import { emitKeypressEvents } from "node:readline";

import {
  estimateCleanSelection,
  renderCleanPlan,
  truncateTerminalText,
  type CleanPlanView,
} from "./clean-renderer.js";
import { createWindowsConsoleKeyInput } from "./windows-console-key-input.js";
import { createWindowsConsoleOutput } from "./windows-console-output.js";

type CleanPromptKey = { name?: string; ctrl?: boolean };
type CleanPromptKeypressHandler = (value: string, key: CleanPromptKey) => void;

export type CleanTaskPromptResult =
  | { action: "submit"; selectedTaskIds: string[]; transcript?: string }
  | {
      action: "cancel";
      transcript?: string;
      reason?: "windows_console_buffer_unavailable";
    }
  | { action: "interrupt"; transcript?: string };

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
    columns?: number;
    supportsAnchoredFrames?: boolean;
    preserveTranscript?: boolean;
    ready?(): Promise<boolean>;
    write(value: string): unknown;
    renderFrame?(lines: string[]): boolean;
    finishFrame?(): void;
    close?(): void | Promise<void>;
  };
  emitKeypressEvents(input: CleanPromptTerminal["input"]): void;
};

const WINDOWS_CONSOLE_INPUT_ENV = "LIGHTRSI_WINDOWS_CONSOLE_INPUT";
const DEFAULT_PROMPT_COLUMNS = 80;

function cleanPromptTaskSize(task: CleanPlanView["tasks"][number]): string {
  return task.tokenCount === null ? `${task.charCount} chars` : `${task.tokenCount} tok`;
}

export function processCleanPromptIsInteractive(params?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  inputIsTTY?: boolean;
  outputIsTTY?: boolean;
}): boolean {
  const inputIsTTY = params?.inputIsTTY ?? process.stdin.isTTY;
  const outputIsTTY = params?.outputIsTTY ?? process.stdout.isTTY;
  if (inputIsTTY && outputIsTTY) return true;
  return (params?.platform ?? process.platform) === "win32"
    && (params?.env ?? process.env)[WINDOWS_CONSOLE_INPUT_ENV] === "1";
}

export function createProcessCleanPromptTerminal(params?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  input?: CleanPromptTerminal["input"];
  output?: CleanPromptTerminal["output"];
  createWindowsInput?: () => CleanPromptTerminal["input"];
  createWindowsOutput?: () => CleanPromptTerminal["output"];
}): CleanPromptTerminal {
  const input = params?.input ?? process.stdin;
  const output = params?.output ?? process.stdout;
  const interactive = processCleanPromptIsInteractive({
    platform: params?.platform,
    env: params?.env,
    inputIsTTY: input.isTTY,
    outputIsTTY: output.isTTY,
  });
  if (interactive && (!input.isTTY || !output.isTTY)) {
    return {
      input: (params?.createWindowsInput ?? createWindowsConsoleKeyInput)(),
      output: (params?.createWindowsOutput ?? createWindowsConsoleOutput)(),
      emitKeypressEvents() {},
    };
  }
  return {
    input,
    output,
    emitKeypressEvents(input) {
      emitKeypressEvents(input as NodeJS.ReadableStream);
    },
  };
}

export function createInitialCleanPromptState(plan: CleanPlanView, maxWidth?: number): {
  selectedTaskIds: string[];
  text: string;
} {
  return {
    selectedTaskIds: [],
    text: renderCleanPlan(plan, { maxWidth }),
  };
}

