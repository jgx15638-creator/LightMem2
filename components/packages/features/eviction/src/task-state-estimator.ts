import type {
  SemanticTaskUpdate,
  TaskStateEstimator,
  TaskStateEstimatorApiConfig,
  TaskStateEstimatorInput,
  TaskStateEstimatorOutput,
} from "./types.js";
import { createApiJsonModelClient } from "./json-model-client.js";

function truncateText(value: string, maxChars = 600): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))];
}

function buildSystemPrompt(
  config: Required<Pick<TaskStateEstimatorApiConfig, "evictionLookaheadTurns" | "lifecycleMode" | "evidenceMode">>,
): string {
  const coupled = config.lifecycleMode === "coupled";
  const threeState = config.evidenceMode !== "two_state";
  return [
    "You are a task-state estimator for a long-running agent session.",
    "Your job is to update global task state incrementally.",
    "You must only return a JSON object.",
    "Do not output a full registry.",
    "You must return only a semantic delta, not a registry patch.",
    "The input is incremental, but the task registry is global.",
    "Each update may modify the lifecycle of any existing task in the session, including older tasks that are not directly covered by the newest delta.",
    "You must backfill task ownership for every covered turn in the delta window.",
    "Never invent turn ids that are not present in the provided delta.",
    "When the newest covered turn contains a new top-level user request, you must decide whether it starts a new task.",
    "If the newest user request is materially different from the objective of the current active task, create a new task update anchored to the first covered turn of that new request instead of extending the old task.",
    "If a newer top-level user request starts a different task, do not keep an older unrelated one-shot task active.",
    ...(coupled
      ? [
          "When an older task already has delivery evidence, no unresolved questions, and is not covered by the current delta, you may mark it evictable instead of leaving it active.",
          "When the hints include evictableCandidateTaskIds and the newest covered turn clearly starts or finishes a different task, you should usually emit lifecycle-only updates that mark those candidate tasks evictable in the same response.",
          "Do not wait for another future turn to mark an obviously finished older task evictable once a newer distinct task has already taken over the session.",
          "Never mark a task evictable unless it is already completed or you are simultaneously providing clear completionEvidence.",
          "Never use evictable for a task that still lacks completion evidence, still has unresolved questions, or is obviously in progress.",
          "Use completed only when the task is finished but still likely to be referenced again immediately. Use evictable only when the task is finished, has completionEvidence, has no unresolved questions, and the session has already moved on to a different task.",
        ]
      : [
          "Your job is only task progression classification, not cache replacement.",
          "Only decide whether each task is active, blocked, or completed.",
          "Do not decide eviction timing.",
          "Never output lifecycle=evictable; eviction will be decided separately by the system.",
          "Use completed when a task is finished and has delivery evidence, even if it may later be evicted by a separate policy layer.",
        ]),
    "Prefer one task per distinct user request unless the new request is clearly just a continuation or clarification of the same objective.",
    "For a newly created task, use a stable taskId derived from the first covered turn, typically `<firstTurnAbsId>` or `<firstTurnAbsId>-task`.",
    "Output schema must be exactly:",
    "{\"baseVersion\": number, \"taskUpdates\": SemanticTaskUpdate[]}.",
    "SemanticTaskUpdate must use exactly these fields:",
    coupled
      ? "{\"taskId\": string, \"title\"?: string, \"objective\": string, \"lifecycle\": \"active\"|\"blocked\"|\"completed\"|\"evictable\", \"coveredTurnAbsIds\"?: string[], \"completionEvidence\"?: string[], \"unresolvedQuestions\"?: string[], \"currentSubgoal\"?: string, \"evictableReason\"?: string}."
      : "{\"taskId\": string, \"title\"?: string, \"objective\": string, \"lifecycle\": \"active\"|\"blocked\"|\"completed\", \"coveredTurnAbsIds\"?: string[], \"completionEvidence\"?: string[], \"unresolvedQuestions\"?: string[], \"currentSubgoal\"?: string}.",
    "coveredTurnAbsIds is required when creating a new task or extending task ownership to new turns.",
    "coveredTurnAbsIds may be omitted or empty for lifecycle-only updates on existing tasks.",
    "If lifecycle is completed or evictable, include completionEvidence unless the existing registry entry already has strong completion evidence.",
    ...(coupled ? ["If lifecycle is evictable, include evictableReason as one short sentence."] : []),
    "Do not output registry patch fields such as upsertTasks, activeTaskIds, completedTaskIds, evictableTaskIds, upsertTurnToTaskIds, transitions, span, or lastProcessedTurnSeq.",
    "Do not use alternate field names such as status, description, action, fromTurnSeq, toTurnSeq, task_created, or task_progressed.",
    ...(threeState
      ? [
          "The delta may include completedTaskSummaries when older completed tasks have been compressed out of the active estimator context.",
          "Treat completedTaskSummaries as stable background memory and prefer keeping the currently unresolved task as one continuous task unless the newest user request clearly starts a new objective.",
        ]
      : [
          "Do not rely on completedTaskSummaries or retained completion evidence from prior tasks; classify each new task only from the current delta and registry state.",
        ]),
  ].join(" ");
}

