import {
  createContextCleanerHostExecutionBridge,
  deriveContextCleanStoredExecution,
  readContextCleanPlan,
  readContextCleanReceipt,
  recoverContextCleanState,
  type ContextCleanPreparedExecution,
  type ContextCleanReceipt,
  type ContextCleanScheduledReceipt,
  type ContextCleanTerminalReceipt,
} from "@lightrsi/cleaner";
import { loadSessionTaskRegistry } from "@lightrsi/history";
import type {
  ContextRewriteResult,
  ModelContextSnapshot,
} from "@lightrsi/host-adapter";

import type { CodexEffectiveHistoryView } from "../context-history/types.js";
import {
  codexSharedContextRewriteBackend,
  type CodexSharedBackendDetails,
  type CodexSharedBackendMetadata,
  type CodexSharedBackendRequest,
} from "../context-rewrite/backend.js";
import {
  buildCodexLifecycleBackendRequest,
  type CodexLifecycleBackendRequestBase,
} from "../context-rewrite/lifecycle-input.js";
import {
  acquireCodexRebaseSessionLock,
  readCodexRebaseEpochJournal,
} from "../context-rewrite/rebase-epoch.js";
import type {
  CodexRebaseAccounting,
  CodexRebaseEpoch,
  CodexRebaseRequestResult,
} from "../context-rewrite/types.js";
import {
  buildCodexCleanerAppliedReceipt,
  buildCodexCleanerAppliedReceiptFromRewrite,
} from "./applied-receipt.js";
import {
  appendCodexCleanerCommitted,
  appendCodexCleanerTerminal,
  readCodexCleanerSchedule,
  type CodexCleanerCommittedRecord,
  type CodexCleanerScheduledRecord,
} from "./scheduler.js";

const STALE_REASONS = new Set([
  "clean_execution_revision_stale",
  "clean_execution_item_stale",
  "clean_execution_protected_item_targeted",
  "clean_execution_task_attribution_stale",
  "clean_execution_task_not_evictable",
  "clean_execution_revalidation_failed",
  "clean_execution_protocol_closure_failed",
  "cleaner_runtime_snapshot_changed",
  "cleaner_runtime_plan_invalid",
]);

export type CodexCleanerPreparedRebase = {
  schedule: CodexCleanerScheduledRecord;
  execution: ContextCleanPreparedExecution;
  backendRequest: CodexSharedBackendRequest;
  snapshot: ModelContextSnapshot<CodexSharedBackendMetadata>;
  rewriteResult: ContextRewriteResult<CodexSharedBackendDetails>;
  rebaseRequest: CodexRebaseRequestResult;
};

export function withCodexCleanerReplayAccounting(
  prepared: CodexCleanerPreparedRebase,
  accounting: CodexRebaseAccounting,
): CodexCleanerPreparedRebase {
  if (!prepared.rewriteResult.details) return prepared;
  return {
    ...prepared,
    rewriteResult: {
      ...prepared.rewriteResult,
      details: {
        ...prepared.rewriteResult.details,
        accounting,
      },
    },
    rebaseRequest: {
      ...prepared.rebaseRequest,
      accounting,
    },
  };
}

export type CodexCleanerRuntimeResult =
  | { outcome: "absent"; reasonCodes: [] }
  | { outcome: "ready"; prepared: CodexCleanerPreparedRebase; reasonCodes: [] }
  | { outcome: "reserved"; reasonCodes: string[] }
  | { outcome: "stale"; receipt: ContextCleanTerminalReceipt; reasonCodes: string[] }
  | { outcome: "terminal"; receipt?: ContextCleanReceipt; reasonCodes: string[] }
  | { outcome: "committed"; reasonCodes: string[] };

export type CodexCleanerHandoffValidation = {
  valid: boolean;
  reasonCodes: string[];
};

export type CodexCleanerAppliedReceiptFinalization =
  | { outcome: "applied"; reasonCodes: [] }
  | { outcome: "reserved"; reasonCodes: string[] };

