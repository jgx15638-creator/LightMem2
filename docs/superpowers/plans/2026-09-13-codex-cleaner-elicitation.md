# Codex Cleaner MCP Elicitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-native Cleaner selection form that maps the user's keyboard selection to exact stored task IDs and schedules them in the same MCP tool call.

**Architecture:** A shared Cleaner control service owns analysis and approval. A reusable full-duplex MCP peer provides server-to-client elicitation, while a Codex-specific MCP entry point composes the Cleaner service and selection tool. Existing direct CLI, recovery MCP, Claude Code skills, and stored plan formats remain compatible.

**Tech Stack:** TypeScript 5.9, Node.js 20+, stdio JSON-RPC/MCP, esbuild, Node test runner, pnpm workspaces.

**Spec:** `docs/design/codex-cleaner-elicitation.md`

## Global Constraints

- Implement Codex support first; do not add Claude Code or OpenClaw elicitation in this plan.
- Do not parse rendered CLI text to recover plan or task IDs.
- Do not accept item IDs, item digests, deletion ranges, or selected task IDs as MCP tool input.
- Select no tasks by default.
- Preserve the existing direct raw-TTY and non-TTY CLI behavior.
- Preserve the existing recovery MCP server name and installation.
- A cancelled, declined, unsupported, failed, or empty selection must not schedule a clean.

---

### Task 1: Shared Cleaner control service

**Files:**
- Create: `components/packages/features/cleaner/src/control-service.ts`
- Modify: `components/packages/features/cleaner/src/index.ts`
- Modify: `components/products/cli/src/hosts/cleaner.ts`
- Test: `components/packages/features/cleaner/tests/control-service.test.ts`
- Test: `components/products/cli/tests/clean-host-registration.test.ts`

**Interfaces:**
- Produces: `ContextCleanerControlService` and `createContextCleanerControlService(...)` from the architecture spec.
- Consumes: existing `ContextCleanerHostBridge`, plan store, recommendation provider, and receipt types.

- [x] **Step 1: Write a failing control-service test**

Create a stored plan with one selectable and one protected task. Assert that
`approve(planId, [selectableId])` recovers frozen item IDs/digests and returns a
scheduled receipt. Assert that an unknown, duplicate, or protected task ID
rejects before `executeApprovedClean` receives a request.

- [x] **Step 2: Run the focused test and confirm it fails**

```powershell
pnpm --filter @lightrsi/cleaner test -- control-service.test.ts
```

Expected: failure because `createContextCleanerControlService` is not exported.

- [x] **Step 3: Implement the Host-neutral service**

Move analysis, stored-plan reading, frozen target recovery, approval, receipt
reading, and cancellation from `createHostCleanCommandBackend` into the new
service. Keep view conversion in the CLI package.

- [x] **Step 4: Adapt the CLI backend**

Construct `ContextCleanerControlService` and delegate all five backend methods,
mapping domain plans and receipts to existing CLI view types.

- [x] **Step 5: Run Cleaner and CLI regression tests**

```powershell
pnpm --filter @lightrsi/cleaner test
pnpm --filter @lightrsi/cli test
pnpm --filter @lightrsi/cleaner typecheck
pnpm --filter @lightrsi/cli typecheck
```

Expected: all existing direct-TTY, non-TTY, plan, selection, and receipt tests pass.

### Task 2: Full-duplex MCP stdio peer

**Files:**
- Create: `components/products/mcp/src/session.ts`
- Modify: `components/products/mcp/src/index.ts`
- Test: `components/products/mcp/tests/session.test.ts`

**Interfaces:**
- Produces: `McpServerPeer`, `McpToolHandler`, and `serveStdioMcpServer(...)`.
- Preserves: `handleMcpRequest(...)`, recovery tool behavior, and both framing modes.

- [x] **Step 1: Write failing bidirectional protocol tests**

Use a spawned fixture server. Send `initialize` with form elicitation capability,
then `tools/call`. Assert that the server emits `elicitation/create`, accepts the
matching client response ID, and completes the original tool call. Also assert
that `notifications/initialized` produces no response.

- [x] **Step 2: Run the MCP tests and confirm the new test fails**

```powershell
pnpm --filter @lightrsi/mcp test
```

Expected: failure because the current request handler treats client responses as invalid requests.

- [x] **Step 3: Implement request correlation and capability storage**

Assign server request IDs from a separate numeric range, store pending resolve
and reject callbacks, route messages without `method` to the pending map, and
reject pending requests when stdin closes.

