import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  createContextCleanerControlPlane,
  createContextCleanerControlService,
  saveContextCleanPlan,
  type ContextCleanPlan,
  type ContextCleanerHostBridge,
  type ExecuteApprovedContextCleanParams,
} from "../src/index.js";

function storedPlan(): ContextCleanPlan {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: "plan-control-service",
    hostId: "codex",
    sessionId: "session-1",
    baseRevision: "revision-1",
    usedTokens: 100,
    usedChars: 400,
    protectedTokens: 0,
    protectedChars: 0,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "estimated",
    tokenCountMethod: "fixture",
    tasks: [
      {
        taskId: "task-selectable",
        label: "Finished task",
        description: "Finished task description",
        summary: "Finished task summary",
        lifecycleState: "completed",
        itemIds: ["item-b", "item-a"],
        itemDigests: {
          "item-a": "digest-a",
          "item-b": "digest-b",
        },
        tokenCount: 75,
        charCount: 300,
        tokenPercent: 75,
        recommendation: "clean",
        reasonCodes: ["task_completed"],
        selectable: true,
      },
      {
        taskId: "task-protected",
        label: "Active task",
        description: "Active task description",
        summary: "Active task summary",
        lifecycleState: "active",
        itemIds: ["item-current"],
        itemDigests: { "item-current": "digest-current" },
        tokenCount: 25,
        charCount: 100,
        tokenPercent: 25,
        recommendation: "protected",
        reasonCodes: ["active_task"],
        selectable: false,
      },
    ],
    createdAt: "2026-09-13T00:00:00.000Z",
  };
}

test("control service recovers frozen task targets before scheduling", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-clean-control-service-"));
  try {
    const plan = storedPlan();
    await saveContextCleanPlan({ stateDir, plan });
    const controlPlane = createContextCleanerControlPlane({
      stateDir,
      now: () => "2026-09-13T00:02:00.000Z",
    });
    const requests: ExecuteApprovedContextCleanParams[] = [];
    const bridge: ContextCleanerHostBridge = {
      hostId: "codex",
      rewriteMode: "response_chain_rebase",
      async listSessions() { return []; },
      async readCleanSnapshot() { throw new Error("unused"); },
      async executeApprovedClean(request) {
        requests.push(request);
        return controlPlane.executeApprovedClean(request);
      },
      readCleanReceipt(planId) { return controlPlane.readCleanReceipt(planId); },
      cancelCleanPlan(planId) { return controlPlane.cancelCleanPlan(planId); },
    };
    const service = createContextCleanerControlService({
      stateDir,
      bridge,
      now: () => "2026-09-13T00:01:00.000Z",
    });

    assert.deepEqual(await service.readPlan(plan.planId), plan);
    const receipt = await service.approve(plan.planId, ["task-selectable"]);

    assert.equal(receipt.status, "scheduled");
    assert.deepEqual(receipt.selectedTaskIds, ["task-selectable"]);
    assert.deepEqual(requests, [{
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: plan.planId,
      hostId: plan.hostId,
      sessionId: plan.sessionId,
      baseRevision: plan.baseRevision,
      approvedAt: "2026-09-13T00:01:00.000Z",
      selectedTasks: [{
        taskId: "task-selectable",
        itemIds: ["item-b", "item-a"],
        itemDigests: {
          "item-a": "digest-a",
          "item-b": "digest-b",
        },
      }],
    }]);
    assert.deepEqual(await service.readReceipt(plan.planId), receipt);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("control service rejects invalid task selections before calling the Host", async () => {
  for (const [selection, error] of [
    [["missing-task"], /clean_selection_unknown_task:missing-task/],
    [["task-selectable", "task-selectable"], /clean_selection_duplicate_task/],
    [["task-protected"], /clean_selection_task_protected:task-protected/],
  ] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-clean-control-reject-"));
    try {
      const plan = storedPlan();
      await saveContextCleanPlan({ stateDir, plan });
      let executeCalls = 0;
      const bridge: ContextCleanerHostBridge = {
        hostId: "codex",
        rewriteMode: "response_chain_rebase",
        async listSessions() { return []; },
        async readCleanSnapshot() { throw new Error("unused"); },
        async executeApprovedClean() {
          executeCalls += 1;
          throw new Error("must_not_execute");
        },
        async readCleanReceipt() { return undefined; },
        async cancelCleanPlan() { throw new Error("unused"); },
      };
      const service = createContextCleanerControlService({ stateDir, bridge });

      await assert.rejects(service.approve(plan.planId, selection), error);
      assert.equal(executeCalls, 0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});
