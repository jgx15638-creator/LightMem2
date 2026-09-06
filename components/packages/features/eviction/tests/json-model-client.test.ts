import assert from "node:assert/strict";
import test from "node:test";

import { createApiJsonModelClient } from "../src/json-model-client.js";

test("sends a Responses JSON request and preserves text and usage", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return {
      ok: true,
      async json() {
        return {
          output: [{ content: [{ text: "{\"ok\":true}" }] }],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cost_usd: 0.001 },
        };
      },
    } as Response;
  };
  try {
    const client = createApiJsonModelClient({
      baseUrl: "https://example.test/v1/", apiKey: "secret", model: "model-a",
    });
    const response = await client.request({ systemPrompt: "system", userPayload: "{\"input\":true}" });
    assert.equal(requestedUrl, "https://example.test/v1/responses");
    assert.equal(new Headers(requestedInit?.headers).get("authorization"), "Bearer secret");
    assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
      model: "model-a",
      input: [
        { role: "system", content: [{ type: "input_text", text: "system" }] },
        { role: "user", content: [{ type: "input_text", text: "{\"input\":true}" }] },
      ],
      text: { format: { type: "json_object" } },
    });
    assert.deepEqual(response, {
      text: "{\"ok\":true}",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.001 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a Chat Completions envelope returned by a compatible Responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
    },
  }) as Response;
  try {
    const client = createApiJsonModelClient({
      baseUrl: "https://example.test/v1", apiKey: "secret", model: "model-a",
    });
    const response = await client.request({ systemPrompt: "system", userPayload: "payload" });
    assert.deepEqual(response, {
      text: "{\"ok\":true}",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts text value objects returned by a compatible Responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output: [{ content: [{ text: { value: "{\"ok\":true}" } }] }],
      };
    },
  }) as Response;
  try {
    const client = createApiJsonModelClient({
      baseUrl: "https://example.test/v1", apiKey: "secret", model: "model-a",
    });
    const response = await client.request({ systemPrompt: "system", userPayload: "payload" });
    assert.equal(response.text, "{\"ok\":true}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to Chat Completions and preserves array content usage", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  let chatBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrls.push(String(input));
    if (requestedUrls.length === 1) {
      return { ok: false, status: 404, async text() { return "missing"; } } as Response;
    }
    chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: [{ text: "{\"fallback\":true}" }] } }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        };
      },
    } as Response;
  };
  try {
    const client = createApiJsonModelClient({
      baseUrl: "https://example.test/v1", apiKey: "secret", model: "model-a",
    });
    const response = await client.request({ systemPrompt: "system", userPayload: "payload" });
    assert.deepEqual(requestedUrls, [
      "https://example.test/v1/responses",
      "https://example.test/v1/chat/completions",
    ]);
    assert.deepEqual(chatBody, {
      model: "model-a",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "payload" },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });
    assert.deepEqual(response, {
      text: "{\"fallback\":true}",
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not hide network failures behind Chat Completions fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  };
  try {
    const client = createApiJsonModelClient({
      baseUrl: "https://example.test/v1", apiKey: "secret", model: "model-a",
    });
    await assert.rejects(
      client.request({ systemPrompt: "system", userPayload: "payload" }),
      /fetch failed/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry auth, rate-limit, or server failures through Chat Completions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403, 429, 500, 503]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return {
          ok: false,
          status,
          async text() { return "provider-controlled-secret-body"; },
        } as Response;
      };
      const client = createApiJsonModelClient({
        baseUrl: "https://example.test/v1", apiKey: "secret", model: "model-a",
      });
      await assert.rejects(
        client.request({ systemPrompt: "system", userPayload: "payload" }),
        (error: unknown) => error instanceof Error
          && error.message === `responses_api_failed:${status}`,
      );
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aborts requests at the configured timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("request aborted", "AbortError"));
    }, { once: true });
  });
  try {
    const client = createApiJsonModelClient({
      baseUrl: "https://example.test/v1", apiKey: "secret", model: "model-a", requestTimeoutMs: 1,
    });
    await assert.rejects(
      client.request({ systemPrompt: "system", userPayload: "payload" }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects incomplete estimator API configuration", () => {
  assert.throws(
    () => createApiJsonModelClient({ baseUrl: "", apiKey: "", model: "" }),
    /requires baseUrl, apiKey, and model/,
  );
});
