import { type IncomingMessage, type Server, type ServerResponse } from "node:http";

export class HttpRequestBodyLimitError extends Error {
  readonly statusCode = 413;
  readonly code = "request_body_too_large";

  constructor(readonly maxBytes: number) {
    super(`HTTP request body exceeds the ${maxBytes} byte limit.`);
    this.name = "HttpRequestBodyLimitError";
  }
}

export type HttpRequestBodyReadOptions = {
  signal?: AbortSignal;
  maxBytes?: number;
};

function normalizeReadOptions(
  options?: AbortSignal | HttpRequestBodyReadOptions,
): HttpRequestBodyReadOptions {
  return options && "aborted" in options ? { signal: options } : options ?? {};
}

export async function readHttpRequestBodyBuffer(
  req: IncomingMessage,
  options?: AbortSignal | HttpRequestBodyReadOptions,
): Promise<Buffer> {
  const { signal, maxBytes } = normalizeReadOptions(options);
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  const contentLength = Number(req.headers["content-length"]);
  if (maxBytes !== undefined
    && Number.isFinite(contentLength)
    && contentLength > maxBytes) {
    throw new HttpRequestBodyLimitError(maxBytes);
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const read = (async () => {
    for await (const chunk of req) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.byteLength;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        throw new HttpRequestBodyLimitError(maxBytes);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  })();
  if (!signal) return read;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([read, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function readHttpRequestBody(
  req: IncomingMessage,
  options?: AbortSignal | HttpRequestBodyReadOptions,
): Promise<string> {
  return (await readHttpRequestBodyBuffer(req, options)).toString("utf8");
}

export function sendJsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function setForwardResponseHeaders(
  res: ServerResponse,
  headers: Record<string, string>,
  fallbackContentType: string,
): void {
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if ([
      "connection",
      "content-length",
      "content-encoding",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ].includes(lower)) continue;
    if (typeof value === "string" && value) res.setHeader(key, value);
  }
  if (!res.hasHeader("content-type")) res.setHeader("content-type", fallbackContentType);
}

export async function listenHttpServer(server: Server, port: number, host = "127.0.0.1"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
