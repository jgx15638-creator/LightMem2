import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { reserveUnusedPort } from "@lightrsi/host-adapter";
import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { createConsoleLogger } from "../src/logger.js";
import { startCodexResponsesProxy } from "../src/proxy-runtime.js";

async function startWireUpstream(params: {
  path: string;
  body: string;
  contentType: string;
  responseChunks?: string[];
  responseStatus?: number;
  chunkDelayMs?: number;
}) {
  const port = await reserveUnusedPort();
  const requests: string[] = [];
  const requestPaths: string[] = [];
  const requestMethods: string[] = [];
  let upstreamAbortCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    requests.push(Buffer.concat(chunks).toString("utf8"));
    requestPaths.push(req.url ?? "");
    requestMethods.push(req.method ?? "");
    if (req.method !== "POST" || req.url !== params.path) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.on("close", () => {
      if (!res.writableEnded) upstreamAbortCount += 1;
    });
    res.statusCode = params.responseStatus ?? 200;
    res.setHeader("content-type", params.contentType);
    const responseChunks = params.responseChunks ?? [params.body];
    for (const chunk of responseChunks) {
      if (res.destroyed) return;
      res.write(chunk);
      if (params.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, params.chunkDelayMs));
    }
    if (!res.destroyed) res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    requestPaths,
    requestMethods,
    get upstreamAbortCount() {
      return upstreamAbortCount;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function startPureForwardProxy(upstreamBaseUrl: string) {
  const proxyPort = await reserveUnusedPort();
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-pure-forward-"));
  const config = normalizeTokenPilotCodexConfig({
    proxyPort,
    stateDir,
    upstreamProvider: "capture",
    upstream: {
      name: "capture",
      baseUrl: upstreamBaseUrl,
      wireApi: "responses",
      requiresOpenAIAuth: false,
    },
    proxyMode: { pureForward: true },
    modules: { stabilizer: true, reduction: true },
  });
  const runtime = await startCodexResponsesProxy({
    config,
    logger: createConsoleLogger(false),
  });
  return {
    runtime,
    stateDir,
    cleanup: () => rm(stateDir, { recursive: true, force: true }),
  };
}

async function readPureForwardTrace(stateDir: string, stage = "pure_forward_timing") {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = (await readFile(`${stateDir}/event-trace.jsonl`, "utf8").catch(() => ""))
      .split(/\r?\n/u)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const row = rows.find((entry) => entry.stage === stage);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

test("pure forward preserves unknown JSON fields on chat completions", async () => {
  const upstream = await startWireUpstream({
    path: "/v1/chat/completions",
    contentType: "application/json",
    body: '{"id":"chat_capture","unknown_response_field":{"keep":true}}',
  });
  const proxy = await startPureForwardProxy(upstream.baseUrl);
  try {
    const requestBody = JSON.stringify({
      model: "capture-model",
      stream: false,
      unknown_request_field: { keep: true },
      messages: [{ role: "user", content: "hello" }],
    });
    const response = await fetch(`${proxy.runtime.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"id":"chat_capture","unknown_response_field":{"keep":true}}');
    assert.deepEqual(upstream.requests, [requestBody]);
  } finally {
    await proxy.runtime.close();
    await proxy.cleanup();
    await upstream.close();
  }
});

test("pure forward preserves SSE bytes and content type", async () => {
  const streamBody = "event: response.created\ndata: {\"id\":\"resp_capture\"}\n\nevent: response.completed\ndata: {}\n\n";
  const upstream = await startWireUpstream({
    path: "/v1/responses",
    contentType: "text/event-stream",
    body: streamBody,
    responseChunks: ["event: response.created\ndata: {\"id\":\"resp_capture\"}\n\n", "event: response.completed\ndata: {}\n\n"],
    chunkDelayMs: 20,
  });
  const proxy = await startPureForwardProxy(upstream.baseUrl);
  try {
    const requestBody = JSON.stringify({
      model: "capture-model",
      stream: true,
      input: [{ role: "user", content: "hello" }],
      unknown_request_field: [1, 2, 3],
    });
    const response = await fetch(`${proxy.runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), streamBody);
    assert.deepEqual(upstream.requests, [requestBody]);
    const trace = await readPureForwardTrace(proxy.stateDir);
    assert.equal(trace?.stage, "pure_forward_timing");
    assert.equal(trace?.responseStatus, 200);
    assert.equal(typeof trace?.requestId, "string");
    assert.equal(trace?.requestBytes, Buffer.byteLength(requestBody));
    assert.equal(trace?.responseStatus, 200);
    assert.equal(trace?.hasResponseBody, true);
    assert.equal(typeof trace?.pre_upstream_ms, "number");
    assert.equal(typeof trace?.upstream_headers_ms, "number");
    assert.equal(typeof trace?.upstream_first_chunk_ms, "number");
    assert.equal(typeof trace?.upstream_stream_ms, "number");
    assert.equal(typeof trace?.downstream_drain_ms, "number");
    assert.equal(typeof trace?.total_ms, "number");
    assert.equal(Number(trace?.upstream_first_chunk_ms) >= 0, true);
    assert.equal(Number(trace?.upstream_stream_ms) >= 0, true);
    assert.equal(Number(trace?.downstream_drain_ms) >= 0, true);
  } finally {
    await proxy.runtime.close();
    await proxy.cleanup();
    await upstream.close();
  }
});

test("pure forward preserves provider payload and endpoint with normal defaults", async () => {
  const streamBody = "event: response.completed\n\n";
  const upstream = await startWireUpstream({
    path: "/v1/responses",
    contentType: "text/event-stream",
    body: streamBody,
    responseChunks: [streamBody],
  });
  const proxy = await startPureForwardProxy(upstream.baseUrl);
  try {
    const requestBody = JSON.stringify({
      model: "capture-model",
      stream: true,
      prompt_cache_key: "session-cache-key",
      input: [{ role: "user", content: "hello" }],
    });
    const response = await fetch(`${proxy.runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), streamBody);
    assert.deepEqual(upstream.requestMethods, ["POST"]);
    assert.deepEqual(upstream.requestPaths, ["/v1/responses"]);
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0], requestBody);
    assert.equal(
      createHash("sha256").update(upstream.requests[0]).digest("hex"),
      createHash("sha256").update(requestBody).digest("hex"),
    );
    assert.equal(upstream.requestPaths.some((path) => path.endsWith("/models")), false);
  } finally {
    await proxy.runtime.close();
    await proxy.cleanup();
    await upstream.close();
  }
});

test("pure forward preserves upstream error status and body", async () => {
  const errorBody = JSON.stringify({ error: { type: "rate_limit_error" } });
  const upstream = await startWireUpstream({
    path: "/v1/responses",
    contentType: "application/json",
    body: errorBody,
    responseStatus: 429,
  });
  const proxy = await startPureForwardProxy(upstream.baseUrl);
  try {
    const response = await fetch(`${proxy.runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capture-model", input: [] }),
    });
    assert.equal(response.status, 429);
    assert.equal(await response.text(), errorBody);
    assert.deepEqual(upstream.requestMethods, ["POST"]);
    assert.deepEqual(upstream.requestPaths, ["/v1/responses"]);
  } finally {
    await proxy.runtime.close();
    await proxy.cleanup();
    await upstream.close();
  }
});
test("pure forward records empty-body timing without inventing chunks", async () => {
  const upstream = await startWireUpstream({
    path: "/v1/responses",
    contentType: "application/json",
    body: "",
  });
  const proxy = await startPureForwardProxy(upstream.baseUrl);
  try {
    const response = await fetch(`${proxy.runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capture-model", input: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    const trace = await readPureForwardTrace(proxy.stateDir);
    assert.equal(trace?.hasResponseBody, false);
    assert.equal(trace?.upstream_first_chunk_ms, null);
    assert.equal(trace?.upstream_stream_ms, null);
    assert.equal(typeof trace?.downstream_drain_ms, "number");
  } finally {
    await proxy.runtime.close();
    await proxy.cleanup();
    await upstream.close();
  }
});

test("pure forward abort cancels upstream response without unhandled rejection", async () => {
  const upstream = await startWireUpstream({
    path: "/v1/responses",
    contentType: "text/event-stream",
    body: "",
    responseChunks: ["event: response.created\\n\\n", "event: response.completed\\n\\n"],
    chunkDelayMs: 500,
  });
  const proxy = await startPureForwardProxy(upstream.baseUrl);
  try {
    const response = await fetch(`${proxy.runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capture-model", stream: true, input: [] }),
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    try {
      await reader.read();
    } catch (error) {
      assert.equal((error as Error).name, "AbortError");
    }
    await reader.cancel().catch(() => {});
    for (let attempt = 0; attempt < 40 && upstream.upstreamAbortCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(upstream.upstreamAbortCount > 0, true);
    const trace = await readPureForwardTrace(proxy.stateDir, "pure_forward_cancelled");
    assert.equal(trace?.stage, "pure_forward_cancelled");
    assert.equal(["request_aborted", "response_close_before_finish"].includes(String(trace?.abortSource)), true);
  } finally {
    await proxy.runtime.close();
    await proxy.cleanup();
    await upstream.close();
  }
});

test("Codex Responses WebSocket warmup is retained for the next generated turn", async () => {
  const streamBody = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-generated"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-generated","status":"completed","output":[]}}\n\n',
  ].join("");
  const upstream = await startWireUpstream({
    path: "/v1/responses",
    contentType: "text/event-stream",
    body: streamBody,
    responseChunks: [streamBody],
  });
  const proxy = await startPureForwardProxy(upstream.baseUrl);
  const socket = new WebSocket(`${proxy.runtime.baseUrl.replace(/^http/u, "ws")}/responses`);
  try {
    const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const received: Array<Record<string, unknown>> = [];
      const timer = setTimeout(() => reject(new Error("timed out waiting for warmup continuation")), 5_000);
      socket.once("error", reject);
      socket.once("open", () => {
        socket.send(JSON.stringify({
          type: "response.create",
          stream_id: "main",
          generate: false,
          model: "gpt-fixture",
          input: [{ type: "message", role: "developer", content: "stable instructions" }],
          tools: [],
        }));
      });
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        const response = event.response && typeof event.response === "object" && !Array.isArray(event.response)
          ? event.response as Record<string, unknown>
          : undefined;
        received.push(event);
        if (event.type === "response.completed"
          && String(response?.id).startsWith("resp_lightrsi_warmup_")) {
          socket.send(JSON.stringify({
            type: "response.create",
            stream_id: "main",
            previous_response_id: response!.id,
            model: "gpt-fixture",
            input: [{ type: "message", role: "user", content: "hello" }],
          }));
          return;
        }
        if (event.type === "response.completed" && response?.id === "resp-generated") {
          clearTimeout(timer);
          resolve(received);
        }
      });
    });
    assert.equal(events.filter((event) => event.type === "response.completed").length, 2);
    assert.equal(upstream.requests.length, 1);
    const forwarded = JSON.parse(upstream.requests[0]!) as Record<string, unknown>;
    assert.equal(forwarded.previous_response_id, undefined);
    assert.equal(forwarded.generate, undefined);
    assert.deepEqual(forwarded.input, [
      { type: "message", role: "developer", content: "stable instructions" },
      { type: "message", role: "user", content: "hello" },
    ]);
  } finally {
    socket.close();
    await proxy.runtime.close();
    await proxy.cleanup();
    await upstream.close();
  }
});
