import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  CODEX_MAX_ENCODED_REQUEST_BYTES,
  CodexRequestBodyError,
  decodeCodexRequestBody,
} from "../src/transport/request-body.js";

const payload = '{"model":"gpt-fixture"}';

test("Codex request decoder accepts identity, gzip, and zstd request bodies", async () => {
  assert.equal(await decodeCodexRequestBody(Buffer.from(payload), undefined), payload);
  assert.equal(await decodeCodexRequestBody(gzipSync(payload), "gzip"), payload);
  const zstdFixture = Buffer.from("KLUv/SAXuQAAeyJtb2RlbCI6ImdwdC1maXh0dXJlIn0=", "base64");
  assert.equal(await decodeCodexRequestBody(zstdFixture, "zstd"), payload);
});

test("Codex request decoder rejects unknown and malformed encodings safely", async () => {
  await assert.rejects(
    decodeCodexRequestBody(Buffer.from(payload), "compress"),
    (error: unknown) => error instanceof CodexRequestBodyError
      && error.statusCode === 415
      && error.code === "unsupported_content_encoding",
  );
  await assert.rejects(
    decodeCodexRequestBody(Buffer.from("not-zstd"), "zstd"),
    (error: unknown) => error instanceof CodexRequestBodyError
      && error.statusCode === 400
      && error.code === "invalid_compressed_request",
  );
});

test("Codex request decoder bounds encoded size and compression expansion", async () => {
  await assert.rejects(
    decodeCodexRequestBody(Buffer.alloc(CODEX_MAX_ENCODED_REQUEST_BYTES + 1), undefined),
    (error: unknown) => error instanceof CodexRequestBodyError
      && error.statusCode === 413
      && error.code === "encoded_request_too_large",
  );
  await assert.rejects(
    decodeCodexRequestBody(gzipSync("a".repeat(100_000)), "gzip"),
    (error: unknown) => error instanceof CodexRequestBodyError
      && error.statusCode === 413
      && error.code === "compression_ratio_too_large",
  );
});
