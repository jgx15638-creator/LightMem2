import assert from "node:assert/strict";
import test from "node:test";

import { renderCleanPlan, renderCleanReceipt } from "../src/clean-renderer.js";

function terminalWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character)) continue;
    width += codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ) ? 2 : 1;
  }
  return width;
}

test("clean renderer shows task-level accounting without item ids", () => {
  const text = renderCleanPlan({
    planId: "plan-1",
    hostId: "codex",
    sessionId: "session-1",
    contextWindowTokens: 100,
    usedTokens: 80,
    usedChars: 320,
    protectedTokens: 10,
    protectedChars: 40,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "estimated",
    tasks: [
      { taskId: "task-a", label: "Finished work", description: "Finished the requested work",
        lifecycleState: "completed", tokenCount: 60, charCount: 240, tokenPercent: 75,
        recommendation: "clean", reasonCodes: ["completed_and_cold"], selectable: true },
      { taskId: "task-current", label: "Current work", description: "Work in progress",
        lifecycleState: "active", tokenCount: 20, charCount: 80, tokenPercent: 25,
        recommendation: "protected", reasonCodes: ["deterministic_protection"], selectable: false },
    ],
  });
  assert.match(text, /Context clean plan plan-1/);
  assert.match(text, /Context usage: 80 \/ 100 tok \(80\.0%\)/);
  assert.match(text, /Protected context: 10 tok/);
  assert.match(text, /Unassigned context: 0 tok/);
  assert.match(text, /\[ \].*task-a.*60 tok.*75\.0%.*clean/);
  assert.match(text, /\[-\].*task-current.*20 tok.*25\.0%.*protected/);
  assert.match(text, /completed_and_cold/);
  assert.match(text, /Task details:\n- task-a: Finished the requested work/);
  assert.match(text, /Reason codes:\n- task-a: completed_and_cold/);
  assert.doesNotMatch(text, /…|—/);
  const taskRows = text.split("\n").filter((line) => /^\[(?: |-)\]/.test(line));
  assert.equal(taskRows.length, 2);
  assert.ok(taskRows.every((line) => line.length <= 100));
  assert.doesNotMatch(text, /item-/);
});

test("clean renderer keeps the plan table and details within the terminal width", () => {
  const maxWidth = 96;
  const taskId = "codex-synth-12345678-1234-5678-90ab-1234567890ab:t1-task";
  const description = "用约 120 字说明 authentication 与 authorization 的区别，并各举一个简单例子。";
  const text = renderCleanPlan({
    planId: "ctxclean-1234567890abcdef",
    hostId: "codex",
    sessionId: "codex-synth-12345678-1234-5678-90ab-1234567890ab",
    contextWindowTokens: 100_000,
    usedTokens: 24_084,
    usedChars: 96_336,
    protectedTokens: 16_664,
    protectedChars: 66_656,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "exact",
    tasks: [{
      taskId,
      label: "任务 A：说明 authentication 与 authorization 的区别",
      description,
      lifecycleState: "completed",
      tokenCount: 3_089,
      charCount: 12_356,
      tokenPercent: 12.8,
      recommendation: "clean",
      reasonCodes: ["completed", "no_unresolved_issues", "no_future_reuse_signals"],
      selectable: true,
    }],
  }, { maxWidth });

  assert.match(text, /TASK\s+DESCRIPTION\s+SIZE\s+SHARE\s+ADVICE\s+RISK \/ REASONS/);
  assert.match(text, /Task details:/);
  assert.match(text, /Reason codes:/);
  assert.ok(text.split("\n").every((line) => terminalWidth(line) <= maxWidth));
});

test("receipt renderer distinguishes estimates from applied savings", () => {
  const text = renderCleanReceipt({
    planId: "plan-1",
    status: "applied",
    selectedTaskIds: ["task-a"],
    estimatedSavedTokens: 60,
    estimatedSavedChars: 240,
    appliedSavedTokens: 55,
    appliedSavedChars: 220,
    deferredTaskIds: [],
    reasons: [],
    fallbackUsed: false,
  });
  assert.match(text, /Estimated savings: 60 tok/);
  assert.match(text, /Scheduled savings: 60 tok/);
  assert.match(text, /Applied savings: 55 tok/);
  assert.match(text, /Fallback count: 0/);
});

test("receipt renderer never represents scheduled estimates as applied savings", () => {
  const text = renderCleanReceipt({
    planId: "plan-1",
    status: "scheduled",
    selectedTaskIds: ["task-a"],
    estimatedSavedTokens: 60,
    estimatedSavedChars: 240,
    deferredTaskIds: [],
    reasons: [],
    fallbackUsed: true,
  });
  assert.match(text, /Estimated savings: 60 tok/);
  assert.match(text, /Scheduled savings: 60 tok/);
  assert.match(text, /Applied savings: not applied/);
  assert.match(text, /Fallback count: 1/);
  assert.doesNotMatch(text, /Applied savings: 60 tok/);
});
