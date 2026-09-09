import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeContextCleanRecommendations,
  type ContextCleanPlan,
  type ContextCleanReceipt,
} from "@lightrsi/cleaner";
import type { JsonModelClient } from "@lightrsi/runtime-core";

import {
  createOpenClawCleanRecommendationProvider,
  createOpenClawContextCleanerCommandHandler,
  handleOpenClawContextCleanCommand,
  loadOpenClawContextCleanerConfig,
} from "./context-cleaner-command.js";
import { registerTokenPilotCommand } from "../tokenpilot-command.js";
import { normalizeConfig } from "../../context-stack/integration/config-normalize.js";

const plan: ContextCleanPlan = {
  schemaVersion: 1,
  planId: "ctxclean-demo",
  hostId: "openclaw",
  sessionId: "session-demo",
  baseRevision: "revision-a",
  usedTokens: 120,
  usedChars: 480,
  protectedTokens: 20,
  protectedChars: 80,
  unassignedTokens: 0,
  unassignedChars: 0,
  tokenCountMode: "exact",
  tokenCountMethod: "fixture",
  tasks: [
    {
      taskId: "task-done",
      label: "Completed task",
      description: "Finished implementation work",
      summary: "done",
      lifecycleState: "completed",
      itemIds: ["item-1"],
      itemDigests: { "item-1": "digest-1" },
      tokenCount: 100,
      charCount: 400,
      tokenPercent: 83.3,
      recommendation: "clean",
      reasonCodes: ["task_completed"],
      selectable: true,
    },
    {
      taskId: "task-active",
      label: "Active task",
      description: "Current work must stay",
      summary: "active",
      lifecycleState: "active",
      itemIds: ["item-2"],
      itemDigests: { "item-2": "digest-2" },
      tokenCount: 20,
      charCount: 80,
      tokenPercent: 16.7,
      recommendation: "protected",
      reasonCodes: ["deterministic_protection"],
      selectable: false,
    },
  ],
  createdAt: "2026-09-09T00:00:00.000Z",
};

const appliedReceipt: ContextCleanReceipt = {
  schemaVersion: 1,
  planId: plan.planId,
  hostId: "openclaw",
  sessionId: plan.sessionId,
  status: "applied",
  selectedTaskIds: ["task-done"],
  estimatedSavedTokens: 100,
  estimatedSavedChars: 400,
  appliedSavedTokens: 100,
  appliedSavedChars: 400,
  tokenCountMode: "exact",
  deferredTaskIds: [],
  reasons: [],
  updatedAt: "2026-09-09T00:00:01.000Z",
  fallbackUsed: false,
  evidence: {
    previousRevision: "revision-a",
    nextRevision: "revision-b",
    operationIds: ["operation-1"],
    itemIds: ["item-1"],
  },
};

function backend(overrides: Record<string, unknown> = {}) {
  return {
    stateDir: "C:/state",
    async analyze() { return plan; },
    async readPlan() { return plan; },
    async approve() { return appliedReceipt; },
    async readReceipt() { return appliedReceipt; },
    async cancel() { return { ...appliedReceipt, status: "cancelled" }; },
    ...overrides,
  } as any;
}

test("native clean analyzes the current OpenClaw session without applying changes", async () => {
  let analyzedSessionId = "";
  let approved = false;
  const result = await handleOpenClawContextCleanCommand({
    ctx: { sessionId: "session-demo" },
    rawArgs: "",
    backend: backend({
      async analyze(sessionId: string) {
        analyzedSessionId = sessionId;
        return plan;
      },
      async approve() {
        approved = true;
        return appliedReceipt;
      },
    }),
  });

  assert.equal(analyzedSessionId, "session-demo");
  assert.equal(approved, false);
  assert.match(result.text, /Context clean plan: ctxclean-demo/);
  assert.match(result.text, /\[-\] task-active/);
  assert.match(result.text, /No changes applied/);
});

test("native clean forwards only the explicit plan task selection", async () => {
  let approvedPlanId = "";
  let approvedTaskIds: string[] = [];
  const result = await handleOpenClawContextCleanCommand({
    ctx: {},
    rawArgs: "--plan ctxclean-demo --select task-done",
    backend: backend({
      async approve(planId: string, taskIds: string[]) {
        approvedPlanId = planId;
        approvedTaskIds = taskIds;
        return appliedReceipt;
      },
    }),
  });

  assert.equal(approvedPlanId, "ctxclean-demo");
  assert.deepEqual(approvedTaskIds, ["task-done"]);
  assert.match(result.text, /Context clean applied/);
  assert.match(result.text, /Released: 100 tok/);
});

