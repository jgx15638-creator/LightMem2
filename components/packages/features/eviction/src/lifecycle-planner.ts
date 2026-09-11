import {
  applySessionTaskRegistryPatch,
  type DeltaView,
  type HistoryBlock,
  type SessionTaskRegistry,
} from "@lightrsi/history";
import type {
  ContextMutationPlan,
  ModelContextSnapshot,
} from "@lightrsi/host-adapter";
import { MODEL_CONTEXT_REWRITE_SCHEMA_VERSION } from "@lightrsi/host-adapter";

import { buildContextMutationPlanFromEviction } from "./context-mutation-plan.js";
import { analyzeEvictionFromTaskRegistry } from "./planning/analyzer.js";
import {
  mapTaskUpdatesToRegistryPatch,
  type RejectedTaskUpdate,
} from "./task-update-mapper.js";
import type {
  EvictionDecision,
  EvictionPolicy,
  TaskStateEstimator,
  TaskStateEstimatorOutput,
  TaskStateTransition,
} from "./types.js";

export type LifecyclePlannerStatus = "completed" | "deferred" | "bypassed";

export type LifecyclePlannerReasonCode =
  | "planner_disabled"
  | "estimator_missing"
  | "insufficient_pending_turns"
  | "duplicate_estimator_window"
  | "empty_delta_window"
  | "planner_input_invalid"
  | "session_mismatch"
  | "estimator_failed"
  | "estimator_output_invalid"
  | "base_version_mismatch"
  | "task_update_turn_out_of_scope"
  | "task_updates_rejected"
  | "registry_updated"
  | "registry_watermark_advanced"
  | "no_eviction_candidates"
  | "mutation_plan_deferred"
  | "mutation_plan_created";

export type LifecyclePlannerConfig = {
  enabled: boolean;
  batchTurns: number;
  evictionEnabled: boolean;
  evictionPolicy: EvictionPolicy;
  evictionMinBlockChars?: number;
};

export type LifecyclePlannerInput<TAdapterMetadata = never> = {
  registry: SessionTaskRegistry;
  delta: DeltaView;
  pendingTurnCount: number;
  duplicateWindow?: boolean;
  estimator?: TaskStateEstimator | null;
  historyBlocks: HistoryBlock[];
  snapshot: ModelContextSnapshot<TAdapterMetadata>;
  stableItemIdsByMessageId?: Readonly<Record<string, readonly string[]>>;
  activeTaskIds?: string[];
  currentTaskIds?: string[];
  currentTurnAbsId?: string;
  closureDeferredTaskIds?: string[];
  config: LifecyclePlannerConfig;
  createdAt: string;
  sourcePresetId?: string;
};

export type LifecyclePlannerResult = {
  status: LifecyclePlannerStatus;
  reasonCodes: LifecyclePlannerReasonCode[];
  registry: SessionTaskRegistry;
  expectedRegistryVersion: number;
  registryChanged: boolean;
  registryUpdateRequired: boolean;
  attemptedEstimator: boolean;
  transitions: TaskStateTransition[];
  rejectedUpdates: RejectedTaskUpdate[];
  decision?: EvictionDecision;
  plan?: ContextMutationPlan;
  deferredBlockIds: string[];
  estimatorUsage?: TaskStateEstimatorOutput["usage"];
  estimatorFailureCode?: string;
  estimatorFailureDurationMs?: number;
};

function estimatorFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "request_timeout";
  const message = error instanceof Error ? error.message : "";
  const http = message.match(/^(responses_api_failed|chat_completions_failed):(\d{3})$/);
  if (http) return `${http[1] === "responses_api_failed" ? "responses" : "chat_completions"}_http_${http[2]}`;
  if (message === "task_state_estimator_empty_response") return "response_empty";
  if (message === "task_state_estimator_invalid_json") return "response_invalid_json";
  if (message === "task_state_estimator_missing_base_version") return "response_missing_base_version";
  if (message === "task_state_estimator_missing_task_updates") return "response_missing_task_updates";
  if (error instanceof TypeError) return "network_error";
  return "unknown";
}

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function baseResult(
  input: LifecyclePlannerInput<unknown>,
  status: LifecyclePlannerStatus,
  reasonCodes: LifecyclePlannerReasonCode[],
  attemptedEstimator = false,
): LifecyclePlannerResult {
  return {
    status,
    reasonCodes,
    registry: input.registry,
    expectedRegistryVersion: input.registry.version,
    registryChanged: false,
    registryUpdateRequired: false,
    attemptedEstimator,
    transitions: [],
    rejectedUpdates: [],
    deferredBlockIds: [],
  };
}

