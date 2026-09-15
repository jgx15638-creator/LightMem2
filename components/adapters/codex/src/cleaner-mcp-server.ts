import { LIGHTRSI_VERSION } from "@lightrsi/kernel";
import { serveStdioMcpServer } from "@lightrsi/mcp";

import {
  CODEX_CLEANER_MCP_SERVER_NAME,
  createCodexCleanerMcpTool,
  createCodexContextCleanerControlService,
} from "./context-cleaner/index.js";

async function main(): Promise<void> {
  const control = await createCodexContextCleanerControlService();
  await serveStdioMcpServer({
    serverInfo: {
      name: CODEX_CLEANER_MCP_SERVER_NAME,
      version: LIGHTRSI_VERSION,
    },
    tools: [createCodexCleanerMcpTool({
      service: control.service,
      resolveSessionId: control.resolveSessionId,
    })],
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
