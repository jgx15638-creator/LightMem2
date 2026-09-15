import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanPlan,
  type ContextCleanReceipt,
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

export function createContextCleanerControlService(params: {
  stateDir: string;
  bridge: ContextCleanerHostBridge;
  recommendationProvider?: ContextCleanRecommendationProvider;
  contextWindowTokens?: number;
  now?: () => string;
}): ContextCleanerControlService {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("clean_control_state_dir_missing");

  async function storedPlan(planId: string): Promise<ContextCleanPlan | undefined> {
    const result = await readContextCleanPlan({ stateDir, planId });
    if (result.bypassed) storeFailure("clean_plan_unavailable", result.reasons);
    return result.value?.plan;
  }

  return {
    async analyze(sessionId) {
      const result = await analyzeContextCleanSession({
        stateDir,
        bridge: params.bridge,
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
      return params.bridge.executeApprovedClean({
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
      return params.bridge.readCleanReceipt(planId);
    },
    cancel(planId) {
      return params.bridge.cancelCleanPlan(planId);
    },
  };
}
