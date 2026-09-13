# Codex Cleaner Raw-TTY Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `!lightrsi-clean` open LightRSI's task selector in the current Codex terminal with Up/Down navigation, Space toggling, Enter submission, and `q` cancellation.

**Architecture:** A Codex-only installed launcher forwards inherited stdio to `lightrsi codex clean --require-tty`. The CLI prompt returns an explicit submit/cancel/interrupt result, while the command layer owns approval and cancellation effects through the existing shared Cleaner control service. MCP elicitation remains installed as a compatibility path.

**Tech Stack:** TypeScript 5.9, Node.js 22.13+, Node test runner, `node:readline` keypress events, PowerShell 5.1 and POSIX command shims, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-13-codex-cleaner-raw-tty-design.md`

## Global Constraints

- Implement Codex support first; do not add the launcher to Claude Code or OpenClaw.
- Use `!lightrsi-clean` as the exact-keyboard entry point.
- Do not modify or fork Codex CLI.
- Preserve the existing MCP Cleaner form as a compatibility path.
- Preserve task classification, immutable plans, receipts, protected-task rules, and deferred apply behavior.
- Do not open another terminal window or use `Start-Process`.
- Do not run installers against the user's normal Codex home during development or verification.
- Run live tests only with temporary `CODEX_HOME`, TokenPilot config, state, bin, and workspace paths.
- Do not create a pull request.

---

### Task 1: Raw-TTY prompt result and key handling

**Files:**
- Modify: `components/products/cli/src/clean-prompt.ts`
- Modify: `components/products/cli/src/clean.ts`
- Modify: `components/products/cli/tests/clean-prompt.test.ts`
- Modify: `components/products/cli/tests/clean.test.ts`

**Interfaces:**
- Produces: `CleanTaskPromptResult` with `submit`, `cancel`, and `interrupt` variants.
- Produces: optional `CleanPromptTerminal` injection for deterministic terminal tests.
- Consumes: existing `CleanPlanView`, `CleanCommandBackend.approve(...)`, and `CleanCommandBackend.cancel(...)`.

- [ ] **Step 1: Add a fake terminal and failing key-contract tests**

Extend `clean-prompt.test.ts` with an `EventEmitter`-based input and a captured-output object. Use this helper shape:

```ts
function createFakeTerminal() {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    rawModes: [] as boolean[],
    resumed: 0,
    paused: 0,
    setRawMode(value: boolean) { this.isRaw = value; this.rawModes.push(value); },
    resume() { this.resumed += 1; },
    pause() { this.paused += 1; },
  });
  const writes: string[] = [];
  return {
    terminal: {
      input,
      output: { isTTY: true, write(value: string) { writes.push(value); } },
      emitKeypressEvents() {},
    },
    input,
    writes,
  };
}
```

Add separate tests proving:

```ts
const pending = promptForCleanTasks(planWithTwoSelectableAndOneProtected(), terminal);
input.emit("keypress", "", { name: "space" });
input.emit("keypress", "", { name: "down" });
input.emit("keypress", "", { name: "space" });
input.emit("keypress", "", { name: "enter" });
assert.deepEqual(await pending, {
  action: "submit",
  selectedTaskIds: ["task-a", "task-b"],
});
assert.doesNotMatch(writes.join(""), /Confirm clean/);
```

Also assert Up/Down wrap among the two selectable tasks, the protected task is
never shown in the selector rows, Enter with no selection returns an empty
submit, `q` and Escape return cancel, Ctrl+C returns interrupt, repeated
terminal keys settle once, and each exit restores the original raw mode and
cursor visibility.

- [ ] **Step 2: Run the prompt test and verify RED**

Run:

```powershell
pnpm --filter @lightrsi/cli exec node --import tsx --test tests/clean-prompt.test.ts
```

Expected: FAIL because `promptForCleanTasks` does not accept injected terminal
I/O, still waits for `y`, and returns `string[] | undefined`.

- [ ] **Step 3: Add failing command-orchestration tests**

Update injected prompts in `clean.test.ts` to return explicit results and add
these assertions:

```ts
async promptSubmit() {
  return { action: "submit" as const, selectedTaskIds: ["task-a"] };
}

async promptCancel() {
  return { action: "cancel" as const };
}

