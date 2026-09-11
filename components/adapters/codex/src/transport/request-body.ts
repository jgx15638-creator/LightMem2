import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { Decompress as ZstdDecompress } from "fzstd";

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const nativeZstdDecompress = (zlib as typeof zlib & {
  zstdDecompress?: typeof zlib.gunzip;
}).zstdDecompress;
const nativeZstdDecompressAsync = nativeZstdDecompress
  ? promisify(nativeZstdDecompress)
  : undefined;

export const CODEX_MAX_ENCODED_REQUEST_BYTES = 16 * 1024 * 1024;
export const CODEX_MAX_DECODED_REQUEST_BYTES = 64 * 1024 * 1024;
export const CODEX_MAX_COMPRESSION_RATIO = 200;

export class CodexRequestBodyError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "CodexRequestBodyError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizedEncodings(contentEncoding: string | string[] | undefined): string[] {
  const joined = Array.isArray(contentEncoding) ? contentEncoding.join(",") : contentEncoding ?? "";
  return joined
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "identity");
}

function enforceDecodedLimits(encodedBytes: number, decoded: Buffer): void {
  if (decoded.byteLength > CODEX_MAX_DECODED_REQUEST_BYTES) {
    throw new CodexRequestBodyError(413, "decoded_request_too_large", "Decoded Codex request body exceeds the 64 MiB limit.");
  }
  const denominator = Math.max(1, encodedBytes);
  if (decoded.byteLength / denominator > CODEX_MAX_COMPRESSION_RATIO) {
    throw new CodexRequestBodyError(413, "compression_ratio_too_large", "Codex request compression ratio exceeds the safe limit.");
  }
}

function maximumDecodedBytes(encodedBytes: number): number {
  return Math.min(
    CODEX_MAX_DECODED_REQUEST_BYTES,
    Math.max(1, encodedBytes) * CODEX_MAX_COMPRESSION_RATIO,
  );
}

function outputLimitError(encodedBytes: number): CodexRequestBodyError {
  return maximumDecodedBytes(encodedBytes) < CODEX_MAX_DECODED_REQUEST_BYTES
    ? new CodexRequestBodyError(413, "compression_ratio_too_large", "Codex request compression ratio exceeds the safe limit.")
    : new CodexRequestBodyError(413, "decoded_request_too_large", "Decoded Codex request body exceeds the 64 MiB limit.");
}

async function decompressZstdBounded(
  input: Buffer,
  maxOutputLength: number,
): Promise<Buffer> {
  if (nativeZstdDecompressAsync) {
    return nativeZstdDecompressAsync(input, { maxOutputLength });
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const decoder = new ZstdDecompress((chunk) => {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxOutputLength) throw outputLimitError(input.byteLength);
    chunks.push(Buffer.from(chunk));
  });
  decoder.push(input, true);
  return Buffer.concat(chunks, totalBytes);
}

export async function decodeCodexRequestBody(
  body: Buffer,
  contentEncoding: string | string[] | undefined,
): Promise<string> {
  if (body.byteLength > CODEX_MAX_ENCODED_REQUEST_BYTES) {
    throw new CodexRequestBodyError(413, "encoded_request_too_large", "Encoded Codex request body exceeds the 16 MiB limit.");
  }
  let decoded = body;
  const maxOutputLength = maximumDecodedBytes(body.byteLength);
  try {
    const encodings = normalizedEncodings(contentEncoding);
    if (encodings.length > 2) {
      throw new CodexRequestBodyError(415, "too_many_content_encodings", "At most two nested request content encodings are supported.");
    }
    for (const encoding of encodings.reverse()) {
      if (encoding === "gzip" || encoding === "x-gzip") {
        decoded = await gunzipAsync(decoded, { maxOutputLength });
      } else if (encoding === "deflate") {
        decoded = await inflateAsync(decoded, { maxOutputLength });
      } else if (encoding === "br") {
        decoded = await brotliDecompressAsync(decoded, { maxOutputLength });
      } else if (encoding === "zstd") {
        decoded = await decompressZstdBounded(decoded, maxOutputLength);
      } else {
        throw new CodexRequestBodyError(415, "unsupported_content_encoding", `Unsupported Codex request content encoding: ${encoding}`);
      }
      enforceDecodedLimits(body.byteLength, decoded);
    }
  } catch (error) {
    if (error instanceof CodexRequestBodyError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw outputLimitError(body.byteLength);
    }
    throw new CodexRequestBodyError(400, "invalid_compressed_request", "Codex request body could not be decompressed safely.");
  }
  enforceDecodedLimits(body.byteLength, decoded);
  return decoded.toString("utf8");
}
