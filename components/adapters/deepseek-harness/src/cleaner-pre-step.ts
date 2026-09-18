/**
 * Context Cleaner request-lifecycle orchestration for DeepSeek Harness.
 *
 * This runs before automatic eviction and native compaction. A successful
 * Cleaner claim marks the current pre-step so automatic eviction can skip the
 * same surface; both systems therefore never rewrite the same request twice.
 */

import { loadSessionTaskRegistry } from "@lightrsi/history";
import {
  readContextCleanPlan,
  readContextCleanReceipt,
} from "@lightrsi/cleaner";

import type { TokenPilotDshConfig } from "./config.js";
import {
  applyScheduledDshClean,
  createDshCleanerExecutionBridge,
} from "./context-cleaner/runtime.js";
import {
  claimDshCleanerSchedule,
  finalizeDshCleanerSchedule,
  readDshCleanerSchedule,
  type DshCleanerClaimedRecord,
} from "./context-cleaner/scheduler.js";
import { surfaceRevision, type DshCleanSnapshotSession } from "./context-cleaner/snapshot.js";
import type { DshCleanerSessionStore } from "./context-cleaner/session-catalog.js";
import type { CycleSession } from "./eviction-cycle.js";
import type { DshPluginContext, DshPreStepPayload } from "./types.js";

/** Request-local signal shared with the automatic eviction handler. */
export type DshCleanerPreStepState = {
  markClaimed(payload: DshPreStepPayload): void;
  wasClaimed(payload: DshPreStepPayload): boolean;
};

export function createDshCleanerPreStepState(): DshCleanerPreStepState {
  const claimed = new WeakSet<object>();
  return {
    markClaimed(payload) { claimed.add(payload); },
    wasClaimed(payload) { return claimed.has(payload); },
  };
}

function sessionStore(session: DshCleanSnapshotSession): DshCleanerSessionStore {
  return {
    list: () => [session],
    get: (sessionId) => sessionId === session.id ? session : undefined,
  };
}

function terminalStatus(receiptStatus: string): "applied" | "stale" | "cancelled" | "failed" | undefined {
  return ["applied", "stale", "cancelled", "failed"].includes(receiptStatus)
    ? receiptStatus as "applied" | "stale" | "cancelled" | "failed"
    : undefined;
}

function sameTaskIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((taskId) => right.includes(taskId));
}

/**
 * The local pointer can legitimately exist while the final shared
 * `approved -> scheduled` transition is being retried. Never claim that
 * pointer until both durable shared records confirm the same scheduled work.
 */
async function isSharedScheduleReady(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: readonly string[];
}): Promise<boolean> {
  const [plan, receipt] = await Promise.all([
    readContextCleanPlan({ stateDir: params.stateDir, planId: params.cleanPlanId }),
    readContextCleanReceipt({ stateDir: params.stateDir, planId: params.cleanPlanId }),
  ]);
  if (plan.bypassed || receipt.bypassed || !plan.value || !receipt.value) return false;
  return plan.value.status === "scheduled"
    && plan.value.plan.hostId === "deepseek-harness"
    && plan.value.plan.sessionId === params.sessionId
    && plan.value.plan.baseRevision === params.baseRevision
    && receipt.value.status === "scheduled"
    && receipt.value.hostId === "deepseek-harness"
    && receipt.value.sessionId === params.sessionId
    && sameTaskIds(receipt.value.selectedTaskIds, params.selectedTaskIds);
}

