/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  annotateCanonicalMessagesWithTaskAnchors,
  loadCanonicalState,
  loadSessionTaskRegistry,
  saveCanonicalState,
  type SessionTaskRegistry,
} from "@lightrsi/history";
import {
  contextSafeRecovery,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
} from "@lightrsi/artifact-store";
import type { RuntimeModuleRuntime, RuntimeTurnContext } from "@lightrsi/kernel";
import {
  createApiTaskStateEstimator,
  createPolicyModule,
  type JsonModelClient,
} from "@lightrsi/tokenpilot";

import { syncRawSemanticTurnsFromMessages } from "../context-stack/page-out-api.js";
import { buildPolicyModuleConfigFromPluginConfig } from "../context-stack/integration/policy-config-bridge.js";
import { detectUpstreamConfig } from "../context-stack/integration/upstream-config.js";
import type { UpstreamConfig } from "../context-stack/integration/upstream-types.js";
import type { NormalizedPluginRuntimeConfig } from "../context-stack/integration/config-types.js";
import { contentToText } from "../context-stack/integration/runtime-event-text.js";
import {
  dedupeStrings,
  ensureContextSafeDetails,
} from "../context-stack/integration/runtime-tooling.js";

const NO_MODEL_RUNTIME: RuntimeModuleRuntime = {
  async callModel() {
    throw new Error("cleaner task-state bootstrap does not use the module runtime model");
  },
};

type CleanerTaskRegistryBootstrapLogger = {
  warn?: (message: string) => void;
};

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function configuredModelRef(config: Record<string, unknown>): string {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  if (typeof model === "string") return model.trim();
  return typeof asRecord(model)?.primary === "string"
    ? String(asRecord(model)?.primary).trim()
    : "";
}

function providerAndModel(config: Record<string, unknown>): {
  providerId?: string;
  modelId?: string;
} {
  const ref = configuredModelRef(config);
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return {};
  return {
    providerId: ref.slice(0, separator),
    modelId: ref.slice(separator + 1),
  };
}

async function persistTaskAnchors(
  stateDir: string,
  sessionId: string,
  registry: SessionTaskRegistry,
): Promise<void> {
  const latest = await loadCanonicalState(stateDir, sessionId);
  if (!latest) return;
  const annotated = annotateCanonicalMessagesWithTaskAnchors(
    latest.messages,
    registry,
    asRecord,
    dedupeStrings,
    ensureContextSafeDetails,
  );
  if (!annotated.changed) return;
  await saveCanonicalState(stateDir, {
    ...latest,
    messages: annotated.messages,
    updatedAt: new Date().toISOString(),
  });
}

export async function ensureOpenClawCleanerTaskRegistry(params: {
  currentConfig: Record<string, unknown>;
  normalized: NormalizedPluginRuntimeConfig;
  sessionId: string;
  modelClient?: JsonModelClient;
  logger?: CleanerTaskRegistryBootstrapLogger;
  dependencies?: {
    detectUpstreamConfig?: typeof detectUpstreamConfig;
    createPolicyModule?: typeof createPolicyModule;
  };
}): Promise<SessionTaskRegistry> {
  const current = await loadSessionTaskRegistry(params.normalized.stateDir, params.sessionId);
  const state = await loadCanonicalState(params.normalized.stateDir, params.sessionId);
  if (!state || state.messages.length === 0) return current;

  try {
    const semantic = await syncRawSemanticTurnsFromMessages(
      params.normalized.stateDir,
      params.sessionId,
      state.messages,
      {
        contentToText,
        contextSafeRecovery: (details) => contextSafeRecovery(details, asRecord),
        memoryFaultRecoverToolName: MEMORY_FAULT_RECOVER_TOOL_NAME,
      },
    );
    if (semantic.turnCount === 0) return current;
    const pendingTurnCount = Math.max(0, semantic.turnCount - current.lastProcessedTurnSeq);
    if (pendingTurnCount === 0) {
      await persistTaskAnchors(params.normalized.stateDir, params.sessionId, current);
      return current;
    }

    const preferred = providerAndModel(params.currentConfig);
    const upstream: UpstreamConfig | null = params.modelClient
      ? null
      : await (params.dependencies?.detectUpstreamConfig ?? detectUpstreamConfig)(
          { warn: (message) => params.logger?.warn?.(message) },
          { preferredProviderId: preferred.providerId },
        );
    if (!params.modelClient && !upstream) {
      params.logger?.warn?.("[context-cleaner] task registry bootstrap skipped: provider unavailable");
      return current;
    }

    const model = upstream && preferred.providerId === upstream.providerId
      && preferred.modelId
      && upstream.models.some((candidate) => candidate.id === preferred.modelId)
      ? preferred.modelId
      : upstream?.models[0]?.id
        ?? preferred.modelId
        ?? params.normalized.taskStateEstimator.model
        ?? "host-default";
    if (!model) {
      params.logger?.warn?.("[context-cleaner] task registry bootstrap skipped: model unavailable");
      return current;
    }

    const estimatorConfig: NormalizedPluginRuntimeConfig = {
      ...params.normalized,
      taskStateEstimator: {
        ...params.normalized.taskStateEstimator,
        enabled: true,
        ...(upstream ? { baseUrl: upstream.baseUrl, apiKey: upstream.apiKey } : {}),
        model,
        // An explicit clean request should classify the complete imported
        // session in one bounded estimator call instead of waiting for the
        // normal rolling batch threshold.
        batchTurns: pendingTurnCount,
      },
    };
    const policy = (params.dependencies?.createPolicyModule ?? createPolicyModule)(
      buildPolicyModuleConfigFromPluginConfig(estimatorConfig, upstream),
      params.modelClient
        ? {
            createTaskStateEstimator: (config) => createApiTaskStateEstimator(
              config,
              () => params.modelClient!,
            ),
          }
        : undefined,
    );
    const context: RuntimeTurnContext = {
      sessionId: params.sessionId,
      sessionMode: "single",
      provider: upstream?.providerId ?? preferred.providerId ?? "openclaw",
      model,
      apiFamily: upstream?.apiFamily === "anthropic-messages"
        ? "anthropic-messages"
        : upstream?.apiFamily === "openai-completions"
          ? "openai-completions"
          : upstream?.apiFamily === "openai-responses"
            ? "openai-responses"
            : "other",
      prompt: "",
      segments: [],
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 16_384 },
    };
    await policy.beforeBuild?.(context, NO_MODEL_RUNTIME);
    const registry = await loadSessionTaskRegistry(params.normalized.stateDir, params.sessionId);
    await persistTaskAnchors(params.normalized.stateDir, params.sessionId, registry);
    return registry;
  } catch (error) {
    params.logger?.warn?.(
      `[context-cleaner] task registry bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return current;
  }
}
