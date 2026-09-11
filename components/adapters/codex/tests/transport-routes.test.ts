import assert from "node:assert/strict";
import test from "node:test";
import {
  codexResourceSuffix,
  codexUpstreamRequestPath,
  isCodexModelsPath,
  isCodexResponsesPath,
} from "../src/transport/routes.js";

test("Codex transport recognizes API and ChatGPT backend route aliases", () => {
  assert.equal(isCodexResponsesPath("/v1/responses"), true);
  assert.equal(isCodexResponsesPath("/backend-api/codex/responses"), true);
  assert.equal(isCodexModelsPath("/models"), true);
  assert.equal(isCodexModelsPath("/backend-api/codex/models"), true);
  assert.equal(isCodexResponsesPath("/v1/chat/completions"), false);
});

test("Codex transport maps resource paths without duplicating API prefixes", () => {
  assert.equal(codexResourceSuffix("/backend-api/codex/models?client_version=0.145.0"), "/models?client_version=0.145.0");
  assert.equal(codexUpstreamRequestPath("https://api.openai.com/v1", "/backend-api/codex/responses"), "/responses");
  assert.equal(codexUpstreamRequestPath("https://chatgpt.com/backend-api/codex", "/v1/models?x=1"), "/models?x=1");
  assert.equal(codexUpstreamRequestPath("https://custom.example", "/responses"), "/v1/responses");
});
