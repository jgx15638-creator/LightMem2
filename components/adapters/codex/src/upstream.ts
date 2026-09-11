/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  buildGatewayForwardHeaders,
  readJsonFile,
  writeJsonFileAtomic,
} from "@lightrsi/host-adapter";
import { join } from "node:path";
import { Readable } from "node:stream";
import { collectCodexResponseItemsFromStream } from "./context-history/sse-item-collector.js";
import type { CodexProviderConfig } from "./config.js";
import { resolveCodexAuthContext } from "./transport/auth-context.js";
import {
  codexResponsesModelKey,
  legacyFieldForResponsesCapability,
  responsesCapabilityFromLegacyField,
  stripUnsupportedResponsesCapabilities,
  unsupportedResponsesCapabilityFromError,
  type CodexResponsesCapability,
} from "./transport/responses-compatibility.js";

export type UpstreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
};

export type UpstreamStreamResponse = {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
};

type InboundHeaders = Record<string, string | string[] | undefined>;

export const CODEX_CHATGPT_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function resolveCodexRequestUpstream(params: {
  upstream: CodexProviderConfig;
  upstreamProvider?: string;
  inboundHeaders?: InboundHeaders;
}): CodexProviderConfig {
  const auth = resolveCodexAuthContext({
    upstream: params.upstream,
    upstreamProvider: params.upstreamProvider,
    inboundHeaders: params.inboundHeaders,
    envApiKey: process.env.OPENAI_API_KEY,
  });
  if (auth.kind !== "chatgpt_oauth") return params.upstream;
  return {
    ...params.upstream,
    baseUrl: CODEX_CHATGPT_UPSTREAM_BASE_URL,
  };
}

type UpstreamResponsesCapabilityRecord = {
  endpoint: string;
  unsupportedOptionalFields?: Array<"prompt_cache_options" | "prompt_cache_retention" | "prompt_cache_key">;
  unsupportedCapabilitiesByModel?: Record<string, CodexResponsesCapability[]>;
  updatedAt: string;
};

const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

export function codexResponsesEndpoint(upstream: CodexProviderConfig): string {
  const base = upstream.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/backend-api/codex")) return `${base}/responses`;
  if (base.endsWith("/v1")) return `${base}/responses`;
  if (base.endsWith("/v1/responses")) return base;
  return `${base}/v1/responses`;
}

function upstreamApiKey(upstream: CodexProviderConfig, inboundAuthorization?: string): string {
  if (upstream.apiKey) return upstream.apiKey;
  if (inboundAuthorization?.toLowerCase().startsWith("bearer ")) {
    return inboundAuthorization.slice("bearer ".length).trim();
  }
  return process.env.OPENAI_API_KEY ?? "";
}

function headersFrom(resp: Response): Record<string, string> {
  return Object.fromEntries(resp.headers.entries());
}

function requestHeaders(
  upstream: CodexProviderConfig,
  inboundAuthorization?: string,
  inboundHeaders?: InboundHeaders,
): Record<string, string> {
  const apiKey = upstreamApiKey(upstream, inboundAuthorization);
  return buildGatewayForwardHeaders({
    upstream: {
      baseUrl: upstream.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      name: upstream.name,
      protocol: "custom",
    },
    inboundAuthorization,
    inboundHeaders,
    includeJsonContentType: true,
  });
}
function encryptedReasoningRequested(payload: any): boolean {
  return Array.isArray(payload?.include) && payload.include.includes("reasoning.encrypted_content");
}

function outputItemsFromResponse(text: string, contentType: string | null): any[] {
  if (contentType?.toLowerCase().includes("text/event-stream") || /^event:\s*response\./mu.test(text)) {
    return collectCodexResponseItemsFromStream(text).outputItems;
  }
  try {
    const parsed = JSON.parse(text) as any;
    return Array.isArray(parsed?.output) ? parsed.output : [];
  } catch {
    return [];
  }
}

function requestedEncryptedReasoningMissing(payload: any, resp: Response, text: string): boolean {
  if (!encryptedReasoningRequested(payload)) return false;
  return outputItemsFromResponse(text, resp.headers.get("content-type")).some((item) => {
    const type = String(item?.type ?? "").toLowerCase();
    return (type === "reasoning" || type === "compaction")
      && (typeof item?.encrypted_content !== "string" || !item.encrypted_content.trim());
  });
}

function upstreamCapabilityPath(stateDir: string, upstream: CodexProviderConfig): string {
  return join(
    stateDir,
    "upstream-capabilities",
    "responses",
    `${encodeURIComponent(codexResponsesEndpoint(upstream))}.json`,
  );
}

function capabilityRecordIsFresh(
  record: UpstreamResponsesCapabilityRecord | null | undefined,
  upstream: CodexProviderConfig,
): boolean {
  const updatedAt = Date.parse(String(record?.updatedAt ?? ""));
  return record?.endpoint === codexResponsesEndpoint(upstream)
    && Number.isFinite(updatedAt)
    && updatedAt <= Date.now()
    && Date.now() - updatedAt < CAPABILITY_TTL_MS;
}

