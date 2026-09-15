export type CleanTaskView = {
  taskId: string;
  label: string;
  description: string;
  lifecycleState: string;
  tokenCount: number | null;
  charCount: number;
  tokenPercent: number | null;
  recommendation: "clean" | "keep" | "protected";
  reasonCodes: string[];
  selectable: boolean;
};

export type CleanPlanView = {
  planId: string;
  hostId: string;
  sessionId: string;
  contextWindowTokens?: number;
  usedTokens: number | null;
  usedChars: number;
  protectedTokens: number | null;
  protectedChars: number;
  unassignedTokens: number | null;
  unassignedChars: number;
  tokenCountMode: string;
  tasks: CleanTaskView[];
};

export type CleanReceiptView = {
  planId: string;
  status: string;
  selectedTaskIds: string[];
  estimatedSavedTokens: number | null;
  estimatedSavedChars: number;
  appliedSavedTokens?: number | null;
  appliedSavedChars?: number;
  fallbackUsed: boolean;
  deferredTaskIds: string[];
  reasons: string[];
};

export type CleanPlanRenderOptions = {
  maxWidth?: number;
};

function count(tokens: number | null, chars: number): string {
  return tokens === null ? `${chars} chars` : `${tokens} tok`;
}

function characterWidth(value: string): number {
  const codePoint = value.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(value)) return 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
}

export function terminalDisplayWidth(value: string): number {
  let width = 0;
  for (const character of value) width += characterWidth(character);
  return width;
}

export function truncateTerminalText(value: string, maxWidth: number): string {
  if (terminalDisplayWidth(value) <= maxWidth) return value;
  if (maxWidth <= 0) return "";
  const suffix = maxWidth >= 3 ? "..." : ".".repeat(maxWidth);
  let result = "";
  let width = 0;
  for (const character of value) {
    const nextWidth = characterWidth(character);
    if (width + nextWidth + suffix.length > maxWidth) break;
    result += character;
    width += nextWidth;
  }
  return `${result}${suffix}`;
}

