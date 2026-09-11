import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  loadSessionTaskRegistry,
  persistSessionTaskRegistry,
  sessionTaskRegistryPath,
} from "@lightrsi/history";
import type {
  LifecyclePlannerConfig,
  TaskStateEstimator,
} from "@lightrsi/eviction";

import type {
  CodexEffectiveHistoryItem,
  CodexEffectiveHistoryView,
  JsonObject,
} from "../src/context-history/index.js";
import {
  acquireCodexRebaseSessionLock,
  codexSharedContextRewriteBackend,
  revalidateCodexLifecyclePreparedPlan,
  runCodexLifecyclePlanner,
  type CodexLifecycleBackendRequestBase,
} from "../src/context-rewrite/index.js";

const SESSION_ID = "codex-lifecycle-runner-session";
const CREATED_AT = "2026-08-16T00:00:00.000Z";
const PLANNER_CONFIG: LifecyclePlannerConfig = {
  enabled: true,
  batchTurns: 1,
  evictionEnabled: true,
  evictionPolicy: "model_scored",
  evictionMinBlockChars: 1,
};

async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lightrsi-codex-lifecycle-runner-"));
}

function effective(stableItemId: string, item: JsonObject): CodexEffectiveHistoryItem {
  return { stableItemId, item };
}

function sourceView(params: {
  items: CodexEffectiveHistoryItem[];
  turns: Array<{
    turnSeq: number;
    inputItemIds?: string[];
    outputItemIds?: string[];
  }>;
}): CodexEffectiveHistoryView {
  return {
    history: {
      revision: "lifecycle-runner-revision",
      replayableItems: params.items,
      observationOnlyItems: [],
      deferredItems: [],
      unresolvedCallIds: [],
      source: "proxy_journal",
      incomplete: false,
    },
    turns: params.turns.map((turn) => ({
      turnSeq: turn.turnSeq,
      turnAbsId: `${SESSION_ID}:t${turn.turnSeq}`,
      inputItemIds: turn.inputItemIds ?? [],
      outputItemIds: turn.outputItemIds ?? [],
    })),
    semanticComplete: true,
    reasonCodes: [],
  };
}

function plannerView(): CodexEffectiveHistoryView {
  return sourceView({
    items: [
      effective("user-old", {
        type: "message",
        role: "user",
        content: "run the old task",
      }),
      effective("call", {
        type: "function_call",
        call_id: "call-runner",
        name: "run_tests",
        arguments: "{}",
      }),
      effective("result", {
        type: "function_call_output",
        call_id: "call-runner",
        output: "EVICT_ME_runner_contract",
      }),
      effective("user-current", {
        type: "message",
        role: "user",
        content: "KEEP_ME_current_task",
      }),
    ],
    turns: [
      { turnSeq: 1, inputItemIds: ["user-old"], outputItemIds: ["call"] },
      { turnSeq: 2, inputItemIds: ["result"] },
      { turnSeq: 3, inputItemIds: ["user-current"] },
    ],
  });
}

function backendRequest(view: CodexEffectiveHistoryView): CodexLifecycleBackendRequestBase {
  return {
    sessionId: SESSION_ID,
    payload: {
      model: "fixture-model",
      previous_response_id: "response-parent",
      input: [{ type: "message", role: "user", content: "next request" }],
    },
    effectiveHistory: view.history,
  };
}

function completingEstimator(
  beforeReturn?: () => Promise<void>,
): TaskStateEstimator {
  return {
    async estimate(input) {
      await beforeReturn?.();
      return {
        baseVersion: input.registry.version,
        taskUpdates: [
          {
            taskId: "task-evict",
            objective: "finish the old task",
            lifecycle: "evictable",
            coveredTurnAbsIds: [`${SESSION_ID}:t1`],
            completionEvidence: ["tool result completed"],
            evictableReason: "moved to a new task",
          },
          {
            taskId: "task-current",
            objective: "continue the current task",
            lifecycle: "active",
            coveredTurnAbsIds: [`${SESSION_ID}:t3`],
          },
        ],
        usage: {
          inputTokens: 120,
          outputTokens: 24,
          totalTokens: 144,
          costUsd: 0.002,
        },
      };
    },
  };
}

