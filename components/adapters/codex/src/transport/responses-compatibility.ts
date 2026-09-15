/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";

export type CodexResponsesCapability =
  | "explicit_prompt_cache"
  | "prompt_cache_retention"
  | "prompt_cache_key"
  | "include"
  | "reasoning_summary"
  | "namespace_tools"
  | "web_search_tool";

export type CodexNamespaceToolAlias = {
  compatibleName: string;
  namespace: string;
  name: string;
};

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

function withoutReasoningSummary(payload: any): any {
  if (!payload || typeof payload !== "object"
    || !payload.reasoning || typeof payload.reasoning !== "object"
    || Array.isArray(payload.reasoning)
    || !("summary" in payload.reasoning)) return payload;
  const reasoning = { ...(payload.reasoning as Record<string, unknown>) };
  delete reasoning.summary;
  const next = { ...(payload as Record<string, unknown>) };
  if (Object.keys(reasoning).length > 0) {
    next.reasoning = reasoning;
  } else {
    delete next.reasoning;
  }
  return next;
}

function namespaceToolKey(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`;
}

function validFunctionName(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function fallbackFunctionName(namespace: string, name: string): string {
  const digest = createHash("sha256")
    .update(namespaceToolKey(namespace, name))
    .digest("hex")
    .slice(0, 12);
  const readableName = name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 100);
  return `lightrsi__${digest}__${readableName || "tool"}`.slice(0, 128);
}

export function codexNamespaceToolAliases(payload: any): CodexNamespaceToolAlias[] {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) return [];
  const usedNames = new Set<string>();
  for (const tool of payload.tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    if (tool.type === "function" && typeof tool.name === "string") usedNames.add(tool.name);
  }
  const aliases: CodexNamespaceToolAlias[] = [];
  for (const tool of payload.tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)
      || tool.type !== "namespace" || typeof tool.name !== "string"
      || !Array.isArray(tool.tools)) continue;
    for (const nestedTool of tool.tools) {
      if (!nestedTool || typeof nestedTool !== "object" || Array.isArray(nestedTool)
        || nestedTool.type !== "function" || typeof nestedTool.name !== "string") continue;
      const preferred = `${tool.name}__${nestedTool.name}`;
      let compatibleName = validFunctionName(preferred) && !usedNames.has(preferred)
        ? preferred
        : fallbackFunctionName(tool.name, nestedTool.name);
      let suffix = 2;
      while (usedNames.has(compatibleName)) {
        const suffixText = `__${suffix}`;
        compatibleName = `${fallbackFunctionName(tool.name, nestedTool.name).slice(0, 128 - suffixText.length)}${suffixText}`;
        suffix += 1;
      }
      usedNames.add(compatibleName);
      aliases.push({ compatibleName, namespace: tool.name, name: nestedTool.name });
    }
  }
  return aliases;
}

function aliasMaps(aliases: Iterable<CodexNamespaceToolAlias>): {
  byCompatibleName: Map<string, CodexNamespaceToolAlias>;
  byNamespacedName: Map<string, CodexNamespaceToolAlias>;
} {
  const byCompatibleName = new Map<string, CodexNamespaceToolAlias>();
  const byNamespacedName = new Map<string, CodexNamespaceToolAlias>();
  for (const alias of aliases) {
    byCompatibleName.set(alias.compatibleName, alias);
    byNamespacedName.set(namespaceToolKey(alias.namespace, alias.name), alias);
  }
  return { byCompatibleName, byNamespacedName };
}

function rewriteInputForFunctionTools(
  input: unknown,
  byNamespacedName: Map<string, CodexNamespaceToolAlias>,
): unknown {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const nextInput = input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (type !== "function_call" && type !== "function_call_output") return item;
    if (typeof record.namespace !== "string" || typeof record.name !== "string") return item;
    const alias = byNamespacedName.get(namespaceToolKey(record.namespace, record.name));
    if (!alias) return item;
    const rewritten: Record<string, unknown> = { ...record, name: alias.compatibleName };
    delete rewritten.namespace;
    changed = true;
    return rewritten;
  });
  return changed ? nextInput : input;
}

function withoutNamespaceTools(payload: any): any {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) return payload;
  const aliases = codexNamespaceToolAliases(payload);
  if (aliases.length === 0) return payload;
  const { byNamespacedName } = aliasMaps(aliases);
  let changed = false;
  const tools = payload.tools.flatMap((tool: unknown) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [tool];
    const namespace = tool as Record<string, unknown>;
    if (namespace.type !== "namespace" || typeof namespace.name !== "string"
      || !Array.isArray(namespace.tools)
      || namespace.tools.some((nested) => !nested || typeof nested !== "object"
        || Array.isArray(nested) || (nested as Record<string, unknown>).type !== "function")) {
      return [tool];
    }
    changed = true;
    return namespace.tools.map((nested) => {
      const functionTool = nested as Record<string, unknown>;
      const alias = typeof functionTool.name === "string"
        ? byNamespacedName.get(namespaceToolKey(namespace.name as string, functionTool.name))
        : undefined;
      const flattened: Record<string, unknown> = {
        ...functionTool,
        ...(alias ? { name: alias.compatibleName } : {}),
      };
      delete flattened.defer_loading;
      return flattened;
    });
  });
  if (!changed) return payload;
  return {
    ...payload,
    tools,
    input: rewriteInputForFunctionTools(payload.input, byNamespacedName),
  };
}

function withoutToolType(payload: any, type: string): any {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) return payload;
  const tools = payload.tools.filter((tool: unknown) =>
    !tool || typeof tool !== "object" || Array.isArray(tool)
      || (tool as Record<string, unknown>).type !== type);
  return tools.length === payload.tools.length ? payload : { ...payload, tools };
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
    } else if (capability === "reasoning_summary") {
      next = withoutReasoningSummary(next);
    } else if (capability === "namespace_tools") {
      next = withoutNamespaceTools(next);
    } else if (capability === "web_search_tool") {
      next = withoutToolType(next, "web_search");
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
  if (/(?:^|\W)include(?:\W|$)/iu.test(evidence)
    && /(?:unsupported|not supported|invalid_(?:request|parameter))/iu.test(evidence)) {
    return "include";
  }
  if (/(?:reasoning|\*+)\.summary(?:\W|$)/iu.test(evidence)
    && /(?:unsupported|not supported|invalid_(?:request|parameter))/iu.test(evidence)) {
    return "reasoning_summary";
  }
  if (/unsupported\s+type\s+["']namespace["']/iu.test(evidence)
    && /only\s+function\s+tools?/iu.test(evidence)) {
    return "namespace_tools";
  }
  if (/unsupported\s+type\s+["']web_search["']/iu.test(evidence)
    && /only\s+function\s+tools?/iu.test(evidence)) {
    return "web_search_tool";
  }
  return undefined;
}

export function legacyFieldForResponsesCapability(
  capability: CodexResponsesCapability,
): "prompt_cache_options" | "prompt_cache_retention" | "prompt_cache_key" | "include" | "reasoning.summary" | "namespace_tools" | "tools.web_search" {
  if (capability === "explicit_prompt_cache") return "prompt_cache_options";
  if (capability === "reasoning_summary") return "reasoning.summary";
  if (capability === "web_search_tool") return "tools.web_search";
  return capability;
}

export function responsesCapabilityFromLegacyField(
  field: unknown,
): CodexResponsesCapability | undefined {
  if (field === "prompt_cache_options") return "explicit_prompt_cache";
  if (field === "prompt_cache_retention" || field === "prompt_cache_key" || field === "include") return field;
  if (field === "reasoning.summary") return "reasoning_summary";
  if (field === "namespace_tools") return "namespace_tools";
  if (field === "tools.web_search") return "web_search_tool";
  return undefined;
}

function restoreNamespacedFunctionCalls(
  value: unknown,
  byCompatibleName: Map<string, CodexNamespaceToolAlias>,
): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const restored = restoreNamespacedFunctionCalls(item, byCompatibleName);
      if (restored !== item) changed = true;
      return restored;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const restored = restoreNamespacedFunctionCalls(child, byCompatibleName);
    next[key] = restored;
    if (restored !== child) changed = true;
  }
  if (record.type === "function_call" && typeof record.name === "string") {
    const alias = byCompatibleName.get(record.name);
    if (alias) {
      next.name = alias.name;
      next.namespace = alias.namespace;
      changed = true;
    }
  }
  return changed ? next : value;
}

export function restoreCodexNamespaceToolCalls(
  value: unknown,
  aliases: Iterable<CodexNamespaceToolAlias>,
): unknown {
  return restoreNamespacedFunctionCalls(value, aliasMaps(aliases).byCompatibleName);
}

export function restoreCodexNamespaceToolCallsInSseBlock(
  block: string,
  aliases: Iterable<CodexNamespaceToolAlias>,
): string {
  const lines = block.split(/\r?\n/u);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return block;
  const dataText = dataLines
    .map((line) => line.slice("data:".length).replace(/^ /u, ""))
    .join("\n")
    .trim();
  if (!dataText || dataText === "[DONE]") return block;
  try {
    const parsed = JSON.parse(dataText) as unknown;
    const restored = restoreCodexNamespaceToolCalls(parsed, aliases);
    if (restored === parsed) return block;
    const nonDataLines = lines.filter((line) => !line.startsWith("data:"));
    return [...nonDataLines, `data: ${JSON.stringify(restored)}`].join("\n");
  } catch {
    return block;
  }
}
