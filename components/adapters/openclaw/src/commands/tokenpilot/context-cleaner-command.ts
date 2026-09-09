import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  analyzeContextCleanSession,
  createApiContextCleanRecommendationProvider,
  createContextCleanerControlPlane,
  readContextCleanPlan,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerHostBridge,
} from "@lightrsi/cleaner";

import { createOpenClawContextCleanerBridge } from "../../context-cleaner/index.js";
import { normalizeConfig } from "../../context-stack/integration/config-normalize.js";
import { resolveSessionIdFromCommandScope } from "../../session/command-scope-map.js";
import { pluginConfigRecord } from "./host-config-adapter.js";

type OpenClawCleanBackend = {
  stateDir: string;
  analyze(sessionId: string): Promise<ContextCleanPlan>;
  readPlan(planId: string): Promise<ContextCleanPlan | undefined>;
  approve(planId: string, selectedTaskIds: string[]): Promise<ContextCleanReceipt>;
  readReceipt(planId: string): Promise<ContextCleanReceipt | undefined>;
  cancel(planId: string): Promise<ContextCleanReceipt>;
};

type ParsedCleanArgs = {
  sessionId?: string;
  planId?: string;
  selectedTaskIds?: string[];
  status: boolean;
  cancel: boolean;
  help: boolean;
};

export function formatOpenClawCleanUsage(): string {
  return [
    "Context Cleaner:",
    "  /lightrsi clean [--session <session-id>]",
    "  /lightrsi clean --plan <plan-id> --select <task-id[,task-id...>]",
    "  /lightrsi clean --status <plan-id>",
    "  /lightrsi clean --cancel <plan-id>",
    "The first command only analyzes. Cleaning requires an explicit task selection.",
  ].join("\n");
}

function parseCleanArgs(rawArgs: string): ParsedCleanArgs {
  const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  const parsed: ParsedCleanArgs = { status: false, cancel: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--session" || argument === "--plan" || argument === "--select") {
      const value = args[++index]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`clean_${argument.slice(2)}_missing`);
      if (argument === "--session") {
        if (parsed.sessionId) throw new Error("clean_session_duplicate");
        parsed.sessionId = value;
      } else if (argument === "--plan") {
        if (parsed.planId) throw new Error("clean_plan_duplicate");
        parsed.planId = value;
      } else {
        if (parsed.selectedTaskIds) throw new Error("clean_selection_duplicate_argument");
        parsed.selectedTaskIds = value.split(",").map((taskId) => taskId.trim()).filter(Boolean);
      }
      continue;
    }
    if (argument === "--status" || argument === "--cancel") {
      const field = argument === "--status" ? "status" : "cancel";
      if (parsed[field]) throw new Error(`clean_${field}_duplicate`);
      parsed[field] = true;
      const possiblePlanId = args[index + 1]?.trim();
      if (possiblePlanId && !possiblePlanId.startsWith("--")) {
        index += 1;
        if (parsed.planId && parsed.planId !== possiblePlanId) throw new Error("clean_plan_conflict");
        parsed.planId = possiblePlanId;
      }
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`clean_argument_unknown:${argument}`);
  }

  if (parsed.help && args.length > 1) throw new Error("clean_help_conflict");
  const actions = Number(parsed.selectedTaskIds !== undefined) + Number(parsed.status) + Number(parsed.cancel);
  if (actions > 1) throw new Error("clean_action_conflict");
  if (actions > 0 && !parsed.planId) throw new Error("clean_plan_missing");
  if (parsed.planId && actions === 0) throw new Error("clean_action_missing");
  if (parsed.planId && parsed.sessionId) throw new Error("clean_session_plan_conflict");
  return parsed;
}

function count(tokens: number | null, chars: number): string {
  return tokens === null ? `${chars} chars` : `${tokens} tok`;
}

function renderPlan(plan: ContextCleanPlan): string {
  const lines = [
    `Context clean plan: ${plan.planId}`,
    `Host/session: ${plan.hostId} / ${plan.sessionId}`,
    `Context usage: ${count(plan.usedTokens, plan.usedChars)} (${plan.tokenCountMode})`,
    "",
    "Selectable tasks:",
  ];
  if (plan.tasks.length === 0) lines.push("- (none)");
  for (const task of plan.tasks) {
    const marker = task.selectable ? "[ ]" : "[-]";
    const reasons = task.reasonCodes.length > 0 ? `; ${task.reasonCodes.join(", ")}` : "";
    lines.push(
      `- ${marker} ${task.taskId} | ${task.lifecycleState} | ${count(task.tokenCount, task.charCount)} | ${task.recommendation}${reasons}`,
      `  ${task.description || task.label}`,
    );
  }
  lines.push(
    "",
    `No changes applied. To clean selected tasks: /lightrsi clean --plan ${plan.planId} --select <task-id[,task-id...]>`,
  );
  return lines.join("\n");
}

function renderReceipt(receipt: ContextCleanReceipt): string {
  const lines = [
    `Context clean ${receipt.status}: ${receipt.planId}`,
    `Selected tasks: ${receipt.selectedTaskIds.length > 0 ? receipt.selectedTaskIds.join(", ") : "(none)"}`,
    `Estimated savings: ${count(receipt.estimatedSavedTokens, receipt.estimatedSavedChars)}`,
  ];
  if (receipt.status === "applied") {
    lines.push(`Released: ${count(receipt.appliedSavedTokens, receipt.appliedSavedChars)}`);
  } else if (receipt.status === "scheduled") {
    lines.push("Apply timing: next Host request.");
  }
  if (receipt.deferredTaskIds.length > 0) lines.push(`Deferred tasks: ${receipt.deferredTaskIds.join(", ")}`);
  if (receipt.reasons.length > 0) lines.push(`Reasons: ${receipt.reasons.join(", ")}`);
  if (receipt.fallbackUsed) lines.push("Recommendation fallback: used");
  return lines.join("\n");
}

