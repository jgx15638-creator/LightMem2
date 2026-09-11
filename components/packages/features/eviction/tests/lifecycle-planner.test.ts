import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptySessionTaskRegistry,
  type DeltaView,
  type HistoryBlock,
  type SessionTaskRegistry,
} from "@lightrsi/history";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ModelContextSnapshot,
} from "@lightrsi/host-adapter";

import {
  planLifecycleEviction,
  type LifecyclePlannerInput,
  type TaskStateEstimator,
} from "../src/index.js";

const SESSION = "session-1";

function registry(): SessionTaskRegistry {
  return createEmptySessionTaskRegistry(SESSION);
}

function delta(toTurnSeqInclusive = 1): DeltaView {
  return {
    fromTurnSeqExclusive: 0,
    toTurnSeqInclusive,
    coveredTurnAbsIds: [`${SESSION}:t${toTurnSeqInclusive}`],
    messages: [],
    toolCalls: [],
    toolResults: [],
    filesRead: [],
    filesWritten: [],
  };
}

function block(taskIds: string[]): HistoryBlock {
  return {
    blockId: "block-1",
    blockType: "other",
    lifecycleState: "EVICTABLE",
    segmentIds: ["message-1"],
    taskIds,
    text: "evictable task block",
    charCount: 1200,
    approxTokens: 300,
  };
}

function snapshot(): ModelContextSnapshot {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    hostId: "test-host",
    sessionId: SESSION,
    revision: "ctxrev-1",
    items: [{
      stableId: "item-1",
      kind: "user",
      taskIds: ["task-1"],
      fingerprint: "fp-1",
      chars: 1200,
    }],
  };
}

function estimator(output: unknown): TaskStateEstimator {
  return {
    estimate: async () => output as Awaited<ReturnType<TaskStateEstimator["estimate"]>>,
  };
}

