import { buildTurnAbsId } from "@lightrsi/history";
import { readCodexContextHistoryJournalRecoveringTail } from "./journal-append.js";
import { codexReplayabilityForItem, codexReplayPairRef } from "./replayability.js";
import { cloneJson, hashJson } from "./shared.js";
import type {
  CodexContextHistoryJournalEntry,
  CodexEffectiveHistory,
  CodexEffectiveHistoryItem,
  CodexEffectiveHistoryReasonCode,
  CodexEffectiveHistoryTurn,
  CodexEffectiveHistoryView,
  CodexRequestJournalEntry,
  CodexResponseJournalEntry,
  JsonObject,
} from "./types.js";

type IndexedRequest = {
  entry: CodexRequestJournalEntry;
  journalIndex: number;
};

type IndexedResponse = {
  entry: CodexResponseJournalEntry;
  journalIndex: number;
};

type CommittedTurn = {
  request: IndexedRequest;
  response: IndexedResponse;
};

type EffectiveItemRecord = {
  stableItemId: string;
  item: JsonObject;
};

function findLastResponse(
  responses: IndexedResponse[],
  predicate: (response: IndexedResponse) => boolean,
): IndexedResponse | undefined {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index];
    if (response && predicate(response)) return response;
  }
  return undefined;
}

function latestRequests(journal: CodexContextHistoryJournalEntry[]): Map<string, IndexedRequest> {
  const requests = new Map<string, IndexedRequest>();
  journal.forEach((entry, journalIndex) => {
    if (entry.kind === "request") requests.set(entry.requestId, { entry, journalIndex });
  });
  return requests;
}

function responsesById(journal: CodexContextHistoryJournalEntry[]): Map<string, IndexedResponse[]> {
  const responses = new Map<string, IndexedResponse[]>();
  journal.forEach((entry, journalIndex) => {
    if (entry.kind === "response" && entry.responseId) {
      const occurrences = responses.get(entry.responseId) ?? [];
      occurrences.push({ entry, journalIndex });
      responses.set(entry.responseId, occurrences);
    }
  });
  return responses;
}

function isCommittedResponseEntry(entry: CodexResponseJournalEntry): boolean {
  if (entry.status === "completed") return true;
  return entry.status === "incomplete"
    && (entry.malformedEventCount ?? 0) > 0
    && (entry.eventTypeCounts?.["response.completed"] ?? 0) > 0;
}

function committedResponses(
  responses: Map<string, IndexedResponse[]>,
  requests: Map<string, IndexedRequest>,
): IndexedResponse[] {
  return Array.from(responses.values()).flat()
    .filter(({ entry }) => {
      if (!isCommittedResponseEntry(entry) || !entry.requestId) return false;
      return requests.get(entry.requestId)?.entry.status === "completed";
    })
    .sort((left, right) => left.journalIndex - right.journalIndex);
}

function previousResponseId(turn: CommittedTurn): string | undefined {
  if ("previousResponseId" in turn.response.entry) {
    return typeof turn.response.entry.previousResponseId === "string"
      ? turn.response.entry.previousResponseId
      : undefined;
  }
  return turn.request.entry.previousResponseId;
}

function semanticPreviousResponseId(turn: CommittedTurn): string | undefined {
  return previousResponseId(turn) ?? turn.request.entry.previousResponseId;
}

function committedInputItems(turn: CommittedTurn): JsonObject[] {
  return turn.request.entry.committedInputItems ?? turn.request.entry.inputItems;
}

