import {
  loadSessionTaskRegistry,
  persistSessionTaskRegistry,
  SessionTaskRegistryVersionMismatchError,
} from "@lightrsi/history";
import {
  planLifecycleEviction,
  type LifecyclePlannerConfig,
  type LifecyclePlannerReasonCode,
  type TaskStateEstimator,
  type TaskStateEstimatorOutput,
} from "@lightrsi/eviction";
import type {
  ContextMutationPlan,
  ContextRewriteValidation,
  ModelContextSnapshot,
} from "@lightrsi/host-adapter";

import type {
  CodexEffectiveHistoryView,
  CodexRequestJournalEntry,
} from "../context-history/types.js";
import {
  buildCodexContextSnapshot,
  codexSharedContextRewriteBackend,
  type CodexSharedBackendMetadata,
  type CodexSharedBackendRequest,
} from "./backend.js";
import {
  buildCodexLifecycleBackendRequest,
  buildCodexLifecycleInput,
  type CodexLifecycleBackendRequestBase,
  type CodexLifecycleInputReasonCode,
} from "./lifecycle-input.js";
import {
  acquireCodexRebaseSessionLock,
  type CodexRebaseSessionLock,
} from "./rebase-epoch.js";

export type CodexLifecycleRunnerReasonCode =
  | CodexLifecycleInputReasonCode
  | LifecyclePlannerReasonCode
  | "lifecycle_runner_state_dir_invalid"
  | "lifecycle_runner_session_mismatch"
  | "lifecycle_runner_lock_busy"
  | "lifecycle_runner_lock_failed"
  | "lifecycle_runner_registry_load_failed"
  | "lifecycle_runner_registry_version_conflict"
  | "lifecycle_runner_registry_persist_failed"
  | "lifecycle_runner_plan_invalid"
  | "lifecycle_runner_failed";

export type CodexLifecyclePreparedPlan = {
  plan: ContextMutationPlan;
  /** CAS version that must still be current when runtime consumes the plan. */
  registryVersion: number;
  backendRequest: CodexSharedBackendRequest;
  snapshot: ModelContextSnapshot<CodexSharedBackendMetadata>;
  validation: ContextRewriteValidation;
};

export type CodexLifecycleRunnerResult = {
  status: "completed" | "deferred" | "bypassed";
  reasonCodes: CodexLifecycleRunnerReasonCode[];
  attemptedEstimator: boolean;
  registryPersisted: boolean;
  registryChanged: boolean;
  estimatorUsage?: TaskStateEstimatorOutput["usage"];
  registryVersionBefore?: number;
  registryVersionAfter?: number;
  estimatorFailureCode?: string;
  estimatorFailureDurationMs?: number;
  preparedPlan?: CodexLifecyclePreparedPlan;
};

export type CodexLifecycleHandoffReasonCode =
  | "lifecycle_execution_registry_load_failed"
  | "lifecycle_execution_registry_version_changed"
  | "lifecycle_execution_snapshot_changed"
  | "lifecycle_execution_plan_invalid";

export type CodexLifecycleHandoffValidation = {
  valid: boolean;
  reasonCodes: CodexLifecycleHandoffReasonCode[];
  registryVersion?: number;
};

export type RevalidateCodexLifecyclePreparedPlanParams = {
  stateDir: string;
  sessionId: string;
  preparedPlan: CodexLifecyclePreparedPlan;
  view: CodexEffectiveHistoryView;
  backendRequest: CodexLifecycleBackendRequestBase;
};

export type RunCodexLifecyclePlannerParams = {
  stateDir: string;
  sessionId: string;
  view: Parameters<typeof buildCodexLifecycleInput>[0]["view"];
  backendRequest: CodexLifecycleBackendRequestBase;
  estimator?: TaskStateEstimator | null;
  config: LifecyclePlannerConfig;
  createdAt: string;
  expectedCurrentRequest?: Pick<
    CodexRequestJournalEntry,
    "requestId" | "sessionId" | "status" | "turnOrdinal"
  >;
  currentTaskIds?: readonly string[];
  closureDeferredTaskIds?: readonly string[];
  currentActiveTaskHint?: string;
  inputMode?: Parameters<typeof buildCodexLifecycleInput>[0]["inputMode"];
  completedTaskSummaries?: Parameters<
    typeof buildCodexLifecycleInput
  >[0]["completedTaskSummaries"];
  duplicateWindow?: boolean;
  sourcePresetId?: string;
};