function storeFailure(operation: string, reasons: string[]): never {
  throw new Error(`${operation}:${reasons.join(",") || "unknown"}`);
}

export function createOpenClawCleanBackend(currentConfig: Record<string, unknown>): OpenClawCleanBackend {
  const normalized = normalizeConfig(pluginConfigRecord(currentConfig));
  const stateDir = normalized.stateDir.trim();
  if (!stateDir) throw new Error("clean_state_dir_missing");
  const controlPlane = createContextCleanerControlPlane({ stateDir });
  const bridge: ContextCleanerHostBridge = createOpenClawContextCleanerBridge({
    stateDir,
    controlPlane,
    config: { replacementMode: normalized.eviction.replacementMode },
  });
  const provider = normalized.taskStateEstimator.enabled
    ? createApiContextCleanRecommendationProvider({
        baseUrl: normalized.taskStateEstimator.baseUrl,
        apiKey: normalized.taskStateEstimator.apiKey,
        model: normalized.taskStateEstimator.model,
        requestTimeoutMs: normalized.taskStateEstimator.requestTimeoutMs,
      })
    : undefined;

  async function readPlan(planId: string): Promise<ContextCleanPlan | undefined> {
    const result = await readContextCleanPlan({ stateDir, planId });
    if (result.bypassed) storeFailure("clean_plan_unavailable", result.reasons);
    return result.value?.plan;
  }

  return {
    stateDir,
    async analyze(sessionId) {
      return (await analyzeContextCleanSession({ stateDir, bridge, sessionId, provider })).plan;
    },
    readPlan,
    async approve(planId, selectedTaskIds) {
      if (selectedTaskIds.length === 0) throw new Error("clean_selection_empty");
      if (new Set(selectedTaskIds).size !== selectedTaskIds.length) {
        throw new Error("clean_selection_duplicate_task");
      }
      const plan = await readPlan(planId);
      if (!plan) throw new Error(`clean_plan_missing:${planId}`);
      const tasksById = new Map(plan.tasks.map((task) => [task.taskId, task]));
      const selectedTasks = selectedTaskIds.map((taskId) => {
        const task = tasksById.get(taskId);
        if (!task) throw new Error(`clean_selection_unknown_task:${taskId}`);
        if (!task.selectable) throw new Error(`clean_selection_task_protected:${taskId}`);
        return { taskId, itemIds: [...task.itemIds], itemDigests: { ...task.itemDigests } };
      });
      return bridge.executeApprovedClean({
        schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
        cleanPlanId: plan.planId,
        hostId: plan.hostId,
        sessionId: plan.sessionId,
        baseRevision: plan.baseRevision,
        approvedAt: new Date().toISOString(),
        selectedTasks,
      });
    },
    readReceipt: (planId) => bridge.readCleanReceipt(planId),
    cancel: (planId) => bridge.cancelCleanPlan(planId),
  };
}

function directSessionId(ctx: any): string | undefined {
  const candidates = [ctx?.sessionId, ctx?.session_id, ctx?.ctx?.SessionId, ctx?.ctx?.sessionId];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value && !value.startsWith("agent:")) return value;
  }
  return undefined;
}

export async function handleOpenClawContextCleanCommand(params: {
  ctx: any;
  rawArgs: string;
  backend: OpenClawCleanBackend;
}): Promise<{ text: string }> {
  const parsed = parseCleanArgs(params.rawArgs);
  if (parsed.help) return { text: formatOpenClawCleanUsage() };
  if (parsed.planId) {
    if (parsed.status) {
      const receipt = await params.backend.readReceipt(parsed.planId);
      return { text: receipt ? renderReceipt(receipt) : `Context clean receipt not found: ${parsed.planId}` };
    }
    if (parsed.cancel) return { text: renderReceipt(await params.backend.cancel(parsed.planId)) };
    return { text: renderReceipt(await params.backend.approve(parsed.planId, parsed.selectedTaskIds!)) };
  }

  const sessionId = parsed.sessionId
    ?? resolveSessionIdFromCommandScope(params.backend.stateDir, params.ctx, params.ctx?.commandBody)
    ?? directSessionId(params.ctx);
  if (!sessionId) throw new Error("clean_session_missing; use --session <session-id>");
  return { text: renderPlan(await params.backend.analyze(sessionId)) };
}

export function createOpenClawContextCleanerCommandHandler(params: {
  loadConfig(): Promise<Record<string, unknown>> | Record<string, unknown>;
  createBackend?: (currentConfig: Record<string, unknown>) => OpenClawCleanBackend;
}) {
  return async (ctx: any, rawArgs: string): Promise<{ text: string }> => {
    if (["--help", "-h"].includes(rawArgs.trim())) {
      return { text: formatOpenClawCleanUsage() };
    }
    try {
      const backend = (params.createBackend ?? createOpenClawCleanBackend)(await params.loadConfig());
      return await handleOpenClawContextCleanCommand({ ctx, rawArgs, backend });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: `Context clean error: ${message}\n\n${formatOpenClawCleanUsage()}` };
    }
  };
}