test("lifecycle runner persists the planner registry before exposing a validated plan", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: completingEstimator(),
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.attemptedEstimator, true);
  assert.equal(result.registryPersisted, true);
  assert.equal(result.registryChanged, true);
  assert.equal(result.registryVersionBefore, 0);
  assert.equal(result.registryVersionAfter, 1);
  assert.deepEqual(result.estimatorUsage, {
    inputTokens: 120,
    outputTokens: 24,
    totalTokens: 144,
    costUsd: 0.002,
  });
  assert.equal(result.preparedPlan?.registryVersion, 1);
  assert.ok(result.reasonCodes.includes("mutation_plan_created"));
  assert.deepEqual(
    result.preparedPlan?.plan.operations[0]?.targetItemIds,
    ["call", "result"],
  );
  assert.deepEqual(
    result.preparedPlan?.backendRequest.taskIdsByItemId?.call,
    ["task-evict"],
  );
  assert.deepEqual(
    result.preparedPlan?.backendRequest.taskIdsByItemId?.result,
    ["task-evict"],
  );

  const persisted = await loadSessionTaskRegistry(stateDir, SESSION_ID);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.lastProcessedTurnSeq, 3);
  assert.deepEqual(persisted.evictableTaskIds, ["task-evict"]);
  assert.deepEqual(persisted.activeTaskIds, ["task-current"]);

  assert.ok(result.preparedPlan);
  if (!result.preparedPlan) return;
  const applied = await codexSharedContextRewriteBackend.apply({
    snapshot: result.preparedPlan.snapshot,
    plan: result.preparedPlan.plan,
    request: result.preparedPlan.backendRequest,
  });
  assert.equal(applied.result.applied, true);
  assert.equal(applied.result.changed, true);
  assert.doesNotMatch(JSON.stringify(applied.request.payload), /EVICT_ME_runner_contract/);
  assert.match(JSON.stringify(applied.request.payload), /KEEP_ME_current_task/);
});

test("lifecycle plan handoff rejects registry-version and snapshot drift", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: completingEstimator(),
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });
  assert.ok(result.preparedPlan);
  if (!result.preparedPlan) return;

  const current = await revalidateCodexLifecyclePreparedPlan({
    stateDir,
    sessionId: SESSION_ID,
    preparedPlan: result.preparedPlan,
    view,
    backendRequest: backendRequest(view),
  });
  assert.deepEqual(current, {
    valid: true,
    reasonCodes: [],
    registryVersion: 1,
  });

  const changedView = structuredClone(view);
  changedView.history.revision = "lifecycle-runner-revision-changed";
  changedView.history.replayableItems[0]!.item.content = "history changed after planning";
  const snapshotDrift = await revalidateCodexLifecyclePreparedPlan({
    stateDir,
    sessionId: SESSION_ID,
    preparedPlan: result.preparedPlan,
    view: changedView,
    backendRequest: backendRequest(changedView),
  });
  assert.deepEqual(snapshotDrift, {
    valid: false,
    reasonCodes: ["lifecycle_execution_snapshot_changed"],
    registryVersion: 1,
  });

  const persisted = await loadSessionTaskRegistry(stateDir, SESSION_ID);
  await persistSessionTaskRegistry(
    stateDir,
    { ...persisted, version: persisted.version + 1 },
    { expectedVersion: persisted.version },
  );
  const registryDrift = await revalidateCodexLifecyclePreparedPlan({
    stateDir,
    sessionId: SESSION_ID,
    preparedPlan: result.preparedPlan,
    view,
    backendRequest: backendRequest(view),
  });
  assert.deepEqual(registryDrift, {
    valid: false,
    reasonCodes: ["lifecycle_execution_registry_version_changed"],
    registryVersion: 2,
  });
});

