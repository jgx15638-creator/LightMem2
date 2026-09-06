import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSessionTaskRegistry } from "@lightrsi/history";
import { reserveUnusedPort } from "@lightrsi/host-adapter";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { buildCodexEffectiveHistory } from "../src/context-history/index.js";
import { readCodexRebaseEpochJournal } from "../src/context-rewrite/index.js";
import { createConsoleLogger } from "../src/logger.js";
import { startCodexResponsesProxy } from "../src/proxy-runtime.js";

type JsonObject = Record<string, unknown>;

async function readBody(req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<JsonObject> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  return JSON.parse(text) as JsonObject;
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Lifecycle fixture did not receive a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function responseMessage(text: string): JsonObject {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

async function startLifecycleUpstream(params?: { firstResponseToolCall?: boolean }): Promise<{
  baseUrl: string;
  requests: JsonObject[];
  close(): Promise<void>;
}> {
  const requests: JsonObject[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const payload = await readBody(req);
    requests.push(payload);
    const requestNumber = requests.length;
    const output = requestNumber === 1 && params?.firstResponseToolCall !== false
      ? [{
          id: "call-item-lifecycle",
          type: "function_call",
          call_id: "call-lifecycle-runtime",
          name: "read_fixture",
          arguments: "{}",
        }]
      : [responseMessage(`completed request ${requestNumber}`)];
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `resp-lifecycle-${requestNumber}`,
      object: "response",
      status: "completed",
      output,
    }));
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => close(server),
  };
}

async function startEstimator(
  sessionId: string,
  mode: "tasks" | "noop" | "fail" = "tasks",
): Promise<{
  baseUrl: string;
  calls(): number;
  close(): Promise<void>;
}> {
  let callCount = 0;
  const server = createServer(async (req, res) => {
    if (
      req.method !== "POST"
      || (req.url !== "/responses" && req.url !== "/chat/completions")
    ) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    await readBody(req);
    callCount += 1;
    if (mode === "fail") {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "synthetic_estimator_failure" } }));
      return;
    }
    const estimatorOutput = mode === "noop" ? {
      baseVersion: 0,
      taskUpdates: [],
    } : {
      baseVersion: 0,
      taskUpdates: [
        {
          taskId: "task-lifecycle-evict",
          objective: "finish reading the old fixture",
          lifecycle: "evictable",
          coveredTurnAbsIds: [`${sessionId}:t1`, `${sessionId}:t2`],
          completionEvidence: ["fixture read completed"],
          evictableReason: "the session moved to a different task",
        },
        {
          taskId: "task-lifecycle-current",
          objective: "continue the retained task",
          lifecycle: "active",
          coveredTurnAbsIds: [`${sessionId}:t3`],
        },
      ],
    };
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/chat/completions"
      ? {
          id: `estimator-chat-${callCount}`,
          choices: [{ message: { content: JSON.stringify(estimatorOutput) } }],
          usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
        }
      : {
          id: `estimator-response-${callCount}`,
          status: "completed",
          output: [responseMessage(JSON.stringify(estimatorOutput))],
          usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144 },
        }));
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: () => callCount,
    close: () => close(server),
  };
}

function requestInputText(payload: JsonObject | undefined): string {
  return JSON.stringify(Array.isArray(payload?.input) ? payload.input : []);
}

