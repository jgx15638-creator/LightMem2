import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export const WINDOWS_CONSOLE_OUTPUT_PATH = "\\\\.\\CONOUT$";
const SCREEN_BUFFER_READY_TIMEOUT_MS = 30_000;
const SCREEN_BUFFER_RESTORE_TIMEOUT_MS = 15_000;
const WINDOWS_SUPPRESS_CODEX_TUI_ENV = "LIGHTRSI_WINDOWS_SUPPRESS_CODEX_TUI";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

type WindowsScreenBufferStream = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

type WindowsScreenBufferInput = {
  write(value: string): boolean;
  end(): void;
};

export type WindowsScreenBufferProcess = {
  stdin: WindowsScreenBufferInput | null;
  stdout: WindowsScreenBufferStream | null;
  stderr: WindowsScreenBufferStream | null;
  kill(): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number | null) => void): unknown;
  off(event: "close", listener: (code: number | null) => void): unknown;
};

export type WindowsConsoleOutput = {
  isTTY: true;
  columns?: number;
  supportsAnchoredFrames: true;
  preserveTranscript: true;
  ready(): Promise<boolean>;
  lastError(): string | undefined;
  write(value: string): boolean;
  finishFrame(): void;
  close(): Promise<void>;
};

export function windowsConsoleScreenBufferScript(
  parentProcessId = process.pid,
  suppressCodexTui = false,
): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$suppressCodexTui = ${suppressCodexTui ? "$true" : "$false"}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LightRsiConsoleScreenBuffer {
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint OPEN_EXISTING = 3;
    public const uint CONSOLE_TEXTMODE_BUFFER = 1;
    public const uint ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
    public const uint DISABLE_NEWLINE_AUTO_RETURN = 0x0008;
    public const uint PROCESS_SUSPEND_RESUME = 0x0800;
    public const int STD_INPUT_HANDLE = -10;
    public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT {
        public short Left;
        public short Top;
        public short Right;
        public short Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public short wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateConsoleScreenBuffer(
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint flags,
        IntPtr screenBufferData);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetConsoleScreenBufferInfo(
        IntPtr consoleOutput,
        out CONSOLE_SCREEN_BUFFER_INFO info);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetConsoleScreenBufferSize(IntPtr consoleOutput, COORD size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetConsoleWindowInfo(
        IntPtr consoleOutput,
        [MarshalAs(UnmanagedType.Bool)] bool absolute,
        ref SMALL_RECT window);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetConsoleMode(IntPtr consoleHandle, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetConsoleMode(IntPtr consoleHandle, uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetConsoleActiveScreenBuffer(IntPtr consoleOutput);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PeekNamedPipe(
        IntPtr pipe,
        IntPtr buffer,
        uint bufferSize,
        IntPtr bytesRead,
        out uint totalBytesAvailable,
        IntPtr bytesLeftThisMessage);

    [DllImport("ntdll.dll")]
    public static extern int NtSuspendProcess(IntPtr processHandle);

    [DllImport("ntdll.dll")]
    public static extern int NtResumeProcess(IntPtr processHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    public static Exception LastError(string operation) {
        return new InvalidOperationException(
            operation + " failed with Win32 error " + Marshal.GetLastWin32Error());
    }

    public static bool InputAvailable() {
        uint bytesAvailable;
        return PeekNamedPipe(
            GetStdHandle(STD_INPUT_HANDLE),
            IntPtr.Zero,
            0,
            IntPtr.Zero,
            out bytesAvailable,
            IntPtr.Zero) && bytesAvailable > 0;
    }
}
'@

function Find-CodexTuiAncestor([int]$startProcessId) {
    $cursor = $startProcessId
    for ($depth = 0; $depth -lt 16 -and $cursor -gt 0; $depth += 1) {
        $entry = Get-CimInstance Win32_Process -Filter ("ProcessId = $cursor") -ErrorAction SilentlyContinue
        if ($null -eq $entry) { break }
        if ([string]::Equals([string]$entry.Name, 'codex.exe', [StringComparison]::OrdinalIgnoreCase)) {
            $commandLine = [string]$entry.CommandLine
            if ($commandLine -notmatch '(?i)(^|\s)app-server(\s|$)') {
                return [int]$entry.ProcessId
            }
        }
        $next = [int]$entry.ParentProcessId
        if ($next -le 0 -or $next -eq $cursor) { break }
        $cursor = $next
    }
    return 0
}

$invalid = [LightRsiConsoleScreenBuffer]::INVALID_HANDLE_VALUE
$original = [IntPtr]::Zero
$cleaner = [IntPtr]::Zero
$codex = [IntPtr]::Zero
$codexProcessId = 0
$codexSuspended = $false
$activated = $false
try {
    $access = [LightRsiConsoleScreenBuffer]::GENERIC_READ -bor [LightRsiConsoleScreenBuffer]::GENERIC_WRITE
    $sharing = [LightRsiConsoleScreenBuffer]::FILE_SHARE_READ -bor [LightRsiConsoleScreenBuffer]::FILE_SHARE_WRITE
    $original = [LightRsiConsoleScreenBuffer]::CreateFileW(
        'CONOUT$',
        $access,
        $sharing,
        [IntPtr]::Zero,
        [LightRsiConsoleScreenBuffer]::OPEN_EXISTING,
        0,
        [IntPtr]::Zero)
    if ($original -eq $invalid) { throw [LightRsiConsoleScreenBuffer]::LastError('CreateFileW(CONOUT$)') }

    $originalInfo = [LightRsiConsoleScreenBuffer+CONSOLE_SCREEN_BUFFER_INFO]::new()
    if (-not [LightRsiConsoleScreenBuffer]::GetConsoleScreenBufferInfo($original, [ref]$originalInfo)) {
        throw [LightRsiConsoleScreenBuffer]::LastError('GetConsoleScreenBufferInfo(original)')
    }

    $cleaner = [LightRsiConsoleScreenBuffer]::CreateConsoleScreenBuffer(
        $access,
        $sharing,
        [IntPtr]::Zero,
        [LightRsiConsoleScreenBuffer]::CONSOLE_TEXTMODE_BUFFER,
        [IntPtr]::Zero)
    if ($cleaner -eq $invalid) { throw [LightRsiConsoleScreenBuffer]::LastError('CreateConsoleScreenBuffer') }

    if ([LightRsiConsoleScreenBuffer]::InputAvailable()) {
        $earlyCommand = [Console]::In.ReadLine()
        if ($earlyCommand -ne 'RESTORE') {
            throw "Unexpected screen-buffer command: $earlyCommand"
        }
        return
    }

    if ($suppressCodexTui) {
        $codexProcessId = Find-CodexTuiAncestor ${parentProcessId}
        if ($codexProcessId -le 0) { throw 'Codex TUI ancestor was not found' }
        $parentSessionId = [uint32]0
        $codexSessionId = [uint32]0
        if (-not [LightRsiConsoleScreenBuffer]::ProcessIdToSessionId(${parentProcessId}, [ref]$parentSessionId) -or
            -not [LightRsiConsoleScreenBuffer]::ProcessIdToSessionId($codexProcessId, [ref]$codexSessionId) -or
            $parentSessionId -ne $codexSessionId) {
            throw 'Codex TUI ancestor belongs to another Windows session'
        }
        [Console]::Out.WriteLine(('GUARD' + [char]9 + $codexProcessId))
        [Console]::Out.Flush()
        $codex = [LightRsiConsoleScreenBuffer]::OpenProcess(
            [LightRsiConsoleScreenBuffer]::PROCESS_SUSPEND_RESUME,
            $false,
            $codexProcessId)
        if ($codex -eq [IntPtr]::Zero) { throw [LightRsiConsoleScreenBuffer]::LastError('OpenProcess(Codex TUI)') }
        $suspendStatus = [LightRsiConsoleScreenBuffer]::NtSuspendProcess($codex)
        if ($suspendStatus -ne 0) { throw "NtSuspendProcess failed with NTSTATUS $suspendStatus" }
        $codexSuspended = $true
    }

    [void][LightRsiConsoleScreenBuffer]::SetConsoleScreenBufferSize($cleaner, $originalInfo.dwSize)
    $window = $originalInfo.srWindow
    [void][LightRsiConsoleScreenBuffer]::SetConsoleWindowInfo($cleaner, $true, [ref]$window)
    $mode = [uint32]0
    if ([LightRsiConsoleScreenBuffer]::GetConsoleMode($cleaner, [ref]$mode)) {
        [void][LightRsiConsoleScreenBuffer]::SetConsoleMode(
            $cleaner,
            $mode -bor [LightRsiConsoleScreenBuffer]::ENABLE_VIRTUAL_TERMINAL_PROCESSING -bor [LightRsiConsoleScreenBuffer]::DISABLE_NEWLINE_AUTO_RETURN)
    }
    if (-not [LightRsiConsoleScreenBuffer]::SetConsoleActiveScreenBuffer($cleaner)) {
        throw [LightRsiConsoleScreenBuffer]::LastError('SetConsoleActiveScreenBuffer(cleaner)')
    }
    $activated = $true

    $cleanerInfo = [LightRsiConsoleScreenBuffer+CONSOLE_SCREEN_BUFFER_INFO]::new()
    if (-not [LightRsiConsoleScreenBuffer]::GetConsoleScreenBufferInfo($cleaner, [ref]$cleanerInfo)) {
        throw [LightRsiConsoleScreenBuffer]::LastError('GetConsoleScreenBufferInfo(cleaner)')
    }
    $columns = [int]$cleanerInfo.srWindow.Right - [int]$cleanerInfo.srWindow.Left + 1
    $rows = [int]$cleanerInfo.srWindow.Bottom - [int]$cleanerInfo.srWindow.Top + 1
    [Console]::Out.WriteLine(('READY' + [char]9 + $columns + [char]9 + $rows))
    [Console]::Out.Flush()

    $restoreRequest = [Console]::In.ReadLineAsync()
    while (-not $restoreRequest.Wait(250)) {
        if ($null -eq (Get-Process -Id ${parentProcessId} -ErrorAction SilentlyContinue)) { break }
    }
    if ($restoreRequest.IsCompleted -and $restoreRequest.Result -ne 'RESTORE') {
        throw "Unexpected screen-buffer command: $($restoreRequest.Result)"
    }
} finally {
    if ($activated -and $original -ne [IntPtr]::Zero -and $original -ne $invalid) {
        [void][LightRsiConsoleScreenBuffer]::SetConsoleActiveScreenBuffer($original)
    }
    if ($codexSuspended -and $codex -ne [IntPtr]::Zero) {
        [void][LightRsiConsoleScreenBuffer]::NtResumeProcess($codex)
        $codexSuspended = $false
    }
    if ($activated) {
        [Console]::Out.WriteLine('RESTORED')
        [Console]::Out.Flush()
    }
    if ($codex -ne [IntPtr]::Zero) { [void][LightRsiConsoleScreenBuffer]::CloseHandle($codex) }
    if ($cleaner -ne [IntPtr]::Zero -and $cleaner -ne $invalid) { [void][LightRsiConsoleScreenBuffer]::CloseHandle($cleaner) }
    if ($original -ne [IntPtr]::Zero -and $original -ne $invalid) { [void][LightRsiConsoleScreenBuffer]::CloseHandle($original) }
}
`;
}

export function windowsConsoleScreenBufferSpawnOptions(): {
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

function windowsPowerShellPath(): string {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function startWindowsScreenBuffer(suppressCodexTui: boolean): ChildProcessWithoutNullStreams {
  const encodedCommand = Buffer.from(
    windowsConsoleScreenBufferScript(process.pid, suppressCodexTui),
    "utf16le",
  ).toString("base64");
  return spawn(windowsPowerShellPath(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ], windowsConsoleScreenBufferSpawnOptions());
}

export function windowsProcessResumeScript(processId: number): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
if ($null -eq (Get-Process -Id ${processId} -ErrorAction SilentlyContinue)) { exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class LightRsiCodexTuiRecovery {
    public const uint PROCESS_SUSPEND_RESUME = 0x0800;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("ntdll.dll")]
    public static extern int NtResumeProcess(IntPtr processHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

$handle = [LightRsiCodexTuiRecovery]::OpenProcess(
    [LightRsiCodexTuiRecovery]::PROCESS_SUSPEND_RESUME,
    $false,
    ${processId})
if ($handle -eq [IntPtr]::Zero) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
try {
    $status = [LightRsiCodexTuiRecovery]::NtResumeProcess($handle)
    if ($status -ne 0) { throw "NtResumeProcess failed with NTSTATUS $status" }
} finally {
    [void][LightRsiCodexTuiRecovery]::CloseHandle($handle)
}
`;
}

function resumeWindowsProcess(processId: number): void {
  const encodedCommand = Buffer.from(windowsProcessResumeScript(processId), "utf16le").toString("base64");
  const result = spawnSync(windowsPowerShellPath(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Codex TUI recovery exited with status ${result.status}`);
}

function unavailableWindowsConsoleOutput(error?: unknown): WindowsConsoleOutput {
  const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  return {
    isTTY: true,
    supportsAnchoredFrames: true,
    preserveTranscript: true,
    async ready() {
      return false;
    },
    lastError() {
      return message;
    },
    write() {
      return false;
    },
    finishFrame() {},
    async close() {},
  };
}

export function createWindowsConsoleOutput(params?: {
  startScreenBuffer?: () => WindowsScreenBufferProcess;
  suppressCodexTui?: boolean;
  resumeGuardedProcess?: (processId: number) => void;
  openConsole?: (path: string) => number;
  writeConsole?: (descriptor: number, value: string) => void;
  closeConsole?: (descriptor: number) => void;
  readyTimeoutMs?: number;
  restoreTimeoutMs?: number;
}): WindowsConsoleOutput {
  const suppressCodexTui = params?.suppressCodexTui
    ?? process.env[WINDOWS_SUPPRESS_CODEX_TUI_ENV] === "1";
  const startScreenBuffer = params?.startScreenBuffer ?? (() => startWindowsScreenBuffer(suppressCodexTui));
  const resumeGuardedProcess = params?.resumeGuardedProcess ?? resumeWindowsProcess;
  const openConsole = params?.openConsole ?? ((path) => openSync(path, "w"));
  const writeConsole = params?.writeConsole ?? ((descriptor, value) => writeSync(descriptor, value));
  const closeConsole = params?.closeConsole ?? closeSync;
  let helper: WindowsScreenBufferProcess;
  try {
    helper = startScreenBuffer();
  } catch (error) {
    return unavailableWindowsConsoleOutput(error);
  }
  let descriptor: number | undefined;
  let closed = false;
  let finished = false;
  let pendingStdout = "";
  let helperError = "";
  let guardedProcessId: number | undefined;
  let guardReleased = false;
  let restoreRequested = false;
  let readySettled = false;
  let restoredSettled = false;
  let resolveReady!: (value: boolean) => void;
  let resolveRestored!: () => void;
  const readyPromise = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const restoredPromise = new Promise<void>((resolve) => {
    resolveRestored = resolve;
  });

  const settleReady = (value: boolean) => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(value);
  };
  const settleRestored = () => {
    if (restoredSettled) return;
    restoredSettled = true;
    resolveRestored();
  };
  const recoverGuardedProcess = () => {
    if (guardedProcessId === undefined || guardReleased) return;
    try {
      resumeGuardedProcess(guardedProcessId);
      guardReleased = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      helperError += `${helperError ? "\n" : ""}Codex TUI recovery failed: ${message}`;
    }
  };
  const onStdout = (chunk: Buffer | string) => {
    pendingStdout += chunk.toString();
    const lines = pendingStdout.split(/\r?\n/);
    pendingStdout = lines.pop() ?? "";
    for (const line of lines) {
      const guard = /^GUARD\t(\d+)$/.exec(line.trim());
      const ready = /^READY\t(\d+)\t(\d+)$/.exec(line.trim());
      if (guard) {
        guardedProcessId = Number.parseInt(guard[1]!, 10);
      } else if (ready) {
        if (closed) continue;
        output.columns = Number.parseInt(ready[1]!, 10);
        try {
          descriptor = openConsole(WINDOWS_CONSOLE_OUTPUT_PATH);
          writeConsole(descriptor, `${CLEAR_SCREEN}${HIDE_CURSOR}`);
          settleReady(true);
        } catch (error) {
          helperError ||= error instanceof Error ? error.message : String(error);
          settleReady(false);
        }
      } else if (line.trim() === "RESTORED") {
        guardReleased = true;
        settleRestored();
      }
    }
  };
  const onStderr = (chunk: Buffer | string) => {
    helperError += chunk.toString();
  };
  const onError = (error: Error) => {
    helperError ||= error.message;
    settleReady(false);
  };
  const onExit = () => {
    settleReady(false);
  };
  const onClose = () => {
    recoverGuardedProcess();
    settleReady(false);
    settleRestored();
  };

  helper.stdout?.on("data", onStdout);
  helper.stderr?.on("data", onStderr);
  helper.on("error", onError);
  helper.on("exit", onExit);
  helper.on("close", onClose);

  const requestRestore = () => {
    if (!helper.stdin || restoreRequested) return;
    restoreRequested = true;
    try {
      helper.stdin.write("RESTORE\n");
    } catch {
      recoverGuardedProcess();
      settleRestored();
    }
  };

  const output: WindowsConsoleOutput = {
    isTTY: true,
    supportsAnchoredFrames: true,
    preserveTranscript: true,
    async ready() {
      const timeoutMs = params?.readyTimeoutMs ?? SCREEN_BUFFER_READY_TIMEOUT_MS;
      const timeout = setTimeout(() => settleReady(false), timeoutMs);
      timeout.unref?.();
      const value = await readyPromise;
      clearTimeout(timeout);
      if (!value) requestRestore();
      return value;
    },
    lastError() {
      return helperError.trim() || undefined;
    },
    write(value) {
      if (closed || descriptor === undefined) return false;
      writeConsole(descriptor, value);
      return true;
    },
    finishFrame() {
      if (closed || finished || descriptor === undefined) return;
      finished = true;
      writeConsole(descriptor, SHOW_CURSOR);
    },
    async close() {
      if (closed) return;
      output.finishFrame();
      closed = true;
      if (descriptor !== undefined) {
        closeConsole(descriptor);
        descriptor = undefined;
      }
      if (helper.stdin) {
        requestRestore();
        try {
          helper.stdin.end();
        } catch {
          recoverGuardedProcess();
          settleRestored();
        }
      } else {
        recoverGuardedProcess();
        settleRestored();
      }
      const timeoutMs = params?.restoreTimeoutMs ?? SCREEN_BUFFER_RESTORE_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        try {
          recoverGuardedProcess();
          helper.kill();
        } finally {
          settleRestored();
        }
      }, timeoutMs);
      timeout.unref?.();
      await restoredPromise;
      clearTimeout(timeout);
      helper.stdout?.off("data", onStdout);
      helper.stderr?.off("data", onStderr);
      helper.off("error", onError);
      helper.off("exit", onExit);
      helper.off("close", onClose);
    },
  };
  return output;
}
