<p align="center">
  <img src="./figs/LightRSI_logo.png" alt="LightRSI logo" width="220">
</p>

<p align="center">
A modular runtime for recursive improvement in long-running LLM agents
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Framework-LightRSI-black" alt="framework">
  <img src="https://img.shields.io/badge/Hosts-OpenClaw%20%7C%20Codex%20%7C%20Claude%20Code%20%7C%20DeepSeek%20Harness-green" alt="hosts">
  <img src="https://img.shields.io/badge/Product-Context%20Cleaner-orange" alt="product">
  <img src="https://img.shields.io/badge/Paper-TokenPilot-blue" alt="paper">
  <img src="https://img.shields.io/badge/Package%20Manager-pnpm-informational" alt="pnpm">
  <img src="https://img.shields.io/badge/License-MIT-brightgreen" alt="license">
</p>

---

<span id='products'/>

## 🛠️ Products

### Context Cleaner

Context Cleaner is available, with the same plan, approval, status, and cancellation model across hosts. In Codex, `/lightrsi-clean` opens the host-rendered task selector; the direct terminal equivalent is `lightrsi codex clean`. Analysis is read-only until you confirm a selection, and protected tasks cannot be selected.

<p align="center">
  <img src="./figs/tokenpilot/ContextCleaner.gif" alt="Codex Context Cleaner task selection" width="900">
</p>

<span id='papers'/>

## 📄 Papers

LightRSI separates reusable improvement capabilities from shared runtime infrastructure and host-specific integration. TokenPilot is the first preset.

| Papers | What It Does | How It Works | Effect |
| :-- | :-- | :-- | :-- |
| `TokenPilot` | Keeps long-running agent sessions smaller, cheaper, and easier to sustain | Stabilizes the reusable prompt prefix, trims oversized tool output before it poisons later turns, and limits how much old context is carried forward as sessions grow | Better cache reuse, lower token usage, lower cost, and less context bloat in shared sessions |

<span id='contents'/>

## 📑 Table of Contents

* <a href='#news'>📢 News</a>
* <a href='#products'>🛠️ Products</a>
* <a href='#papers'>📄 Papers</a>
* <a href='#installation'>🔧 Installation</a>
* <a href='#quickstart'>⚡ Quick Start</a>
* <a href='#visual-results'>🖼️ Visual Results</a>
* <a href='#architecture'>🏗️ Architecture</a>
* <a href='#experiments'>🧪 Experiment Reproduction</a>
* <a href='#commands'>💡 Commands</a>
* <a href='#experimental-results'>📁 Experimental Results</a>
* <a href='#citation'>📄 Citation</a>
* <a href='#contributing'>🤝 Contributing</a>
* <a href='#contributors'>🎉 Contributors</a>
* <a href='#related-works'>📚 Related Works</a>
* <a href='#community'>💬 Community</a>

<span id='news'/>