test("native clean reads status and cancels through the canonical backend", async () => {
  let statusPlanId = "";
  let cancelledPlanId = "";
  const cleanBackend = backend({
    async readReceipt(planId: string) {
      statusPlanId = planId;
      return appliedReceipt;
    },
    async cancel(planId: string) {
      cancelledPlanId = planId;
      return {
        ...appliedReceipt,
        status: "cancelled",
        appliedSavedTokens: undefined,
        appliedSavedChars: undefined,
        fallbackUsed: true,
        evidence: undefined,
        reasons: ["cancelled_by_user"],
      };
    },
  });

  const status = await handleOpenClawContextCleanCommand({
    ctx: {}, rawArgs: "--status ctxclean-demo", backend: cleanBackend,
  });
  const cancelled = await handleOpenClawContextCleanCommand({
    ctx: {}, rawArgs: "--cancel ctxclean-demo", backend: cleanBackend,
  });

  assert.equal(statusPlanId, "ctxclean-demo");
  assert.equal(cancelledPlanId, "ctxclean-demo");
  assert.match(status.text, /Context clean applied/);
  assert.match(cancelled.text, /Context clean cancelled/);
  assert.match(cancelled.text, /Recommendation fallback: used/);
});

test("native command registration preserves aliases and exposes clean help", async () => {
  const registered: Array<{ name: string; handler(ctx: any): Promise<{ text: string }> }> = [];
  const api = {
    registerCommand(spec: any) { registered.push(spec); },
    runtime: {
      config: {
        loadConfig: async () => ({}),
        writeConfigFile: async () => undefined,
      },
    },
  };
  registerTokenPilotCommand(api, {});

  assert.deepEqual(registered.map((spec) => spec.name), ["tokenpilot", "lightrsi", "tp"]);
  const command = registered.find((spec) => spec.name === "lightrsi");
  assert.ok(command);
  const cleanHelp = await command.handler({ args: "clean --help" });
  assert.match(cleanHelp.text, /\/lightrsi clean --plan/);
  const generalHelp = await command.handler({ args: "help" });
  assert.match(generalHelp.text, /Context Cleaner:/);
});

test("native clean reads current OpenClaw config without the removed runtime loader", async () => {
  const currentConfig = { plugins: { entries: { tokenpilot: { enabled: true } } } };
  assert.equal(loadOpenClawContextCleanerConfig({ config: currentConfig }), currentConfig);
});

test("native clean retains the legacy OpenClaw config loader fallback", async () => {
  const legacyConfig = { plugins: { entries: {} } };
  const legacyConfigApi = {
    marker: "legacy",
    loadConfig(this: { marker: string }) {
      assert.equal(this.marker, "legacy");
      return legacyConfig;
    },
  };

  assert.equal(
    await loadOpenClawContextCleanerConfig({ runtime: { config: legacyConfigApi } }),
    legacyConfig,
  );
});

test("native clean fails closed when OpenClaw exposes no config surface", () => {
  assert.throws(
    () => loadOpenClawContextCleanerConfig({}),
    /clean_config_unavailable/,
  );
});

test("native clean recommendations use the Host-managed model without API credentials", async () => {
  let requests = 0;
  const modelClient: JsonModelClient = {
    async request() {
      requests += 1;
      return {
        text: JSON.stringify({
          tasks: [{
            taskId: "task-done",
            label: "Completed task",
            description: "Finished implementation work",
            summary: "done",
            recommendation: "clean",
            reasonCodes: ["task_completed"],
            confidence: 0.95,
          }],
        }),
      };
    },
  };
  const provider = createOpenClawCleanRecommendationProvider(
    normalizeConfig({ taskStateEstimator: { enabled: false } }),
    modelClient,
  );

  assert.ok(provider);
  const result = await analyzeContextCleanRecommendations({
    tasks: [plan.tasks[0]!],
    provider,
  });

  assert.equal(requests, 1);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.tasks[0]?.recommendation, "clean");
  assert.equal(result.tasks[0]?.selectable, true);
});

test("native clean handler returns actionable usage for invalid arguments", async () => {
  const handler = createOpenClawContextCleanerCommandHandler({
    loadConfig: async () => ({}),
    createBackend: () => backend(),
  });
  const result = await handler({}, "--select task-done");
  assert.match(result.text, /Context clean error: clean_plan_missing/);
  assert.match(result.text, /\/lightrsi clean --status/);
});
