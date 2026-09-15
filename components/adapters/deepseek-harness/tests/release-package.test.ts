import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(import.meta.dirname, "..");
const tarCommand = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

test("packed DSH bundle resolves through its package entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-dsh-release-"));
  try {
    const npmArgs = [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      root,
    ];
    const packed = process.platform === "win32"
      ? await execFileAsync(
        process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        ["/d", "/s", "/c", "npm.cmd", ...npmArgs],
        { cwd: packageDir },
      )
      : await execFileAsync("npm", npmArgs, { cwd: packageDir });
    const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const archive = join(root, result[0]!.filename);
    const installedDir = join(
      root,
      "node_modules",
      "@lightrsi",
      "deepseek-harness-adapter",
    );
    await mkdir(dirname(installedDir), { recursive: true });
    await execFileAsync(tarCommand, ["-xzf", archive, "-C", dirname(installedDir)]);
    await rename(join(dirname(installedDir), "package"), installedDir);

    const manifest = JSON.parse(
      await readFile(join(installedDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifest.main, "./dist/index.js");
    assert.equal(
      (manifest.dependencies as Record<string, unknown> | undefined)?.["@lightrsi/eviction"],
      undefined,
    );
    assert.equal(
      await readFile(join(installedDir, "cordis.patch.yml"), "utf8")
        .then((value) => value.includes("@lightrsi/deepseek-harness-adapter")),
      true,
    );

    const require = createRequire(join(root, "consumer.mjs"));
    const entry = require.resolve("@lightrsi/deepseek-harness-adapter");
    const plugin = await import(pathToFileURL(entry).href) as {
      name: string;
      inject: string[];
      apply(ctx: { on(event: string): void; tokenMeter: { measure(): object } }, config: unknown): void;
    };
    const events: string[] = [];
    plugin.apply({
      on(event) { events.push(event); },
      tokenMeter: { measure: () => ({}) },
    }, {
      enabled: true,
      eviction: { enabled: true },
      taskStateEstimator: {
        enabled: true,
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        model: "test-model",
      },
    });
    assert.equal(plugin.name, "tokenpilot-dsh");
    assert.deepEqual(plugin.inject, ["tokenMeter"]);
    assert.deepEqual(events, ["agent/pre-step"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
