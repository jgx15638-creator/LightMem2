/* eslint-disable @typescript-eslint/no-explicit-any */

export type CodexResponsesCapability =
  | "explicit_prompt_cache"
  | "prompt_cache_retention"
  | "prompt_cache_key";

export function codexResponsesModelKey(payload: unknown): string {
  const model = payload && typeof payload === "object"
    ? String((payload as Record<string, unknown>).model ?? "").trim()
    : "";
  return model || "(unknown-model)";
}

function withoutTopLevelField(payload: any, field: string): any {
  if (!payload || typeof payload !== "object" || !(field in payload)) return payload;
  const next = { ...(payload as Record<string, unknown>) };
  delete next[field];
  return next;
}

function withoutInputPromptCacheBreakpoints(payload: any): any {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.input)) return payload;
  let inputChanged = false;
  const input = payload.input.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.content)) return item;
    let contentChanged = false;
    const content = record.content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)
        || !("prompt_cache_breakpoint" in part)) return part;
      const nextPart = { ...(part as Record<string, unknown>) };
      delete nextPart.prompt_cache_breakpoint;
      contentChanged = true;
      return nextPart;
    });
    if (!contentChanged) return item;
    inputChanged = true;
    return { ...record, content };
  });
  return inputChanged ? { ...payload, input } : payload;
}

export function stripUnsupportedResponsesCapabilities(
  payload: any,
  capabilities: Iterable<CodexResponsesCapability>,
): any {
  let next = payload;
  for (const capability of capabilities) {
    if (capability === "explicit_prompt_cache") {
      next = withoutTopLevelField(next, "prompt_cache_options");
      next = withoutInputPromptCacheBreakpoints(next);
    } else {
      next = withoutTopLevelField(next, capability);
    }
  }
  return next;
}

function errorDetails(text: string): { param?: string; message?: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
      ? parsed.error as Record<string, unknown>
      : parsed;
    return {
      param: typeof error.param === "string"
        ? error.param
        : typeof parsed.param === "string"
          ? parsed.param
          : undefined,
      message: typeof error.message === "string"
        ? error.message
        : typeof error.detail === "string"
          ? error.detail
          : typeof parsed.detail === "string"
            ? parsed.detail
            : undefined,
      code: typeof error.code === "string"
        ? error.code
        : typeof parsed.code === "string"
          ? parsed.code
          : undefined,
    };
  } catch {
    return { message: text };
  }
}

export function unsupportedResponsesCapabilityFromError(
  text: string,
): CodexResponsesCapability | undefined {
  if (!text) return undefined;
  const details = errorDetails(text);
  const evidence = [details.param, details.code, details.message].filter(Boolean).join(" ");
  if (/prompt_cache_(?:options|breakpoint)/iu.test(evidence)
    && /(?:unsupported|not supported|invalid_(?:request|parameter))/iu.test(evidence)) {
    return "explicit_prompt_cache";
  }
  if (/prompt_cache_retention/iu.test(evidence)
    && /(?:unsupported|not supported|invalid_(?:request|parameter))/iu.test(evidence)) {
    return "prompt_cache_retention";
  }
  if (/prompt_cache_key/iu.test(evidence)
    && /(?:unsupported|not supported|invalid_(?:request|parameter))/iu.test(evidence)) {
    return "prompt_cache_key";
  }
  return undefined;
}

export function legacyFieldForResponsesCapability(
  capability: CodexResponsesCapability,
): "prompt_cache_options" | "prompt_cache_retention" | "prompt_cache_key" {
  return capability === "explicit_prompt_cache" ? "prompt_cache_options" : capability;
}

export function responsesCapabilityFromLegacyField(
  field: unknown,
): CodexResponsesCapability | undefined {
  if (field === "prompt_cache_options") return "explicit_prompt_cache";
  if (field === "prompt_cache_retention" || field === "prompt_cache_key") return field;
  return undefined;
}
