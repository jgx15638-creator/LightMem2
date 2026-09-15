import type { ContextCleanPlan } from "@lightrsi/cleaner";

function count(tokens: number | null, chars: number): string {
  return tokens === null ? `${chars} chars` : `${tokens} tok`;
}

function codePointWidth(value: string): number {
  const code = value.codePointAt(0) ?? 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  return code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd)
  ) ? 2 : 1;
}

function displayWidth(value: string): number {
  return [...value].reduce((width, character) => width + codePointWidth(character), 0);
}

function truncate(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  const target = Math.max(0, width - 1);
  let result = "";
  let used = 0;
  for (const character of value) {
    const next = codePointWidth(character);
    if (used + next > target) break;
    result += character;
    used += next;
  }
  return `${result}…`;
}

function cell(value: string, width: number): string {
  const clipped = truncate(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function share(plan: ContextCleanPlan, task: ContextCleanPlan["tasks"][number]): string {
  if (task.tokenPercent !== null) return `${task.tokenPercent.toFixed(1)}%`;
  return plan.usedChars > 0 ? `${(task.charCount / plan.usedChars * 100).toFixed(1)}% chars` : "-";
}

function risk(task: ContextCleanPlan["tasks"][number]): string {
  if (!task.selectable || task.recommendation === "protected") return "blocked";
  return task.recommendation === "clean" ? "low" : "caution";
}

function estimateRecommended(plan: ContextCleanPlan): { tokens: number | null; chars: number } {
  const tasks = plan.tasks.filter(
    (task) => task.selectable && task.recommendation === "clean",
  );
  return {
    tokens: tasks.length === 0
      ? (plan.usedTokens === null ? null : 0)
      : tasks.every((task) => task.tokenCount !== null)
        ? tasks.reduce((total, task) => total + (task.tokenCount ?? 0), 0)
        : null,
    chars: tasks.reduce((total, task) => total + task.charCount, 0),
  };
}

export function renderOpenClawCleanPlan(plan: ContextCleanPlan): string {
  // Keep the native OpenClaw Markdown response inside a typical 120-column
  // TUI. Full task ids, descriptions, and reasons remain available below.
  const widths = [3, 18, 22, 11, 11, 9, 18];
  const format = (row: string[]): string => row
    .map((value, index) => cell(value, widths[index]!))
    .join("  ")
    .trimEnd();
  const rows = plan.tasks.map((task) => format([
    task.selectable ? "[ ]" : "[-]",
    task.taskId,
    task.description || task.label,
    count(task.tokenCount, task.charCount),
    share(plan, task),
    task.recommendation,
    `${risk(task)}${task.reasonCodes.length > 0 ? `: ${task.reasonCodes.join(",")}` : ""}`,
  ]));
  const recommended = estimateRecommended(plan);
  const selectable = plan.tasks.filter((task) => task.selectable);
  const usage = plan.contextWindowTokens !== undefined
    && plan.contextWindowTokens > 0
    && plan.usedTokens !== null
    ? `${plan.usedTokens} / ${plan.contextWindowTokens} tok (${(
        plan.usedTokens / plan.contextWindowTokens * 100
      ).toFixed(1)}%)`
    : count(plan.usedTokens, plan.usedChars);

  return [
    `Context clean plan: ${plan.planId}`,
    `Host/session: ${plan.hostId} / ${plan.sessionId}`,
    `Context usage: ${usage} (${plan.tokenCountMode})`,
    `Protected context: ${count(plan.protectedTokens, plan.protectedChars)}`,
    `Unassigned context: ${count(plan.unassignedTokens, plan.unassignedChars)}`,
    "",
    "```text",
    format(["", "TASK", "DESCRIPTION", "SIZE", "SHARE", "ADVICE", "RISK / REASONS"]),
    format(widths.map((width) => "-".repeat(width))),
    ...(rows.length > 0 ? rows : ["(no attributed tasks)"]),
    "```",
    "",
    "Task details:",
    ...(plan.tasks.length > 0
      ? plan.tasks.map((task) => `- ${task.taskId}: ${task.description || task.label}`)
      : ["- (none)"]),
    "",
    "Reason codes:",
    ...(plan.tasks.length > 0
      ? plan.tasks.map((task) => `- ${task.taskId}: ${task.reasonCodes.join(", ") || "(none)"}`)
      : ["- (none)"]),
    "",
    `Recommended selection estimate: ${count(recommended.tokens, recommended.chars)}`,
    "",
    "Selectable tasks:",
    "None selected by default.",
    ...(selectable.length > 0
      ? selectable.map((task, index) => `${index + 1}. ${task.taskId} - ${task.label}`)
      : ["(none)"]),
    "",
    "Choose task IDs explicitly after reviewing this plan.",
    "",
    "No changes applied.",
    `Apply selected tasks: /lightrsi clean --plan ${plan.planId} --select <task-id[,task-id...]>`,
  ].join("\n");
}