## 📢 News
- **[2026-08-21]**: 🎉🎉🎉 [**TokenPilot: Cache-Efficient Context Management for LLM Agents**](https://arxiv.org/abs/2606.17016) has been accepted by **EMNLP 2026**!
- **[2026-06-28]**: 🧩 TokenPilot now supports Codex and Claude Code. Demo video: [YouTube](https://www.youtube.com/watch?v=LGpu7FqaXCI) · [Bilibili](https://www.bilibili.com/video/BV1DSM86fE8M/?spm_id_from=333.1007.0.0)
- **[2026-06-16]**: 🚀 **[TokenPilot: Cache-Efficient Context Management for LLM Agents](https://arxiv.org/abs/2606.17016)** is released.
<span id='installation'/>

## 🔧 Installation

### 1. Prepare the Repository Once

Clone the repository and build the shared packages:

```bash
git clone https://github.com/zjunlp/LightRSI.git
cd LightRSI
corepack enable
pnpm install
```

The Host-specific Cleaner installer below builds the shared CLI, recovery MCP,
and selected adapter before installing them. A separate repository-wide build is
not required for this flow.

### 2. Pick Your Host

Open the host you want and run the default install commands.

<details>
<summary><strong>OpenClaw</strong></summary>

<br>

Default install:

```bash
pnpm component:install:tokenpilot:openclaw
```

This installs the current TokenPilot OpenClaw adapter, updates `~/.openclaw/openclaw.json`, enables the plugin, switches `plugins.slots.contextEngine` to `layered-context`, applies the default `normal` mode, and tries to restart the OpenClaw gateway automatically.

If your OpenClaw home or config path is not under the default `~/.openclaw`, set:

```bash
export LIGHTRSI_OPENCLAW_HOME="/path/to/openclaw-home"
export OPENCLAW_CONFIG_PATH="/path/to/openclaw.json"
```

Then run the same install command again:

```bash
pnpm component:install:tokenpilot:openclaw
```

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

<br>

Default install:

```bash
corepack pnpm cleaner:install:codex
```

This builds and installs the shared CLI, recovery MCP, Codex adapter, and the
explicit-only `lightrsi-clean`, `lightrsi-clean-status`,
`lightrsi-clean-apply`, and `lightrsi-clean-cancel` command skills. It keeps
your current active Codex provider, reroutes it through the local TokenPilot
proxy, writes `~/.codex/tokenpilot.json`, and registers the required hooks and
MCP server.

If your Codex config files are not under the default `~/.codex`, set:

```bash
export CODEX_CONFIG_PATH="/path/to/config.toml"
export CODEX_HOOKS_CONFIG_PATH="/path/to/hooks.json"
export TOKENPILOT_CODEX_CONFIG="/path/to/tokenpilot.json"
```

Then run the same install flow:

```bash
corepack pnpm cleaner:install:codex
```

On Windows, the installer uses the npm command directory when that directory is
already on `PATH` and creates `lightrsi.cmd`. On Linux/macOS it installs under
`~/.local/bin` by default. Set `LIGHTRSI_BIN_DIR` to choose another command
directory.

</details>

<details>
<summary><strong>Claude Code</strong></summary>

<br>

Default install:

```bash
corepack pnpm cleaner:install:claude-code
```

This builds and installs the shared CLI, recovery MCP, Claude Code adapter, and
the explicit-only Cleaner analysis, status, apply, and cancel command skills. It
updates local gateway routing, registers the required hooks and MCP server, and
preserves existing Claude files as `.tokenpilot.bak` backups before rewriting.

If your Claude Code files are not under the default `~/.claude`, set:

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
```

Then run the same install flow:

```bash
corepack pnpm cleaner:install:claude-code
```

Use `node scripts/install-cleaner.mjs <host> --dry-run` to inspect the exact build
and installation commands without changing Host configuration.
Add `--skip-build` only when reusing an existing local build; the installer
rejects missing or older CLI, MCP, and adapter artifacts before changing Host
configuration.

</details>

<details>
<summary><strong>DeepSeek Harness (Cordis)</strong></summary>

<br>

The DeepSeek Harness adapter is a native Cordis plugin and is installed into a DeepSeek Harness checkout rather than through the shared CLI. Build a local package from this repository:

```bash
corepack pnpm --filter @lightrsi/deepseek-harness-adapter build
corepack pnpm --filter @lightrsi/deepseek-harness-adapter pack --pack-destination ./artifacts
```

From the DeepSeek Harness checkout, add the generated `.tgz` to the profile you use, such as `web`:

```bash
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add /absolute/path/to/lightrsi-deepseek-harness-adapter-<version>.tgz
```

The plugin is registered as `tokenpilot-dsh` and is disabled by default. Configure and enable it only after supplying a durable `stateDir` and the estimator and eviction settings required by your Harness profile. Its failure mode is fail-open, so an optimization failure does not block the agent.

</details>

<span id='quickstart'/>

## ⚡ Quick Start

Pick your host and open the matching one-pass setup below.

<details>
<summary><strong>OpenClaw</strong></summary>

<br>

1. Start or restart OpenClaw.
2. Open a session with a `lightrsi/<model>` model such as `lightrsi/gpt-5.4-mini`.
3. Run:

```text
/lightrsi status
```

You should see a status block similar to:

- plugin entry enabled
- config enabled
- mode `normal`
- context engine slot `layered-context`
- stabilizer enabled
- reduction enabled

For a fuller runtime summary, run:

```text
/lightrsi report
/lightrsi doctor
/lightrsi visual
/lightrsi mode normal
```

`/lightrsi doctor` is the quickest integration self-check for the current OpenClaw adapter surface. `/lightrsi visual` opens the local visual inspector for stability, reduction, and eviction snapshots. `/lightrsi mode <conservative|normal|aggressive>` switches preset runtime behavior.

You can also use the standalone CLI outside OpenClaw:

```bash
lightrsi openclaw status
lightrsi openclaw report
lightrsi openclaw doctor
lightrsi openclaw visual
lightrsi openclaw mode normal
```

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

<br>

The current Codex path uses the standalone CLI plus Codex hooks.

1. Run the Codex install flow shown above.
2. Start Codex normally.
3. If Codex asks you to review or trust the installed TokenPilot hooks, approve them.
4. Open a new Codex session so `SessionStart` can start the local proxy.
5. In another terminal, verify the adapter:

```bash
lightrsi codex status
lightrsi codex doctor
lightrsi codex report
lightrsi codex mode normal
lightrsi codex reduction status
lightrsi codex stabilizer target user
```

Expected first-run shape:

- `lightrsi codex doctor` reports `proxy healthy: yes`
- `lightrsi codex status` shows `stabilizer` and `reduction` enabled
- after a few turns, `lightrsi codex report` no longer says `No TokenPilot session stats yet.`

Install success does not always mean the proxy is already running before the first trusted session. If doctor still reports `proxy healthy: no` after trusting hooks and opening a new Codex session, use the manual fallback:

```bash
tokenpilot-codex status
tokenpilot-codex start
```


</details>

<details>
<summary><strong>Claude Code</strong></summary>

<br>

The current Claude Code path also uses the standalone CLI, but routes requests through a local Anthropic-compatible gateway and a shared MCP recovery server.

1. Run the Claude Code install flow shown above.
2. Start Claude Code normally.
3. Open a new Claude Code session so `SessionStart` can auto-start the local gateway.
4. In another terminal, verify the adapter:

```bash
lightrsi claude-code status
lightrsi claude-code doctor
lightrsi claude-code report
lightrsi claude-code mode normal
lightrsi claude-code reduction status
lightrsi claude-code stabilizer target developer
```

Expected first-run shape:

- `lightrsi claude-code doctor` reports `proxy healthy: yes`
- `lightrsi claude-code status` shows `stabilizer` and `reduction` enabled
- after a few turns, `lightrsi claude-code report` no longer says `No TokenPilot session stats yet.`

Like Codex, install success does not guarantee that the gateway is already healthy before the first real session triggers `SessionStart`.

</details>

<details>
<summary><strong>DeepSeek Harness</strong></summary>

<br>

After adding and enabling the `tokenpilot-dsh` Cordis plugin, open a DeepSeek
Harness session and run:

```text
/tokenpilot-status
```

The command reports estimator, scheduling, application, and deferral state without creating a model turn. By default, the adapter runs its eviction pass before the Harness's native compaction; preserve this ordering unless you deliberately change the profile configuration.

</details>


<span id='visual-results'/>

## 🖼️ Visual Results

The screenshots below come from the built-in visual inspector opened with:

```text
lightrsi visual
```

<details>
<summary><strong>TokenPilot</strong> runtime effects</summary>

<br>

Stable-prefix view:

![TokenPilot stabilizer view](./figs/tokenpilot/stabilizer.png)

Reduction view:

![TokenPilot reduction view](./figs/tokenpilot/reduction.png)

Eviction view:

![TokenPilot eviction view](./figs/tokenpilot/eviction.png)

</details>

<span id='architecture'/>

## 🏗️ Architecture

The current public repository separates reusable capabilities, verified presets, host adapters, and user-facing products.

At a high level:

- `components/packages`
  - shared foundation and independently composable feature packages
- `components/presets`
  - verified feature combinations such as TokenPilot
- `components/adapters`
  - host-specific integration, install surfaces, runtime hooks, and product registration
- `components/products`
  - shared CLI, Visual launcher, recovery MCP, and interactive Cleaner surfaces

```text
LightRSI/
├── components/
│   ├── packages/
│   │   ├── foundation/           # contracts, runtime, host, history, artifact, product infrastructure
│   │   └── features/             # stabilizer, reduction, eviction, and memory
│   ├── presets/
│   │   └── tokenpilot/           # Stabilizer + Reduction + Eviction composition contract
│   ├── adapters/
│   │   ├── openclaw/             # OpenClaw adapter
│   │   ├── codex/                # Codex CLI adapter
│   │   ├── claude-code/          # Claude Code adapter
│   │   └── deepseek-harness/     # native DeepSeek Harness Cordis adapter
│   └── products/
│       ├── cli/                  # shared lightrsi CLI, browser visual launcher, and Cleaner UI
│       └── mcp/                  # shared recovery and interactive MCP session support
├── docs/                         # Public-facing notes and smoke helpers for the current runtime path
├── website/                      # Documentation site
└── README.md
```

TokenPilot is now a preset rather than a source-code parent directory. Each adapter explicitly binds the preset and contributes host discovery metadata; the shared CLI and Visual surface consume those registrations.

<span id='experiments'/>

## 🧪 Experiment Reproduction

Benchmark tasks, runners, profiles, and analysis are maintained in the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot). LightRSI contains the runtime and plugin platform; it no longer vendors the experiment harness.

Experiment entrypoints:

- [TokenPilot reproduction guide](https://github.com/Xubqpanda/TokenPilot/blob/main/README.md)


<span id='commands'/>

## 💡 Commands

Use the basic commands first, then the session-aware and advanced ones when you need them.

Shared standalone CLI patterns:

```bash
lightrsi report
lightrsi visual
lightrsi use openclaw
lightrsi use codex session <session-id>
lightrsi context
lightrsi <host> session <session-id> report
```

- `lightrsi report` shows the latest available report across hosts
- `lightrsi visual` opens the shared browser visual and lets you switch hosts and sessions
- `lightrsi use <host>` sets the default host for hostless CLI commands
- `lightrsi use <host> session <session-id>` pins the default session for later `report` and `visual`
- `lightrsi context` shows the current default host, pinned session, and remembered config target
- `lightrsi <host> session <session-id> report` reads one specific session directly

Pick your host for the command surface below.

<details>
<summary><strong>OpenClaw</strong></summary>

<br>

Inside an OpenClaw session:

```text
/lightrsi status
/lightrsi report
/lightrsi doctor
/lightrsi visual
/lightrsi mode normal
/lightrsi stabilizer target developer
/lightrsi reduction mode balanced
/lightrsi eviction on
/lightrsi help
```

Outside OpenClaw, the standalone CLI supports the same host directly:

```bash
lightrsi openclaw status
lightrsi openclaw report
lightrsi openclaw doctor
lightrsi openclaw visual
lightrsi openclaw mode normal
lightrsi openclaw session <session-id> report
```

Useful OpenClaw-only controls:

- `mode aggressive` enables the most aggressive runtime policy preset
- `eviction ...` controls lifecycle-aware context eviction
- `settings details on` expands status output with more runtime detail
- `stabilizer ...` and `reduction ...` let you tune prefix stabilization and observation reduction directly

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

<br>

Use the standalone CLI:

```bash
lightrsi codex status
lightrsi codex report
lightrsi codex doctor
lightrsi codex visual
lightrsi codex session <session-id> report
lightrsi codex reduction status
lightrsi codex stabilizer target developer
lightrsi codex mode normal
lightrsi codex reduction mode balanced
lightrsi codex help
```

Useful Codex controls:

- `stabilizer on|off` toggles stable-prefix rewriting
- `stabilizer target <developer|user>` chooses where dynamic context is attached
- `reduction on|off` toggles observation reduction
- `reduction mode <light|balanced>` switches between lighter and stronger trimming
- `reduction pass toolPayloadTrim off` disables one specific reduction pass
- `lightrsi codex clean` analyzes a session and interactively selects tasks to clean

</details>

<details>
<summary><strong>Claude Code</strong></summary>

<br>

Use the standalone CLI:

```bash
lightrsi claude-code status
lightrsi claude-code report
lightrsi claude-code doctor
lightrsi claude-code visual
lightrsi claude-code session <session-id> report
lightrsi claude-code reduction status
lightrsi claude-code stabilizer target developer
lightrsi claude-code mode normal
lightrsi claude-code reduction mode balanced
lightrsi claude-code help
```

Useful Claude Code controls:

- `stabilizer on|off` toggles stable-prefix rewriting
- `stabilizer target <developer|user>` chooses where dynamic context is attached
- `reduction on|off` toggles observation reduction
- `reduction mode <light|balanced>` switches between lighter and stronger trimming
- `reduction pass toolPayloadTrim off` disables one specific reduction pass

</details>

<details>
<summary><strong>DeepSeek Harness</strong></summary>

<br>

Inside a DeepSeek Harness session:

```text
/tokenpilot-status
```

This read-only command reports estimator activity, eligible eviction work, scheduled or applied changes, and any deferrals. The DeepSeek Harness adapter is registered by Cordis as `tokenpilot-dsh`; it does not use the shared `lightrsi` CLI.

</details>


<span id='experimental-results'/>

## 📁 Experimental Results

Benchmark tasks, runners, profiles, analysis, and result bundles are maintained in the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot). This repository keeps only the runtime and plugin platform.

- [TokenPilot reproduction guide](https://github.com/Xubqpanda/TokenPilot/blob/main/README.md)
- [PinchBench benchmark documentation](https://github.com/Xubqpanda/TokenPilot/tree/main/benchmarks/pinchbench)
- [Claw-Eval benchmark documentation](https://github.com/Xubqpanda/TokenPilot/tree/main/benchmarks/claw-eval)

For the latest commands, configurations, and reported results, use the experiment repository as the source of truth.
<span id='citation'/>

## 📄 Citation

Please cite our paper if you use LightRSI in your work.

```bibtex
@article{xu2026tokenpilot,
  title={TokenPilot: Cache-Efficient Context Management for LLM Agents},
  author={Xu, Buqiang and Xue, Zirui and Chen, Dianmou and Fu, Chenyang and Wu, Chiyu and Huang, Caiying and Jiang, Chen and Fang, Jizhan and Deng, Xinle and Chen, Yijun and others},
  journal={arXiv preprint arXiv:2606.17016},
  year={2026}
}
```

<span id='contributing'/>

## 🤝 Contributing

We welcome bug fixes, host adapter improvements, onboarding fixes, tests, and documentation updates, see [CONTRIBUTING.md](./CONTRIBUTING.md) for more details.

<span id='contributors'/>

## 🎉Contributors

<a href="https://github.com/zjunlp/LightRSI/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=zjunlp/LightRSI" />
</a>

We thank all the contributors to this project, more contributors are welcome!

<span id='related-works'/>

## 📚 Related Works

### LightMem Series
This repository belongs to ZJUNLP LightMem series, focusing on solving context bloat, excessive token consumption and low cache utilization for long-running LLM agents:
- [LightMem](https://github.com/zjunlp/LightMem) — A lightweight and efficient memory management framework designed for Large Language Models and AI Agents
- [LightMem-Ego](https://github.com/zjunlp/LightMem-Ego) — A lightweight streaming multimodal memory system for everyday-life assistance
### Other Related Projects

- [LLMLingua-2](https://github.com/microsoft/LLMLingua) — Token-level prompt compression
- [SelectiveContext](https://github.com/liyucheng09/Selective_Context) — Self-information-based context reduction
- [Pichay](https://github.com/fsgeek/pichay) — Demand paging for LLM context windows
- [MemoBrain](https://github.com/qhjqhj00/MemoBrain) — Executive memory for long-horizon reasoning agents
- [AgentSwing](https://github.com/Alibaba-NLP/DeepResearch) — Adaptive parallel context management routing for web agents
- [MemOS](https://github.com/MemTensor/MemOS) — Memory operating system for LLM agents
- [Headroom](https://github.com/chopratejas/headroom) — Compresses everything when AI agent reads

<span id='community'/>

## 💬 Community

- [Discord](https://discord.gg/gHdVfWz3) — setup help, debugging, feedback, and user discussion
- GitHub Issues — reproducible bugs, feature requests, and integration regressions
