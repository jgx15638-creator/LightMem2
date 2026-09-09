import { createProductSurfaceCommandHandler, parseCommandAction } from "@lightrsi/product-surface";
import { TOKENPILOT_PRODUCT_SURFACE_IDENTITY } from "@lightrsi/tokenpilot";
import { openClawProductSurfaceConfigAdapter } from "./tokenpilot/host-config-adapter.js";
import { createOpenClawProductSurfaceBridge } from "./tokenpilot/openclaw-command-bridge.js";
import {
  createOpenClawContextCleanerCommandHandler,
  formatOpenClawCleanUsage,
} from "./tokenpilot/context-cleaner-command.js";

export function registerTokenPilotCommand(api: any, logger: { debug?: (...args: unknown[]) => void }): void {
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
    loadConfig: bridge.loadConfig,
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
