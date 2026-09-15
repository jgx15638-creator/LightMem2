import assert from "node:assert/strict";
import test from "node:test";

import { codexWebSocketFallbackEvent } from "../src/transport/websocket-bridge.js";

test("Codex WebSocket fallback turns a provider JSON detail into a terminal error event", () => {
  assert.deepEqual(codexWebSocketFallbackEvent({
    status: 400,
    text: JSON.stringify({ detail: "Unsupported parameter: previous_response_id" }),
  }), {
    type: "error",
    code: "http_compatibility_error",
    message: "Unsupported parameter: previous_response_id",
    status: 400,
  });
});

test("Codex WebSocket fallback preserves a valid Responses event", () => {
  const event = {
    type: "response.failed",
    response: { id: "resp-failed", status: "failed" },
  };
  assert.deepEqual(codexWebSocketFallbackEvent({
    status: 400,
    text: JSON.stringify(event),
  }), event);
});
