import {
  createApiContextCleanRecommendationProvider,
  createContextCleanerControlPlane,
  createContextCleanerControlService,
  type ContextCleanerControlService,
} from "@lightrsi/cleaner";
import type {
  TaskStateEstimator,
  TaskStateEstimatorApiConfig,
} from "@lightrsi/eviction";

import {
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
} from "../config.js";
import { resolveCodexTaskStateEstimator } from "../context-rewrite/estimator-config.js";
import { resolveCodexStateDir } from "../host-config-adapter.js";
import {
  loadCodexSessionSnapshot,
  resolveCodexSessionAlias,
  resolveLatestCodexSessionId,
} from "../session-state.js";
import { createCodexContextCleanerBridge } from "./bridge.js";
import { resolveCodexCleanerInvocationSessionId } from "./session-catalog.js";

export type CodexContextCleanerControlService = {
  stateDir: string;
  service: ContextCleanerControlService;
  resolveSessionId(): Promise<string | undefined>;
};

type CleanerEnvironment = Readonly<Record<string, string | undefined>>;

export type CodexCleanerRecommendationConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMs: number;
}>;

export function resolveCodexCleanerRecommendationConfig(params: {
  config: TaskStateEstimatorApiConfig;
  environment: CleanerEnvironment;
}): CodexCleanerRecommendationConfig | undefined {
  const resolution = resolveCodexTaskStateEstimator({
    config: params.config,
    env: params.environment,
  });

  if (
    resolution.status !== "ready" ||
    !resolution.config.baseUrl ||
    !resolution.config.apiKey ||
    !resolution.config.model
  ) {
    return undefined;
  }

  return {
    baseUrl: resolution.config.baseUrl,
    apiKey: resolution.config.apiKey,
    model: resolution.config.model,
    requestTimeoutMs: resolution.config.requestTimeoutMs,
  };
}

function currentCodexSessionRef(params: {
  currentCodexSessionId?: string;
  environment: CleanerEnvironment;
}): string | undefined {
  return params.currentCodexSessionId?.trim()
    || params.environment.CODEX_SESSION_ID?.trim()
    || params.environment.CODEX_THREAD_ID?.trim()
    || undefined;
}

export async function createCodexContextCleanerControlService(params?: {
  tokenPilotConfigPath?: string;
  stateDir?: string;
  currentCodexSessionId?: string;
  environment?: CleanerEnvironment;
  taskStateEstimator?: TaskStateEstimator;
  now?: () => string;
}): Promise<CodexContextCleanerControlService> {
  const tokenPilotConfigPath = params?.tokenPilotConfigPath?.trim()
    || defaultTokenPilotConfigPath();
  const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
  const environment = params?.environment ?? process.env;
  const stateDir = params?.stateDir?.trim()
    || environment.TOKENPILOT_STATE_DIR?.trim()
    || resolveCodexStateDir(config as unknown as Record<string, unknown>);
  if (!stateDir) throw new Error("codex_clean_state_dir_missing");

  const sessionRef = currentCodexSessionRef({
    currentCodexSessionId: params?.currentCodexSessionId,
    environment,
  });
  let resolvedCurrentSession: {
    sessionId: string;
    codexSessionId: string;
  } | undefined;
  const resolveSessionId = async (): Promise<string | undefined> => {
    let resolvedSessionId: string | undefined;
    if (sessionRef) {
      resolvedSessionId = await resolveCodexSessionAlias(stateDir, sessionRef);
      if (!resolvedSessionId && await loadCodexSessionSnapshot(stateDir, sessionRef)) {
        resolvedSessionId = sessionRef;
      }
    } else {
      resolvedSessionId = await resolveCodexCleanerInvocationSessionId(stateDir)
        ?? await resolveLatestCodexSessionId(stateDir);
    }
    if (!resolvedSessionId) {
      resolvedCurrentSession = undefined;
      return undefined;
    }
    const snapshot = await loadCodexSessionSnapshot(stateDir, resolvedSessionId);
    const codexSessionId = snapshot?.codexSessionId?.trim();
    resolvedCurrentSession = codexSessionId
      ? { sessionId: resolvedSessionId, codexSessionId }
      : undefined;
    return resolvedSessionId;
  };
  const controlPlane = createContextCleanerControlPlane({
    stateDir,
    now: params?.now,
  });
  const estimatorResolution = resolveCodexTaskStateEstimator({
    config: config.taskStateEstimator,
    env: environment,
  });
  const bridge = createCodexContextCleanerBridge({
    stateDir,
    controlPlane,
    currentCodexSessionId: sessionRef,
    async resolveCurrentCodexSessionId(sessionId) {
      return resolvedCurrentSession?.sessionId === sessionId
        ? resolvedCurrentSession.codexSessionId
        : undefined;
    },
    taskStateEstimator: params?.taskStateEstimator ?? estimatorResolution.estimator,
    taskStateEstimatorConfig: {
      batchTurns: estimatorResolution.config.batchTurns,
      inputMode: estimatorResolution.config.inputMode,
    },
  });
  const recommendationConfig = resolveCodexCleanerRecommendationConfig({
    config: config.taskStateEstimator,
    environment,
  });
  const recommendationProvider = recommendationConfig
    ? createApiContextCleanRecommendationProvider(recommendationConfig)
    : undefined;
  const service = createContextCleanerControlService({
    stateDir,
    bridge,
    recommendationProvider,
    now: params?.now,
  });

  return {
    stateDir,
    service,
    resolveSessionId,
  };
}
