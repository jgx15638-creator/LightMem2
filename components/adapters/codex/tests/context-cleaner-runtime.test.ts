import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  readContextCleanReceipt,
  saveContextCleanPlan,
  transitionContextCleanState,
  type ContextCleanPendingReceipt,
  type ContextCleanPlan,
} from "@lightrsi/cleaner";
import {
  createEmptySessionTaskRegistry,
  persistSessionTaskRegistry,
} from "@lightrsi/history";
import { reserveUnusedPort } from "@lightrsi/host-adapter";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import type {
  CodexEffectiveHistoryItem,
  CodexEffectiveHistoryView,
  JsonObject,
} from "../src/context-history/index.js";
import { buildCodexEffectiveHistoryView } from "../src/context-history/index.js";
import {
  appendPendingCodexRebaseEpoch,
  buildCodexLifecycleBackendRequest,
  codexSharedContextRewriteBackend,
  commitCodexRebaseEpoch,
  type CodexLifecycleBackendRequestBase,
  withCodexRebaseReplayAccountingInput,
} from "../src/context-rewrite/index.js";
import {
  finalizeCodexCleanerAppliedReceipt,
  finalizeCodexCleanerHandoffFailure,
  prepareCodexCleanerRebase,
  revalidateCodexCleanerPreparedRebase,
  withCodexCleanerReplayAccounting,
} from "../src/context-cleaner/runtime.js";
import {
  appendCodexCleanerCommitted,
  readCodexCleanerSchedule,
  scheduleCodexCleanerPlan,
} from "../src/context-cleaner/scheduler.js";
import { createConsoleLogger } from "../src/logger.js";
import { startCodexResponsesProxy } from "../src/proxy-runtime.js";

const SESSION_ID = "codex-cleaner-runtime-session";
const CLEAN_PLAN_ID = "clean-plan-runtime";
const REVISION = "codex-cleaner-runtime-revision";
const CREATED_AT = "2026-08-22T00:00:00.000Z";

async function withTempState(
  run: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-runtime-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function readBody(
  request: Parameters<Parameters<typeof createServer>[0]>[0],
): Promise<JsonObject> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
    ));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  return JSON.parse(text) as JsonObject;
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  const port = await reserveUnusedPort();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startRuntimeUpstream(): Promise<{
  baseUrl: string;
  requests: JsonObject[];
  close(): Promise<void>;
}> {
  const requests: JsonObject[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const payload = await readBody(request);
    requests.push(payload);
    const requestNumber = requests.length;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: `response-cleaner-${requestNumber}`,
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: `KEEP_RESPONSE_cleaner_${requestNumber}`,
        }],
      }],
    }));
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => closeServer(server),
  };
}

async function startCountingEstimator(): Promise<{
  baseUrl: string;
  calls(): number;
  close(): Promise<void>;
}> {
  let calls = 0;
  const server = createServer(async (request, response) => {
    await readBody(request);
    calls += 1;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: `estimator-cleaner-${calls}`,
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: JSON.stringify({ baseVersion: 0, taskUpdates: [] }),
        }],
      }],
    }));
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => closeServer(server),
  };
}

function effective(stableItemId: string, item: JsonObject): CodexEffectiveHistoryItem {
  return { stableItemId, item };
}

function sourceView(
  revision = REVISION,
  targetRole: "user" | "system" = "user",
): CodexEffectiveHistoryView {
  return {
    history: {
      revision,
      replayableItems: [
        effective("old-item", {
          type: "message",
          role: targetRole,
          content: "EVICT_ME_cleaner_runtime",
        }),
        effective("keep-item", {
          type: "message",
          role: "assistant",
          content: "KEEP_ME_cleaner_runtime",
        }),
      ],
      observationOnlyItems: [],
      deferredItems: [],
      unresolvedCallIds: [],
      source: "proxy_journal",
      incomplete: false,
    },
    turns: [
      {
        turnSeq: 1,
        turnAbsId: `${SESSION_ID}:t1`,
        inputItemIds: ["old-item"],
        outputItemIds: [],
      },
      {
        turnSeq: 2,
        turnAbsId: `${SESSION_ID}:t2`,
        inputItemIds: [],
        outputItemIds: ["keep-item"],
      },
    ],
    semanticComplete: true,
    reasonCodes: [],
  };
}

