import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  encodeMcpMessage,
  type TokenPilotMcpWireProtocol,
} from "../src/index.js";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

function extractMessages(
  buffer: Buffer,
  protocol: TokenPilotMcpWireProtocol,
): { messages: JsonRpcMessage[]; remainder: Buffer } {
  const messages: JsonRpcMessage[] = [];
  for (;;) {
    if (protocol === "newline_json") {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const body = buffer.slice(0, newline).toString("utf8").trim();
      buffer = buffer.slice(newline + 1);
      if (body) messages.push(JSON.parse(body) as JsonRpcMessage);
      continue;
    }

    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) break;
    const header = buffer.slice(0, boundary).toString("utf8");
    const match = /^content-length:\s*(\d+)$/im.exec(header);
    assert.ok(match);
    const contentLength = Number(match[1]);
    const bodyStart = boundary + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) break;
    messages.push(JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8")) as JsonRpcMessage);
    buffer = buffer.slice(bodyEnd);
  }
  return { messages, remainder: buffer };
}

async function exerciseFullDuplexSession(protocol: TokenPilotMcpWireProtocol): Promise<void> {
  const fixturePath = join(__dirname, "session-fixture.ts");
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr = "";
  const messages: JsonRpcMessage[] = [];
  const waiters: Array<() => void> = [];

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout = Buffer.concat([stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const extracted = extractMessages(stdout, protocol);
    stdout = extracted.remainder;
    messages.push(...extracted.messages);
    while (waiters.length > 0) waiters.shift()?.();
  });

  async function waitFor(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new Error(`MCP fixture response timeout: ${stderr}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  function send(message: JsonRpcMessage): void {
    child.stdin.write(encodeMcpMessage(message, protocol));
  }

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {
          elicitation: { form: {} },
        },
        clientInfo: { name: "session-test", version: "0.1.0" },
      },
    });
    const initialized = await waitFor((message) => message.id === 1);
    assert.equal(initialized.result?.serverInfo && (initialized.result.serverInfo as { name?: string }).name,
      "lightrsi-mcp-session-fixture");

    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "selection_probe", arguments: {} },
    });

    const elicitation = await waitFor((message) => message.method === "elicitation/create");
    assert.equal(elicitation.params?.mode, "form");
    assert.notEqual(elicitation.id, null);
    send({
      jsonrpc: "2.0",
      id: elicitation.id,
      result: {
        action: "accept",
        content: { task_1: true },
      },
    });

    const completed = await waitFor((message) => message.id === 2);
    assert.equal(completed.error, undefined);
    assert.deepEqual(completed.result?.structuredContent, {
      action: "accept",
      selected: true,
      clientCapabilities: {
        elicitation: { form: {} },
      },
    });
    assert.equal(messages.filter((message) => message.id === null).length, 0);
  } finally {
    child.kill();
  }
}

test("stdio MCP session correlates server elicitation over newline JSON", async () => {
  await exerciseFullDuplexSession("newline_json");
});

test("stdio MCP session correlates server elicitation over Content-Length framing", async () => {
  await exerciseFullDuplexSession("content_length");
});
