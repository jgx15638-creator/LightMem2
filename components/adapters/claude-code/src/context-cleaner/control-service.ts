import {
  createApiContextCleanRecommendationProvider,
  createContextCleanerControlPlane,
  createContextCleanerControlService,
  type ContextCleanerControlService,
} from "@lightrsi/cleaner";

import {
  defaultClaudeCodeStateDir,
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
} from "../config.js";
import { resolveClaudeCodeStateDir } from "../host-config-adapter.js";
import {
  loadClaudeCodeSessionSnapshot,
  resolveLatestClaudeCodeSessionId,
} from "../session-state.js";
import { createClaudeCodeContextCleanerBridge } from "./bridge.js";

/**
 * Claude Code cleaner control-service composition.
 *
 * Mirrors codex/src/context-cleaner/control-service.ts: it wires the shared
 * control plane + the Claude host bridge + the shared control service into a
 * single object the CLI (and any command entry point) can drive, so callers
 * depend only on the public ContextCleanerControlService instead of reaching
 * into the Claude bridge or plan store directly.
 *
 * Unlike codex, the Claude bridge takes no estimator/session callbacks — the
 * task-state estimator lives on the request-overlay runtime path
 * (context-cleaner/runtime.ts, context-rewrite/estimator-config.ts), not on the
 * analyze/approve/cancel control path composed here. The only model-facing knob
 * on this path is the analyze-time recommendation provider, resolved below from
 * the same taskStateEstimator config block the CLI host previously read inline.
 */

type CleanerEnvironment = Readonly<Record<string, string | undefined>>;

type ClaudeTaskStateEstimatorConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requestTimeoutMs: number;
};

export type ClaudeCleanerRecommendationConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMs: number;
}>;

export type ClaudeCodeContextCleanerControlService = {
  stateDir: string;
  service: ContextCleanerControlService;
  resolveSessionId(): Promise<string | undefined>;
};

/**
 * Reproduce the recommendation-provider gating the CLI host applied inline
 * (hosts/claude-code.ts passed recommendationEnabled + recommendationConfig
 * from config.taskStateEstimator). Provider is built only when the block is not
 * explicitly disabled and baseUrl/apiKey/model are all present; otherwise the
 * shared orchestrator falls back to its non-model recommendation path.
 */
export function resolveClaudeCleanerRecommendationConfig(
  config: ClaudeTaskStateEstimatorConfig,
): ClaudeCleanerRecommendationConfig | undefined {
  const baseUrl = config.baseUrl?.trim();
  const apiKey = config.apiKey?.trim();
  const model = config.model?.trim();
  if (config.enabled === false || !baseUrl || !apiKey || !model) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

export async function createClaudeCodeContextCleanerControlService(params?: {
  tokenPilotConfigPath?: string;
  stateDir?: string;
  currentClaudeSessionId?: string;
  environment?: CleanerEnvironment;
  now?: () => string;
}): Promise<ClaudeCodeContextCleanerControlService> {
  const tokenPilotConfigPath =
    params?.tokenPilotConfigPath?.trim() || defaultTokenPilotClaudeCodeConfigPath();
  const config = await loadTokenPilotClaudeCodeConfig(tokenPilotConfigPath);
  const environment = params?.environment ?? process.env;

  const stateDir =
    params?.stateDir?.trim()
    || environment.TOKENPILOT_STATE_DIR?.trim()
    || resolveClaudeCodeStateDir(config as unknown as Record<string, unknown>)
    || defaultClaudeCodeStateDir(tokenPilotConfigPath);
  if (!stateDir) throw new Error("claude_clean_state_dir_missing");

  const sessionRef = params?.currentClaudeSessionId?.trim();
  const resolveSessionId = async (): Promise<string | undefined> => {
    if (sessionRef && (await loadClaudeCodeSessionSnapshot(stateDir, sessionRef))) {
      return sessionRef;
    }
    return resolveLatestClaudeCodeSessionId(stateDir);
  };

  const controlPlane = createContextCleanerControlPlane({
    stateDir,
    now: params?.now,
  });
  const bridge = createClaudeCodeContextCleanerBridge({ stateDir, controlPlane });

  const recommendationConfig = resolveClaudeCleanerRecommendationConfig(
    config.taskStateEstimator,
  );
  const recommendationProvider = recommendationConfig
    ? createApiContextCleanRecommendationProvider(recommendationConfig)
    : undefined;

  const service = createContextCleanerControlService({
    stateDir,
    bridge,
    recommendationProvider,
    now: params?.now,
  });

  return { stateDir, service, resolveSessionId };
}