function validEstimatorOutput(value: unknown): value is TaskStateEstimatorOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Partial<TaskStateEstimatorOutput>;
  if (
    !Number.isInteger(output.baseVersion)
    || (output.baseVersion ?? -1) < 0
    || !Array.isArray(output.taskUpdates)
  ) return false;
  const optionalStringArray = (value: unknown): boolean =>
    value === undefined
    || (Array.isArray(value) && value.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    ));
  const optionalString = (value: unknown): boolean =>
    value === undefined || typeof value === "string";
  const taskIds = new Set<string>();
  const updatesValid = output.taskUpdates.every((update) => {
    if (!update || typeof update !== "object" || Array.isArray(update)) return false;
    if (
      typeof update.taskId !== "string"
      || !update.taskId.trim()
      || taskIds.has(update.taskId.trim())
    ) return false;
    taskIds.add(update.taskId.trim());
    return typeof update.objective === "string"
      && update.objective.trim().length > 0
      && ["active", "blocked", "completed", "evictable"].includes(update.lifecycle)
      && optionalStringArray(update.coveredTurnAbsIds)
      && optionalStringArray(update.completionEvidence)
      && optionalStringArray(update.unresolvedQuestions)
      && optionalString(update.title)
      && optionalString(update.currentSubgoal)
      && optionalString(update.evictableReason);
  });
  if (!updatesValid) return false;
  if (output.usage === undefined) return true;
  const usage = output.usage as Partial<NonNullable<TaskStateEstimatorOutput["usage"]>>;
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(
    (entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0,
  ) && (
    usage.costUsd === undefined
    || (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0)
  );
}

function canonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validPlannerEnvelope(input: LifecyclePlannerInput<unknown>): boolean {
  const { delta, registry, snapshot } = input;
  const stableIds = snapshot.items.map((item) => item.stableId);
  return Number.isInteger(registry.version)
    && registry.version >= 0
    && Number.isInteger(registry.lastProcessedTurnSeq)
    && registry.lastProcessedTurnSeq >= 0
    && Number.isInteger(delta.fromTurnSeqExclusive)
    && delta.fromTurnSeqExclusive >= 0
    && delta.fromTurnSeqExclusive === registry.lastProcessedTurnSeq
    && Number.isInteger(delta.toTurnSeqInclusive)
    && delta.toTurnSeqInclusive > delta.fromTurnSeqExclusive
    && snapshot.schemaVersion === MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
    && snapshot.hostId.trim().length > 0
    && snapshot.sessionId.trim().length > 0
    && snapshot.revision.trim().length > 0
    && stableIds.length === new Set(stableIds).size
    && snapshot.items.every(
      (item) => item.stableId.trim().length > 0 && item.fingerprint.trim().length > 0,
    )
    && canonicalTimestamp(input.createdAt);
}

function blockTaskIds(block: HistoryBlock, registry: SessionTaskRegistry): string[] {
  const direct = uniqueStrings(block.taskIds ?? []);
  if (direct.length > 0) return direct;
  const byTurns = uniqueStrings(
    (block.turnAbsIds ?? []).flatMap((turnId) => registry.turnToTaskIds[turnId] ?? []),
  );
  if (byTurns.length > 0) return byTurns;
  return uniqueStrings([
    ...(registry.blockToTaskIds[block.blockId] ?? []),
    ...block.segmentIds.flatMap((segmentId) => registry.blockToTaskIds[segmentId] ?? []),
  ]);
}

function protectedTaskIds(input: LifecyclePlannerInput<unknown>, registry: SessionTaskRegistry): Set<string> {
  return new Set(uniqueStrings([
    ...input.registry.activeTaskIds,
    ...registry.activeTaskIds,
    ...Object.values(registry.tasks)
      .filter((task) => task.lifecycle === "blocked" || task.unresolvedQuestions.length > 0)
      .map((task) => task.taskId),
    ...(input.activeTaskIds ?? []),
    ...(input.currentTaskIds ?? []),
    ...(input.closureDeferredTaskIds ?? []),
  ]));
}

function safeHistoryBlocks(
  input: LifecyclePlannerInput<unknown>,
  registry: SessionTaskRegistry,
): HistoryBlock[] {
  const protectedIds = protectedTaskIds(input, registry);
  const currentTurnAbsId = input.currentTurnAbsId?.trim();
  return input.historyBlocks.filter(
    (block) => !(currentTurnAbsId && block.turnAbsIds?.includes(currentTurnAbsId))
      && !blockTaskIds(block, registry).some((taskId) => protectedIds.has(taskId)),
  );
}

function taskStateChanged(
  before: SessionTaskRegistry,
  after: SessionTaskRegistry,
): boolean {
  return JSON.stringify({
    tasks: before.tasks,
    activeTaskIds: before.activeTaskIds,
    completedTaskIds: before.completedTaskIds,
    evictableTaskIds: before.evictableTaskIds,
    turnToTaskIds: before.turnToTaskIds,
  }) !== JSON.stringify({
    tasks: after.tasks,
    activeTaskIds: after.activeTaskIds,
    completedTaskIds: after.completedTaskIds,
    evictableTaskIds: after.evictableTaskIds,
    turnToTaskIds: after.turnToTaskIds,
  });
}

/**
 * Runs the Host-neutral estimator-to-plan lifecycle. The caller owns history
 * loading, duplicate-window persistence, registry CAS, tracing, and mutation
 * execution. This function performs no I/O and fails closed to no plan.
 */