function uniqueStrings(values: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function fullyApplied(
  execution: ContextCleanPreparedExecution,
  result: ContextRewriteResult<CodexSharedBackendDetails>,
): boolean {
  const operationIds = execution.mutationPlan.operations.map((operation) => operation.id);
  return result.applied
    && result.changed
    && result.fallbackUsed === false
    && result.details?.rebasePrepared === true
    && result.deferredOperationIds.length === 0
    && result.appliedOperationIds.length === operationIds.length
    && operationIds.every((operationId) => result.appliedOperationIds.includes(operationId));
}

async function executionContext(params: {
  stateDir: string;
  sessionId: string;
  view: CodexEffectiveHistoryView;
  backendRequest: CodexLifecycleBackendRequestBase;
}): Promise<{
  backendRequest: CodexSharedBackendRequest;
  snapshot: ModelContextSnapshot<CodexSharedBackendMetadata>;
}> {
  const registry = await loadSessionTaskRegistry(params.stateDir, params.sessionId);
  if (registry.sessionId !== params.sessionId) {
    throw new Error("cleaner_runtime_registry_session_mismatch");
  }
  const backendRequest = buildCodexLifecycleBackendRequest({
    view: params.view,
    registry,
    request: params.backendRequest,
  });
  const snapshot = await codexSharedContextRewriteBackend.readSnapshot({
    sessionId: params.sessionId,
    request: backendRequest,
  });
  return { backendRequest, snapshot };
}

function executionBridge(params: {
  stateDir: string;
  sessionId: string;
  backendRequest: CodexSharedBackendRequest;
  snapshot: ModelContextSnapshot<CodexSharedBackendMetadata>;
}) {
  return createContextCleanerHostExecutionBridge({
    stateDir: params.stateDir,
    hostId: "codex",
    async readExecutionSnapshot(sessionId) {
      if (sessionId !== params.sessionId) {
        throw new Error("cleaner_runtime_snapshot_session_mismatch");
      }
      const { adapterMetadata: _adapterMetadata, ...canonicalSnapshot } = params.snapshot;
      return {
        snapshot: canonicalSnapshot,
        activeTaskIds: params.backendRequest.activeTaskIds ?? [],
        evictableTaskIds: params.backendRequest.evictableTaskIds ?? [],
      };
    },
  });
}

function receiptBridge(stateDir: string) {
  return createContextCleanerHostExecutionBridge({
    stateDir,
    hostId: "codex",
    async readExecutionSnapshot() {
      throw new Error("cleaner_runtime_receipt_write_does_not_read_host_state");
    },
  });
}

function staleReasonCodes(reasonCodes: readonly string[]): string[] | undefined {
  const stale = uniqueStrings(reasonCodes.filter((reason) => STALE_REASONS.has(reason)));
  return stale.length > 0 ? stale : undefined;
}

export function isCodexCleanerStaleReasonCode(reason: string | undefined): boolean {
  return typeof reason === "string" && STALE_REASONS.has(reason);
}

function isScheduledReceipt(
  receipt: ContextCleanReceipt | undefined,
): receipt is ContextCleanScheduledReceipt {
  return receipt?.status === "scheduled";
}

async function persistTerminalSchedule(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  receiptStatus: "stale" | "cancelled" | "failed";
  reasons: string[];
  updatedAt: string;
}): Promise<string[]> {
  const local = await appendCodexCleanerTerminal(params);
  return local.outcome === "transitioned" || local.outcome === "unchanged"
    ? []
    : uniqueStrings(local.reasons);
}

