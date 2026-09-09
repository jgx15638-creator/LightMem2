import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCanonicalState } from "@lightrsi/history";

import { createPluginContextEngine } from "./context-engine.js";

function createDeps(transcriptEntries: any[] | null) {
  const traceStages: string[] = [];
  return {
    traceStages,
    deps: {
      appendTaskStateTrace: async (_stateDir: string, record: any) => {
        traceStages.push(String(record.stage ?? ""));
      },
      appendEvictionVisualSnapshot: async () => undefined,
      readTranscriptEntriesForSession: async () => transcriptEntries,
      transcriptMessageStableId: (entry: any) => String(entry.id),
      asRecord: (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined,
      canonicalMessageTaskIds: () => [],
      contentToText: (value: unknown) => String(value ?? ""),
      dedupeStrings: (values: string[]) => [...new Set(values)],
      ensureContextSafeDetails: (_details: unknown, patch: Record<string, unknown>) => patch,
      extractPathLike: () => undefined,
      extractToolMessageText: (message: Record<string, unknown>) => String(message.content ?? ""),
      isToolResultLikeMessage: () => false,
      messageToolCallId: () => undefined,
      safeId: (value: string) => value,
    },
  };
}

test("context engine persists runtime messages when the transcript path is unavailable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-context-engine-runtime-fallback-"));
  try {
    const { deps } = createDeps(null);
    const engine = createPluginContextEngine({
      stateDir,
      moduleEnablement: { stabilizer: false, reduction: false, eviction: false },
      modules: { eviction: false },
      eviction: { enabled: false },
      memory: { enabled: false, autoDistill: false },
      taskStateEstimator: { evidenceMode: "three_state" },
    }, {}, deps);

    await engine.assemble({
      sessionId: "runtime-session",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });

    const state = await loadCanonicalState(stateDir, "runtime-session");
    assert.deepEqual(state?.messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    assert.equal(state?.seenMessageIds.length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("context engine declares fenced turns and commits them idempotently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-context-engine-commit-turn-"));
  try {
    const { deps } = createDeps(null);
    const engine = createPluginContextEngine({
      stateDir,
      moduleEnablement: { stabilizer: false, reduction: false, eviction: false },
      modules: { eviction: false },
      eviction: { enabled: false },
      memory: { enabled: false, autoDistill: false },
      taskStateEstimator: { evidenceMode: "three_state" },
    }, {}, deps);

    assert.deepEqual(engine.info.transcriptSemantics, {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });

    const params = {
      advancementKey: "advance-1",
      sessionId: "committed-session",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };
    assert.deepEqual(await engine.commitTurn(params), { status: "committed" });
    assert.deepEqual(await engine.commitTurn(params), { status: "duplicate" });

    const state = await loadCanonicalState(stateDir, params.sessionId);
    assert.deepEqual(state?.messages, params.messages);
    assert.equal(state?.seenMessageIds.length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("context engine skips eviction rewrite and traces when eviction is disabled", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-context-engine-disabled-"));
  try {
    const { deps, traceStages } = createDeps([
      { id: "m1", message: { role: "user", content: "hello" } },
    ]);
    const engine = createPluginContextEngine({
      stateDir,
      moduleEnablement: { stabilizer: false, reduction: false, eviction: false },
      modules: { eviction: false },
      eviction: { enabled: true },
      memory: { enabled: false, autoDistill: false },
      taskStateEstimator: { evidenceMode: "three_state" },
    }, {}, deps);

    assert.equal(engine.info.id, "tokenpilot");
    const assembled = await engine.assemble({ sessionId: "session-disabled", messages: [] });

    assert.deepEqual(assembled.messages, [{ role: "user", content: "hello" }]);
    assert.equal(traceStages.includes("canonical_state_rewrite"), false);
    assert.equal(traceStages.includes("history_eviction_completed"), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("context engine records enabled history eviction independently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-context-engine-enabled-"));
  try {
    const { deps, traceStages } = createDeps([
      { id: "m1", message: { role: "user", content: "hello" } },
    ]);
    const engine = createPluginContextEngine({
      stateDir,
      moduleEnablement: { stabilizer: false, reduction: false, eviction: true },
      modules: { eviction: true },
      eviction: {
        enabled: true,
        policy: "noop",
        minBlockChars: 256,
        replacementMode: "pointer_stub",
      },
      memory: { enabled: false, autoDistill: false },
      taskStateEstimator: { evidenceMode: "three_state" },
    }, { info: () => undefined }, deps);

    await engine.afterTurn({ sessionId: "session-enabled", messages: [] });

    assert.equal(traceStages.includes("canonical_state_rewrite"), true);
    assert.equal(traceStages.includes("history_eviction_completed"), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
