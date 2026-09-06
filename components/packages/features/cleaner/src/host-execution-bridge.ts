import { createHash } from "node:crypto";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  revalidateContextMutationPlan,
  validateContextMutationProtocolClosure,
  type ContextMutationOperation,
  type ContextMutationPlan,
} from "@lightrsi/host-adapter";
import {
  isTerminalContextCleanStatus,
  type ApprovedContextCleanTask,
  type ContextCleanExecutionPrepareResult,
  type ContextCleanExecutionRequest,
  type ContextCleanExecutionSnapshot,
  type ContextCleanPlanRecord,
  type ContextCleanReceipt,
  type ContextCleanScheduledReceipt,
  type ContextCleanStoreWriteResult,
  type ContextCleanerHostExecutionBridge,
} from "./contracts.js";
import { readContextCleanPlan } from "./clean-plan-store.js";
import { readContextCleanReceipt } from "./clean-receipt-store.js";
import {
  recoverContextCleanState,
  transitionContextCleanState,
} from "./clean-state-coordinator.js";
import { sameCanonicalValue } from "./clean-store-support.js";

const EXECUTION_ID_VERSION = 1 as const;
const CONTEXT_ITEM_KINDS = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "reasoning",
  "tool_call",
  "tool_result",
  "compaction",
  "unknown",
]);

export type CreateContextCleanerHostExecutionBridgeParams = {
  stateDir: string;
  hostId: string;
  /** Reads the canonical snapshot and lifecycle state inside the Host request lock. */
  readExecutionSnapshot(
    sessionId: string,
  ): Promise<ContextCleanExecutionSnapshot>;
};

function bypassed(
  reasons: string[],
  receipt?: ContextCleanReceipt,
): ContextCleanExecutionPrepareResult {
  return {
    outcome: "bypassed",
    bypassed: true,
    reasons,
    ...(receipt ? { receipt } : {}),
  };
}

function uniqueNonBlankStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.trim().length > 0)
    && new Set(value).size === value.length;
}

function uniqueNonBlankStrings(value: unknown): value is string[] {
  return uniqueNonBlankStringArray(value) && value.length > 0;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function isScheduledReceipt(
  receipt: ContextCleanReceipt,
): receipt is ContextCleanScheduledReceipt {
  return receipt.status === "scheduled";
}

function digestId(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  return `${prefix}-v${EXECUTION_ID_VERSION}-${digest}`;
}

function validExecutionSnapshot(value: ContextCleanExecutionSnapshot): boolean {
  const { snapshot } = value;
  if (snapshot.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
    || !snapshot.hostId.trim()
    || !snapshot.sessionId.trim()
    || !snapshot.revision.trim()
    || Object.hasOwn(snapshot, "adapterMetadata")
    || !uniqueNonBlankStringArray([...value.activeTaskIds])
    || !uniqueNonBlankStringArray([...value.evictableTaskIds])) return false;
  const activeTaskIds = new Set(value.activeTaskIds);
  if (value.evictableTaskIds.some((taskId) => activeTaskIds.has(taskId))) return false;

  const stableIds = new Set<string>();
  for (const item of snapshot.items) {
    if (!item || !item.stableId.trim()
      || stableIds.has(item.stableId)
      || !CONTEXT_ITEM_KINDS.has(item.kind)
      || !item.fingerprint.trim()
      || !Number.isSafeInteger(item.chars)
      || item.chars < 0
      || (item.taskIds !== undefined
        && !uniqueNonBlankStringArray(item.taskIds))) return false;
    stableIds.add(item.stableId);
  }
  return true;
}

function selectedTasksFromPlan(
  record: ContextCleanPlanRecord,
  selectedTaskIds: readonly string[],
): ApprovedContextCleanTask[] | undefined {
  const selectedSet = new Set(selectedTaskIds);
  const selectedTasks = record.plan.tasks
    .filter((task) => selectedSet.has(task.taskId));
  if (selectedTasks.length !== selectedTaskIds.length
    || selectedTasks.some((task) => !task.selectable || task.itemIds.length === 0)) {
    return undefined;
  }

  const claimedItemIds = new Set<string>();
  const result: ApprovedContextCleanTask[] = [];
  for (const task of selectedTasks) {
    if (task.itemIds.some((itemId) => claimedItemIds.has(itemId))) return undefined;
    for (const itemId of task.itemIds) claimedItemIds.add(itemId);
    result.push({
      taskId: task.taskId,
      itemIds: [...task.itemIds],
      itemDigests: Object.fromEntries(
        task.itemIds.map((itemId) => [itemId, task.itemDigests[itemId]!]),
      ),
    });
  }
  return result;
}

function buildMutationPlan(params: {
  record: ContextCleanPlanRecord;
  selectedTasks: ApprovedContextCleanTask[];
}): ContextMutationPlan {
  const tasksById = new Map(
    params.record.plan.tasks.map((task) => [task.taskId, task]),
  );
  const operations: ContextMutationOperation[] = params.selectedTasks.map((task) => {
    const planTask = tasksById.get(task.taskId)!;
    const targetItemFingerprints = Object.fromEntries(
      task.itemIds.map((itemId) => [itemId, task.itemDigests[itemId]!]),
    );
    return {
      id: digestId("ctxcleanop", {
        cleanPlanId: params.record.plan.planId,
        taskId: task.taskId,
        targetItemIds: task.itemIds,
        targetItemFingerprints,
      }),
      type: "remove",
      targetItemIds: [...task.itemIds],
      targetItemFingerprints,
      taskIds: [task.taskId],
      rationale: "user_approved_context_clean",
      estimatedSavedChars: planTask.charCount,
    };
  });
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId: digestId("ctxcleanplan", {
      cleanPlanId: params.record.plan.planId,
      operationIds: operations.map((operation) => operation.id),
    }),
    hostId: params.record.plan.hostId,
    sessionId: params.record.plan.sessionId,
    baseRevision: params.record.plan.baseRevision,
    sourceModuleId: "cleaner_manual",
    operations,
    createdAt: params.record.plan.createdAt,
  };
}

