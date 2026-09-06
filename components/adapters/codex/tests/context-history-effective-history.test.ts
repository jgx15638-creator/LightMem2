import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCodexRequestJournalEntry,
  appendCodexResponseJournalEntry,
  buildCodexEffectiveHistory,
  buildCodexEffectiveHistoryView,
  codexContextHistoryJournalPath,
  resolveCodexEffectiveHistoryCurrentInputClosures,
  type JsonObject,
} from "../src/context-history/index.js";

async function withTempState(
  fn: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-effective-history-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function sseBlock(event: string | undefined, data: JsonObject | string): string {
  const lines = event ? [`event: ${event}`] : [];
  const text = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of text.split("\n")) lines.push(`data: ${line}`);
  lines.push("");
  return lines.join("\n");
}

function sseStream(...blocks: string[]): string {
  return blocks.join("\n");
}

test("CDH-04 Effective History Builder marks an orphan incomplete response after the committed head as incomplete", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "root" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      response: { id: "resp-1", output: [] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      rawStreamText: sseStream(
        sseBlock("response.created", { response: { id: "resp-orphan" } }),
      ),
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-1",
    });

    assert.equal(history.incomplete, true);
    assert.equal(history.replayableItems.length, 1);
  });
});

test("CDH-04 Effective History Builder preserves ordered turns when a provider reuses response ids", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-reused-response-id";
    for (let turn = 1; turn <= 3; turn += 1) {
      const requestId = `request-${turn}`;
      await appendCodexRequestJournalEntry({
        stateDir,
        sessionId,
        requestId,
        turnOrdinal: turn,
        payload: {
          ...(turn > 1 ? { previous_response_id: "resp-provider-reused" } : {}),
          input: [{ role: "user", content: `reused id turn ${turn}` }],
        },
        status: "completed",
      });
      await appendCodexResponseJournalEntry({
        stateDir,
        sessionId,
        requestId,
        response: {
          id: "resp-provider-reused",
          output: [{ type: "message", role: "assistant", content: `answer ${turn}` }],
        },
        previousResponseId: turn > 1 ? "resp-provider-reused" : null,
        status: "completed",
      });
    }

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: "resp-provider-reused",
    });

    assert.equal(history.incomplete, false);
    assert.match(JSON.stringify(history.replayableItems), /reused id turn 1/);
    assert.match(JSON.stringify(history.replayableItems), /reused id turn 2/);
    assert.match(JSON.stringify(history.replayableItems), /reused id turn 3/);
  });
});

test("CDH-04 Effective History View builds deterministic journal turn sidecars", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-turn-sidecar";
    for (let turn = 1; turn <= 2; turn += 1) {
      await appendCodexRequestJournalEntry({
        stateDir,
        sessionId,
        requestId: `request-${turn}`,
        turnOrdinal: turn,
        payload: {
          ...(turn > 1 ? { previous_response_id: `resp-${turn - 1}` } : {}),
          input: [{ id: `input-${turn}`, role: "user", content: `turn ${turn}` }],
        },
        status: "completed",
      });
      await appendCodexResponseJournalEntry({
        stateDir,
        sessionId,
        requestId: `request-${turn}`,
        response: {
          id: `resp-${turn}`,
          previous_response_id: turn > 1 ? `resp-${turn - 1}` : null,
          output: [{ id: `output-${turn}`, type: "message", role: "assistant", content: `answer ${turn}` }],
        },
        status: "completed",
      });
    }

    const first = await buildCodexEffectiveHistoryView({ stateDir, sessionId });
    const restarted = await buildCodexEffectiveHistoryView({ stateDir, sessionId });
    const legacy = await buildCodexEffectiveHistory({ stateDir, sessionId });

    assert.equal(first.semanticComplete, true);
    assert.deepEqual(first.reasonCodes, []);
    assert.deepEqual(first.turns.map(({ turnSeq, turnAbsId }) => ({ turnSeq, turnAbsId })), [
      { turnSeq: 1, turnAbsId: `${sessionId}:t1` },
      { turnSeq: 2, turnAbsId: `${sessionId}:t2` },
    ]);
    assert.deepEqual(first.turns, restarted.turns);
    assert.deepEqual(first.history, legacy);
    assert.equal(first.history.revision, legacy.revision);

    const allItemIds = new Set([
      ...first.history.replayableItems,
      ...first.history.observationOnlyItems,
      ...first.history.deferredItems,
    ].map((entry) => entry.stableItemId));
    for (const turn of first.turns) {
      assert.equal(turn.inputItemIds.length, 1);
      assert.equal(turn.outputItemIds.length, 1);
      assert.equal(turn.inputItemIds.every((itemId) => allItemIds.has(itemId)), true);
      assert.equal(turn.outputItemIds.every((itemId) => allItemIds.has(itemId)), true);
    }
  });
});

