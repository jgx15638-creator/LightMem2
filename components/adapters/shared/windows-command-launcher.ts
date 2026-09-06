import { writeFile } from "node:fs/promises";

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function installWindowsNodeCommandLauncher(params: {
  binPath: string;
  targetPath: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
}): Promise<string | undefined> {
  if ((params.platform ?? process.platform) !== "win32") return undefined;

  const launcherPath = `${params.binPath}.cmd`;
  const powerShellPath = `${params.binPath}.ps1`;
  const nodePath = quotePowerShellLiteral(params.nodePath ?? process.execPath);
  const targetPath = quotePowerShellLiteral(params.targetPath);
  // Keep the cmd shim ASCII-only. cmd.exe decodes batch files using the active
  // console code page, which corrupts absolute paths containing non-ASCII text.
  // Windows PowerShell 5.1 reliably detects the UTF-8 BOM on the companion file.
  await writeFile(
    launcherPath,
    '@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dpn0.ps1" %*\r\n',
    "ascii",
  );
  await writeFile(
    powerShellPath,
    `\uFEFF$ErrorActionPreference = 'Stop'\r\n& ${nodePath} ${targetPath} @args\r\nexit $LASTEXITCODE\r\n`,
    "utf8",
  );
  return launcherPath;
}