- [x] **Step 4: Preserve wire compatibility**

Use the existing newline-JSON and Content-Length encoders and parsers. Keep the
current recovery server entry point on its existing one-way handler during this
task; only export the new reusable peer.

- [x] **Step 5: Run MCP tests and typecheck**

```powershell
pnpm --filter @lightrsi/mcp test
pnpm --filter @lightrsi/mcp typecheck
```

Expected: existing recovery tests and new full-duplex tests pass.

### Task 3: Codex Cleaner service composition and selection tool

**Files:**
- Create: `components/adapters/codex/src/context-cleaner/control-service.ts`
- Create: `components/adapters/codex/src/context-cleaner/mcp-selection.ts`
- Modify: `components/adapters/codex/src/context-cleaner/index.ts`
- Modify: `components/products/cli/src/hosts/codex.ts`
- Test: `components/adapters/codex/tests/context-cleaner-mcp-selection.test.ts`

**Interfaces:**
- Produces: `createCodexContextCleanerControlService(...)`.
- Produces: `createCodexCleanerMcpTool(...)`, `CODEX_CLEANER_MCP_SERVER_NAME`, and `CODEX_CLEAN_TOOL_NAME`.
- Consumes: shared Cleaner service and `McpServerPeer.request(...)`.

- [x] **Step 1: Write failing selection-mapping tests**

Build a plan with two selectable tasks and one protected task. Capture the
`elicitation/create` request, return `{ action: "accept", content: { task_1:
true, task_2: false } }`, and assert that approval receives only the exact first
task ID. Assert that the protected task has no form field.

- [x] **Step 2: Add negative-path tests**

Assert that cancel, decline, empty selection, missing form capability, and
analysis with no selectable tasks never call `approve`. Assert that approval
errors return an MCP error result without substituting a new plan or task ID.

- [x] **Step 3: Run the focused adapter test and confirm it fails**

```powershell
pnpm --filter @lightrsi/codex-adapter test -- context-cleaner-mcp-selection.test.ts
```

Expected: failure because the Codex Cleaner MCP tool does not exist.

- [x] **Step 4: Implement Codex service composition**

Load the existing Codex TokenPilot config, resolve `stateDir`, construct the
Codex Cleaner bridge, and resolve the current session in this order:
`CODEX_SESSION_ID`, `CODEX_THREAD_ID`, configured/latest session fallback.
Reuse this composition from the CLI host adapter.

- [x] **Step 5: Implement the form builder and tool handler**

Generate ordinal field names, freeze the field-to-task map locally, include all
tasks in the plan message, include only selectable tasks in the schema, and set
every boolean default to false. On accepted non-empty selection, call the shared
service's `approve` before returning the tool result.

- [x] **Step 6: Run adapter and CLI tests**

```powershell
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/codex-adapter typecheck
pnpm --filter @lightrsi/cli test
```

Expected: exact mapping and all negative-path tests pass; CLI behavior remains unchanged.

### Task 4: Codex Cleaner MCP executable and installation

**Files:**
- Create: `components/adapters/codex/src/cleaner-mcp-server.ts`
- Modify: `components/adapters/codex/build.ts`
- Modify: `components/adapters/codex/src/install.ts`
- Modify: `components/adapters/codex/src/doctor.ts`
- Modify: `components/adapters/codex/scripts/pack-release.mjs`
- Modify: `components/adapters/codex/scripts/pack_release.sh`
- Test: `components/adapters/codex/tests/install.test.ts`
- Test: `components/adapters/codex/tests/doctor.test.ts`
- Test: `components/adapters/codex/src/release-package.test.ts`

**Interfaces:**
- Produces: `dist/cleaner-mcp-server.js` and an installed `[mcp_servers.lightrsi_cleaner]` block.
- Preserves: existing `[mcp_servers.tokenpilot_memory_fault_recover]` block and recovery artifact.

- [x] **Step 1: Write failing install and package tests**

Assert that installation writes both MCP blocks exactly once, repeated install
is idempotent, the Cleaner block points to `cleaner-mcp-server.js`, and the
release archive contains both MCP server artifacts.

- [x] **Step 2: Run focused install tests and confirm failure**

```powershell
pnpm --filter @lightrsi/codex-adapter test -- install.test.ts
```

Expected: failure because the Cleaner server spec and artifact are absent.

- [x] **Step 3: Add the executable and build entry**