async function persistStale(params: {
  stateDir: string;
  sessionId: string;
  scheduledReceipt: ContextCleanScheduledReceipt;
  reasonCodes: string[];
  updatedAt: string;
}): Promise<CodexCleanerRuntimeResult> {
  const receipt: ContextCleanTerminalReceipt = {
    ...params.scheduledReceipt,
    status: "stale",
    deferredTaskIds: [...params.scheduledReceipt.selectedTaskIds],
    fallbackUsed: false,
    reasons: [...params.reasonCodes],
    updatedAt: params.updatedAt,
  };
  const stored = await receiptBridge(params.stateDir).recordCleanReceipt(receipt);
  if (stored.bypassed) {
    return {
      outcome: "reserved",
      reasonCodes: uniqueStrings([
        ...params.reasonCodes,
        "cleaner_runtime_stale_receipt_write_failed",
        ...stored.reasons,
      ]),
    };
  }
  const localReasons = await persistTerminalSchedule({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    cleanPlanId: receipt.planId,
    receiptStatus: "stale",
    reasons: params.reasonCodes,
    updatedAt: params.updatedAt,
  });
  return localReasons.length === 0
    ? { outcome: "stale", receipt, reasonCodes: params.reasonCodes }
    : {
        outcome: "reserved",
        reasonCodes: uniqueStrings([
          ...params.reasonCodes,
          "cleaner_runtime_terminal_schedule_write_failed",
          ...localReasons,
        ]),
      };
}

export async function finalizeCodexCleanerHandoffFailure(params: {
  stateDir: string;
  sessionId: string;
  prepared: CodexCleanerPreparedRebase;
  reasonCodes: string[];
  now?: string;
}): Promise<CodexCleanerRuntimeResult> {
  const stale = staleReasonCodes(params.reasonCodes);
  if (!stale) {
    return { outcome: "reserved", reasonCodes: uniqueStrings(params.reasonCodes) };
  }
  return persistStale({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    scheduledReceipt: params.prepared.execution.scheduledReceipt,
    reasonCodes: stale,
    updatedAt: params.now ?? new Date().toISOString(),
  });
}

export async function finalizeCodexCleanerAppliedReceipt(params: {
  stateDir: string;
  sessionId: string;
  prepared: CodexCleanerPreparedRebase;
  epoch: CodexRebaseEpoch;
}): Promise<CodexCleanerAppliedReceiptFinalization> {
  const built = buildCodexCleanerAppliedReceiptFromRewrite({
    execution: params.prepared.execution,
    rewriteResult: params.prepared.rewriteResult,
    rebaseRequest: params.prepared.rebaseRequest,
    epoch: params.epoch,
  });
  if (!built.receipt) {
    return { outcome: "reserved", reasonCodes: built.reasons };
  }
  const stored = await receiptBridge(params.stateDir).recordCleanReceipt(built.receipt);
  if (stored.bypassed || stored.value?.status !== "applied") {
    return {
      outcome: "reserved",
      reasonCodes: uniqueStrings([
        "cleaner_runtime_applied_receipt_write_failed",
        ...stored.reasons,
      ]),
    };
  }
  const local = await appendCodexCleanerCommitted({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    cleanPlanId: params.prepared.execution.cleanPlanId,
    mutationPlanId: params.prepared.execution.mutationPlan.planId,
    epochId: params.epoch.epochId,
    updatedAt: params.epoch.updatedAt,
  });
  if (local.outcome !== "transitioned" && local.outcome !== "unchanged") {
    return {
      outcome: "reserved",
      reasonCodes: uniqueStrings([
        "cleaner_runtime_applied_schedule_write_failed",
        ...local.reasons,
      ]),
    };
  }
  return { outcome: "applied", reasonCodes: [] };
}

type CodexCleanerCommitRecovery =
  | { outcome: "none"; reasonCodes: [] }
  | {
      outcome: "recovered";
      commit: {
        cleanPlanId: string;
        mutationPlanId: string;
        epochId: string;
        updatedAt: string;
      };
      reasonCodes: [];
    }
  | { outcome: "terminal"; receipt: ContextCleanReceipt; reasonCodes: string[] }
  | { outcome: "reserved"; reasonCodes: string[] };

