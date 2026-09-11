import type { SessionTaskRegistry } from "@lightrsi/history";
import type { ContextItemRef, ModelContextSnapshot } from "@lightrsi/host-adapter";

import { buildToolResultSegments } from "../eviction.js";

function provenTaskIds(
  registry: SessionTaskRegistry,
  segmentId: string,
  toolUseId: string,
  turnAbsIdByToolCallId?: ReadonlyMap<string, string>,
): string[] | undefined {
  const direct = registry.blockToTaskIds[segmentId];
  const turnAbsId = turnAbsIdByToolCallId?.get(toolUseId);
  const related = direct ?? (turnAbsId ? registry.turnToTaskIds[turnAbsId] : undefined);
  if (!related || related.length === 0) return undefined;
  const normalized = related.map((taskId) => taskId.trim());
  if (normalized.some((taskId) => !taskId || registry.tasks[taskId] === undefined)
    || new Set(normalized).size !== normalized.length) return undefined;
  return [...normalized].sort();
}

/**
 * Add only registry-proven task ownership to a canonical Claude snapshot.
 * Claude's stable item ids are positional, while the registry keys historical
 * closed tool results by semantic segment id. buildToolResultSegments is the
 * adapter-owned proof that connects those identities. Text and current-turn
 * content deliberately remain unassigned.
 */
export function attributeClaudeSnapshotTasks(params: {
  snapshot: ModelContextSnapshot;
  messages: unknown[];
  registry: SessionTaskRegistry;
  turnAbsIdByToolCallId?: ReadonlyMap<string, string>;
}): ModelContextSnapshot {
  const cleanItems = params.snapshot.items.map(({ taskIds: _taskIds, ...item }) => item);
  if (params.snapshot.hostId !== "claude-code"
    || params.registry.sessionId !== params.snapshot.sessionId) {
    return { ...params.snapshot, items: cleanItems };
  }

  const itemsByStableId = new Map(cleanItems.map((item) => [item.stableId, item] as const));
  const itemsByCallId = new Map<string, ContextItemRef[]>();
  for (const item of cleanItems) {
    if (!item.callId) continue;
    const related = itemsByCallId.get(item.callId) ?? [];
    related.push(item);
    itemsByCallId.set(item.callId, related);
  }

  const attributedTaskIds = new Map<string, string[]>();
  const { bindings } = buildToolResultSegments(params.messages);
  for (const binding of bindings.values()) {
    const taskIds = provenTaskIds(
      params.registry,
      binding.segmentId,
      binding.toolUseId,
      params.turnAbsIdByToolCallId,
    );
    if (!taskIds) continue;
    const resultStableId = `${params.snapshot.sessionId}:${binding.messageIndex}:${binding.blockIndex}`;
    const result = itemsByStableId.get(resultStableId);
    const pairedItems = itemsByCallId.get(binding.toolUseId) ?? [];
    const calls = pairedItems.filter((item) => item.kind === "tool_call");
    const results = pairedItems.filter((item) => item.kind === "tool_result");
    if (result?.kind !== "tool_result"
      || result.callId !== binding.toolUseId
      || calls.length !== 1
      || results.length !== 1
      || results[0]?.stableId !== resultStableId) continue;
    attributedTaskIds.set(calls[0]!.stableId, taskIds);
    attributedTaskIds.set(resultStableId, taskIds);
  }

  return {
    ...params.snapshot,
    items: cleanItems.map((item) => {
      const taskIds = attributedTaskIds.get(item.stableId);
      return taskIds ? { ...item, taskIds } : item;
    }),
  };
}
