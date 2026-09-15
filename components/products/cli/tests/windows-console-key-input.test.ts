import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createWindowsConsoleKeyInput,
  windowsConsoleKeyReaderScript,
  windowsConsoleKeyReaderSpawnOptions,
} from "../src/windows-console-key-input.js";

class FakeKeyReader extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killCalls = 0;

  kill() {
    this.killCalls += 1;
    return true;
  }
}

test("Windows console key reader stays attached to the parent console", () => {
  const options = windowsConsoleKeyReaderSpawnOptions();

  assert.equal(options.windowsHide, false);
  assert.deepEqual(options.stdio, ["inherit", "pipe", "pipe"]);
});

test("Windows console key reader uses RawUI when the Codex shell redirects stdin", () => {
  const script = windowsConsoleKeyReaderScript();

  assert.match(script, /RawUI\.ReadKey\('NoEcho,IncludeKeyDown'\)/);
  assert.doesNotMatch(script, /\[Console\]::ReadKey/);
});

test("Windows console input reports the helper error before interrupting the prompt", async () => {
  const reader = new FakeKeyReader();
  const diagnostics: unknown[] = [];
  const keys: Array<{ name?: string; ctrl?: boolean }> = [];
  const input = createWindowsConsoleKeyInput({
    startReader: () => reader,
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  input.on("keypress", (_value, key) => {
    keys.push(key);
    if (key.ctrl && key.name === "c") input.pause();
  });

  input.resume();
  reader.stderr.write("ReadKey failed\r\n");
  reader.emit("exit", 1);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(diagnostics, [
    { event: "reader_stderr", message: "ReadKey failed" },
    { event: "reader_exit", code: 1 },
  ]);
  assert.deepEqual(keys, [{ name: "c", ctrl: true }]);
  assert.equal(reader.killCalls, 0);
});

test("Windows console input converts reader lines to Cleaner keypresses and stops with the prompt", async () => {
  const reader = new FakeKeyReader();
  const diagnostics: unknown[] = [];
  const input = createWindowsConsoleKeyInput({
    startReader: () => reader,
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const keys: Array<{ name?: string; ctrl?: boolean }> = [];
  input.on("keypress", (_value, key) => keys.push(key));

  input.resume();
  reader.stdout.write("up\r\ndo");
  reader.stdout.write("wn\nspace\nenter\nq\nescape\ninterrupt\nignored\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.pause();

  assert.deepEqual(keys, [
    { name: "up" },
    { name: "down" },
    { name: "space" },
    { name: "enter" },
    { name: "q" },
    { name: "escape" },
    { name: "c", ctrl: true },
  ]);
  assert.deepEqual(diagnostics, [
    { event: "reader_key", key: "up" },
    { event: "reader_key", key: "down" },
    { event: "reader_key", key: "space" },
    { event: "reader_key", key: "enter" },
    { event: "reader_key", key: "q" },
    { event: "reader_key", key: "escape" },
    { event: "reader_key", key: "interrupt" },
  ]);
  assert.equal(reader.killCalls, 1);
});
