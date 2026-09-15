import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

type CleanPromptKey = { name?: string; ctrl?: boolean };
type CleanPromptKeypressHandler = (value: string, key: CleanPromptKey) => void;

type KeyReaderOutput = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export type WindowsConsoleKeyReader = {
  stdout: KeyReaderOutput | null;
  stderr: KeyReaderOutput | null;
  kill(): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number | null) => void): unknown;
};

export type WindowsConsoleKeyDiagnostic =
  | { event: "reader_start_error"; message: string }
  | { event: "reader_stdout_missing" }
  | { event: "reader_key"; key: string }
  | { event: "reader_stderr"; message: string }
  | { event: "reader_error"; message: string }
  | { event: "reader_exit"; code: number | null };

export type WindowsConsoleKeyInput = {
  isTTY: true;
  isRaw: false;
  setRawMode(value: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "keypress", listener: CleanPromptKeypressHandler): WindowsConsoleKeyInput;
  off(event: "keypress", listener: CleanPromptKeypressHandler): WindowsConsoleKeyInput;
};

export function windowsConsoleKeyReaderScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
$controlMask = [System.Management.Automation.Host.ControlKeyStates]::LeftCtrlPressed -bor [System.Management.Automation.Host.ControlKeyStates]::RightCtrlPressed
while ($true) {
    $pressed = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    $isControl = ($pressed.ControlKeyState -band $controlMask) -ne 0
    if ($isControl -and $pressed.VirtualKeyCode -eq 67) {
        [Console]::Out.WriteLine('interrupt')
        [Console]::Out.Flush()
        continue
    }
    $token = switch ($pressed.VirtualKeyCode) {
        38 { 'up' }
        40 { 'down' }
        32 { 'space' }
        13 { 'enter' }
        81 { 'q' }
        27 { 'escape' }
        default { $null }
    }
    if ($null -ne $token) {
        [Console]::Out.WriteLine($token)
        [Console]::Out.Flush()
    }
}
`;
}

export function windowsConsoleKeyReaderSpawnOptions(): {
  stdio: ["inherit", "pipe", "pipe"];
  windowsHide: false;
} {
  return {
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: false,
  };
}

function startWindowsConsoleKeyReader(): WindowsConsoleKeyReader {
  const powerShellPath = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encodedCommand = Buffer.from(windowsConsoleKeyReaderScript(), "utf16le").toString("base64");
  return spawn(powerShellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ], windowsConsoleKeyReaderSpawnOptions());
}

function keyFromToken(token: string): CleanPromptKey | undefined {
  if (["up", "down", "space", "enter", "q", "escape"].includes(token)) {
    return { name: token };
  }
  if (token === "interrupt") return { name: "c", ctrl: true };
  return undefined;
}

function reportIsolatedTestDiagnostic(diagnostic: WindowsConsoleKeyDiagnostic): void {
  const isolatedTestRoot = process.env.LIGHTRSI_ISOLATED_TEST_ROOT?.trim();
  if (!isolatedTestRoot) return;
  try {
    appendFileSync(
      join(isolatedTestRoot, "windows-console-key-input.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never change prompt behavior.
  }
}

export function createWindowsConsoleKeyInput(params?: {
  startReader?: () => WindowsConsoleKeyReader;
  reportDiagnostic?: (diagnostic: WindowsConsoleKeyDiagnostic) => void;
}): WindowsConsoleKeyInput {
  const events = new EventEmitter();
  const startReader = params?.startReader ?? startWindowsConsoleKeyReader;
  const reportDiagnostic = params?.reportDiagnostic ?? reportIsolatedTestDiagnostic;
  let reader: WindowsConsoleKeyReader | undefined;
  let pending = "";

  const report = (diagnostic: WindowsConsoleKeyDiagnostic) => {
    try {
      reportDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never change prompt behavior.
    }
  };
  const emitInterrupt = () => events.emit("keypress", "", { name: "c", ctrl: true });
  const onData = (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const token = line.trim();
      const key = keyFromToken(token);
      if (key) {
        report({ event: "reader_key", key: token });
        events.emit("keypress", "", key);
      }
    }
  };
  const onStderrData = (chunk: Buffer | string) => {
    const message = chunk.toString().trim().slice(0, 4_000);
    if (message) report({ event: "reader_stderr", message });
  };
  function detachReader(activeReader: WindowsConsoleKeyReader, terminate: boolean): void {
    activeReader.stdout?.off("data", onData);
    activeReader.stderr?.off("data", onStderrData);
    activeReader.off("error", onError);
    activeReader.off("exit", onExit);
    if (reader === activeReader) reader = undefined;
    pending = "";
    if (terminate) {
      try {
        activeReader.kill();
      } catch {
        // The helper may already be closing; prompt cleanup remains idempotent.
      }
    }
  }
  function onError(error: Error): void {
    report({ event: "reader_error", message: error.message });
    if (reader) detachReader(reader, false);
    emitInterrupt();
  }
  function onExit(code: number | null): void {
    report({ event: "reader_exit", code });
    if (reader) detachReader(reader, false);
    emitInterrupt();
  }

  const input: WindowsConsoleKeyInput = {
    isTTY: true,
    isRaw: false,
    setRawMode() {},
    resume() {
      if (reader) return;
      try {
        reader = startReader();
      } catch (error) {
        report({
          event: "reader_start_error",
          message: error instanceof Error ? error.message : String(error),
        });
        queueMicrotask(emitInterrupt);
        return;
      }
      if (!reader.stdout) {
        report({ event: "reader_stdout_missing" });
        detachReader(reader, true);
        queueMicrotask(emitInterrupt);
        return;
      }
      reader.stdout.on("data", onData);
      reader.stderr?.on("data", onStderrData);
      reader.on("error", onError);
      reader.on("exit", onExit);
    },
    pause() {
      if (!reader) return;
      detachReader(reader, true);
    },
    on(_event, listener) {
      events.on("keypress", listener);
      return input;
    },
    off(_event, listener) {
      events.off("keypress", listener);
      return input;
    },
  };
  return input;
}
