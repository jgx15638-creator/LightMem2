import assert from "node:assert/strict";
import test from "node:test";
import { prepareBeforeCall } from "@lightrsi/host-adapter";
import { canonicalizeEnvelopeTools } from "@lightrsi/stabilizer";
import {
  createClaudeMessagesPayloadCodec,
  extractMessagesInputText,
} from "../src/messages-codec.js";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { prepareClaudeStablePrefix } from "../src/stable-prefix.js";

test("extractMessagesInputText flattens Anthropic content blocks", () => {
  const text = extractMessagesInputText([
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_result", content: "from tool" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "world" },
      ],
    },
  ]);
  assert.equal(text, "hello\nfrom tool\nworld");
});

test("codec maps Messages request and response shapes", () => {
  const codec = createClaudeMessagesPayloadCodec();
  const request = codec.decodeRequest({
    model: "claude-sonnet-4-6",
    stream: false,
    system: "stay stable",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    ],
    tools: [{ name: "bash" }],
    metadata: { sessionId: "sess-1" },
    max_tokens: 512,
  });
  assert.equal(request.session.sessionId, "sess-1");
  assert.equal(request.instructions, "stay stable");
  assert.equal(request.messages[0]?.role, "user");
  assert.equal(request.metadata?.inputText, "hi");

  const response = codec.decodeResponse({
    id: "msg_123",
    content: [
      { type: "text", text: "done" },
      { type: "tool_use", id: "tool_1", name: "bash", input: { cmd: "pwd" } },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  }, request);
  assert.equal(response.assistantText, "done");
  assert.equal(response.toolCalls?.[0]?.toolCallId, "tool_1");
  assert.equal(response.toolCalls?.[0]?.toolName, "bash");
  assert.deepEqual(response.toolCalls?.[0]?.argumentsJson, { cmd: "pwd" });
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 5 });
});

test("claude session resolver synthesizes a per-request session id when host session markers are absent", () => {
  const codec = createClaudeMessagesPayloadCodec();
  const payloadA: any = {
    model: "claude-sonnet-4-6",
    stream: false,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi a" }],
      },
    ],
  };
  const payloadB: any = {
    model: "claude-sonnet-4-6",
    stream: false,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi b" }],
      },
    ],
  };

  const requestA = codec.decodeRequest(payloadA);
  const requestB = codec.decodeRequest(payloadB);

  assert.match(requestA.session.sessionId, /^claude-synth-/);
  assert.match(requestB.session.sessionId, /^claude-synth-/);
  assert.notEqual(requestA.session.sessionId, requestB.session.sessionId);
  assert.equal((payloadA.metadata as Record<string, unknown>)?.tokenpilotSyntheticSessionId, requestA.session.sessionId);
  assert.equal((payloadB.metadata as Record<string, unknown>)?.tokenpilotSyntheticSessionId, requestB.session.sessionId);
});

test("claude request path canonicalizes tools before encode", async () => {
  const codec = createClaudeMessagesPayloadCodec();
  const request = codec.decodeRequest({
    model: "claude-sonnet-4-6",
    stream: false,
    system: "stay stable",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    ],
    tools: [
      { type: "function", name: "z_tool", input_schema: { type: "object", properties: { z: { type: "number" }, a: { type: "number" } } } },
      { type: "function", name: "a_tool", input_schema: { type: "object", properties: { b: { type: "boolean" }, a: { type: "boolean" } } } },
    ],
    metadata: { sessionId: "sess-tools" },
  });

  const prepared = await prepareBeforeCall({
    envelope: request,
    config: { mode: "normal" },
    helpers: { prepareStablePrefix: canonicalizeEnvelopeTools },
  });
  const encoded = codec.encodeRequest(prepared.envelope) as any;

  assert.equal(Array.isArray(encoded.tools), true);
  assert.equal(encoded.tools[0]?.name, "a_tool");
  assert.equal(encoded.tools[1]?.name, "z_tool");
  assert.deepEqual(Object.keys(encoded.tools[0]?.input_schema?.properties ?? {}), ["a", "b"]);
  assert.deepEqual(Object.keys(encoded.tools[1]?.input_schema?.properties ?? {}), ["a", "z"]);
});

test("claude stable prefix preserves inbound prompt_cache_key for encode while storing framework stable key", () => {
  const codec = createClaudeMessagesPayloadCodec();
  const request = codec.decodeRequest({
    model: "claude-sonnet-4-6",
    stream: false,
    system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
    prompt_cache_key: "legacy-key-a",
    metadata: { sessionId: "sess-cache-key-rewrite" },
  });

  const prepared = prepareClaudeStablePrefix(request, normalizeTokenPilotClaudeCodeConfig({
    hooks: {
      dynamicContextTarget: "user",
    },
  }));
  const encoded = codec.encodeRequest(prepared) as Record<string, unknown>;

  assert.equal("prompt_cache_key" in encoded, false);
  assert.match(String(prepared.metadata?.frameworkStablePromptCacheKey ?? ""), /^lightrsi-claude-/);
  assert.equal(prepared.metadata?.originalPromptCacheKey, "legacy-key-a");
});

test("codec preserves structured Anthropic system blocks and cache metadata", () => {
  const codec = createClaudeMessagesPayloadCodec();
  const system = [
    {
      type: "text",
      text: "You are a stable coding agent.",
      cache_control: { type: "ephemeral", ttl: "1h" },
      unknown_field: { keep: true },
    },
    { type: "text", text: "Follow repository rules." },
  ];
  const rawPayload = {
    model: "claude-sonnet-4-6",
    stream: false,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };

  const envelope = codec.decodeRequest(rawPayload);
  assert.equal(envelope.instructions, "You are a stable coding agent.\nFollow repository rules.");
  assert.deepEqual(envelope.metadata?.__anthropicRawSystem, system);
  assert.equal(envelope.metadata?.__anthropicSystemText, envelope.instructions);

  const encoded = codec.encodeRequest(envelope) as Record<string, unknown>;
  assert.deepEqual(encoded.system, system);
  assert.equal("prompt_cache_key" in encoded, false);
});

test("codec appends pipeline instructions to structured Anthropic system blocks", async () => {
  const codec = createClaudeMessagesPayloadCodec();
  const system = [
    {
      type: "text",
      text: "You are a stable coding agent.",
      cache_control: { type: "ephemeral", ttl: "1h" },
      unknown_field: { keep: true },
    },
    { type: "text", text: "Follow repository rules." },
  ];
  const envelope = codec.decodeRequest({
    model: "claude-sonnet-4-6",
    stream: false,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });

  const prepared = await prepareBeforeCall({ envelope });
  const encoded = codec.encodeRequest(prepared.envelope) as Record<string, unknown>;
  const encodedSystem = encoded.system as Array<Record<string, unknown>>;

  assert.equal(prepared.diagnostics.recoveryInjected, true);
  assert.equal(encodedSystem.length, 3);
  assert.deepEqual(encodedSystem.slice(0, 2), system);
  assert.equal(encodedSystem[2]?.type, "text");
  assert.match(String(encodedSystem[2]?.text ?? ""), /^\n\n\[Recovery Protocol\]/);
});
