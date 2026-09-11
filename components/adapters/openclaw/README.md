# TokenPilot OpenClaw Adapter

This package contains the live OpenClaw adapter runtime for the current LightRSI OpenClaw path. Within the broader LightRSI framework, this package is the runtime adapter layer used by the TokenPilot component.

This adapter explicitly binds TokenPilot with `stabilizer`, `reduction`, and `eviction`, and contributes OpenClaw state discovery to the shared CLI/Visual product registry.

For the component-level overview, command surface, and full configuration reference, see:

- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)
- [`components/adapters/README.md`](../README.md)
- [`components/adapters/HOSTS.md`](../HOSTS.md)

Current adapter responsibilities:

- embedded responses proxy
- stable-prefix rewriting
- request-time reduction
- tool-result persistence
- canonical history rewrite and eviction
- user-approved Context Cleaner snapshot and immediate canonical apply
- recovery protocol and recovery tool wiring

## Install

Release-style install:

```bash
cd /path/to/LightRSI/components/adapters/openclaw
npm run install:release
```

This uses OpenClaw's managed plugin installer so the declared Context Engine
capability is recorded and consented, then installs the packaged TokenPilot
runtime component into:

```text
~/.openclaw/extensions/tokenpilot
```

After install, run the adapter doctor:

```bash
cd /path/to/LightRSI/components/adapters/openclaw
npm run doctor:openclaw
```

Inside an active TokenPilot session, the equivalent self-check is:

```text
/tokenpilot doctor
```

Or use the standalone CLI:

```bash
cd /path/to/LightRSI
lightrsi openclaw doctor
```

Analyze an OpenClaw session without changing its context:

```bash
lightrsi openclaw clean --session <session-id>
```

The same flow is available inside an active OpenClaw conversation through the
plugin's native command surface:

```text
/lightrsi clean
/lightrsi clean --session <session-id>
```

The first form resolves the current conversation's mapped TokenPilot session.
If no mapping is available, pass the session id explicitly. Analysis never
applies a rewrite by itself. When the task registry is missing or behind the
canonical conversation, this explicit analysis request first classifies the
pending turns through OpenClaw's Host-managed, tool-free model completion
surface. Cleaner recommendations reuse that same Host-managed completion, so
provider credentials remain inside OpenClaw's auth store. Older Hosts
without that surface fall back to an explicitly configured `taskStateEstimator`;
classification or recommendation failure uses the conservative shared fallback
and does not make any additional task selectable.

Apply only tasks selected from that immutable plan:

```bash
lightrsi openclaw clean --plan <plan-id> --select <task-id,...>
```

Or apply and inspect the plan from the OpenClaw conversation:

```text
/lightrsi clean --plan <plan-id> --select <task-id,...>
/lightrsi clean --status <plan-id>
/lightrsi clean --cancel <plan-id>
```

`/tokenpilot clean` and `/tp clean` are equivalent aliases. Active, current,
and unresolved tasks remain protected by the canonical Cleaner validation.

OpenClaw archives selected task content before atomically committing the
canonical rewrite. Unlike scheduled Codex and Claude Code rewrites, a successful
OpenClaw command returns an `applied` receipt immediately.

Development-style install should use source build + runtime sync instead of mixing release and load-path installs. The current sanity workflow is:

1. build the package
2. sync the runtime artifact
3. validate OpenClaw config
4. restart gateway

See:

- [`README.md`](../../../README.md)
- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)

## Build

```bash
cd /path/to/LightRSI/components/adapters/openclaw
corepack pnpm build
corepack pnpm typecheck
```

## Runtime Model Prefix

When the current TokenPilot component is active, it registers an explicit provider namespace:

```text
lightrsi/<model>
```

Example:

```text
lightrsi/gpt-5.4-mini
```

## Runtime State

The current component state directory prefers:

```text
$HOME/.openclaw/tokenpilot-state/tokenpilot/
```

Legacy installs may still be under:

```text
$HOME/.openclaw/tokenpilot-plugin-state/tokenpilot/
```

Useful files:

- `event-trace.jsonl`
- `provider-traffic.jsonl`
- `response-root-state.json`
- `sessions/<logical>/turns.jsonl`

## Debugging

When a run looks invalid, start with:

```bash
OPENCLAW_CONFIG_PATH=$HOME/.openclaw/openclaw.json openclaw config validate
tail -n 100 $HOME/.openclaw/logs/gateway.log
rg 'stable_prefix_rewrite|proxy_before_call_rewrite|proxy_after_call_rewrite|tool_result_persist_applied' \
  $HOME/.openclaw/tokenpilot-state/task-state/trace.jsonl
```

Lightweight integration self-check:

```bash
cd /path/to/LightRSI/components/adapters/openclaw
npm run doctor:openclaw
```

The runtime sanity guide lives in:

- [`../README.md`](../README.md)
- [`../HOSTS.md`](../HOSTS.md)

## Package Scripts

Primary package scripts:

```bash
corepack pnpm build
corepack pnpm typecheck
npm test
npm run doctor:openclaw
```

The package still contains a small release-helper surface under `components/adapters/openclaw/scripts/`. Benchmarking and evaluation flows live in the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot).
