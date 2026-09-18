import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type CleanerHostCapabilities,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerHostBridge,
  type ContextCleanerSchedulingControlPlane,
  type ContextCleanerScheduleRequest,
} from "./contracts.js";
import { readContextCleanPlan } from "./clean-plan-store.js";
import {
  analyzeContextCleanSession,
} from "./orchestrator.js";
import type { ContextCleanRecommendationProvider } from "./recommendation.js";

export interface ContextCleanerControlService {
  analyze(sessionId: string): Promise<ContextCleanPlan>;
  readPlan(planId: string): Promise<ContextCleanPlan | undefined>;
  approve(
    planId: string,
    selectedTaskIds: readonly string[],
  ): Promise<ContextCleanReceipt>;
  readReceipt(planId: string): Promise<ContextCleanReceipt | undefined>;
  cancel(planId: string): Promise<ContextCleanReceipt>;
}

function storeFailure(operation: string, reasons: string[]): never {
  throw new Error(`${operation}:${reasons.join(",") || "unknown"}`);
}

/**
 * Build a ContextCleanerHostBridge from the frozen one-way capabilities plus
 * the shared control plane (task doc §1.2/1.3). Capability composition uses a
 * two-phase schedule: persist approval, write the Host pointer, then publish
 * the shared scheduled receipt. Existing {bridge} callers are unaffected.
 */
export function composeContextCleanerHostBridge(params: {
  capabilities: CleanerHostCapabilities;
  controlPlane: ContextCleanerSchedulingControlPlane;
}): ContextCleanerHostBridge {
  const { capabilities, controlPlane } = params;
  if (capabilities.hostId !== capabilities.snapshotSource.hostId
    || capabilities.rewriteMode !== capabilities.snapshotSource.rewriteMode) {
    throw new Error("clean_capabilities_identity_mismatch");
  }

  async function abortHostSchedule(
    request: ContextCleanerScheduleRequest,
    receipt: ContextCleanReceipt,
  ): Promise<void> {
    if (receipt.status !== "stale"
      && receipt.status !== "cancelled"
      && receipt.status !== "failed") return;
    const result = await capabilities.scheduleWriter.abortSchedule({
      ...request,
      receiptStatus: receipt.status,
      reasons: receipt.reasons.length > 0
        ? [...receipt.reasons]
        : [`clean_schedule_${receipt.status}`],
      updatedAt: receipt.updatedAt,
    });
    if (result.outcome !== "transitioned" && result.outcome !== "unchanged") {
      throw new Error(
        `clean_schedule_abort_failed:${result.reasons.join(",") || "unknown"}`,
      );
    }
  }

  return {
    hostId: capabilities.hostId,
    rewriteMode: capabilities.rewriteMode,
    listSessions: () => capabilities.sessionCatalog.listSessions(),
    readCleanSnapshot: (sessionId) =>
      capabilities.snapshotSource.readCleanSnapshot(sessionId),
    async executeApprovedClean(request) {
      if (request.hostId !== capabilities.hostId) {
        throw new Error("clean_approval_host_mismatch");
      }
      const approved = await controlPlane.approveCleanSelection(request);
      if (approved.status !== "approved" && approved.status !== "scheduled") {
        return approved;
      }
      const scheduleRequest: ContextCleanerScheduleRequest = {
        sessionId: request.sessionId,
        cleanPlanId: request.cleanPlanId,
        baseRevision: request.baseRevision,
        selectedTaskIds: [...approved.selectedTaskIds],
        scheduledAt: approved.updatedAt,
      };
      const written = await capabilities.scheduleWriter.writeSchedule(scheduleRequest);
      if (written.outcome !== "stored" && written.outcome !== "unchanged") {
        throw new Error(
          `clean_schedule_failed:${written.reasons.join(",") || "unknown"}`,
        );
      }
      const finalized = await controlPlane.finalizeCleanSchedule({
        ...scheduleRequest,
        hostId: request.hostId,
      });
      await abortHostSchedule(scheduleRequest, finalized);
      return finalized;
    },
    readCleanReceipt: (planId) => controlPlane.readCleanReceipt(planId),
    cancelCleanPlan: (planId) => controlPlane.cancelCleanPlan(planId),
  };
}