test("CDH-04 Effective History View marks the current request semantic-only incomplete", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-current-request";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      turnOrdinal: 1,
      payload: { input: [{ role: "user", content: "committed" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: { id: "resp-1", output: [{ type: "message", role: "assistant", content: "done" }] },
      status: "completed",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-current",
      turnOrdinal: 2,
      payload: { previous_response_id: "resp-1", input: [{ role: "user", content: "current" }] },
      status: "pending",
    });

    const view = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "resp-1",
      currentRequestId: "request-current",
    });

    assert.equal(view.history.incomplete, false);
    assert.equal(view.semanticComplete, false);
    assert.deepEqual(view.reasonCodes, ["journal_current_request_uncommitted"]);
    assert.deepEqual(view.turns.map((turn) => turn.turnSeq), [1]);
  });
});

test("CDH-04 Effective History View fails closed on conflicting journal turn sequences", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-turn-conflict";
    for (let index = 1; index <= 2; index += 1) {
      const requestId = `request-${index}`;
      await appendCodexRequestJournalEntry({
        stateDir,
        sessionId,
        requestId,
        turnOrdinal: 1,
        payload: {
          ...(index > 1 ? { previous_response_id: "resp-1" } : {}),
          input: [{ role: "user", content: requestId }],
        },
        status: "completed",
      });
      await appendCodexResponseJournalEntry({
        stateDir,
        sessionId,
        requestId,
        response: {
          id: `resp-${index}`,
          previous_response_id: index > 1 ? "resp-1" : null,
          output: [],
        },
        status: "completed",
      });
    }

    const view = await buildCodexEffectiveHistoryView({ stateDir, sessionId });
    assert.equal(view.history.incomplete, false);
    assert.equal(view.semanticComplete, false);
    assert.equal(view.reasonCodes.includes("journal_turn_sequence_conflict"), true);
  });
});

test("CDH-04 Effective History View reports malformed journal records with a finite reason", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-malformed-record";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-valid",
      payload: { input: [{ role: "user", content: "valid prefix" }] },
      status: "completed",
    });
    await appendFile(
      codexContextHistoryJournalPath(stateDir, sessionId),
      "{\"truncated\":\n",
      "utf8",
    );

    const view = await buildCodexEffectiveHistoryView({ stateDir, sessionId });

    assert.equal(view.semanticComplete, false);
    assert.equal(view.reasonCodes.includes("journal_malformed_lines"), true);
    assert.equal(view.reasonCodes.includes("history_replay_incomplete"), true);
  });
});

test("CDH-04 Effective History View fails closed when its journal cannot be read", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-effective-read-error";
    await mkdir(codexContextHistoryJournalPath(stateDir, sessionId), { recursive: true });

    const view = await buildCodexEffectiveHistoryView({ stateDir, sessionId });

    assert.equal(view.history.incomplete, true);
    assert.equal(view.semanticComplete, false);
    assert.equal(view.reasonCodes.includes("journal_read_error"), true);
    assert.equal(view.reasonCodes.includes("history_replay_incomplete"), true);
  });
});

