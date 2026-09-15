import { stdin, stdout } from "node:process";

import {
  encodeMcpMessage,
  type TokenPilotMcpWireProtocol,
} from "./wire.js";

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type McpClientCapabilities = Readonly<Record<string, unknown>>;

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type McpToolResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface McpServerPeer {
  readonly clientCapabilities: McpClientCapabilities;
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export interface McpToolHandler {
  readonly definition: McpToolDefinition;
  call(
    args: Record<string, unknown>,
    peer: McpServerPeer,
  ): Promise<McpToolResult> | McpToolResult;
}

type ParsedMessage = {
  message: JsonRpcMessage;
  protocol: TokenPilotMcpWireProtocol;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

function parseHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of raw.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.set(
      line.slice(0, index).trim().toLowerCase(),
      line.slice(index + 1).trim(),
    );
  }
  return headers;
}

function decodeMessages(
  initialBuffer: Buffer,
): { messages: ParsedMessage[]; remainder: Buffer; parseErrors: TokenPilotMcpWireProtocol[] } {
  let buffer = initialBuffer;
  const messages: ParsedMessage[] = [];
  const parseErrors: TokenPilotMcpWireProtocol[] = [];

  for (;;) {
    let body: string | undefined;
    let protocol: TokenPilotMcpWireProtocol;
    const boundary = buffer.indexOf("\r\n\r\n");
    const newlineIndex = buffer.indexOf("\n");

    if (boundary >= 0 && (newlineIndex < 0 || boundary < newlineIndex)) {
      protocol = "content_length";
      const headers = parseHeaders(buffer.slice(0, boundary).toString("utf8"));
      const contentLength = Number(headers.get("content-length") ?? "");
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        parseErrors.push(protocol);
        buffer = Buffer.alloc(0);
        break;
      }
      const bodyStart = boundary + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) break;
      body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.slice(bodyEnd);
    } else if (newlineIndex >= 0) {
      protocol = "newline_json";
      body = buffer.slice(0, newlineIndex).toString("utf8").trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!body) continue;
    } else {
      break;
    }

    try {
      messages.push({
        message: JSON.parse(body) as JsonRpcMessage,
        protocol,
      });
    } catch {
      parseErrors.push(protocol);
    }
  }

  return { messages, remainder: buffer, parseErrors };
}

function messageError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serveStdioMcpServer(params: {
  serverInfo: { name: string; version: string };
  tools: readonly McpToolHandler[];
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const input = params.input ?? stdin;
  const output = params.output ?? stdout;
  const toolsByName = new Map(params.tools.map((tool) => [tool.definition.name, tool]));
  const pending = new Map<number, PendingRequest>();
  let buffer: Buffer = Buffer.alloc(0);
  let preferredProtocol: TokenPilotMcpWireProtocol = "newline_json";
  let nextServerRequestId = 1_000_000;
  let clientCapabilities: McpClientCapabilities = {};

  function write(message: JsonRpcMessage, protocol = preferredProtocol): void {
    output.write(encodeMcpMessage(message, protocol));
  }

  function rejectPending(reason: string): void {
    for (const request of pending.values()) request.reject(new Error(reason));
    pending.clear();
  }

  const peer: McpServerPeer = {
    get clientCapabilities() {
      return clientCapabilities;
    },
    request<T>(method: string, requestParams: Record<string, unknown>): Promise<T> {
      const requestId = nextServerRequestId;
      nextServerRequestId += 1;
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, {
          resolve(value) { resolve(value as T); },
          reject,
        });
        write({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params: requestParams,
        });
      });
    },
  };

  async function handleRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id ?? null;
    const method = typeof message.method === "string" ? message.method : "";

    if (!method) {
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message || "MCP client request failed"));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (id === null) return;

    if (method === "initialize") {
      const capabilities = message.params?.capabilities;
      clientCapabilities = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
        ? { ...capabilities as Record<string, unknown> }
        : {};
      const requestedVersion = typeof message.params?.protocolVersion === "string"
        ? message.params.protocolVersion
        : "2024-11-05";
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: { tools: {} },
          serverInfo: params.serverInfo,
        },
      });
      return;
    }

    if (method === "ping") {
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      write({
        jsonrpc: "2.0",
        id,
        result: { tools: params.tools.map((tool) => tool.definition) },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = typeof message.params?.name === "string" ? message.params.name : "";
      const tool = toolsByName.get(toolName);
      if (!tool) {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName || "(missing)"}` },
        });
        return;
      }
      const args = message.params?.arguments
        && typeof message.params.arguments === "object"
        && !Array.isArray(message.params.arguments)
        ? message.params.arguments as Record<string, unknown>
        : {};
      try {
        const result = await tool.call(args, peer);
        write({ jsonrpc: "2.0", id, result });
      } catch (error) {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: messageError(error) },
        });
      }
      return;
    }

    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  return new Promise<void>((resolve, reject) => {
    input.on("data", (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const decoded = decodeMessages(buffer);
      buffer = decoded.remainder;
      for (const protocol of decoded.parseErrors) {
        preferredProtocol = protocol;
        write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }, protocol);
      }
      for (const parsed of decoded.messages) {
        preferredProtocol = parsed.protocol;
        void handleRequest(parsed.message).catch((error) => {
          const id = parsed.message.id ?? null;
          if (id !== null) {
            write({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: messageError(error) },
            }, parsed.protocol);
          }
        });
      }
    });
    input.once("end", () => {
      rejectPending("MCP client input closed");
      resolve();
    });
    input.once("error", (error) => {
      rejectPending(`MCP client input failed: ${messageError(error)}`);
      reject(error);
    });
  });
}
