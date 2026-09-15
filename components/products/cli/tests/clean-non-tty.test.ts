import assert from "node:assert/strict";
import test from "node:test";

import { handleCleanCommand, type CleanCommandBackend } from "../src/clean.js";
import { processCleanPromptIsInteractive } from "../src/clean-prompt.js";

test("Windows console launcher marker enables the interactive Cleaner without Node TTY flags", () => {
  assert.equal(processCleanPromptIsInteractive({
    platform: "win32",
    env: { LIGHTRSI_WINDOWS_CONSOLE_INPUT: "1" },
    inputIsTTY: false,
    outputIsTTY: false,
  }), true);
  assert.equal(processCleanPromptIsInteractive({
    platform: "win32",
    env: {},
    inputIsTTY: false,
    outputIsTTY: false,
  }), false);
});

test("non-interactive clean is analysis-only and never calls approve", async () => {
  let approved = false;
  const backend: CleanCommandBackend = {
    async analyze() {
      return {
        planId: "plan-non-tty", hostId: "claude-code", sessionId: "session-1",
        usedTokens: null, usedChars: 400, protectedTokens: null, protectedChars: 100,
        unassignedTokens: null, unassignedChars: 0, tokenCountMode: "chars",
        tasks: [{ taskId: "task-a", label: "Finished", description: "Finished task", lifecycleState: "completed", tokenCount: null,
          charCount: 300, tokenPercent: null, recommendation: "clean", reasonCodes: [], selectable: true }],
      };
    },
    async readPlan() { return undefined; },
    async approve() { approved = true; throw new Error("must not approve"); },
    async readReceipt() { return undefined; },
    async cancel() { throw new Error("unused"); },
  };
  const result = await handleCleanCommand({ args: [], sessionId: "session-1", backend, interactive: false });
  assert.equal(approved, false);
  assert.match(result.text, /Analysis only \(non-interactive\)/);
  assert.match(result.text, /1\. task-a - Finished/);
  assert.match(result.text, /None selected by default/);
  assert.match(result.text, /--plan plan-non-tty --select/);
  assert.match(result.text, /Recommended selection estimate: 300 chars/);
});

test("the dedicated clean alias rejects non-TTY analysis before creating a plan", async () => {
  const calls: string[] = [];
  const backend: CleanCommandBackend = {
    async analyze() { calls.push("analyze"); throw new Error("must not analyze"); },
    async readPlan() { calls.push("read-plan"); return undefined; },
    async approve() { calls.push("approve"); throw new Error("must not approve"); },
    async readReceipt() { calls.push("read-receipt"); return undefined; },
    async cancel() { calls.push("cancel"); throw new Error("must not cancel"); },
  };

  await assert.rejects(
    handleCleanCommand({
      args: ["--require-tty"],
      sessionId: "session-1",
      backend,
      interactive: false,
    }),
    /clean_interactive_tty_required/,
  );
  assert.deepEqual(calls, []);
});

test("the TTY marker preserves help, status, and cancel command behavior", async () => {
  const calls: string[] = [];
  const backend: CleanCommandBackend = {
    async analyze() { calls.push("analyze"); throw new Error("must not analyze"); },
    async readPlan() { calls.push("read-plan"); return undefined; },
    async approve() { calls.push("approve"); throw new Error("must not approve"); },
    async readReceipt(planId) {
      calls.push(`read-receipt:${planId}`);
      return undefined;
    },
    async cancel(planId) {
      calls.push(`cancel:${planId}`);
      return {
        planId,
        status: "cancelled",
        selectedTaskIds: [],
        estimatedSavedTokens: 0,
        estimatedSavedChars: 0,
        fallbackUsed: false,
        deferredTaskIds: [],
        reasons: [],
      };
    },
  };

  const help = await handleCleanCommand({ args: ["--require-tty", "--help"], backend });
  const status = await handleCleanCommand({
    args: ["--require-tty", "--status", "plan-1"],
    backend,
    interactive: false,
  });
  const cancelled = await handleCleanCommand({
    args: ["--require-tty", "--cancel", "plan-1"],
    backend,
    interactive: false,
  });

  assert.match(help.text, /lightrsi <host> clean/);
  assert.equal(status.text, "Context clean receipt not found: plan-1");
  assert.match(cancelled.text, /Context clean cancelled/);
  assert.deepEqual(calls, ["read-receipt:plan-1", "cancel:plan-1"]);
});