function buildCommittedChain(params: {
  headResponseId?: string;
  requests: Map<string, IndexedRequest>;
  responses: Map<string, IndexedResponse[]>;
  parentResponseId?: (turn: CommittedTurn) => string | undefined;
}): { chain: CommittedTurn[]; complete: boolean } {
  const committed = committedResponses(params.responses, params.requests);
  const head = params.headResponseId
    ? findLastResponse(committed, ({ entry }) => entry.responseId === params.headResponseId)
    : committed.at(-1);
  if (!head) {
    return { chain: [], complete: params.headResponseId === undefined && params.requests.size === 0 };
  }

  const chain: CommittedTurn[] = [];
  const seenJournalIndexes = new Set<number>();
  let cursor: IndexedResponse | undefined = head;
  while (cursor) {
    const responseId = cursor.entry.responseId;
    const requestId = cursor.entry.requestId;
    if (!responseId || !requestId || !isCommittedResponseEntry(cursor.entry)) {
      return { chain: [], complete: false };
    }
    if (seenJournalIndexes.has(cursor.journalIndex)) return { chain: [], complete: false };
    seenJournalIndexes.add(cursor.journalIndex);

    const request = params.requests.get(requestId);
    if (!request || request.entry.status !== "completed") {
      return { chain: [], complete: false };
    }
    const turn = { request, response: cursor };
    chain.unshift(turn);

    const previousId = (params.parentResponseId ?? previousResponseId)(turn);
    if (!previousId) break;
    cursor = findLastResponse(committed, (candidate) => (
      candidate.entry.responseId === previousId
      && candidate.journalIndex < cursor!.journalIndex
    ));
    if (!cursor) return { chain, complete: false };
  }
  return { chain, complete: true };
}

function itemIdentity(params: {
  item: JsonObject;
  sessionId: string;
  turnOrdinal: number;
  phase: "input" | "output";
  itemOrdinal: number;
  syntheticOccurrences: Map<string, number>;
}): string {
  const type = typeof params.item.type === "string"
    ? params.item.type
    : typeof params.item.role === "string"
      ? `message:${params.item.role}`
      : "item";
  if (typeof params.item.id === "string") return `${type}:id:${params.item.id}`;
  if (typeof params.item.call_id === "string") return `${type}:call:${params.item.call_id}`;
  // Stateless replay sends prior items again in a later request. Synthetic
  // identities therefore follow content plus its ordered occurrence in the
  // effective payload, rather than the request that happened to carry it.
  const baseNativeId = `${type}:synthetic:${hashJson(params.item)}`;
  const occurrence = params.syntheticOccurrences.get(baseNativeId) ?? 0;
  params.syntheticOccurrences.set(baseNativeId, occurrence + 1);
  return occurrence === 0
    ? baseNativeId
    : `${baseNativeId}:occurrence:${occurrence}`;
}

function appendEffectiveItem(params: {
  item: JsonObject;
  sessionId: string;
  turnOrdinal: number;
  phase: "input" | "output";
  itemOrdinal: number;
  seen: Set<string>;
  replayableItems: CodexEffectiveHistoryItem[];
  observationOnlyItems: CodexEffectiveHistoryItem[];
  deferredItems: CodexEffectiveHistoryItem[];
  effectiveItemRecords?: EffectiveItemRecord[];
  syntheticOccurrences: Map<string, number>;
}): string | undefined {
  const nativeId = itemIdentity(params);
  if (params.seen.has(nativeId)) return undefined;
  params.seen.add(nativeId);
  const effectiveItem: CodexEffectiveHistoryItem = {
    stableItemId: `codex-${hashJson(nativeId)}`,
    nativeId,
    callId: typeof params.item.call_id === "string" ? params.item.call_id : undefined,
    item: cloneJson(params.item),
  };
  const replayability = codexReplayabilityForItem(params.item);
  if (replayability.mode === "replayable") params.replayableItems.push(effectiveItem);
  else if (replayability.mode === "observation_only") params.observationOnlyItems.push(effectiveItem);
  else params.deferredItems.push(effectiveItem);
  params.effectiveItemRecords?.push({
    stableItemId: effectiveItem.stableItemId,
    item: effectiveItem.item,
  });
  return effectiveItem.stableItemId;
}

function turnAttributionKey(item: JsonObject): string {
  const normalized = cloneJson(item);
  delete normalized.id;
  delete normalized.internal_chat_message_metadata_passthrough;
  if (!["program_output", "tool_search_call", "tool_search_output"].includes(
    String(normalized.type ?? "").toLowerCase(),
  )) delete normalized.status;
  delete normalized.created_at;
  return hashJson(canonicalizeTurnAttributionValue(normalized));
}

function canonicalizeTurnAttributionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeTurnAttributionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeTurnAttributionValue(child)]),
  );
}

function buildAttributedTurns(params: {
  chain: CommittedTurn[];
  effectiveItemRecords: EffectiveItemRecord[];
  sessionId: string;
}): { turns: CodexEffectiveHistoryTurn[]; complete: boolean; ambiguousDuplicate: boolean } {
  const candidates = params.effectiveItemRecords.map((entry) => ({
    ...entry,
    key: turnAttributionKey(entry.item),
    matched: false,
  }));
  const sourceBuckets = new Map<string, Set<string>>();
  const sourceCounts = new Map<string, number>();
  const finalCounts = new Map<string, number>();
  for (const candidate of candidates) {
    finalCounts.set(candidate.key, (finalCounts.get(candidate.key) ?? 0) + 1);
  }

  const turns = params.chain.map((turn) => {
    const sidecar: CodexEffectiveHistoryTurn = {
      turnSeq: turn.request.entry.turnOrdinal,
      turnAbsId: buildTurnAbsId(params.sessionId, turn.request.entry.turnOrdinal),
      inputItemIds: [],
      outputItemIds: [],
    };
    const attribute = (
      item: JsonObject,
      phase: "input" | "output",
      trackSource = true,
    ) => {
      const key = turnAttributionKey(item);
      if (trackSource) {
        const bucket = `${turn.request.entry.turnOrdinal}:${phase}`;
        const buckets = sourceBuckets.get(key) ?? new Set<string>();
        buckets.add(bucket);
        sourceBuckets.set(key, buckets);
        sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
      }
      const candidate = candidates.find((entry) => !entry.matched && entry.key === key);
      if (!candidate) return;
      candidate.matched = true;
      appendUnique(
        phase === "input" ? sidecar.inputItemIds : sidecar.outputItemIds,
        candidate.stableItemId,
      );
    };
    turn.request.entry.inputItems.forEach((item) => attribute(item, "input"));
    const sourceKeys = new Set(turn.request.entry.inputItems.map(turnAttributionKey));
    committedInputItems(turn)
      .filter((item) => !sourceKeys.has(turnAttributionKey(item)))
      .forEach((item) => attribute(item, "input", false));
    turn.response.entry.outputItems.forEach((item) => attribute(item, "output"));
    return sidecar;
  });
  const ambiguousDuplicate = Array.from(sourceCounts).some(([key, sourceCount]) => (
    (finalCounts.get(key) ?? 0) > 0
    && sourceCount > (finalCounts.get(key) ?? 0)
    && (sourceBuckets.get(key)?.size ?? 0) > 1
  ));
  return {
    turns,
    complete: !ambiguousDuplicate && candidates.every((entry) => entry.matched),
    ambiguousDuplicate,
  };
}

function appendUnique(values: string[], value: string | undefined): void {
  if (value && !values.includes(value)) values.push(value);
}

function mergeTurns(
  turns: CodexEffectiveHistoryTurn[],
  validItemIds?: Set<string>,
): CodexEffectiveHistoryTurn[] {
  const byTurnSeq = new Map<number, CodexEffectiveHistoryTurn>();
  for (const turn of turns) {
    const inputItemIds = turn.inputItemIds.filter((itemId) => !validItemIds || validItemIds.has(itemId));
    const outputItemIds = turn.outputItemIds.filter((itemId) => !validItemIds || validItemIds.has(itemId));
    const existing = byTurnSeq.get(turn.turnSeq);
    if (!existing) {
      byTurnSeq.set(turn.turnSeq, {
        turnSeq: turn.turnSeq,
        turnAbsId: turn.turnAbsId,
        inputItemIds: Array.from(new Set(inputItemIds)),
        outputItemIds: Array.from(new Set(outputItemIds)),
      });
      continue;
    }
    inputItemIds.forEach((itemId) => appendUnique(existing.inputItemIds, itemId));
    outputItemIds.forEach((itemId) => appendUnique(existing.outputItemIds, itemId));
  }
  const attributedItemIds = new Set<string>();
  return Array.from(byTurnSeq.values())
    .sort((left, right) => left.turnSeq - right.turnSeq)
    .map((turn) => ({
      ...turn,
      inputItemIds: turn.inputItemIds.filter((itemId) => {
        if (attributedItemIds.has(itemId)) return false;
        attributedItemIds.add(itemId);
        return true;
      }),
      outputItemIds: turn.outputItemIds.filter((itemId) => {
        if (attributedItemIds.has(itemId)) return false;
        attributedItemIds.add(itemId);
        return true;
      }),
    }));
}

