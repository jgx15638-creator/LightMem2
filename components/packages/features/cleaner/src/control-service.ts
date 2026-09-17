import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type CleanerHostCapabilities,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerControlPlane,
  type ContextCleanerHostBridge,
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
 * the shared control plane (task doc §1.2/1.3). This reproduces exactly what a
 * host bridge's executeApprovedClean did — run the shared plan-store execute,
 * then, on a "scheduled" receipt, write the host schedule pointer — but drives
 * the host side through the pure capability operations. Existing {bridge}
 * callers are unaffected; this is the additive capabilities path only.
 */
export function composeContextCleanerHostBridge(params: {
  capabilities: CleanerHostCapabilities;
  controlPlane: ContextCleanerControlPlane;
}): ContextCleanerHostBridge {
  const { capabilities, controlPlane } = params;
  return {
    hostId: capabilities.hostId,
    rewriteMode: capabilities.rewriteMode,
    listSessions: () => capabilities.sessionCatalog.listSessions(),
    readCleanSnapshot: (sessionId) =>
      capabilities.snapshotSource.readCleanSnapshot(sessionId),
    async executeApprovedClean(request) {
      const receipt = await controlPlane.executeApprovedClean(request);
      if (receipt.status === "scheduled") {
        const written = await capabilities.scheduleWriter.writeSchedule({
          sessionId: request.sessionId,
          cleanPlanId: request.cleanPlanId,
          baseRevision: request.baseRevision,
          selectedTaskIds: request.selectedTasks.map((task) => task.taskId),
          scheduledAt: receipt.updatedAt,
        });
        if (written.outcome !== "stored" && written.outcome !== "unchanged") {
          throw new Error(
            `clean_schedule_failed:${written.reasons.join(",") || "unknown"}`,
          );
        }
      }
      return receipt;
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
  controlPlane?: ContextCleanerControlPlane;
  recommendationProvider?: ContextCleanRecommendationProvider;
  contextWindowTokens?: number;
  now?: () => string;
}): ContextCleanerControlService {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("clean_control_state_dir_missing");

  const bridge = params.bridge
    ?? (params.capabilities && params.controlPlane
      ? composeContextCleanerHostBridge({
        capabilities: params.capabilities,
        controlPlane: params.controlPlane,
      })
      : undefined);
  if (!bridge) throw new Error("clean_control_bridge_or_capabilities_required");

  async function storedPlan(planId: string): Promise<ContextCleanPlan | undefined> {
    const result = await readContextCleanPlan({ stateDir, planId });
    if (result.bypassed) storeFailure("clean_plan_unavailable", result.reasons);
    return result.value?.plan;
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
      return bridge.executeApprovedClean({
        schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
        cleanPlanId: plan.planId,
        hostId: plan.hostId,
        sessionId: plan.sessionId,
        baseRevision: plan.baseRevision,
        approvedAt: params.now?.() ?? new Date().toISOString(),
        selectedTasks,
      });
    },
    readReceipt(planId) {
      return bridge.readCleanReceipt(planId);
    },
    cancel(planId) {
      return bridge.cancelCleanPlan(planId);
    },
  };
}
