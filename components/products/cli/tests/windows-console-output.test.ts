import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createWindowsConsoleOutput,
  windowsProcessResumeScript,
  windowsConsoleScreenBufferScript,
  windowsConsoleScreenBufferSpawnOptions,
  WINDOWS_CONSOLE_OUTPUT_PATH,
  type WindowsScreenBufferProcess,
} from "../src/windows-console-output.js";

class FakeStream extends EventEmitter {
  override on(event: "data", listener: (chunk: Buffer | string) => void): this {
    return super.on(event, listener);
  }

  override off(event: "data", listener: (chunk: Buffer | string) => void): this {
    return super.off(event, listener);
  }
}

class FakeScreenBufferProcess extends EventEmitter implements WindowsScreenBufferProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly input: string[] = [];
  ended = 0;
  killed = 0;
  autoRestore = true;
  readonly stdin = {
    write: (value: string) => {
      this.input.push(value);
      if (this.autoRestore && value === "RESTORE\n") {
        this.stdout.emit("data", "RESTORED\n");
      }
      return true;
    },
    end: () => {
      this.ended += 1;
    },
  };

  kill(): boolean {
    this.killed += 1;
    this.emit("exit", null);
    this.emit("close", null);
    return true;
  }

}

test("Windows screen-buffer helper owns and restores a separate console buffer", () => {
  const script = windowsConsoleScreenBufferScript(4321);

  assert.match(script, /CreateConsoleScreenBuffer/);
  assert.match(script, /PeekNamedPipe/);
  assert.match(script, /SetConsoleActiveScreenBuffer\(\$cleaner\)/);
  assert.match(script, /SetConsoleActiveScreenBuffer\(\$original\)/);
  assert.match(script, /Get-Process -Id 4321/);
  assert.match(script, /WriteLine\('RESTORED'\)/);
  assert.match(script, /\$suppressCodexTui = \$false/);
  assert.deepEqual(windowsConsoleScreenBufferSpawnOptions(), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
});

test("Windows screen-buffer helper suspends only a Codex TUI ancestor", () => {
  const script = windowsConsoleScreenBufferScript(4321, true);

  assert.match(script, /\$suppressCodexTui = \$true/);
  assert.match(script, /Find-CodexTuiAncestor 4321/);
  assert.match(script, /app-server/);
  assert.match(script, /ProcessIdToSessionId\(4321/);
  assert.match(script, /WriteLine\(\('GUARD'/);
  assert.match(script, /NtSuspendProcess/);
  assert.match(script, /SetConsoleActiveScreenBuffer\(\$original\)[\s\S]*NtResumeProcess/);
  assert.match(windowsProcessResumeScript(9876), /NtResumeProcess/);
  assert.match(windowsProcessResumeScript(9876), /Get-Process -Id 9876/);
});

test("Windows console output waits for the modal buffer before opening CONOUT", async () => {
  const helper = new FakeScreenBufferProcess();
  const opened: string[] = [];
  const writes: Array<{ descriptor: number; value: string }> = [];
  const closed: number[] = [];
  const output = createWindowsConsoleOutput({
    startScreenBuffer: () => helper,
    openConsole(path) {
      opened.push(path);
      return 17;
    },
    writeConsole(descriptor, value) {
      writes.push({ descriptor, value });
    },
    closeConsole(descriptor) {
      closed.push(descriptor);
    },
    readyTimeoutMs: 100,
    restoreTimeoutMs: 100,
  });

  assert.deepEqual(opened, []);
  const ready = output.ready();
  helper.stdout.emit("data", "READY\t12");
  helper.stdout.emit("data", "0\t40\n");
  assert.equal(await ready, true);
  assert.equal(output.columns, 120);
  assert.deepEqual(opened, [WINDOWS_CONSOLE_OUTPUT_PATH]);
  assert.equal(writes[0]?.value, "\u001b[2J\u001b[H\u001b[?25l");

  assert.equal(output.write("Context clean plan"), true);
  output.finishFrame();
  await output.close();
  await output.close();

  assert.equal(writes[1]?.value, "Context clean plan");
  assert.equal(writes[2]?.value, "\u001b[?25h");
  assert.deepEqual(helper.input, ["RESTORE\n"]);
  assert.equal(helper.ended, 1);
  assert.equal(helper.killed, 0);
  assert.deepEqual(closed, [17]);
});

test("Windows console output reports helper startup failure without opening CONOUT", async () => {
  const helper = new FakeScreenBufferProcess();
  const opened: string[] = [];
  const output = createWindowsConsoleOutput({
    startScreenBuffer: () => helper,
    openConsole(path) {
      opened.push(path);
      return 18;
    },
    readyTimeoutMs: 100,
    restoreTimeoutMs: 100,
  });

  const ready = output.ready();
  helper.stderr.emit("data", "CreateConsoleScreenBuffer failed");
  helper.emit("exit", 1);
  helper.emit("close", 1);

  assert.equal(await ready, false);
  assert.equal(output.write("must stay captured"), false);
  await output.close();
  assert.deepEqual(opened, []);
});

test("Windows console output ignores a late READY after startup cancellation", async () => {
  const helper = new FakeScreenBufferProcess();
  helper.autoRestore = false;
  const opened: string[] = [];
  const output = createWindowsConsoleOutput({
    startScreenBuffer: () => helper,
    openConsole(path) {
      opened.push(path);
      return 23;
    },
    readyTimeoutMs: 5,
    restoreTimeoutMs: 100,
  });

  assert.equal(await output.ready(), false);
  const closing = output.close();
  helper.stdout.emit("data", "READY\t80\t30\nRESTORED\n");
  await closing;

  assert.deepEqual(opened, []);
  assert.deepEqual(helper.input, ["RESTORE\n"]);
});

test("Windows console output converts synchronous helper startup errors into safe unavailability", async () => {
  const output = createWindowsConsoleOutput({
    startScreenBuffer() {
      throw new Error("PowerShell unavailable");
    },
  });

  assert.equal(await output.ready(), false);
  assert.equal(output.write("must not escape to Codex's live buffer"), false);
  await output.close();
});

test("Windows console output waits for RESTORED before completing cleanup", async () => {
  const helper = new FakeScreenBufferProcess();
  helper.autoRestore = false;
  const output = createWindowsConsoleOutput({
    startScreenBuffer: () => helper,
    openConsole() {
      return 19;
    },
    writeConsole() {},
    closeConsole() {},
    readyTimeoutMs: 100,
    restoreTimeoutMs: 1_000,
  });
  const ready = output.ready();
  helper.stdout.emit("data", "READY\t80\t30\n");
  assert.equal(await ready, true);

  let closed = false;
  const closing = output.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  helper.stdout.emit("data", "RESTORED\n");
  await closing;
  assert.equal(closed, true);
});

test("Windows console output recovers the guarded Codex TUI when its helper exits", async () => {
  const helper = new FakeScreenBufferProcess();
  const recovered: number[] = [];
  const output = createWindowsConsoleOutput({
    startScreenBuffer: () => helper,
    suppressCodexTui: true,
    resumeGuardedProcess(processId) {
      recovered.push(processId);
    },
    openConsole() {
      return 20;
    },
    writeConsole() {},
    closeConsole() {},
    readyTimeoutMs: 100,
    restoreTimeoutMs: 100,
  });
  const ready = output.ready();
  helper.stdout.emit("data", "GUARD\t9876\nREADY\t80\t30\n");
  assert.equal(await ready, true);

  helper.emit("exit", 1);
  helper.emit("close", 1);
  assert.deepEqual(recovered, [9876]);
  await output.close();
  assert.deepEqual(recovered, [9876]);
});

test("Windows console output does not resume a guard twice after normal restoration", async () => {
  const helper = new FakeScreenBufferProcess();
  const recovered: number[] = [];
  const output = createWindowsConsoleOutput({
    startScreenBuffer: () => helper,
    suppressCodexTui: true,
    resumeGuardedProcess(processId) {
      recovered.push(processId);
    },
    openConsole() {
      return 22;
    },
    writeConsole() {},
    closeConsole() {},
    readyTimeoutMs: 100,
    restoreTimeoutMs: 100,
  });
  const ready = output.ready();
  helper.stdout.emit("data", "GUARD\t9876\nREADY\t80\t30\n");
  assert.equal(await ready, true);

  await output.close();
  helper.emit("exit", 0);
  helper.emit("close", 0);
  assert.deepEqual(recovered, []);
});

test("Windows console output recovers the guarded Codex TUI before a forced helper stop", async () => {
  const helper = new FakeScreenBufferProcess();
  helper.autoRestore = false;
  const events: string[] = [];
  const output = createWindowsConsoleOutput({
    startScreenBuffer: () => helper,
    suppressCodexTui: true,
    resumeGuardedProcess(processId) {
      events.push(`resume:${processId}`);
    },
    openConsole() {
      return 21;
    },
    writeConsole() {},
    closeConsole() {},
    readyTimeoutMs: 100,
    restoreTimeoutMs: 10,
  });
  const originalKill = helper.kill.bind(helper);
  helper.kill = () => {
    events.push("kill");
    return originalKill();
  };
  const ready = output.ready();
  helper.stdout.emit("data", "GUARD\t6789\nREADY\t80\t30\n");
  assert.equal(await ready, true);

  await output.close();
  assert.deepEqual(events, ["resume:6789", "kill"]);
});