async function loadUnsupportedCapabilities(
  stateDir: string | undefined,
  upstream: CodexProviderConfig,
  model: string,
): Promise<Set<CodexResponsesCapability>> {
  if (!stateDir) return new Set();
  const record = await readJsonFile<UpstreamResponsesCapabilityRecord>(
    upstreamCapabilityPath(stateDir, upstream),
  );
  if (!capabilityRecordIsFresh(record, upstream)) return new Set();
  if (record?.unsupportedCapabilitiesByModel) {
    const capabilities = record.unsupportedCapabilitiesByModel[model];
    return new Set(Array.isArray(capabilities)
      ? capabilities.filter((value): value is CodexResponsesCapability =>
        value === "explicit_prompt_cache"
        || value === "prompt_cache_retention"
        || value === "prompt_cache_key")
      : []);
  }
  return new Set((record?.unsupportedOptionalFields ?? [])
    .map(responsesCapabilityFromLegacyField)
    .filter((value): value is CodexResponsesCapability => Boolean(value)));
}

async function persistUnsupportedCapability(
  stateDir: string | undefined,
  upstream: CodexProviderConfig,
  model: string,
  capability: CodexResponsesCapability,
): Promise<void> {
  if (!stateDir) return;
  const path = upstreamCapabilityPath(stateDir, upstream);
  const current = await readJsonFile<UpstreamResponsesCapabilityRecord>(path);
  const previousByModel = capabilityRecordIsFresh(current, upstream)
    && current?.unsupportedCapabilitiesByModel
    ? current.unsupportedCapabilitiesByModel
    : {};
  const modelCapabilities = new Set(previousByModel[model] ?? []);
  modelCapabilities.add(capability);
  const legacyFields = new Set(
    capabilityRecordIsFresh(current, upstream) ? current?.unsupportedOptionalFields ?? [] : [],
  );
  legacyFields.add(legacyFieldForResponsesCapability(capability));
  await writeJsonFileAtomic(upstreamCapabilityPath(stateDir, upstream), {
    endpoint: codexResponsesEndpoint(upstream),
    unsupportedOptionalFields: Array.from(legacyFields),
    unsupportedCapabilitiesByModel: {
      ...previousByModel,
      [model]: Array.from(modelCapabilities),
    },
    updatedAt: new Date().toISOString(),
  } satisfies UpstreamResponsesCapabilityRecord);
}

export async function requestUpstreamResponses(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
  inboundHeaders?: InboundHeaders;
  stateDir?: string;
}): Promise<UpstreamHttpResponse> {
  const send = (payload: any) => fetch(codexResponsesEndpoint(params.upstream), {
    method: "POST",
    headers: requestHeaders(params.upstream, params.inboundAuthorization, params.inboundHeaders),
    body: JSON.stringify(payload),
  });
  const model = codexResponsesModelKey(params.payload);
  const unsupportedCapabilities = await loadUnsupportedCapabilities(params.stateDir, params.upstream, model);
  let payload = stripUnsupportedResponsesCapabilities(params.payload, unsupportedCapabilities);
  let resp = await send(payload);
  let text = await resp.text();
  if (!resp.ok) {
    const unsupportedCapability = unsupportedResponsesCapabilityFromError(text);
    if (unsupportedCapability && !unsupportedCapabilities.has(unsupportedCapability)) {
      await persistUnsupportedCapability(params.stateDir, params.upstream, model, unsupportedCapability);
      const downgraded = stripUnsupportedResponsesCapabilities(payload, [unsupportedCapability]);
      if (downgraded !== payload) {
        payload = downgraded;
        resp = await send(payload);
        text = await resp.text();
      }
    }
  }
  let encryptedRepairAttempts = 0;
  while (resp.ok
    && requestedEncryptedReasoningMissing(payload, resp, text)
    && encryptedRepairAttempts < 2) {
    encryptedRepairAttempts += 1;
    resp = await send(payload);
    text = await resp.text();
  }
  return {
    status: resp.status,
    headers: headersFrom(resp),
    text,
  };
}

export async function requestUpstreamResponsesStream(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
  inboundHeaders?: InboundHeaders;
  stateDir?: string;
}): Promise<UpstreamStreamResponse> {
  const send = (payload: any) => fetch(codexResponsesEndpoint(params.upstream), {
    method: "POST",
    headers: requestHeaders(params.upstream, params.inboundAuthorization, params.inboundHeaders),
    body: JSON.stringify(payload),
  });
  const model = codexResponsesModelKey(params.payload);
  const unsupportedCapabilities = await loadUnsupportedCapabilities(params.stateDir, params.upstream, model);
  let payload = stripUnsupportedResponsesCapabilities(params.payload, unsupportedCapabilities);
  let resp = await send(payload);
  if (!resp.ok) {
    const text = await resp.text();
    const unsupportedCapability = unsupportedResponsesCapabilityFromError(text);
    if (unsupportedCapability && !unsupportedCapabilities.has(unsupportedCapability)) {
      await persistUnsupportedCapability(params.stateDir, params.upstream, model, unsupportedCapability);
      const downgraded = stripUnsupportedResponsesCapabilities(payload, [unsupportedCapability]);
      if (downgraded !== payload) {
        payload = downgraded;
        resp = await send(payload);
      } else {
        return {
          status: resp.status,
          headers: headersFrom(resp),
          stream: Readable.from([text]),
        };
      }
    } else {
      return {
        status: resp.status,
        headers: headersFrom(resp),
        stream: Readable.from([text]),
      };
    }
  }
  return {
    status: resp.status,
    headers: headersFrom(resp),
    stream: resp.body ? Readable.fromWeb(resp.body as any) : Readable.from([""]),
  };
}
