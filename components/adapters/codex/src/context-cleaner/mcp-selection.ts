import type {
  ContextCleanPlan,
  ContextCleanReceipt,
  ContextCleanerControlService,
} from "@lightrsi/cleaner";
import type {
  McpClientCapabilities,
  McpToolHandler,
  McpToolResult,
} from "@lightrsi/mcp";

export const CODEX_CLEANER_MCP_SERVER_NAME = "lightrsi_cleaner";
export const CODEX_CLEAN_TOOL_NAME = "lightrsi_clean";

type ElicitationResult = {
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function supportsFormElicitation(capabilities: McpClientCapabilities): boolean {
  const elicitation = asRecord(capabilities.elicitation);
  return Object.hasOwn(elicitation, "form");
}

function taskSize(plan: ContextCleanPlan, index: number): string {
  const task = plan.tasks[index]!;
  return task.tokenCount === null
    ? `${task.charCount} chars`
    : `${task.tokenCount} tok`;
}

function renderPlan(plan: ContextCleanPlan): string {
  const used = plan.usedTokens === null
    ? `${plan.usedChars} chars`
    : `${plan.usedTokens} tok`;
  return [
    `Context clean plan ${plan.planId}`,
    `Host/session: ${plan.hostId} / ${plan.sessionId}`,
    `Context usage: ${used} (${plan.tokenCountMode})`,
    "",
    ...plan.tasks.map((task, index) => {
      const marker = task.selectable ? "[ ]" : "[-]";
      return `${marker} ${task.taskId} · ${task.label} · ${taskSize(plan, index)} · ${task.recommendation}`;
    }),
    "",
    "Select completed tasks to clean. Protected tasks are shown for context and cannot be selected.",
  ].join("\n");
}

function receiptDetails(receipt: ContextCleanReceipt): Record<string, unknown> {
  return {
    planId: receipt.planId,
    status: receipt.status,
    selectedTaskIds: [...receipt.selectedTaskIds],
    estimatedSavedTokens: receipt.estimatedSavedTokens,
    estimatedSavedChars: receipt.estimatedSavedChars,
    fallbackUsed: receipt.fallbackUsed,
  };
}

function result(
  text: string,
  structuredContent: Record<string, unknown>,
  isError = false,
): McpToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodexCleanerMcpTool(params: {
  service: ContextCleanerControlService;
  resolveSessionId(): Promise<string | undefined>;
}): McpToolHandler {
  return {
    definition: {
      name: CODEX_CLEAN_TOOL_NAME,
      description:
        "Analyze the current Codex session, ask the user which completed tasks to clean, and schedule the exact accepted selection for the next Host request.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async call(_args, peer) {
      const sessionId = await params.resolveSessionId();
      if (!sessionId) {
        return result(
          "No current Codex session could be resolved.",
          { error: "codex_clean_session_not_found" },
          true,
        );
      }

      const plan = await params.service.analyze(sessionId);
      const selectableTasks = plan.tasks.filter((task) => task.selectable);
      if (selectableTasks.length === 0) {
        return result(
          `${renderPlan(plan)}\n\nNo selectable tasks are available; no changes were scheduled.`,
          { planId: plan.planId, status: "analyzed", selectedTaskIds: [] },
        );
      }
      if (!supportsFormElicitation(peer.clientCapabilities)) {
        return result(
          `${renderPlan(plan)}\n\nThis Codex client does not support form elicitation. Run \`lightrsi codex clean\` in a terminal to use the direct interactive flow.`,
          {
            planId: plan.planId,
            error: "codex_clean_form_elicitation_unsupported",
            fallbackCommand: "lightrsi codex clean",
          },
          true,
        );
      }

      const taskIdByField = new Map<string, string>();
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      for (const [index, task] of selectableTasks.entries()) {
        const field = `task_${index + 1}`;
        taskIdByField.set(field, task.taskId);
        required.push(field);
        properties[field] = {
          type: "boolean",
          title: task.label,
          description: `${task.taskId} · ${task.tokenCount === null ? `${task.charCount} chars` : `${task.tokenCount} tok`} · ${task.recommendation}`,
          default: false,
        };
      }

      const elicitation = await peer.request<ElicitationResult>("elicitation/create", {
        mode: "form",
        message: renderPlan(plan),
        requestedSchema: {
          type: "object",
          additionalProperties: false,
          properties,
          required,
        },
      });
      if (elicitation.action !== "accept") {
        return result(
          "Context clean cancelled; no changes were scheduled.",
          { planId: plan.planId, status: "cancelled", selectedTaskIds: [] },
        );
      }

      const content = asRecord(elicitation.content);
      const selectedTaskIds = [...taskIdByField]
        .filter(([field]) => content[field] === true)
        .map(([, taskId]) => taskId);
      if (selectedTaskIds.length === 0) {
        return result(
          "No tasks selected; no changes were scheduled.",
          { planId: plan.planId, status: "analyzed", selectedTaskIds: [] },
        );
      }

      try {
        const receipt = await params.service.approve(plan.planId, selectedTaskIds);
        return result(
          [
            `Context clean scheduled: ${receipt.planId}`,
            `Selected tasks: ${receipt.selectedTaskIds.join(", ")}`,
            `Estimated savings: ${receipt.estimatedSavedTokens === null ? `${receipt.estimatedSavedChars} chars` : `${receipt.estimatedSavedTokens} tok`}`,
            "Apply timing: next Host request.",
          ].join("\n"),
          receiptDetails(receipt),
        );
      } catch (error) {
        return result(
          `Context clean could not be scheduled: ${errorMessage(error)}`,
          {
            planId: plan.planId,
            selectedTaskIds,
            error: errorMessage(error),
          },
          true,
        );
      }
    },
  };
}
