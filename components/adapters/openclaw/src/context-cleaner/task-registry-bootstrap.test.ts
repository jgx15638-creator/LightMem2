import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEmptySessionTaskRegistry,
  loadCanonicalState,
  listRawSemanticTurnSeqs,
  persistSessionTaskRegistry,
  saveCanonicalState,
} from "@lightrsi/history";

import { normalizeConfig } from "../context-stack/integration/config-normalize.js";
import { ensureOpenClawCleanerTaskRegistry } from "./task-registry-bootstrap.js";

test("cleaner bootstraps task state from canonical runtime messages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-task-bootstrap-"));
  const sessionId = "session-cleaner-bootstrap";
  try {
    const messages = [
      { role: "user", content: "task one" },
      { role: "assistant", content: "task one complete" },
      { role: "user", content: "task two" },
      { role: "assistant", content: "task two complete" },
      { role: "user", content: "task three" },
      { role: "assistant", content: "task three complete" },
    ];
    await saveCanonicalState(stateDir, {
      version: 1,
      sessionId,
      messages,
      seenMessageIds: messages.map((_, index) => `m${index + 1}`),
      updatedAt: new Date().toISOString(),
    });

    let receivedPolicyConfig: any;
    const registry = await ensureOpenClawCleanerTaskRegistry({
      currentConfig: {
        agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      },
      normalized: normalizeConfig({ stateDir }),
      sessionId,
      dependencies: {
        detectUpstreamConfig: async () => ({
          providerId: "deepseek",
          baseUrl: "https://api.example.test/v1",
          apiKey: "test-key",
          apiFamily: "openai-completions",
          models: [{
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: false,
            input: ["text"],
            contextWindow: 1_000_000,
            maxTokens: 8_192,
          }],
        }),
        createPolicyModule: ((config: any) => {
          receivedPolicyConfig = config;
          return {
            name: "test-policy",
            async beforeBuild(context: any) {
              const next = createEmptySessionTaskRegistry(sessionId);
              next.version = 1;
              next.tasks["task-one"] = {
                taskId: "task-one",
                title: "Task one",
                objective: "Complete task one",
                lifecycle: "evictable",
                evictableReason: "A newer task replaced it.",
                completionEvidence: ["Delivered task one"],
                unresolvedQuestions: [],
                span: {
                  firstTurnAbsId: `${sessionId}:t1`,
                  lastTurnAbsId: `${sessionId}:t1`,
                  supportingTurnAbsIds: [`${sessionId}:t1`],
                  lastEstimatorTurnAbsId: `${sessionId}:t3`,
                },
              };
              next.evictableTaskIds = ["task-one"];
              next.turnToTaskIds = {
                [`${sessionId}:t1`]: ["task-one"],
                [`${sessionId}:t2`]: ["task-one"],
                [`${sessionId}:t3`]: ["task-one"],
              };
              next.lastProcessedTurnSeq = 3;
              await persistSessionTaskRegistry(stateDir, next);
              return context;
            },
          };
        }) as any,
      },
    });

    assert.deepEqual(await listRawSemanticTurnSeqs(stateDir, sessionId), [1, 2, 3]);
    assert.equal(receivedPolicyConfig.taskStateEstimator.enabled, true);
    assert.equal(receivedPolicyConfig.taskStateEstimator.batchTurns, 3);
    assert.equal(receivedPolicyConfig.taskStateEstimator.model, "deepseek-v4-flash");
    assert.deepEqual(registry.evictableTaskIds, ["task-one"]);
    const annotated = await loadCanonicalState(stateDir, sessionId);
    assert.deepEqual(
      annotated?.messages.map((message) => message.details?.contextSafe?.taskIds),
      messages.map(() => ["task-one"]),
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("cleaner task bootstrap fails closed when no model provider is available", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-task-bootstrap-fallback-"));
  const sessionId = "session-cleaner-no-provider";
  try {
    await saveCanonicalState(stateDir, {
      version: 1,
      sessionId,
      messages: [{ role: "user", content: "unfinished work" }],
      seenMessageIds: ["m1"],
      updatedAt: new Date().toISOString(),
    });
    const registry = await ensureOpenClawCleanerTaskRegistry({
      currentConfig: {},
      normalized: normalizeConfig({ stateDir }),
      sessionId,
      dependencies: { detectUpstreamConfig: async () => null },
    });
    assert.deepEqual(registry.tasks, {});
    assert.deepEqual(registry.evictableTaskIds, []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("cleaner task bootstrap classifies only turns added after an existing registry", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-task-bootstrap-incremental-"));
  const sessionId = "session-cleaner-incremental";
  try {
    const messages = [
      { role: "user", content: "task one" },
      { role: "assistant", content: "task one complete" },
      { role: "user", content: "task two" },
      { role: "assistant", content: "task two complete" },
      { role: "user", content: "task three" },
      { role: "assistant", content: "task three complete" },
    ];
    await saveCanonicalState(stateDir, {
      version: 1,
      sessionId,
      messages,
      seenMessageIds: messages.map((_, index) => `m${index + 1}`),
      updatedAt: new Date().toISOString(),
    });
    const existing = createEmptySessionTaskRegistry(sessionId);
    existing.version = 1;
    existing.lastProcessedTurnSeq = 1;
    existing.tasks["task-one"] = {
      taskId: "task-one",
      title: "Task one",
      objective: "Complete task one",
      lifecycle: "completed",
      completionEvidence: ["Delivered task one"],
      unresolvedQuestions: [],
      span: {
        firstTurnAbsId: `${sessionId}:t1`,
        lastTurnAbsId: `${sessionId}:t1`,
        supportingTurnAbsIds: [`${sessionId}:t1`],
        lastEstimatorTurnAbsId: `${sessionId}:t1`,
      },
    };
    existing.completedTaskIds = ["task-one"];
    existing.turnToTaskIds = { [`${sessionId}:t1`]: ["task-one"] };
    await persistSessionTaskRegistry(stateDir, existing);

    let receivedBatchTurns = 0;
    await ensureOpenClawCleanerTaskRegistry({
      currentConfig: { agents: { defaults: { model: "deepseek/deepseek-v4-flash" } } },
      normalized: normalizeConfig({ stateDir }),
      sessionId,
      dependencies: {
        detectUpstreamConfig: async () => ({
          providerId: "deepseek",
          baseUrl: "https://api.example.test/v1",
          apiKey: "test-key",
          apiFamily: "openai-completions",
          models: [{
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: false,
            input: ["text"],
            contextWindow: 1_000_000,
            maxTokens: 8_192,
          }],
        }),
        createPolicyModule: ((config: any) => {
          receivedBatchTurns = config.taskStateEstimator.batchTurns;
          return { name: "test-policy", async beforeBuild(context: any) { return context; } };
        }) as any,
      },
    });

    assert.equal(receivedBatchTurns, 2);
    assert.deepEqual(await listRawSemanticTurnSeqs(stateDir, sessionId), [1, 2, 3]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("cleaner task bootstrap uses a Host-managed model client without provider config", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-host-model-"));
  const sessionId = "session-cleaner-host-model";
  const taskId = `${sessionId}:t1-task`;
  try {
    await saveCanonicalState(stateDir, {
      version: 1,
      sessionId,
      messages: [
        { role: "user", content: "Write a small sorting example." },
        { role: "assistant", content: "Delivered the example and explanation." },
      ],
      seenMessageIds: ["m1", "m2"],
      updatedAt: new Date().toISOString(),
    });

    const registry = await ensureOpenClawCleanerTaskRegistry({
      currentConfig: {
        agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      },
      normalized: normalizeConfig({ stateDir }),
      sessionId,
      modelClient: {
        async request() {
          return {
            text: JSON.stringify({
              baseVersion: 0,
              taskUpdates: [{
                taskId,
                title: "Sorting example",
                objective: "Write a small sorting example.",
                lifecycle: "completed",
                coveredTurnAbsIds: [`${sessionId}:t1`],
                completionEvidence: ["Delivered the example and explanation."],
                unresolvedQuestions: [],
              }],
            }),
          };
        },
      },
    });

    assert.equal(registry.tasks[taskId]?.lifecycle, "completed");
    assert.equal(registry.lastProcessedTurnSeq, 1);
    const annotated = await loadCanonicalState(stateDir, sessionId);
    assert.deepEqual(
      annotated?.messages.map((message) => message.details?.contextSafe?.taskIds),
      [[taskId], [taskId]],
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