function alignProxyTurnsAfterRollout(params: {
  sessionId: string;
  rolloutTurns: CodexEffectiveHistoryTurn[];
  proxyTurns: CodexEffectiveHistoryTurn[];
}): CodexEffectiveHistoryTurn[] {
  if (params.rolloutTurns.length === 0 || params.proxyTurns.length === 0) {
    return params.proxyTurns;
  }
  // A fresh proxy journal starts its local ordinal at 1 even when the Codex
  // rollout already contains session-global turns. Empty rollout sidecars do
  // not prove a boundary, so only advance after the last turn owning an item.
  const evidencedRolloutTurns = params.rolloutTurns.filter((turn) =>
    turn.inputItemIds.length > 0 || turn.outputItemIds.length > 0
  );
  if (evidencedRolloutTurns.length === 0) return params.proxyTurns;
  const lastRolloutTurnSeq = Math.max(...evidencedRolloutTurns.map((turn) => turn.turnSeq));
  const firstProxyTurnSeq = Math.min(...params.proxyTurns.map((turn) => turn.turnSeq));
  const offset = firstProxyTurnSeq <= lastRolloutTurnSeq
    ? lastRolloutTurnSeq - firstProxyTurnSeq + 1
    : 0;
  if (offset === 0) return params.proxyTurns;
  return params.proxyTurns.map((turn) => {
    const turnSeq = turn.turnSeq + offset;
    return {
      ...turn,
      turnSeq,
      turnAbsId: buildTurnAbsId(params.sessionId, turnSeq),
    };
  });
}

function historyItemIds(history: CodexEffectiveHistory): Set<string> {
  return new Set([
    ...history.replayableItems,
    ...history.observationOnlyItems,
    ...history.deferredItems,
  ].map((entry) => entry.stableItemId));
}

function uniqueReasonCodes(
  values: CodexEffectiveHistoryReasonCode[],
): CodexEffectiveHistoryReasonCode[] {
  return Array.from(new Set(values));
}

function unresolvedCallIds(items: CodexEffectiveHistoryItem[]): string[] {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const entry of items) {
    const ref = codexReplayPairRef(entry.item);
    if (ref.side === "call" && ref.callId) calls.add(ref.callId);
    if (ref.side === "output" && ref.callId) outputs.add(ref.callId);
  }
  return Array.from(calls).filter((callId) => !outputs.has(callId)).sort();
}

const CURRENT_INPUT_CLOSURE_REASON_CODES = new Set<CodexEffectiveHistoryReasonCode>([
  "journal_current_request_uncommitted",
  "history_replay_incomplete",
  "history_unresolved_tool_calls",
]);

/**
 * Treats a committed tool call as closed only for the request that carries its
 * matching output. The current input remains outside the history snapshot and
 * is appended by the rebase builder, so the history revision stays stable.
 */