async promptInterrupt() {
  return { action: "interrupt" as const };
}
```

Verify submit calls `approve:plan-1:task-a`, cancel calls
`cancel:plan-1` exactly once and renders a cancelled receipt, interrupt calls
`cancel:plan-1` and rejects with `clean_selection_interrupted`, and empty submit
calls neither approve nor cancel.

- [ ] **Step 4: Run the command test and verify RED**

Run:

```powershell
pnpm --filter @lightrsi/cli exec node --import tsx --test tests/clean.test.ts
```

Expected: FAIL because `handleCleanCommand` still interprets the prompt result
as an optional array and does not cancel the stored plan.

- [ ] **Step 5: Implement the minimal prompt state machine**

In `clean-prompt.ts`, define:

```ts
export type CleanTaskPromptResult =
  | { action: "submit"; selectedTaskIds: string[] }
  | { action: "cancel" }
  | { action: "interrupt" };

export type CleanTaskPrompt = (plan: CleanPlanView) => Promise<CleanTaskPromptResult>;
```

Add the narrow injected terminal interface used by the test. Default it to
`process.stdin`, `process.stdout`, and `emitKeypressEvents`. Remove the
`confirming` state. Enter resolves `submit` immediately, `q` and Escape resolve
`cancel`, and Ctrl+C resolves `interrupt`. Use a `settled` guard and one
idempotent cleanup function to restore raw mode and cursor visibility before
resolving.

- [ ] **Step 6: Implement command lifecycle effects**

In `clean.ts`, switch on `selection.action`:

```ts
if (selection.action === "cancel") {
  return { text: resultText(renderCleanReceipt(await params.backend.cancel(plan.planId))) };
}
if (selection.action === "interrupt") {
  await params.backend.cancel(plan.planId);
  throw new Error("clean_selection_interrupted");
}
if (selection.selectedTaskIds.length === 0) {
  return { text: resultText("No tasks selected; no changes were applied.") };
}
return {
  text: resultText(await approveSelection(params.backend, plan, selection.selectedTaskIds)),
};
```

- [ ] **Step 7: Run focused and full CLI verification**

Run:

```powershell
pnpm --filter @lightrsi/cli test
pnpm --filter @lightrsi/cli typecheck
```

Expected: all CLI tests pass; output contains no `Confirm clean? [y/N]`.

- [ ] **Step 8: Commit the prompt behavior**

```powershell
git add -- components/products/cli/src/clean-prompt.ts components/products/cli/src/clean.ts components/products/cli/tests/clean-prompt.test.ts components/products/cli/tests/clean.test.ts
git commit -m "feat(cleaner): add direct TTY task selection"
```

### Task 2: Codex-only fixed command launcher

**Files:**
- Modify: `components/adapters/shared/windows-command-launcher.ts`
- Modify: `components/adapters/shared/cli-bin-install.ts`
- Modify: `components/adapters/codex/tests/cli-bin-install.test.ts`

**Interfaces:**
- Produces: `installLightRsiCommandAlias({ adapterRoot, binDir, binName, fixedArgs, platform, nodePath })`.
- Extends: `installWindowsNodeCommandLauncher(...)` with `fixedArgs?: readonly string[]`.
- Produces: `lightrsi-clean`, plus `.cmd` and `.ps1` companions on Windows.

- [ ] **Step 1: Write failing launcher-content tests**

In `cli-bin-install.test.ts`, install an alias with:

```ts
const alias = await installLightRsiCommandAlias({
  adapterRoot,
  binDir,
  binName: "lightrsi-clean",
  fixedArgs: ["codex", "clean", "--require-tty"],
  platform: "win32",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
});
```

Assert the Windows PowerShell companion contains the Node path, CLI path, and
fixed arguments before `@args`, and the `.cmd` shim uses the existing ASCII
PowerShell pattern. Assert a POSIX install writes an executable wrapper with
`exec`, shell-quoted paths, the fixed arguments, and `"$@"`.

- [ ] **Step 2: Run the installer test and verify RED**

Run:

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/cli-bin-install.test.ts
```

Expected: FAIL because the alias installer and `fixedArgs` option do not exist.

- [ ] **Step 3: Add a Windows execution test**

Use the existing copied `node.exe` fixture and fake CLI logger. Invoke
`lightrsi-clean.cmd --status plan-1` and assert the child receives:

```ts
["codex", "clean", "--require-tty", "--status", "plan-1"]
```

Make the fake CLI exit with code 17 in a second call and assert the launcher
returns code 17. This proves argument order and exit-code propagation without
touching a real installation.

- [ ] **Step 4: Run the execution test and verify RED**

Run the same focused test command. Expected: FAIL because no
`lightrsi-clean.cmd` exists.

- [ ] **Step 5: Implement the reusable alias installer**

In `cli-bin-install.ts`, add PowerShell and POSIX quoting helpers and export:

```ts
export async function installLightRsiCommandAlias(params: {
  adapterRoot: string;
  binDir: string;
  binName: string;
  fixedArgs: readonly string[];
  platform?: NodeJS.Platform;
  nodePath?: string;
}): Promise<{
  binPath: string;
  launcherPath?: string;
  cliDistPath: string;
}>;
```

The extensionless wrapper uses `exec`. On Windows, call the shared launcher
writer with `fixedArgs`. Never use `Start-Process`, pipes, or redirected stdio.

In `windows-command-launcher.ts`, quote each fixed argument with the existing
PowerShell literal function and place them between the target path and `@args`.

- [ ] **Step 6: Run launcher tests and typecheck**

Run:

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/cli-bin-install.test.ts
pnpm --filter @lightrsi/codex-adapter typecheck
```

Expected: content, Unicode path, forwarded-argument, and exit-code tests pass.

- [ ] **Step 7: Commit the launcher primitive**

```powershell
git add -- components/adapters/shared/windows-command-launcher.ts components/adapters/shared/cli-bin-install.ts components/adapters/codex/tests/cli-bin-install.test.ts
git commit -m "feat(codex): add Cleaner command launcher"
```

### Task 3: Require a TTY only for the dedicated alias

**Files:**
- Modify: `components/products/cli/src/clean.ts`
- Modify: `components/products/cli/tests/clean.test.ts`
- Modify: `components/products/cli/tests/clean-non-tty.test.ts`

**Interfaces:**
- Extends: internal clean argument parsing with `--require-tty`.
- Preserves: existing non-interactive behavior for plain `lightrsi codex clean`.

- [ ] **Step 1: Write failing command tests**

Add a test that calls:

```ts
await handleCleanCommand({
  args: ["--require-tty"],
  sessionId: "session-1",
  backend,
  interactive: false,
});
```

Assert rejection with `clean_interactive_tty_required` and assert `analyze` was
never called. Also prove `--require-tty --status plan-1`,
`--require-tty --cancel plan-1`, and `--require-tty --help` keep their existing
behavior, while plain non-interactive analysis still renders a plan.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
pnpm --filter @lightrsi/cli exec node --import tsx --test tests/clean.test.ts tests/clean-non-tty.test.ts
```

Expected: FAIL with `clean_argument_syntax` or an unexpected analysis call.

- [ ] **Step 3: Implement the internal marker**

Strip at most one leading `--require-tty` before existing strict parsing and
carry `requireTty: boolean` on every parsed action. In the analyze branch,
compute interactivity before `backend.analyze` and throw
`clean_interactive_tty_required` when the marker is present and stdio is not a
TTY. Status, cancel, help, and explicit plan selection bypass that check.

- [ ] **Step 4: Run CLI regression tests**

Run:

```powershell
pnpm --filter @lightrsi/cli test
pnpm --filter @lightrsi/cli typecheck
```

Expected: the alias marker fails early without a TTY, and old command forms are
unchanged.

- [ ] **Step 5: Commit the alias guard**

```powershell
git add -- components/products/cli/src/clean.ts components/products/cli/tests/clean.test.ts components/products/cli/tests/clean-non-tty.test.ts
git commit -m "fix(cleaner): require TTY for interactive alias"
```

### Task 4: Install and diagnose the Codex alias

**Files:**
- Modify: `components/adapters/codex/src/install.ts`
- Modify: `components/adapters/codex/src/doctor.ts`
- Modify: `components/adapters/codex/tests/install.test.ts`
- Modify: `components/adapters/codex/tests/doctor.test.ts`
- Modify: `components/adapters/claude-code/tests/install.test.ts`

**Interfaces:**
- Extends: `installCodexTokenPilot(...)` result with `cleanCliBinPath` and optional `cleanCliLauncherPath`.
- Extends: `CodexDoctorReport` with `cleanCliInstalled` and `cleanCliLauncherInstalled`.
- Consumes: `installLightRsiCommandAlias(...)` from Task 2.

- [ ] **Step 1: Write failing Codex installation tests**

In the temp-directory Codex install test, assert:

```ts
assert.equal(result.cleanCliBinPath, join(cliBinDir, "lightrsi-clean"));
assert.equal(
  result.cleanCliLauncherPath,
  process.platform === "win32" ? join(cliBinDir, "lightrsi-clean.cmd") : undefined,
);
```

Execute the installed alias with `--help` and assert it renders Cleaner usage.
Install twice and assert the wrapper content is unchanged and only one alias
set exists.

- [ ] **Step 2: Write a failing Claude isolation assertion**

In the Claude install test, use a dedicated temporary bin directory and assert
that `lightrsi-clean`, `lightrsi-clean.cmd`, and `lightrsi-clean.ps1` are absent.
The existing Claude command-skill directory named `lightrsi-clean` is unrelated
and remains installed.