export async function promptForCleanTasks(
  plan: CleanPlanView,
  terminal: CleanPromptTerminal = createProcessCleanPromptTerminal(),
): Promise<CleanTaskPromptResult> {
  const choices = plan.tasks.filter((task) => task.selectable);
  if (!terminal.input.isTTY || !terminal.output.isTTY) return { action: "cancel" };

  if (terminal.output.ready && !await terminal.output.ready()) {
    await terminal.output.close?.();
    return { action: "cancel", reason: "windows_console_buffer_unavailable" };
  }

  const availableColumns = Math.max(2, terminal.output.columns ?? DEFAULT_PROMPT_COLUMNS);
  const lineWidth = availableColumns - 1;
  const initial = createInitialCleanPromptState(plan, lineWidth);
  terminal.output.write(`${initial.text}\n\n`);
  if (choices.length === 0) {
    await terminal.output.close?.();
    return {
      action: "submit",
      selectedTaskIds: [],
      ...(terminal.output.preserveTranscript ? { transcript: initial.text } : {}),
    };
  }

  const selected = new Set(initial.selectedTaskIds);
  let cursor = 0;
  let renderedLineCount = 0;
  let rendering = false;
  let renderRequested = false;
  let settled = false;
  let absoluteFrames = false;
  terminal.emitKeypressEvents(terminal.input);
  const selectorLines = () => {
    const estimate = estimateCleanSelection(plan, [...selected]);
    const estimateText = estimate.tokens === null ? `${estimate.chars} chars` : `${estimate.tokens} tok`;
    const activeTaskId = choices[cursor]!.taskId;
    const separator = "-".repeat(lineWidth);
    return [
      "Select tasks to clean",
      separator,
      ...plan.tasks.map((task) => {
        const marker = task.taskId === activeTaskId ? ">" : " ";
        const checked = task.selectable ? (selected.has(task.taskId) ? "x" : " ") : "-";
        const status = task.selectable ? cleanPromptTaskSize(task) : "protected";
        return `${marker} [${checked}] ${task.label} · ${status}`;
      }),
      separator,
      `Selected estimated release: ${estimateText}`,
      "Up/Down move · Space toggle · Enter submit · q cancel",
    ].map((line) => truncateTerminalText(line, lineWidth));
  };
  const render = () => {
    if (settled) return;
    renderRequested = true;
    if (rendering) return;

    rendering = true;
    try {
      while (renderRequested && !settled) {
        renderRequested = false;
        const lines = selectorLines();
        if (terminal.output.renderFrame?.(lines) === true) {
          absoluteFrames = true;
          renderedLineCount = lines.length;
          continue;
        }
        const firstFrame = renderedLineCount === 0;
        const anchored = terminal.output.supportsAnchoredFrames === true;
        const framePrefix = anchored
          ? firstFrame
            ? `\u001b[?25l${"\n".repeat(lines.length)}\u001b[${lines.length}F\u001b[s`
            : "\u001b[u"
          : firstFrame
            ? "\u001b[?25l"
            : `\u001b[${renderedLineCount}F`;
        const frameBody = anchored
          ? lines.map((line, index) => (
              `\r\u001b[2K${line}${index + 1 < lines.length ? "\n" : ""}`
            )).join("")
          : lines.map((line) => `\r\u001b[2K${line}\n`).join("");
        const frameSuffix = anchored
          ? `\u001b[u\u001b[${lines.length}E\r\u001b[2K`
          : "\r\u001b[2K";
        const frame = `${framePrefix}${frameBody}${frameSuffix}`;

        terminal.output.write(frame);
        renderedLineCount = lines.length;
      }
    } finally {
      rendering = false;
    }
  };

  return new Promise<CleanTaskPromptResult>((resolve) => {
    const previousRaw = terminal.input.isRaw;
    const cleanup = async () => {
      terminal.input.off("keypress", onKeypress);
      terminal.input.setRawMode?.(Boolean(previousRaw));
      terminal.input.pause();
      try {
        if (absoluteFrames) {
          terminal.output.finishFrame?.();
        } else {
          const restoreHostCursor = terminal.output.supportsAnchoredFrames && renderedLineCount > 0
            ? `\u001b[u\u001b[${renderedLineCount}E\r\u001b[2K`
            : "";
          terminal.output.write(`${restoreHostCursor}\u001b[?25h`);
        }
      } finally {
        await terminal.output.close?.();
      }
    };
    const finish = (value: CleanTaskPromptResult) => {
      if (settled) return;
      const completed = terminal.output.preserveTranscript
        ? {
            ...value,
            transcript: `${initial.text}\n\n${selectorLines().join("\n")}`,
          }
        : value;
      settled = true;
      void cleanup().then(() => resolve(completed));
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
      render();
    };
    terminal.input.on("keypress", onKeypress);
    terminal.input.setRawMode?.(true);
    terminal.input.resume();
    render();
  });
}