function asScheduledReceiptForRecovery(
  receipt: ContextCleanReceipt,
): ContextCleanScheduledReceipt | undefined {
  if (receipt.status === "scheduled") return { ...receipt, status: "scheduled" };
  if (receipt.status !== "applied") return undefined;
  const {
    appliedSavedTokens: _appliedSavedTokens,
    appliedSavedChars: _appliedSavedChars,
    evidence: _evidence,
    ...scheduled
  } = receipt;
  return { ...scheduled, status: "scheduled", fallbackUsed: false };
}

async function recoverCodexCleanerCommittedEpoch(params: {
  stateDir: string;
  sessionId: string;
  schedule: CodexCleanerScheduledRecord | CodexCleanerCommittedRecord;
}): Promise<CodexCleanerCommitRecovery> {
  const recovered = await recoverContextCleanState({
    stateDir: params.stateDir,
    planId: params.schedule.cleanPlanId,
  });
  if (recovered.bypassed) {
    return {
      outcome: "reserved",
      reasonCodes: uniqueStrings([
        "cleaner_runtime_receipt_recovery_failed",
        ...recovered.reasons,
      ]),
    };
  }
  const [storedPlan, storedReceipt, epochs] = await Promise.all([
    readContextCleanPlan({ stateDir: params.stateDir, planId: params.schedule.cleanPlanId }),
    readContextCleanReceipt({ stateDir: params.stateDir, planId: params.schedule.cleanPlanId }),
    readCodexRebaseEpochJournal(params.stateDir, params.sessionId),
  ]);
  if (storedPlan.bypassed || storedReceipt.bypassed) {
    return {
      outcome: "reserved",
      reasonCodes: uniqueStrings([
        "cleaner_runtime_receipt_recovery_unavailable",
        ...storedPlan.reasons,
        ...storedReceipt.reasons,
      ]),
    };
  }
  if (epochs.readError || epochs.malformedLineCount > 0) {
    return {
      outcome: "reserved",
      reasonCodes: ["cleaner_runtime_epoch_journal_unavailable"],
    };
  }
  if (!storedPlan.value || !storedReceipt.value) {
    return params.schedule.status === "committed"
      ? { outcome: "reserved", reasonCodes: ["cleaner_runtime_committed_receipt_missing"] }
      : { outcome: "none", reasonCodes: [] };
  }
  const record = storedPlan.value.plan;
  const receipt = storedReceipt.value;
  if (record.hostId !== "codex"
    || record.sessionId !== params.sessionId
    || record.baseRevision !== params.schedule.baseRevision
    || record.planId !== params.schedule.cleanPlanId
    || storedPlan.value.status !== receipt.status
    || receipt.hostId !== "codex"
    || receipt.sessionId !== params.sessionId
    || receipt.planId !== params.schedule.cleanPlanId
    || !sameStringSet(receipt.selectedTaskIds, params.schedule.selectedTaskIds)) {
    return { outcome: "reserved", reasonCodes: ["cleaner_runtime_receipt_identity_invalid"] };
  }
  if (receipt.status === "stale" || receipt.status === "cancelled" || receipt.status === "failed") {
    return { outcome: "terminal", receipt, reasonCodes: receipt.reasons };
  }
  const scheduledReceipt = asScheduledReceiptForRecovery(receipt);
  const storedExecution = scheduledReceipt && deriveContextCleanStoredExecution({
    record: storedPlan.value,
    selectedTaskIds: params.schedule.selectedTaskIds,
  });
  if (!scheduledReceipt || !storedExecution) {
    return { outcome: "reserved", reasonCodes: ["cleaner_runtime_receipt_scope_invalid"] };
  }
  const execution: ContextCleanPreparedExecution = {
    cleanPlanId: storedPlan.value.plan.planId,
    hostId: storedPlan.value.plan.hostId,
    sessionId: storedPlan.value.plan.sessionId,
    baseRevision: storedPlan.value.plan.baseRevision,
    selectedTasks: storedExecution.selectedTasks,
    mutationPlan: storedExecution.mutationPlan,
    scheduledReceipt,
  };
  const matchingEpoch = epochs.epochs.find((epoch) => (
    epoch.status === "committed"
    && epoch.planId === execution.mutationPlan.planId
    && (params.schedule.status !== "committed" || epoch.epochId === params.schedule.epochId)
  ));
  if (!matchingEpoch) {
    return params.schedule.status === "committed"
      ? { outcome: "reserved", reasonCodes: ["cleaner_runtime_committed_epoch_missing"] }
      : { outcome: "none", reasonCodes: [] };
  }
  const built = buildCodexCleanerAppliedReceipt({ execution, epoch: matchingEpoch });
  if (!built.receipt) return { outcome: "reserved", reasonCodes: built.reasons };
  if (receipt.status === "applied") {
    if (!sameCanonicalValue(receipt, built.receipt)) {
      return { outcome: "reserved", reasonCodes: ["cleaner_runtime_applied_receipt_evidence_invalid"] };
    }
  } else {
    const stored = await receiptBridge(params.stateDir).recordCleanReceipt(built.receipt);
    if (stored.bypassed || stored.value?.status !== "applied") {
      return {
        outcome: "reserved",
        reasonCodes: uniqueStrings([
          "cleaner_runtime_applied_receipt_write_failed",
          ...stored.reasons,
        ]),
      };
    }
  }
  return {
    outcome: "recovered",
    commit: {
      cleanPlanId: execution.cleanPlanId,
      mutationPlanId: execution.mutationPlan.planId,
      epochId: matchingEpoch.epochId,
      updatedAt: matchingEpoch.updatedAt,
    },
    reasonCodes: [],
  };
}

