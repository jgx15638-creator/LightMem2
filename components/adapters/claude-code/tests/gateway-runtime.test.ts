import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRecoveryProtocolText,
  assertStablePrefixRewrite,
  type HostGatewayForwarder,
} from "@lightrsi/host-adapter";
import {
  loadSessionTaskRegistry,
  persistSessionTaskRegistry,
  sessionTaskRegistryPath,
} from "@lightrsi/history";
import { readVisualSessionData, readVisualSessionList } from "@lightrsi/product-surface";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";
import { readLatestClaudeSnapshotRecord } from "../src/context-rewrite/snapshot-store.js";

async function reserveUnusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTestJsonServer(handler: (
  req: import("node:http").IncomingMessage,
  body: string,
) => {
  status?: number;
  headers?: Record<string, string>;
  payload?: unknown;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const port = await reserveUnusedPort();
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const result = handler(req, body);
    res.statusCode = result.status ?? 200;
    res.setHeader("content-type", "application/json");
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      res.setHeader(key, value);
    }
    res.end(JSON.stringify(result.payload ?? {}));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test("gateway runtime serves health and forwards Claude Messages requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: unknown[] = [];
  const forwarder: HostGatewayForwarder = {
    async requestRaw() {
      throw new Error("requestRaw not used in test");
    },
    async request(params) {
      seenPayloads.push(params.payload);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 12, output_tokens: 4 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const healthResp = await fetch(`${runtime.baseUrl}/health`);
    assert.equal(healthResp.status, 200);
    const health = await healthResp.json();
    assert.equal(health.ok, true);

    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        system: "stay stable",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);
    const payload = await requestResp.json();
    assert.equal(payload.id, "msg_test_1");
    assert.equal((seenPayloads as Record<string, unknown>[]).length, 1);
    assert.equal(((seenPayloads[0] as Record<string, unknown>).model), "claude-sonnet-4-6");
    const cleanerSnapshot = await readLatestClaudeSnapshotRecord(
      join(dir, "state"),
      "sess-runtime-1",
    );
    assert.equal(cleanerSnapshot?.model, "claude-sonnet-4-6");
    assert.equal(cleanerSnapshot?.snapshot.items.length, 1);
    assert.equal(cleanerSnapshot?.snapshot.items[0]?.chars, "hello".length);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway snapshot persistence is fail-open and logs only reported failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-snapshot-result-"));
  const proxyPort = await reserveUnusedPort();
  const warnings: string[] = [];
  let saveCount = 0;
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: false },
    }),
    logger: {
      debug() {},
      info() {},
      warn(message) { warnings.push(message); },
      error() {},
    },
    forwarder: {
      requestRaw: async () => { throw new Error("requestRaw not used in test"); },
      async request() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            id: "msg_snapshot_result",
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: "end_turn",
          }),
        };
      },
      async requestStream() { throw new Error("stream not used"); },
    },
    dependencies: {
      async saveSnapshot() {
        saveCount += 1;
        return saveCount === 1
          ? { saved: true as const }
          : { saved: false as const, reason: "write_failed" as const };
      },
    },
  });

  async function send(label: string): Promise<void> {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess-snapshot-result" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: label }] }],
        max_tokens: 32,
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  try {
    await send("first");
    await send("second");
    assert.equal(saveCount, 2);
    assert.deepEqual(
      warnings.filter((message) => message.includes("snapshot persistence failed")),
      ["context cleaner snapshot persistence failed (ignored): write_failed"],
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway persists an unassigned snapshot when task registry recovery fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-registry-failure-"));
  const stateDir = join(dir, "state");
  const sessionId = "sess-registry-failure";
  const proxyPort = await reserveUnusedPort();
  const warnings: string[] = [];
  const registryPath = sessionTaskRegistryPath(stateDir, sessionId);
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, "{broken", "utf8");

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir,
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: false },
    }),
    logger: {
      debug() {},
      info() {},
      warn(message) { warnings.push(message); },
      error() {},
    },
    forwarder: {
      requestRaw: async () => { throw new Error("requestRaw not used in test"); },
      async request() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            id: "msg_registry_failure",
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: "end_turn",
          }),
        };
      },
      async requestStream() { throw new Error("stream not used"); },
    },
  });

  try {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: "inspect" }] }],
        max_tokens: 32,
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const snapshot = await readLatestClaudeSnapshotRecord(stateDir, sessionId);
    assert.equal(snapshot?.snapshot.items.length, 1);
    assert.equal(snapshot?.snapshot.items[0]?.taskIds, undefined);
    assert.equal(
      warnings.filter((message) => message.includes("task attribution failed")).length,
      1,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway publishes only block-proven task attribution from the persisted registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-snapshot-tasks-"));
  const stateDir = join(dir, "state");
  const sessionId = "sess-snapshot-tasks";
  const proxyPort = await reserveUnusedPort();
  const seeded = await loadSessionTaskRegistry(stateDir, sessionId);
  seeded.version = 1;
  seeded.tasks["task-proven"] = {
    taskId: "task-proven",
    title: "proven task",
    objective: "read the file",
    lifecycle: "completed",
    completionEvidence: ["done"],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${sessionId}:t1`,
      lastTurnAbsId: `${sessionId}:t1`,
      supportingTurnAbsIds: [`${sessionId}:t1`],
      lastEstimatorTurnAbsId: `${sessionId}:t1`,
    },
  };
  seeded.completedTaskIds = ["task-proven"];
  seeded.blockToTaskIds = {
    "anthropic-tool-result:toolu_proven": ["task-proven"],
  };
  seeded.taskToBlockIds = {
    "task-proven": ["anthropic-tool-result:toolu_proven"],
  };
  await persistSessionTaskRegistry(stateDir, seeded, { expectedVersion: 0 });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir,
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: false },
    }),
    logger: createConsoleLogger(false),
    forwarder: {
      requestRaw: async () => { throw new Error("requestRaw not used in test"); },
      async request() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            id: "msg_snapshot_tasks",
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: "end_turn",
          }),
        };
      },
      async requestStream() { throw new Error("stream not used"); },
    },
  });
  const messages = [
    { role: "user", content: [{ type: "text", text: "read" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_proven", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_proven", content: "body" }],
    },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "current" }] },
  ];

  try {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        messages,
        max_tokens: 32,
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const snapshot = await readLatestClaudeSnapshotRecord(stateDir, sessionId);
    const toolPair = snapshot?.snapshot.items.filter(
      (item) => item.callId === "toolu_proven",
    ) ?? [];
    assert.equal(toolPair.length, 2);
    assert.ok(toolPair.every((item) => (
      JSON.stringify(item.taskIds) === JSON.stringify(["task-proven"])
    )));
    assert.equal(snapshot?.snapshot.items.at(-1)?.taskIds, undefined);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime proxies Claude model discovery and count_tokens for Anthropic-compatible upstreams", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-probes-"));
  const proxyPort = await reserveUnusedPort();
  const seenRequests: Array<{ method: string; url: string; auth?: string; xApiKey?: string }> = [];
  const upstream = await startTestJsonServer((req, body) => {
    seenRequests.push({
      method: String(req.method ?? ""),
      url: String(req.url ?? ""),
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      xApiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
    });
    if (req.method === "GET" && req.url === "/anthropic/v1/models") {
      return {
        payload: {
          data: [{ id: "deepseek-chat", type: "model", display_name: "DeepSeek Chat" }],
        },
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages/count_tokens") {
      return {
        payload: {
          input_tokens: 42,
        },
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages") {
      const parsed = JSON.parse(body) as { model?: string };
      return {
        payload: {
          id: "msg_probe_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: String(parsed.model ?? "ok") }],
        },
      };
    }
    return {
      status: 404,
      payload: {
        error: "not found",
      },
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const modelsResp = await fetch(`${runtime.baseUrl}/v1/models`, {
      headers: {
        authorization: "Bearer inbound-token",
      },
    });
    assert.equal(modelsResp.status, 200);
    const models = await modelsResp.json() as { data?: Array<{ id?: string }> };
    assert.equal(models.data?.[0]?.id, "deepseek-chat");

    const countResp = await fetch(`${runtime.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer inbound-token",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        system: "stay stable",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    });
    assert.equal(countResp.status, 200);
    const countPayload = await countResp.json() as { input_tokens?: number };
    assert.equal(countPayload.input_tokens, 42);

    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer inbound-token",
        "x-session-id": "sess-probes-1",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        max_tokens: 64,
      }),
    });
    assert.equal(requestResp.status, 200);
    const payload = await requestResp.json() as { content?: Array<{ text?: string }> };
    assert.equal(payload.content?.[0]?.text, "deepseek-chat");

    assert.deepEqual(
      seenRequests.map((item) => [item.method, item.url]),
      [
        ["GET", "/anthropic/v1/models"],
        ["POST", "/anthropic/v1/messages/count_tokens"],
        ["POST", "/anthropic/v1/messages"],
      ],
    );
    assert.equal(seenRequests[0]?.auth, "Bearer inbound-token");
    assert.equal(seenRequests[0]?.xApiKey, undefined);
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime synthesizes a local model list when DeepSeek anthropic /v1/models is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-model-fallback-"));
  const proxyPort = await reserveUnusedPort();
  const upstream = await startTestJsonServer((req, body) => {
    if (req.method === "GET" && req.url === "/anthropic/v1/models") {
      return {
        status: 404,
        payload: {},
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages") {
      const parsed = JSON.parse(body) as { model?: string };
      return {
        payload: {
          id: "msg_fallback_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: String(parsed.model ?? "ok") }],
        },
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages/count_tokens") {
      return {
        payload: {
          input_tokens: 7,
        },
      };
    }
    return {
      status: 404,
      payload: {},
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const modelsResp = await fetch(`${runtime.baseUrl}/v1/models`);
    assert.equal(modelsResp.status, 200);
    const models = await modelsResp.json() as { data?: Array<{ id?: string }> };
    const ids = (models.data ?? []).map((item) => item.id);
    assert.ok(ids.length > 0);
    assert.ok(ids.some((id) => typeof id === "string" && id.startsWith("claude-")));
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime synthesizes configured third-party model ids when upstream model discovery is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-generic-models-"));
  const proxyPort = await reserveUnusedPort();
  const seenRequests: Array<{ method: string; url: string; body?: { model?: string } }> = [];
  const upstream = await startTestJsonServer((req, body) => {
    const parsed = body ? JSON.parse(body) as { model?: string } : undefined;
    seenRequests.push({
      method: String(req.method ?? ""),
      url: String(req.url ?? ""),
      body: parsed,
    });
    if (req.method === "POST" && req.url === "/anthropic/v1/messages") {
      return {
        payload: {
          id: "msg_generic_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: String(parsed?.model ?? "ok") }],
        },
      };
    }
    return {
      status: 404,
      payload: {
        error: "not found",
      },
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
      upstreamModel: "glm-5.2[1m]",
      visibleModels: ["glm-5.2[1m]", "glm-4.7"],
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const modelsResp = await fetch(`${runtime.baseUrl}/v1/models`);
    assert.equal(modelsResp.status, 200);
    const models = await modelsResp.json() as { data?: Array<{ id?: string }> };
    assert.deepEqual(models.data?.map((entry) => entry.id), ["glm-5.2[1m]", "glm-4.7"]);

    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-generic-models-1",
      },
      body: JSON.stringify({
        model: "glm-5.2[1m]",
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        max_tokens: 64,
      }),
    });
    assert.equal(requestResp.status, 200);
    const payload = await requestResp.json() as { content?: Array<{ text?: string }> };
    assert.equal(payload.content?.[0]?.text, "glm-5.2[1m]");
    assert.deepEqual(
      seenRequests.map((item) => [item.method, item.url, item.body?.model]),
      [
        ["GET", "/anthropic/v1/models", undefined],
        ["POST", "/anthropic/v1/messages", "glm-5.2[1m]"],
      ],
    );
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime records session-state and ux-effects after a reduced request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-state-"));
  const proxyPort = await reserveUnusedPort();
  const longToolPayload = `payload\n${"line\n".repeat(800)}`;
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request() {
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_state_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 20, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 300,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: true,
          agentsStartupOptimization: false,
        },
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-state-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /repo/demo",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
              { type: "tool_result", tool_use_id: "toolu_1", content: longToolPayload },
            ],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);

    const latest = JSON.parse(
      await readFile(join(dir, "state", "session-state", "latest.json"), "utf8"),
    ) as { sessionId: string };
    assert.equal(latest.sessionId, "sess-state-1");

    const snapshot = JSON.parse(
      await readFile(join(dir, "state", "session-state", "sessions", "sess-state-1.json"), "utf8"),
    ) as { latestResponseId?: string; reductionSavedChars?: number; workspaceHint?: string };
    assert.equal(snapshot.latestResponseId, "msg_state_1");
    assert.equal(typeof snapshot.reductionSavedChars, "number");
    assert.equal(snapshot.workspaceHint, "/repo/demo");

    const ux = JSON.parse(
      await readFile(join(dir, "state", "ux-effects", "latest.json"), "utf8"),
    ) as { sessionId: string; savedCount: number; countMode?: string };
    assert.equal(ux.sessionId, "sess-state-1");
    assert.equal(ux.countMode, "chars");
    assert.ok(ux.savedCount > 0);

    const sessions = await readVisualSessionList(join(dir, "state"));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "sess-state-1");
    assert.equal(sessions[0]?.stabilityCount, 1);
    assert.ok((sessions[0]?.reductionCount ?? 0) > 0);

    const visual = await readVisualSessionData(join(dir, "state"), "sess-state-1");
    assert.equal(visual.stability.length, 1);
    assert.ok(visual.reduction.length > 0);
    assert.match(visual.stability[0]?.developerCanonical ?? "", /<WORKDIR>/);
    assert.match(visual.stability[0]?.dynamicContextText ?? "", /WORKDIR: \/repo\/demo/);
    assert.ok((visual.reduction[0]?.savedChars ?? 0) > 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime reuses the latest real Claude hook session when request markers are absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-session-merge-"));
  const proxyPort = await reserveUnusedPort();
  const stateDir = join(dir, "state");
  const longToolPayload = `payload\n${"line\n".repeat(800)}`;
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request() {
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_merge_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  await upsertClaudeCodeSessionSnapshot(stateDir, "claude-real-session-1", {
    lastHookEvent: "SessionStart",
    workspaceHint: "/repo/demo",
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir,
      proxyPort,
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (let turn = 0; turn < 2; turn += 1) {
      const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: false,
          system: "Your working directory is: /repo/demo",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `hello ${turn}` },
                { type: "tool_result", tool_use_id: `toolu_${turn}`, content: longToolPayload },
              ],
            },
          ],
          max_tokens: 64,
        }),
      });
      assert.equal(response.status, 200);
    }

    const latest = JSON.parse(
      await readFile(join(stateDir, "session-state", "latest.json"), "utf8"),
    ) as { sessionId: string };
    assert.equal(latest.sessionId, "claude-real-session-1");

    const sessions = await readVisualSessionList(stateDir);
    assert.deepEqual(sessions.map((entry) => entry.sessionId), ["claude-real-session-1"]);

    const visual = await readVisualSessionData(stateDir, "claude-real-session-1");
    assert.equal(visual.sessionId, "claude-real-session-1");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime reuses disclosed read paths from prior Claude session snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-disclosed-"));
  const proxyPort = await reserveUnusedPort();
  const codePayload = `
export function loadConfig(file: string) {
  return file.trim();
}

export function saveConfig(file: string, text: string) {
  return text + file;
}
`.repeat(30);
  const seenPayloads: Array<Record<string, unknown>> = [];
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_disclosed_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 20, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 300,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: false,
          agentsStartupOptimization: false,
        },
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (let turn = 0; turn < 2; turn += 1) {
      const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-disclosed-1",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: false,
          system: "Your working directory is: /repo/demo",
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: `toolu_read_${turn}`,
                  name: "Read",
                  input: { path: "/repo/src/config.ts" },
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "text", text: "summarize this" },
                { type: "tool_result", tool_use_id: `toolu_read_${turn}`, content: codePayload },
              ],
            },
          ],
          max_tokens: 256,
        }),
      });
      assert.equal(response.status, 200);
    }

    assert.equal(seenPayloads.length, 2);
    const firstMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const secondMessages = seenPayloads[1]?.messages as Array<Record<string, unknown>>;
    const firstToolResult = ((firstMessages?.[1]?.content as Array<Record<string, unknown>>)?.[1] ?? {}) as Record<string, unknown>;
    const secondToolResult = ((secondMessages?.[1]?.content as Array<Record<string, unknown>>)?.[1] ?? {}) as Record<string, unknown>;

    assert.match(String(firstToolResult.content ?? firstToolResult.text ?? ""), /\[code outlined lines=/);
    assert.doesNotMatch(String(secondToolResult.content ?? secondToolResult.text ?? ""), /\[code outlined lines=/);
    assert.match(String(secondToolResult.content ?? secondToolResult.text ?? ""), /export function loadConfig/);

    const snapshot = JSON.parse(
      await readFile(join(dir, "state", "session-state", "sessions", "sess-disclosed-1.json"), "utf8"),
    ) as { disclosedReadPaths?: string[] };
    assert.deepEqual(snapshot.disclosedReadPaths, ["/repo/src/config.ts"]);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime does not record ux-effects when reduced request fails upstream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-failed-"));
  const proxyPort = await reserveUnusedPort();
  const longToolPayload = `payload\n${"line\n".repeat(800)}`;
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request() {
      throw new Error("upstream failed");
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 300,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: true,
          agentsStartupOptimization: false,
        },
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-failed-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /repo/demo",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
              { type: "tool_result", tool_use_id: "toolu_1", content: longToolPayload },
            ],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 500);
    await assert.rejects(
      readFile(join(dir, "state", "ux-effects", "latest.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime applies stable-prefix rewrite before forwarding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-stable-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_2",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-2",
      },
      body: JSON.stringify({
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);
    assert.equal(seenPayloads.length, 1);
    assert.equal(seenPayloads[0]?.model, "claude-sonnet-4-6");
    assert.equal("prompt_cache_key" in seenPayloads[0], false);
    assert.deepEqual(seenPayloads[0]?.cache_control, { type: "ephemeral" });
    assert.match(String(seenPayloads[0]?.system ?? ""), /Your working directory is: \/tmp\/demo/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Runtime: agent=agent-123\s*\|/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Be precise\./);
    assertRecoveryProtocolText(String(seenPayloads[0]?.system ?? ""));
    const forwardedMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const forwardedUserBlocks = forwardedMessages?.[0]?.content as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(forwardedUserBlocks), true);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime supports developer-targeted stable-prefix injection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-devtarget-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_3",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "developer",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-3",
      },
      body: JSON.stringify({
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);
    assert.equal(seenPayloads.length, 1);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Your working directory is: \/tmp\/demo/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Runtime: agent=agent-123 \|/);
    assert.equal("prompt_cache_key" in seenPayloads[0], false);
    assert.deepEqual(seenPayloads[0]?.cache_control, { type: "ephemeral" });
    const forwardedMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const forwardedUserBlocks = forwardedMessages?.[0]?.content as Array<Record<string, unknown>>;
    assert.equal(String(forwardedUserBlocks?.[0]?.text ?? ""), "hello");

    const visual = await readVisualSessionData(join(dir, "state"), "sess-runtime-3");
    assert.equal(visual.stability.length, 1);
    assert.equal(visual.stability[0]?.dynamicContextTarget, "developer");
    assert.match(visual.stability[0]?.developerForwarded ?? "", /Your working directory is: \/tmp\/demo/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime reuses the same Claude prompt_cache_key for the same stable prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-cache-key-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_cache_key",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (const agentId of ["agent-123", "agent-456"]) {
      const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-runtime-cache-key",
        },
        body: JSON.stringify({
          model: "tokenpilot/claude-sonnet-4-6",
          stream: false,
          system: `Your working directory is: /tmp/demo\nRuntime: agent=${agentId} |\nBe precise.`,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          max_tokens: 256,
        }),
      });
      assert.equal(requestResp.status, 200);
    }

    assert.equal(seenPayloads.length, 2);
    assert.equal("prompt_cache_key" in seenPayloads[0], false);
    assert.equal("prompt_cache_key" in seenPayloads[1], false);
    assert.deepEqual(seenPayloads[0]?.cache_control, seenPayloads[1]?.cache_control);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime preserves inbound Claude prompt_cache_key while converging framework stable keys for diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-force-cache-key-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: `msg_force_cache_${seenPayloads.length}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (const inboundKey of ["legacy-key-a", "legacy-key-b"]) {
      const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-runtime-force-cache-key",
        },
        body: JSON.stringify({
          model: "tokenpilot/claude-sonnet-4-6",
          stream: false,
          prompt_cache_key: inboundKey,
          system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          max_tokens: 256,
        }),
      });
      assert.equal(response.status, 200);
    }

    assert.equal(seenPayloads.length, 2);
    assert.equal("prompt_cache_key" in seenPayloads[0], false);
    assert.equal("prompt_cache_key" in seenPayloads[1], false);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime caches unsupported cache_control for Anthropic-compatible upstreams and skips retry later", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-capability-"));
  const proxyPort = await reserveUnusedPort();
  const seenRequests: Array<Record<string, unknown>> = [];
  const upstream = await startTestJsonServer((_req, body) => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    seenRequests.push(parsed);
    if ("cache_control" in parsed) {
      return {
        status: 400,
        payload: {
          error: {
            message: "Unsupported parameter: cache_control",
            type: "bad_response_status_code",
            param: "",
            code: "bad_response_status_code",
          },
        },
      };
    }
    return {
      payload: {
        id: `msg_cap_${seenRequests.length}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const requestBody = JSON.stringify({
      model: "tokenpilot/claude-sonnet-4-6",
      stream: false,
      system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      max_tokens: 256,
    });

    const first = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-capability-1",
      },
      body: requestBody,
    });
    const second = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-capability-1",
      },
      body: requestBody,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(seenRequests.length, 3);
    assert.equal("cache_control" in (seenRequests[0] ?? {}), true);
    assert.equal("cache_control" in (seenRequests[1] ?? {}), false);
    assert.equal("cache_control" in (seenRequests[2] ?? {}), false);

    const capabilityRaw = await readFile(
      join(
        dir,
        "state",
        "upstream-capabilities",
        "anthropic-messages",
        encodeURIComponent(`${upstream.baseUrl}/anthropic/v1/messages`) + ".json",
      ),
      "utf8",
    );
    const capability = JSON.parse(capabilityRaw) as { unsupportedOptionalFields?: string[] };
    assert.deepEqual(capability.unsupportedOptionalFields, ["cache_control"]);
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway eviction preserves tool closure and the active user turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-eviction-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Array<Record<string, unknown>> = [];
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "msg_eviction_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 20, output_tokens: 4 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: true },
      eviction: { enabled: true, minBlockChars: 256 },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  const originalMessages = [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_eviction_1",
        name: "Read",
        input: { file_path: "/repo/large.txt" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_eviction_1",
        content: "EVICT_ME_" + "x".repeat(5000),
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "previous task complete" }] },
    { role: "user", content: [{ type: "text", text: "KEEP_ME_current_user_turn" }] },
  ];
  try {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-eviction-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        messages: originalMessages,
        max_tokens: 256,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(seenPayloads.length, 1);

    const messages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const toolUse = (messages[1]?.content as Array<Record<string, unknown>>)[0];
    const toolResult = (messages[2]?.content as Array<Record<string, unknown>>)[0];
    const activeUser = (messages.at(-1)?.content as Array<Record<string, unknown>>)[0];
    assert.equal(toolUse?.id, "toolu_eviction_1");
    assert.equal(toolResult?.type, "tool_result");
    assert.equal(toolResult?.tool_use_id, "toolu_eviction_1");
    assert.match(String(toolResult?.content), /^\[(evicted:|Tool payload trimmed)/);
    assert.equal(activeUser?.text, "KEEP_ME_current_user_turn");

    const trace = (await readFile(join(dir, "state", "event-trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const beforeCall = trace.find((entry) => entry.stage === "gateway_before_call");
    assert.equal(beforeCall?.evictionEnabled, true);
    assert.equal(beforeCall?.evictionApplied, true);
    assert.equal(beforeCall?.evictionChangedToolResults, 1);
    assert.ok(Number(beforeCall?.evictionSavedChars) > 0);

    const cleanerSnapshot = await readLatestClaudeSnapshotRecord(
      join(dir, "state"),
      "sess-eviction-1",
    );
    const originalRevision = createHash("sha256")
      .update(JSON.stringify(originalMessages))
      .digest("hex")
      .slice(0, 32);
    assert.equal(cleanerSnapshot?.snapshot.revision, originalRevision);
    assert.equal(cleanerSnapshot?.snapshot.items.length, 5);
    assert.equal(
      cleanerSnapshot?.snapshot.items.find((item) => item.kind === "tool_result")?.chars,
      ("EVICT_ME_" + "x".repeat(5000)).length,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway relocates a persisted plan onto shifted history across turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-reloc-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Array<Record<string, unknown>> = [];
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "msg_reloc",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 20, output_tokens: 4 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: true },
      eviction: { enabled: true, minBlockChars: 256 },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  // The same completed tool_use/tool_result pair appears in both turns; only its
  // position (and therefore stableId + revision) shifts when a new earlier turn
  // is prepended in turn 2. The evicted content is identical so its fingerprint
  // is stable — relocation must re-anchor the persisted plan onto the new index.
  const bigToolResult = "EVICT_ME_" + "x".repeat(5000);
  const toolPair = [
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_reloc_1",
        name: "Read",
        input: { file_path: "/repo/large.txt" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_reloc_1",
        content: bigToolResult,
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "previous task complete" }] },
  ];

  async function sendTurn(messages: unknown[]): Promise<void> {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess-reloc-e2e" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: false, messages, max_tokens: 256 }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  try {
    // Turn 1: tool_result at msgIdx 2.
    await sendTurn([
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      ...toolPair,
      { role: "user", content: [{ type: "text", text: "KEEP_ME_turn1" }] },
    ]);

    // Turn 2: prepend a completed earlier exchange so the SAME tool_result now
    // sits two indices later (msgIdx shifts, revision changes).
    await sendTurn([
      { role: "user", content: [{ type: "text", text: "an earlier request" }] },
      { role: "assistant", content: [{ type: "text", text: "earlier request handled" }] },
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      ...toolPair,
      { role: "user", content: [{ type: "text", text: "KEEP_ME_turn2" }] },
    ]);

    assert.equal(seenPayloads.length, 2);

    // Turn 2 forwarded payload: the shifted tool_result must still be evicted.
    const turn2 = seenPayloads[1]?.messages as Array<Record<string, unknown>>;
    const evictedInTurn2 = turn2.some((message) => {
      const content = message?.content;
      if (!Array.isArray(content)) return false;
      return content.some((block) => {
        const record = block as Record<string, unknown>;
        return record.type === "tool_result"
          && record.tool_use_id === "toolu_reloc_1"
          && /^\[(evicted:|Tool payload trimmed)/.test(String(record.content));
      });
    });
    assert.equal(evictedInTurn2, true);

    // The original large body must NOT reach upstream in turn 2.
    assert.equal(JSON.stringify(seenPayloads[1]).includes(bigToolResult), false);

    // The current user turn is always preserved.
    const turn2Active = (turn2.at(-1)?.content as Array<Record<string, unknown>>)[0];
    assert.equal(turn2Active?.text, "KEEP_ME_turn2");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runs the semantic pipeline when an estimator is injected, and stays fail-open when it throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-semantic-"));
  const proxyPort = await reserveUnusedPort();
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request() {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "msg_sem_1", type: "message", role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 3 }, stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() { throw new Error("stream not used"); },
  };

  // A fake estimator whose estimate() THROWS. The semantic block must catch it
  // and let the request proceed unchanged (fail-open).
  const throwingResolveEstimator = () => ({
    estimate() { throw new Error("estimator boom"); },
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
    }),
    logger: createConsoleLogger(false),
    forwarder,
    dependencies: { resolveEstimator: throwingResolveEstimator as never },
  });

  try {
    const resp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess-sem-fail" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        max_tokens: 128,
      }),
    });
    // Estimator threw, but the request is unaffected — fail-open.
    assert.equal(resp.status, 200);
    const body = JSON.parse(await resp.text()) as { id?: string };
    assert.equal(body.id, "msg_sem_1");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway persists a task registry when the injected estimator returns updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-gateway-semantic-ok-"));
  const proxyPort = await reserveUnusedPort();
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request() {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "msg_sem_2", type: "message", role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 3 }, stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() { throw new Error("stream not used"); },
  };

  // A fake estimator that returns a single task update, so the registry should
  // change and be persisted. baseVersion 0 matches a fresh (empty) registry.
  const okResolveEstimator = () => ({
    estimate() {
      return {
        baseVersion: 0,
        taskUpdates: [
          {
            taskId: "task-1",
            lifecycle: "active",
            objective: "do the thing",
            coveredTurnAbsIds: ["sess-sem-ok:t1"],
          },
        ],
      };
    },
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      taskStateEstimator: { enabled: true, batchTurns: 1 },
    }),
    logger: createConsoleLogger(false),
    forwarder,
    dependencies: { resolveEstimator: okResolveEstimator as never },
  });

  try {
    const resp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess-sem-ok" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        messages: [
          { role: "user", content: [{ type: "text", text: "start a task" }] },
        ],
        max_tokens: 128,
      }),
    });
    assert.equal(resp.status, 200);

    // The semantic block ran and persisted a registry for this session.
    const registryRaw = await readFile(
      join(dir, "state", "task-state", "sess-sem-ok", "registry.json"),
      "utf8",
    );
    const registry = JSON.parse(registryRaw) as { sessionId: string; version: number };
    assert.equal(registry.sessionId, "sess-sem-ok");
    assert.ok(registry.version >= 1);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lifecycle estimator rewrites the real Claude upstream payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-lifecycle-e2e-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Array<Record<string, unknown>> = [];
  const bigToolResult = "EVICT_ME_" + "x".repeat(5000);
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: `msg_lifecycle_${seenPayloads.length}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 3 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() { throw new Error("stream not used"); },
  };
  let estimateCount = 0;
  const resolveEstimator = () => ({
    estimate({ registry, delta }: { registry: { version: number }; delta: { coveredTurnAbsIds: string[] } }) {
      estimateCount += 1;
      const evictable = estimateCount > 1;
      return {
        baseVersion: registry.version,
        taskUpdates: [{
          taskId: "task-lifecycle-e2e",
          lifecycle: evictable ? "evictable" : "completed",
          objective: "read and finish the file task",
          completionEvidence: ["assistant confirmed the task is complete"],
          coveredTurnAbsIds: delta.coveredTurnAbsIds,
        }],
      };
    },
  });
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: true },
      eviction: { enabled: true, minBlockChars: 256 },
      taskStateEstimator: { enabled: true, batchTurns: 1 },
    }),
    logger: createConsoleLogger(false),
    forwarder,
    dependencies: { resolveEstimator: resolveEstimator as never },
  });

  const toolHistory = [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_lifecycle_e2e", name: "Read", input: { file_path: "/repo/data.txt" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_lifecycle_e2e", content: bigToolResult }],
    },
  ];

  async function send(messages: unknown[]): Promise<void> {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess-lifecycle-e2e" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: false, messages, max_tokens: 128 }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  try {
    // First pass establishes completion evidence and the tool call's turn anchor.
    await send(toolHistory);
    // The second estimate promotes the same task to evictable. The old tool
    // result is now outside the current user turn and must be mapped back to t1.
    await send([
      ...toolHistory,
      { role: "assistant", content: [{ type: "text", text: "task complete" }] },
      { role: "user", content: [{ type: "text", text: "KEEP_ME_current_turn" }] },
    ]);

    assert.equal(seenPayloads.length, 2);
    const secondMessages = seenPayloads[1]!.messages as Array<Record<string, unknown>>;
    assert.equal(JSON.stringify(seenPayloads[1]).includes(bigToolResult), false);
    const toolUse = (secondMessages[1]!.content as Array<Record<string, unknown>>)[0];
    const toolResult = (secondMessages[2]!.content as Array<Record<string, unknown>>)[0];
    assert.equal(toolUse.id, "toolu_lifecycle_e2e");
    assert.equal(toolResult.tool_use_id, "toolu_lifecycle_e2e");
    assert.match(String(toolResult.content), /Tool payload trimmed|evicted: earlier tool result/);
    assert.equal((secondMessages.at(-1)!.content as Array<Record<string, unknown>>)[0]!.text, "KEEP_ME_current_turn");

    const trace = (await readFile(join(dir, "state", "event-trace.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const beforeCall = trace.filter((entry) => entry.stage === "gateway_before_call").at(-1);
    assert.equal(beforeCall?.evictionPlanSource, "lifecycle");
    assert.equal(beforeCall?.evictionApplied, true);

    const cleanerSnapshot = await readLatestClaudeSnapshotRecord(
      join(dir, "state"),
      "sess-lifecycle-e2e",
    );
    const attributedPair = cleanerSnapshot?.snapshot.items.filter(
      (item) => item.callId === "toolu_lifecycle_e2e",
    ) ?? [];
    assert.equal(attributedPair.length, 2);
    // A unique persisted tool-call -> semantic-turn link plus turn ownership is
    // sufficient proof for Cleaner item ownership.
    assert.ok(attributedPair.every((item) =>
      JSON.stringify(item.taskIds) === JSON.stringify(["task-lifecycle-e2e"])));
    assert.equal(
      cleanerSnapshot?.snapshot.items.at(-1)?.taskIds,
      undefined,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lifecycle registry persistence failure bypasses the plan and heuristic fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-lifecycle-cas-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Array<Record<string, unknown>> = [];
  const bigToolResult = "EVICT_ME_" + "x".repeat(5000);
  const forwarder: HostGatewayForwarder = {
    requestRaw: async () => { throw new Error("requestRaw not used in test"); },
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ id: `msg_cas_${seenPayloads.length}`, type: "message", role: "assistant", content: [], stop_reason: "end_turn" }),
      };
    },
    async requestStream() { throw new Error("stream not used"); },
  };
  let estimateCount = 0;
  const resolveEstimator = () => ({
    estimate({ registry, delta }: { registry: { version: number }; delta: { coveredTurnAbsIds: string[] } }) {
      estimateCount += 1;
      return {
        baseVersion: registry.version,
        taskUpdates: [{
          taskId: estimateCount > 1 ? "task-cas-uncommitted" : "task-cas-e2e",
          lifecycle: estimateCount > 1 ? "evictable" : "completed",
          objective: "finish the file task",
          completionEvidence: ["done"],
          coveredTurnAbsIds: delta.coveredTurnAbsIds,
        }],
      };
    },
  });
  let persistCount = 0;
  const persistTaskRegistry: typeof persistSessionTaskRegistry = async (...args) => {
    persistCount += 1;
    if (persistCount === 2) throw new Error("simulated registry CAS conflict");
    return persistSessionTaskRegistry(...args);
  };
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: true },
      eviction: { enabled: true, minBlockChars: 256 },
      taskStateEstimator: { enabled: true, batchTurns: 1 },
    }),
    logger: createConsoleLogger(false),
    forwarder,
    dependencies: {
      resolveEstimator: resolveEstimator as never,
      persistTaskRegistry,
    },
  });
  const firstMessages = [
    { role: "user", content: [{ type: "text", text: "read" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_cas_e2e", name: "Read", input: { file_path: "/repo/data.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cas_e2e", content: bigToolResult }] },
  ];
  async function send(messages: unknown[]): Promise<void> {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-session-id": "sess-cas-e2e" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: false, messages, max_tokens: 64 }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  try {
    await send(firstMessages);
    await send([
      ...firstMessages,
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "KEEP_ME_current_turn" }] },
    ]);
    assert.equal(seenPayloads.length, 2);
    assert.equal(JSON.stringify(seenPayloads[1]).includes(bigToolResult), true);
    const casMessages = seenPayloads[1]!.messages as Array<Record<string, unknown>>;
    const casToolResult = (casMessages[2]!.content as Array<Record<string, unknown>>)[0];
    assert.equal(casToolResult.content, bigToolResult);
    const trace = (await readFile(join(dir, "state", "event-trace.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const beforeCall = trace.filter((entry) => entry.stage === "gateway_before_call").at(-1);
    assert.equal(beforeCall?.evictionPlanSource, "none");
    assert.equal(beforeCall?.evictionApplied, false);
    const registry = await loadSessionTaskRegistry(join(dir, "state"), "sess-cas-e2e");
    assert.equal(registry.tasks["task-cas-e2e"]?.lifecycle, "completed");
    assert.equal(registry.tasks["task-cas-uncommitted"], undefined);
    const cleanerSnapshot = await readLatestClaudeSnapshotRecord(
      join(dir, "state"),
      "sess-cas-e2e",
    );
    assert.ok(cleanerSnapshot?.snapshot.items.every(
      (item) => !item.taskIds?.includes("task-cas-uncommitted"),
    ));
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
