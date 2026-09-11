/**
 * DSH cleaner observability (unit 4b).
 *
 * Reports the current scheduled clean's state for doctor/session-report:
 * plan-store availability, pending plan, last receipt status, estimated /
 * scheduled / applied savings, and fallback count — the same surface PR 64
 * added for the other hosts. Read-by-id only: the session pointer supplies the
 * plan id; the shared stores are never scanned.
 */

import {
  readContextCleanPlan,
  readContextCleanReceipt,
  type ContextCleanReceipt,
} from "@lightrsi/cleaner";
import type { ModelContextRewriteMode } from "@lightrsi/host-adapter";

import { readDshCleanerSchedule } from "./scheduler.js";

const REWRITE_MODE: ModelContextRewriteMode = "canonical";

type CleanerSavings = { tokens: number | null; chars: number };

export type DshCleanerObservability = {
  availability: "available" | "degraded";
  planStore: "available" | "missing" | "unknown";
  pendingPlan: "none" | "scheduled" | "unknown";
  lastReceipt: ContextCleanReceipt["status"] | "none" | "unknown";
  rewriteMode: ModelContextRewriteMode;
  savings: { estimated?: CleanerSavings; scheduled?: CleanerSavings; applied?: CleanerSavings };
  fallbackCount: number | null;
};

function degraded(planStore: DshCleanerObservability["planStore"]): DshCleanerObservability {
  return { availability: "degraded", planStore, pendingPlan: "unknown", lastReceipt: "unknown", rewriteMode: REWRITE_MODE, savings: {}, fallbackCount: null };
}

export function emptyDshCleanerObservability(): DshCleanerObservability {
  return { availability: "available", planStore: "unknown", pendingPlan: "none", lastReceipt: "none", rewriteMode: REWRITE_MODE, savings: {}, fallbackCount: 0 };
}

function estimatedSavings(receipt: ContextCleanReceipt): CleanerSavings {
  return { tokens: receipt.estimatedSavedTokens, chars: receipt.estimatedSavedChars };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

/** Read observability for a session's current scheduled clean. */
export async function readDshCleanerObservability(params: {
  stateDir: string;
  sessionId: string;
}): Promise<DshCleanerObservability> {
  const schedule = await readDshCleanerSchedule(params);
  if (schedule.outcome === "bypassed") return degraded("unknown");
  if (schedule.outcome === "missing") return emptyDshCleanerObservability();

  const cleanPlanId = schedule.record.cleanPlanId;
  const plan = await readContextCleanPlan({ stateDir: params.stateDir, planId: cleanPlanId });
  if (plan.bypassed) return degraded("unknown");
  if (!plan.value) return degraded("missing");
  if (plan.value.plan.hostId !== "deepseek-harness" || plan.value.plan.sessionId !== params.sessionId) {
    return degraded("unknown");
  }

  const receipt = await readContextCleanReceipt({ stateDir: params.stateDir, planId: cleanPlanId });
  if (receipt.bypassed) return degraded("unknown");
  if (!receipt.value) return { ...degraded("available") };

  // The receipt must match the pointer's frozen identity, and the plan/receipt
  // states must agree — otherwise the pointer is stale and we report degraded.
  const value = receipt.value;
  const identityOk = value.planId === cleanPlanId
    && value.hostId === "deepseek-harness"
    && value.sessionId === params.sessionId
    && plan.value.plan.baseRevision === schedule.record.baseRevision
    && sameStringSet(value.selectedTaskIds, schedule.record.selectedTaskIds)
    && plan.value.status === value.status;
  if (!identityOk) return degraded("available");

  const savings: DshCleanerObservability["savings"] = { estimated: estimatedSavings(value) };
  if (value.status === "scheduled") {
    savings.scheduled = estimatedSavings(value);
  } else if (value.status === "applied") {
    savings.applied = { tokens: value.appliedSavedTokens, chars: value.appliedSavedChars };
  }

  return {
    availability: "available",
    planStore: "available",
    pendingPlan: value.status === "scheduled" ? "scheduled" : "none",
    lastReceipt: value.status,
    rewriteMode: REWRITE_MODE,
    savings,
    fallbackCount: value.fallbackUsed ? 1 : 0,
  };
}
