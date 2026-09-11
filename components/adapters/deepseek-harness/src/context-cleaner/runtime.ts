/**
 * DSH context-cleaner execution bridge (unit 3).
 *
 * Two responsibilities:
 *   1. `createDshCleanerExecutionBridge` — configures the SHARED execution
 *      bridge (`createContextCleanerHostExecutionBridge`) with a
 *      `readExecutionSnapshot` that reads DSH's LIVE canonical surface inside
 *      the request lock. The shared bridge owns the stored-state machine.
 *   2. `applyScheduledDshClean` — takes a prepared (`outcome: "ready"`) clean and
 *      commits it to the surface through R4 `applyEvictionTransaction` (the SAME
 *      canonical delete path as eviction — §2.2, no second delete path), then
 *      records an applied receipt.
 *
 * Savings accounting is conservative on purpose: only operations whose EVERY
 * target actually landed are counted, so a partial commit never over-reports
 * saved chars (the failure mode PR 62/64 fixed elsewhere). Token savings are
 * null under the chars_only snapshot mode until exact metering is wired.
 */

import {
  createContextCleanerHostExecutionBridge,
  type ContextCleanAppliedReceipt,
  type ContextCleanExecutionRequest,
  type ContextCleanExecutionSnapshot,
  type ContextCleanerHostExecutionBridge,
} from "@lightrsi/cleaner";
import type { SessionTaskRegistry } from "@lightrsi/history";

import {
  applyEvictionTransaction,
  type AppendableSession,
  type EvictionPlan,
  type EvictionTarget,
} from "../surface-transaction.js";
import { describeEffectiveItems, type CycleSession } from "../eviction-cycle.js";
import { buildDshCleanSnapshot, DSH_HOST_ID, surfaceRevision } from "./snapshot.js";
import type { DshCleanerSessionStore } from "./session-catalog.js";

/** Extract the durable seq from a `event-<seq>-<kind>` stable id. */
function parseSeq(stableId: string): number | undefined {
  const match = /^event-(\d+)-/.exec(stableId);
  return match ? Number(match[1]) : undefined;
}

/** Build the shared execution bridge, reading the live DSH surface per session. */
export function createDshCleanerExecutionBridge(params: {
  stateDir: string;
  sessions: DshCleanerSessionStore;
  loadRegistry: (sessionId: string) => Promise<SessionTaskRegistry> | SessionTaskRegistry;
}): ContextCleanerHostExecutionBridge {
  return createContextCleanerHostExecutionBridge({
    stateDir: params.stateDir,
    hostId: DSH_HOST_ID,
    async readExecutionSnapshot(sessionId): Promise<ContextCleanExecutionSnapshot> {
      const session = params.sessions.get(sessionId);
      if (!session) throw new Error("dsh_clean_execution_snapshot_unavailable");
      const registry = await params.loadRegistry(sessionId);
      const { snapshot } = buildDshCleanSnapshot({ session, registry, revision: surfaceRevision(session) });
      return {
        snapshot,
        activeTaskIds: registry.activeTaskIds,
        evictableTaskIds: registry.evictableTaskIds,
      };
    },
  });
}

export type DshCleanApplyOutcome =
  | { outcome: "applied"; receipt: ContextCleanAppliedReceipt }
  | { outcome: "skipped"; reasons: string[] };

/**
 * Apply a scheduled clean to the live surface. Prepares via the shared bridge,
 * commits through R4, records the applied receipt. Non-"ready" prepare outcomes
 * and non-committed transactions leave the surface untouched.
 */
export async function applyScheduledDshClean(params: {
  session: CycleSession;
  executionBridge: ContextCleanerHostExecutionBridge;
  request: ContextCleanExecutionRequest;
  computeRevision: (session: AppendableSession) => string;
}): Promise<DshCleanApplyOutcome> {
  const prepared = await params.executionBridge.prepareScheduledClean(params.request);
  if (prepared.outcome !== "ready") {
    const reasons = "reasons" in prepared && prepared.reasons.length > 0 ? [...prepared.reasons] : [`clean_prepare_${prepared.outcome}`];
    return { outcome: "skipped", reasons };
  }

  const { execution } = prepared;
  const previousRevision = params.computeRevision(params.session);

  // mutationPlan target item ids (event-<seq>-<kind>) -> R4 eviction targets.
  const bySeq = new Map(
    describeEffectiveItems(params.session.events, params.session.surface.nodes).map((item) => [item.seq, item]),
  );
  const targets: EvictionTarget[] = [];
  for (const operation of execution.mutationPlan.operations) {
    for (const stableId of operation.targetItemIds) {
      const seq = parseSeq(stableId);
      if (seq === undefined || !bySeq.has(seq)) continue;
      const item = bySeq.get(seq)!;
      const stubText = `[cleaned: ${item.kind} @${seq}]`;
      const eventType = item.kind === "tool_result" ? "tool/result" as const : "user/message" as const;
      const data = eventType === "tool/result"
        ? { message: { role: "user", content: [{ type: "tool-result", text: stubText, ...(item.callIds?.[0] ? { toolCallId: item.callIds[0] } : {}) }], source: { kind: "plugin", plugin: "tokenpilot-dsh", cleaned: true } } }
        : { message: { role: item.role, content: [{ type: "text", text: stubText }], source: { kind: "plugin", plugin: "tokenpilot-dsh", cleaned: true } } };
      targets.push({ sourceEventSeq: seq, eventType, data });
    }
  }
  if (targets.length === 0) return { outcome: "skipped", reasons: ["clean_no_targets"] };

  const plan: EvictionPlan = {
    evictionId: execution.mutationPlan.planId,
    revision: previousRevision,
    targets,
  };
  const result = applyEvictionTransaction(params.session, plan, params.computeRevision);
  if (result.status !== "committed" && result.status !== "partial") {
    return { outcome: "skipped", reasons: [`clean_apply_${result.status}`] };
  }

  const applied = new Set(result.appliedSeqs);
  // Count only fully-applied operations, so a partial commit never over-reports.
  const appliedOperations = execution.mutationPlan.operations.filter((operation) =>
    operation.targetItemIds.length > 0
    && operation.targetItemIds.every((stableId) => {
      const seq = parseSeq(stableId);
      return seq !== undefined && applied.has(seq);
    }),
  );
  const appliedItemIds = appliedOperations.flatMap((operation) => operation.targetItemIds);
  const appliedSavedChars = appliedOperations.reduce((sum, operation) => sum + (operation.estimatedSavedChars ?? 0), 0);

  const scheduled = execution.scheduledReceipt;
  const receipt: ContextCleanAppliedReceipt = {
    schemaVersion: scheduled.schemaVersion,
    planId: scheduled.planId,
    hostId: DSH_HOST_ID,
    sessionId: scheduled.sessionId,
    selectedTaskIds: scheduled.selectedTaskIds,
    estimatedSavedTokens: scheduled.estimatedSavedTokens,
    estimatedSavedChars: scheduled.estimatedSavedChars,
    tokenCountMode: scheduled.tokenCountMode,
    deferredTaskIds: scheduled.deferredTaskIds,
    reasons: scheduled.reasons,
    updatedAt: new Date().toISOString(),
    status: "applied",
    appliedSavedTokens: scheduled.tokenCountMode === "chars_only" ? null : null,
    appliedSavedChars,
    fallbackUsed: false,
    evidence: {
      previousRevision,
      nextRevision: params.computeRevision(params.session),
      operationIds: appliedOperations.map((operation) => operation.id),
      itemIds: appliedItemIds,
    },
  };

  await params.executionBridge.recordCleanReceipt(receipt);
  return { outcome: "applied", receipt };
}
