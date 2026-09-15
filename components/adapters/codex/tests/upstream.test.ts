import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_CHATGPT_UPSTREAM_BASE_URL,
  requestUpstreamResponses,
  requestUpstreamResponsesStream,
  resolveCodexRequestUpstream,
} from "../src/upstream.js";

test("built-in OpenAI requests use the ChatGPT Codex endpoint for ChatGPT-authenticated accounts", () => {
  const upstream = { baseUrl: "https://api.openai.com/v1", wireApi: "responses" as const };
  assert.deepEqual(resolveCodexRequestUpstream({
    upstream,
    upstreamProvider: "openai",
    inboundHeaders: {
      authorization: "Bearer oauth-fixture",
      "ChatGPT-Account-Id": "account-fixture",
    },
  }), {
    ...upstream,
    baseUrl: CODEX_CHATGPT_UPSTREAM_BASE_URL,
  });
  assert.equal(resolveCodexRequestUpstream({
    upstream,
    upstreamProvider: "openai",
    inboundHeaders: { authorization: "Bearer api-key-fixture" },
  }), upstream);
});

test("enhanced Responses forwarding preserves ChatGPT authentication context headers", async () => {
  let receivedHeaders: IncomingHttpHeaders | undefined;
  const server = createServer(async (req, res) => {
    receivedHeaders = req.headers;
    for await (const _chunk of req) {
      // Drain the request body before replying.
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  try {
    const response = await requestUpstreamResponses({
      upstream: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        wireApi: "responses",
        requiresOpenAIAuth: true,
      },
      payload: { model: "gpt-fixture", input: [] },
      inboundAuthorization: "Bearer chatgpt-token-fixture",
      inboundHeaders: {
        authorization: "Bearer chatgpt-token-fixture",
        "chatgpt-account-id": "account-fixture",
        originator: "codex_cli_rs",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(receivedHeaders?.authorization, "Bearer chatgpt-token-fixture");
    assert.equal(receivedHeaders?.["chatgpt-account-id"], "account-fixture");
    assert.equal(receivedHeaders?.originator, "codex_cli_rs");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("streaming forwarding ends at response.completed even when the upstream socket stays open", async () => {
  let heldResponse: import("node:http").ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    heldResponse = res;
    for await (const _chunk of req) {
      // Drain the request body before replying.
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.write([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"done"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp-terminal","status":"completed"}}',
      "",
      "",
    ].join("\n"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  let stream: import("node:stream").Readable | undefined;
  try {
    const response = await requestUpstreamResponsesStream({
      upstream: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      payload: { model: "gpt-fixture", input: [], stream: true },
    });
    stream = response.stream;
    const bodyPromise = (async () => {
      let body = "";
      for await (const chunk of response.stream) body += String(chunk);
      return body;
    })();
    const body = await Promise.race([
      bodyPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("terminal SSE event did not end the forwarded stream")), 250);
      }),
    ]);
    assert.match(body, /event: response\.completed/);
    assert.match(body, /resp-terminal/);
  } finally {
    stream?.destroy();
    heldResponse?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withReasoningFixture(
  responses: Array<{ encrypted?: string }>,
  run: (baseUrl: string, requestCount: () => number) => Promise<void>,
): Promise<void> {
  let count = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request body before replying.
    }
    const fixture = responses[Math.min(count, responses.length - 1)] ?? {};
    count += 1;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `resp-${count}`,
      status: "completed",
      output: [{
        type: "reasoning",
        encrypted_content: fixture.encrypted,
        summary: [],
      }],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, () => count);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("upstream retries up to twice when requested encrypted reasoning is omitted", async () => {
  await withReasoningFixture([{}, {}, { encrypted: "opaque-retry-state" }], async (baseUrl, requestCount) => {
    const response = await requestUpstreamResponses({
      upstream: { baseUrl, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        store: false,
        include: ["reasoning.encrypted_content"],
        input: [{ role: "user", content: "test" }],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(requestCount(), 3);
    assert.match(response.text, /opaque-retry-state/);
  });
});
test("upstream encrypted-reasoning repair is bounded to two retries", async () => {
  await withReasoningFixture([{}, {}, {}], async (baseUrl, requestCount) => {
    const response = await requestUpstreamResponses({
      upstream: { baseUrl, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        include: ["reasoning.encrypted_content"],
        input: [{ role: "user", content: "test" }],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(requestCount(), 3);
    assert.doesNotMatch(response.text, /encrypted_content":"opaque/);
  });
});
test("streaming upstream learns consecutive Responses compatibility rejections", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-include-capability-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    if ("include" in payload) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: {
          message: "include is not supported in Responses compatibility mode",
          type: "v_api_biz_error",
          code: "invalid_request",
        },
      }));
      return;
    }
    const reasoning = payload.reasoning && typeof payload.reasoning === "object"
      ? payload.reasoning as Record<string, unknown>
      : undefined;
    if (reasoning && "summary" in reasoning) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: {
          message: "***.summary is not supported in Responses compatibility mode",
          type: "v_api_biz_error",
          code: "invalid_request",
        },
      }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  const upstream = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    wireApi: "responses" as const,
    requiresOpenAIAuth: false,
  };
  const payload = {
    model: "kimi-fixture",
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "none", summary: "auto" },
    input: [{ role: "user", content: "test" }],
  };
  try {
    const first = await requestUpstreamResponsesStream({ upstream, payload, stateDir });
    assert.equal(first.status, 200);
    let firstText = "";
    for await (const chunk of first.stream) firstText += chunk.toString();
    assert.match(firstText, /response\.completed/u);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0]?.include, ["reasoning.encrypted_content"]);
    assert.equal("include" in (requests[1] ?? {}), false);
    assert.equal(
      "summary" in ((requests[1]?.reasoning as Record<string, unknown> | undefined) ?? {}),
      true,
    );
    assert.equal(
      "summary" in ((requests[2]?.reasoning as Record<string, unknown> | undefined) ?? {}),
      false,
    );

    const second = await requestUpstreamResponsesStream({ upstream, payload, stateDir });
    assert.equal(second.status, 200);
    for await (const _chunk of second.stream) {
      // Drain the stream before closing the fixture.
    }
    assert.equal(requests.length, 4);
    assert.equal("include" in (requests[3] ?? {}), false);
    assert.equal(
      "summary" in ((requests[3]?.reasoning as Record<string, unknown> | undefined) ?? {}),
      false,
    );
    assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(payload.reasoning, { effort: "none", summary: "auto" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("streaming upstream flattens namespace tools and restores namespaced function calls", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-namespace-capability-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    const tools = Array.isArray(payload.tools)
      ? payload.tools as Array<Record<string, unknown>>
      : [];
    if (tools.some((tool) => tool.type === "namespace")) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: {
          message: 'tool 8 has unsupported type "namespace"; only function tools can use Responses compatibility mode',
          type: "v_api_biz_error",
          code: "invalid_request",
        },
      }));
      return;
    }
    const flattened = tools.find((tool) =>
      tool.type === "function"
      && typeof tool.name === "string"
      && tool.name.includes("clean_selection"));
    assert.ok(flattened);
    assert.equal("defer_loading" in flattened, false);
    const input = Array.isArray(payload.input)
      ? payload.input as Array<Record<string, unknown>>
      : [];
    const replayedCall = input.find((item) => item.type === "function_call");
    if (replayedCall) {
      assert.equal("namespace" in replayedCall, false);
      assert.equal(replayedCall.name, flattened.name);
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.end([
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call-clean-selection",
          name: flattened.name,
          arguments: "{}",
        },
      })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-fixture" } })}`,
      "",
      "",
    ].join("\n"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  const upstream = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    wireApi: "responses" as const,
    requiresOpenAIAuth: false,
  };
  const namespaceTool = {
    type: "namespace",
    name: "mcp__lightrsi_cleaner",
    description: "LightRSI Cleaner tools.",
    tools: [{
      type: "function",
      name: "clean_selection",
      description: "Select completed tasks.",
      strict: false,
      defer_loading: true,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }],
  };
  try {
    const firstPayload = {
      model: "kimi-fixture",
      input: [{ role: "user", content: "select tasks" }],
      tools: [namespaceTool],
    };
    const first = await requestUpstreamResponsesStream({
      upstream,
      payload: firstPayload,
      stateDir,
    });
    assert.equal(first.status, 200);
    let firstText = "";
    for await (const chunk of first.stream) firstText += chunk.toString();
    assert.match(firstText, /"namespace":"mcp__lightrsi_cleaner"/u);
    assert.match(firstText, /"name":"clean_selection"/u);
    assert.equal(requests.length, 2);

    const secondPayload = {
      model: "kimi-fixture",
      input: [{
        type: "function_call",
        call_id: "call-clean-selection",
        namespace: "mcp__lightrsi_cleaner",
        name: "clean_selection",
        arguments: "{}",
      }, {
        type: "function_call_output",
        call_id: "call-clean-selection",
        output: "accepted",
      }],
      tools: [namespaceTool],
    };
    const second = await requestUpstreamResponsesStream({
      upstream,
      payload: secondPayload,
      stateDir,
    });
    assert.equal(second.status, 200);
    for await (const _chunk of second.stream) {
      // Drain the rewritten stream before closing the fixture.
    }
    assert.equal(requests.length, 3);
    assert.equal(namespaceTool.type, "namespace");
    assert.equal(namespaceTool.tools[0]?.name, "clean_selection");
    assert.equal(namespaceTool.tools[0]?.defer_loading, true);
    assert.equal(secondPayload.input[0]?.namespace, "mcp__lightrsi_cleaner");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("non-streaming upstream restores flattened namespace tool calls", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-namespace-json-"));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const tools = Array.isArray(payload.tools)
      ? payload.tools as Array<Record<string, unknown>>
      : [];
    if (tools.some((tool) => tool.type === "namespace")) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: {
          message: 'tool 2 has unsupported type "namespace"; only function tools can use Responses compatibility mode',
        },
      }));
      return;
    }
    const flattened = tools.find((tool) => tool.type === "function");
    assert.equal(typeof flattened?.name, "string");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp-json-fixture",
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "call-json-fixture",
        name: flattened?.name,
        arguments: "{}",
      }],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  try {
    const response = await requestUpstreamResponses({
      upstream: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      payload: {
        model: "kimi-fixture",
        input: [{ role: "user", content: "select tasks" }],
        tools: [{
          type: "namespace",
          name: "mcp__fixture",
          description: "Fixture tools.",
          tools: [{
            type: "function",
            name: "choose",
            description: "Choose a task.",
            parameters: { type: "object", properties: {} },
          }],
        }],
      },
      stateDir,
    });
    assert.equal(response.status, 200);
    const parsed = JSON.parse(response.text) as Record<string, unknown>;
    const output = parsed.output as Array<Record<string, unknown>>;
    assert.equal(output[0]?.namespace, "mcp__fixture");
    assert.equal(output[0]?.name, "choose");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("streaming upstream removes an explicitly unsupported hosted web search tool", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-web-search-capability-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    const tools = Array.isArray(payload.tools)
      ? payload.tools as Array<Record<string, unknown>>
      : [];
    if (tools.some((tool) => tool.type === "web_search")) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: {
          message: 'tool 185 has unsupported type "web_search"; only function tools can use Responses compatibility mode',
          type: "v_api_biz_error",
          code: "invalid_request",
        },
      }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  const upstream = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    wireApi: "responses" as const,
    requiresOpenAIAuth: false,
  };
  const payload = {
    model: "kimi-fixture",
    input: [{ role: "user", content: "test" }],
    tools: [{
      type: "function",
      name: "clean_selection",
      description: "Select completed tasks.",
      parameters: { type: "object", properties: {} },
    }, {
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
    }],
  };
  try {
    const first = await requestUpstreamResponsesStream({ upstream, payload, stateDir });
    assert.equal(first.status, 200);
    for await (const _chunk of first.stream) {
      // Drain the stream before the cached follow-up request.
    }
    assert.equal(requests.length, 2);
    assert.equal((requests[1]?.tools as unknown[]).length, 1);

    const second = await requestUpstreamResponsesStream({ upstream, payload, stateDir });
    assert.equal(second.status, 200);
    for await (const _chunk of second.stream) {
      // Drain the stream before closing the fixture.
    }
    assert.equal(requests.length, 3);
    assert.equal((requests[2]?.tools as unknown[]).length, 1);
    assert.equal(payload.tools.length, 2);
    assert.equal(payload.tools[1]?.type, "web_search");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("expired unsupported-field capability records allow one bounded retry", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-capability-expiry-"));
  let requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    if ("prompt_cache_retention" in payload) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: prompt_cache_retention" } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const endpoint = `${baseUrl}/responses`;
  try {
    await mkdir(join(stateDir, "upstream-capabilities", "responses"), { recursive: true });
    await writeFile(
      join(stateDir, "upstream-capabilities", "responses", `${encodeURIComponent(endpoint)}.json`),
      JSON.stringify({
        endpoint,
        unsupportedOptionalFields: ["prompt_cache_retention"],
        updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }),
      "utf8",
    );
    const response = await requestUpstreamResponses({
      upstream: { baseUrl, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        prompt_cache_retention: "24h",
        input: [{ role: "user", content: "test" }],
      },
      stateDir,
    });
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.prompt_cache_retention, "24h");
    assert.equal("prompt_cache_retention" in (requests[1] ?? {}), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("unsupported prompt_cache_options is persisted and retried once without that field", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cache-options-capability-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    if ("prompt_cache_options" in payload) {
      res.statusCode = 400;
      res.end(JSON.stringify({ detail: "Unsupported parameter: prompt_cache_options" }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  try {
    const response = await requestUpstreamResponses({
      upstream: { baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        input: [{ role: "user", content: "test" }],
      },
      stateDir,
    });
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.prompt_cache_options, { mode: "explicit", ttl: "30m" });
    assert.equal("prompt_cache_options" in (requests[1] ?? {}), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("unsupported content-block prompt_cache_breakpoint downgrades explicit caching only for that model", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cache-breakpoint-capability-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    const content = ((payload.input as Array<Record<string, unknown>> | undefined)?.[0]?.content ?? []) as Array<Record<string, unknown>>;
    if (content.some((part) => "prompt_cache_breakpoint" in part)) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: {
          type: "invalid_request_error",
          param: "prompt_cache_breakpoint",
          message: "prompt_cache_breakpoint is not supported on this model",
        },
      }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  const upstream = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    wireApi: "responses" as const,
    requiresOpenAIAuth: false,
  };
  const payload = {
    model: "gpt-5.6-fixture-a",
    prompt_cache_options: { mode: "explicit" },
    input: [{
      role: "developer",
      content: [{
        type: "input_text",
        text: "stable",
        prompt_cache_breakpoint: { mode: "explicit" },
      }],
    }],
    tools: [{
      type: "function",
      name: "fixture",
      parameters: {
        type: "object",
        properties: { prompt_cache_breakpoint: { type: "string" } },
      },
    }],
  };
  try {
    const first = await requestUpstreamResponses({ upstream, payload, stateDir });
    assert.equal(first.status, 200);
    assert.equal(requests.length, 2);
    assert.equal("prompt_cache_options" in (requests[1] ?? {}), false);
    const retryContent = (((requests[1]?.input as Array<Record<string, unknown>>)[0]?.content) ?? []) as Array<Record<string, unknown>>;
    assert.equal("prompt_cache_breakpoint" in (retryContent[0] ?? {}), false);
    const retryTools = requests[1]?.tools as Array<Record<string, unknown>>;
    assert.equal(JSON.stringify(retryTools).includes("prompt_cache_breakpoint"), true);
    assert.equal("prompt_cache_options" in payload, true);
    assert.equal("prompt_cache_breakpoint" in payload.input[0]!.content[0]!, true);

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