function buildDerivedHints(input: TaskStateEstimatorInput): Record<string, unknown> {
  const coveredTurnAbsIds = uniqueStrings(input.delta.coveredTurnAbsIds ?? []);
  const coveredTurnSet = new Set(coveredTurnAbsIds);
  const deltaUserMessages = input.delta.messages.filter((message) => message.role === "user");
  const newestUserMessage = deltaUserMessages.at(-1);
  const newestUserTurnAbsId = newestUserMessage?.anchor.turnAbsId;
  const newestUserTurnSeq = newestUserMessage?.anchor.turnSeq;
  const previousActiveTaskIds = uniqueStrings(input.registry.activeTaskIds ?? []);

  const taskHints = Object.values(input.registry.tasks).map((task) => {
    const supportingTurnAbsIds = uniqueStrings(task.span?.supportingTurnAbsIds ?? []);
    const coveredByDelta = supportingTurnAbsIds.filter((turnAbsId) => coveredTurnSet.has(turnAbsId));
    const lastTaskTurnAbsId = task.span?.lastTurnAbsId;
    const lastTaskTurnSeq = typeof lastTaskTurnAbsId === "string"
      ? Number(lastTaskTurnAbsId.split(":t").at(-1) ?? Number.NaN)
      : Number.NaN;
    const turnsSinceLastTaskTurn = Number.isFinite(lastTaskTurnSeq) && typeof newestUserTurnSeq === "number"
      ? Math.max(0, newestUserTurnSeq - lastTaskTurnSeq)
      : undefined;
    const unresolvedQuestions = Array.isArray(task.unresolvedQuestions) ? task.unresolvedQuestions : [];
    const completionEvidence = Array.isArray(task.completionEvidence) ? task.completionEvidence : [];
    const objective = task.objective ?? "";
    const title = task.title ?? "";
    const artifactLikeObjective =
      /\b(write|create|draft|summarize|summary|report|email|triage|plan|analysis|stock|pdf|spreadsheet|sheet|document)\b/i
        .test(`${title}\n${objective}`);
    return {
      taskId: task.taskId,
      lifecycle: task.lifecycle,
      title,
      objective: truncateText(objective, 240),
      isCoveredInDelta: coveredByDelta.length > 0,
      coveredTurnAbsIdsInDelta: coveredByDelta,
      lastTurnAbsId: lastTaskTurnAbsId,
      turnsSinceLastTaskTurn,
      completionEvidenceCount: completionEvidence.length,
      hasCompletionEvidence: completionEvidence.length > 0,
      unresolvedQuestionCount: unresolvedQuestions.length,
      hasUnresolvedQuestions: unresolvedQuestions.length > 0,
      artifactLikeObjective,
      wasPreviouslyActive: previousActiveTaskIds.includes(task.taskId),
    };
  });
  const evictableCandidateTaskIds = taskHints
    .filter((task) =>
      task.lifecycle === "completed"
      && !task.isCoveredInDelta
      && task.hasCompletionEvidence
      && !task.hasUnresolvedQuestions
      && typeof task.turnsSinceLastTaskTurn === "number"
      && task.turnsSinceLastTaskTurn >= 1
    )
    .map((task) => task.taskId);

  return {
    deltaInputMode: input.delta.inputMode ?? "sliding_window",
    newestCoveredUserTurnAbsId: newestUserTurnAbsId,
    newestCoveredUserText: newestUserMessage ? truncateText(newestUserMessage.text, 400) : undefined,
    deltaMessageCount: input.delta.messages.length,
    deltaToolCallCount: input.delta.toolCalls.length,
    deltaToolResultCount: input.delta.toolResults.length,
    completedTaskSummaryCount: Array.isArray(input.delta.completedTaskSummaries)
      ? input.delta.completedTaskSummaries.length
      : 0,
    coveredTurnAbsIds,
    previousActiveTaskIds,
    evictableCandidateTaskIds,
    existingTaskHints: taskHints,
  };
}

