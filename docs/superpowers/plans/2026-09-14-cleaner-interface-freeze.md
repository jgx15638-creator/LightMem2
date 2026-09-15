# Cleaner Host Interface Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze a small host-neutral Cleaner boundary so Codex, Claude Code, OpenClaw, and later adapters can be developed in parallel without sharing UI code or Cleaner persistence logic.

**Architecture:** `@lightrsi/cleaner` owns immutable plans, receipts, typed lifecycle errors, two-phase scheduling, execution claims, cancellation, and terminal recording. Adapters supply a snapshot source, an idempotent host-local schedule writer, an optional session catalog, and their existing native rewrite backend. CLI and MCP surfaces consume the shared control service and remain outside the frozen host contract.

**Tech Stack:** TypeScript 5.9, Node.js 20/22, Node test runner, pnpm workspaces, atomic JSON stores, existing per-plan file locks, and Codex and Claude host-local schedule journals.

**Spec:** `docs/superpowers/specs/2026-09-14-cleaner-interface-freeze-design.md`

## Global Constraints

- Work only in an isolated LightRSI worktree. Do not modify the user's normal checkout, normal `CODEX_HOME`, authentication, or persistent environment.
- Preserve stored `ContextCleanPlan` and `ContextCleanReceipt` schema version 1 and their existing file paths.
- Do not add an `applying` receipt state. Use the internal execution-claim sidecar from the specification.
- Do not change recommendation, attribution, protection, raw-TTY key, or rendering behavior.
- Do not implement Cleaner in OpenClaw. Run its existing tests and typecheck as compatibility checks.
- Do not include VVEAI, Responses compatibility, WebSocket, model-catalog, upstream, or proxy changes.
- Convert public failures to `ContextCleanerError`; keep raw store reasons internal.
- Use object parameters and readonly arrays on every frozen public method.
- Write a failing test before each production change, then run its focused test before continuing.
- Commit only files and hunks named by the current task. Inspect `git diff --cached` before each commit.
- Do not create or submit a pull request while executing this plan.

## Work Allocation and Merge Order

| Lane | Plan work | Start condition |
| --- | --- | --- |
| Shared interface owner | Tasks 1-3, shared composition portion of Task 4 | Starts first; Tasks 1-3 stay sequential |
| Codex interaction owner | Codex portion of Task 4 and Task 5 | Starts after Task 3 contracts pass |
| Claude compatibility owner | Claude portion of Task 4 | Starts after Task 3 contracts pass; may run parallel with Codex work |
| Interface reviewer | Task 6 conformance review and Task 7 freeze gate | Starts after both Task 4 lanes and Task 5 pass |
| Other host owners | New Claude/OpenClaw feature work based on the adapter guide | Starts only after Task 7 passes |

Within Task 4, the shared interface owner edits generic CLI composition, while
the Codex and Claude owners edit only their adapter paths. Integrate those lanes
after their focused tests pass. Later Codex selector and display fixes remain in
the Codex lane and do not reopen the frozen host contract.

---

### Task 1: Freeze public capability, result, and error types

**Files:**
- Create: `components/packages/features/cleaner/src/errors.ts`
- Modify: `components/packages/features/cleaner/src/contracts.ts`
- Modify: `components/packages/features/cleaner/src/index.ts`
- Create: `components/packages/features/cleaner/tests/errors.test.ts`
- Modify: `components/packages/features/cleaner/tests/contracts.test.ts`

**Interfaces:**
- Produces: `ContextCleanerSnapshotSource`, `ContextCleanerScheduleWriter`, and `ContextCleanerSessionCatalog`.
- Produces: `ContextCleanerErrorCode` and `ContextCleanerError`.
- Tightens: execution claim and terminal recording result unions.
- Deprecates for removal in Task 4: `ContextCleanerHostBridge` and `ContextCleanerControlPlane`.

- [ ] **Step 1: Add failing error-contract tests**

Create `errors.test.ts`:

```ts
test("ContextCleanerError exposes a stable code and copied details", () => {
  const source = { planId: "plan-1", status: "approved" };
  const error = new ContextCleanerError("clean_state_conflict", source);
  source.status = "scheduled";

  assert.equal(error.name, "ContextCleanerError");
  assert.equal(error.code, "clean_state_conflict");
  assert.deepEqual(error.details, { planId: "plan-1", status: "approved" });
  assert.equal(isContextCleanerError(error), true);
  assert.equal(isContextCleanerError(new Error("clean_state_conflict")), false);
});
```

