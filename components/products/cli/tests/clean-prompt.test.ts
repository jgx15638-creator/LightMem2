import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createInitialCleanPromptState,
  createProcessCleanPromptTerminal,
  promptForCleanTasks,
  type CleanPromptTerminal,
} from "../src/clean-prompt.js";
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
  onResume?: () => void;

  setRawMode(value: boolean) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {
    this.resumed += 1;
    this.onResume?.();
  }

  pause() {
    this.paused += 1;
  }
}

function createFakeTerminal(columns = 80, supportsAnchoredFrames = false) {
  const input = new FakePromptInput();
  const writes: string[] = [];
  const output: CleanPromptTerminal["output"] = {
    isTTY: true,
    columns,
    supportsAnchoredFrames,
    write(value: string) {
      writes.push(value);
    },
    close() {},
  };
  return {
    input,
    writes,
    terminal: {
      input,
      output,
      emitKeypressEvents() {},
    },
  };
}

function longInteractivePlan(): CleanPlanView {
  const base = interactivePlan();
  return {
    ...base,
    tasks: [
      {
        ...base.tasks[0]!,
        taskId: "codex-synth-e8f2a0e6-3906-4209-80e2-ea522ff591dd:t1-task",
        label: "Task A: Authentication and authorization with a deliberately long explanation",
      },
      {
        ...base.tasks[1]!,
        taskId: "codex-synth-e8f2a0e6-3906-4209-80e2-ea522ff591dd:t2-task",
        label: "Task B: 数据库索引的优点与代价",
      },
      {
        ...base.tasks[2]!,
        taskId: "codex-synth-e8f2a0e6-3906-4209-80e2-ea522ff591dd:t3-task",
        label: "Task C: Release approval pending",
      },
    ],
  };
}

function visibleWidth(value: string): number {
  return [...value].reduce((width, character) => {
    return width + (/^[\u2e80-\u9fff]$/u.test(character) ? 2 : 1);
  }, 0);
}

function renderAnsiFrames(values: string[]): string[] {
  const rows: string[] = [];
  let row = 0;
  let column = 0;
  let savedRow = 0;
  let savedColumn = 0;

  const ensureRow = () => {
    while (rows.length <= row) rows.push("");
  };
  const writeText = (value: string) => {
    ensureRow();
    const current = rows[row] ?? "";
    rows[row] = `${current.slice(0, column)}${value}${current.slice(column + value.length)}`;
    column += value.length;
  };

  for (const value of values) {
    for (let index = 0; index < value.length;) {
      if (value[index] === "\u001b" && value[index + 1] === "[") {
        const match = /^\u001b\[([0-9;?]*)([A-Za-z])/u.exec(value.slice(index));
        assert.ok(match, `Unsupported ANSI sequence: ${JSON.stringify(value.slice(index, index + 12))}`);
        const count = Number.parseInt(match[1] || "1", 10);
        if (match[2] === "F") {
          row = Math.max(0, row - count);
          column = 0;
        } else if (match[2] === "E") {
          row += count;
          column = 0;
        } else if (match[2] === "K" && match[1] === "2") {
          ensureRow();
          rows[row] = "";
        } else if (match[2] === "s") {
          savedRow = row;
          savedColumn = column;
        } else if (match[2] === "u") {
          row = savedRow;
          column = savedColumn;
        } else if (!((match[2] === "l" || match[2] === "h") && match[1] === "?25")) {
          assert.fail(`Unsupported ANSI command: ${match[0]}`);
        }
        index += match[0].length;
      } else if (value[index] === "\n") {
        row += 1;
        index += 1;
      } else if (value[index] === "\r") {
        column = 0;
        index += 1;
      } else {
        let end = index + 1;
        while (end < value.length && value[end] !== "\u001b" && value[end] !== "\n" && value[end] !== "\r") end += 1;
        writeText(value.slice(index, end));
        index = end;
      }
    }
  }
  return rows;
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

test("interactive rows stay within the terminal width and keep task IDs in the static plan", async () => {
  const { input, writes, terminal } = createFakeTerminal(64);
  const pending = (promptForCleanTasks as Function)(longInteractivePlan(), terminal);

  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "q" });
  await pending;

  const output = writes.join("");
  const interactiveOutput = output.split("\u001b[?25l").at(-1) ?? "";
  const visibleLines = interactiveOutput
    .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replaceAll("\r", "")
    .split("\n")
    .filter(Boolean);

  assert.match(output.split("\u001b[?25l")[0] ?? "", /codex-synth-e8f2a0e6/);
  assert.doesNotMatch(interactiveOutput, /codex-synth-e8f2a0e6/);
  assert.match(interactiveOutput, /\[-\] Task C: Release approval pending.*protected/);
  assert.equal(
    visibleLines.every((line) => line.length <= 64),
    true,
    `interactive output exceeded 64 columns:\n${visibleLines.join("\n")}`,
  );
});