test("CDH-04 Effective History View keeps stateless continuation roots single and deterministic", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-stateless-root";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-old-root",
      turnOrdinal: 1,
      payload: { input: [{ id: "old-input", role: "user", content: "old turn" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-old-root",
      response: { id: "resp-old-root", output: [{ id: "old-output", role: "assistant", content: "old answer" }] },
      status: "completed",
    });
    const replayInput = [
      { id: "old-input", role: "user", content: "old turn" },
      { id: "old-output", role: "assistant", content: "old answer" },
      { id: "current-input", role: "user", content: "current turn" },
    ];
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-stateless-root",
      turnOrdinal: 2,
      payload: {
        previous_response_id: "resp-old-root",
        input: [{ id: "current-input", role: "user", content: "current turn" }],
      },
      committedInputItems: replayInput,
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-stateless-root",
      previousResponseId: null,
      response: {
        id: "resp-stateless-root",
        previous_response_id: null,
        output: [{ id: "current-output", role: "assistant", content: "current answer" }],
      },
      status: "completed",
    });

    const first = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "resp-stateless-root",
    });
    const restarted = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "resp-stateless-root",
    });

    assert.equal(first.semanticComplete, true);
    assert.deepEqual(first.turns.map((turn) => ({
      turnSeq: turn.turnSeq,
      inputCount: turn.inputItemIds.length,
      outputCount: turn.outputItemIds.length,
    })), [
      { turnSeq: 1, inputCount: 1, outputCount: 1 },
      { turnSeq: 2, inputCount: 1, outputCount: 1 },
    ]);
    assert.deepEqual(first.turns, restarted.turns);
    const attributedItemIds = first.turns.flatMap((turn) => [
      ...turn.inputItemIds,
      ...turn.outputItemIds,
    ]);
    assert.equal(attributedItemIds.length, 4);
    assert.equal(new Set(attributedItemIds).size, attributedItemIds.length);
  });
});

test("CDH-04 Effective History View attributes committed replay input to the semantic turn", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-committed-input-attribution";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      turnOrdinal: 1,
      payload: {
        input: [{ id: "current-input", role: "user", content: "current" }],
      },
      committedInputItems: [
        { id: "prior-input", role: "user", content: "prior context" },
        { id: "current-input", role: "user", content: "current" },
      ],
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: {
        id: "response-1",
        output: [{ id: "assistant-1", type: "message", role: "assistant", content: "answer" }],
      },
      status: "completed",
    });

    const view = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "response-1",
    });

    assert.equal(view.semanticComplete, true);
    assert.deepEqual(view.turns.map((turn) => ({
      inputCount: turn.inputItemIds.length,
      outputCount: turn.outputItemIds.length,
    })), [{ inputCount: 2, outputCount: 1 }]);
  });
});

test("CDH-04 Effective History View fails closed on ambiguous cross-turn replay attribution", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-ambiguous-stateless-root";
    for (let turn = 1; turn <= 2; turn += 1) {
      await appendCodexRequestJournalEntry({
        stateDir,
        sessionId,
        requestId: `request-${turn}`,
        turnOrdinal: turn,
        payload: {
          ...(turn > 1 ? { previous_response_id: "resp-1" } : {}),
          input: [{ id: "provider-reused-input", role: "user", content: "same native item" }],
        },
        ...(turn === 2 ? {
          committedInputItems: [
            { id: "provider-reused-input", role: "user", content: "same native item" },
          ],
        } : {}),
        status: "completed",
      });
      await appendCodexResponseJournalEntry({
        stateDir,
        sessionId,
        requestId: `request-${turn}`,
        ...(turn === 2 ? { previousResponseId: null } : {}),
        response: {
          id: `resp-${turn}`,
          previous_response_id: turn === 2 ? null : undefined,
          output: [],
        },
        status: "completed",
      });
    }

    let legacyBootstrapCalled = false;
    const view = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "resp-2",
      async rolloutParserBootstrap() {
        legacyBootstrapCalled = true;
        return null;
      },
    });

    assert.equal(view.history.incomplete, false);
    assert.equal(view.semanticComplete, false);
    assert.equal(view.reasonCodes.includes("journal_turn_attribution_incomplete"), true);
    assert.equal(legacyBootstrapCalled, false);
  });
});

