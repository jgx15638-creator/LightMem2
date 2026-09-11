import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { isCodexResponsesPath } from "./routes.js";

type UpgradeArgs = {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  pathname: string;
};

type WarmupState = {
  event: Record<string, unknown>;
  responseId: string;
};

const FORWARD_HEADER_NAMES = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "x-openai-client-version",
]);

function downstreamHeaders(req: IncomingMessage): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, rawValue] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (!FORWARD_HEADER_NAMES.has(lower)
      && !lower.startsWith("x-codex-")
      && !lower.startsWith("x-openai-")) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (typeof value === "string" && value) headers.set(name, value);
  }
  return headers;
}

function webSocketText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function withStreamId(payload: unknown, streamId: unknown): unknown {
  if (!streamId || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  return "stream_id" in record ? record : { ...record, stream_id: streamId };
}

function streamKey(streamId: unknown): string {
  return typeof streamId === "string" ? streamId : "";
}

function warmupResponse(event: Record<string, unknown>, responseId: string): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: event.instructions ?? "",
    model: event.model,
    output: [],
    parallel_tool_calls: event.parallel_tool_calls ?? true,
    previous_response_id: event.previous_response_id ?? null,
    reasoning: event.reasoning ?? null,
    store: event.store ?? false,
    tool_choice: event.tool_choice ?? "auto",
    tools: event.tools ?? [],
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
  };
}

function prepareWarmupEvent(event: Record<string, unknown>): WarmupState {
  const prepared = { ...event };
  delete prepared.type;
  delete prepared.stream_id;
  delete prepared.generate;
  delete prepared.background;
  delete prepared.stream;
  return {
    event: prepared,
    responseId: `resp_lightrsi_warmup_${randomUUID().replaceAll("-", "")}`,
  };
}

function mergeWarmupEvent(
  event: Record<string, unknown>,
  warmups: Map<string, WarmupState>,
): Record<string, unknown> {
  const previousResponseId = typeof event.previous_response_id === "string"
    ? event.previous_response_id
    : undefined;
  const warmup = previousResponseId ? warmups.get(previousResponseId) : undefined;
  if (!warmup) return event;
  warmups.delete(warmup.responseId);
  const warmupInput = Array.isArray(warmup.event.input) ? warmup.event.input : [];
  const nextInput = Array.isArray(event.input) ? event.input : [];
  const merged: Record<string, unknown> = {
    ...warmup.event,
    ...event,
    input: [...warmupInput, ...nextInput],
  };
  delete merged.previous_response_id;
  return merged;
}

function sendSseBlock(socket: WebSocket, block: string, streamId: unknown): void {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return;
  try {
    sendJson(socket, withStreamId(JSON.parse(data), streamId));
  } catch {
    sendJson(socket, {
      type: "error",
      code: "invalid_upstream_event",
      message: "The HTTP compatibility bridge received a malformed Responses stream event.",
      ...(streamId ? { stream_id: streamId } : {}),
    });
  }
}

async function forwardResponseCreate(params: {
  req: IncomingMessage;
  socket: WebSocket;
  localUrl: string;
  event: Record<string, unknown>;
  controller: AbortController;
}): Promise<void> {
  const streamId = params.event.stream_id;
  const payload = { ...params.event };
  delete payload.type;
  delete payload.stream_id;
  delete payload.generate;
  delete payload.background;
  payload.stream = true;

  const response = await fetch(params.localUrl, {
    method: "POST",
    headers: downstreamHeaders(params.req),
    body: JSON.stringify(payload),
    signal: params.controller.signal,
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    const text = await response.text();
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      result = {
        type: "error",
        code: "http_compatibility_error",
        message: text || `LightRSI HTTP compatibility bridge returned status ${response.status}.`,
      };
    }
    sendJson(params.socket, withStreamId(result, streamId));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const blocks = pending.split(/\r?\n\r?\n/u);
    pending = blocks.pop() ?? "";
    for (const block of blocks) sendSseBlock(params.socket, block, streamId);
    if (done) break;
  }
  if (pending.trim()) sendSseBlock(params.socket, pending, streamId);
}

export function createCodexWebSocketCompatibilityBridge(params: {
  port: number;
}): {
  handleUpgrade(args: UpgradeArgs): boolean;
  close(): Promise<void>;
} {
  const server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  const controllers = new Map<WebSocket, Set<AbortController>>();
  const warmups = new Map<WebSocket, Map<string, WarmupState>>();
  const queues = new Map<WebSocket, Map<string, Promise<void>>>();

  server.on("connection", (socket, req) => {
    clients.add(socket);
    controllers.set(socket, new Set());
    warmups.set(socket, new Map());
    queues.set(socket, new Map());
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        sendJson(socket, {
          type: "error",
          code: "binary_websocket_message_unsupported",
          message: "Codex Responses WebSocket messages must be UTF-8 JSON text.",
        });
        return;
      }
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(webSocketText(data)) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        event = parsed as Record<string, unknown>;
      } catch {
        sendJson(socket, {
          type: "error",
          code: "invalid_websocket_event",
          message: "Codex Responses WebSocket messages must be JSON objects.",
        });
        return;
      }
      if (event.type !== "response.create") {
        sendJson(socket, {
          type: "error",
          code: "unsupported_websocket_event",
          message: "LightRSI currently accepts response.create client events on the Responses WebSocket path.",
          ...(event.stream_id ? { stream_id: event.stream_id } : {}),
        });
        return;
      }
      const lane = streamKey(event.stream_id);
      const laneQueues = queues.get(socket)!;
      const prior = laneQueues.get(lane) ?? Promise.resolve();
      const next = prior.then(async () => {
        if (event.generate === false) {
          const warmup = prepareWarmupEvent(event);
          warmups.get(socket)?.set(warmup.responseId, warmup);
          const response = warmupResponse(event, warmup.responseId);
          sendJson(socket, withStreamId({ type: "response.created", response }, event.stream_id));
          sendJson(socket, withStreamId({ type: "response.completed", response }, event.stream_id));
          return;
        }
        const controller = new AbortController();
        controllers.get(socket)?.add(controller);
        const requestUrl = new URL(req.url ?? "/v1/responses", "http://127.0.0.1");
        const localUrl = `http://127.0.0.1:${params.port}${requestUrl.pathname}${requestUrl.search}`;
        try {
          await forwardResponseCreate({
            req,
            socket,
            localUrl,
            event: mergeWarmupEvent(event, warmups.get(socket)!),
            controller,
          });
        } finally {
          controllers.get(socket)?.delete(controller);
        }
      }).catch((error) => {
        sendJson(socket, {
          type: "error",
          code: "websocket_bridge_failed",
          message: error instanceof Error ? error.message : String(error),
          ...(event.stream_id ? { stream_id: event.stream_id } : {}),
        });
      }).finally(() => {
        if (laneQueues.get(lane) === next) laneQueues.delete(lane);
      });
      laneQueues.set(lane, next);
    });
    socket.once("close", () => {
      for (const controller of controllers.get(socket) ?? []) controller.abort();
      controllers.delete(socket);
      warmups.delete(socket);
      queues.delete(socket);
      clients.delete(socket);
    });
  });

  return {
    handleUpgrade({ req, socket, head, pathname }) {
      if (!isCodexResponsesPath(pathname)) return false;
      server.handleUpgrade(req, socket, head, (client) => {
        server.emit("connection", client, req);
      });
      return true;
    },
    async close() {
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
