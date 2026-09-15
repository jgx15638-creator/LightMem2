import {
  createApiContextCleanRecommendationProvider,
  createContextCleanerControlService,
  createContextCleanerControlPlane,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerControlService,
  type ContextCleanerControlPlane,
  type ContextCleanerHostBridge,
} from "@lightrsi/cleaner";

import type { CleanCommandBackend } from "../clean.js";
import type { CleanPlanView, CleanReceiptView } from "../clean-renderer.js";

type RecommendationConfig = Parameters<typeof createApiContextCleanRecommendationProvider>[0];

function planView(plan: ContextCleanPlan): CleanPlanView {
  return {
    planId: plan.planId,
    hostId: plan.hostId,
    sessionId: plan.sessionId,
    ...(plan.contextWindowTokens !== undefined
      ? { contextWindowTokens: plan.contextWindowTokens }
      : {}),
    usedTokens: plan.usedTokens,
    usedChars: plan.usedChars,
    protectedTokens: plan.protectedTokens,
    protectedChars: plan.protectedChars,
    unassignedTokens: plan.unassignedTokens,
    unassignedChars: plan.unassignedChars,
    tokenCountMode: plan.tokenCountMode,
    tasks: plan.tasks.map((task) => ({
      taskId: task.taskId,
      label: task.label,
      description: task.description,
      lifecycleState: task.lifecycleState,
      tokenCount: task.tokenCount,
      charCount: task.charCount,
      tokenPercent: task.tokenPercent,
      recommendation: task.recommendation,
      reasonCodes: [...task.reasonCodes],
      selectable: task.selectable,
    })),
  };
}

function receiptView(receipt: ContextCleanReceipt): CleanReceiptView {
  return {
    planId: receipt.planId,
    status: receipt.status,
    selectedTaskIds: [...receipt.selectedTaskIds],
    estimatedSavedTokens: receipt.estimatedSavedTokens,
    estimatedSavedChars: receipt.estimatedSavedChars,
    ...(receipt.status === "applied"
      ? {
          appliedSavedTokens: receipt.appliedSavedTokens,
          appliedSavedChars: receipt.appliedSavedChars,
        }
      : {}),
    fallbackUsed: receipt.fallbackUsed,
    deferredTaskIds: [...receipt.deferredTaskIds],
    reasons: [...receipt.reasons],
  };
}

export function createHostCleanCommandBackend(params: {
  stateDir: string;
  createBridge(controlPlane: ContextCleanerControlPlane): ContextCleanerHostBridge;
  recommendationEnabled?: boolean;
  recommendationConfig: RecommendationConfig;
  contextWindowTokens?: number;
  now?: () => string;
}): CleanCommandBackend {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("clean_host_state_dir_missing");
  const controlPlane = createContextCleanerControlPlane({ stateDir, now: params.now });
  const bridge = params.createBridge(controlPlane);
  const provider = params.recommendationEnabled === false
    ? undefined
    : createApiContextCleanRecommendationProvider(params.recommendationConfig);
  const service = createContextCleanerControlService({
    stateDir,
    bridge,
    recommendationProvider: provider,
    contextWindowTokens: params.contextWindowTokens,
    now: params.now,
  });

  return createCleanCommandBackendFromControlService(service);
}

export function createCleanCommandBackendFromControlService(
  service: ContextCleanerControlService,
): CleanCommandBackend {
  return {
    async analyze(sessionId) {
      return planView(await service.analyze(sessionId));
    },
    async readPlan(planId) {
      const plan = await service.readPlan(planId);
      return plan ? planView(plan) : undefined;
    },
    async approve(planId, selectedTaskIds) {
      return receiptView(await service.approve(planId, selectedTaskIds));
    },
    async readReceipt(planId) {
      const receipt = await service.readReceipt(planId);
      return receipt ? receiptView(receipt) : undefined;
    },
    async cancel(planId) {
      return receiptView(await service.cancel(planId));
    },
  };
}