test("CDH-04 Effective History Builder builds proxy journal history in strict order with replay and observation split", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      payload: {
        model: "gpt-5.4-mini",
        input: [
          { role: "developer", content: "stable instructions" },
          { role: "user", content: "turn one" },
        ],
      },
      status: "completed",
      observedAt: "2026-07-24T10:00:00.000Z",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      response: {
        id: "resp-1",
        output: [
          { id: "msg-1", type: "message", role: "assistant", content: [{ type: "output_text", text: "need tool" }] },
          { id: "fc-1", type: "function_call", call_id: "call-1", name: "run_tests", arguments: "{}" },
          { id: "ws-1", type: "web_search_call", query: "observed but not replayed" },
        ],
      },
      observedAt: "2026-07-24T10:00:01.000Z",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-2",
      payload: {
        model: "gpt-5.4-mini",
        previous_response_id: "resp-1",
        input: [
          { type: "function_call_output", call_id: "call-1", output: "{\"passed\":true}" },
          { role: "user", content: "turn two" },
        ],
      },
      status: "completed",
      observedAt: "2026-07-24T10:00:02.000Z",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-2",
      response: {
        id: "resp-2",
        previous_response_id: "resp-1",
        output: [
          { id: "msg-2", type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        ],
      },
      status: "completed",
      observedAt: "2026-07-24T10:00:03.000Z",
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-1",
      headResponseId: "resp-2",
    });

    assert.equal(history.source, "proxy_journal");
    assert.equal(history.incomplete, false);
    assert.equal(history.unresolvedCallIds.length, 0);
    assert.equal(history.observationOnlyItems.length, 0);
    assert.deepEqual(
      history.replayableItems.map((entry) => entry.item.type ?? entry.item.role),
      ["developer", "user", "message", "function_call", "web_search_call", "function_call_output", "user", "message"],
    );
    assert.match(history.revision, /^rev-[0-9a-f]+$/);
  });
});

test("CDH-04 Effective History Builder excludes failed requests and abandoned response branches", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "root-request",
      turnOrdinal: 1,
      payload: { input: [{ role: "user", content: "root" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "root-request",
      response: { id: "resp-root", output: [] },
      status: "completed",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "failed-request",
      turnOrdinal: 2,
      payload: {
        previous_response_id: "resp-root",
        input: [{ role: "user", content: "FAILED_BRANCH_SENTINEL" }],
      },
      status: "failed",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "branch-a-request",
      turnOrdinal: 3,
      payload: {
        previous_response_id: "resp-root",
        input: [{ role: "user", content: "BRANCH_A_SENTINEL" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "branch-a-request",
      response: { id: "resp-a", previous_response_id: "resp-root", output: [] },
      status: "completed",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "branch-b-request",
      turnOrdinal: 4,
      payload: {
        previous_response_id: "resp-root",
        input: [{ role: "user", content: "BRANCH_B_SENTINEL" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "branch-b-request",
      response: { id: "resp-b", previous_response_id: "resp-root", output: [] },
      status: "completed",
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-1",
      headResponseId: "resp-a",
    });
    const replayed = JSON.stringify(history.replayableItems);

    assert.match(replayed, /BRANCH_A_SENTINEL/);
    assert.doesNotMatch(replayed, /BRANCH_B_SENTINEL|FAILED_BRANCH_SENTINEL/);
    assert.equal(history.incomplete, false);
  });
});

test("CDH-04 Effective History Builder keeps synthetic item ids stable across request state events", async () => {
  async function buildWithStates(states: Array<"pending" | "completed">): Promise<string[]> {
    let ids: string[] = [];
    await withTempState(async (stateDir) => {
      for (const status of states) {
        await appendCodexRequestJournalEntry({
          stateDir,
          sessionId: "codex-session-1",
          requestId: "request-1",
          turnOrdinal: 1,
          payload: { input: [{ role: "user", content: "stable synthetic item" }] },
          status,
        });
      }
      await appendCodexResponseJournalEntry({
        stateDir,
        sessionId: "codex-session-1",
        requestId: "request-1",
        response: { id: "resp-1", output: [] },
        status: "completed",
      });
      ids = (await buildCodexEffectiveHistory({
        stateDir,
        sessionId: "codex-session-1",
        headResponseId: "resp-1",
      })).replayableItems.map((entry) => entry.stableItemId);
    });
    return ids;
  }

  assert.deepEqual(await buildWithStates(["completed"]), await buildWithStates(["pending", "completed"]));
});

test("CDH-04 Effective History Builder keeps synthetic item ids stable across stateless replay turns", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-synthetic-stateless-replay";
    const firstUser = { role: "user", content: "first synthetic request" };
    const firstAssistant = { role: "assistant", content: "first synthetic answer" };

    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      turnOrdinal: 1,
      payload: { input: [firstUser] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: { id: "response-1", output: [firstAssistant] },
      status: "completed",
    });
    const beforeReplay = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "response-1",
    });
    const frozenIds = beforeReplay.history.replayableItems.map((item) => item.stableItemId);

    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-2",
      turnOrdinal: 2,
      payload: {
        previous_response_id: "response-1",
        input: [{ role: "user", content: "second synthetic request" }],
      },
      committedInputItems: [
        firstUser,
        firstAssistant,
        { role: "user", content: "second synthetic request" },
      ],
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-2",
      previousResponseId: null,
      response: {
        id: "response-2",
        previous_response_id: null,
        output: [{ role: "assistant", content: "second synthetic answer" }],
      },
      status: "completed",
    });

    const afterReplay = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "response-2",
    });
    const replayedIds = new Set(afterReplay.history.replayableItems.map((item) => item.stableItemId));
    assert.equal(afterReplay.semanticComplete, true);
    assert.deepEqual(afterReplay.reasonCodes, []);
    assert.ok(frozenIds.every((itemId) => replayedIds.has(itemId)));
  });
});

