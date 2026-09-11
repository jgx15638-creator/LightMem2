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

test("packaged Codex codec emits GPT-5.6 cache boundaries without mutating user input", async () => {
  const extractDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-release-smoke-"));
  let archivePath = "";
  try {
    archivePath = await packRelease();
    await execFileAsync(tarCommand, ["-xzf", archivePath, "-C", extractDir]);
    const installedDir = join(extractDir, "package");
    const manifest = JSON.parse(await readFile(join(installedDir, "package.json"), "utf8"));
    assert.equal(manifest.name, "@lightrsi/codex-adapter");
    const require = createRequire(__filename);
    const bundled = require(join(installedDir, "dist", "index.js"));
    const codec = bundled.createCodexResponsesPayloadCodec();
    const config = bundled.normalizeTokenPilotCodexConfig({});
    const raw = {
      model: "cx/gpt-5.6-sol",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Stable rules." }] },
        { role: "user", content: "Keep exact user text." },
      ],
    };
    const prepared = bundled.prepareCodexStablePrefix(codec.decodeRequest(raw), config);
    const encoded = codec.encodeRequest(prepared);
    assert.deepEqual(encoded.prompt_cache_options, { mode: "explicit", ttl: "30m" });
    assert.deepEqual(encoded.input[0].content[0].prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(encoded.input[1].content, "Keep exact user text.");
    assert.equal("prompt_cache_retention" in encoded, false);
    await execFileAsync(process.execPath, [
      resolve(packageDir, "../../..", "scripts", "release", "smoke-host-package.mjs"),
      archivePath,
      "codex",
      manifest.version,
    ], { timeout: 60_000 });
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
});
