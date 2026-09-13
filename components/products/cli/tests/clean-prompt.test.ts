import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createInitialCleanPromptState, promptForCleanTasks } from "../src/clean-prompt.js";
import type { CleanPlanView } from "../src/clean-renderer.js";

function plan(): CleanPlanView {
  return {
    planId: "plan-1",
    hostId: "codex",
    sessionId: "session-1",
    contextWindowTokens: 100,
    usedTokens: 80,
    usedChars: 320,
    protectedTokens: 20,
    protectedChars: 80,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "estimated",
    tasks: [
      { taskId: "task-completed", label: "Completed", description: "Completed work", lifecycleState: "completed", tokenCount: 60,
        charCount: 240, tokenPercent: 75, recommendation: "clean", reasonCodes: [], selectable: true },
      { taskId: "system", label: "System", description: "System instructions", lifecycleState: "protected", tokenCount: 20,
        charCount: 80, tokenPercent: 25, recommendation: "protected", reasonCodes: ["system_instruction"], selectable: false },
    ],
  };
}

function interactivePlan(): CleanPlanView {
  const base = plan();
  return {
    ...base,
    tasks: [
      { ...base.tasks[0]!, taskId: "task-a", label: "Task A" },
      { ...base.tasks[0]!, taskId: "task-b", label: "Task B" },
      { ...base.tasks[1]!, taskId: "task-protected", label: "Task C" },
    ],
  };
}

class FakePromptInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  resumed = 0;
  paused = 0;

  setRawMode(value: boolean) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {
    this.resumed += 1;
  }

  pause() {
    this.paused += 1;
  }
}

function createFakeTerminal() {
  const input = new FakePromptInput();
  const writes: string[] = [];
  return {
    input,
    writes,
    terminal: {
      input,
      output: {
        isTTY: true,
        write(value: string) {
          writes.push(value);
        },
      },
      emitKeypressEvents() {},
    },
  };
}

test("interactive clean starts with no selection and shows the complete plan", () => {
  const state = createInitialCleanPromptState(plan());

  assert.deepEqual(state.selectedTaskIds, []);
  assert.match(state.text, /Context usage: 80 \/ 100 tok \(80\.0%\)/);
  assert.match(state.text, /\[ \].*task-completed/);
  assert.match(state.text, /\[-\].*system.*System instructions/);
  assert.match(state.text, /Protected context: 20 tok/);
});

test("space toggles selectable tasks and enter submits immediately", async () => {
  const { input, writes, terminal } = createFakeTerminal();
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

  input.emit("keypress", "", { name: "space" });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "space" });
  input.emit("keypress", "", { name: "enter" });

  assert.deepEqual(await pending, {
    action: "submit",
    selectedTaskIds: ["task-a", "task-b"],
  });
  assert.doesNotMatch(writes.join(""), /Confirm clean/);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.resumed, 1);
  assert.equal(input.paused, 1);
  assert.match(writes.join(""), /\u001b\[\?25l/);
  assert.match(writes.join(""), /\u001b\[\?25h/);
});

test("up and down wrap only among selectable tasks", async () => {
  const up = createFakeTerminal();
  const upPending = (promptForCleanTasks as Function)(interactivePlan(), up.terminal);
  up.input.emit("keypress", "", { name: "up" });
  up.input.emit("keypress", "", { name: "space" });
  up.input.emit("keypress", "", { name: "enter" });
  assert.deepEqual(await upPending, {
    action: "submit",
    selectedTaskIds: ["task-b"],
  });

  const down = createFakeTerminal();
  const downPending = (promptForCleanTasks as Function)(interactivePlan(), down.terminal);
  down.input.emit("keypress", "", { name: "down" });
  down.input.emit("keypress", "", { name: "down" });
  down.input.emit("keypress", "", { name: "space" });
  down.input.emit("keypress", "", { name: "enter" });
  assert.deepEqual(await downPending, {
    action: "submit",
    selectedTaskIds: ["task-a"],
  });
});

test("enter submits an empty selection without a confirmation step", async () => {
  const { input, writes, terminal } = createFakeTerminal();
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

  input.emit("keypress", "", { name: "enter" });

  assert.deepEqual(await pending, { action: "submit", selectedTaskIds: [] });
  assert.doesNotMatch(writes.join(""), /Confirm clean/);
});

for (const keyName of ["q", "escape"]) {
  test(`${keyName} returns an explicit cancellation and restores the terminal`, async () => {
    const { input, writes, terminal } = createFakeTerminal();
    const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

    input.emit("keypress", "", { name: keyName });

    assert.deepEqual(await pending, { action: "cancel" });
    assert.deepEqual(input.rawModes, [true, false]);
    assert.equal(input.paused, 1);
    assert.match(writes.at(-1) ?? "", /\u001b\[\?25h/);
  });
}

test("Ctrl+C returns an interrupt and ignores later terminal events", async () => {
  const { input, terminal } = createFakeTerminal();
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

  input.emit("keypress", "", { name: "c", ctrl: true });
  input.emit("keypress", "", { name: "enter" });

  assert.deepEqual(await pending, { action: "interrupt" });
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.paused, 1);
});