function result(params: {
  status: CodexLifecycleRunnerResult["status"];
  reasonCodes: Iterable<CodexLifecycleRunnerReasonCode>;
  attemptedEstimator?: boolean;
  registryPersisted?: boolean;
  registryChanged?: boolean;
  estimatorUsage?: TaskStateEstimatorOutput["usage"];
  registryVersionBefore?: number;
  registryVersionAfter?: number;
  estimatorFailureCode?: string;
  estimatorFailureDurationMs?: number;
  preparedPlan?: CodexLifecyclePreparedPlan;
}): CodexLifecycleRunnerResult {
  return {
    status: params.status,
    reasonCodes: [...new Set(params.reasonCodes)],
    attemptedEstimator: params.attemptedEstimator ?? false,
    registryPersisted: params.registryPersisted ?? false,
    registryChanged: params.registryChanged ?? false,
    ...(params.estimatorUsage ? { estimatorUsage: params.estimatorUsage } : {}),
    ...(params.registryVersionBefore !== undefined
      ? { registryVersionBefore: params.registryVersionBefore }
      : {}),
    ...(params.registryVersionAfter !== undefined
      ? { registryVersionAfter: params.registryVersionAfter }
      : {}),
    ...(params.estimatorFailureCode
      ? { estimatorFailureCode: params.estimatorFailureCode }
      : {}),
    ...(params.estimatorFailureDurationMs !== undefined
      ? { estimatorFailureDurationMs: params.estimatorFailureDurationMs }
      : {}),
    ...(params.preparedPlan ? { preparedPlan: params.preparedPlan } : {}),
  };
}

function fullyApplicable(
  plan: ContextMutationPlan,
  validation: ContextRewriteValidation,
): boolean {
  const operationIds = [...new Set(plan.operations.map((operation) => operation.id))];
  return validation.valid
    && validation.deferredOperationIds.length === 0
    && validation.applicableOperationIds.length === operationIds.length
    && operationIds.every((operationId) => (
      validation.applicableOperationIds.includes(operationId)
    ));
}