function filterRegistryForEvidenceMode(
  registry: TaskStateEstimatorInput["registry"],
  evidenceMode: "three_state" | "two_state",
): TaskStateEstimatorInput["registry"] {
  if (evidenceMode !== "two_state") return registry;
  const keptTaskIds = new Set(
    Object.values(registry.tasks)
      .filter((task) => task.lifecycle !== "completed" && task.lifecycle !== "evictable")
      .map((task) => task.taskId),
  );
  const filterTaskArray = (values: string[] | undefined): string[] =>
    Array.isArray(values)
      ? values.filter((taskId) => typeof taskId === "string" && keptTaskIds.has(taskId))
      : [];
  const filterTaskMap = (map: Record<string, string[]> | undefined): Record<string, string[]> => {
    if (!map || typeof map !== "object") return {};
    const next: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(map)) {
      if (!keptTaskIds.has(key)) continue;
      next[key] = Array.isArray(values)
        ? values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
    }
    return next;
  };
  const filterBlockMap = (map: Record<string, string[]> | undefined): Record<string, string[]> => {
    if (!map || typeof map !== "object") return {};
    const next: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(map)) {
      const filtered = Array.isArray(values)
        ? values.filter((taskId): taskId is string => typeof taskId === "string" && keptTaskIds.has(taskId))
        : [];
      if (filtered.length > 0) next[key] = filtered;
    }
    return next;
  };
  return {
    ...registry,
    tasks: Object.fromEntries(
      Object.entries(registry.tasks).filter(([, task]) => task.lifecycle !== "completed" && task.lifecycle !== "evictable"),
    ),
    activeTaskIds: filterTaskArray(registry.activeTaskIds),
    completedTaskIds: [],
    evictableTaskIds: [],
    taskToBlockIds: filterTaskMap(registry.taskToBlockIds),
    blockToTaskIds: filterBlockMap(registry.blockToTaskIds),
    turnToTaskIds: filterBlockMap(registry.turnToTaskIds),
  };
}

function buildUserPayload(
  input: TaskStateEstimatorInput,
  evidenceMode: "three_state" | "two_state",
): string {
  const filteredRegistry = filterRegistryForEvidenceMode(input.registry, evidenceMode);
  const filteredDelta =
    evidenceMode === "two_state"
      ? {
          ...input.delta,
          completedTaskSummaries: [],
        }
      : input.delta;
  const filteredInput: TaskStateEstimatorInput = {
    registry: filteredRegistry,
    delta: filteredDelta,
  };
  const hints = buildDerivedHints(filteredInput);
  return JSON.stringify({
    registry: filteredRegistry,
    delta: filteredDelta,
    hints,
  });
}

function stringField(
  update: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = update[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stringArrayField(
  update: Record<string, unknown>,
  names: string[],
): string[] | undefined {
  for (const name of names) {
    const value = update[name];
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) {
      return uniqueStrings(
        value.filter((entry): entry is string => typeof entry === "string"),
      );
    }
  }
  return undefined;
}

function normalizeLifecycle(value: unknown): SemanticTaskUpdate["lifecycle"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["active", "in_progress", "ongoing", "open", "pending", "protected", "keep"].includes(normalized)) {
    return "active";
  }
  if (["blocked", "waiting", "waiting_for_approval", "pending_approval", "on_hold"].includes(normalized)) {
    return "blocked";
  }
  if (["completed", "complete", "done", "finished"].includes(normalized)) {
    return "completed";
  }
  if (["evictable", "evict", "clean", "removable", "releasable"].includes(normalized)) {
    return "evictable";
  }
  return undefined;
}