export function resolveCodexEffectiveHistoryCurrentInputClosures(params: {
  view: CodexEffectiveHistoryView;
  currentInput: unknown;
}): CodexEffectiveHistory {
  const { history } = params.view;
  if (!history.incomplete || history.unresolvedCallIds.length === 0) return history;
  if (!params.view.reasonCodes.includes("history_unresolved_tool_calls")) return history;
  if (params.view.reasonCodes.some((reason) => !CURRENT_INPUT_CLOSURE_REASON_CODES.has(reason))) {
    return history;
  }
  const outputCallIds = new Set(
    (Array.isArray(params.currentInput) ? params.currentInput : [])
      .filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map(codexReplayPairRef)
      .filter((ref) => ref.side === "output" && ref.callId)
      .map((ref) => ref.callId!),
  );
  if (!history.unresolvedCallIds.every((callId) => outputCallIds.has(callId))) return history;
  return {
    ...history,
    unresolvedCallIds: [],
    incomplete: false,
  };
}

function hasUncommittedActiveWork(params: {
  chain: CommittedTurn[];
  currentRequestId?: string;
  explicitHead: boolean;
  requests: Map<string, IndexedRequest>;
}): boolean {
  const headTurnOrdinal = params.chain.at(-1)?.request.entry.turnOrdinal ?? 0;
  const committedRequestIds = new Set(params.chain.map((turn) => turn.request.entry.requestId));
  return Array.from(params.requests.values()).some(({ entry }) => {
    if (entry.requestId === params.currentRequestId || entry.status === "failed") return false;
    if (committedRequestIds.has(entry.requestId)) return false;
    if (params.explicitHead) return false;
    if (entry.turnOrdinal <= headTurnOrdinal) return false;
    return true;
  });
}

function hasUncommittedResponseWork(params: {
  chain: CommittedTurn[];
  explicitHead: boolean;
  journal: CodexContextHistoryJournalEntry[];
  requests: Map<string, IndexedRequest>;
}): boolean {
  if (params.explicitHead) return false;
  const headJournalIndex = params.chain.at(-1)?.response.journalIndex ?? -1;
  return params.journal.some((entry, journalIndex) => {
    if (journalIndex <= headJournalIndex || entry.kind !== "response" || entry.status === "failed") return false;
    if (!entry.requestId) return true;
    return params.requests.get(entry.requestId)?.entry.status !== "failed";
  });
}

function hasMalformedStreamEvents(chain: CommittedTurn[]): boolean {
  return chain.some((turn) => (turn.response.entry.malformedEventCount ?? 0) > 0);
}

function hasTurnSequenceConflict(chain: CommittedTurn[]): boolean {
  let previous = 0;
  const seen = new Set<number>();
  for (const turn of chain) {
    const turnSeq = turn.request.entry.turnOrdinal;
    if (seen.has(turnSeq) || turnSeq <= previous) return true;
    seen.add(turnSeq);
    previous = turnSeq;
  }
  return false;
}

function effectiveItemKeys(entry: CodexEffectiveHistoryItem): string[] {
  const type = typeof entry.item.type === "string"
    ? entry.item.type
    : typeof entry.item.role === "string"
      ? `message:${entry.item.role}`
      : "item";
  const keys = [`stable:${entry.stableItemId}`];
  if (entry.nativeId) keys.push(`native:${entry.nativeId}`);
  if (typeof entry.item.id === "string") keys.push(`item:${type}:${entry.item.id}`);
  if (entry.callId) keys.push(`call:${type}:${entry.callId}`);
  return keys;
}

function appendMergedEffectiveItems(params: {
  target: CodexEffectiveHistoryItem[];
  entries: CodexEffectiveHistoryItem[];
  seen: Set<string>;
}): void {
  for (const entry of params.entries) {
    const keys = effectiveItemKeys(entry);
    if (keys.some((key) => params.seen.has(key))) continue;
    keys.forEach((key) => params.seen.add(key));
    params.target.push({
      ...entry,
      item: cloneJson(entry.item),
    });
  }
}

function historyRevision(params: {
  replayableItems: CodexEffectiveHistoryItem[];
  observationOnlyItems: CodexEffectiveHistoryItem[];
  deferredItems: CodexEffectiveHistoryItem[];
  unresolved: string[];
  incomplete: boolean;
}): string {
  return `rev-${hashJson({
    replayableItems: params.replayableItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    observationOnlyItems: params.observationOnlyItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    deferredItems: params.deferredItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    unresolved: params.unresolved,
    incomplete: params.incomplete,
  })}`;
}

