import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { isFetchSafeTestPort, reserveUnusedPort } from "../src/testing/host-e2e.js";
import { startHostGatewayRuntimeServer } from "../src/gateway/runtime-server.js";
import { HttpRequestBodyLimitError } from "../src/gateway/http-server.js";

test("test port reservation excludes ports blocked by Fetch", async () => {
  assert.equal(isFetchSafeTestPort(6_000), false);
  assert.equal(isFetchSafeTestPort(6_667), false);
  assert.equal(isFetchSafeTestPort(10_080), false);
  assert.equal(isFetchSafeTestPort(17_668), true);
  assert.equal(isFetchSafeTestPort(await reserveUnusedPort()), true);
});

test("runtime server accepts request aliases and exposes the original body buffer to a decoder", async () => {
  const port = await reserveUnusedPort();
  const seen: Array<{ pathname: string; body: string }> = [];
  const runtime = await startHostGatewayRuntimeServer({
    port,
    requestPath: "/v1/responses",
    requestPaths: ["/v1/responses", "/backend-api/codex/responses"],
    healthPayload: { ok: true },
    decodeRequestBody({ body }) {
      return body.subarray(1).toString("utf8");
    },
    async handleRequest({ pathname, body, res }) {
      seen.push({ pathname, body });
      res.statusCode = 204;
      res.end();
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
      method: "POST",
      body: Buffer.from("!decoded"),
    });
    assert.equal(response.status, 204);
    assert.deepEqual(seen, [{ pathname: "/backend-api/codex/responses", body: "decoded" }]);
  } finally {
    await runtime.close();
  }
});

test("runtime server delegates websocket upgrades without treating them as HTTP routes", async () => {
  const port = await reserveUnusedPort();
  let upgradedPath = "";
  const runtime = await startHostGatewayRuntimeServer({
    port,
    requestPath: "/v1/responses",
    healthPayload: { ok: true },
    async handleRequest({ res }) {
      res.statusCode = 204;
      res.end();
    },
    handleUpgrade({ socket, pathname }) {
      upgradedPath = pathname;
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
      return true;
    },
  });
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/v1/responses",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
        },
      });
      req.once("response", (response) => resolve(response.statusCode));
      req.once("upgrade", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(status, 426);
    assert.equal(upgradedPath, "/v1/responses");
  } finally {
    await runtime.close();
  }
});

test("runtime server rejects request bodies while reading once the configured limit is exceeded", async () => {
  const port = await reserveUnusedPort();
  let handledRequest = false;
  const runtime = await startHostGatewayRuntimeServer({
    port,
    requestPath: "/v1/responses",
    maxRequestBodyBytes: 8,
    healthPayload: { ok: true },
    async handleRequest({ res }) {
      handledRequest = true;
      res.statusCode = 204;
      res.end();
    },
    async handleError({ error, res }) {
      assert.equal(error instanceof HttpRequestBodyLimitError, true);
      res.statusCode = 413;
      res.end("too large");
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      body: "123456789",
    });
    assert.equal(response.status, 413);
    assert.equal(await response.text(), "too large");
    assert.equal(handledRequest, false);
  } finally {
    await runtime.close();
  }
});
