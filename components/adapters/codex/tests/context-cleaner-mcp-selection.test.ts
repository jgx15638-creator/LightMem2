import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerControlService,
} from "@lightrsi/cleaner";
import type { McpServerPeer } from "@lightrsi/mcp";

import {
  CODEX_CLEANER_MCP_SERVER_NAME,
  CODEX_CLEAN_TOOL_NAME,
  createCodexCleanerMcpTool,
} from "../src/context-cleaner/mcp-selection.js";

function plan(): ContextCleanPlan {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: "ctxclean-selection-test",
    hostId: "codex",
    sessionId: "session-1",
    baseRevision: "revision-1",
    contextWindowTokens: 128_000,
    usedTokens: 30_000,
    usedChars: 120_000,
    protectedTokens: 5_000,
    protectedChars: 20_000,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "exact",
    tokenCountMethod: "fixture",
    tasks: [
      {
        taskId: "task-a-exact",
        label: "OAuth refresh regression",
        description: "Diagnose OAuth refresh failures",
        summary: "OAuth investigation complete",
        lifecycleState: "completed",
        itemIds: ["item-a"],
        itemDigests: { "item-a": "digest-a" },
        tokenCount: 12_000,
        charCount: 48_000,
        tokenPercent: 40,
        recommendation: "clean",
        reasonCodes: ["task_completed"],
        selectable: true,
      },
      {
        taskId: "task-b-exact",
        label: "Index migration benchmark",
        description: "Benchmark the event-search index",
        summary: "Benchmark complete",
        lifecycleState: "completed",
        itemIds: ["item-b"],
        itemDigests: { "item-b": "digest-b" },
        tokenCount: 7_000,
        charCount: 28_000,
        tokenPercent: 23.3,
        recommendation: "clean",
        reasonCodes: ["task_completed"],
        selectable: true,
      },
      {
        taskId: "task-c-protected",
        label: "Release approval",
        description: "Wait for production approval",
        summary: "Approval remains pending",
        lifecycleState: "active",
        itemIds: ["item-c"],
        itemDigests: { "item-c": "digest-c" },
        tokenCount: 6_000,
        charCount: 24_000,
        tokenPercent: 20,
        recommendation: "protected",
        reasonCodes: ["active_task", "pending_approval"],
        selectable: false,
      },
    ],
    createdAt: "2026-09-13T00:00:00.000Z",
  };
}

function scheduledReceipt(selectedTaskIds: string[]): ContextCleanReceipt {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: "ctxclean-selection-test",
    hostId: "codex",
    sessionId: "session-1",
    status: "scheduled",
    selectedTaskIds,
    estimatedSavedTokens: 12_000,
    estimatedSavedChars: 48_000,
    tokenCountMode: "exact",
    deferredTaskIds: [],
    reasons: [],
    updatedAt: "2026-09-13T00:01:00.000Z",
    fallbackUsed: false,
  };
}

function createService(params?: {
  currentPlan?: ContextCleanPlan;
  approveError?: Error;
}): {
  service: ContextCleanerControlService;
  approvals: string[][];
} {
  const currentPlan = params?.currentPlan ?? plan();
  const approvals: string[][] = [];
  return {
    approvals,
    service: {
      async analyze() { return currentPlan; },
      async readPlan() { return currentPlan; },
      async approve(_planId, selectedTaskIds) {
        approvals.push([...selectedTaskIds]);
        if (params?.approveError) throw params.approveError;
        return scheduledReceipt([...selectedTaskIds]);
      },
      async readReceipt() { return undefined; },
      async cancel() { throw new Error("unused"); },
    },
  };
}

function createPeer(params: {
  response?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}): {
  peer: McpServerPeer;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    requests,
    peer: {
      clientCapabilities: params.capabilities ?? { elicitation: { form: {} } },
      async request<T>(method: string, requestParams: Record<string, unknown>): Promise<T> {
        requests.push({ method, params: requestParams });
        return (params.response ?? {
          action: "accept",
          content: { task_1: true, task_2: false },
        }) as T;
      },
    },
  };
}