function relocateMutationPlanForFrozenSelection(params: {
  record: ContextCleanPlanRecord;
  current: ContextCleanExecutionSnapshot;
  selectedTasks: ApprovedContextCleanTask[];
  mutationPlan: ContextMutationPlan;
}): ContextMutationPlan | undefined {
  if (params.current.snapshot.revision === params.record.plan.baseRevision) {
    return params.mutationPlan;
  }
  const baseline = params.record.plan.snapshotItems;
  if (!baseline || baseline.length === 0) return undefined;

  const baselineById = new Map(
    baseline.map((item) => [item.stableId, item.fingerprint]),
  );
  for (const task of params.selectedTasks) {
    for (const itemId of task.itemIds) {
      if (baselineById.get(itemId) !== task.itemDigests[itemId]) return undefined;
    }
  }
  return {
    ...params.mutationPlan,
    baseRevision: params.current.snapshot.revision,
  };
}

/**
 * Reconstructs the immutable mutation scope from the persisted plan. Hosts use
 * this for recovery only; it never accepts item ids or digests from a caller.
 */
export function deriveContextCleanStoredExecution(params: {
  record: ContextCleanPlanRecord;
  selectedTaskIds: readonly string[];
}): {
  selectedTasks: ApprovedContextCleanTask[];
  mutationPlan: ContextMutationPlan;
} | undefined {
  if (!uniqueNonBlankStrings([...params.selectedTaskIds])) return undefined;
  const selectedTasks = selectedTasksFromPlan(
    params.record,
    params.selectedTaskIds,
  );
  if (!selectedTasks) return undefined;
  return {
    selectedTasks,
    mutationPlan: buildMutationPlan({ record: params.record, selectedTasks }),
  };
}

async function readStoredExecutionState(params: {
  stateDir: string;
  planId: string;
}): Promise<{
  record?: ContextCleanPlanRecord;
  receipt?: ContextCleanReceipt;
  reasons: string[];
}> {
  const recovery = await recoverContextCleanState(params);
  if (recovery.bypassed) {
    return { reasons: ["clean_execution_recovery_failed", ...recovery.reasons] };
  }
  const [planRead, receiptRead] = await Promise.all([
    readContextCleanPlan(params),
    readContextCleanReceipt(params),
  ]);
  if (planRead.bypassed) {
    return { reasons: ["clean_execution_plan_unavailable", ...planRead.reasons] };
  }
  if (receiptRead.bypassed) {
    return { reasons: ["clean_execution_receipt_unavailable", ...receiptRead.reasons] };
  }
  return { record: planRead.value, receipt: receiptRead.value, reasons: [] };
}

