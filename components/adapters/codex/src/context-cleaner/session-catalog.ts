import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { sessionStateRoot } from "@lightrsi/host-adapter";
import type { ContextCleanerSession } from "@lightrsi/cleaner";

import { loadCodexSessionSnapshot } from "../session-state.js";

const CLEANER_INVOCATION_MAX_AGE_MS = 60_000;

function cleanerToolName(value: string | undefined): boolean {
  const toolName = value?.trim() ?? "";
  return /^(?:(?:mcp__)?lightrsi_cleaner(?:__|\.))?lightrsi_clean$/i.test(toolName);
}

export async function listCodexCleanerSessions(
  stateDir: string,
): Promise<ContextCleanerSession[]> {
  const directory = join(sessionStateRoot(stateDir), "sessions");
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const sessions = await Promise.all(names.map(async (name): Promise<ContextCleanerSession | undefined> => {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(basename(name, ".json"));
    } catch {
      return undefined;
    }
    if (!sessionId.trim()) return undefined;
    const snapshot = await loadCodexSessionSnapshot(stateDir, sessionId);
    if (!snapshot || snapshot.sessionId !== sessionId) return undefined;
    return { sessionId, updatedAt: snapshot.updatedAt };
  }));

  return sessions
    .filter((session): session is ContextCleanerSession => session !== undefined)
    .sort((left, right) => (
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
      || left.sessionId.localeCompare(right.sessionId)
    ));
}

export async function resolveCodexCleanerInvocationSessionId(
  stateDir: string,
  now = Date.now(),
): Promise<string | undefined> {
  const sessions = await listCodexCleanerSessions(stateDir);
  for (const session of sessions) {
    const snapshot = await loadCodexSessionSnapshot(stateDir, session.sessionId);
    if (
      snapshot?.lastHookEvent !== "PreToolUse"
      || !cleanerToolName(snapshot.lastToolName)
      || !snapshot.codexSessionId?.trim()
    ) {
      continue;
    }
    const updatedAt = Date.parse(snapshot.updatedAt);
    if (Number.isFinite(updatedAt) && now - updatedAt >= 0 && now - updatedAt <= CLEANER_INVOCATION_MAX_AGE_MS) {
      return session.sessionId;
    }
  }
  return undefined;
}