test("Codex proxy uses lifecycle planning instead of a conflicting manual plan", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-lifecycle-runtime-"));
  const sessionId = "codex-lifecycle-runtime-session";
  const upstream = await startLifecycleUpstream();
  const estimator = await startEstimator(sessionId);
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveUnusedPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      taskStateEstimator: {
        enabled: true,
        baseUrl: estimator.baseUrl,
        apiKey: "synthetic-estimator-key",
        model: "synthetic-estimator",
        batchTurns: 3,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "start the fixture task" }],
      }),
    });
    assert.equal(first.status, 200);

    const evict = `EVICT_ME_lifecycle_runtime_${"x".repeat(400)}`;
    const keep = "KEEP_ME_lifecycle_runtime";
    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-lifecycle-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [
          {
            type: "function_call_output",
            call_id: "call-lifecycle-runtime",
            output: evict,
          },
        ],
      }),
    });
    assert.equal(second.status, 200);

    const third = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-lifecycle-2",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: keep }],
      }),
    });
    assert.equal(third.status, 200);

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const keepItem = history.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes(keep)
    ));
    assert.ok(keepItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: keepItem.stableItemId }],
    };

    const fourth = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-lifecycle-3",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "continue with the current task" }],
      }),
    });
    assert.equal(fourth.status, 200);
    assert.equal(estimator.calls(), 1);
    assert.equal(upstream.requests.length, 4);
    const lifecyclePayload = upstream.requests[3];
    const lifecycleEvents = (await readFile(join(stateDir, "event-trace.jsonl"), "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonObject)
      .filter((row) => String(row.stage).startsWith("context_rewrite_"));
    assert.equal(
      "previous_response_id" in (lifecyclePayload ?? {}),
      false,
      JSON.stringify(lifecycleEvents),
    );
    assert.doesNotMatch(requestInputText(lifecyclePayload), /EVICT_ME_lifecycle_runtime/);
    assert.match(requestInputText(lifecyclePayload), /KEEP_ME_lifecycle_runtime/);

    const registry = await loadSessionTaskRegistry(stateDir, sessionId);
    assert.equal(registry.version, 1);
    assert.deepEqual(registry.evictableTaskIds, ["task-lifecycle-evict"]);
    assert.deepEqual(registry.activeTaskIds, ["task-lifecycle-current"]);
    const plannerTrace = lifecycleEvents.find((event) => (
      event.stage === "context_rewrite_lifecycle_planner_completed"
      && event.attemptedEstimator === true
    ));
    assert.deepEqual(plannerTrace?.estimatorUsage, {
      inputTokens: 120,
      outputTokens: 24,
      totalTokens: 144,
    });
    const epochJournal = await readCodexRebaseEpochJournal(stateDir, sessionId);
    const committedEpoch = epochJournal.epochs.find((epoch) => epoch.status === "committed");
    assert.equal(committedEpoch?.accounting?.estimatorCostTokens, 144);
    assert.equal(committedEpoch?.accounting?.estimatorCostChars, 576);
  } finally {
    await runtime?.close();
    await estimator.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex proxy does not fall back to a manual plan when lifecycle config is incomplete", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-lifecycle-incomplete-"));
  const sessionId = "codex-lifecycle-incomplete-session";
  const upstream = await startLifecycleUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveUnusedPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      taskStateEstimator: {
        enabled: true,
        baseUrl: "http://127.0.0.1:1",
        model: "synthetic-estimator",
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "disabled",
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "MANUAL_TARGET_lifecycle_incomplete" }],
      }),
    });
    assert.equal(first.status, 200);

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const manualTarget = history.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes("MANUAL_TARGET_lifecycle_incomplete")
    ));
    assert.ok(manualTarget);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: manualTarget.stableItemId }],
    };

    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-lifecycle-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "keep the original response chain" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[1]?.previous_response_id, "resp-lifecycle-1");
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex proxy does not consume a completed request retry twice", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-lifecycle-retry-"));
  const sessionId = "codex-lifecycle-retry-session";
  const upstream = await startLifecycleUpstream({ firstResponseToolCall: false });
  const estimator = await startEstimator(sessionId, "noop");
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveUnusedPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      taskStateEstimator: {
        enabled: true,
        baseUrl: estimator.baseUrl,
        apiKey: "synthetic-estimator-key",
        model: "synthetic-estimator",
        batchTurns: 1,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "disabled",
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "establish one committed turn" }],
      }),
    });
    assert.equal(first.status, 200);

    const retryBody = JSON.stringify({
      model: "gpt-5.4-mini",
      stream: false,
      previous_response_id: "resp-lifecycle-1",
      metadata: { tokenpilotSessionId: sessionId },
      input: [{ role: "user", content: "retry this exact request" }],
    });
    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: retryBody,
    });
    assert.equal(second.status, 200);
    const retry = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: retryBody,
    });
    assert.equal(retry.status, 200);

    assert.equal(estimator.calls(), 1);
    const registry = await loadSessionTaskRegistry(stateDir, sessionId);
    assert.equal(registry.version, 1);
    assert.equal(registry.lastProcessedTurnSeq, 1);
    assert.equal(upstream.requests.length, 3);
    assert.equal(upstream.requests[2]?.previous_response_id, "resp-lifecycle-1");
  } finally {
    await runtime?.close();
    await estimator.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex proxy keeps the original chain when the estimator fails", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-lifecycle-estimator-fail-"));
  const sessionId = "codex-lifecycle-estimator-fail-session";
  const upstream = await startLifecycleUpstream({ firstResponseToolCall: false });
  const estimator = await startEstimator(sessionId, "fail");
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveUnusedPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      taskStateEstimator: {
        enabled: true,
        baseUrl: estimator.baseUrl,
        apiKey: "synthetic-estimator-key",
        model: "synthetic-estimator",
        batchTurns: 1,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "disabled",
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "MANUAL_TARGET_estimator_failure" }],
      }),
    });
    assert.equal(first.status, 200);

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const manualTarget = history.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes("MANUAL_TARGET_estimator_failure")
    ));
    assert.ok(manualTarget);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: manualTarget.stableItemId }],
    };

    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-lifecycle-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "preserve the chain after estimator failure" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(estimator.calls(), 1);
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[1]?.previous_response_id, "resp-lifecycle-1");
    const registry = await loadSessionTaskRegistry(stateDir, sessionId);
    assert.equal(registry.version, 0);
    assert.equal(registry.lastProcessedTurnSeq, 0);
  } finally {
    await runtime?.close();
    await estimator.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
