import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MODEL_CONTEXT_REWRITE_SCHEMA_VERSION } from "@lightrsi/host-adapter";

import {
  createClaudeCodeContextCleanerControlService,
  resolveClaudeCleanerRecommendationConfig,
} from "../src/context-cleaner/control-service.js";
import {
  normalizeTokenPilotClaudeCodeConfig,
  writeTokenPilotClaudeCodeConfig,
} from "../src/config.js";
import { saveLatestClaudeSnapshot } from "../src/context-rewrite/snapshot-store.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";

async function writeConfig(stateDir: string, configPath: string): Promise<void> {
  await writeTokenPilotClaudeCodeConfig(
    normalizeTokenPilotClaudeCodeConfig(
      { stateDir, taskStateEstimator: { enabled: false } },
      { configPath },
    ),
    configPath,
  );
}

async function seedSession(stateDir: string, sessionId: string): Promise<void> {
  await upsertClaudeCodeSessionSnapshot(stateDir, sessionId, {
    latestModel: "claude-sonnet-4-6",
  });
  await saveLatestClaudeSnapshot(
    stateDir,
    sessionId,
    {
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      hostId: "claude-code",
      sessionId,
      revision: "revision-1",
      items: [{ stableId: "item-1", kind: "user", fingerprint: "digest-1", chars: 12 }],
    },
    { model: "claude-sonnet-4-6" },
  );
}

test("Claude cleaner control service composes stateDir, an explicit session, and the shared service", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-clean-control-"));
  try {
    const stateDir = join(root, "state");
    const tokenPilotConfigPath = join(root, "tokenpilot.json");
    await writeConfig(stateDir, tokenPilotConfigPath);
    await seedSession(stateDir, "session-a");

    const control = await createClaudeCodeContextCleanerControlService({
      tokenPilotConfigPath,
      stateDir,
      currentClaudeSessionId: "session-a",
      environment: {},
    });

    assert.equal(control.stateDir, stateDir);
    assert.equal(await control.resolveSessionId(), "session-a");
    assert.equal(typeof control.service.analyze, "function");
    assert.equal(typeof control.service.approve, "function");
    assert.equal(typeof control.service.readReceipt, "function");
    assert.equal(typeof control.service.cancel, "function");

    const plan = await control.service.analyze("session-a");
    assert.equal(plan.hostId, "claude-code");
    assert.equal(plan.sessionId, "session-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude cleaner control service falls back to the latest session when no hint is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-clean-control-latest-"));
  try {
    const stateDir = join(root, "state");
    const tokenPilotConfigPath = join(root, "tokenpilot.json");
    await writeConfig(stateDir, tokenPilotConfigPath);
    await seedSession(stateDir, "session-old");
    await seedSession(stateDir, "session-new");

    const control = await createClaudeCodeContextCleanerControlService({
      tokenPilotConfigPath,
      stateDir,
      environment: {},
    });

    const resolved = await control.resolveSessionId();
    assert.ok(
      resolved === "session-old" || resolved === "session-new",
      `expected a seeded session id, got ${String(resolved)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveClaudeCleanerRecommendationConfig gates on enabled and full credentials", () => {
  assert.deepEqual(
    resolveClaudeCleanerRecommendationConfig({
      baseUrl: "https://api.example.test/v1/",
      apiKey: "secret",
      model: "estimator-model",
      requestTimeoutMs: 180_000,
    }),
    {
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      model: "estimator-model",
      requestTimeoutMs: 180_000,
    },
  );

  assert.equal(
    resolveClaudeCleanerRecommendationConfig({
      enabled: false,
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      model: "estimator-model",
      requestTimeoutMs: 180_000,
    }),
    undefined,
  );

  assert.equal(
    resolveClaudeCleanerRecommendationConfig({
      baseUrl: "https://api.example.test/v1",
      apiKey: "",
      model: "estimator-model",
      requestTimeoutMs: 180_000,
    }),
    undefined,
  );
});