test("lifecycle runner persists a successful no-op watermark without exposing a plan", async () => {
  const stateDir = await tempStateDir();
  const view = sourceView({
    items: [effective("user", {
      type: "message",
      role: "user",
      content: "nothing to update",
    })],
    turns: [{ turnSeq: 1, inputItemIds: ["user"] }],
  });
  let estimatorCalls = 0;
  const estimator: TaskStateEstimator = {
    estimate: (input) => {
      estimatorCalls += 1;
      return { baseVersion: input.registry.version, taskUpdates: [] };
    },
  };
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator,
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.registryPersisted, true);
  assert.equal(result.registryChanged, false);
  assert.equal(result.preparedPlan, undefined);
  assert.deepEqual(result.reasonCodes, [
    "registry_watermark_advanced",
    "no_eviction_candidates",
  ]);
  const persisted = await loadSessionTaskRegistry(stateDir, SESSION_ID);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.lastProcessedTurnSeq, 1);

  const retry = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator,
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });
  assert.equal(retry.status, "deferred");
  assert.deepEqual(retry.reasonCodes, ["lifecycle_no_pending_turns"]);
  assert.equal(estimatorCalls, 1);
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 1);
});

test("lifecycle runner defers below the batch threshold without calling the estimator", async () => {
  const stateDir = await tempStateDir();
  const view = sourceView({
    items: [effective("user", { type: "message", role: "user", content: "one turn" })],
    turns: [{ turnSeq: 1, inputItemIds: ["user"] }],
  });
  let estimatorCalled = false;
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: {
      estimate: () => {
        estimatorCalled = true;
        return { baseVersion: 0, taskUpdates: [] };
      },
    },
    config: { ...PLANNER_CONFIG, batchTurns: 2 },
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "deferred");
  assert.deepEqual(result.reasonCodes, ["insufficient_pending_turns"]);
  assert.equal(estimatorCalled, false);
  assert.equal(result.registryPersisted, false);
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 0);
});

test("lifecycle runner leaves the registry unchanged on estimator failure", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: {
      estimate: () => {
        throw new Error("private upstream error must not escape");
      },
    },
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "bypassed");
  assert.deepEqual(result.reasonCodes, ["estimator_failed"]);
  assert.equal(result.attemptedEstimator, true);
  assert.equal(result.registryPersisted, false);
  assert.equal(result.preparedPlan, undefined);
  assert.equal(result.estimatorFailureCode, "unknown");
  assert.equal(typeof result.estimatorFailureDurationMs, "number");
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 0);
  assert.doesNotMatch(JSON.stringify(result), /private upstream error/);

  const retry = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: completingEstimator(),
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });
  assert.equal(retry.status, "completed");
  assert.equal(retry.registryVersionBefore, 0);
  assert.equal(retry.registryVersionAfter, 1);
  assert.ok(retry.preparedPlan);
});

test("lifecycle runner rejects invalid estimator output without persisting state", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: {
      estimate: () => ({
        baseVersion: 0,
        taskUpdates: [{
          taskId: "",
          objective: "",
          lifecycle: "active",
        }],
      }),
    },
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "bypassed");
  assert.deepEqual(result.reasonCodes, ["estimator_output_invalid"]);
  assert.equal(result.registryPersisted, false);
  assert.equal(result.preparedPlan, undefined);
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 0);
});

test("lifecycle runner defers incomplete tool closure before estimator execution", async () => {
  const stateDir = await tempStateDir();
  const view = sourceView({
    items: [effective("call", {
      type: "function_call",
      call_id: "call-incomplete",
      name: "run_tests",
      arguments: "{}",
    })],
    turns: [{ turnSeq: 1, outputItemIds: ["call"] }],
  });
  let estimatorCalled = false;
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: {
      estimate: () => {
        estimatorCalled = true;
        return { baseVersion: 0, taskUpdates: [] };
      },
    },
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "deferred");
  assert.ok(result.reasonCodes.includes("semantic_tool_closure_incomplete"));
  assert.equal(estimatorCalled, false);
  assert.equal(result.registryPersisted, false);
});

test("lifecycle runner drops a prepared plan when registry CAS loses", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: completingEstimator(async () => {
      const current = await loadSessionTaskRegistry(stateDir, SESSION_ID);
      await persistSessionTaskRegistry(stateDir, { ...current, version: 5 });
    }),
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.registryPersisted, false);
  assert.equal(result.registryVersionBefore, 0);
  assert.equal(result.registryVersionAfter, 5);
  assert.ok(result.reasonCodes.includes("lifecycle_runner_registry_version_conflict"));
  assert.equal(result.preparedPlan, undefined);
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 5);

  const retry = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: completingEstimator(),
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });
  assert.equal(retry.status, "completed");
  assert.equal(retry.registryVersionBefore, 5);
  assert.equal(retry.registryVersionAfter, 6);
  assert.equal(retry.preparedPlan?.registryVersion, 6);
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 6);
});