- [ ] **Step 3: Run adapter install tests and verify RED**

Run:

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/install.test.ts
pnpm --filter @lightrsi/claude-code-adapter exec node --import tsx --test tests/install.test.ts
```

Expected: Codex assertions fail because the binary alias is absent; Claude
isolation already passes.

- [ ] **Step 4: Install the alias from the Codex adapter**

Call `installLightRsiCommandAlias` only in `installCodexTokenPilot` after the
shared CLI exists:

```ts
const cleanCliBin = cliBin.installed
  ? await installLightRsiCommandAlias({
      adapterRoot: adapterRootFromHere(),
      binDir: cliBin.binDir,
      binName: "lightrsi-clean",
      fixedArgs: ["codex", "clean", "--require-tty"],
      platform: params?.platform,
    })
  : undefined;
```

Return its paths without changing the user's provider, authentication, or MCP
configuration logic.

- [ ] **Step 5: Write failing doctor tests**

Pass a temporary `cliBinDir` to `inspectCodexDoctor`. Assert the report and
rendered text distinguish the extensionless alias from the Windows `.cmd`
launcher and report missing files honestly.

- [ ] **Step 6: Run doctor tests and verify RED**

Run:

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/doctor.test.ts
```

Expected: FAIL because the report contains no alias fields.

- [ ] **Step 7: Implement alias diagnostics**

Add optional `cliBinDir` input to `inspectCodexDoctor`; default it to
`LIGHTRSI_BIN_DIR` or `$HOME/.local/bin`. Check `lightrsi-clean` and, on
Windows, `lightrsi-clean.cmd`. Add two concise lines to
`renderCodexDoctorReport` and include missing alias files in remediation text.
Do not read or print command contents, environment values, or credentials.

- [ ] **Step 8: Run Codex and Claude adapter verification**

Run:

```powershell
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/codex-adapter typecheck
pnpm --filter @lightrsi/claude-code-adapter test
pnpm --filter @lightrsi/claude-code-adapter typecheck
```

Expected: Codex installs and diagnoses the alias; Claude installation output
and bins remain unchanged.

- [ ] **Step 9: Commit Codex integration**

```powershell
git add -- components/adapters/codex/src/install.ts components/adapters/codex/src/doctor.ts components/adapters/codex/tests/install.test.ts components/adapters/codex/tests/doctor.test.ts components/adapters/claude-code/tests/install.test.ts
git commit -m "feat(codex): install raw TTY Cleaner entrypoint"
```

### Task 5: Documentation and isolated live-test harness

**Files:**
- Modify: `components/adapters/codex/README.md`
- Modify: `components/adapters/shared/command-skill-bridge.ts`
- Modify: `components/adapters/codex/tests/command-skill-bridge.test.ts`
- Modify: `var/codex-cleaner-isolated-test/start.ps1`
- Create: `var/codex-cleaner-isolated-test/verify-result.ps1`

**Interfaces:**
- Documents: `!lightrsi-clean` as the raw-TTY path and MCP form as compatibility behavior.
- Produces: isolated result verifier that accepts only a test-root path.

- [ ] **Step 1: Write failing documentation and skill assertions**

