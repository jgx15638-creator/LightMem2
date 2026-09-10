import { createTurnAnchor, buildTurnAbsId } from "@lightrsi/history";
import type {
  RawSemanticTurnRecord,
  RawSemanticMessageRecord,
  RawSemanticToolCallRecord,
  RawSemanticToolResultRecord,
} from "@lightrsi/history";

const SUMMARY_MAX = 200;

function summarize(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= SUMMARY_MAX ? trimmed : trimmed.slice(0, SUMMARY_MAX) + "…";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((blockRaw) => {
      const block = asRecord(blockRaw);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isClaudeInternalMetadataRequest(message: Record<string, unknown>): boolean {
  const text = messageText(message).trim();
  return text.startsWith("[SUGGESTION MODE:")
    || (text.startsWith("<session>")
      && text.includes("Write the title in the predominant language of the session"));
}

/** Claude resends its full message history. Retain the newest user message and
 * the immediately preceding assistant message. The latter contains either the
 * tool call paired with a tool result or the previous task's delivered answer,
 * which the lifecycle estimator needs as completion evidence. */
export function sliceClaudeMessagesForCurrentUserTurn(messages: unknown[]): unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role !== "user") continue;
    if (isClaudeInternalMetadataRequest(message)) return [];
    const previous = index > 0 ? asRecord(messages[index - 1]) : undefined;
    return messages.slice(previous?.role === "assistant" ? index - 1 : index);
  }
  return messages;
}

// Extract a file path from a tool_use input, if the tool operates on a file.
function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const candidate = input.file_path ?? input.path ?? input.filePath;
  return typeof candidate === "string" ? candidate : undefined;
}

// Classify which files a tool reads vs writes based on its name.
function fileEffects(toolName: string, input: Record<string, unknown> | undefined): {
  filesRead?: string[];
  filesWritten?: string[];
} {
  const path = filePathOf(input);
  if (!path) return {};
  const lower = toolName.toLowerCase();
  if (lower === "read" || lower === "grep" || lower === "glob") {
    return { filesRead: [path] };
  }
  if (lower === "write" || lower === "edit" || lower === "multiedit" || lower === "notebookedit") {
    return { filesWritten: [path] };
  }
  return {};
}

/**
 * Map one turn's Claude messages into a RawSemanticTurnRecord: message records
 * (user/assistant text), tool call records (tool_use), and tool result records
 * (tool_result). turnSeq is the caller-supplied real turn sequence — never a
 * re-numbered array index. tool_result full text is carried in fullText but the
 * estimator only consumes summary + rawContentRef. toolName for a result is
 * resolved from its paired tool_use in the same turn when available.
 */
export function buildRawSemanticTurnRecord(params: {
  sessionId: string;
  turnSeq: number;
  messages: unknown[];
}): RawSemanticTurnRecord {
  const { sessionId, turnSeq, messages } = params;
  const messageRecords: RawSemanticMessageRecord[] = [];
  const toolCalls: RawSemanticToolCallRecord[] = [];
  const toolResults: RawSemanticToolResultRecord[] = [];

  // First pass: map tool_use id → toolName so results can resolve their tool.
  const toolNameByCallId = new Map<string, string>();
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message || !Array.isArray(message.content)) continue;
    for (const blockRaw of message.content) {
      const block = asRecord(blockRaw);
      if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        toolNameByCallId.set(block.id, block.name);
      }
    }
  }

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const anchor = createTurnAnchor(sessionId, turnSeq, role);

    if (typeof message.content === "string") {
      if (message.content.trim().length > 0) {
        messageRecords.push({ anchor, role, text: message.content });
      }
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    for (const blockRaw of message.content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim().length > 0) {
          messageRecords.push({ anchor, role, text: block.text });
        }
      } else if (block.type === "tool_use") {
        const toolName = typeof block.name === "string" ? block.name : "";
        const input = asRecord(block.input);
        const argumentsText = input ? JSON.stringify(input) : undefined;
        toolCalls.push({
          anchor: createTurnAnchor(sessionId, turnSeq, "tool"),
          toolCallId: typeof block.id === "string" ? block.id : "",
          toolName,
          argumentsText,
          argumentsSummary: summarize(argumentsText ?? toolName),
          ...fileEffects(toolName, input),
        });
      } else if (block.type === "tool_result") {
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const fullText = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        const toolName = toolNameByCallId.get(callId) ?? "";
        toolResults.push({
          anchor: createTurnAnchor(sessionId, turnSeq, "tool"),
          toolCallId: callId,
          toolName,
          status: block.is_error === true ? "error" : "success",
          fullText,
          summary: summarize(fullText),
          ...fileEffects(toolName, undefined),
        });
      }
    }
  }

  return {
    sessionId,
    turnSeq,
    turnAbsId: buildTurnAbsId(sessionId, turnSeq),
    messages: messageRecords,
    toolCalls,
    toolResults,
  };
}

import type { RawSemanticSnapshot } from "@lightrsi/history";

/**
 * Assemble a RawSemanticSnapshot from per-turn records by concatenating their
 * message/toolCall/toolResult arrays in turn order. lastTurnSeq is the highest
 * turnSeq present. The snapshot is what buildDeltaViewFromRawSemanticSnapshot
 * consumes to produce a DeltaView for a turn range.
 */
export function buildRawSemanticSnapshot(params: {
  sessionId: string;
  turns: import("@lightrsi/history").RawSemanticTurnRecord[];
}): RawSemanticSnapshot {
  const { sessionId, turns } = params;
  const ordered = [...turns].sort((a, b) => a.turnSeq - b.turnSeq);
  let lastTurnSeq = 0;
  const messages: RawSemanticSnapshot["messages"] = [];
  const toolCalls: RawSemanticSnapshot["toolCalls"] = [];
  const toolResults: RawSemanticSnapshot["toolResults"] = [];
  for (const turn of ordered) {
    lastTurnSeq = Math.max(lastTurnSeq, turn.turnSeq);
    messages.push(...turn.messages);
    toolCalls.push(...turn.toolCalls);
    toolResults.push(...turn.toolResults);
  }
  return { sessionId, lastTurnSeq, messages, toolCalls, toolResults };
}