function backendRequest(view: CodexEffectiveHistoryView): CodexLifecycleBackendRequestBase {
  return {
    sessionId: SESSION_ID,
    payload: {
      model: "gpt-5.4-mini",
      previous_response_id: "response-parent",
      input: [{
        type: "message",
        role: "user",
        content: "CURRENT_INPUT_cleaner_runtime",
      }],
    },
    effectiveHistory: view.history,
    currentInput: [{
      type: "message",
      role: "user",
      content: "CURRENT_INPUT_cleaner_runtime",
    }],
  };
}

function pendingReceipt(
  status: ContextCleanPendingReceipt["status"],
): ContextCleanPendingReceipt {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: CLEAN_PLAN_ID,
    hostId: "codex",
    sessionId: SESSION_ID,
    status,
    selectedTaskIds: status === "analyzed" ? [] : ["task-old"],
    estimatedSavedTokens: null,
    estimatedSavedChars: 70,
    tokenCountMode: "chars_only",
    deferredTaskIds: [],
    fallbackUsed: false,
    reasons: [],
    updatedAt: status === "analyzed"
      ? "2026-08-22T00:00:00.000Z"
      : status === "approved"
        ? "2026-08-22T00:00:01.000Z"
        : "2026-08-22T00:00:02.000Z",
  };
}

async function seedScheduledClean(
  stateDir: string,
  targetRole: "user" | "system" = "user",
): Promise<{
  view: CodexEffectiveHistoryView;
  request: CodexLifecycleBackendRequestBase;
}> {
  const view = sourceView(REVISION, targetRole);
  const registry = createEmptySessionTaskRegistry(SESSION_ID);
  registry.version = 1;
  registry.lastProcessedTurnSeq = 2;
  registry.activeTaskIds = ["task-current"];
  registry.evictableTaskIds = ["task-old"];
  registry.turnToTaskIds[`${SESSION_ID}:t1`] = ["task-old"];
  registry.turnToTaskIds[`${SESSION_ID}:t2`] = ["task-current"];
  registry.tasks["task-old"] = {
    taskId: "task-old",
    title: "old task",
    objective: "remove completed context",
    lifecycle: "evictable",
    completionEvidence: ["completed"],
    unresolvedQuestions: [],
    span: { startTurnSeq: 1, endTurnSeq: 1 },
    coveredTurnAbsIds: [`${SESSION_ID}:t1`],
    updatedAt: CREATED_AT,
  };
  registry.tasks["task-current"] = {
    taskId: "task-current",
    title: "current task",
    objective: "retain active context",
    lifecycle: "active",
    completionEvidence: [],
    unresolvedQuestions: [],
    span: { startTurnSeq: 2, endTurnSeq: 2 },
    coveredTurnAbsIds: [`${SESSION_ID}:t2`],
    updatedAt: CREATED_AT,
  };
  await persistSessionTaskRegistry(stateDir, registry);

  const request = backendRequest(view);
  const attributedRequest = buildCodexLifecycleBackendRequest({ view, registry, request });
  const snapshot = await codexSharedContextRewriteBackend.readSnapshot({
    sessionId: SESSION_ID,
    request: attributedRequest,
  });
  const oldItem = snapshot.items.find((item) => item.stableId === "old-item")!;
  const keepItem = snapshot.items.find((item) => item.stableId === "keep-item")!;
  const plan: ContextCleanPlan = {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: CLEAN_PLAN_ID,
    hostId: "codex",
    sessionId: SESSION_ID,
    baseRevision: REVISION,
    model: "gpt-5.4-mini",
    usedTokens: null,
    usedChars: oldItem.chars + keepItem.chars,
    protectedTokens: null,
    protectedChars: 0,
    unassignedTokens: null,
    unassignedChars: 0,
    tokenCountMode: "chars_only",
    tokenCountMethod: "utf16_chars",
    snapshotItems: snapshot.items.map((item) => ({
      stableId: item.stableId,
      fingerprint: item.fingerprint,
    })),
    tasks: [
      {
        taskId: "task-old",
        label: "old task",
        description: "completed old task",
        summary: "completed",
        lifecycleState: "completed",
        itemIds: ["old-item"],
        itemDigests: { "old-item": oldItem.fingerprint },
        tokenCount: null,
        charCount: oldItem.chars,
        tokenPercent: null,
        recommendation: "clean",
        reasonCodes: ["completed"],
        selectable: true,
      },
      {
        taskId: "task-current",
        label: "current task",
        description: "active task",
        summary: "active",
        lifecycleState: "active",
        itemIds: ["keep-item"],
        itemDigests: { "keep-item": keepItem.fingerprint },
        tokenCount: null,
        charCount: keepItem.chars,
        tokenPercent: null,
        recommendation: "protected",
        reasonCodes: ["active_task"],
        selectable: false,
      },
    ],
    createdAt: CREATED_AT,
  };
  assert.equal((await saveContextCleanPlan({ stateDir, plan })).bypassed, false);
  for (const status of ["analyzed", "approved", "scheduled"] as const) {
    assert.equal((await transitionContextCleanState({
      stateDir,
      receipt: pendingReceipt(status),
    })).bypassed, false);
  }
  assert.equal((await scheduleCodexCleanerPlan({
    stateDir,
    sessionId: SESSION_ID,
    cleanPlanId: CLEAN_PLAN_ID,
    baseRevision: REVISION,
    selectedTaskIds: ["task-old"],
    scheduledAt: pendingReceipt("scheduled").updatedAt,
  })).outcome, "stored");
  return { view, request };
}

