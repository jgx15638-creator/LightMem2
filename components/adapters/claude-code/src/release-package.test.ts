import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(__dirname, "..");
const tarCommand = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

async function packRelease(): Promise<string> {
  const result = process.platform === "win32"
    ? await execFileAsync(process.execPath, ["scripts/pack-release.mjs"], { cwd: packageDir })
    : await execFileAsync("bash", ["scripts/pack_release.sh"], { cwd: packageDir });
  const archiveName = result.stdout.trim().split(/\r?\n/u).at(-1)?.split(/[\\/]/u).at(-1) ?? "";
  if (!archiveName) throw new Error("release packer produced no archive");
  return join(packageDir, archiveName);
}

test("packaged Claude codec preserves structured systems and native cache control", async () => {
  const extractDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-release-smoke-"));
  let archivePath = "";
  try {
    archivePath = await packRelease();
    await execFileAsync(tarCommand, ["-xzf", archivePath, "-C", extractDir]);
    const installedDir = join(extractDir, "package");
    const manifest = JSON.parse(await readFile(join(installedDir, "package.json"), "utf8"));
    assert.equal(manifest.name, "@lightrsi/claude-code-adapter");
    const require = createRequire(__filename);
    const bundled = require(join(installedDir, "dist", "index.js"));
    const codec = bundled.createClaudeMessagesPayloadCodec();
    const raw = {
      model: "claude-sonnet-4-6",
      system: [{ type: "text", text: "Stable rules.", cache_control: { type: "ephemeral" }, unknown: { keep: true } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    const encoded = codec.encodeRequest(codec.decodeRequest(raw));
    assert.deepEqual(encoded.system, raw.system);
    assert.deepEqual(encoded.cache_control, { type: "ephemeral" });
    assert.equal("prompt_cache_key" in encoded, false);
    assert.deepEqual(encoded.messages, raw.messages);
    await execFileAsync(process.execPath, [
      resolve(packageDir, "../../..", "scripts", "release", "smoke-host-package.mjs"),
      archivePath,
      "claude-code",
      manifest.version,
    ], { timeout: 60_000 });
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
});
