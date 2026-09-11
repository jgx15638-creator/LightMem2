import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const adapterDir = resolve(scriptDir, "..");
const repoRoot = resolve(adapterDir, "../../..");
const npmExecPath = process.env.npm_execpath;

function npmInvocation(args) {
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  if (process.platform === "win32") {
    for (const arg of args) {
      if (!/^[A-Za-z0-9._:@/-]+$/u.test(arg)) {
        throw new Error("Refusing to pass an unsafe argument to npm.cmd");
      }
    }
    return {
      command: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")],
    };
  }
  return { command: "npm", args };
}

function childEnv(workdir, extra = {}) {
  const env = { ...process.env, ...extra, INIT_CWD: workdir };
  for (const name of [
    "npm_config_local_prefix",
    "npm_config_workspace",
    "npm_config_workspaces",
    "npm_config_include_workspace_root",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_package_json",
  ]) {
    delete env[name];
  }
  return env;
}

function runPack(packageDir, cacheDir) {
  const invocation = npmInvocation(["pack", "--silent"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: packageDir,
    env: childEnv(packageDir, { npm_config_cache: cacheDir }),
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const category = result.stderr?.trim() ? "npm-pack-error" : "unknown";
    throw new Error(`Release npm pack failed (${category}; exit ${result.status ?? "unknown"})`);
  }
  const archiveName = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!archiveName || basename(archiveName) !== archiveName || !archiveName.endsWith(".tgz")) {
    throw new Error("Release npm pack did not return a safe archive name");
  }
  return archiveName;
}

async function main() {
  const packDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-pack-"));
  try {
    const packageDir = join(packDir, "package");
    const distDir = join(packageDir, "dist");
    await mkdir(distDir, { recursive: true });
    for (const file of ["index.js", "cli.js", "hooks-handler.js", "install-codex.js"]) {
      await copyFile(join(adapterDir, "dist", file), join(distDir, file));
    }
    await copyFile(
      resolve(repoRoot, "components/products/cli/dist/cli.js"),
      join(distDir, "lightrsi.js"),
    );
    await copyFile(
      resolve(repoRoot, "components/products/cli/dist/cli.js"),
      join(distDir, "lightmem2.js"),
    );
    await copyFile(
      resolve(repoRoot, "components/products/mcp/dist/server.js"),
      join(distDir, "mcp-server.js"),
    );
    await copyFile(join(adapterDir, "README.md"), join(packageDir, "README.md"));

    const manifest = JSON.parse(await readFile(join(adapterDir, "package.json"), "utf8"));
    delete manifest.dependencies;
    delete manifest.devDependencies;
    delete manifest.scripts;
    manifest.files = ["dist", "README.md"];
    await writeFile(
      join(packageDir, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const cacheDir = join(packDir, "npm-cache");
    await mkdir(cacheDir, { recursive: true });
    const archiveName = runPack(packageDir, cacheDir);
    const archivePath = join(adapterDir, archiveName);
    await copyFile(join(packageDir, archiveName), archivePath);
    process.stdout.write(`${archivePath}\n`);
  } finally {
    await rm(packDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