test("Codex cleaner runtime prepares only the scheduled manual plan with the existing backend", async () => {
  await withTempState(async (stateDir) => {
    const seeded = await seedScheduledClean(stateDir);
    const result = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: seeded.view,
      backendRequest: seeded.request,
      now: "2026-08-22T00:00:03.000Z",
    });

    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready") return;
    assert.equal(result.prepared.execution.mutationPlan.sourceModuleId, "cleaner_manual");
    assert.equal(result.prepared.execution.cleanPlanId, CLEAN_PLAN_ID);
    assert.doesNotMatch(
      JSON.stringify(result.prepared.rebaseRequest.payload),
      /EVICT_ME_cleaner_runtime/,
    );
    assert.match(
      JSON.stringify(result.prepared.rebaseRequest.payload),
      /KEEP_ME_cleaner_runtime/,
    );
    assert.match(
      JSON.stringify(result.prepared.rebaseRequest.payload),
      /CURRENT_INPUT_cleaner_runtime/,
    );
  });
});

test("Codex cleaner runtime marks selected-item drift stale and preserves the original request", async () => {
  await withTempState(async (stateDir) => {
    const seeded = await seedScheduledClean(stateDir);
    const changedView = sourceView("changed-revision");
    changedView.history.replayableItems[0] = effective("old-item", {
      type: "message",
      role: "user",
      content: "EVICT_ME_cleaner_runtime_changed_after_analysis",
    });
    const result = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: changedView,
      backendRequest: backendRequest(changedView),
      now: "2026-08-22T00:00:04.000Z",
    });

    assert.equal(result.outcome, "stale");
    assert.deepEqual(result.reasonCodes, ["clean_execution_item_stale"]);
    const receipt = await readContextCleanReceipt({ stateDir, planId: CLEAN_PLAN_ID });
    assert.equal(receipt.value?.status, "stale");
    assert.equal(receipt.value?.fallbackUsed, false);
    assert.equal("appliedSavedChars" in (receipt.value ?? {}), false);
    assert.equal(
      (await readCodexCleanerSchedule({ stateDir, sessionId: SESSION_ID })).outcome,
      "terminal",
    );
  });
});

test("Codex cleaner runtime terminates a scheduled plan that targets protected system content", async () => {
  await withTempState(async (stateDir) => {
    const seeded = await seedScheduledClean(stateDir, "system");
    const result = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: seeded.view,
      backendRequest: seeded.request,
      now: "2026-08-22T00:00:04.000Z",
    });

    assert.equal(result.outcome, "stale");
    assert.deepEqual(result.reasonCodes, ["clean_execution_protected_item_targeted"]);
    assert.equal(
      (await readContextCleanReceipt({ stateDir, planId: CLEAN_PLAN_ID })).value?.status,
      "stale",
    );
    assert.equal(
      (await readCodexCleanerSchedule({ stateDir, sessionId: SESSION_ID })).outcome,
      "terminal",
    );
  });
});

