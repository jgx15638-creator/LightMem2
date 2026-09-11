/**
 * DSH cleaner schedule pointer (unit 4a).
 *
 * The shared clean stores are read-by-id only, so a host needs a session →
 * current-scheduled-plan pointer. This is a lean, trigger-agnostic version of
 * the claude scheduler: one atomic JSON file per session under the shared
 * stateDir. It records only what observability and the (future) apply-trigger
 * need — no overlay/rebase-specific fields, no lock journal yet.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DSH_CLEANER_SCHEDULE_SCHEMA = "lightrsi.deepseek-harness.cleaner-schedule/v1" as const;
const DSH_CLEANER_HOST_ID = "deepseek-harness" as const;

type ScheduleIdentity = {
  schema: typeof DSH_CLEANER_SCHEDULE_SCHEMA;
  hostId: typeof DSH_CLEANER_HOST_ID;
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: string[];
  scheduledAt: string;
  updatedAt: string;
};

export type DshCleanerScheduledRecord = ScheduleIdentity & { status: "scheduled" };
export type DshCleanerTerminalRecord = ScheduleIdentity & {
  status: "terminal";
  receiptStatus: "stale" | "cancelled" | "failed";
  reasons: string[];
};
export type DshCleanerScheduleRecord = DshCleanerScheduledRecord | DshCleanerTerminalRecord;

export type DshCleanerScheduleReadResult =
  | { outcome: "missing"; reasons: [] }
  | { outcome: "ready"; record: DshCleanerScheduledRecord; reasons: [] }
  | { outcome: "terminal"; record: DshCleanerTerminalRecord; reasons: [] }
  | { outcome: "bypassed"; reasons: string[] };

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function uniqueNonBlankStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonBlank) && new Set(value).size === value.length;
}

function schedulePath(stateDir: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(stateDir, "cleaner-schedule", `${digest}.json`);
}

function validate(parsed: unknown): DshCleanerScheduleRecord | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== DSH_CLEANER_SCHEDULE_SCHEMA
    || record.hostId !== DSH_CLEANER_HOST_ID
    || !nonBlank(record.sessionId)
    || !nonBlank(record.cleanPlanId)
    || !nonBlank(record.baseRevision)
    || !uniqueNonBlankStrings(record.selectedTaskIds)
    || !canonicalTimestamp(record.scheduledAt)
    || !canonicalTimestamp(record.updatedAt)) {
    return undefined;
  }
  if (record.status === "scheduled") return record as unknown as DshCleanerScheduledRecord;
  if (record.status === "terminal"
    && ["stale", "cancelled", "failed"].includes(record.receiptStatus as string)
    && Array.isArray(record.reasons)) {
    return record as unknown as DshCleanerTerminalRecord;
  }
  return undefined;
}

/** Atomically write the schedule pointer for a session (temp file + rename). */
export async function writeDshCleanerSchedule(params: {
  stateDir: string;
  record: DshCleanerScheduleRecord;
}): Promise<void> {
  const path = schedulePath(params.stateDir, params.record.sessionId);
  await mkdir(join(params.stateDir, "cleaner-schedule"), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(params.record)}\n`, "utf8");
  await rename(tmp, path);
}

/** Read the current schedule pointer for a session. Missing file → "missing". */
export async function readDshCleanerSchedule(params: {
  stateDir: string;
  sessionId: string;
}): Promise<DshCleanerScheduleReadResult> {
  let raw: string;
  try {
    raw = await readFile(schedulePath(params.stateDir, params.sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "missing", reasons: [] };
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_read_error"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_malformed"] };
  }
  const record = validate(parsed);
  if (!record) return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_invalid"] };
  if (record.sessionId !== params.sessionId) return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_session_mismatch"] };
  return record.status === "scheduled"
    ? { outcome: "ready", record, reasons: [] }
    : { outcome: "terminal", record, reasons: [] };
}