- [ ] **Step 2: Add compile-time contract fixtures**

In `contracts.test.ts`, declare objects using `satisfies`:

```ts
const snapshotSource = {
  hostId: "test-host",
  async readSnapshot(input: { sessionId: string }) {
    assert.equal(input.sessionId, "session-1");
    return sampleSnapshot();
  },
} satisfies ContextCleanerSnapshotSource;

const scheduleWriter = {
  hostId: "test-host",
  async writeSchedule() {
    return { outcome: "stored" as const };
  },
} satisfies ContextCleanerScheduleWriter;
```

Add `// @ts-expect-error` fixtures proving that a failed writer result requires
an error, a success result cannot contain an error, positional
`readSnapshot("session-1")` is rejected, and callers cannot mutate a returned
session list.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
pnpm --filter @lightrsi/cleaner exec node --import tsx --test tests/errors.test.ts tests/contracts.test.ts
pnpm --filter @lightrsi/cleaner typecheck
```

Expected: FAIL because the new class and split interfaces do not exist.

- [ ] **Step 4: Implement typed errors**

Implement the exact error-code union from the spec and:

```ts
export class ContextCleanerError extends Error {
  readonly code: ContextCleanerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ContextCleanerErrorCode,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = "ContextCleanerError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
```

Also export `isContextCleanerError`. Never include transcript text or arbitrary
caught-error strings in `details`.

- [ ] **Step 5: Add the split interfaces and tight unions**

Implement the signatures from the design spec. Change the `snapshotItems`
comment to:

```ts
/** Ordered metadata baseline used to freeze and relocate selected targets. */
```

Keep every plan and receipt field unchanged. Mark the old combined types as
internal migration shims until Task 4.

- [ ] **Step 6: Run package verification**

```powershell
pnpm --filter @lightrsi/cleaner test
pnpm --filter @lightrsi/cleaner typecheck
```

Expected: all Cleaner tests pass, including negative type fixtures.

- [ ] **Step 7: Commit only the contract files**

```powershell
git add -- components/packages/features/cleaner/src/errors.ts components/packages/features/cleaner/src/contracts.ts components/packages/features/cleaner/src/index.ts components/packages/features/cleaner/tests/errors.test.ts components/packages/features/cleaner/tests/contracts.test.ts
git diff --cached --check
git diff --cached
git commit -m "refactor(cleaner): define host integration contract"
```

---

### Task 2: Make approval and host scheduling a two-phase service operation

**Files:**
- Modify: `components/packages/features/cleaner/src/control-service.ts`
- Modify: `components/packages/features/cleaner/src/orchestrator.ts`
- Modify: `components/packages/features/cleaner/src/clean-state-coordinator.ts`
- Modify: `components/packages/features/cleaner/tests/control-service.test.ts`
- Modify: `components/packages/features/cleaner/tests/orchestrator.test.ts`

**Interfaces:**
- Produces: object-parameter `ContextCleanerControlService`.
- Produces: `scheduleSelection(...)` that returns only after host schedule and shared scheduled receipt are durable.
- Consumes: snapshot source and schedule writer without adapter lifecycle forwarding.

- [ ] **Step 1: Replace Codex-shaped test bridges with host-neutral fakes**

Create a test writer journal keyed by plan ID. Its first matching write returns
`stored`, a repeat returns `unchanged`, and a changed identity returns
`failed` with `clean_state_conflict`.

Use the service only through:

```ts
service.analyze({ sessionId });
service.getPlan({ planId });
service.scheduleSelection({ planId, selectedTaskIds });
service.getReceipt({ planId });
service.cancel({ planId });
```

- [ ] **Step 2: Add failing ordering and recovery tests**

Prove all six cases:

1. the writer observes a stored `approved` receipt;
2. writer failure leaves the receipt `approved`;
3. a writer that stores a pointer but reports failure once returns `unchanged`
   on retry and converges to one scheduled receipt;
4. cancellation during the writer call prevents the final scheduled transition;
5. repeated identical scheduling returns the stored scheduled receipt;
6. a different selection returns `clean_state_conflict`.

Use typed assertions:

```ts
await assert.rejects(
  service.scheduleSelection({ planId, selectedTaskIds: ["task-a"] }),
  (error: unknown) => isContextCleanerError(error)
    && error.code === "clean_schedule_write_failed",
);
```

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
pnpm --filter @lightrsi/cleaner exec node --import tsx --test tests/control-service.test.ts tests/orchestrator.test.ts
```

Expected: FAIL because shared state currently becomes scheduled before the
adapter writes its queue.

- [ ] **Step 4: Implement the new service composition**

Use this factory shape:

```ts
createContextCleanerControlService({
  stateDir,
  snapshotSource,
  scheduleWriter,
  recommendationProvider,
  contextWindowTokens,
  now,
});
```

Reject mismatched host IDs with `clean_invalid_input`. Validation reconstructs
exact item IDs and digests from the stored plan; these fields never cross the
schedule-writer boundary.

- [ ] **Step 5: Implement two-phase scheduling**

Under the per-plan lock, write or confirm a matching `approved` receipt. Reuse
that receipt's `updatedAt` as `scheduledAt`, call `writeSchedule`, then
reacquire the lock and transition `approved -> scheduled` only if state and
selection still match. A retry from `approved` must reuse the same timestamp.

Map a writer failure to:

```ts
throw new ContextCleanerError("clean_schedule_write_failed", {
  planId: plan.planId,
  causeCode: write.error.code,
});
```

A retry from `approved` must call the idempotent writer again. A host pointer
whose final shared transition lost to cancellation remains inert.

Canonicalize selected task IDs by their order in the stored plan before writing
the approved receipt or calling the schedule writer. Add a test showing
`["task-b", "task-a"]` and `["task-a", "task-b"]` replay the same identity.

- [ ] **Step 6: Run focused and full verification**

```powershell
pnpm --filter @lightrsi/cleaner exec node --import tsx --test tests/control-service.test.ts tests/orchestrator.test.ts tests/clean-state-coordinator.test.ts
pnpm --filter @lightrsi/cleaner test
pnpm --filter @lightrsi/cleaner typecheck
```

Expected: all pass, and the writer-order test observes `approved` during the
host write.

- [ ] **Step 7: Commit the scheduling lifecycle**

```powershell
git add -- components/packages/features/cleaner/src/control-service.ts components/packages/features/cleaner/src/orchestrator.ts components/packages/features/cleaner/src/clean-state-coordinator.ts components/packages/features/cleaner/tests/control-service.test.ts components/packages/features/cleaner/tests/orchestrator.test.ts
git diff --cached --check
git diff --cached
git commit -m "fix(cleaner): make host scheduling recoverable"
```

---

### Task 3: Serialize cancellation and execution with a durable claim

**Files:**
- Create: `components/packages/features/cleaner/src/clean-execution-claim-store.ts`
- Modify: `components/packages/features/cleaner/src/clean-store-support.ts`
- Modify: `components/packages/features/cleaner/src/host-execution-bridge.ts`
- Modify: `components/packages/features/cleaner/src/control-service.ts`
- Modify: `components/packages/features/cleaner/src/index.ts`
- Create: `components/packages/features/cleaner/tests/clean-execution-claim-store.test.ts`
- Modify: `components/packages/features/cleaner/tests/host-execution-bridge.test.ts`
- Modify: `components/packages/features/cleaner/tests/control-service.test.ts`

**Interfaces:**
- Produces: `claimScheduledClean(...)` with a deterministic claim ID.
- Produces: claim-required `recordCleanReceipt(...)`.
- Coordinates: cancellation and execution through the existing per-plan lock.
- Keeps internal: claim record, path, parser, and raw store results.

- [ ] **Step 1: Add failing claim-store tests**

Cover the exact
`context-cleaner/execution-claims/<sha256(planId)>.json` path, atomic first
write, matching replay, conflicting identity, corrupt JSON, and
`claimed -> completed`. Use the record shape in the design spec.

- [ ] **Step 2: Add failing claim/cancel tests**

Cover:

- claim wins, then cancel returns `clean_execution_in_progress`;
- cancel wins, then claim returns the terminal cancelled receipt;
- concurrent claim and cancel have exactly one winner;
- repeated claim returns the same claim and mutation operation IDs;
- missing or mismatched claim rejects terminal recording;
- matching `applied`, `stale`, and `failed` receipts record successfully;
- terminal replay is unchanged;
- a terminal receipt plus a claimed sidecar completes recovery without a second mutation.

The concurrent assertion is:

```ts
const [claimed, cancelled] = await Promise.allSettled([
  bridge.claimScheduledClean(request()),
  service.cancel({ planId: "plan-1" }),
]);
const claimWon = claimed.status === "fulfilled"
  && claimed.value.outcome === "ready";
const cancelWon = cancelled.status === "fulfilled"
  && cancelled.value.status === "cancelled";
assert.equal(Number(claimWon) + Number(cancelWon), 1);
```

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
pnpm --filter @lightrsi/cleaner exec node --import tsx --test tests/clean-execution-claim-store.test.ts tests/host-execution-bridge.test.ts tests/control-service.test.ts
```

Expected: FAIL because no claim exists and cancellation can still follow a
successful execution preparation.

- [ ] **Step 4: Implement the internal sidecar**

Add the path beside existing Cleaner store paths without exporting it from the
package root. Use `writeJsonFileAtomic` and unlocked helpers called only while
`withContextCleanStoreLock` is held. Derive `claimId` from stored plan identity,
canonical selected task IDs, and the scheduled receipt timestamp.

- [ ] **Step 5: Claim after revalidation and recheck**

Keep current snapshot, frozen-target, lifecycle, protection, and protocol
closure validation. Reacquire the plan lock, re-read state, require the same
scheduled identity, and write or reuse the claim before returning `ready`.

- [ ] **Step 6: Make cancel and terminal recording claim-aware**

Cancellation checks the claim while holding the same lock. With a claim, throw:

```ts
new ContextCleanerError("clean_execution_in_progress", {
  planId,
  claimId: claim.claimId,
});
```

Terminal recording accepts only `applied`, `stale`, or `failed` and requires the
matching claim. Transition plan and receipt under the lock, then mark the claim
completed. Recovery completes a leftover sidecar when the terminal receipt is
already durable.

- [ ] **Step 7: Run focused, repeated-race, and package verification**

```powershell
pnpm --filter @lightrsi/cleaner exec node --import tsx --test tests/clean-execution-claim-store.test.ts tests/host-execution-bridge.test.ts tests/control-service.test.ts
1..20 | ForEach-Object { pnpm --filter @lightrsi/cleaner exec node --import tsx --test --test-name-pattern "concurrent claim and cancel" tests/host-execution-bridge.test.ts; if ($LASTEXITCODE -ne 0) { throw "race iteration $_ failed" } }
pnpm --filter @lightrsi/cleaner test
pnpm --filter @lightrsi/cleaner typecheck
```

Expected: all 20 races have exactly one winner.

- [ ] **Step 8: Commit execution arbitration**

```powershell
git add -- components/packages/features/cleaner/src/clean-execution-claim-store.ts components/packages/features/cleaner/src/clean-store-support.ts components/packages/features/cleaner/src/host-execution-bridge.ts components/packages/features/cleaner/src/control-service.ts components/packages/features/cleaner/src/index.ts components/packages/features/cleaner/tests/clean-execution-claim-store.test.ts components/packages/features/cleaner/tests/host-execution-bridge.test.ts components/packages/features/cleaner/tests/control-service.test.ts
git diff --cached --check
git diff --cached
git commit -m "fix(cleaner): serialize cancellation and execution"
```

---

### Task 4: Migrate Codex and Claude Code to the frozen capabilities

**Files:**
- Modify: `components/adapters/codex/src/context-cleaner/bridge.ts`
- Modify: `components/adapters/codex/src/context-cleaner/control-service.ts`
- Modify: `components/adapters/codex/src/context-cleaner/index.ts`
- Modify: `components/adapters/codex/src/context-cleaner/runtime.ts`
- Modify: `components/adapters/codex/tests/context-cleaner-bridge.test.ts`
- Modify: `components/adapters/codex/tests/context-cleaner-control-service.test.ts`
- Modify: `components/adapters/codex/tests/context-cleaner-runtime.test.ts`
- Modify: `components/adapters/claude-code/src/context-cleaner/bridge.ts`
- Modify: `components/adapters/claude-code/src/context-cleaner/runtime.ts`
- Modify: `components/adapters/claude-code/tests/context-cleaner-bridge.test.ts`
- Modify: `components/adapters/claude-code/tests/context-cleaner-runtime.test.ts`
- Modify: `components/products/cli/src/hosts/cleaner.ts`
- Modify: `components/products/cli/src/hosts/codex.ts`
- Modify: `components/products/cli/tests/clean-host-registration.test.ts`

**Interfaces:**
- Codex and Claude produce snapshot source, schedule writer, and session catalog.
- Host runtimes consume execution claims and claim-required terminal recording.
- Removes: adapter dependency on `ContextCleanerControlPlane`.

- [ ] **Step 1: Add failing capability and runtime tests**

For each host, assert the factory exposes:

```ts
type CleanerHostCapabilities = {
  snapshotSource: ContextCleanerSnapshotSource;
  scheduleWriter: ContextCleanerScheduleWriter;
  sessionCatalog: ContextCleanerSessionCatalog;
};
```

Real schedule writers must return `stored`, then `unchanged` for identical
input including `scheduledAt`, and typed `clean_state_conflict` for changed
selection.

Make each runtime receive `{ outcome: "ready", claimId: "claim-1", execution }`
and assert it records `{ claimId: "claim-1", receipt }`. Terminal, missing, and
rejected results must not invoke the rewrite backend. A
`clean_execution_not_scheduled` rejection while shared state is still approved
must leave the host pointer scheduled for retry. A terminal cancelled result
must close the host pointer without applying a mutation.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/context-cleaner-bridge.test.ts tests/context-cleaner-control-service.test.ts tests/context-cleaner-runtime.test.ts
pnpm --filter @lightrsi/claude-code-adapter exec node --import tsx --test tests/context-cleaner-bridge.test.ts tests/context-cleaner-runtime.test.ts
pnpm --filter @lightrsi/cli exec node --import tsx --test tests/clean-host-registration.test.ts
```

Expected: FAIL because both bridges forward a shared control plane and runtimes
do not propagate claims.

- [ ] **Step 3: Split both host bridges**

Expose `snapshotSource`, `scheduleWriter`, and `sessionCatalog`. Reuse
`scheduleCodexCleanerPlan` and `scheduleClaudeCleanerPlan` inside
`writeSchedule`. Delete approval-request and shared-receipt forwarding and
validation from adapters. Keep native snapshot and schedule formats unchanged.

- [ ] **Step 4: Update compositions and runtimes**

Construct the shared service from snapshot source and schedule writer; use the
catalog only for session discovery. Rename runtime preparation to
`claimScheduledClean`, keep the claim ID in a local variable, and pass it to
`recordCleanReceipt`. Never persist or expose the claim ID to a model.

- [ ] **Step 5: Remove migration shims**

```powershell
rg -n "ContextCleanerHostBridge|ContextCleanerControlPlane|ExecuteApprovedContextCleanParams|createContextCleanerControlPlane|executeApprovedClean|prepareScheduledClean" components --glob "*.ts"
```

Expected: no matches.

- [ ] **Step 6: Run affected package verification**

```powershell
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/codex-adapter typecheck
pnpm --filter @lightrsi/claude-code-adapter test
pnpm --filter @lightrsi/claude-code-adapter typecheck
pnpm --filter @lightrsi/cli test
pnpm --filter @lightrsi/cli typecheck
```

- [ ] **Step 7: Commit adapter migration**

Stage only the Task 4 paths, inspect the staged diff, then:

```powershell
git diff --cached --check
git diff --cached
git commit -m "refactor(cleaner): migrate host adapters to capabilities"
```

---

### Task 5: Migrate UI consumers and persist Codex MCP cancellation

**Files:**
- Modify: `components/adapters/codex/src/context-cleaner/mcp-selection.ts`
- Modify: `components/adapters/codex/tests/context-cleaner-mcp-selection.test.ts`
- Modify: `components/products/cli/src/clean.ts`
- Modify: `components/products/cli/src/hosts/cleaner.ts`
- Modify: `components/products/cli/tests/clean.test.ts`
- Modify: `components/products/cli/tests/clean-prompt.test.ts`

**Interfaces:**
- MCP and CLI consume only `ContextCleanerControlService`.
- UI failures branch on `ContextCleanerError.code`.
- Prompt and terminal event types remain product-internal.

- [ ] **Step 1: Add failing consumer tests**

For elicitation `decline` and `cancel`, assert
`service.cancel({ planId })` is called once and structured content comes from
the persisted receipt. A store failure returns `isError: true` with the stable
code. Assert selected submission calls:

```ts
service.scheduleSelection({
  planId: "plan-1",
  selectedTaskIds: ["task-a"],
});
```

Empty submission calls neither schedule nor cancel.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/context-cleaner-mcp-selection.test.ts
pnpm --filter @lightrsi/cli exec node --import tsx --test tests/clean.test.ts tests/clean-prompt.test.ts
```

Expected: FAIL because MCP reports cancellation without persisting it and
consumers still call `approve`.

- [ ] **Step 3: Persist cancellation and map typed errors**

For a non-accepted MCP elicitation, call `service.cancel({ planId })` and render
the returned receipt. Catch `ContextCleanerError` at the tool boundary and
return its code and sanitized details. Map an unknown exception to
`clean_store_unavailable` without echoing its raw message to the model.

- [ ] **Step 4: Migrate CLI service calls without changing keys or rendering**

Map `analyze`, `scheduleSelection`, `getReceipt`, and `cancel` into the existing
CLI backend. Do not edit key handlers, selector rows, footer output, Windows
console input, or immediate `q`/Escape behavior.

- [ ] **Step 5: Run UI regression verification**

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/context-cleaner-mcp-selection.test.ts
pnpm --filter @lightrsi/cli exec node --import tsx --test tests/clean.test.ts tests/clean-prompt.test.ts tests/clean-non-tty.test.ts tests/windows-console-key-input.test.ts tests/windows-console-output.test.ts
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/cli test
```

Expected: MCP cancellation is stored, and raw-TTY key/output tests are unchanged.

- [ ] **Step 6: Commit UI migration**

Stage only Task 5 paths, inspect the staged diff, then:

```powershell
git diff --cached --check
git diff --cached
git commit -m "fix(cleaner): persist UI cancellation through service"
```

---

### Task 6: Add cross-host conformance coverage and adapter documentation

**Files:**
- Create: `components/adapters/shared/testing/context-cleaner-contract.ts`
- Create: `components/adapters/codex/tests/context-cleaner-contract.test.ts`
- Create: `components/adapters/claude-code/tests/context-cleaner-contract.test.ts`
- Create: `docs/design/cleaner-host-adapter-contract.md`
- Modify: `docs/superpowers/specs/2026-09-14-cleaner-interface-freeze-design.md`

**Interfaces:**
- Produces: test-only `defineContextCleanerHostContract(...)`.
- Documents: the frozen capability boundary for parallel adapter authors.
- Does not export the conformance helper from a production package.

- [ ] **Step 1: Implement the test-only contract harness**

Use this input:

```ts
export type ContextCleanerHostContractFixture = {
  name: string;
  create(): Promise<{
    snapshotSource: ContextCleanerSnapshotSource;
    scheduleWriter: ContextCleanerScheduleWriter;
    readStoredSchedule(planId: string): Promise<{
      sessionId: string;
      baseRevision: string;
      selectedTaskIds: readonly string[];
    } | undefined>;
  }>;
};

export function defineContextCleanerHostContract(
  fixture: ContextCleanerHostContractFixture,
): void;
```

Register tests for host and snapshot identity, first schedule write, identical
replay, conflicting replay, absence of native payloads, and proof that schedule
writing does not mutate the snapshot.

- [ ] **Step 2: Run the same harness against Codex and Claude**

Each fixture uses temporary state and the real snapshot and scheduler
implementation. Do not create an OpenClaw fixture in this change.

```powershell
pnpm --filter @lightrsi/codex-adapter exec node --import tsx --test tests/context-cleaner-contract.test.ts
pnpm --filter @lightrsi/claude-code-adapter exec node --import tsx --test tests/context-cleaner-contract.test.ts
```

Expected: both hosts report the same contract test names and all pass.

- [ ] **Step 3: Write the adapter author guide**

`docs/design/cleaner-host-adapter-contract.md` must contain the dependency
diagram, all three capability signatures, schedule identity and idempotency,
two-phase scheduling, execution claims, typed errors, a complete fake adapter
example, conformance commands, and a list of responsibilities that stay in the
shared service. Link it from the spec.

- [ ] **Step 4: Verify docs and boundaries**

```powershell
pnpm check:boundaries
rg -n "ContextCleanerControlPlane|executeApprovedClean|prepareScheduledClean" docs/design/cleaner-host-adapter-contract.md
git diff --check -- components/adapters/shared/testing/context-cleaner-contract.ts components/adapters/codex/tests/context-cleaner-contract.test.ts components/adapters/claude-code/tests/context-cleaner-contract.test.ts docs/design/cleaner-host-adapter-contract.md docs/superpowers/specs/2026-09-14-cleaner-interface-freeze-design.md
```

Expected: boundary check passes; both searches and diff check return no output.

- [ ] **Step 5: Commit conformance coverage and guide**

Stage only Task 6 paths, inspect the staged diff, then:

```powershell
git diff --cached --check
git diff --cached
git commit -m "test(cleaner): add host adapter conformance suite"
```

---

### Task 7: Run the interface-freeze gate and audit branch scope

**Files:**
- Modify only if a check finds a defect: files already named in Tasks 1-6.
- Review: all commits since the feature branch merge base.
- Do not modify: normal `~/.codex/config.toml` or `~/.codex/auth.json`.

**Interfaces:**
- Verifies: frozen exports, lifecycle invariants, host compatibility, UI
  regression, package boundaries, and environment isolation.
- Produces: a review note with exact test counts and limitations.

- [ ] **Step 1: Prove migration types are gone**

```powershell
rg -n "ContextCleanerHostBridge|ContextCleanerControlPlane|ExecuteApprovedContextCleanParams|createContextCleanerControlPlane|executeApprovedClean|prepareScheduledClean" components --glob "*.ts"
```

Expected: no matches.

- [ ] **Step 2: Run all affected tests, typechecks, boundaries, and builds**

```powershell
pnpm --filter @lightrsi/cleaner test
pnpm --filter @lightrsi/cleaner typecheck
pnpm --filter @lightrsi/cli test
pnpm --filter @lightrsi/cli typecheck
pnpm --filter @lightrsi/codex-adapter test
pnpm --filter @lightrsi/codex-adapter typecheck
pnpm --filter @lightrsi/claude-code-adapter test
pnpm --filter @lightrsi/claude-code-adapter typecheck
pnpm --filter @lightrsi/openclaw-adapter test
pnpm --filter @lightrsi/openclaw-adapter typecheck
pnpm check:boundaries
pnpm -r build
```

Expected: every command exits 0. Record current test counts from this run.

- [ ] **Step 3: Repeat lifecycle stress tests**

```powershell
1..50 | ForEach-Object { pnpm --filter @lightrsi/cleaner exec node --import tsx --test --test-name-pattern "concurrent claim and cancel|writer failure.*retry|terminal receipt replay" tests/host-execution-bridge.test.ts tests/control-service.test.ts; if ($LASTEXITCODE -ne 0) { throw "lifecycle iteration $_ failed" } }
```

Expected: no double winner, orphan scheduled receipt, or duplicate host
schedule in 50 iterations.

- [ ] **Step 4: Reject unrelated transport files from the branch**

```powershell
$mergeBase = git merge-base HEAD origin/main
$changed = git diff --name-only $mergeBase HEAD
$forbidden = $changed | Select-String -Pattern 'responses-compatibility|websocket-bridge|upstream|proxy-runtime|vveai|model-catalog'
if ($forbidden) { $forbidden; throw 'Interface-freeze branch contains unrelated transport files.' }
git diff --check $mergeBase HEAD
```

If unrelated work is uncommitted, leave it uncommitted and exclude it from the
future PR. Do not reset, delete, or stash another person's work.

- [ ] **Step 5: Prove OpenClaw source stayed unchanged**

```powershell
$mergeBase = git merge-base HEAD origin/main
$openClawChanges = git diff --name-only $mergeBase HEAD -- components/adapters/openclaw
if ($openClawChanges) { $openClawChanges; throw 'OpenClaw implementation is outside this change.' }
```

Expected: no output.

- [ ] **Step 6: Run one isolated Codex live test**

Record SHA-256 hashes of normal `~/.codex/config.toml` and
`~/.codex/auth.json`. Use temporary `CODEX_HOME`, state, bin, and workspace
paths. Complete two small tasks, keep one protected task active, run
`!lightrsi-clean`, select one task, submit, and send one next host request.

Verify one host pointer, one shared scheduled receipt, one execution claim, one
applied receipt, and no duplicate mutation. Close the isolated process, verify
both normal hashes are unchanged, then delete only the resolved temporary path
printed by the launcher after confirming it is beneath `$env:TEMP`.

- [ ] **Step 7: Produce the freeze review note**

Record the final signatures, package test counts, 50-iteration stress result,
Codex and Claude conformance result, OpenClaw unchanged result, isolated
receipt/claim outcome, normal config hash equality, and forbidden-file audit.

Do not create a PR. Present the review note and branch diff to the user for the
next decision.