/** Attach scheduled Cleaner execution at the front of DSH's pre-step waterfall. */
export function registerDshCleanerPreStep(
  ctx: DshPluginContext,
  config: TokenPilotDshConfig,
  state: DshCleanerPreStepState,
): void {
  const stateDir = config.stateDir?.trim();
  if (!config.enabled || !stateDir) return;

  ctx.on("agent/pre-step", async (payload, next) => {
    let claim: DshCleanerClaimedRecord | undefined;
    try {
      if (payload.signal.aborted) return next();

      const session = payload.agent.session;
      const scheduled = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      if (scheduled.outcome !== "ready") return next();

      if (!await isSharedScheduleReady({
        stateDir,
        sessionId: session.id,
        cleanPlanId: scheduled.record.cleanPlanId,
        baseRevision: scheduled.record.baseRevision,
        selectedTaskIds: scheduled.record.selectedTaskIds,
      })) {
        return next();
      }

      const claimed = await claimDshCleanerSchedule({
        stateDir,
        sessionId: session.id,
        cleanPlanId: scheduled.record.cleanPlanId,
      });
      if (claimed.outcome !== "claimed") return next();
      claim = claimed.record;
      // A claim is enough to suppress automatic eviction for this request. If
      // revalidation later fails, the Cleaner records a terminal receipt but
      // must not let a second surface-rewriter race it in the same waterfall.
      state.markClaimed(payload);

      const executionBridge = createDshCleanerExecutionBridge({
        stateDir,
        sessions: sessionStore(session as unknown as DshCleanSnapshotSession),
        loadRegistry: (sessionId) => loadSessionTaskRegistry(stateDir, sessionId),
      });
      const outcome = await applyScheduledDshClean({
        session: session as unknown as CycleSession,
        executionBridge,
        request: {
          cleanPlanId: claim.cleanPlanId,
          sessionId: session.id,
          baseRevision: claim.baseRevision,
          selectedTaskIds: [...claim.selectedTaskIds],
        },
        computeRevision: surfaceRevision,
      });

      if (outcome.outcome === "applied") {
        ctx.tokenMeter.measure(session);
        await finalizeDshCleanerSchedule({
          stateDir,
          sessionId: session.id,
          cleanPlanId: claim.cleanPlanId,
          receiptStatus: "applied",
          reasons: outcome.receipt.reasons,
          updatedAt: outcome.receipt.updatedAt,
          claimId: claim.claimId,
        });
      } else if (outcome.outcome === "terminal") {
        const status = terminalStatus(outcome.receipt.status);
        if (status) {
          await finalizeDshCleanerSchedule({
            stateDir,
            sessionId: session.id,
            cleanPlanId: claim.cleanPlanId,
            receiptStatus: status,
            reasons: outcome.receipt.reasons,
            updatedAt: outcome.receipt.updatedAt,
            claimId: claim.claimId,
          });
        }
      } else if (outcome.outcome === "stale") {
        await finalizeDshCleanerSchedule({
          stateDir,
          sessionId: session.id,
          cleanPlanId: claim.cleanPlanId,
          receiptStatus: "stale",
          reasons: outcome.receipt?.reasons ?? outcome.reasons,
          ...(outcome.receipt ? { updatedAt: outcome.receipt.updatedAt } : {}),
          claimId: claim.claimId,
        });
      } else if (outcome.outcome === "failed") {
        if (outcome.surfaceChanged) ctx.tokenMeter.measure(session);
        await finalizeDshCleanerSchedule({
          stateDir,
          sessionId: session.id,
          cleanPlanId: claim.cleanPlanId,
          receiptStatus: "failed",
          reasons: outcome.receipt?.reasons ?? outcome.reasons,
          ...(outcome.receipt ? { updatedAt: outcome.receipt.updatedAt } : {}),
          claimId: claim.claimId,
        });
      } else if (outcome.outcome === "skipped") {
        // A claim has already been persisted. Preserve at-most-once semantics
        // even for an unexpected non-terminal prepare outcome.
        await finalizeDshCleanerSchedule({
          stateDir,
          sessionId: session.id,
          cleanPlanId: claim.cleanPlanId,
          receiptStatus: "failed",
          reasons: outcome.reasons.length > 0 ? outcome.reasons : ["clean_prepare_skipped"],
          claimId: claim.claimId,
        });
      }
    } catch {
      if (claim) {
        await finalizeDshCleanerSchedule({
          stateDir,
          sessionId: payload.agent.session.id,
          cleanPlanId: claim.cleanPlanId,
          receiptStatus: "failed",
          reasons: ["dsh_cleaner_runtime_error"],
          claimId: claim.claimId,
        }).catch(() => undefined);
      }
      // The Cleaner is an optimization. State/session/registry failures must
      // preserve DSH's original agent request and never block native compaction.
    }
    return next();
  }, { prepend: true });
}