test("interactive rows also fit a narrow terminal with Chinese task labels", async () => {
  const { input, writes, terminal } = createFakeTerminal(28);
  const pending = (promptForCleanTasks as Function)(longInteractivePlan(), terminal);

  input.emit("keypress", "", { name: "q" });
  await pending;

  const interactiveOutput = writes.join("").split("\u001b[?25l").at(-1) ?? "";
  const visibleLines = interactiveOutput
    .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replaceAll("\r", "")
    .split("\n")
    .filter(Boolean);
  assert.equal(
    visibleLines.every((line) => visibleWidth(line) < 28),
    true,
    `interactive output exceeded 27 display columns:\n${visibleLines.join("\n")}`,
  );
});

test("initial selector frame is emitted as one terminal write", async () => {
  const { input, writes, terminal } = createFakeTerminal(64);
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

  assert.equal(writes.length, 2);
  assert.match(writes[1] ?? "", /^\u001b\[\?25l/);
  assert.equal(writes[1]?.match(/\r\u001b\[2K/g)?.length, 9);

  input.emit("keypress", "", { name: "q" });
  await pending;
});

test("redraw commits one fixed-height frame and leaves a guard row", async () => {
  const { input, writes, terminal } = createFakeTerminal(64);
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);
  const redrawStart = writes.length;

  input.emit("keypress", "", { name: "down" });
  const redrawWrites = writes.slice(redrawStart);
  const redraw = redrawWrites[0] ?? "";
  input.emit("keypress", "", { name: "q" });
  await pending;

  assert.equal(redrawWrites.length, 1);
  assert.match(redraw, /^\u001b\[8F/);
  assert.equal(redraw.match(/\r\u001b\[2K/g)?.length, 9);
  assert.match(redraw, /\r\u001b\[2K$/);
});

test("redraw restores the selector anchor after host output moves the shared cursor", async () => {
  const { input, writes, terminal } = createFakeTerminal(64, true);
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

  assert.match(writes[1] ?? "", /\u001b\[s/);
  assert.match(writes[1] ?? "", /\u001b\[u\u001b\[8E\r\u001b\[2K$/);

  terminal.output.write("\u2022 Working\n");
  const redrawStart = writes.length;
  input.emit("keypress", "", { name: "down" });
  const redraw = writes[redrawStart] ?? "";
  input.emit("keypress", "", { name: "q" });
  await pending;

  assert.match(redraw, /^\u001b\[u/);
  assert.doesNotMatch(redraw, /^\u001b\[\d+F/);
  assert.match(redraw, /\u001b\[u\u001b\[8E\r\u001b\[2K$/);
});

test("Windows absolute frame output owns selector redraw and cleanup", async () => {
  const { input, terminal } = createFakeTerminal(64);
  const frames: string[][] = [];
  let finished = 0;
  terminal.output.renderFrame = (lines: string[]) => {
    frames.push(lines);
    return true;
  };
  terminal.output.finishFrame = () => {
    finished += 1;
  };
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "q" });

  assert.deepEqual(await pending, { action: "cancel" });
  assert.equal(frames.length, 2);
  assert.match(frames[0]?.[2] ?? "", /^> \[ \] Task A/);
  assert.match(frames[1]?.[3] ?? "", /^> \[ \] Task B/);
  assert.equal(finished, 1);
});

test("anchored redraw replaces one selector after an external Working update", async () => {
  const { input, writes, terminal } = createFakeTerminal(64, true);
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);
  const initialFrame = writes[1] ?? "";

  const hostUpdate = "\u2022 Working\n";
  input.emit("keypress", "", { name: "down" });
  const redraw = writes.at(-1) ?? "";
  input.emit("keypress", "", { name: "q" });
  await pending;

  const screen = renderAnsiFrames([initialFrame, hostUpdate, redraw]);
  assert.equal(screen.filter((line) => line === "Select tasks to clean").length, 1);
  assert.equal(screen.filter((line) => line.includes("Up/Down move")).length, 1);
  assert.equal(screen.some((line) => line.startsWith("> [ ] Task B")), true);
  assert.equal(screen.some((line) => line.includes("Working")), false);
});

test("reentrant key events serialize selector frame writes", async () => {
  const { input, writes, terminal } = createFakeTerminal(64);
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);
  let depth = 0;
  let maxDepth = 0;
  let triggerNestedKeys = true;
  terminal.output.write = (value: string) => {
    depth += 1;
    maxDepth = Math.max(maxDepth, depth);
    writes.push(value);
    if (triggerNestedKeys) {
      triggerNestedKeys = false;
      input.emit("keypress", "", { name: "down" });
      input.emit("keypress", "", { name: "down" });
    }
    depth -= 1;
  };

  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "space" });
  input.emit("keypress", "", { name: "enter" });

  assert.deepEqual(await pending, {
    action: "submit",
    selectedTaskIds: ["task-b"],
  });
  assert.equal(maxDepth, 1);
});

test("the key listener is ready before a Windows console reader starts", async () => {
  const { input, terminal } = createFakeTerminal();
  input.onResume = () => {
    input.emit("keypress", "", { name: "space" });
    input.emit("keypress", "", { name: "enter" });
  };

  assert.deepEqual(await (promptForCleanTasks as Function)(interactivePlan(), terminal), {
    action: "submit",
    selectedTaskIds: ["task-a"],
  });
});

test("Windows redirected prompts use the attached console for input and output", () => {
  const redirectedInput = new FakePromptInput();
  redirectedInput.isTTY = false;
  const redirectedWrites: string[] = [];
  const redirectedOutput = {
    isTTY: false,
    write(value: string) {
      redirectedWrites.push(value);
    },
  };
  const consoleInput = new FakePromptInput();
  const consoleWrites: string[] = [];
  const consoleOutput = {
    isTTY: true as const,
    write(value: string) {
      consoleWrites.push(value);
      return true;
    },
    close() {},
  };
  const terminal = createProcessCleanPromptTerminal({
    platform: "win32",
    env: { LIGHTRSI_WINDOWS_CONSOLE_INPUT: "1" },
    input: redirectedInput,
    output: redirectedOutput,
    createWindowsInput: () => consoleInput,
    createWindowsOutput: () => consoleOutput,
  });

  assert.equal(terminal.input, consoleInput);
  assert.equal(terminal.output, consoleOutput);
  assert.deepEqual(redirectedWrites, []);
  assert.deepEqual(consoleWrites, []);
});

test("prompt cleanup closes a dedicated terminal output", async () => {
  const { input, terminal } = createFakeTerminal();
  let closeCalls = 0;
  terminal.output.close = () => {
    closeCalls += 1;
  };
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);

  input.emit("keypress", "", { name: "q" });

  assert.deepEqual(await pending, { action: "cancel" });
  assert.equal(closeCalls, 1);
});

test("modal Windows prompt returns one complete final transcript with selection marks", async () => {
  const { input, terminal } = createFakeTerminal();
  terminal.output.preserveTranscript = true;
  terminal.output.ready = async () => true;
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);
  await Promise.resolve();

  input.emit("keypress", "", { name: "space" });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "space" });
  input.emit("keypress", "", { name: "enter" });

  const result = await pending;
  assert.equal(result.action, "submit");
  assert.deepEqual(result.selectedTaskIds, ["task-a", "task-b"]);
  assert.match(result.transcript, /Context clean plan plan-1/);
  assert.match(result.transcript, /  \[x\] Task A · 60 tok/);
  assert.match(result.transcript, /> \[x\] Task B · 60 tok/);
  assert.match(result.transcript, /  \[-\] Task C · protected/);
  assert.match(result.transcript, /Selected estimated release: 120 tok/);
  assert.equal(result.transcript.match(/Select tasks to clean/g)?.length, 1);
});

test("modal Windows cancellation preserves the last visible selection state", async () => {
  const { input, terminal } = createFakeTerminal();
  terminal.output.preserveTranscript = true;
  terminal.output.ready = async () => true;
  const pending = (promptForCleanTasks as Function)(interactivePlan(), terminal);
  await Promise.resolve();

  input.emit("keypress", "", { name: "space" });
  input.emit("keypress", "", { name: "q" });

  const result = await pending;
  assert.equal(result.action, "cancel");
  assert.match(result.transcript, /> \[x\] Task A · 60 tok/);
  assert.match(result.transcript, /  \[ \] Task B · 60 tok/);
  assert.match(result.transcript, /Selected estimated release: 60 tok/);
});

test("modal Windows prompt cancels safely when the screen buffer is unavailable", async () => {
  const { input, writes, terminal } = createFakeTerminal();
  let closeCalls = 0;
  terminal.output.preserveTranscript = true;
  terminal.output.ready = async () => false;
  terminal.output.close = async () => {
    closeCalls += 1;
  };

  assert.deepEqual(await (promptForCleanTasks as Function)(interactivePlan(), terminal), {
    action: "cancel",
    reason: "windows_console_buffer_unavailable",
  });
  assert.equal(input.resumed, 0);
  assert.deepEqual(writes, []);
  assert.equal(closeCalls, 1);
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
