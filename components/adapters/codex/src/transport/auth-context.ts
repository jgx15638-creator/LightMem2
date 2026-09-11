import type { IncomingHttpHeaders } from "node:http";
import type { CodexProviderConfig } from "../config.js";

export type CodexAuthKind = "chatgpt_oauth" | "api_key" | "custom" | "missing";

export type CodexAuthContext = {
  kind: CodexAuthKind;
  authorization?: string;
  chatGptAccountId?: string;
  errorCode?: "chatgpt_oauth_incomplete" | "openai_auth_missing";
};

function headerValue(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined> | undefined,
  expectedName: string,
): string | undefined {
  const match = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === expectedName);
  const value = match?.[1];
  const normalized = Array.isArray(value) ? value.join(", ") : value;
  return typeof normalized === "string" && normalized.trim() ? normalized.trim() : undefined;
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1]?.trim() || undefined;
}

export function resolveCodexAuthContext(params: {
  upstream: CodexProviderConfig;
  upstreamProvider?: string;
  inboundHeaders?: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  envApiKey?: string;
}): CodexAuthContext {
  const authorization = headerValue(params.inboundHeaders, "authorization");
  const chatGptAccountId = headerValue(params.inboundHeaders, "chatgpt-account-id");
  const token = bearerToken(authorization);
  // Codex reserves the exact lower-case `openai` provider ID. A differently
  // cased name can still be a user-defined provider and must not inherit the
  // managed-login requirements of the built-in provider.
  const builtInOpenAI = params.upstreamProvider?.trim() === "openai";
  const configuredApiKey = params.upstream.apiKey?.trim() || params.envApiKey?.trim();

  if (!builtInOpenAI || params.upstream.requiresOpenAIAuth === false) {
    return {
      kind: "custom",
      ...(authorization ? { authorization } : {}),
      ...(chatGptAccountId ? { chatGptAccountId } : {}),
    };
  }
  if (chatGptAccountId && token) {
    return { kind: "chatgpt_oauth", authorization, chatGptAccountId };
  }
  // ChatGPT account routing is identified by its explicit account header, not
  // by guessing the format of a bearer secret. API key formats are opaque and
  // may change over time.
  if (chatGptAccountId) {
    return {
      kind: "missing",
      ...(authorization ? { authorization } : {}),
      ...(chatGptAccountId ? { chatGptAccountId } : {}),
      errorCode: "chatgpt_oauth_incomplete",
    };
  }
  if (configuredApiKey || token) {
    return {
      kind: "api_key",
      ...(authorization ? { authorization } : {}),
    };
  }
  return { kind: "missing", errorCode: "openai_auth_missing" };
}

export function codexAuthErrorPayload(context: CodexAuthContext): {
  error: { type: string; code: string; message: string };
} | undefined {
  if (context.kind !== "missing") return undefined;
  if (context.errorCode === "chatgpt_oauth_incomplete") {
    return {
      error: {
        type: "authentication_error",
        code: "chatgpt_oauth_incomplete",
        message: "Codex-managed ChatGPT authentication requires both Authorization and ChatGPT-Account-ID headers. Keep model_provider = \"openai\" and configure the user-level openai_base_url through the LightRSI installer.",
      },
    };
  }
  return {
    error: {
      type: "authentication_error",
      code: "openai_auth_missing",
      message: "No Codex-managed ChatGPT credential or OpenAI API key reached the LightRSI proxy. Run codex login, then retry with the built-in openai provider.",
    },
  };
}