function sameLifecycleSnapshot(
  left: ModelContextSnapshot<CodexSharedBackendMetadata>,
  right: ModelContextSnapshot<CodexSharedBackendMetadata>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Revalidates the planner-to-runtime handoff. The caller must hold the Codex
 * rebase session lock continuously from this check through provider execution.
 */
export async function revalidateCodexLifecyclePreparedPlan(
  params: RevalidateCodexLifecyclePreparedPlanParams,
): Promise<CodexLifecycleHandoffValidation> {
  let registry;
  try {
    registry = await loadSessionTaskRegistry(params.stateDir, params.sessionId);
  } catch {
    return {
      valid: false,
      reasonCodes: ["lifecycle_execution_registry_load_failed"],
    };
  }
  if (
    registry.sessionId !== params.sessionId
    || registry.version !== params.preparedPlan.registryVersion
  ) {
    return {
      valid: false,
      reasonCodes: ["lifecycle_execution_registry_version_changed"],
      registryVersion: registry.version,
    };
  }

  let currentSnapshot: ModelContextSnapshot<CodexSharedBackendMetadata>;
  try {
    const currentRequest = buildCodexLifecycleBackendRequest({
      view: params.view,
      registry,
      request: params.backendRequest,
    });
    currentSnapshot = buildCodexContextSnapshot(currentRequest);
  } catch {
    return {
      valid: false,
      reasonCodes: ["lifecycle_execution_snapshot_changed"],
      registryVersion: registry.version,
    };
  }
  if (!sameLifecycleSnapshot(params.preparedPlan.snapshot, currentSnapshot)) {
    return {
      valid: false,
      reasonCodes: ["lifecycle_execution_snapshot_changed"],
      registryVersion: registry.version,
    };
  }

  let validation: ContextRewriteValidation;
  try {
    validation = await codexSharedContextRewriteBackend.validate({
      snapshot: currentSnapshot,
      plan: params.preparedPlan.plan,
    });
  } catch {
    return {
      valid: false,
      reasonCodes: ["lifecycle_execution_plan_invalid"],
      registryVersion: registry.version,
    };
  }
  return fullyApplicable(params.preparedPlan.plan, validation)
    ? {
        valid: true,
        reasonCodes: [],
        registryVersion: registry.version,
      }
    : {
        valid: false,
        reasonCodes: ["lifecycle_execution_plan_invalid"],
        registryVersion: registry.version,
      };
}

/**
 * Consumes the shared lifecycle planner inside the existing Codex rebase
 * session lock. The runner owns registry I/O and post-estimator Host
 * validation, but never calls an upstream provider or mutates the request.
 * A plan is exposed only after its registry update wins the expected-version
 * CAS. The returned registryVersion is a handoff token: runtime wiring must
 * re-check it if planning and provider execution do not share one continuous
 * session-lock scope.
 */
export async function runCodexLifecyclePlanner(
  params: RunCodexLifecyclePlannerParams,
): Promise<CodexLifecycleRunnerResult> {
  if (!params.config.enabled) {
    return result({
      status: "bypassed",
      reasonCodes: ["planner_disabled"],
    });
  }
  if (!params.estimator) {
    return result({
      status: "bypassed",
      reasonCodes: ["estimator_missing"],
    });
  }
  if (!params.stateDir.trim()) {
    return result({
      status: "bypassed",
      reasonCodes: ["lifecycle_runner_state_dir_invalid"],
    });
  }
  if (
    !params.sessionId.trim()
    || params.backendRequest.sessionId !== params.sessionId
    || (params.expectedCurrentRequest
      && params.expectedCurrentRequest.sessionId !== params.sessionId)
  ) {
    return result({
      status: "bypassed",
      reasonCodes: ["lifecycle_runner_session_mismatch"],
    });
  }

  let lock: CodexRebaseSessionLock | undefined;
  try {
    lock = await acquireCodexRebaseSessionLock({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
    });
  } catch {
    return result({
      status: "bypassed",
      reasonCodes: ["lifecycle_runner_lock_failed"],
    });
  }
  if (!lock) {
    return result({
      status: "deferred",
      reasonCodes: ["lifecycle_runner_lock_busy"],
    });
  }

  let attemptedEstimator = false;
  let estimatorUsage: TaskStateEstimatorOutput["usage"];
  let estimatorFailureCode: string | undefined;
  let estimatorFailureDurationMs: number | undefined;
  try {
    let registry;
    try {
      registry = await loadSessionTaskRegistry(params.stateDir, params.sessionId);
    } catch {
      return result({
        status: "bypassed",
        reasonCodes: ["lifecycle_runner_registry_load_failed"],
      });
    }
    const registryVersionBefore = registry.version;

    const lifecycleInput = buildCodexLifecycleInput({
      view: params.view,
      registry,
      backendRequest: params.backendRequest,
      expectedCurrentRequest: params.expectedCurrentRequest,
      currentTaskIds: params.currentTaskIds,
      closureDeferredTaskIds: params.closureDeferredTaskIds,
      currentActiveTaskHint: params.currentActiveTaskHint,
      inputMode: params.inputMode,
      completedTaskSummaries: params.completedTaskSummaries,
    });
    if (lifecycleInput.status === "deferred") {
      return result({
        status: "deferred",
        reasonCodes: lifecycleInput.reasonCodes,
        registryVersionBefore,
        registryVersionAfter: registryVersionBefore,
      });
    }

    const planned = await planLifecycleEviction({
      registry,
      delta: lifecycleInput.delta,
      pendingTurnCount: lifecycleInput.pendingTurnCount,
      duplicateWindow: params.duplicateWindow,
      estimator: params.estimator,
      historyBlocks: lifecycleInput.historyBlocks,
      snapshot: lifecycleInput.snapshot,
      stableItemIdsByMessageId: lifecycleInput.stableItemIdsByMessageId,
      activeTaskIds: lifecycleInput.activeTaskIds,
      currentTaskIds: lifecycleInput.currentTaskIds,
      currentTurnAbsId: lifecycleInput.currentTurnAbsId,
      closureDeferredTaskIds: lifecycleInput.closureDeferredTaskIds,
      config: params.config,
      createdAt: params.createdAt,
      sourcePresetId: params.sourcePresetId,
    });
    attemptedEstimator = planned.attemptedEstimator;
    estimatorUsage = planned.estimatorUsage;
    estimatorFailureCode = planned.estimatorFailureCode;
    estimatorFailureDurationMs = planned.estimatorFailureDurationMs;

    let preparedPlan: CodexLifecyclePreparedPlan | undefined;
    const runnerReasons: CodexLifecycleRunnerReasonCode[] = [...planned.reasonCodes];
    if (planned.plan) {
      const backendRequest = buildCodexLifecycleBackendRequest({
        view: lifecycleInput.committedView,
        registry: planned.registry,
        request: params.backendRequest,
      });
      const snapshot = buildCodexContextSnapshot(backendRequest);
      const validation = await codexSharedContextRewriteBackend.validate({
        snapshot,
        plan: planned.plan,
      });
      if (fullyApplicable(planned.plan, validation)) {
        preparedPlan = {
          plan: planned.plan,
          registryVersion: planned.registry.version,
          backendRequest,
          snapshot,
          validation,
        };
      } else {
        runnerReasons.push("lifecycle_runner_plan_invalid");
      }
    }
    if (preparedPlan && !planned.registryUpdateRequired) {
      preparedPlan = undefined;
      runnerReasons.push("lifecycle_runner_plan_invalid");
    }

    let registryPersisted = false;
    if (planned.registryUpdateRequired) {
      try {
        await persistSessionTaskRegistry(params.stateDir, planned.registry, {
          expectedVersion: planned.expectedRegistryVersion,
        });
        registryPersisted = true;
      } catch (error) {
        if (error instanceof SessionTaskRegistryVersionMismatchError) {
          return result({
            status: "deferred",
            reasonCodes: [
              ...runnerReasons,
              "lifecycle_runner_registry_version_conflict",
            ],
            attemptedEstimator: planned.attemptedEstimator,
            estimatorUsage: planned.estimatorUsage,
            estimatorFailureCode: planned.estimatorFailureCode,
            estimatorFailureDurationMs: planned.estimatorFailureDurationMs,
            registryVersionBefore,
            registryVersionAfter: error.actualVersion,
          });
        }
        return result({
          status: "bypassed",
          reasonCodes: [
            ...runnerReasons,
            "lifecycle_runner_registry_persist_failed",
          ],
          attemptedEstimator: planned.attemptedEstimator,
          estimatorUsage: planned.estimatorUsage,
          estimatorFailureCode: planned.estimatorFailureCode,
          estimatorFailureDurationMs: planned.estimatorFailureDurationMs,
          registryVersionBefore,
          registryVersionAfter: registryVersionBefore,
        });
      }
    }

    return result({
      status: runnerReasons.includes("lifecycle_runner_plan_invalid")
        ? "deferred"
        : planned.status,
      reasonCodes: runnerReasons,
      attemptedEstimator: planned.attemptedEstimator,
      estimatorUsage: planned.estimatorUsage,
      estimatorFailureCode: planned.estimatorFailureCode,
      estimatorFailureDurationMs: planned.estimatorFailureDurationMs,
      registryPersisted,
      registryChanged: planned.registryChanged,
      registryVersionBefore,
      registryVersionAfter: registryPersisted
        ? planned.registry.version
        : registryVersionBefore,
      preparedPlan,
    });
  } catch {
    return result({
      status: "bypassed",
      reasonCodes: ["lifecycle_runner_failed"],
      attemptedEstimator,
      estimatorUsage,
      estimatorFailureCode,
      estimatorFailureDurationMs,
    });
  } finally {
    await lock.release();
  }
}
