/**
 * DSH session catalog for the context cleaner.
 *
 * Unlike the file-backed hosts, DSH's session truth source is `ctx.sessions`
 * (the native SessionStore). We enumerate it directly and derive `updatedAt`
 * from the latest durable event time when it yields a canonical timestamp.
 */

import type { ContextCleanerSession } from "@lightrsi/cleaner";

import type { DshLogEventWithMeta } from "../types.js";

/** The slice of the DSH SessionStore the catalog needs (ctx.sessions). */
export interface DshCleanerSessionStore {
  list(): readonly DshCatalogSession[];
  get(id: string): DshCatalogSession | undefined;
}

export interface DshCatalogSession {
  readonly id: string;
  readonly events: readonly DshLogEventWithMeta[];
  readonly surface: { readonly nodes: readonly number[]; readonly replaceGeneration: number };
}

function latestUpdatedAt(events: readonly DshLogEventWithMeta[]): string | undefined {
  let latest = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const time = (event as { time?: unknown }).time;
    const ms = typeof time === "number" ? time : typeof time === "string" ? Date.parse(time) : NaN;
    if (Number.isFinite(ms)) latest = Math.max(latest, ms);
  }
  if (!Number.isFinite(latest)) return undefined;
  const iso = new Date(latest).toISOString();
  return Date.parse(iso) === latest ? iso : undefined;
}

/** List DSH sessions as cleaner sessions, newest first. */
export function listDshCleanerSessions(sessions: DshCleanerSessionStore): ContextCleanerSession[] {
  return sessions
    .list()
    .map((session): ContextCleanerSession => {
      const updatedAt = latestUpdatedAt(session.events);
      return updatedAt ? { sessionId: session.id, updatedAt } : { sessionId: session.id };
    })
    .filter((session) => session.sessionId.trim().length > 0)
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
      || left.sessionId.localeCompare(right.sessionId),
    );
}
