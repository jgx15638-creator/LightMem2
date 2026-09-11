import { createProductSurfaceCommandHandler, parseCommandAction } from "@lightrsi/product-surface";
import { TOKENPILOT_PRODUCT_SURFACE_IDENTITY } from "@lightrsi/tokenpilot";
import type { JsonModelClient } from "@lightrsi/runtime-core";
import { openClawProductSurfaceConfigAdapter } from "./tokenpilot/host-config-adapter.js";
import { createOpenClawProductSurfaceBridge } from "./tokenpilot/openclaw-command-bridge.js";
import {
  createOpenClawContextCleanerCommandHandler,
  formatOpenClawCleanUsage,
  loadOpenClawContextCleanerConfig,
} from "./tokenpilot/context-cleaner-command.js";

function cleanerAgentId(ctx: any): string {
  const candidates = [ctx?.agentId, ctx?.agent_id, ctx?.ctx?.AgentId, ctx?.ctx?.agentId];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() ?? "main";
}

function createOpenClawCleanerModelClient(api: any, ctx: any): JsonModelClient | undefined {
  const subagent = api?.runtime?.subagent;
  if (typeof subagent?.complete !== "function") return undefined;
  return {
    async request(input) {
      const result = await subagent.complete.call(subagent, {
        agentId: cleanerAgentId(ctx),
        message: input.userPayload,
        extraSystemPrompt: input.systemPrompt,
        timeoutMs: 60_000,
      });
      return { text: String(result?.text ?? "") };
    },
  };
}

export function registerTokenPilotCommand(
  api: any,
  logger: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void },
): void {
  if (typeof api.registerCommand !== "function") {
    logger.debug?.("[plugin-runtime] registerCommand unavailable; /tokenpilot not registered.");
    return;
  }

  const bridge = createOpenClawProductSurfaceBridge(api);
  const sharedHandler = createProductSurfaceCommandHandler({
    bridge,
    configAdapter: openClawProductSurfaceConfigAdapter,
    identity: TOKENPILOT_PRODUCT_SURFACE_IDENTITY,
  });
  const cleanHandler = createOpenClawContextCleanerCommandHandler({
    loadConfig: () => loadOpenClawContextCleanerConfig(api),
    logger: { warn: (message) => logger.warn?.(message) },
    createModelClient: (ctx) => createOpenClawCleanerModelClient(api, ctx),
  });

  for (const alias of TOKENPILOT_PRODUCT_SURFACE_IDENTITY.aliases) {
    api.registerCommand({
      name: alias.name,
      description: alias.description,
      acceptsArgs: true,
      async handler(ctx: any) {
        const rawArgs = typeof ctx?.args === "string" ? ctx.args : "";
        const { action, rest } = parseCommandAction(rawArgs);
        if (action === "clean") return cleanHandler(ctx, rest);
        const result = await sharedHandler(ctx);
        if (!action || action === "help") {
          return { ...result, text: `${result.text}\n\n${formatOpenClawCleanUsage()}` };
        }
        return result;
      },
    });
  }
  logger.debug?.("[plugin-runtime] Registered /tokenpilot, /lightrsi, and /tp commands.");
}