test("Codex cleaner runtime never mutates from an adapter-local schedule without shared approval state", async () => {
  await withTempState(async (stateDir) => {
    const view = sourceView();
    assert.equal((await scheduleCodexCleanerPlan({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: CLEAN_PLAN_ID,
      baseRevision: REVISION,
      selectedTaskIds: ["task-old"],
      scheduledAt: "2026-08-22T00:00:02.000Z",
    })).outcome, "stored");

    const result = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view,
      backendRequest: backendRequest(view),
    });
    assert.equal(result.outcome, "reserved");
    assert.ok(result.reasonCodes.includes("clean_execution_missing"));
    assert.equal("prepared" in result, false);
  });
});

test("Codex cleaner runtime repairs the crash window after a committed rebase epoch", async () => {
  await withTempState(async (stateDir) => {
    const seeded = await seedScheduledClean(stateDir);
    const first = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: seeded.view,
      backendRequest: seeded.request,
    });
    assert.equal(first.outcome, "ready");
    if (first.outcome !== "ready") return;

    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: SESSION_ID,
      planId: first.prepared.execution.mutationPlan.planId,
      epochId: "epoch-crash-window",
      oldPreviousResponseId: "response-parent",
      oldRevision: first.prepared.rebaseRequest.oldRevision,
      accounting: first.prepared.rebaseRequest.accounting,
    });
    await commitCodexRebaseEpoch({
      stateDir,
      sessionId: SESSION_ID,
      epochId: "epoch-crash-window",
      newResponseId: "response-after-clean",
      newRevision: first.prepared.rebaseRequest.rebaseRevision,
      accounting: first.prepared.rebaseRequest.accounting,
      updatedAt: "2026-08-22T00:00:05.000Z",
    });
    assert.equal((await appendCodexCleanerCommitted({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: CLEAN_PLAN_ID,
      mutationPlanId: first.prepared.execution.mutationPlan.planId,
      epochId: "epoch-crash-window",
      updatedAt: "2026-08-22T00:00:05.000Z",
    })).outcome, "transitioned");

    const postCommitView = sourceView("post-commit-revision");
    const recovered = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: postCommitView,
      backendRequest: backendRequest(postCommitView),
      now: "2026-08-22T00:00:06.000Z",
    });
    assert.equal(recovered.outcome, "committed");
    const receipt = await readContextCleanReceipt({ stateDir, planId: CLEAN_PLAN_ID });
    assert.equal(receipt.value?.status, "applied");
    if (receipt.value?.status === "applied") {
      assert.equal(
        receipt.value.appliedSavedChars,
        first.prepared.rebaseRequest.accounting.actuallyRemovedChars,
      );
      assert.equal(receipt.value.appliedSavedTokens, null);
      assert.equal(receipt.value.evidence.previousRevision, REVISION);
      assert.equal(
        receipt.value.evidence.nextRevision,
        first.prepared.rebaseRequest.rebaseRevision,
      );
      assert.deepEqual(
        receipt.value.evidence.itemIds,
        first.prepared.execution.mutationPlan.operations.flatMap(
          (operation) => operation.targetItemIds,
        ),
      );
      assert.deepEqual(
        receipt.value.evidence.operationIds,
        first.prepared.execution.mutationPlan.operations.map((operation) => operation.id),
      );
    }
    const local = await readCodexCleanerSchedule({ stateDir, sessionId: SESSION_ID });
    assert.equal(local.outcome, "committed");
    if (local.outcome === "committed") {
      assert.equal(local.record.epochId, "epoch-crash-window");
      assert.equal(
        local.record.mutationPlanId,
        first.prepared.execution.mutationPlan.planId,
      );
    }
  });
});