function mergeRolloutBootstrapWithProxyJournal(params: {
  sessionId: string;
  bootstrapped: CodexEffectiveHistoryView;
  proxyTurns: CodexEffectiveHistoryTurn[];
  proxyReplayableItems: CodexEffectiveHistoryItem[];
  proxyObservationOnlyItems: CodexEffectiveHistoryItem[];
  proxyDeferredItems: CodexEffectiveHistoryItem[];
  proxyIncomplete: boolean;
  proxyReasonCodes: CodexEffectiveHistoryReasonCode[];
}): CodexEffectiveHistoryView {
  const seen = new Set<string>();
  const replayableItems: CodexEffectiveHistoryItem[] = [];
  const observationOnlyItems: CodexEffectiveHistoryItem[] = [];
  const deferredItems: CodexEffectiveHistoryItem[] = [];
  appendMergedEffectiveItems({
    target: replayableItems,
    entries: params.bootstrapped.history.replayableItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: observationOnlyItems,
    entries: params.bootstrapped.history.observationOnlyItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: deferredItems,
    entries: params.bootstrapped.history.deferredItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: replayableItems,
    entries: params.proxyReplayableItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: observationOnlyItems,
    entries: params.proxyObservationOnlyItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: deferredItems,
    entries: params.proxyDeferredItems,
    seen,
  });
  const unresolved = Array.from(new Set([
    ...params.bootstrapped.history.unresolvedCallIds,
    ...unresolvedCallIds(replayableItems),
  ])).sort();
  const incomplete = Boolean(
    params.bootstrapped.history.incomplete
    || params.proxyIncomplete
    || deferredItems.length > 0
    || unresolved.length > 0
  );
  const history: CodexEffectiveHistory = {
    revision: historyRevision({
      replayableItems,
      observationOnlyItems,
      deferredItems,
      unresolved,
      incomplete,
    }),
    replayableItems,
    observationOnlyItems,
    deferredItems,
    unresolvedCallIds: unresolved,
    source: "rollout_proxy_merge",
    incomplete,
  };
  const alignedProxyTurns = alignProxyTurnsAfterRollout({
    sessionId: params.sessionId,
    rolloutTurns: params.bootstrapped.turns,
    proxyTurns: params.proxyTurns,
  });
  const turns = mergeTurns(
    [...params.bootstrapped.turns, ...alignedProxyTurns],
    historyItemIds(history),
  );
  const reasonCodes = uniqueReasonCodes([
    ...params.bootstrapped.reasonCodes,
    ...params.proxyReasonCodes,
    ...(incomplete ? ["history_replay_incomplete" as const] : []),
    ...(deferredItems.length > 0 ? ["history_deferred_items" as const] : []),
    ...(unresolved.length > 0 ? ["history_unresolved_tool_calls" as const] : []),
  ]);
  return {
    history,
    turns,
    semanticComplete: params.bootstrapped.semanticComplete
      && !params.proxyIncomplete
      && reasonCodes.length === 0,
    reasonCodes,
  };
}

export type BuildCodexEffectiveHistoryParams = {
  stateDir: string;
  sessionId: string;
  headResponseId?: string;
  currentRequestId?: string;
  rolloutParserBootstrap?: () => Promise<CodexEffectiveHistory | null>;
  rolloutViewBootstrap?: () => Promise<CodexEffectiveHistoryView | null>;
};