function coveredTurnFallback(
  taskId: string,
  input: TaskStateEstimatorInput,
): string[] {
  const taskIdMatch = input.delta.coveredTurnAbsIds.find(
    (turnAbsId) => taskId === turnAbsId || taskId.startsWith(`${turnAbsId}-`) || taskId.startsWith(`${turnAbsId}:`),
  );
  if (taskIdMatch) return [taskIdMatch];
  if (input.delta.coveredTurnAbsIds.length === 1) return [...input.delta.coveredTurnAbsIds];
  return [];
}

function normalizeTaskUpdate(
  value: unknown,
  input: TaskStateEstimatorInput,
): SemanticTaskUpdate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const update = value as Record<string, unknown>;
  const taskId = stringField(update, ["taskId", "task_id", "id"]);
  if (!taskId) return undefined;

  const previous = input.registry.tasks[taskId];
  const title = stringField(update, ["title", "taskTitle", "task_title"]);
  const currentSubgoal = stringField(update, ["currentSubgoal", "current_subgoal", "subgoal"]);
  const rawCompletionEvidence = stringArrayField(update, [
    "completionEvidence",
    "completion_evidence",
    "evidence",
  ]);
  const unresolvedQuestions = stringArrayField(update, [
    "unresolvedQuestions",
    "unresolved_questions",
    "openQuestions",
    "open_questions",
  ]);
  const lifecycle = normalizeLifecycle(
    update.lifecycle ?? update.status ?? update.state ?? update.action,
  ) ?? (
    (rawCompletionEvidence?.length ?? 0) > 0
      ? "completed"
      : (unresolvedQuestions?.length ?? 0) > 0
        ? "blocked"
        : "active"
  );
  const allowedTurnIds = new Set(input.delta.coveredTurnAbsIds);
  const rawCoveredTurnAbsIds = stringArrayField(update, [
    "coveredTurnAbsIds",
    "covered_turn_abs_ids",
    "turnAbsIds",
    "turn_abs_ids",
    "turnIds",
    "turn_ids",
  ]);
  let coveredTurnAbsIds = uniqueStrings(rawCoveredTurnAbsIds ?? [])
    .filter((turnAbsId) => allowedTurnIds.has(turnAbsId));
  if (coveredTurnAbsIds.length === 0 && !previous) {
    coveredTurnAbsIds = coveredTurnFallback(taskId, input);
  }
  const coveredUserObjective = input.delta.messages.find(
    (message) => message.role === "user" && coveredTurnAbsIds.includes(message.anchor.turnAbsId),
  )?.text.trim();
  const objective = stringField(update, ["objective", "description", "task", "summary"])
    ?? previous?.objective
    ?? title
    ?? currentSubgoal
    ?? coveredUserObjective
    ?? "";

  let completionEvidence = rawCompletionEvidence;
  if (
    (lifecycle === "completed" || lifecycle === "evictable")
    && (completionEvidence?.length ?? 0) === 0
    && !previous?.completionEvidence?.length
  ) {
    const deliveredTurn = input.delta.messages.find(
      (message) => message.role === "assistant" && coveredTurnAbsIds.includes(message.anchor.turnAbsId),
    )?.anchor.turnAbsId;
    if (deliveredTurn) completionEvidence = [`Assistant response recorded for ${deliveredTurn}`];
  }

  return {
    taskId,
    ...(title ? { title } : {}),
    objective,
    lifecycle,
    ...(coveredTurnAbsIds.length > 0 ? { coveredTurnAbsIds } : {}),
    ...(completionEvidence ? { completionEvidence } : {}),
    ...(unresolvedQuestions ? { unresolvedQuestions } : {}),
    ...(currentSubgoal ? { currentSubgoal } : {}),
    ...(stringField(update, ["evictableReason", "evictable_reason", "reason"])
      ? { evictableReason: stringField(update, ["evictableReason", "evictable_reason", "reason"])! }
      : {}),
  };
}