Compose `serveStdioMcpServer` with the Codex Cleaner tool. Add
`"cleaner-mcp-server": "src/cleaner-mcp-server.ts"` to the adapter's esbuild
entry points.

- [x] **Step 4: Install and diagnose the second server**

Add `resolveCodexCleanerMcpServerSpecForInstall`, write its TOML block with
`TOKENPILOT_STATE_DIR`, probe it during install, and report its health separately
from recovery MCP health in doctor output.

- [x] **Step 5: Package both artifacts**

Keep copying `products/mcp/dist/server.js` as `mcp-server.js`; additionally copy
the adapter-built `dist/cleaner-mcp-server.js` into the release package.

- [x] **Step 6: Run build, install, doctor, and package tests**

```powershell
pnpm --filter @lightrsi/mcp build
pnpm --filter @lightrsi/codex-adapter build
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/codex-adapter typecheck
```

Expected: both MCP services build, install idempotently, and report independent health.

### Task 5: Route the Codex clean skill to MCP

**Files:**
- Modify: `components/adapters/shared/command-skill-bridge.ts`
- Test: `components/adapters/codex/tests/install.test.ts`
- Test: `components/adapters/claude-code/tests/install.test.ts`

**Interfaces:**
- Codex `/lightrsi-clean` calls `lightrsi_cleaner.lightrsi_clean` once.
- Claude Code `/lightrsi-clean` retains the current bundled CLI analysis command.
- `lightrsi-clean-apply`, status, and cancel skills remain available.

- [x] **Step 1: Write failing host-specific skill tests**

Assert that the generated Codex clean skill names the MCP tool, forbids shell
fallback during a successful MCP call, and tells the model to return the tool
result. Assert that the generated Claude skill still contains its current exact
version-pinned shell command.

- [x] **Step 2: Run Codex and Claude install tests and confirm the Codex assertion fails**

```powershell
pnpm --filter @lightrsi/codex-adapter test -- install.test.ts
pnpm --filter @lightrsi/claude-code-adapter test -- install.test.ts
```

- [x] **Step 3: Split Cleaner analysis instructions by bridge style**

Generate MCP-specific instructions only when `style === "codex"` and
`mode === "cleaner_analysis"`. Do not alter the remaining command skills.

- [x] **Step 4: Run both adapter suites**

```powershell
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/claude-code-adapter test
```

Expected: Codex uses MCP and Claude retains the existing behavior.

### Task 6: End-to-end selection and regression verification

**Files:**
- Modify: `components/adapters/codex/tests/e2e.test.ts`
- Modify: `components/adapters/codex/README.md`

**Interfaces:**
- Verifies the complete user-visible path without a live model dependency.
- Documents install, approval, selection, cancellation, and direct CLI fallback.

- [x] **Step 1: Write an in-process end-to-end test**

Create a Codex snapshot with two selectable and one protected task, initialize
the Cleaner MCP server with elicitation capability, call the tool, return an
accepted A+C form response, and assert that the stored receipt contains only A
and C with status `scheduled`.

- [x] **Step 2: Add cancellation and stale-plan end-to-end cases**

Assert that cancellation writes no scheduled receipt and that a plan conflict
returns the existing stable error without applying a rewrite.

- [x] **Step 3: Run all affected tests and builds**

```powershell
pnpm --filter @lightrsi/cleaner test
pnpm --filter @lightrsi/mcp test
pnpm --filter @lightrsi/cli test
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/cleaner typecheck
pnpm --filter @lightrsi/mcp typecheck
pnpm --filter @lightrsi/cli typecheck
pnpm --filter @lightrsi/codex-adapter typecheck
pnpm --filter @lightrsi/mcp build
pnpm --filter @lightrsi/cli build
pnpm --filter @lightrsi/codex-adapter build
```

Expected: every command exits zero.

- [x] **Step 4: Perform the installed Codex CLI smoke test**

Install into an isolated Codex home, start Codex CLI, invoke `/lightrsi-clean`,
approve the one-time MCP tool call, select two known selectable tasks with the
host controls, and verify that the returned and stored receipt contains the same
two exact IDs. Exit Codex and verify that no test configuration was written to
the user's normal Codex home.

- [x] **Step 5: Update Codex documentation**

Document that the host renders the form and owns key bindings, that no task is
preselected, that acceptance schedules work for the next Host request, and that
the direct `lightrsi codex clean` command remains available.