test("CDH-04 Effective History Builder delegates to rollout parser bootstrap when proxy journal is incomplete", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      rawStreamText: sseStream(
        sseBlock("response.created", { response: { id: "resp-incomplete" } }),
        sseBlock("response.output_text.delta", { item_id: "msg-1", delta: "partial" }),
      ),
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-1",
      async rolloutParserBootstrap() {
        return {
          revision: "rollout-rev-1",
          replayableItems: [
            {
              stableItemId: "rollout-user-1",
              nativeId: "rollout-msg-1",
              item: { role: "user", content: "bootstrapped from rollout parser fake" },
            },
          ],
          observationOnlyItems: [],
          deferredItems: [],
          unresolvedCallIds: [],
          source: "rollout_bootstrap",
          incomplete: false,
        };
      },
    });

    assert.equal(history.source, "rollout_bootstrap");
    assert.equal(history.revision, "rollout-rev-1");
    assert.equal(history.replayableItems[0]?.item.content, "bootstrapped from rollout parser fake");
  });
});

test("CDH-04 Effective History Builder merges rollout bootstrap with post-baseline proxy journal", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-rollout-merge",
      requestId: "request-after-rollout",
      payload: {
        previous_response_id: "resp-rollout-baseline",
        input: [{ role: "user", content: "proxy journal after rollout baseline" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-rollout-merge",
      requestId: "request-after-rollout",
      response: {
        id: "resp-proxy-head",
        previous_response_id: "resp-rollout-baseline",
        output: [
          {
            id: "msg-after-rollout",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "proxy journal answer" }],
          },
        ],
      },
      status: "completed",
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-rollout-merge",
      headResponseId: "resp-proxy-head",
      async rolloutParserBootstrap() {
        return {
          revision: "rollout-rev-merge",
          replayableItems: [
            {
              stableItemId: "rollout-baseline-user",
              nativeId: "rollout-baseline-user",
              item: { role: "user", content: "rollout compacted baseline" },
            },
          ],
          observationOnlyItems: [],
          deferredItems: [],
          unresolvedCallIds: [],
          source: "rollout_bootstrap",
          incomplete: false,
        };
      },
    });

    assert.equal(history.source, "rollout_proxy_merge");
    assert.equal(history.incomplete, false);
    assert.deepEqual(
      history.replayableItems.map((entry) => entry.item.type ?? entry.item.role),
      ["user", "user", "message"],
    );
    assert.match(JSON.stringify(history.replayableItems), /rollout compacted baseline/);
    assert.match(JSON.stringify(history.replayableItems), /proxy journal after rollout baseline/);
    assert.match(JSON.stringify(history.replayableItems), /proxy journal answer/);
  });
});

