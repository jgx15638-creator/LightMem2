import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";

test("normalizeTokenPilotClaudeCodeConfig applies stable defaults", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.logLevel, "info");
  assert.equal(config.proxyPort, 17668);
  assert.equal(config.upstreamBaseUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(config.stateDir.endsWith(join(".claude", "tokenpilot-state", "tokenpilot")), true);
});

test("normalizeTokenPilotClaudeCodeConfig derives default stateDir from the tokenpilot config path", () => {
  const configPath = resolve("tmp", "custom-claude-root", "tokenpilot.json");
  const config = normalizeTokenPilotClaudeCodeConfig({}, {
    configPath,
  });
  assert.equal(config.stateDir, join(dirname(configPath), "tokenpilot-state", "tokenpilot"));
});

test("normalizeTokenPilotClaudeCodeConfig trims and clamps values", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({
    logLevel: "debug",
    proxyPort: 999999,
    upstreamBaseUrl: "https://example.com/v1/messages///",
  });
  assert.equal(config.logLevel, "debug");
  assert.equal(config.proxyPort, 65535);
  assert.equal(config.upstreamBaseUrl, "https://example.com/v1/messages");
});

test("normalizeTokenPilotClaudeCodeConfig enables stabilizer and reduction defaults", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({});
  assert.equal(config.modules.stabilizer, true);
  assert.equal(config.modules.reduction, true);
  assert.equal(config.modules.eviction, false);
  assert.equal(config.eviction.enabled, false);
  assert.equal(config.eviction.minBlockChars, 4000);
  assert.equal(config.eviction.failureMode, "bypass");
  assert.equal(config.reduction.triggerMinChars, 2200);
  assert.equal(config.reduction.maxToolChars, 1200);
  assert.equal(config.reduction.passes.readStateCompaction, true);
  assert.equal(config.reduction.passes.toolPayloadTrim, true);
  assert.equal(config.reduction.passes.htmlSlimming, true);
  assert.equal(config.reduction.passes.execOutputTruncation, true);
  assert.equal(config.reduction.passes.agentsStartupOptimization, true);
});

test("normalizeTokenPilotClaudeCodeConfig preserves and clamps eviction settings", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({
    modules: { eviction: true },
    eviction: { enabled: true, minBlockChars: 10, failureMode: "fail_closed" },
  });
  assert.equal(config.modules.eviction, true);
  assert.equal(config.eviction.enabled, true);
  assert.equal(config.eviction.minBlockChars, 256);
  assert.equal(config.eviction.failureMode, "bypass");
});

test("normalizeTokenPilotClaudeCodeConfig applies taskStateEstimator defaults", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({});
  assert.equal(config.taskStateEstimator.enabled, undefined);
  assert.equal(config.taskStateEstimator.baseUrl, undefined);
  assert.equal(config.taskStateEstimator.apiKey, undefined);
  assert.equal(config.taskStateEstimator.model, undefined);
  assert.equal(config.taskStateEstimator.requestTimeoutMs, 60_000);
  assert.equal(config.taskStateEstimator.batchTurns, 5);
  assert.equal(config.taskStateEstimator.evictionLookaheadTurns, 3);
  assert.equal(config.taskStateEstimator.inputMode, undefined);
  assert.equal(config.taskStateEstimator.lifecycleMode, undefined);
  assert.equal(config.taskStateEstimator.evidenceMode, undefined);
});

test("normalizeTokenPilotClaudeCodeConfig reads and clamps taskStateEstimator values", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({
    taskStateEstimator: {
      enabled: true,
      baseUrl: "https://estimator.example.com/v1///",
      apiKey: "  sk-test  ",
      model: "claude-sonnet-4-6",
      requestTimeoutMs: 5000,
      batchTurns: 0,
      evictionLookaheadTurns: 10,
      inputMode: "sliding_window",
      lifecycleMode: "decoupled",
      evidenceMode: "two_state",
    },
  });
  assert.equal(config.taskStateEstimator.enabled, true);
  assert.equal(config.taskStateEstimator.apiKey, "sk-test");
  assert.equal(config.taskStateEstimator.model, "claude-sonnet-4-6");
  assert.equal(config.taskStateEstimator.requestTimeoutMs, 5000);
  assert.equal(config.taskStateEstimator.batchTurns, 1);
  assert.equal(config.taskStateEstimator.evictionLookaheadTurns, 10);
  assert.equal(config.taskStateEstimator.inputMode, "sliding_window");
  assert.equal(config.taskStateEstimator.lifecycleMode, "decoupled");
  assert.equal(config.taskStateEstimator.evidenceMode, "two_state");
});