function cell(value: string, width: number): string {
  const truncated = truncateTerminalText(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - terminalDisplayWidth(truncated)))}`;
}

function fitTableWidths(desired: number[], maxWidth?: number): number[] {
  if (maxWidth === undefined) return desired;
  const widths = [...desired];
  const minimums = [3, 4, 11, 4, 5, 6, 6];
  const separatorsWidth = (widths.length - 1) * 2;
  while (widths.reduce((total, width) => total + width, separatorsWidth) > maxWidth) {
    let shrinkIndex = -1;
    let largestSurplus = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const surplus = widths[index]! - minimums[index]!;
      if (surplus > largestSurplus) {
        largestSurplus = surplus;
        shrinkIndex = index;
      }
    }
    if (shrinkIndex < 0) break;
    widths[shrinkIndex]! -= 1;
  }
  return widths;
}

function wrapTerminalLine(value: string, maxWidth?: number): string[] {
  if (maxWidth === undefined || terminalDisplayWidth(value) <= maxWidth) return [value];
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const character of value) {
    const nextWidth = characterWidth(character);
    if (line && width + nextWidth > maxWidth) {
      lines.push(line);
      line = "";
      width = 0;
    }
    line += character;
    width += nextWidth;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function risk(task: CleanTaskView): string {
  const level = task.recommendation === "protected" ? "blocked"
    : task.recommendation === "keep" ? "caution" : "low";
  return task.reasonCodes.length > 0 ? `${level}: ${task.reasonCodes.join(",")}` : level;
}

export function estimateCleanSelection(plan: CleanPlanView, selectedTaskIds: readonly string[]): {
  tokens: number | null;
  chars: number;
} {
  const selected = plan.tasks.filter((task) => selectedTaskIds.includes(task.taskId));
  return {
    tokens: selected.length === 0
      ? (plan.usedTokens === null ? null : 0)
      : selected.every((task) => task.tokenCount !== null)
      ? selected.reduce((total, task) => total + (task.tokenCount ?? 0), 0)
      : null,
    chars: selected.reduce((total, task) => total + task.charCount, 0),
  };
}

export function renderCleanPlan(plan: CleanPlanView, options: CleanPlanRenderOptions = {}): string {
  const maxWidth = options.maxWidth === undefined
    ? undefined
    : Math.max(1, Math.floor(options.maxWidth));
  const rows = plan.tasks.map((task) => [
    task.selectable ? "[ ]" : "[-]",
    task.taskId,
    task.description,
    count(task.tokenCount, task.charCount),
    task.tokenPercent === null ? "-" : `${task.tokenPercent.toFixed(1)}%`,
    task.recommendation,
    risk(task),
  ]);
  const widths = fitTableWidths([
    3,
    Math.max(18, "TASK".length, ...plan.tasks.map((task) => terminalDisplayWidth(task.taskId))),
    22,
    10,
    7,
    9,
    17,
  ], maxWidth);
  const format = (row: string[]) => truncateTerminalText(
    row.map((value, index) => cell(value, widths[index]!)).join("  ").trimEnd(),
    maxWidth ?? Number.POSITIVE_INFINITY,
  );
  const recommendedTaskIds = plan.tasks
    .filter((task) => task.selectable && task.recommendation === "clean")
    .map((task) => task.taskId);
  const recommended = estimateCleanSelection(plan, recommendedTaskIds);
  const usage = plan.contextWindowTokens !== undefined && plan.contextWindowTokens > 0 && plan.usedTokens !== null
    ? `${plan.usedTokens} / ${plan.contextWindowTokens} tok (${(plan.usedTokens / plan.contextWindowTokens * 100).toFixed(1)}%)`
    : count(plan.usedTokens, plan.usedChars);
  const lines = [
    `Context clean plan ${plan.planId}`,
    `Host/session: ${plan.hostId} / ${plan.sessionId}`,
    `Context usage: ${usage} (${plan.tokenCountMode})`,
    `Protected context: ${count(plan.protectedTokens, plan.protectedChars)}`,
    `Unassigned context: ${count(plan.unassignedTokens, plan.unassignedChars)}`,
    "",
    format(["", "TASK", "DESCRIPTION", "SIZE", "SHARE", "ADVICE", "RISK / REASONS"]),
    format(widths.map((width) => "-".repeat(width))),
    ...rows.map(format),
    "",
    "Task details:",
    ...plan.tasks.map((task) => `- ${task.taskId}: ${task.description}`),
    "",
    "Reason codes:",
    ...plan.tasks
      .filter((task) => task.reasonCodes.length > 0)
      .map((task) => `- ${task.taskId}: ${task.reasonCodes.join(", ")}`),
    "",
    `Recommended selection estimate: ${count(recommended.tokens, recommended.chars)}`,
  ];
  return lines.flatMap((line) => wrapTerminalLine(line, maxWidth)).join("\n");
}

export function renderCleanReceipt(receipt: CleanReceiptView): string {
  const lines = [
    `Context clean ${receipt.status}: ${receipt.planId}`,
    `Selected tasks: ${receipt.selectedTaskIds.length > 0 ? receipt.selectedTaskIds.join(", ") : "(none)"}`,
    `Estimated savings: ${count(receipt.estimatedSavedTokens, receipt.estimatedSavedChars)}`,
    `Scheduled savings: ${receipt.status === "scheduled" || receipt.status === "applied"
      ? count(receipt.estimatedSavedTokens, receipt.estimatedSavedChars)
      : "not scheduled"}`,
  ];
  if (receipt.status === "applied") {
    if (receipt.appliedSavedTokens !== undefined || receipt.appliedSavedChars !== undefined) {
      lines.push(`Applied savings: ${count(receipt.appliedSavedTokens ?? null, receipt.appliedSavedChars ?? 0)}`);
    } else {
      lines.push("Applied savings: unavailable (missing Host evidence)");
    }
  } else {
    lines.push("Applied savings: not applied");
  }
  lines.push(`Fallback count: ${receipt.fallbackUsed ? 1 : 0}`);
  if (receipt.status === "scheduled") lines.push("Apply timing: next Host request.");
  if (receipt.deferredTaskIds.length > 0) lines.push(`Deferred tasks: ${receipt.deferredTaskIds.join(", ")}`);
  if (receipt.reasons.length > 0) lines.push(`Reasons: ${receipt.reasons.join(", ")}`);
  return lines.join("\n");
}