test("CDH-04 Effective History View merges only evidenced rollout and proxy turns", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-rollout-view-merge";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-2",
      turnOrdinal: 2,
      payload: {
        previous_response_id: "resp-rollout-root",
        input: [{ id: "proxy-input-2", role: "user", content: "proxy turn" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-2",
      response: {
        id: "resp-proxy-2",
        previous_response_id: "resp-rollout-root",
        output: [{ id: "proxy-output-2", type: "message", role: "assistant", content: "proxy answer" }],
      },
      status: "completed",
    });
    const rolloutItem = {
      stableItemId: "rollout-input-1",
      nativeId: "rollout-input-1",
      item: { id: "rollout-input-1", type: "message", role: "user", content: "rollout turn" },
    };
    const rolloutHistory = {
      revision: "rollout-view-revision",
      replayableItems: [rolloutItem],
      observationOnlyItems: [],
      deferredItems: [],
      unresolvedCallIds: [],
      source: "rollout_bootstrap" as const,
      incomplete: false,
    };

    const view = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "resp-proxy-2",
      async rolloutViewBootstrap() {
        return {
          history: rolloutHistory,
          turns: [{
            turnSeq: 1,
            turnAbsId: "wrong-host-id:t1",
            inputItemIds: ["rollout-input-1", "removed-rollout-id"],
            outputItemIds: [],
          }, {
            turnSeq: 2,
            turnAbsId: "wrong-host-id:t2",
            inputItemIds: [],
            outputItemIds: ["rollout-input-1"],
          }],
          semanticComplete: true,
          reasonCodes: [],
        };
      },
    });

    assert.equal(view.history.source, "rollout_proxy_merge");
    assert.equal(view.semanticComplete, true);
    assert.deepEqual(view.reasonCodes, []);
    assert.deepEqual(view.turns.map((turn) => ({
      turnSeq: turn.turnSeq,
      turnAbsId: turn.turnAbsId,
      inputCount: turn.inputItemIds.length,
      outputCount: turn.outputItemIds.length,
    })), [
      { turnSeq: 1, turnAbsId: `${sessionId}:t1`, inputCount: 1, outputCount: 0 },
      { turnSeq: 2, turnAbsId: `${sessionId}:t2`, inputCount: 1, outputCount: 1 },
    ]);
    const allAttributedIds = view.turns.flatMap((turn) => [
      ...turn.inputItemIds,
      ...turn.outputItemIds,
    ]);
    assert.equal(new Set(allAttributedIds).size, allAttributedIds.length);
    assert.equal(allAttributedIds.includes("removed-rollout-id"), false);
  });
});

test("CDH-04 Effective History View aligns local proxy ordinals after a rollout baseline", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-rollout-local-ordinal";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-after-rollout",
      payload: {
        previous_response_id: "resp-rollout-root",
        input: [{ id: "proxy-input", role: "user", content: "after rollout" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-after-rollout",
      response: {
        id: "resp-proxy-head",
        previous_response_id: "resp-rollout-root",
        output: [{
          id: "proxy-output",
          type: "message",
          role: "assistant",
          content: "after rollout answer",
        }],
      },
      status: "completed",
    });
    const rolloutItem = {
      stableItemId: "rollout-input-7",
      nativeId: "rollout-input-7",
      item: {
        id: "rollout-input-7",
        type: "message",
        role: "user",
        content: "rollout baseline",
      },
    };

    const view = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "resp-proxy-head",
      async rolloutViewBootstrap() {
        return {
          history: {
            revision: "rollout-local-ordinal-revision",
            replayableItems: [rolloutItem],
            observationOnlyItems: [],
            deferredItems: [],
            unresolvedCallIds: [],
            source: "rollout_bootstrap",
            incomplete: false,
          },
          turns: [{
            turnSeq: 7,
            turnAbsId: `${sessionId}:t7`,
            inputItemIds: [rolloutItem.stableItemId],
            outputItemIds: [],
          }],
          semanticComplete: true,
          reasonCodes: [],
        };
      },
    });

    assert.equal(view.semanticComplete, true);
    assert.deepEqual(view.reasonCodes, []);
    assert.deepEqual(view.turns.map((turn) => ({
      turnSeq: turn.turnSeq,
      turnAbsId: turn.turnAbsId,
    })), [
      { turnSeq: 7, turnAbsId: `${sessionId}:t7` },
      { turnSeq: 8, turnAbsId: `${sessionId}:t8` },
    ]);
    assert.deepEqual(view.turns[1]?.inputItemIds.length, 1);
    assert.deepEqual(view.turns[1]?.outputItemIds.length, 1);
  });
});