test("Codex cleaner finalizer rejects malformed actual accounting without applying", async () => {
  await withTempState(async (stateDir) => {
    const seeded = await seedScheduledClean(stateDir);
    const prepared = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: seeded.view,
      backendRequest: seeded.request,
    });
    assert.equal(prepared.outcome, "ready");
    if (prepared.outcome !== "ready") return;

    const invalidAccounting = {
      ...prepared.prepared.rebaseRequest.accounting,
      actuallyRemovedChars: 1.5,
    };
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: SESSION_ID,
      planId: prepared.prepared.execution.mutationPlan.planId,
      epochId: "epoch-invalid-accounting",
      oldPreviousResponseId: "response-parent",
      oldRevision: prepared.prepared.rebaseRequest.oldRevision,
      accounting: invalidAccounting,
    });
    const epoch = await commitCodexRebaseEpoch({
      stateDir,
      sessionId: SESSION_ID,
      epochId: "epoch-invalid-accounting",
      newResponseId: "response-invalid-accounting",
      newRevision: prepared.prepared.rebaseRequest.rebaseRevision,
      accounting: invalidAccounting,
      updatedAt: "2026-08-22T00:00:05.000Z",
    });
    const finalized = await finalizeCodexCleanerAppliedReceipt({
      stateDir,
      sessionId: SESSION_ID,
      prepared: prepared.prepared,
      epoch,
    });
    assert.equal(finalized.outcome, "reserved");
    assert.ok(finalized.reasonCodes.includes("cleaner_receipt_epoch_invalid"));
    assert.equal(
      (await readContextCleanReceipt({ stateDir, planId: CLEAN_PLAN_ID })).value?.status,
      "scheduled",
    );
    assert.equal(
      (await readCodexCleanerSchedule({ stateDir, sessionId: SESSION_ID })).outcome,
      "ready",
    );
  });
});

test("Codex cleaner finalizer accepts replay accounting refreshed for the final input", async () => {
  await withTempState(async (stateDir) => {
    const seeded = await seedScheduledClean(stateDir);
    const result = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: seeded.view,
      backendRequest: seeded.request,
    });
    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready") return;

    const accounting = withCodexRebaseReplayAccountingInput(
      result.prepared.rebaseRequest.accounting,
      [
        ...(result.prepared.rebaseRequest.payload.input as JsonObject[]),
        { role: "system", content: "RECOVERY_PROTOCOL_added_after_cleaner_prepare" },
      ],
    );
    assert.notEqual(
      accounting.rebaseReplayCostChars,
      result.prepared.rebaseRequest.accounting.rebaseReplayCostChars,
    );
    const prepared = withCodexCleanerReplayAccounting(result.prepared, accounting);
    assert.deepEqual(prepared.rebaseRequest.accounting, accounting);
    assert.deepEqual(prepared.rewriteResult.details?.accounting, accounting);

    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: SESSION_ID,
      planId: prepared.execution.mutationPlan.planId,
      epochId: "epoch-refreshed-accounting",
      oldPreviousResponseId: "response-parent",
      oldRevision: prepared.rebaseRequest.oldRevision,
      accounting,
    });
    const epoch = await commitCodexRebaseEpoch({
      stateDir,
      sessionId: SESSION_ID,
      epochId: "epoch-refreshed-accounting",
      newResponseId: "response-refreshed-accounting",
      newRevision: prepared.rebaseRequest.rebaseRevision,
      accounting,
      updatedAt: "2026-08-22T00:00:05.000Z",
    });
    const finalized = await finalizeCodexCleanerAppliedReceipt({
      stateDir,
      sessionId: SESSION_ID,
      prepared,
      epoch,
    });

    assert.equal(finalized.outcome, "applied");
    assert.equal(
      (await readContextCleanReceipt({ stateDir, planId: CLEAN_PLAN_ID })).value?.status,
      "applied",
    );
    assert.equal(
      (await readCodexCleanerSchedule({ stateDir, sessionId: SESSION_ID })).outcome,
      "committed",
    );
  });
});

test("Codex cleaner runtime handoff rejects fingerprint drift before provider execution", async () => {
  await withTempState(async (stateDir) => {
    const seeded = await seedScheduledClean(stateDir);
    const prepared = await prepareCodexCleanerRebase({
      stateDir,
      sessionId: SESSION_ID,
      view: seeded.view,
      backendRequest: seeded.request,
      now: "2026-08-22T00:00:03.000Z",
    });
    assert.equal(prepared.outcome, "ready");
    if (prepared.outcome !== "ready") return;

    const changedView = structuredClone(seeded.view);
    changedView.history.replayableItems[0]!.item.content = "history changed after prepare";
    const handoff = await revalidateCodexCleanerPreparedRebase({
      stateDir,
      sessionId: SESSION_ID,
      prepared: prepared.prepared,
      view: changedView,
      backendRequest: backendRequest(changedView),
    });
    assert.equal(handoff.valid, false);
    assert.ok(handoff.reasonCodes.includes("clean_execution_item_stale"));

    const finalized = await finalizeCodexCleanerHandoffFailure({
      stateDir,
      sessionId: SESSION_ID,
      prepared: prepared.prepared,
      reasonCodes: handoff.reasonCodes,
      now: "2026-08-22T00:00:04.000Z",
    });
    assert.equal(finalized.outcome, "stale");
    assert.equal(
      (await readContextCleanReceipt({ stateDir, planId: CLEAN_PLAN_ID })).value?.status,
      "stale",
    );
  });
});