function input(overrides: Partial<LifecyclePlannerInput> = {}): LifecyclePlannerInput {
  return {
    registry: registry(),
    delta: delta(),
    pendingTurnCount: 1,
    estimator: estimator({ baseVersion: 0, taskUpdates: [] }),
    historyBlocks: [],
    snapshot: snapshot(),
    stableItemIdsByMessageId: { "message-1": ["item-1"] },
    config: {
      enabled: true,
      batchTurns: 1,
      evictionEnabled: true,
      evictionPolicy: "model_scored",
      evictionMinBlockChars: 256,
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

test("disabled and missing estimator bypass without registry updates", async () => {
  const disabled = await planLifecycleEviction(input({
    config: {
      enabled: false,
      batchTurns: 1,
      evictionEnabled: true,
      evictionPolicy: "model_scored",
    },
  }));
  const missing = await planLifecycleEviction(input({ estimator: null }));

  assert.deepEqual(disabled.reasonCodes, ["planner_disabled"]);
  assert.deepEqual(missing.reasonCodes, ["estimator_missing"]);
  assert.equal(disabled.registryUpdateRequired, false);
  assert.equal(missing.attemptedEstimator, false);
});

test("batch and duplicate gates do not call the estimator", async () => {
  let calls = 0;
  const countingEstimator: TaskStateEstimator = {
    estimate: async () => {
      calls += 1;
      return { baseVersion: 0, taskUpdates: [] };
    },
  };
  const batched = await planLifecycleEviction(input({
    estimator: countingEstimator,
    pendingTurnCount: 1,
    config: {
      enabled: true,
      batchTurns: 2,
      evictionEnabled: true,
      evictionPolicy: "model_scored",
    },
  }));
  const duplicate = await planLifecycleEviction(input({
    estimator: countingEstimator,
    duplicateWindow: true,
  }));

  assert.deepEqual(batched.reasonCodes, ["insufficient_pending_turns"]);
  assert.deepEqual(duplicate.reasonCodes, ["duplicate_estimator_window"]);
  assert.equal(calls, 0);
});

test("invalid planner inputs bypass before calling the estimator", async () => {
  let calls = 0;
  const countingEstimator: TaskStateEstimator = {
    estimate: async () => {
      calls += 1;
      return { baseVersion: 0, taskUpdates: [] };
    },
  };
  const invalidBatch = await planLifecycleEviction(input({
    estimator: countingEstimator,
    config: {
      enabled: true,
      batchTurns: Number.NaN,
      evictionEnabled: true,
      evictionPolicy: "model_scored",
    },
  }));
  const missingTimestamp = await planLifecycleEviction(input({
    estimator: countingEstimator,
    createdAt: " ",
  }));
  const skippedWindow = await planLifecycleEviction(input({
    estimator: countingEstimator,
    delta: {
      ...delta(3),
      fromTurnSeqExclusive: 2,
    },
  }));

  assert.deepEqual(invalidBatch.reasonCodes, ["planner_input_invalid"]);
  assert.deepEqual(missingTimestamp.reasonCodes, ["planner_input_invalid"]);
  assert.deepEqual(skippedWindow.reasonCodes, ["planner_input_invalid"]);
  assert.equal(calls, 0);
});

test("estimator failures, invalid output, and stale versions fail open", async () => {
  const failed = await planLifecycleEviction(input({
    estimator: { estimate: async () => { throw new Error("secret provider error"); } },
  }));
  const invalid = await planLifecycleEviction(input({
    estimator: estimator({ baseVersion: 0, taskUpdates: "invalid" }),
  }));
  const invalidNested = await planLifecycleEviction(input({
    estimator: estimator({
      baseVersion: 0,
      taskUpdates: [{
        taskId: "task-1",
        objective: "invalid nested output",
        lifecycle: "active",
        coveredTurnAbsIds: [1],
      }],
    }),
  }));
  const staleRegistry = registry();
  staleRegistry.version = 4;
  const stale = await planLifecycleEviction(input({
    registry: staleRegistry,
    estimator: estimator({ baseVersion: 3, taskUpdates: [] }),
  }));

  assert.deepEqual(failed.reasonCodes, ["estimator_failed"]);
  assert.equal(failed.estimatorFailureCode, "unknown");
  assert.equal(typeof failed.estimatorFailureDurationMs, "number");
  assert.deepEqual(invalid.reasonCodes, ["estimator_output_invalid"]);
  assert.deepEqual(invalidNested.reasonCodes, ["estimator_output_invalid"]);
  assert.deepEqual(stale.reasonCodes, ["base_version_mismatch"]);
  assert.equal(failed.plan, undefined);
  assert.equal(invalid.registryUpdateRequired, false);
  assert.equal(stale.registry.version, 4);
});

test("estimator failure diagnostics expose only a bounded category", async () => {
  const failed = await planLifecycleEviction(input({
    estimator: {
      estimate: async () => {
        throw new Error("responses_api_failed:502");
      },
    },
  }));

  assert.equal(failed.estimatorFailureCode, "responses_http_502");
  assert.equal(typeof failed.estimatorFailureDurationMs, "number");
  assert.doesNotMatch(JSON.stringify(failed), /provider|secret|body/i);
});

test("estimator cannot claim turn ownership outside the delta", async () => {
  const result = await planLifecycleEviction(input({
    estimator: estimator({
      baseVersion: 0,
      taskUpdates: [{
        taskId: "task-1",
        objective: "out of scope task",
        lifecycle: "active",
        coveredTurnAbsIds: [`${SESSION}:t99`],
      }],
    }),
  }));

  assert.equal(result.status, "deferred");
  assert.deepEqual(result.reasonCodes, ["task_update_turn_out_of_scope"]);
  assert.equal(result.registryUpdateRequired, false);
  assert.equal(result.registry.lastProcessedTurnSeq, 0);
});

test("successful no-op advances the watermark without reporting task changes", async () => {
  const result = await planLifecycleEviction(input({
    delta: delta(3),
    pendingTurnCount: 3,
    estimator: estimator({ baseVersion: 0, taskUpdates: [] }),
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.registry.lastProcessedTurnSeq, 3);
  assert.equal(result.registry.version, 1);
  assert.equal(result.registryUpdateRequired, true);
  assert.equal(result.registryChanged, false);
  assert.deepEqual(result.reasonCodes, [
    "registry_watermark_advanced",
    "no_eviction_candidates",
  ]);
});

test("completed task update produces a deterministic mutation plan", async () => {
  const completed = registry();
  completed.version = 2;
  completed.tasks["task-1"] = {
    taskId: "task-1",
    title: "Task 1",
    objective: "finish work",
    lifecycle: "completed",
    completionEvidence: ["delivered result"],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${SESSION}:t1`,
      lastTurnAbsId: `${SESSION}:t1`,
      supportingTurnAbsIds: [`${SESSION}:t1`],
      lastEstimatorTurnAbsId: `${SESSION}:t1`,
    },
  };
  completed.completedTaskIds = ["task-1"];
  completed.blockToTaskIds = { "block-1": ["task-1"] };

  const params = input({
    registry: completed,
    historyBlocks: [block(["task-1"])],
    estimator: estimator({
      baseVersion: 2,
      taskUpdates: [{
        taskId: "task-1",
        objective: "finish work",
        lifecycle: "evictable",
        completionEvidence: ["delivered result"],
        evictableReason: "session moved on",
      }],
    }),
  });
  const first = await planLifecycleEviction(params);
  const second = await planLifecycleEviction(params);

  assert.equal(first.registry.evictableTaskIds.includes("task-1"), true);
  assert.equal(first.plan?.operations.length, 1);
  assert.deepEqual(first.plan?.operations[0]?.targetItemIds, ["item-1"]);
  assert.equal(first.plan?.planId, second.plan?.planId);
  assert.deepEqual(first.reasonCodes, ["registry_updated", "mutation_plan_created"]);
});

test("a task active before estimation cannot be evicted in the same run", async () => {
  const activeRegistry = registry();
  activeRegistry.tasks["task-1"] = {
    taskId: "task-1",
    title: "Active task",
    objective: "finish work",
    lifecycle: "active",
    completionEvidence: [],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${SESSION}:t1`,
      lastTurnAbsId: `${SESSION}:t1`,
      supportingTurnAbsIds: [`${SESSION}:t1`],
      lastEstimatorTurnAbsId: `${SESSION}:t1`,
    },
  };
  activeRegistry.activeTaskIds = ["task-1"];

  const result = await planLifecycleEviction(input({
    registry: activeRegistry,
    historyBlocks: [block(["task-1"])],
    estimator: estimator({
      baseVersion: 0,
      taskUpdates: [{
        taskId: "task-1",
        objective: "finish work",
        lifecycle: "evictable",
        completionEvidence: ["delivered result"],
        evictableReason: "session moved on",
      }],
    }),
  }));

  assert.equal(result.registry.evictableTaskIds.includes("task-1"), true);
  assert.equal(result.plan, undefined);
  assert.equal(result.decision?.instructions.length, 0);
});

test("active, current, and unresolved task ownership protects mixed blocks", async () => {
  const protectedRegistry = registry();
  protectedRegistry.tasks["task-1"] = {
    taskId: "task-1",
    title: "Old task",
    objective: "old work",
    lifecycle: "evictable",
    completionEvidence: ["done"],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${SESSION}:t1`,
      lastTurnAbsId: `${SESSION}:t1`,
      supportingTurnAbsIds: [`${SESSION}:t1`],
      lastEstimatorTurnAbsId: `${SESSION}:t1`,
    },
  };
  protectedRegistry.tasks["task-current"] = {
    taskId: "task-current",
    title: "Current task",
    objective: "current work",
    lifecycle: "active",
    completionEvidence: [],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${SESSION}:t2`,
      lastTurnAbsId: `${SESSION}:t2`,
      supportingTurnAbsIds: [`${SESSION}:t2`],
      lastEstimatorTurnAbsId: `${SESSION}:t2`,
    },
  };
  protectedRegistry.evictableTaskIds = ["task-1"];
  protectedRegistry.activeTaskIds = ["task-current"];

  const result = await planLifecycleEviction(input({
    registry: protectedRegistry,
    historyBlocks: [block(["task-1", "task-current"])],
    currentTaskIds: ["task-current"],
    estimator: estimator({ baseVersion: 0, taskUpdates: [] }),
  }));

  assert.equal(result.plan, undefined);
  assert.equal(result.decision?.instructions.length, 0);
  assert.deepEqual(result.reasonCodes, [
    "registry_watermark_advanced",
    "no_eviction_candidates",
  ]);
});

test("current turn protects a block before task ownership is available", async () => {
  const currentBlock = {
    ...block(["task-1"]),
    turnAbsIds: [`${SESSION}:t1`],
  };
  const currentRegistry = registry();
  currentRegistry.tasks["task-1"] = {
    taskId: "task-1",
    title: "Task 1",
    objective: "finished task",
    lifecycle: "evictable",
    completionEvidence: ["done"],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${SESSION}:t1`,
      lastTurnAbsId: `${SESSION}:t1`,
      supportingTurnAbsIds: [`${SESSION}:t1`],
      lastEstimatorTurnAbsId: `${SESSION}:t1`,
    },
  };
  currentRegistry.evictableTaskIds = ["task-1"];

  const result = await planLifecycleEviction(input({
    registry: currentRegistry,
    historyBlocks: [currentBlock],
    currentTurnAbsId: `${SESSION}:t1`,
    estimator: estimator({ baseVersion: 0, taskUpdates: [] }),
  }));

  assert.equal(result.plan, undefined);
  assert.equal(result.decision?.instructions.length, 0);
});

test("tool closure deferral protects an otherwise evictable task", async () => {
  const closureRegistry = registry();
  closureRegistry.tasks["task-1"] = {
    taskId: "task-1",
    title: "Tool task",
    objective: "complete tool work",
    lifecycle: "evictable",
    completionEvidence: ["tool returned"],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${SESSION}:t1`,
      lastTurnAbsId: `${SESSION}:t1`,
      supportingTurnAbsIds: [`${SESSION}:t1`],
      lastEstimatorTurnAbsId: `${SESSION}:t1`,
    },
  };
  closureRegistry.evictableTaskIds = ["task-1"];

  const result = await planLifecycleEviction(input({
    registry: closureRegistry,
    historyBlocks: [block(["task-1"])],
    closureDeferredTaskIds: ["task-1"],
    estimator: estimator({ baseVersion: 0, taskUpdates: [] }),
  }));

  assert.equal(result.plan, undefined);
  assert.equal(result.decision?.instructions.length, 0);
});

test("rejected task updates do not advance the registry watermark", async () => {
  const result = await planLifecycleEviction(input({
    estimator: estimator({
      baseVersion: 0,
      taskUpdates: [{
        taskId: "task-1",
        objective: "unfinished",
        lifecycle: "evictable",
        coveredTurnAbsIds: [`${SESSION}:t1`],
        unresolvedQuestions: ["still open"],
      }],
    }),
  }));

  assert.equal(result.status, "deferred");
  assert.deepEqual(result.reasonCodes, ["task_updates_rejected"]);
  assert.equal(result.registry.lastProcessedTurnSeq, 0);
  assert.equal(result.rejectedUpdates.length, 1);
});

test("silently unmappable estimator updates do not advance the watermark", async () => {
  const result = await planLifecycleEviction(input({
    estimator: estimator({
      baseVersion: 0,
      taskUpdates: [{
        taskId: "new-task",
        objective: "new work",
        lifecycle: "active",
      }],
    }),
  }));

  assert.equal(result.status, "deferred");
  assert.deepEqual(result.reasonCodes, ["estimator_output_invalid"]);
  assert.equal(result.registry.lastProcessedTurnSeq, 0);
  assert.equal(result.registryUpdateRequired, false);
});

test("duplicate task updates and invalid usage are rejected", async () => {
  const duplicate = {
    taskId: "task-1",
    objective: "work",
    lifecycle: "active" as const,
    coveredTurnAbsIds: [`${SESSION}:t1`],
  };
  const duplicateResult = await planLifecycleEviction(input({
    estimator: estimator({ baseVersion: 0, taskUpdates: [duplicate, duplicate] }),
  }));
  const invalidUsage = await planLifecycleEviction(input({
    estimator: estimator({
      baseVersion: 0,
      taskUpdates: [],
      usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 },
    }),
  }));

  assert.deepEqual(duplicateResult.reasonCodes, ["estimator_output_invalid"]);
  assert.deepEqual(invalidUsage.reasonCodes, ["estimator_output_invalid"]);
});

test("invalid snapshots and non-canonical timestamps bypass before estimation", async () => {
  let calls = 0;
  const countingEstimator: TaskStateEstimator = {
    estimate: async () => {
      calls += 1;
      return { baseVersion: 0, taskUpdates: [] };
    },
  };
  const duplicateItemSnapshot = snapshot();
  duplicateItemSnapshot.items.push({ ...duplicateItemSnapshot.items[0]! });
  const invalidSnapshot = await planLifecycleEviction(input({
    estimator: countingEstimator,
    snapshot: duplicateItemSnapshot,
  }));
  const invalidTimestamp = await planLifecycleEviction(input({
    estimator: countingEstimator,
    createdAt: "August 13, 2026",
  }));

  assert.deepEqual(invalidSnapshot.reasonCodes, ["planner_input_invalid"]);
  assert.deepEqual(invalidTimestamp.reasonCodes, ["planner_input_invalid"]);
  assert.equal(calls, 0);
});
