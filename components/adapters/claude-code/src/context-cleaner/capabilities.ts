import type { CleanerHostCapabilities } from "@lightrsi/cleaner";

import { readLatestClaudeSnapshotRecord } from "../context-rewrite/snapshot-store.js";
import { listClaudeCleanerSessions } from "./session-catalog.js";
import { scheduleClaudeCleanerPlan } from "./scheduler.js";

const CLAUDE_HOST_ID = "claude-code";

/**
 * Claude Code frozen one-way cleaner capabilities (task doc §3.2/§3.3).
 *
 * Splits the host-owned half of the old bridge into three pure, stateDir-only
 * operations: read the canonical snapshot, enumerate sessions, and write the
 * Claude schedule pointer. Plan/receipt persistence and validation stay in the
 * shared control plane + control service (see composeContextCleanerHostBridge),
 * so this factory needs nothing but stateDir. The underlying functions are the
 * same ones the legacy bridge wraps, so behaviour is unchanged.
 */
export function createClaudeCodeCleanerCapabilities(params: {
  stateDir: string;
}): CleanerHostCapabilities {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("claude_clean_state_dir_missing");

  return {
    hostId: CLAUDE_HOST_ID,
    rewriteMode: "request_overlay",
    snapshotSource: {
      hostId: CLAUDE_HOST_ID,
      rewriteMode: "request_overlay",
      async readCleanSnapshot(sessionId) {
        const record = await readLatestClaudeSnapshotRecord(stateDir, sessionId);
        if (!record) throw new Error("claude_clean_snapshot_unavailable");
        return {
          ...record.snapshot,
          capturedAt: record.storedAt,
          ...(record.model ? { model: record.model } : {}),
          tokenCountMode: "chars_only",
          tokenCountMethod: "utf16_chars",
        };
      },
    },
    sessionCatalog: {
      listSessions() {
        return listClaudeCleanerSessions(stateDir);
      },
    },
    scheduleWriter: {
      writeSchedule(request) {
        return scheduleClaudeCleanerPlan({
          stateDir,
          sessionId: request.sessionId,
          cleanPlanId: request.cleanPlanId,
          baseRevision: request.baseRevision,
          selectedTaskIds: request.selectedTaskIds,
          scheduledAt: request.scheduledAt,
        });
      },
    },
  };
}