export async function planLifecycleEviction<TAdapterMetadata = never>(
  input: LifecyclePlannerInput<TAdapterMetadata>,
): Promise<LifecyclePlannerResult> {
  if (!input.config.enabled) {
    return baseResult(input, "bypassed", ["planner_disabled"]);
  }
  if (!input.estimator) {
    return baseResult(input, "bypassed", ["estimator_missing"]);
  }
  if (
    !Number.isFinite(input.config.batchTurns)
    || input.config.batchTurns < 1
    || !Number.isInteger(input.pendingTurnCount)
    || input.pendingTurnCount < 0
    || !validPlannerEnvelope(input)
  ) {
    return baseResult(input, "bypassed", ["planner_input_invalid"]);
  }
  const batchTurns = Math.floor(input.config.batchTurns);
  if (input.pendingTurnCount < batchTurns) {
    return baseResult(input, "deferred", ["insufficient_pending_turns"]);
  }
  if (input.duplicateWindow) {
    return baseResult(input, "deferred", ["duplicate_estimator_window"]);
  }
  if (input.delta.coveredTurnAbsIds.length === 0) {
    return baseResult(input, "deferred", ["empty_delta_window"]);
  }
  if (
    input.registry.sessionId !== input.snapshot.sessionId
    || input.delta.coveredTurnAbsIds.some(
      (turnId) => !turnId.startsWith(`${input.registry.sessionId}:t`),
    )
  ) {
    return baseResult(input, "bypassed", ["session_mismatch"]);
  }

  let output: unknown;
  const estimatorStartedAt = Date.now();
  try {
    output = await input.estimator.estimate({
      registry: input.registry,
      delta: input.delta,
    });
  } catch (error) {
    return {
      ...baseResult(input, "bypassed", ["estimator_failed"], true),
      estimatorFailureCode: estimatorFailureCode(error),
      estimatorFailureDurationMs: Math.max(0, Date.now() - estimatorStartedAt),
    };
  }
  if (!validEstimatorOutput(output)) {
    return {
      ...baseResult(input, "bypassed", ["estimator_output_invalid"], true),
      estimatorFailureCode: "response_schema_invalid",
      estimatorFailureDurationMs: Math.max(0, Date.now() - estimatorStartedAt),
    };
  }
  if (output.baseVersion !== input.registry.version) {
    const result = baseResult(input, "deferred", ["base_version_mismatch"], true);
    return { ...result, estimatorUsage: output.usage };
  }

  const coveredTurnAbsIds = new Set(input.delta.coveredTurnAbsIds);
  if (output.taskUpdates.some((update) =>
    (update.coveredTurnAbsIds ?? []).some(
      (turnAbsId) => !coveredTurnAbsIds.has(turnAbsId),
    ))) {
    const result = baseResult(
      input,
      "deferred",
      ["task_update_turn_out_of_scope"],
      true,
    );
    return { ...result, estimatorUsage: output.usage };
  }

  const mapped = mapTaskUpdatesToRegistryPatch({
    registry: input.registry,
    updates: output.taskUpdates,
    coveredTurnAbsIds: input.delta.coveredTurnAbsIds,
    toTurnSeqInclusive: input.delta.toTurnSeqInclusive,
  });
  if (mapped.rejectedUpdates.length > 0) {
    const result = baseResult(input, "deferred", ["task_updates_rejected"], true);
    return {
      ...result,
      rejectedUpdates: mapped.rejectedUpdates,
      estimatorUsage: output.usage,
    };
  }
  if (mapped.transitions.length !== output.taskUpdates.length) {
    const result = baseResult(input, "deferred", ["estimator_output_invalid"], true);
    return { ...result, estimatorUsage: output.usage };
  }

  const registry = applySessionTaskRegistryPatch(input.registry, mapped.patch);
  const registryChanged = taskStateChanged(input.registry, registry);
  const reasonCodes: LifecyclePlannerReasonCode[] = [
    registryChanged ? "registry_updated" : "registry_watermark_advanced",
  ];
  const decision = analyzeEvictionFromTaskRegistry(
    safeHistoryBlocks(input, registry),
    registry,
    {
      enabled: input.config.evictionEnabled,
      policy: input.config.evictionPolicy,
      minBlockChars: input.config.evictionMinBlockChars,
    },
  );
  const built = buildContextMutationPlanFromEviction({
    decision,
    registry,
    snapshot: input.snapshot,
    stableItemIdsByMessageId: input.stableItemIdsByMessageId,
    createdAt: input.createdAt,
    sourcePresetId: input.sourcePresetId,
  });
  if (built.plan) {
    reasonCodes.push("mutation_plan_created");
  } else if (built.deferredBlockIds.length > 0) {
    reasonCodes.push("mutation_plan_deferred");
  } else {
    reasonCodes.push("no_eviction_candidates");
  }

  return {
    status: "completed",
    reasonCodes,
    registry,
    expectedRegistryVersion: input.registry.version,
    registryChanged,
    registryUpdateRequired: true,
    attemptedEstimator: true,
    transitions: mapped.transitions,
    rejectedUpdates: [],
    decision,
    plan: built.plan,
    deferredBlockIds: built.deferredBlockIds,
    estimatorUsage: output.usage,
  };
}