test("lifecycle runner defers while the Codex rebase session lock is owned", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  const lock = await acquireCodexRebaseSessionLock({ stateDir, sessionId: SESSION_ID });
  assert.ok(lock);
  let estimatorCalled = false;
  try {
    const result = await runCodexLifecyclePlanner({
      stateDir,
      sessionId: SESSION_ID,
      view,
      backendRequest: backendRequest(view),
      estimator: {
        estimate: () => {
          estimatorCalled = true;
          return { baseVersion: 0, taskUpdates: [] };
        },
      },
      config: PLANNER_CONFIG,
      createdAt: CREATED_AT,
    });
    assert.equal(result.status, "deferred");
    assert.deepEqual(result.reasonCodes, ["lifecycle_runner_lock_busy"]);
    assert.equal(estimatorCalled, false);
  } finally {
    await lock?.release();
  }
});

test("concurrent lifecycle runners estimate and persist a session only once", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  let releaseEstimator!: () => void;
  let announceEstimator!: () => void;
  const estimatorGate = new Promise<void>((resolve) => {
    releaseEstimator = resolve;
  });
  const estimatorEntered = new Promise<void>((resolve) => {
    announceEstimator = resolve;
  });
  let estimatorCalls = 0;
  const first = runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: {
      async estimate(input) {
        estimatorCalls += 1;
        announceEstimator();
        await estimatorGate;
        return {
          baseVersion: input.registry.version,
          taskUpdates: [],
        };
      },
    },
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });
  await estimatorEntered;

  const concurrent = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: {
      estimate: () => {
        estimatorCalls += 1;
        return { baseVersion: 0, taskUpdates: [] };
      },
    },
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });
  releaseEstimator();
  const completed = await first;

  assert.equal(concurrent.status, "deferred");
  assert.deepEqual(concurrent.reasonCodes, ["lifecycle_runner_lock_busy"]);
  assert.equal(completed.status, "completed");
  assert.equal(estimatorCalls, 1);
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 1);
});

test("lifecycle runner bypasses disabled or missing estimators before state I/O", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  let estimatorCalled = false;
  const disabled = await runCodexLifecyclePlanner({
    stateDir: "   ",
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: {
      estimate: () => {
        estimatorCalled = true;
        return { baseVersion: 0, taskUpdates: [] };
      },
    },
    config: { ...PLANNER_CONFIG, enabled: false },
    createdAt: CREATED_AT,
  });
  const missing = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: null,
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.deepEqual(disabled.reasonCodes, ["planner_disabled"]);
  assert.deepEqual(missing.reasonCodes, ["estimator_missing"]);
  assert.equal(estimatorCalled, false);
  assert.equal((await loadSessionTaskRegistry(stateDir, SESSION_ID)).version, 0);
});

test("lifecycle runner rejects an empty state directory before creating lock state", async () => {
  const view = plannerView();
  const result = await runCodexLifecyclePlanner({
    stateDir: "   ",
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: completingEstimator(),
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "bypassed");
  assert.deepEqual(result.reasonCodes, ["lifecycle_runner_state_dir_invalid"]);
  assert.equal(result.attemptedEstimator, false);
  assert.equal(result.preparedPlan, undefined);
});

test("lifecycle runner fails open when the persisted registry is unreadable", async () => {
  const stateDir = await tempStateDir();
  const view = plannerView();
  const path = sessionTaskRegistryPath(stateDir, SESSION_ID);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{not-json", "utf8");
  const result = await runCodexLifecyclePlanner({
    stateDir,
    sessionId: SESSION_ID,
    view,
    backendRequest: backendRequest(view),
    estimator: completingEstimator(),
    config: PLANNER_CONFIG,
    createdAt: CREATED_AT,
  });

  assert.equal(result.status, "bypassed");
  assert.deepEqual(result.reasonCodes, ["lifecycle_runner_registry_load_failed"]);
  assert.equal(result.attemptedEstimator, false);
  assert.equal(result.preparedPlan, undefined);
});