async function persistExistingTerminal(params: {
  stateDir: string;
  sessionId: string;
  receipt: ContextCleanReceipt;
  now: string;
}): Promise<CodexCleanerRuntimeResult> {
  if (params.receipt.status !== "stale"
    && params.receipt.status !== "cancelled"
    && params.receipt.status !== "failed") {
    return {
      outcome: "terminal",
      receipt: params.receipt,
      reasonCodes: ["cleaner_runtime_terminal_receipt"],
    };
  }
  const reasons = params.receipt.reasons.length > 0
    ? params.receipt.reasons
    : ["cleaner_runtime_terminal_receipt"];
  const localReasons = await persistTerminalSchedule({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    cleanPlanId: params.receipt.planId,
    receiptStatus: params.receipt.status,
    reasons,
    updatedAt: params.now,
  });
  return {
    outcome: "terminal",
    receipt: params.receipt,
    reasonCodes: uniqueStrings([...reasons, ...localReasons]),
  };
}

export async function prepareCodexCleanerRebase(params: {
  stateDir: string;
  sessionId: string;
  view: CodexEffectiveHistoryView;
  backendRequest: CodexLifecycleBackendRequestBase;
  now?: string;
}): Promise<CodexCleanerRuntimeResult> {
  const now = params.now ?? new Date().toISOString();
  const initial = await readCodexCleanerSchedule(params);
  if (initial.outcome === "missing") return { outcome: "absent", reasonCodes: [] };
  if (initial.outcome === "bypassed") {
    return { outcome: "reserved", reasonCodes: initial.reasons };
  }
  if (initial.outcome === "terminal") {
    return { outcome: "terminal", reasonCodes: initial.record.reasons };
  }

  const lock = await acquireCodexRebaseSessionLock({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
  });
  if (!lock) return { outcome: "reserved", reasonCodes: ["cleaner_runtime_lock_busy"] };

  let decision: CodexCleanerRuntimeResult;
  let scheduledReceipt: ContextCleanScheduledReceipt | undefined;
  let recoveredCommit: {
    cleanPlanId: string;
    mutationPlanId: string;
    epochId: string;
    updatedAt: string;
  } | undefined;
  try {
    const currentSchedule = await readCodexCleanerSchedule(params);
    if (currentSchedule.outcome === "missing") {
      decision = { outcome: "reserved", reasonCodes: ["cleaner_runtime_schedule_changed"] };
    } else if (currentSchedule.outcome === "bypassed") {
      decision = { outcome: "reserved", reasonCodes: currentSchedule.reasons };
    } else if (currentSchedule.outcome === "terminal") {
      decision = { outcome: "terminal", reasonCodes: currentSchedule.record.reasons };
    } else if (currentSchedule.outcome === "ready"
      && initial.outcome === "ready"
      && !sameCanonicalValue(initial.record, currentSchedule.record)) {
      decision = { outcome: "reserved", reasonCodes: ["cleaner_runtime_schedule_changed"] };
    } else {
      const recovery = await recoverCodexCleanerCommittedEpoch({
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        schedule: currentSchedule.record,
      });
      if (recovery.outcome === "recovered") {
        recoveredCommit = recovery.commit;
        decision = {
          outcome: "committed",
          reasonCodes: ["cleaner_runtime_already_committed"],
        };
      } else if (recovery.outcome === "terminal") {
        decision = {
          outcome: "terminal",
          receipt: recovery.receipt,
          reasonCodes: recovery.reasonCodes.length > 0
            ? recovery.reasonCodes
            : ["cleaner_runtime_terminal_receipt"],
        };
      } else if (recovery.outcome === "reserved") {
        decision = { outcome: "reserved", reasonCodes: recovery.reasonCodes };
      } else if (currentSchedule.outcome === "committed") {
        decision = {
          outcome: "reserved",
          reasonCodes: ["cleaner_runtime_committed_receipt_missing"],
        };
      } else {
        let context;
        try {
          context = await executionContext(params);
        } catch {
          decision = {
            outcome: "reserved",
            reasonCodes: ["cleaner_runtime_execution_context_unavailable"],
          };
          return decision;
        }
        const bridge = executionBridge({
          ...params,
          backendRequest: context.backendRequest,
          snapshot: context.snapshot,
        });
        const prepared = await bridge.prepareScheduledClean({
          cleanPlanId: currentSchedule.record.cleanPlanId,
          sessionId: currentSchedule.record.sessionId,
          baseRevision: currentSchedule.record.baseRevision,
          selectedTaskIds: currentSchedule.record.selectedTaskIds,
        });
        if (prepared.outcome === "terminal") {
          decision = {
            outcome: "terminal",
            receipt: prepared.receipt,
            reasonCodes: prepared.receipt.reasons.length > 0
              ? prepared.receipt.reasons
              : ["cleaner_runtime_terminal_receipt"],
          };
        } else if (prepared.outcome !== "ready") {
          const stale = prepared.outcome === "bypassed"
            ? staleReasonCodes(prepared.reasons)
            : undefined;
          if (stale && prepared.outcome === "bypassed"
            && isScheduledReceipt(prepared.receipt)) {
            scheduledReceipt = prepared.receipt;
            decision = { outcome: "reserved", reasonCodes: stale };
          } else {
            decision = { outcome: "reserved", reasonCodes: prepared.reasons };
          }
        } else {
          scheduledReceipt = prepared.execution.scheduledReceipt;
          const applied = await codexSharedContextRewriteBackend.apply({
            snapshot: context.snapshot,
            plan: prepared.execution.mutationPlan,
            request: context.backendRequest,
          });
          if (!fullyApplied(prepared.execution, applied.result)) {
            decision = {
              outcome: "reserved",
              reasonCodes: ["cleaner_runtime_rebase_prepare_failed"],
            };
          } else {
            decision = {
              outcome: "ready",
              prepared: {
                schedule: currentSchedule.record,
                execution: prepared.execution,
                backendRequest: context.backendRequest,
                snapshot: context.snapshot,
                rewriteResult: applied.result,
                rebaseRequest: {
                  payload: applied.request.payload,
                  oldRevision: applied.result.previousRevision,
                  rebaseRevision: applied.result.nextRevision,
                  accounting: applied.result.details!.accounting,
                },
              },
              reasonCodes: [],
            };
          }
        }
      }
    }
  } finally {
    await lock.release();
  }

  if (decision.outcome === "reserved" && scheduledReceipt) {
    const stale = staleReasonCodes(decision.reasonCodes);
    if (stale) {
      return persistStale({
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        scheduledReceipt,
        reasonCodes: stale,
        updatedAt: now,
      });
    }
  }
  if (decision.outcome === "committed" && recoveredCommit) {
    const local = await appendCodexCleanerCommitted({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      ...recoveredCommit,
    });
    if (local.outcome !== "transitioned" && local.outcome !== "unchanged") {
      return {
        outcome: "reserved",
        reasonCodes: uniqueStrings([
          "cleaner_runtime_commit_recovery_failed",
          ...local.reasons,
        ]),
      };
    }
  }
  if (decision.outcome === "terminal" && decision.receipt) {
    return persistExistingTerminal({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      receipt: decision.receipt,
      now,
    });
  }
  return decision;
}