export async function buildCodexEffectiveHistoryView(
  params: BuildCodexEffectiveHistoryParams,
): Promise<CodexEffectiveHistoryView> {
  const journalRead = await readCodexContextHistoryJournalRecoveringTail(params.stateDir, params.sessionId);
  const requests = latestRequests(journalRead.entries);
  const responses = responsesById(journalRead.entries);
  const committedChain = buildCommittedChain({
    headResponseId: params.headResponseId,
    requests,
    responses,
  });
  const semanticChain = buildCommittedChain({
    headResponseId: params.headResponseId,
    requests,
    responses,
    parentResponseId: semanticPreviousResponseId,
  });
  const malformedStreams = hasMalformedStreamEvents(committedChain.chain);
  const turnSequenceConflict = hasTurnSequenceConflict(committedChain.chain);
  const emptyChainWithJournal = Boolean(
    committedChain.chain.length === 0
    && journalRead.entries.some((entry) => (
      entry.status !== "failed"
      && !(entry.kind === "request" && entry.requestId === params.currentRequestId)
    ))
  );
  const uncommittedActiveWork = hasUncommittedActiveWork({
    chain: committedChain.chain,
    currentRequestId: params.currentRequestId,
    explicitHead: params.headResponseId !== undefined,
    requests,
  });
  const uncommittedResponseWork = hasUncommittedResponseWork({
    chain: committedChain.chain,
    explicitHead: params.headResponseId !== undefined,
    journal: journalRead.entries,
    requests,
  });
  const journalIncomplete = Boolean(
    journalRead.readError
    || journalRead.malformedLineCount > 0
    || malformedStreams
    || !committedChain.complete
    || emptyChainWithJournal
    || uncommittedActiveWork
    || uncommittedResponseWork,
  );
  const journalReasonCodes: CodexEffectiveHistoryReasonCode[] = [
    ...(journalRead.readError ? ["journal_read_error" as const] : []),
    ...(journalRead.malformedLineCount > 0 ? ["journal_malformed_lines" as const] : []),
    ...(malformedStreams ? ["journal_malformed_stream" as const] : []),
    ...(!committedChain.complete ? ["journal_committed_chain_incomplete" as const] : []),
    ...(emptyChainWithJournal ? ["journal_history_without_committed_chain" as const] : []),
    ...(uncommittedActiveWork ? ["journal_uncommitted_request" as const] : []),
    ...(uncommittedResponseWork ? ["journal_uncommitted_response" as const] : []),
    ...(params.currentRequestId ? ["journal_current_request_uncommitted" as const] : []),
    ...(turnSequenceConflict ? ["journal_turn_sequence_conflict" as const] : []),
  ];
  const replayableItems: CodexEffectiveHistoryItem[] = [];
  const observationOnlyItems: CodexEffectiveHistoryItem[] = [];
  const deferredItems: CodexEffectiveHistoryItem[] = [];
  const effectiveItemRecords: EffectiveItemRecord[] = [];
  const seen = new Set<string>();
  let syntheticOccurrences = new Map<string, number>();
  for (const turn of committedChain.chain) {
    const carriesCommittedReplay = Array.isArray(turn.request.entry.committedInputItems);
    const turnSyntheticOccurrences = carriesCommittedReplay
      ? new Map<string, number>()
      : syntheticOccurrences;
    committedInputItems(turn).forEach((item, itemOrdinal) => {
      appendEffectiveItem({
        item,
        sessionId: params.sessionId,
        turnOrdinal: turn.request.entry.turnOrdinal,
        phase: "input",
        itemOrdinal,
        seen,
        replayableItems,
        observationOnlyItems,
        deferredItems,
        effectiveItemRecords,
        syntheticOccurrences: turnSyntheticOccurrences,
      });
    });
    turn.response.entry.outputItems.forEach((item, itemOrdinal) => {
      appendEffectiveItem({
        item,
        sessionId: params.sessionId,
        turnOrdinal: turn.request.entry.turnOrdinal,
        phase: "output",
        itemOrdinal,
        seen,
        replayableItems,
        observationOnlyItems,
        deferredItems,
        effectiveItemRecords,
        syntheticOccurrences: turnSyntheticOccurrences,
      });
    });
    syntheticOccurrences = turnSyntheticOccurrences;
  }
  const attribution = buildAttributedTurns({
    chain: semanticChain.chain,
    effectiveItemRecords,
    sessionId: params.sessionId,
  });
  const attributionIncomplete = !semanticChain.complete || !attribution.complete;
  if (attributionIncomplete) journalReasonCodes.push("journal_turn_attribution_incomplete");
  const turns = attribution.turns;

  const unresolved = unresolvedCallIds(replayableItems);
  const effectiveIncomplete = journalIncomplete || deferredItems.length > 0 || unresolved.length > 0;
  const bootstrapRequested = journalRead.entries.length === 0
    || effectiveIncomplete
    || (attributionIncomplete && Boolean(params.rolloutViewBootstrap));
  if (bootstrapRequested && (params.rolloutViewBootstrap || params.rolloutParserBootstrap)) {
    const bootstrapped = params.rolloutViewBootstrap
      ? await params.rolloutViewBootstrap()
      : await params.rolloutParserBootstrap!().then((history) => history
        ? {
            history,
            turns: [],
            semanticComplete: false,
            reasonCodes: ["rollout_turn_boundary_unavailable" as const],
          }
        : null);
    if (bootstrapped) {
      const normalizedBootstrap: CodexEffectiveHistoryView = {
        ...bootstrapped,
        turns: mergeTurns(bootstrapped.turns.map((turn) => ({
          ...turn,
          turnAbsId: buildTurnAbsId(params.sessionId, turn.turnSeq),
        })), historyItemIds(bootstrapped.history)),
        reasonCodes: uniqueReasonCodes(bootstrapped.reasonCodes),
      };
      const proxyReasonCodes = journalReasonCodes.filter((reason) =>
        reason !== "journal_committed_chain_incomplete"
        && reason !== "journal_history_without_committed_chain"
        && !(
          reason === "journal_turn_attribution_incomplete"
          && !semanticChain.complete
          && attribution.complete
          && !attribution.ambiguousDuplicate
          && normalizedBootstrap.semanticComplete
        )
      );
      if (committedChain.chain.length === 0) {
        const reasonCodes = uniqueReasonCodes([
          ...normalizedBootstrap.reasonCodes,
          ...proxyReasonCodes,
        ]);
        return {
          ...normalizedBootstrap,
          semanticComplete: normalizedBootstrap.semanticComplete && reasonCodes.length === 0,
          reasonCodes,
        };
      }
      return mergeRolloutBootstrapWithProxyJournal({
        sessionId: params.sessionId,
        bootstrapped: normalizedBootstrap,
        proxyTurns: turns,
        proxyReplayableItems: replayableItems,
        proxyObservationOnlyItems: observationOnlyItems,
        proxyDeferredItems: deferredItems,
        proxyIncomplete: Boolean(
          journalRead.readError
          || journalRead.malformedLineCount > 0
          || malformedStreams
          || emptyChainWithJournal
          || uncommittedActiveWork
          || uncommittedResponseWork
        ),
        proxyReasonCodes,
      });
    }
  }
  const revision = historyRevision({
    replayableItems,
    observationOnlyItems,
    deferredItems,
    unresolved,
    incomplete: effectiveIncomplete,
  });

  const history: CodexEffectiveHistory = {
    revision,
    replayableItems,
    observationOnlyItems,
    deferredItems,
    unresolvedCallIds: unresolved,
    source: journalRead.entries.length > 0 ? "proxy_journal" : "empty",
    incomplete: effectiveIncomplete,
  };
  const reasonCodes = uniqueReasonCodes([
    ...journalReasonCodes,
    ...(effectiveIncomplete ? ["history_replay_incomplete" as const] : []),
    ...(deferredItems.length > 0 ? ["history_deferred_items" as const] : []),
    ...(unresolved.length > 0 ? ["history_unresolved_tool_calls" as const] : []),
  ]);
  return {
    history,
    turns: mergeTurns(turns, historyItemIds(history)),
    semanticComplete: reasonCodes.length === 0,
    reasonCodes,
  };
}

export async function buildCodexEffectiveHistory(
  params: BuildCodexEffectiveHistoryParams,
): Promise<CodexEffectiveHistory> {
  return (await buildCodexEffectiveHistoryView(params)).history;
}
