import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@lightrsi/host-adapter";
import {
  CONTEXT_CLEAN_STORE_SCHEMA_VERSION,
  contextCleanReceiptFilePath,
  contextCleanTransactionFilePath,
  createContextCleanerHostExecutionBridge,
  deriveContextCleanStoredExecution,
  readContextCleanReceipt,
  readContextCleanPlan,
  saveContextCleanPlan,
  transitionContextCleanState,
} from "../src/index.js";
import { samplePlan, sampleReceipt, sampleSnapshot } from "./fixtures.js";

async function saveScheduledPlan(
  stateDir: string,
  plan = samplePlan(),
): Promise<void> {
  await saveContextCleanPlan({ stateDir, plan });
  await transitionContextCleanState({
    stateDir,
    receipt: sampleReceipt("approved"),
  });
  await transitionContextCleanState({
    stateDir,
    receipt: sampleReceipt("scheduled"),
  });
}

function request() {
  return {
    cleanPlanId: "clean-plan-1",
    sessionId: "session-1",
    baseRevision: "rev-1",
    selectedTaskIds: ["task-a"],
  };
}

test("execution bridge expands only the frozen scheduled task scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-"));
  try {
    await saveScheduledPlan(root);
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: ["task-current"],
          evictableTaskIds: ["task-a"],
        };
      },
    });

    const first = await bridge.prepareScheduledClean(request());
    const second = await bridge.prepareScheduledClean(request());
    assert.equal(first.outcome, "ready");
    assert.equal(second.outcome, "ready");
    if (first.outcome !== "ready" || second.outcome !== "ready") return;
    assert.deepEqual(first.execution.selectedTasks, [{
      taskId: "task-a",
      itemIds: ["item-a", "item-b"],
      itemDigests: { "item-a": "digest-a", "item-b": "digest-b" },
    }]);
    assert.equal(first.execution.mutationPlan.sourceModuleId, "cleaner_manual");
    assert.equal(first.execution.mutationPlan.operations.length, 1);
    assert.deepEqual(
      first.execution.mutationPlan.operations[0]?.targetItemIds,
      ["item-a", "item-b"],
    );
    assert.deepEqual(
      first.execution.mutationPlan.operations[0]?.targetItemFingerprints,
      { "item-a": "digest-a", "item-b": "digest-b" },
    );
    assert.equal(
      first.execution.mutationPlan.planId,
      second.execution.mutationPlan.planId,
    );
    assert.equal("adapterMetadata" in first.execution.mutationPlan, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stored execution derivation is deterministic and rejects duplicate task selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-derived-"));
  try {
    await saveScheduledPlan(root);
    const stored = await readContextCleanPlan({ stateDir: root, planId: "clean-plan-1" });
    assert.ok(stored.value);
    const first = deriveContextCleanStoredExecution({
      record: stored.value,
      selectedTaskIds: ["task-a"],
    });
    const second = deriveContextCleanStoredExecution({
      record: stored.value,
      selectedTaskIds: ["task-a"],
    });
    assert.deepEqual(first, second);
    assert.equal(first?.mutationPlan.sourceModuleId, "cleaner_manual");
    assert.equal(deriveContextCleanStoredExecution({
      record: stored.value,
      selectedTaskIds: ["task-a", "task-a"],
    }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution bridge records a real terminal receipt through the shared coordinator", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-receipt-"));
  try {
    await saveScheduledPlan(root);
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: ["task-current"],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const recorded = await bridge.recordCleanReceipt(sampleReceipt("applied"));
    assert.equal(recorded.bypassed, false);
    assert.equal(recorded.value?.status, "applied");
    assert.equal(
      (await readContextCleanReceipt({ stateDir: root, planId: "clean-plan-1" }))
        .value?.status,
      "applied",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal plans replay their receipt without reading or mutating Host state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-terminal-"));
  try {
    await saveScheduledPlan(root);
    await transitionContextCleanState({
      stateDir: root,
      receipt: sampleReceipt("applied"),
    });
    let snapshotReads = 0;
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        snapshotReads += 1;
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: ["task-current"],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const result = await bridge.prepareScheduledClean(request());
    assert.equal(result.outcome, "terminal");
    assert.equal(result.outcome === "terminal" ? result.receipt.status : undefined, "applied");
    assert.equal(snapshotReads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution bridge rejects identity, approval, and selection mismatches before reading Host state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-identity-"));
  try {
    await saveScheduledPlan(root);
    let snapshotReads = 0;
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        snapshotReads += 1;
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });

    const selection = await bridge.prepareScheduledClean({
      ...request(),
      selectedTaskIds: ["task-current"],
    });
    assert.deepEqual(selection.reasons, ["clean_execution_selection_mismatch"]);
    const revision = await bridge.prepareScheduledClean({
      ...request(),
      baseRevision: "other-revision",
    });
    assert.deepEqual(revision.reasons, ["clean_execution_base_revision_mismatch"]);
    const session = await bridge.prepareScheduledClean({
      ...request(),
      sessionId: "other-session",
    });
    assert.deepEqual(session.reasons, ["clean_execution_session_mismatch"]);

    const otherHost = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "claude-code",
      async readExecutionSnapshot() {
        snapshotReads += 1;
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const host = await otherHost.prepareScheduledClean(request());
    assert.deepEqual(host.reasons, ["clean_execution_host_mismatch"]);
    assert.equal(snapshotReads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved plans cannot execute until a scheduler records the scheduled state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-approved-"));
  try {
    await saveContextCleanPlan({ stateDir: root, plan: samplePlan() });
    await transitionContextCleanState({
      stateDir: root,
      receipt: sampleReceipt("approved"),
    });
    let snapshotReads = 0;
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        snapshotReads += 1;
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const result = await bridge.prepareScheduledClean(request());
    assert.deepEqual(result.reasons, ["clean_execution_not_scheduled"]);
    assert.equal(snapshotReads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revision, digest, lifecycle, and task attribution drift preserve the Host request", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-stale-"));
  try {
    await saveScheduledPlan(root);
    const prepareWith = async (params: {
      snapshot?: ReturnType<typeof sampleSnapshot>;
      activeTaskIds?: string[];
      evictableTaskIds?: string[];
    }) => createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: params.snapshot ?? sampleSnapshot(),
          activeTaskIds: params.activeTaskIds ?? [],
          evictableTaskIds: params.evictableTaskIds ?? ["task-a"],
        };
      },
    }).prepareScheduledClean(request());

    const revision = await prepareWith({ snapshot: sampleSnapshot("rev-2") });
    assert.deepEqual(revision.reasons, ["clean_execution_revision_stale"]);

    const digestSnapshot = sampleSnapshot();
    digestSnapshot.items[0] = {
      ...digestSnapshot.items[0]!,
      fingerprint: "changed-digest",
    };
    const digest = await prepareWith({ snapshot: digestSnapshot });
    assert.deepEqual(digest.reasons, ["clean_execution_item_stale"]);

    const attributionSnapshot = sampleSnapshot();
    attributionSnapshot.items[0] = {
      ...attributionSnapshot.items[0]!,
      taskIds: ["task-other"],
    };
    const attribution = await prepareWith({ snapshot: attributionSnapshot });
    assert.deepEqual(attribution.reasons, ["clean_execution_task_attribution_stale"]);

    const lifecycle = await prepareWith({
      activeTaskIds: ["task-a"],
      evictableTaskIds: ["task-a"],
    });
    assert.deepEqual(lifecycle.reasons, ["clean_execution_snapshot_invalid"]);

    const noLongerEvictable = await prepareWith({ evictableTaskIds: [] });
    assert.deepEqual(noLongerEvictable.reasons, ["clean_execution_task_not_evictable"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unrelated history drift relocates a frozen selection without expanding its scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-unrelated-drift-"));
  try {
    const baseline = sampleSnapshot();
    await saveScheduledPlan(root, {
      ...samplePlan(),
      snapshotItems: baseline.items.map((item) => ({
        stableId: item.stableId,
        fingerprint: item.fingerprint,
      })),
    });
    const current = sampleSnapshot("rev-2");
    current.items[2] = { ...current.items[2]!, fingerprint: "changed-unselected-item" };
    current.items.push({
      stableId: "item-cleaner-control",
      kind: "assistant",
      taskIds: ["task-current"],
      fingerprint: "digest-cleaner-control",
      chars: 48,
    });
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: current,
          activeTaskIds: ["task-current"],
          evictableTaskIds: ["task-a"],
        };
      },
    });

    const result = await bridge.prepareScheduledClean(request());
    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready") return;
    assert.equal(result.execution.baseRevision, "rev-2");
    assert.deepEqual(
      result.execution.mutationPlan.operations[0]?.targetItemIds,
      ["item-a", "item-b"],
    );
    assert.equal(
      result.execution.mutationPlan.operations[0]?.targetItemIds.includes("item-cleaner-control"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relocation rejects drift or removal inside the frozen selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-selected-drift-"));
  try {
    const baseline = sampleSnapshot();
    await saveScheduledPlan(root, {
      ...samplePlan(),
      snapshotItems: baseline.items.map((item) => ({
        stableId: item.stableId,
        fingerprint: item.fingerprint,
      })),
    });
    const prepareWith = async (snapshot: ReturnType<typeof sampleSnapshot>) => (
      createContextCleanerHostExecutionBridge({
        stateDir: root,
        hostId: "codex",
        async readExecutionSnapshot() {
          return {
            snapshot,
            activeTaskIds: ["task-current"],
            evictableTaskIds: ["task-a"],
          };
        },
      }).prepareScheduledClean(request())
    );

    const changed = sampleSnapshot("rev-2");
    changed.items[0] = { ...changed.items[0]!, fingerprint: "changed-selected-item" };
    const changedResult = await prepareWith(changed);
    assert.equal(changedResult.outcome, "bypassed");
    assert.deepEqual(changedResult.reasons, ["clean_execution_item_stale"]);

    const missing = sampleSnapshot("rev-2");
    missing.items = missing.items.filter((item) => item.stableId !== "item-a");
    const missingResult = await prepareWith(missing);
    assert.equal(missingResult.outcome, "bypassed");
    assert.deepEqual(missingResult.reasons, ["clean_execution_item_stale"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol closure failure does not expose a partially applicable mutation plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-closure-"));
  try {
    await saveScheduledPlan(root);
    const snapshot = sampleSnapshot();
    snapshot.items[0] = {
      ...snapshot.items[0]!,
      kind: "tool_call",
      callId: "call-without-result",
    };
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot,
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const result = await bridge.prepareScheduledClean(request());
    assert.equal(result.outcome, "bypassed");
    assert.deepEqual(result.reasons, ["clean_execution_protocol_closure_failed"]);
    assert.equal("execution" in result, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution bridge independently rejects protected system content", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-protected-"));
  try {
    await saveScheduledPlan(root);
    const protectedSnapshot = sampleSnapshot();
    protectedSnapshot.items[0] = {
      ...protectedSnapshot.items[0]!,
      kind: "system",
    };
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: protectedSnapshot,
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const result = await bridge.prepareScheduledClean(request());
    assert.equal(result.outcome, "bypassed");
    assert.deepEqual(result.reasons, ["clean_execution_protected_item_targeted"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution bridge recovers an interrupted scheduled transition after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-recovery-"));
  try {
    await saveContextCleanPlan({ stateDir: root, plan: samplePlan() });
    await transitionContextCleanState({
      stateDir: root,
      receipt: sampleReceipt("approved"),
    });
    const scheduled = sampleReceipt("scheduled");
    const intentPath = contextCleanTransactionFilePath(root, scheduled.planId);
    await mkdir(dirname(intentPath), { recursive: true });
    await writeJsonFileAtomic(intentPath, {
      storeSchemaVersion: CONTEXT_CLEAN_STORE_SCHEMA_VERSION,
      planId: scheduled.planId,
      fromStatus: "approved",
      receipt: scheduled,
      createdAt: scheduled.updatedAt,
    });
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    assert.equal((await bridge.prepareScheduledClean(request())).outcome, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and corrupt stores fail without reading Host state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-store-"));
  try {
    let snapshotReads = 0;
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        snapshotReads += 1;
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const missing = await bridge.prepareScheduledClean(request());
    assert.equal(missing.outcome, "missing");

    await saveScheduledPlan(root);
    const receiptPath = contextCleanReceiptFilePath(root, request().cleanPlanId);
    await writeFile(receiptPath, "{not-json", "utf8");
    const corrupt = await bridge.prepareScheduledClean(request());
    assert.equal(corrupt.outcome, "bypassed");
    assert.equal(corrupt.reasons[0], "clean_execution_receipt_unavailable");
    assert.equal(snapshotReads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-host receipt evidence is rejected without changing scheduled state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-record-host-"));
  try {
    await saveScheduledPlan(root);
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const rejected = await bridge.recordCleanReceipt({
      ...sampleReceipt("applied"),
      hostId: "claude-code",
    });
    assert.deepEqual(rejected.reasons, ["clean_execution_receipt_host_mismatch"]);
    assert.equal(
      (await readContextCleanReceipt({ stateDir: root, planId: request().cleanPlanId }))
        .value?.status,
      "scheduled",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed canonical snapshots fail closed without exposing Host payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-snapshot-invalid-"));
  try {
    await saveScheduledPlan(root);
    const malformed = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return null as never;
      },
    });
    const malformedResult = await malformed.prepareScheduledClean(request());
    assert.deepEqual(malformedResult.reasons, ["clean_execution_snapshot_invalid"]);

    const withAdapterPayload = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        return {
          snapshot: {
            ...sampleSnapshot(),
            adapterMetadata: { rawRequest: "must-not-cross-shared-boundary" },
          } as never,
          activeTaskIds: [],
          evictableTaskIds: ["task-a"],
        };
      },
    });
    const payloadResult = await withAdapterPayload.prepareScheduledClean(request());
    assert.deepEqual(payloadResult.reasons, ["clean_execution_snapshot_invalid"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping selected task item scopes are rejected instead of double targeting", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-execution-overlap-"));
  try {
    const plan = samplePlan();
    plan.planId = "clean-plan-overlap";
    plan.tasks[1] = {
      ...plan.tasks[1]!,
      taskId: "task-b",
      lifecycleState: "completed",
      itemIds: ["item-b"],
      itemDigests: { "item-b": "digest-b" },
      recommendation: "clean",
      selectable: true,
    };
    const receipt = (status: "approved" | "scheduled") => ({
      ...sampleReceipt(status),
      planId: plan.planId,
      selectedTaskIds: ["task-a", "task-b"],
    });
    await saveContextCleanPlan({ stateDir: root, plan });
    await transitionContextCleanState({ stateDir: root, receipt: receipt("approved") });
    await transitionContextCleanState({ stateDir: root, receipt: receipt("scheduled") });
    let snapshotReads = 0;
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: root,
      hostId: "codex",
      async readExecutionSnapshot() {
        snapshotReads += 1;
        return {
          snapshot: sampleSnapshot(),
          activeTaskIds: [],
          evictableTaskIds: ["task-a", "task-b"],
        };
      },
    });
    const result = await bridge.prepareScheduledClean({
      cleanPlanId: plan.planId,
      sessionId: plan.sessionId,
      baseRevision: plan.baseRevision,
      selectedTaskIds: ["task-a", "task-b"],
    });
    assert.deepEqual(result.reasons, ["clean_execution_plan_selection_invalid"]);
    assert.equal(snapshotReads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
