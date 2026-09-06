import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  closeHttpServer,
  listenHttpServer,
  readHttpRequestBodyBuffer,
  sendJsonResponse,
} from "./http-server.js";

export type HostGatewayRuntimeServer = {
  baseUrl: string;
  close(): Promise<void>;
};

export async function startHostGatewayRuntimeServer(params: {
  port: number;
  requestPath: string;
  requestPaths?: readonly string[];
  maxRequestBodyBytes?: number;
  basePath?: string;
  healthPayload: unknown;
  decodeRequestBody?(args: {
    req: IncomingMessage;
    body: Buffer;
  }): string | Promise<string>;
  handleRoute?(args: {
    req: IncomingMessage;
    res: ServerResponse;
    pathname: string;
    readBody(signal?: AbortSignal): Promise<string>;
    readBodyBuffer(signal?: AbortSignal): Promise<Buffer>;
  }): Promise<boolean | void>;
  handleUpgrade?(args: {
    req: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    pathname: string;
  }): Promise<boolean | void> | boolean | void;
  handleRequest(args: {
    req: IncomingMessage;
    res: ServerResponse;
    pathname: string;
    body: string;
  }): Promise<void>;
  handleError?(args: {
    error: unknown;
    req: IncomingMessage;
    res: ServerResponse;
  }): Promise<void>;
}): Promise<HostGatewayRuntimeServer> {
  const basePath = params.basePath ?? "/v1";
  const requestPaths = new Set(params.requestPaths ?? [params.requestPath]);
  const server = createServer(async (req, res) => {
    try {
      let bodyBufferPromise: Promise<Buffer> | null = null;
      let bodyPromise: Promise<string> | null = null;
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const readBodyBuffer = (signal?: AbortSignal) => {
        bodyBufferPromise ??= readHttpRequestBodyBuffer(req, {
          signal,
          maxBytes: params.maxRequestBodyBytes,
        });
        return bodyBufferPromise;
      };
      const readBody = (signal?: AbortSignal) => {
        bodyPromise ??= readBodyBuffer(signal).then((body) => params.decodeRequestBody
          ? params.decodeRequestBody({ req, body })
          : body.toString("utf8"));
        return bodyPromise;
      };
      if (req.method === "GET" && pathname === "/health") {
        sendJsonResponse(res, 200, params.healthPayload);
        return;
      }
      if (params.handleRoute) {
        const handled = await params.handleRoute({
          req,
          res,
          pathname,
          readBody,
          readBodyBuffer,
        });
        if (handled) return;
      }
      if (req.method !== "POST" || !requestPaths.has(pathname)) {
        sendJsonResponse(res, 404, { error: "not found" });
        return;
      }
      const body = await readBody();
      await params.handleRequest({
        req,
        res,
        pathname,
        body,
      });
    } catch (error) {
      if (params.handleError) {
        await params.handleError({ error, req, res });
        return;
      }
      sendJsonResponse(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (params.handleUpgrade) {
    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      Promise.resolve(params.handleUpgrade!({ req, socket, head, pathname }))
        .then((handled) => {
          if (!handled && !socket.destroyed) socket.destroy();
        })
        .catch(() => {
          if (!socket.destroyed) socket.destroy();
        });
    });
  }

  await listenHttpServer(server, params.port);

  return {
    baseUrl: `http://127.0.0.1:${params.port}${basePath}`,
    close() {
      return closeHttpServer(server);
    },
  };
}
