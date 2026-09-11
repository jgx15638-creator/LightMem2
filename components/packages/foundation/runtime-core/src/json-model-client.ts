export type JsonModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
};

export type JsonModelApiConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requestTimeoutMs?: number;
};

export type JsonModelRequest = { systemPrompt: string; userPayload: string };
export type JsonModelResponse = { text: string; usage?: JsonModelUsage };
export type JsonModelClient = {
  request(input: JsonModelRequest): Promise<JsonModelResponse>;
};

const CHAT_FALLBACK_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

function extractTextValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const nested = (value as { value?: unknown }).value;
  return typeof nested === "string" ? nested.trim() : "";
}

function extractResponsesText(payload: any): string {
  const texts: string[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      const text = extractTextValue(part?.text);
      if (text) texts.push(text);
    }
  }
  if (texts.length > 0) return texts.join("\n");
  const outputText = extractTextValue(payload?.output_text);
  return outputText || extractChatText(payload);
}

function extractChatText(payload: any): string {
  const content = Array.isArray(payload?.choices) ? payload.choices[0]?.message?.content : undefined;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => extractTextValue(part?.text))
    .filter(Boolean)
    .join("\n");
}

function finiteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function extractUsage(payload: any): JsonModelUsage | undefined {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = finiteNumber(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens,
  ) ?? 0;
  const outputTokens = finiteNumber(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens,
  ) ?? 0;
  const totalTokens = finiteNumber(usage.total_tokens ?? usage.totalTokens)
    ?? inputTokens + outputTokens;
  const costUsd = finiteNumber(
    usage.cost_usd ?? usage.costUsd ?? usage.total_cost ?? usage.totalCost ?? payload?.cost_usd,
  );
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: Math.max(0, totalTokens),
    ...(costUsd !== undefined ? { costUsd: Math.max(0, costUsd) } : {}),
  };
}

async function responseError(prefix: string, response: Response): Promise<Error> {
  // Drain the body without copying provider-controlled text into logs or traces.
  try { await response.text(); } catch { /* The status remains sufficient evidence. */ }
  return new Error(`${prefix}:${response.status}`);
}

/** OpenAI-compatible JSON client shared by estimator-backed runtime features. */
export function createApiJsonModelClient(config: JsonModelApiConfig): JsonModelClient {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("json model client requires baseUrl, apiKey, and model");
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const apiKey = config.apiKey;
  const model = config.model;
  const requestTimeoutMs = Math.max(1_000, config.requestTimeoutMs ?? 60_000);

  return {
    async request(input): Promise<JsonModelResponse> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const responses = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            input: [
              { role: "system", content: [{ type: "input_text", text: input.systemPrompt }] },
              { role: "user", content: [{ type: "input_text", text: input.userPayload }] },
            ],
            text: { format: { type: "json_object" } },
          }),
        });
        if (responses.ok) {
          const payload = await responses.json();
          return { text: extractResponsesText(payload), usage: extractUsage(payload) };
        }
        if (!CHAT_FALLBACK_STATUSES.has(responses.status)) {
          throw await responseError("responses_api_failed", responses);
        }
        try { await responses.text(); } catch { /* Continue with the compatible API. */ }

        const chat = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userPayload },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
          }),
        });
        if (!chat.ok) throw await responseError("chat_completions_failed", chat);
        const payload = await chat.json();
        return { text: extractChatText(payload), usage: extractUsage(payload) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
