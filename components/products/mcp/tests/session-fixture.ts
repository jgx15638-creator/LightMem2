import {
  serveStdioMcpServer,
  type McpToolHandler,
} from "../src/index.js";

const selectionProbe: McpToolHandler = {
  definition: {
    name: "selection_probe",
    description: "Exercise one server-originated form elicitation request.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  async call(_args, peer) {
    const elicitation = await peer.request<{
      action?: string;
      content?: Record<string, unknown>;
    }>("elicitation/create", {
      mode: "form",
      message: "Choose completed tasks",
      requestedSchema: {
        type: "object",
        properties: {
          task_1: {
            type: "boolean",
            title: "Task A",
            default: false,
          },
        },
        required: ["task_1"],
      },
    });
    return {
      content: [{
        type: "text",
        text: `Selection: ${String(elicitation.content?.task_1 === true)}`,
      }],
      structuredContent: {
        action: elicitation.action,
        selected: elicitation.content?.task_1 === true,
        clientCapabilities: peer.clientCapabilities,
      },
      isError: false,
    };
  },
};

serveStdioMcpServer({
  serverInfo: {
    name: "lightrsi-mcp-session-fixture",
    version: "0.1.0",
  },
  tools: [selectionProbe],
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