function validateStoredIdentity(params: {
  bridgeHostId: string;
  request: ContextCleanExecutionRequest;
  record: ContextCleanPlanRecord;
  receipt: ContextCleanReceipt;
}): string[] {
  const { request, record, receipt } = params;
  if (record.plan.hostId !== params.bridgeHostId
    || receipt.hostId !== params.bridgeHostId) return ["clean_execution_host_mismatch"];
  if (record.plan.sessionId !== request.sessionId
    || receipt.sessionId !== request.sessionId) return ["clean_execution_session_mismatch"];
  if (record.plan.baseRevision !== request.baseRevision) {
    return ["clean_execution_base_revision_mismatch"];
  }
  if (record.status !== receipt.status) return ["clean_execution_state_conflict"];
  if (!sameStringSet(receipt.selectedTaskIds, request.selectedTaskIds)) {
    return ["clean_execution_selection_mismatch"];
  }
  return [];
}

async function prepareScheduledClean(params: {
  config: CreateContextCleanerHostExecutionBridgeParams;
  request: ContextCleanExecutionRequest;
}): Promise<ContextCleanExecutionPrepareResult> {
  const { request, config } = params;
  if (!request.cleanPlanId.trim()
    || !request.sessionId.trim()
    || !request.baseRevision.trim()
    || !uniqueNonBlankStrings(request.selectedTaskIds)) {
    return bypassed(["clean_execution_request_invalid"]);
  }

  const stored = await readStoredExecutionState({
    stateDir: config.stateDir,
    planId: request.cleanPlanId,
  });
  if (stored.reasons.length > 0) return bypassed(stored.reasons);
  if (!stored.record) {
    return {
      outcome: "missing",
      bypassed: false,
      reasons: ["clean_execution_missing"],
    };
  }
  if (!stored.receipt) return bypassed(["clean_execution_receipt_missing"]);

  const identityReasons = validateStoredIdentity({
    bridgeHostId: config.hostId,
    request,
    record: stored.record,
    receipt: stored.receipt,
  });
  if (identityReasons.length > 0) return bypassed(identityReasons, stored.receipt);
  if (isTerminalContextCleanStatus(stored.receipt.status)) {
    return {
      outcome: "terminal",
      receipt: stored.receipt,
      bypassed: false,
      reasons: [],
    };
  }
  if (!isScheduledReceipt(stored.receipt)) {
    return bypassed(["clean_execution_not_scheduled"], stored.receipt);
  }

  const storedExecution = deriveContextCleanStoredExecution({
    record: stored.record,
    selectedTaskIds: request.selectedTaskIds,
  });
  if (!storedExecution) {
    return bypassed(["clean_execution_plan_selection_invalid"], stored.receipt);
  }
  const { selectedTasks, mutationPlan: storedMutationPlan } = storedExecution;

  let current: ContextCleanExecutionSnapshot;
  try {
    current = await config.readExecutionSnapshot(request.sessionId);
  } catch {
    return bypassed(["clean_execution_snapshot_unavailable"], stored.receipt);
  }
  let snapshotValid = false;
  try {
    snapshotValid = validExecutionSnapshot(current);
  } catch {
    // Treat malformed Host callback data like any other unavailable snapshot.
  }
  if (!snapshotValid) {
    return bypassed(["clean_execution_snapshot_invalid"], stored.receipt);
  }
  if (current.snapshot.hostId !== config.hostId
    || current.snapshot.sessionId !== request.sessionId) {
    return bypassed(["clean_execution_snapshot_identity_mismatch"], stored.receipt);
  }
  const mutationPlan = relocateMutationPlanForFrozenSelection({
    record: stored.record,
    current,
    selectedTasks,
    mutationPlan: storedMutationPlan,
  });
  if (!mutationPlan) {
    return bypassed(["clean_execution_revision_stale"], stored.receipt);
  }

  const activeTaskIds = new Set(current.activeTaskIds);
  const evictableTaskIds = new Set(current.evictableTaskIds);
  if (selectedTasks.some((task) => activeTaskIds.has(task.taskId)
    || !evictableTaskIds.has(task.taskId))) {
    return bypassed(["clean_execution_task_not_evictable"], stored.receipt);
  }
  const currentItems = new Map(
    current.snapshot.items.map((item) => [item.stableId, item]),
  );
  for (const task of selectedTasks) {
    for (const itemId of task.itemIds) {
      const item = currentItems.get(itemId);
      if (!item || item.fingerprint !== task.itemDigests[itemId]) {
        return bypassed(["clean_execution_item_stale"], stored.receipt);
      }
      if (item.kind === "system" || item.kind === "developer"
        || item.role === "system" || item.role === "developer") {
        return bypassed(["clean_execution_protected_item_targeted"], stored.receipt);
      }
      if (!item.taskIds?.includes(task.taskId)) {
        return bypassed(["clean_execution_task_attribution_stale"], stored.receipt);
      }
    }
  }

  const revalidation = revalidateContextMutationPlan({
    snapshot: current.snapshot,
    plan: mutationPlan,
  });
  if (!revalidation.valid
    || revalidation.deferredOperationIds.length > 0
    || revalidation.applicableOperationIds.length !== mutationPlan.operations.length) {
    return bypassed(["clean_execution_revalidation_failed"], stored.receipt);
  }
  const closure = validateContextMutationProtocolClosure({
    snapshot: current.snapshot,
    plan: mutationPlan,
    activeTaskIds: current.activeTaskIds,
    evictableTaskIds: current.evictableTaskIds,
    candidateOperationIds: revalidation.applicableOperationIds,
  });
  if (!closure.valid
    || closure.deferredOperationIds.length > 0
    || closure.applicableOperationIds.length !== mutationPlan.operations.length) {
    return bypassed(["clean_execution_protocol_closure_failed"], stored.receipt);
  }

  const rechecked = await readStoredExecutionState({
    stateDir: config.stateDir,
    planId: request.cleanPlanId,
  });
  if (rechecked.reasons.length > 0) return bypassed(rechecked.reasons);
  if (!rechecked.record || !rechecked.receipt) {
    return bypassed(["clean_execution_state_changed"]);
  }
  if (isTerminalContextCleanStatus(rechecked.receipt.status)) {
    return {
      outcome: "terminal",
      receipt: rechecked.receipt,
      bypassed: false,
      reasons: [],
    };
  }
  if (!sameCanonicalValue(stored.record, rechecked.record)
    || !sameCanonicalValue(stored.receipt, rechecked.receipt)) {
    return bypassed(["clean_execution_state_changed"], rechecked.receipt);
  }

  return {
    outcome: "ready",
    execution: {
      cleanPlanId: stored.record.plan.planId,
      hostId: stored.record.plan.hostId,
      sessionId: stored.record.plan.sessionId,
      baseRevision: mutationPlan.baseRevision,
      selectedTasks,
      mutationPlan,
      scheduledReceipt: stored.receipt,
    },
    bypassed: false,
    reasons: [],
  };
}

export function createContextCleanerHostExecutionBridge(
  params: CreateContextCleanerHostExecutionBridgeParams,
): ContextCleanerHostExecutionBridge {
  if (!params.stateDir.trim()) throw new TypeError("clean execution stateDir must not be empty");
  if (!params.hostId.trim()) throw new TypeError("clean execution hostId must not be empty");
  return {
    hostId: params.hostId,
    async prepareScheduledClean(request) {
      return prepareScheduledClean({ config: params, request });
    },
    async recordCleanReceipt(
      receipt: ContextCleanReceipt,
    ): Promise<ContextCleanStoreWriteResult<ContextCleanPlanRecord>> {
      if (receipt.hostId !== params.hostId) {
        return {
          outcome: "bypassed",
          bypassed: true,
          reasons: ["clean_execution_receipt_host_mismatch"],
        };
      }
      return transitionContextCleanState({ stateDir: params.stateDir, receipt });
    },
  };
}