test("Codex Cleaner maps ordinal form fields to exact selectable task IDs", async () => {
  const { service, approvals } = createService();
  const { peer, requests } = createPeer({});
  const tool = createCodexCleanerMcpTool({
    service,
    async resolveSessionId() { return "session-1"; },
  });

  const result = await tool.call({}, peer);

  assert.equal(CODEX_CLEANER_MCP_SERVER_NAME, "lightrsi_cleaner");
  assert.equal(CODEX_CLEAN_TOOL_NAME, "lightrsi_clean");
  assert.equal(tool.definition.name, CODEX_CLEAN_TOOL_NAME);
  assert.deepEqual(tool.definition.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {},
  });
  assert.deepEqual(approvals, [["task-a-exact"]]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "elicitation/create");
  assert.equal(requests[0]?.params.mode, "form");
  assert.match(String(requests[0]?.params.message), /task-c-protected/);
  const schema = requests[0]?.params.requestedSchema as {
    properties?: Record<string, { default?: boolean; description?: string }>;
    required?: string[];
  };
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["task_1", "task_2"]);
  assert.deepEqual(schema.required, ["task_1", "task_2"]);
  assert.equal(schema.properties?.task_1?.default, false);
  assert.match(schema.properties?.task_1?.description ?? "", /task-a-exact/);
  assert.equal(JSON.stringify(schema).includes("task-c-protected"), false);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent?.selectedTaskIds, ["task-a-exact"]);
});

test("Codex Cleaner does not approve cancelled, declined, or empty selections", async () => {
  for (const response of [
    { action: "cancel" },
    { action: "decline" },
    { action: "accept", content: { task_1: false, task_2: false } },
  ]) {
    const { service, approvals } = createService();
    const { peer } = createPeer({ response });
    const tool = createCodexCleanerMcpTool({
      service,
      async resolveSessionId() { return "session-1"; },
    });

    const result = await tool.call({}, peer);

    assert.deepEqual(approvals, []);
    assert.equal(result.isError, false);
  }
});

test("Codex Cleaner fails safely without form elicitation capability", async () => {
  const { service, approvals } = createService();
  const { peer, requests } = createPeer({ capabilities: {} });
  const tool = createCodexCleanerMcpTool({
    service,
    async resolveSessionId() { return "session-1"; },
  });

  const result = await tool.call({}, peer);

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /lightrsi codex clean/);
  assert.deepEqual(requests, []);
  assert.deepEqual(approvals, []);
});

test("Codex Cleaner skips elicitation when analysis has no selectable tasks", async () => {
  const currentPlan = plan();
  currentPlan.tasks = currentPlan.tasks.map((task) => ({ ...task, selectable: false }));
  const { service, approvals } = createService({ currentPlan });
  const { peer, requests } = createPeer({ capabilities: {} });
  const tool = createCodexCleanerMcpTool({
    service,
    async resolveSessionId() { return "session-1"; },
  });

  const result = await tool.call({}, peer);

  assert.equal(result.isError, false);
  assert.match(String(result.content[0]?.text), /No selectable tasks/);
  assert.deepEqual(requests, []);
  assert.deepEqual(approvals, []);
});

test("Codex Cleaner returns approval errors without substituting a plan", async () => {
  const { service, approvals } = createService({
    approveError: new Error("clean_approval_scheduled_conflict"),
  });
  const { peer, requests } = createPeer({});
  const tool = createCodexCleanerMcpTool({
    service,
    async resolveSessionId() { return "session-1"; },
  });

  const result = await tool.call({}, peer);

  assert.equal(requests.length, 1);
  assert.deepEqual(approvals, [["task-a-exact"]]);
  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /clean_approval_scheduled_conflict/);
  assert.equal(result.structuredContent?.planId, "ctxclean-selection-test");
});