test("CDH-04 Effective History Builder marks malformed SSE journals incomplete without dropping valid items", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      payload: { stream: true, input: [{ role: "user", content: "malformed but usable" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      rawStreamText: sseStream(
        sseBlock("response.created", { response: { id: "resp-malformed" } }),
        sseBlock("response.output_item.done", {
          output_index: 0,
          item: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "kept" }],
          },
        }),
        sseBlock("response.output_text.delta", "{\"truncated\":"),
        sseBlock("response.completed", { response: { id: "resp-malformed" } }),
      ),
    });

    const view = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId: "codex-session-1",
      headResponseId: "resp-malformed",
    });
    const history = view.history;

    assert.equal(history.incomplete, true);
    assert.equal(view.semanticComplete, false);
    assert.equal(view.reasonCodes.includes("journal_malformed_stream"), true);
    assert.deepEqual(
      history.replayableItems.map((entry) => entry.item.type ?? entry.item.role),
      ["user", "message"],
    );
    assert.match(JSON.stringify(history.replayableItems), /kept/);
  });
});

test("CDH-04 Effective History Builder ignores malformed SSE outside the selected response chain", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "root-request",
      payload: { input: [{ role: "user", content: "root" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "root-request",
      response: { id: "resp-root", output: [] },
      status: "completed",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "selected-request",
      payload: {
        previous_response_id: "resp-root",
        input: [{ role: "user", content: "selected branch" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "selected-request",
      response: { id: "resp-selected", previous_response_id: "resp-root", output: [] },
      status: "completed",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "abandoned-request",
      payload: {
        previous_response_id: "resp-root",
        input: [{ role: "user", content: "abandoned branch" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "abandoned-request",
      rawStreamText: sseStream(
        sseBlock("response.created", { response: { id: "resp-abandoned", previous_response_id: "resp-root" } }),
        sseBlock("response.output_text.delta", "{\"truncated\":"),
        sseBlock("response.completed", { response: { id: "resp-abandoned" } }),
      ),
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-1",
      headResponseId: "resp-selected",
    });

    assert.equal(history.incomplete, false);
    assert.doesNotMatch(JSON.stringify(history.replayableItems), /abandoned branch/);
  });
});

test("CDH-04 Effective History Builder consumes SSE-collected response items", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      payload: {
        stream: true,
        input: [{ role: "user", content: "collect stream" }],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-1",
      rawStreamText: sseStream(
        sseBlock("response.created", { response: { id: "resp-sse" } }),
        sseBlock("response.output_item.done", {
          output_index: 0,
          item: { id: "rs-1", type: "reasoning", encrypted_content: "opaque" },
        }),
        sseBlock("response.output_item.added", {
          output_index: 1,
          item: { id: "msg-1", type: "message", role: "assistant", content: [] },
        }),
        sseBlock("response.content_part.added", {
          item_id: "msg-1",
          output_index: 1,
          content_index: 0,
          part: { type: "output_text", text: "SSE" },
        }),
        sseBlock("response.output_text.done", {
          item_id: "msg-1",
          output_index: 1,
          content_index: 0,
          text: "SSE done",
        }),
        sseBlock("response.output_item.added", {
          output_index: 2,
          item: {
            id: "fc-1",
            type: "function_call",
            call_id: "call-1",
            name: "run_tests",
            arguments: "",
          },
        }),
        sseBlock("response.function_call_arguments.done", {
          item_id: "fc-1",
          output_index: 2,
          arguments: "{}",
        }),
        sseBlock("response.output_item.added", {
          output_index: 3,
          item: {
            id: "cc-1",
            type: "custom_tool_call",
            call_id: "custom-1",
            name: "edit",
            input: "",
          },
        }),
        sseBlock("response.custom_tool_call_input.done", {
          item_id: "cc-1",
          output_index: 3,
          input: "payload",
        }),
        sseBlock("response.completed", { response: { id: "resp-sse" } }),
      ),
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-2",
      payload: {
        previous_response_id: "resp-sse",
        input: [
          { type: "function_call_output", call_id: "call-1", output: "{\"passed\":true}" },
          { type: "custom_tool_call_output", call_id: "custom-1", output: "{\"edited\":true}" },
          { role: "user", content: "continue" },
        ],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-1",
      requestId: "request-2",
      response: {
        id: "resp-2",
        previous_response_id: "resp-sse",
        output: [
          { id: "msg-2", type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        ],
      },
      status: "completed",
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-1",
      headResponseId: "resp-2",
    });

    assert.equal(history.incomplete, false);
    assert.equal(history.unresolvedCallIds.length, 0);
    assert.deepEqual(
      history.replayableItems.map((entry) => entry.item.type ?? entry.item.role),
      [
        "user",
        "reasoning",
        "message",
        "function_call",
        "custom_tool_call",
        "function_call_output",
        "custom_tool_call_output",
        "user",
        "message",
      ],
    );
    assert.match(JSON.stringify(history.replayableItems), /SSE done/);
  });
});

test("CDH-04 Effective History Builder defers summary-only reasoning and blocks rebase", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-deferred",
      requestId: "request-1",
      payload: { stream: true, input: [{ role: "user", content: "reason" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-deferred",
      requestId: "request-1",
      rawStreamText: sseStream(
        sseBlock("response.created", { response: { id: "resp-1" } }),
        sseBlock("response.output_item.added", {
          output_index: 0,
          item: { id: "rs-1", type: "reasoning", summary: [] },
        }),
        sseBlock("response.reasoning_summary_text.done", {
          item_id: "rs-1",
          output_index: 0,
          summary_index: 0,
          text: "summary only",
        }),
        sseBlock("response.completed", { response: { id: "resp-1" } }),
      ),
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-deferred",
    });

    assert.equal(history.incomplete, true);
    assert.equal(history.deferredItems.length, 1);
    assert.equal(history.deferredItems[0]?.item.type, "reasoning");
    assert.doesNotMatch(JSON.stringify(history.replayableItems), /summary only/);
  });
});

