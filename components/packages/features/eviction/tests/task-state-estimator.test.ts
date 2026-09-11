import assert from "node:assert/strict";
import test from "node:test";

import { createApiTaskStateEstimator } from "../src/task-state-estimator.js";

const estimatorInput: any = {
  registry: {
    version: 1,
    tasks: {},
    activeTaskIds: [],
    completedTaskIds: [],
    evictableTaskIds: [],
    taskToBlockIds: {},
    blockToTaskIds: {},
    turnToTaskIds: {},
  },
  delta: {
    inputMode: "sliding_window",
    coveredTurnAbsIds: [],
    messages: [],
    toolCalls: [],
    toolResults: [],
    filesRead: [],
    filesWritten: [],
  },
};

test("task-state estimator preserves Responses API usage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({ baseVersion: 1, taskUpdates: [] }),
        usage: {
          input_tokens: 120,
          output_tokens: 24,
          total_tokens: 144,
          cost_usd: 0.002,
        },
      };
    },
  } as Response);
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate(estimatorInput);
    assert.deepEqual(output.usage, {
      inputTokens: 120,
      outputTokens: 24,
      totalTokens: 144,
      costUsd: 0.002,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task-state estimator preserves Chat Completions usage after Responses fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 404,
        async text() {
          return "not found";
        },
      } as Response;
    }
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: JSON.stringify({ baseVersion: 1, taskUpdates: [] }) } }],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 20,
            total_tokens: 100,
          },
        };
      },
    } as Response;
  };
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate(estimatorInput);
    assert.equal(calls, 2);
    assert.deepEqual(output.usage, {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task-state estimator leaves null provider cost unknown", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({ baseVersion: 1, taskUpdates: [] }),
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          cost_usd: null,
        },
      };
    },
  } as Response);
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate(estimatorInput);
    assert.deepEqual(output.usage, {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task-state estimator accepts a fenced JSON object from compatible providers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: "```json\n{\"baseVersion\":1,\"taskUpdates\":[]}\n```",
          }],
        }],
      };
    },
  } as Response);
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    assert.deepEqual(await estimator.estimate(estimatorInput), {
      baseVersion: 1,
      taskUpdates: [],
      usage: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task-state estimator normalizes common compatible-provider task update aliases", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({
          base_version: 7,
          task_updates: [{
            task_id: "session-1:t2-task",
            title: "Validate event-search index migration",
            description: "Benchmark and validate the event-search index migration",
            status: "complete",
            covered_turn_abs_ids: ["session-1:t2"],
            completion_evidence: "TASK_B_COMPLETE",
          }],
        }),
      };
    },
  } as Response);
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate({
      registry: {
        ...estimatorInput.registry,
        version: 7,
        sessionId: "session-1",
      },
      delta: {
        ...estimatorInput.delta,
        fromTurnSeqExclusive: 1,
        toTurnSeqInclusive: 2,
        coveredTurnAbsIds: ["session-1:t2"],
        messages: [{
          anchor: { sessionId: "session-1", turnAbsId: "session-1:t2", turnSeq: 2, role: "user" },
          role: "user",
          text: "Validate the event-search index migration.",
          source: "raw",
        }],
      },
    } as any);

    assert.deepEqual(output, {
      baseVersion: 7,
      taskUpdates: [{
        taskId: "session-1:t2-task",
        title: "Validate event-search index migration",
        objective: "Benchmark and validate the event-search index migration",
        lifecycle: "completed",
        coveredTurnAbsIds: ["session-1:t2"],
        completionEvidence: ["TASK_B_COMPLETE"],
      }],
      usage: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task-state estimator removes out-of-window ownership while preserving current turns", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({
          baseVersion: 1,
          taskUpdates: [{
            taskId: "session-1:t2-task",
            objective: "Validate the current task",
            lifecycle: "active",
            coveredTurnAbsIds: ["session-1:t1", "session-1:t2"],
          }],
        }),
      };
    },
  } as Response);
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate({
      registry: {
        ...estimatorInput.registry,
        sessionId: "session-1",
      },
      delta: {
        ...estimatorInput.delta,
        fromTurnSeqExclusive: 1,
        toTurnSeqInclusive: 2,
        coveredTurnAbsIds: ["session-1:t2"],
      },
    } as any);

    assert.deepEqual(output.taskUpdates[0]?.coveredTurnAbsIds, ["session-1:t2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task-state estimator derives a missing new-task objective from its covered user turn", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({
          baseVersion: 1,
          taskUpdates: [{
            taskId: "session-1:t2-task",
            lifecycle: "active",
            coveredTurnAbsIds: ["session-1:t2"],
          }],
        }),
      };
    },
  } as Response);
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate({
      registry: {
        ...estimatorInput.registry,
        sessionId: "session-1",
      },
      delta: {
        ...estimatorInput.delta,
        fromTurnSeqExclusive: 1,
        toTurnSeqInclusive: 2,
        coveredTurnAbsIds: ["session-1:t2"],
        messages: [{
          anchor: { sessionId: "session-1", turnAbsId: "session-1:t2", turnSeq: 2, role: "user" },
          role: "user",
          text: "Diagnose the OAuth refresh failure.",
          source: "raw",
        }],
      },
    } as any);

    assert.equal(output.taskUpdates[0]?.objective, "Diagnose the OAuth refresh failure.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
