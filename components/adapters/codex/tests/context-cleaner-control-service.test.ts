import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCodexContextCleanerControlService,
  resolveCodexCleanerRecommendationConfig,
} from "../src/context-cleaner/control-service.js";
import {
  appendCodexRequestJournalEntry,
  appendCodexResponseJournalEntry,
} from "../src/context-history/index.js";
import {
  indexCodexHostSessionAlias,
  upsertCodexSessionSnapshot,
} from "../src/session-state.js";
import {
  normalizeTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "../src/config.js";

test("Codex Cleaner control service resolves the current Host alias before latest session", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-codex-clean-control-"));
  try {
    const stateDir = join(root, "state");
    const tokenPilotConfigPath = join(root, "tokenpilot.json");
    await writeTokenPilotCodexConfig(normalizeTokenPilotCodexConfig({
      stateDir,
      taskStateEstimator: { enabled: false, batchTurns: 1 },
    }, { configPath: tokenPilotConfigPath }), tokenPilotConfigPath);
    await upsertCodexSessionSnapshot(stateDir, "session-current", {
      codexSessionId: "host-session",
    }, { markLatest: false });
    await indexCodexHostSessionAlias(stateDir, "host-session", "session-current");
    await upsertCodexSessionSnapshot(stateDir, "session-latest", {});

    const current = await createCodexContextCleanerControlService({
      tokenPilotConfigPath,
      environment: {
        CODEX_SESSION_ID: "host-session",
        CODEX_THREAD_ID: "thread-session",
      },
    });
    const latest = await createCodexContextCleanerControlService({
      tokenPilotConfigPath,
      environment: {},
    });

    assert.equal(current.stateDir, stateDir);
    assert.equal(await current.resolveSessionId(), "session-current");
    assert.equal(await latest.resolveSessionId(), "session-latest");
    assert.equal(typeof current.service.analyze, "function");
    assert.equal(typeof current.service.approve, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Cleaner control service proves the latest mapped Host session without MCP environment ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-codex-clean-control-current-"));
  try {
    const stateDir = join(root, "state");
    const tokenPilotConfigPath = join(root, "tokenpilot.json");
    const sessionId = "session-current-stateless";
    const codexSessionId = "host-current-stateless";
    await writeTokenPilotCodexConfig(normalizeTokenPilotCodexConfig({
      stateDir,
      taskStateEstimator: { enabled: false, batchTurns: 1 },
    }, { configPath: tokenPilotConfigPath }), tokenPilotConfigPath);
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-current",
      payload: {
        input: [
          { type: "message", role: "user", content: "finished task" },
          { type: "message", role: "assistant", content: "done" },
          { type: "message", role: "user", content: "$lightrsi-clean" },
        ],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-current",
      response: {
        id: "response-current",
        previous_response_id: null,
        output: [{
          type: "function_call",
          call_id: "functions.mcp__lightrsi_cleaner__lightrsi_clean:1",
          name: "lightrsi_clean",
          arguments: "{}",
        }],
      },
      status: "completed",
    });
    await upsertCodexSessionSnapshot(stateDir, sessionId, {
      codexSessionId,
      latestResponseId: "response-current",
      latestModel: "kimi-k2.7-code",
    });

    const control = await createCodexContextCleanerControlService({
      tokenPilotConfigPath,
      environment: {},
      taskStateEstimator: {
        estimate(input) {
          return {
            baseVersion: input.registry.version,
            taskUpdates: [{
              taskId: "completed-stateless-task",
              objective: "finish the stateless task",
              lifecycle: "completed",
              coveredTurnAbsIds: [...input.delta.coveredTurnAbsIds],
              completionEvidence: ["assistant reported completion"],
            }],
          };
        },
      },
    });
    const resolvedSessionId = await control.resolveSessionId();

    assert.equal(resolvedSessionId, sessionId);
    const plan = await control.service.analyze(resolvedSessionId!);
    assert.deepEqual(plan.tasks.map((task) => task.taskId), ["completed-stateless-task"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Cleaner control service prefers the Host session invoking Cleaner over unrelated latest traffic", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-codex-clean-control-hook-"));
  try {
    const stateDir = join(root, "state");
    const tokenPilotConfigPath = join(root, "tokenpilot.json");
    const sessionId = "session-invoking-cleaner";
    const codexSessionId = "host-invoking-cleaner";
    await writeTokenPilotCodexConfig(normalizeTokenPilotCodexConfig({
      stateDir,
      taskStateEstimator: { enabled: false },
    }, { configPath: tokenPilotConfigPath }), tokenPilotConfigPath);
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-invoking-cleaner",
      payload: {
        input: [
          { type: "message", role: "user", content: "finished task" },
          { type: "message", role: "assistant", content: "done" },
          { type: "message", role: "user", content: "$lightrsi-clean" },
        ],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-invoking-cleaner",
      response: {
        id: "response-invoking-cleaner",
        previous_response_id: null,
        output: [{
          type: "function_call",
          call_id: "functions.mcp__lightrsi_cleaner__lightrsi_clean:1",
          name: "lightrsi_clean",
          arguments: "{}",
        }],
      },
      status: "completed",
    });
    await upsertCodexSessionSnapshot(stateDir, sessionId, {
      codexSessionId,
      latestResponseId: "response-invoking-cleaner",
      latestModel: "kimi-k2.7-code",
      lastHookEvent: "PreToolUse",
      lastToolName: "mcp__lightrsi_cleaner__lightrsi_clean",
    }, { markLatest: false });
    await upsertCodexSessionSnapshot(stateDir, "unrelated-latest-session", {
      latestModel: "kimi-k2.7-code",
    });

    const control = await createCodexContextCleanerControlService({
      tokenPilotConfigPath,
      environment: {},
    });
    const resolvedSessionId = await control.resolveSessionId();

    assert.equal(resolvedSessionId, sessionId);
    await assert.doesNotReject(control.service.analyze(resolvedSessionId!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Cleaner recommendation config resolves estimator credentials from the environment", () => {
  const config = normalizeTokenPilotCodexConfig({
    taskStateEstimator: { enabled: true },
  });

  const resolved = resolveCodexCleanerRecommendationConfig({
    config: config.taskStateEstimator,
    environment: {
      LIGHTRSI_TASK_STATE_ESTIMATOR_BASE_URL: "https://api.example.test/v1/",
      LIGHTRSI_TASK_STATE_ESTIMATOR_API_KEY: "env-secret",
      LIGHTRSI_TASK_STATE_ESTIMATOR_MODEL: "estimator-model",
      LIGHTRSI_TASK_STATE_ESTIMATOR_TIMEOUT_MS: "180000",
    },
  });

  assert.deepEqual(resolved, {
    baseUrl: "https://api.example.test/v1",
    apiKey: "env-secret",
    model: "estimator-model",
    requestTimeoutMs: 180_000,
  });
});
