import assert from "node:assert/strict";
import test from "node:test";
import { codexAuthErrorPayload, resolveCodexAuthContext } from "../src/transport/auth-context.js";

const upstream = {
  baseUrl: "https://api.openai.com/v1",
  wireApi: "responses" as const,
  requiresOpenAIAuth: true,
};

test("Codex auth classifies a complete managed ChatGPT credential pair", () => {
  assert.deepEqual(resolveCodexAuthContext({
    upstream,
    upstreamProvider: "openai",
    inboundHeaders: {
      authorization: "Bearer oauth-fixture",
      "ChatGPT-Account-ID": "account-fixture",
    },
  }), {
    kind: "chatgpt_oauth",
    authorization: "Bearer oauth-fixture",
    chatGptAccountId: "account-fixture",
  });
});

test("Codex auth fails locally when managed ChatGPT headers are incomplete", () => {
  const context = resolveCodexAuthContext({
    upstream,
    upstreamProvider: "openai",
    inboundHeaders: { "chatgpt-account-id": "account-fixture" },
  });
  assert.equal(context.kind, "missing");
  assert.equal(context.errorCode, "chatgpt_oauth_incomplete");
  assert.equal(codexAuthErrorPayload(context)?.error.code, "chatgpt_oauth_incomplete");
});

test("Codex auth keeps API-key and custom-provider paths distinct", () => {
  assert.equal(resolveCodexAuthContext({
    upstream,
    upstreamProvider: "openai",
    inboundHeaders: { authorization: "Bearer opaque-api-key-fixture" },
  }).kind, "api_key");
  assert.equal(resolveCodexAuthContext({
    upstream: { ...upstream, requiresOpenAIAuth: false },
    upstreamProvider: "custom",
    inboundHeaders: {},
  }).kind, "custom");
  assert.equal(resolveCodexAuthContext({
    upstream,
    upstreamProvider: "OpenAI",
    inboundHeaders: {},
  }).kind, "custom");
});

test("Codex auth remediation names only the supported user-level base URL override", () => {
  const message = codexAuthErrorPayload({
    kind: "missing",
    errorCode: "chatgpt_oauth_incomplete",
  })?.error.message;
  assert.match(message ?? "", /openai_base_url/);
  assert.doesNotMatch(message ?? "", /chatgpt_base_url/);
});