test("Codex proxy gives the scheduled manual cleaner exclusive ownership of the next request", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-cleaner-proxy-session";
    const cleanPlanId = "clean-plan-proxy";
    const upstream = await startRuntimeUpstream();
    const estimator = await startCountingEstimator();
    let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
    try {
      const config = normalizeTokenPilotCodexConfig({
        stateDir,
        proxyPort: await reserveUnusedPort(),
        upstreamProvider: "OpenAI",
        upstream: {
          baseUrl: upstream.baseUrl,
          wireApi: "responses",
          requiresOpenAIAuth: false,
        },
        modules: { stabilizer: false, reduction: false },
        taskStateEstimator: {
          enabled: true,
          baseUrl: estimator.baseUrl,
          apiKey: "synthetic-estimator-key",
          model: "synthetic-estimator",
          batchTurns: 1,
        },
        contextRewrite: {
          enabled: true,
          providerCompatibilityProbe: "mock_fixture",
        },
      } as any);
      runtime = await startCodexResponsesProxy({
        config,
        logger: createConsoleLogger(false),
        allowMockFixtureEvidence: true,
      });

      const send = async (payload: JsonObject) => fetch(`${runtime!.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal((await send({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "KEEP_INITIAL_cleaner_proxy" }],
      })).status, 200);
      assert.equal((await send({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "response-cleaner-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "EVICT_ME_cleaner_proxy" }],
      })).status, 200);

      const view = await buildCodexEffectiveHistoryView({
        stateDir,
        sessionId,
        headResponseId: "response-cleaner-2",
      });
      const selectedItem = view.history.replayableItems.find((item) => (
        JSON.stringify(item.item).includes("EVICT_ME_cleaner_proxy")
      ));
      assert.ok(selectedItem);
      const registry = createEmptySessionTaskRegistry(sessionId);
      registry.version = 1;
      registry.lastProcessedTurnSeq = Math.max(...view.turns.map((turn) => turn.turnSeq));
      registry.evictableTaskIds = ["task-proxy-old"];
      registry.blockToTaskIds[selectedItem.stableItemId] = ["task-proxy-old"];
      registry.tasks["task-proxy-old"] = {
        taskId: "task-proxy-old",
        title: "old proxy task",
        objective: "remove the approved old request",
        lifecycle: "evictable",
        completionEvidence: ["completed"],
        unresolvedQuestions: [],
        span: { startTurnSeq: 2, endTurnSeq: 2 },
        coveredTurnAbsIds: [],
        updatedAt: CREATED_AT,
      };
      await persistSessionTaskRegistry(stateDir, registry);

      const baseRequest: CodexLifecycleBackendRequestBase = {
        sessionId,
        payload: {
          model: "gpt-5.4-mini",
          previous_response_id: "response-cleaner-2",
          input: [],
        },
        effectiveHistory: view.history,
        currentInput: [],
      };
      const attributed = buildCodexLifecycleBackendRequest({
        view,
        registry,
        request: baseRequest,
      });
      const snapshot = await codexSharedContextRewriteBackend.readSnapshot({
        sessionId,
        request: attributed,
      });
      const selectedSnapshotItem = snapshot.items.find(
        (item) => item.stableId === selectedItem.stableItemId,
      )!;
      const totalChars = snapshot.items.reduce((sum, item) => sum + item.chars, 0);
      const plan: ContextCleanPlan = {
        schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
        planId: cleanPlanId,
        hostId: "codex",
        sessionId,
        baseRevision: snapshot.revision,
        model: "gpt-5.4-mini",
        usedTokens: null,
        usedChars: totalChars,
        protectedTokens: null,
        protectedChars: 0,
        unassignedTokens: null,
        unassignedChars: totalChars - selectedSnapshotItem.chars,
        tokenCountMode: "chars_only",
        tokenCountMethod: "utf16_chars",
        tasks: [{
          taskId: "task-proxy-old",
          label: "old proxy task",
          description: "approved old request",
          summary: "completed",
          lifecycleState: "completed",
          itemIds: [selectedItem.stableItemId],
          itemDigests: { [selectedItem.stableItemId]: selectedSnapshotItem.fingerprint },
          tokenCount: null,
          charCount: selectedSnapshotItem.chars,
          tokenPercent: null,
          recommendation: "clean",
          reasonCodes: ["completed"],
          selectable: true,
        }],
        createdAt: CREATED_AT,
      };
      assert.equal((await saveContextCleanPlan({ stateDir, plan })).bypassed, false);
      const receiptFor = (status: ContextCleanPendingReceipt["status"]): ContextCleanPendingReceipt => ({
        schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
        planId: cleanPlanId,
        hostId: "codex",
        sessionId,
        status,
        selectedTaskIds: status === "analyzed" ? [] : ["task-proxy-old"],
        estimatedSavedTokens: null,
        estimatedSavedChars: selectedSnapshotItem.chars,
        tokenCountMode: "chars_only",
        deferredTaskIds: [],
        fallbackUsed: false,
        reasons: [],
        updatedAt: status === "analyzed"
          ? "2026-08-22T00:01:00.000Z"
          : status === "approved"
            ? "2026-08-22T00:01:01.000Z"
            : "2026-08-22T00:01:02.000Z",
      });
      for (const status of ["analyzed", "approved", "scheduled"] as const) {
        assert.equal((await transitionContextCleanState({
          stateDir,
          receipt: receiptFor(status),
        })).bypassed, false);
      }
      assert.equal((await scheduleCodexCleanerPlan({
        stateDir,
        sessionId,
        cleanPlanId,
        baseRevision: snapshot.revision,
        selectedTaskIds: ["task-proxy-old"],
        scheduledAt: receiptFor("scheduled").updatedAt,
      })).outcome, "stored");
      const estimatorCallsBeforeManualRequest = estimator.calls();

      assert.equal((await send({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "response-cleaner-2",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "CURRENT_KEEP_cleaner_proxy" }],
      })).status, 200);

      assert.equal(estimator.calls(), estimatorCallsBeforeManualRequest);
      assert.equal(upstream.requests.length, 3);
      assert.equal(upstream.requests[2]?.previous_response_id, undefined);
      const outgoing = JSON.stringify(upstream.requests[2]);
      assert.doesNotMatch(outgoing, /EVICT_ME_cleaner_proxy/);
      assert.match(outgoing, /KEEP_RESPONSE_cleaner_1/);
      assert.match(outgoing, /CURRENT_KEEP_cleaner_proxy/);
      assert.equal(
        (await readCodexCleanerSchedule({ stateDir, sessionId })).outcome,
        "committed",
      );
      const appliedReceipt = await readContextCleanReceipt({ stateDir, planId: cleanPlanId });
      assert.equal(appliedReceipt.value?.status, "applied");
      if (appliedReceipt.value?.status === "applied") {
        assert.equal(appliedReceipt.value.fallbackUsed, false);
        assert.ok(appliedReceipt.value.appliedSavedChars > 0);
        assert.equal(appliedReceipt.value.appliedSavedTokens, null);
        assert.equal(appliedReceipt.value.evidence.previousRevision, snapshot.revision);
        assert.ok(appliedReceipt.value.evidence.nextRevision.trim());
        assert.equal(appliedReceipt.value.evidence.operationIds.length, 1);
        assert.deepEqual(appliedReceipt.value.evidence.itemIds, [selectedItem.stableItemId]);
      }

      const estimatorCallsAfterManualCommit = estimator.calls();
      assert.equal((await send({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "response-cleaner-3",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "AUTOMATIC_RESUMES_cleaner_proxy" }],
      })).status, 200);
      assert.ok(estimator.calls() > estimatorCallsAfterManualCommit);
    } finally {
      await runtime?.close();
      await estimator.close();
      await upstream.close();
    }
  });
});