export async function revalidateCodexCleanerPreparedRebase(params: {
  stateDir: string;
  sessionId: string;
  prepared: CodexCleanerPreparedRebase;
  view: CodexEffectiveHistoryView;
  backendRequest: CodexLifecycleBackendRequestBase;
}): Promise<CodexCleanerHandoffValidation> {
  const schedule = await readCodexCleanerSchedule(params);
  if (schedule.outcome !== "ready") {
    return {
      valid: false,
      reasonCodes: schedule.outcome === "bypassed"
        ? schedule.reasons
        : [`cleaner_runtime_schedule_${schedule.outcome}`],
    };
  }
  if (!sameCanonicalValue(schedule.record, params.prepared.schedule)) {
    return { valid: false, reasonCodes: ["cleaner_runtime_schedule_changed"] };
  }

  const epochs = await readCodexRebaseEpochJournal(params.stateDir, params.sessionId);
  if (epochs.readError || epochs.malformedLineCount > 0) {
    return { valid: false, reasonCodes: ["cleaner_runtime_epoch_journal_unavailable"] };
  }
  if (epochs.epochs.some((epoch) => (
    epoch.status === "committed"
    && epoch.planId === params.prepared.execution.mutationPlan.planId
  ))) {
    return { valid: false, reasonCodes: ["cleaner_runtime_already_committed"] };
  }

  let current;
  try {
    current = await executionContext(params);
  } catch {
    return {
      valid: false,
      reasonCodes: ["cleaner_runtime_execution_context_unavailable"],
    };
  }
  const bridge = executionBridge({
    ...params,
    backendRequest: current.backendRequest,
    snapshot: current.snapshot,
  });
  const prepared = await bridge.prepareScheduledClean({
    cleanPlanId: schedule.record.cleanPlanId,
    sessionId: schedule.record.sessionId,
    baseRevision: schedule.record.baseRevision,
    selectedTaskIds: schedule.record.selectedTaskIds,
  });
  if (prepared.outcome !== "ready") {
    return { valid: false, reasonCodes: prepared.reasons };
  }
  if (!sameCanonicalValue(params.prepared.execution.mutationPlan, prepared.execution.mutationPlan)
    || !sameCanonicalValue(params.prepared.snapshot, current.snapshot)) {
    return { valid: false, reasonCodes: ["cleaner_runtime_snapshot_changed"] };
  }
  const validation = await codexSharedContextRewriteBackend.validate({
    snapshot: current.snapshot,
    plan: prepared.execution.mutationPlan,
  });
  const operationIds = prepared.execution.mutationPlan.operations.map((operation) => operation.id);
  const valid = validation.valid
    && validation.deferredOperationIds.length === 0
    && validation.applicableOperationIds.length === operationIds.length
    && operationIds.every((operationId) => validation.applicableOperationIds.includes(operationId));
  return valid
    ? { valid: true, reasonCodes: [] }
    : { valid: false, reasonCodes: ["cleaner_runtime_plan_invalid", ...validation.reasons] };
}
