import { writeFile } from "node:fs/promises";

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function installWindowsNodeCommandLauncher(params: {
  binPath: string;
  targetPath: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  fixedArgs?: readonly string[];
  consoleInput?: boolean;
  suppressCodexTui?: boolean;
}): Promise<string | undefined> {
  if ((params.platform ?? process.platform) !== "win32") return undefined;

  const launcherPath = `${params.binPath}.cmd`;
  const powerShellPath = `${params.binPath}.ps1`;
  const nodePath = quotePowerShellLiteral(params.nodePath ?? process.execPath);
  const targetPath = quotePowerShellLiteral(params.targetPath);
  const fixedArgs = (params.fixedArgs ?? []).map(quotePowerShellLiteral).join(" ");
  const fixedArgSuffix = fixedArgs ? ` ${fixedArgs}` : "";
  // Keep stdout/stderr on Codex's captured streams so the completed Cleaner
  // transcript is rendered once after the modal console buffer closes. Only
  // raw key input is reattached to the console.
  const consoleRedirect = params.consoleInput ? " < CONIN$" : "";
  const consoleEnvironment = [
    params.consoleInput ? "$env:LIGHTRSI_WINDOWS_CONSOLE_INPUT = '1'" : "",
    params.suppressCodexTui ? "$env:LIGHTRSI_WINDOWS_SUPPRESS_CODEX_TUI = '1'" : "",
  ].filter(Boolean).join("\r\n");
  const consoleEnvironmentPrefix = consoleEnvironment ? `${consoleEnvironment}\r\n` : "";
  // Keep the cmd shim ASCII-only. cmd.exe decodes batch files using the active
  // console code page, which corrupts absolute paths containing non-ASCII text.
  // Windows PowerShell 5.1 reliably detects the UTF-8 BOM on the companion file.
  await writeFile(
    launcherPath,
    `@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dpn0.ps1" %*${consoleRedirect}\r\n`,
    "ascii",
  );
  await writeFile(
    powerShellPath,
    `\uFEFF$ErrorActionPreference = 'Stop'\r\n${consoleEnvironmentPrefix}& ${nodePath} ${targetPath}${fixedArgSuffix} @args\r\nexit $LASTEXITCODE\r\n`,
    "utf8",
  );
  return launcherPath;
}