test("CDH-04 Effective History Builder marks unresolved tool calls incomplete", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: "codex-session-unresolved",
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "run tool" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: "codex-session-unresolved",
      requestId: "request-1",
      response: {
        id: "resp-1",
        output: [{ type: "function_call", call_id: "call-1", name: "run", arguments: "{}" }],
      },
      status: "completed",
    });

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: "codex-session-unresolved",
    });

    assert.equal(history.incomplete, true);
    assert.deepEqual(history.unresolvedCallIds, ["call-1"]);
  });
});

test("CDH-04 current tool output closes the committed head for stateless replay", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-current-tool-output";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "run tool" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: {
        id: "resp-1",
        output: [{ type: "custom_tool_call", call_id: "call-1", name: "exec", input: "{}" }],
      },
      status: "completed",
    });

    const view = await buildCodexEffectiveHistoryView({
      stateDir,
      sessionId,
      headResponseId: "resp-1",
    });
    assert.equal(view.history.incomplete, true);
    assert.deepEqual(view.history.unresolvedCallIds, ["call-1"]);

    const closed = resolveCodexEffectiveHistoryCurrentInputClosures({
      view,
      currentInput: [{ type: "custom_tool_call_output", call_id: "call-1", output: "ok" }],
    });

    assert.equal(closed.incomplete, false);
    assert.deepEqual(closed.unresolvedCallIds, []);
    assert.equal(closed.revision, view.history.revision);
  });
});
