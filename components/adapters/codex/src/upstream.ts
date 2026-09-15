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
  codexNamespaceToolAliases,
  codexResponsesModelKey,
  legacyFieldForResponsesCapability,
  restoreCodexNamespaceToolCalls,
  restoreCodexNamespaceToolCallsInSseBlock,
  responsesCapabilityFromLegacyField,
  stripUnsupportedResponsesCapabilities,
  unsupportedResponsesCapabilityFromError,
  type CodexNamespaceToolAlias,
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
  unsupportedOptionalFields?: Array<
    "prompt_cache_options" | "prompt_cache_retention" | "prompt_cache_key" | "include" | "reasoning.summary" | "namespace_tools" | "tools.web_search"
  >;
  unsupportedCapabilitiesByModel?: Record<string, CodexResponsesCapability[]>;
  updatedAt: string;
};

const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CAPABILITY_DOWNGRADE_RETRIES = 5;

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
        || value === "prompt_cache_key"
        || value === "include"
        || value === "reasoning_summary"
        || value === "namespace_tools"
        || value === "web_search_tool")
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

function restoreNamespaceToolResponseText(
  text: string,
  contentType: string | null,
  aliases: CodexNamespaceToolAlias[],
): string {
  if (aliases.length === 0 || !text) return text;
  if (contentType?.toLowerCase().includes("text/event-stream") || /^event:\s*response\./mu.test(text)) {
    return text
      .split(/\r?\n\r?\n/u)
      .map((block) => restoreCodexNamespaceToolCallsInSseBlock(block, aliases))
      .join("\n\n");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const restored = restoreCodexNamespaceToolCalls(parsed, aliases);
    return restored === parsed ? text : JSON.stringify(restored);
  } catch {
    return text;
  }
}

function restoreNamespaceToolResponseStream(
  stream: Readable,
  aliases: CodexNamespaceToolAlias[],
): Readable {
  if (aliases.length === 0) return stream;
  return Readable.from((async function* () {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), { stream: true });
      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        yield `${restoreCodexNamespaceToolCallsInSseBlock(block, aliases)}\n\n`;
      }
    }
    pending += decoder.decode();
    if (pending) yield restoreCodexNamespaceToolCallsInSseBlock(pending, aliases);
  })());
}

const TERMINAL_RESPONSES_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

function sseEventType(block: string): string | undefined {
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) return line.slice("event:".length).trim();
  }
  for (const line of block.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    try {
      const payload = JSON.parse(line.slice("data:".length).trim()) as { type?: unknown };
      if (typeof payload.type === "string") return payload.type;
    } catch {
      // Non-JSON data blocks are not terminal Responses events.
    }
  }
  return undefined;
}

function stopAfterTerminalResponsesEvent(stream: Readable): Readable {
  return Readable.from((async function* () {
    const decoder = new TextDecoder();
    let pending = "";
    let terminal = false;
    try {
      for await (const chunk of stream) {
        pending += decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), {
          stream: true,
        });
        while (true) {
          const separator = /\r?\n\r?\n/u.exec(pending);
          if (!separator || separator.index === undefined) break;
          const end = separator.index + separator[0].length;
          const block = pending.slice(0, separator.index);
          const framed = pending.slice(0, end);
          pending = pending.slice(end);
          yield framed;
          if (TERMINAL_RESPONSES_EVENTS.has(sseEventType(block) ?? "")) {
            terminal = true;
            return;
          }
        }
      }
      pending += decoder.decode();
      if (pending) yield pending;
    } finally {
      if (terminal && !stream.destroyed) stream.destroy();
    }
  })());
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
  const namespaceToolAliases = codexNamespaceToolAliases(params.payload);
  const unsupportedCapabilities = await loadUnsupportedCapabilities(params.stateDir, params.upstream, model);
  let payload = stripUnsupportedResponsesCapabilities(params.payload, unsupportedCapabilities);
  let resp = await send(payload);
  let text = await resp.text();
  let downgradeRetries = 0;
  while (!resp.ok && downgradeRetries < MAX_CAPABILITY_DOWNGRADE_RETRIES) {
    const unsupportedCapability = unsupportedResponsesCapabilityFromError(text);
    if (!unsupportedCapability || unsupportedCapabilities.has(unsupportedCapability)) break;
    const downgraded = stripUnsupportedResponsesCapabilities(payload, [unsupportedCapability]);
    if (downgraded === payload) break;
    await persistUnsupportedCapability(params.stateDir, params.upstream, model, unsupportedCapability);
    unsupportedCapabilities.add(unsupportedCapability);
    payload = downgraded;
    downgradeRetries += 1;
    resp = await send(payload);
    text = await resp.text();
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
    text: unsupportedCapabilities.has("namespace_tools")
      ? restoreNamespaceToolResponseText(text, resp.headers.get("content-type"), namespaceToolAliases)
      : text,
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
  const namespaceToolAliases = codexNamespaceToolAliases(params.payload);
  const unsupportedCapabilities = await loadUnsupportedCapabilities(params.stateDir, params.upstream, model);
  let payload = stripUnsupportedResponsesCapabilities(params.payload, unsupportedCapabilities);
  let resp = await send(payload);
  let downgradeRetries = 0;
  while (!resp.ok) {
    const text = await resp.text();
    const unsupportedCapability = unsupportedResponsesCapabilityFromError(text);
    if (downgradeRetries >= MAX_CAPABILITY_DOWNGRADE_RETRIES
      || !unsupportedCapability
      || unsupportedCapabilities.has(unsupportedCapability)) {
      return {
        status: resp.status,
        headers: headersFrom(resp),
        stream: Readable.from([text]),
      };
    }
    const downgraded = stripUnsupportedResponsesCapabilities(payload, [unsupportedCapability]);
    if (downgraded === payload) {
      return {
        status: resp.status,
        headers: headersFrom(resp),
        stream: Readable.from([text]),
      };
    }
    await persistUnsupportedCapability(params.stateDir, params.upstream, model, unsupportedCapability);
    unsupportedCapabilities.add(unsupportedCapability);
    payload = downgraded;
    downgradeRetries += 1;
    resp = await send(payload);
  }
  return {
    status: resp.status,
    headers: headersFrom(resp),
    stream: restoreNamespaceToolResponseStream(
      stopAfterTerminalResponsesEvent(
        resp.body ? Readable.fromWeb(resp.body as any) : Readable.from([""]),
      ),
      unsupportedCapabilities.has("namespace_tools") ? namespaceToolAliases : [],
    ),
  };
}
