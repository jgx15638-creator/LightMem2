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

test("release installer uses OpenClaw managed installation for capability consent", async () => {
  const script = await readFile(join(packageDir, "scripts", "install_release.sh"), "utf8");
  assert.match(
    script,
    /openclaw_cmd plugins install "\$\{archive_path\}" --force --accept-capabilities/,
  );
  assert.doesNotMatch(script, /tar -xzf "\$\{archive_path\}"/);
  assert.match(script, /tokenpilot_cfg\["proxyAutostart"\] = False/);
  assert.match(script, /slots\["contextEngine"\] = "tokenpilot"/);
});

test("release package loads without monorepo workspace dependencies", async () => {
  const extractDir = await mkdtemp(join(tmpdir(), "tokenpilot-release-smoke-"));
  let archivePath = "";

  try {
    const result = await execFileAsync("bash", ["scripts/pack_release.sh"], {
      cwd: packageDir,
      env: {
        ...process.env,
        NPM_CACHE_DIR: join(extractDir, "npm-cache"),
      },
    });
    archivePath = result.stdout.trim().split("\n").at(-1) ?? "";
    assert.match(archivePath, /lightrsi-openclaw-adapter-.*\.tgz$/);

    await execFileAsync(tarCommand, ["-xzf", archivePath, "-C", extractDir]);
    const installedDir = join(extractDir, "package");
    const manifest = JSON.parse(await readFile(join(installedDir, "package.json"), "utf8"));
    assert.equal(manifest.name, "@lightrsi/openclaw-adapter");
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies, undefined);
    const pluginManifest = JSON.parse(
      await readFile(join(installedDir, "openclaw.plugin.json"), "utf8"),
    );
    assert.equal(pluginManifest.kind, "context-engine");

    const require = createRequire(__filename);
    const plugin = require(join(installedDir, "dist", "index.js"));
    assert.equal(plugin.id, "tokenpilot");
    assert.equal(plugin.kind, "context-engine");
    assert.equal(typeof plugin.register, "function");

    const hooks = plugin.__testHooks;
    const tools = [
      { type: "function", function: { name: "read" } },
      { type: "function", function: { name: "write" } },
    ];
    const makePayload = (userText: string) => ({
      model: "tokenpilot/gpt-5.4-mini",
      instructions: "Stable root prompt.",
      input: [
        {
          role: "developer",
          content: "Runtime: agent=test-agent | host=demo\nYour working directory is: /tmp/demo\n\nDeveloper prompt",
        },
        { role: "user", content: userText },
      ],
      tools,
    });
    const payloadA = makePayload("Keep exact user text A.");
    const payloadB = makePayload("Keep exact user text B.");
    const rewriteA = hooks.rewritePayloadForStablePrefix(payloadA, payloadA.model, {
      dynamicContextTarget: "developer",
    });
    const rewriteB = hooks.rewritePayloadForStablePrefix(payloadB, payloadB.model, {
      dynamicContextTarget: "developer",
    });
    assert.equal(rewriteA.promptCacheKey, rewriteB.promptCacheKey);
    assert.equal(payloadA.input[1].content, "Keep exact user text A.");
    assert.deepEqual(payloadA.tools, tools);

    const prepared = await hooks.prepareProxyRequest({
      cfg: hooks.normalizeConfig({
        moduleEnablement: { stabilizer: true, reduction: false, eviction: false },
        proxyMode: { pureForward: false },
      }),
      payload: makePayload("Keep exact user text A."),
      dynamicContextTarget: "developer",
    });
    assert.equal(prepared.payload.input[1].content, "Keep exact user text A.");
    assert.deepEqual(prepared.payload.tools, tools);
    const preparedAgain = await hooks.prepareProxyRequest({
      cfg: hooks.normalizeConfig({
        moduleEnablement: { stabilizer: true, reduction: false, eviction: false },
        proxyMode: { pureForward: false },
      }),
      payload: makePayload("Keep exact user text B."),
      dynamicContextTarget: "developer",
    });
    assert.equal(
      prepared.requestEnvelope.metadata?.promptCacheKey,
      preparedAgain.requestEnvelope.metadata?.promptCacheKey,
    );
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
});