function mergeTaskUpdates(updates: SemanticTaskUpdate[]): SemanticTaskUpdate[] {
  const merged = new Map<string, SemanticTaskUpdate>();
  for (const update of updates) {
    const previous = merged.get(update.taskId);
    if (!previous) {
      merged.set(update.taskId, update);
      continue;
    }
    merged.set(update.taskId, {
      ...previous,
      ...update,
      coveredTurnAbsIds: uniqueStrings([
        ...(previous.coveredTurnAbsIds ?? []),
        ...(update.coveredTurnAbsIds ?? []),
      ]),
      completionEvidence: uniqueStrings([
        ...(previous.completionEvidence ?? []),
        ...(update.completionEvidence ?? []),
      ]),
      unresolvedQuestions: uniqueStrings(
        update.unresolvedQuestions ?? previous.unresolvedQuestions ?? [],
      ),
    });
  }
  return [...merged.values()];
}

function normalizeEstimatorOutput(
  parsed: Record<string, unknown>,
  input: TaskStateEstimatorInput,
): TaskStateEstimatorOutput {
  const rawTaskUpdates = Array.isArray(parsed.taskUpdates)
    ? parsed.taskUpdates
    : Array.isArray(parsed.task_updates)
      ? parsed.task_updates
      : Array.isArray(parsed.updates)
        ? parsed.updates
        : [];
  const taskUpdates = mergeTaskUpdates(
    rawTaskUpdates
      .map((update) => normalizeTaskUpdate(update, input))
      .filter((update): update is SemanticTaskUpdate => update !== undefined),
  );
  if (rawTaskUpdates.length > 0 && taskUpdates.length === 0) {
    throw new Error("task_state_estimator_invalid_task_updates");
  }
  return {
    baseVersion: input.registry.version,
    taskUpdates,
  };
}

function parseEstimatorOutput(
  rawText: string,
  input: TaskStateEstimatorInput,
): TaskStateEstimatorOutput {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("task_state_estimator_empty_response");
  }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidates = uniqueStrings([
    fenced ?? trimmed,
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ]);
  let parsed: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const candidateValue = JSON.parse(candidate) as unknown;
      if (candidateValue && typeof candidateValue === "object" && !Array.isArray(candidateValue)) {
        parsed = candidateValue as Record<string, unknown>;
      }
      break;
    } catch {
      // Try the next bounded JSON candidate without retaining provider text.
    }
  }
  if (!parsed) {
    throw new Error("task_state_estimator_invalid_json");
  }
  const rawTaskUpdates = parsed.taskUpdates ?? parsed.task_updates ?? parsed.updates;
  if (!Array.isArray(rawTaskUpdates)) {
    throw new Error("task_state_estimator_missing_task_updates");
  }
  return normalizeEstimatorOutput(parsed, input);
}

export function createApiTaskStateEstimator(
  cfg: TaskStateEstimatorApiConfig,
): TaskStateEstimator {
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw new Error("task-state estimator requires baseUrl, apiKey, and model");
  }
  const evictionLookaheadTurns = Math.max(1, cfg.evictionLookaheadTurns ?? 3);
  const lifecycleMode = cfg.lifecycleMode === "decoupled" ? "decoupled" : "coupled";
  const evidenceMode = cfg.evidenceMode === "two_state" ? "two_state" : "three_state";
  const client = createApiJsonModelClient(cfg);
  return {
    async estimate(input: TaskStateEstimatorInput): Promise<TaskStateEstimatorOutput> {
      const response = await client.request({
        systemPrompt: buildSystemPrompt({ evictionLookaheadTurns, lifecycleMode, evidenceMode }),
        userPayload: buildUserPayload(input, evidenceMode),
      });
      return { ...parseEstimatorOutput(response.text, input), usage: response.usage };
    },
  };
}
