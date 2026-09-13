import { emitKeypressEvents } from "node:readline";

import { estimateCleanSelection, renderCleanPlan, type CleanPlanView } from "./clean-renderer.js";

type CleanPromptKey = { name?: string; ctrl?: boolean };
type CleanPromptKeypressHandler = (value: string, key: CleanPromptKey) => void;

export type CleanTaskPromptResult =
  | { action: "submit"; selectedTaskIds: string[] }
  | { action: "cancel" }
  | { action: "interrupt" };

export type CleanTaskPrompt = (plan: CleanPlanView) => Promise<CleanTaskPromptResult>;

export type CleanPromptTerminal = {
  input: {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(value: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: "keypress", listener: CleanPromptKeypressHandler): unknown;
    off(event: "keypress", listener: CleanPromptKeypressHandler): unknown;
  };
  output: {
    isTTY?: boolean;
    write(value: string): unknown;
  };
  emitKeypressEvents(input: CleanPromptTerminal["input"]): void;
};

const processTerminal: CleanPromptTerminal = {
  input: process.stdin,
  output: process.stdout,
  emitKeypressEvents(input) {
    emitKeypressEvents(input as NodeJS.ReadableStream);
  },
};

export function createInitialCleanPromptState(plan: CleanPlanView): {
  selectedTaskIds: string[];
  text: string;
} {
  return {
    selectedTaskIds: [],
    text: renderCleanPlan(plan),
  };
}

export async function promptForCleanTasks(
  plan: CleanPlanView,
  terminal: CleanPromptTerminal = processTerminal,
): Promise<CleanTaskPromptResult> {
  const choices = plan.tasks.filter((task) => task.selectable);
  if (!terminal.input.isTTY || !terminal.output.isTTY) return { action: "cancel" };

  const initial = createInitialCleanPromptState(plan);
  terminal.output.write(`${initial.text}\n\n`);
  if (choices.length === 0) return { action: "submit", selectedTaskIds: [] };

  const selected = new Set(initial.selectedTaskIds);
  let cursor = 0;
  terminal.emitKeypressEvents(terminal.input);
  const render = (first: boolean) => {
    if (!first) terminal.output.write(`\u001b[${choices.length + 2}A`);
    terminal.output.write("Select tasks to clean (Up/Down move, Space toggle, Enter submit, q cancel)\n");
    for (const [index, task] of choices.entries()) {
      const marker = index === cursor ? ">" : " ";
      const checked = selected.has(task.taskId) ? "x" : " ";
      terminal.output.write(`${marker} [${checked}] ${task.taskId} - ${task.label}\u001b[K\n`);
    }
    const estimate = estimateCleanSelection(plan, [...selected]);
    const estimateText = estimate.tokens === null ? `${estimate.chars} chars` : `${estimate.tokens} tok`;
    terminal.output.write(`Selected estimated release: ${estimateText}\u001b[K\n`);
  };

  return new Promise<CleanTaskPromptResult>((resolve) => {
    const previousRaw = terminal.input.isRaw;
    let settled = false;
    const cleanup = () => {
      terminal.input.off("keypress", onKeypress);
      terminal.input.setRawMode?.(Boolean(previousRaw));
      terminal.input.pause();
      terminal.output.write("\u001b[?25h");
    };
    const finish = (value: CleanTaskPromptResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onKeypress: CleanPromptKeypressHandler = (_value, key) => {
      if (key.ctrl && key.name === "c") {
        return finish({ action: "interrupt" });
      }
      if (key.name === "q" || key.name === "escape") return finish({ action: "cancel" });
      if (key.name === "return" || key.name === "enter") {
        return finish({
          action: "submit",
          selectedTaskIds: choices
            .filter((task) => selected.has(task.taskId))
            .map((task) => task.taskId),
        });
      }
      if (key.name === "up") cursor = (cursor + choices.length - 1) % choices.length;
      else if (key.name === "down") cursor = (cursor + 1) % choices.length;
      else if (key.name === "space") {
        const taskId = choices[cursor]!.taskId;
        if (selected.has(taskId)) selected.delete(taskId);
        else selected.add(taskId);
      } else return;
      render(false);
    };
    terminal.input.setRawMode?.(true);
    terminal.input.resume();
    terminal.input.on("keypress", onKeypress);
    terminal.output.write("\u001b[?25l");
    render(true);
  });
}