Assert the generated Codex Cleaner skill says that exact raw-TTY keys are
available through the user-entered `!lightrsi-clean` command and does not claim
the MCP form has the same keys. Assert the README contains the command and the
four-key contract.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/command-skill-bridge.test.ts
```

Expected: FAIL because current guidance describes only MCP elicitation.

- [ ] **Step 3: Update guidance without rerouting the MCP skill**

Keep the current MCP tool call behavior for `$lightrsi-clean`. Add a short,
literal note that users who need Up/Down, Space, Enter, and `q` run
`!lightrsi-clean` themselves. Update the README with the same distinction and
the deferred-apply note.

- [ ] **Step 4: Harden the isolated start script**

After isolated installation, require the temporary alias files and print:

```text
RAW_TTY_COMMAND=!lightrsi-clean
WORK_CONFIG_UNCHANGED=TRUE
ISOLATED_TEST_ENV=READY
```

Set `$env:LIGHTRSI_ISOLATED_TEST_ROOT = $testRoot` before launching Codex so
the verifier can consume the exact path without transcription.

Continue to launch Codex from the temporary workspace and stop only the
temporary TokenPilot daemon in `finally`. Never write the API key or inherited
auth file contents to logs.

- [ ] **Step 5: Add isolated receipt verification**

Create `verify-result.ps1` with mandatory `-TestRoot` and optional
`-ExpectedStatus scheduled|cancelled`. Resolve the path and reject it unless it
is beneath `[IO.Path]::GetTempPath()` and its leaf starts with
`lightrsi-codex-cleaner-`. Read only that test root's Cleaner plan, receipt, and
task registry. For scheduled mode assert A and B are selected, C is protected,
and the normal Codex config hash file still matches. For cancelled mode assert
no rewrite is scheduled.

- [ ] **Step 6: Parse-check the PowerShell scripts**

Run:

```powershell
$errors = $null
[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path '.\var\codex-cleaner-isolated-test\start.ps1'),
  [ref]$null,
  [ref]$errors
) | Out-Null
if ($errors.Count) { $errors | Format-List | Out-String | Write-Error }
[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path '.\var\codex-cleaner-isolated-test\verify-result.ps1'),
  [ref]$null,
  [ref]$errors
) | Out-Null
if ($errors.Count) { $errors | Format-List | Out-String | Write-Error }
```

Expected: no parser errors under Windows PowerShell 5.1.

- [ ] **Step 7: Run the isolated prerequisite check**

```powershell
& '.\var\codex-cleaner-isolated-test\start.ps1' -CheckOnly
```

Expected: `ISOLATED_TEST_PREREQUISITES=PASS`. This command must not install,
start a daemon, prompt for a key, or change the work config.

- [ ] **Step 8: Commit documentation and harness changes**

```powershell
git add -- components/adapters/codex/README.md components/adapters/shared/command-skill-bridge.ts components/adapters/codex/tests/command-skill-bridge.test.ts var/codex-cleaner-isolated-test/start.ps1 var/codex-cleaner-isolated-test/verify-result.ps1
git commit -m "test(codex): isolate raw TTY Cleaner verification"
```

### Task 6: Full regression and acceptance verification

**Files:**
- Verify only; modify a file only after reproducing a concrete failure with a new failing test.

**Interfaces:**
- Consumes every deliverable from Tasks 1 through 5.
- Produces fresh verification evidence and no PR.

- [ ] **Step 1: Run package tests and typechecks**

```powershell
pnpm --filter @lightrsi/cleaner test
pnpm --filter @lightrsi/cleaner typecheck
pnpm --filter @lightrsi/cli test
pnpm --filter @lightrsi/cli typecheck
pnpm --filter @lightrsi/mcp test
pnpm --filter @lightrsi/mcp typecheck
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/codex-adapter typecheck
pnpm --filter @lightrsi/claude-code-adapter test
pnpm --filter @lightrsi/claude-code-adapter typecheck
pnpm check:boundaries
```

Expected: every command exits 0 with zero failing tests.

- [ ] **Step 2: Build the affected products**

```powershell
pnpm --filter @lightrsi/cleaner build
pnpm --filter @lightrsi/cli build
pnpm --filter @lightrsi/mcp build
pnpm --filter @lightrsi/codex-adapter build
pnpm --filter @lightrsi/claude-code-adapter build
```

Expected: every build exits 0.

- [ ] **Step 3: Verify the work environment has not changed**

Record and compare hashes for the user's normal Codex config and auth before
and after automated verification. Inspect running TokenPilot processes and
ensure no process points at a temporary test root after scripts exit. Do not
print auth contents or API keys.

- [ ] **Step 4: Run the isolated live acceptance test**

From the isolated worktree only:

```powershell
& '.\var\codex-cleaner-isolated-test\start.ps1'
```

Inside the launched Codex session, complete short A and B tasks, leave C active,
then run `!lightrsi-clean`. Select A and B with Space and submit with Enter.
Send one harmless follow-up so deferred apply executes, exit Codex, and run:

```powershell
& '.\var\codex-cleaner-isolated-test\verify-result.ps1' `
  -TestRoot $env:LIGHTRSI_ISOLATED_TEST_ROOT `
  -ExpectedStatus scheduled
```

Expected: exact A/B receipt, protected C, applied rewrite, unchanged work config,
and no temporary daemon.

- [ ] **Step 5: Run the isolated cancellation acceptance test**

Start a fresh isolated run, invoke `!lightrsi-clean`, press `q`, exit Codex, and
run the verifier with `-ExpectedStatus cancelled`. Expected: cancelled receipt,
no scheduled rewrite, restored terminal, unchanged work config, and no temporary
daemon.

- [ ] **Step 6: Inspect the final diff**

```powershell
git status --short
git diff --check
git diff --stat HEAD~5..HEAD
```

Confirm changes remain on `codex/cleaner-elicitation`, no normal-home config or
credential file is tracked, no API key appears in the diff, and no PR exists.