export function createContextCleanerControlService(params: {
  stateDir: string;
  /** Legacy host bridge. Supply this OR (capabilities + controlPlane). */
  bridge?: ContextCleanerHostBridge;
  /** Frozen one-way capabilities path; requires controlPlane. */
  capabilities?: CleanerHostCapabilities;
  controlPlane?: ContextCleanerSchedulingControlPlane;
  recommendationProvider?: ContextCleanRecommendationProvider;
  contextWindowTokens?: number;
  now?: () => string;
}): ContextCleanerControlService {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("clean_control_state_dir_missing");

  const hasCapabilityPath = params.capabilities !== undefined
    || params.controlPlane !== undefined;
  if (params.bridge && hasCapabilityPath) {
    throw new Error("clean_control_composition_ambiguous");
  }
  if (!params.bridge && (!params.capabilities || !params.controlPlane)) {
    throw new Error("clean_control_bridge_or_capabilities_required");
  }
  const bridge = params.bridge ?? composeContextCleanerHostBridge({
    capabilities: params.capabilities!,
    controlPlane: params.controlPlane!,
  });
  if (!bridge.hostId.trim()) throw new Error("clean_control_host_id_missing");

  async function storedPlan(planId: string): Promise<ContextCleanPlan | undefined> {
    const result = await readContextCleanPlan({ stateDir, planId });
    if (result.bypassed) storeFailure("clean_plan_unavailable", result.reasons);
    const plan = result.value?.plan;
    if (plan && plan.hostId !== bridge.hostId) {
      throw new Error(`clean_plan_host_mismatch:${planId}`);
    }
    return plan;
  }

  function validateReceipt(
    receipt: ContextCleanReceipt,
    plan: ContextCleanPlan,
  ): ContextCleanReceipt {
    if (receipt.planId !== plan.planId
      || receipt.hostId !== bridge.hostId
      || receipt.sessionId !== plan.sessionId) {
      throw new Error(`clean_receipt_identity_mismatch:${plan.planId}`);
    }
    return receipt;
  }

  return {
    async analyze(sessionId) {
      const result = await analyzeContextCleanSession({
        stateDir,
        bridge,
        sessionId,
        provider: params.recommendationProvider,
        contextWindowTokens: params.contextWindowTokens,
      });
      return result.plan;
    },
    readPlan(planId) {
      return storedPlan(planId);
    },
    async approve(planId, selectedTaskIds) {
      const plan = await storedPlan(planId);
      if (!plan) throw new Error(`clean_plan_missing:${planId}`);
      if (new Set(selectedTaskIds).size !== selectedTaskIds.length) {
        throw new Error("clean_selection_duplicate_task");
      }
      const tasksById = new Map(plan.tasks.map((task) => [task.taskId, task]));
      const selectedTasks = selectedTaskIds.map((taskId) => {
        const task = tasksById.get(taskId);
        if (!task) throw new Error(`clean_selection_unknown_task:${taskId}`);
        if (!task.selectable) {
          throw new Error(`clean_selection_task_protected:${taskId}`);
        }
        return {
          taskId,
          itemIds: [...task.itemIds],
          itemDigests: { ...task.itemDigests },
        };
      });
      const receipt = await bridge.executeApprovedClean({
        schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
        cleanPlanId: plan.planId,
        hostId: plan.hostId,
        sessionId: plan.sessionId,
        baseRevision: plan.baseRevision,
        approvedAt: params.now?.() ?? new Date().toISOString(),
        selectedTasks,
      });
      return validateReceipt(receipt, plan);
    },
    async readReceipt(planId) {
      const plan = await storedPlan(planId);
      if (!plan) return undefined;
      const receipt = await bridge.readCleanReceipt(planId);
      return receipt ? validateReceipt(receipt, plan) : undefined;
    },
    async cancel(planId) {
      const plan = await storedPlan(planId);
      if (!plan) throw new Error(`clean_plan_missing:${planId}`);
      return validateReceipt(await bridge.cancelCleanPlan(planId), plan);
    },
  };
}
