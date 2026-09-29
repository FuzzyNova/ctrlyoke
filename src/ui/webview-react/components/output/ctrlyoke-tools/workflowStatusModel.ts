import { STEP_STATUS } from "@root/types/DashboardConstants";

export interface WorkflowStatusStep {
  index: number;
  prompt: string;
  status: string;
  model?: string;
}

export interface WorkflowStatusResult {
  workflowKey: string;
  runRef: string;
  metadata: {
    currentIndex: number;
    totalSteps: number;
    completedSteps: number;
    executionState: string;
    harness: string | null;
    model: string | null;
  };
  steps: WorkflowStatusStep[];
  schemaWarnings: Array<{ message: string; path?: string }>;
}

export type WorkflowStatusParams = Record<string, never>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkflowStatusParams(
  raw: unknown
): WorkflowStatusParams | undefined {
  return isRecord(raw) ? {} : undefined;
}

export function parseWorkflowStatusResultText(
  text: string
): WorkflowStatusResult | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      typeof value.workflowKey !== "string" ||
      typeof value.runRef !== "string" ||
      !isRecord(value.metadata) ||
      !Array.isArray(value.steps) ||
      !Array.isArray(value.schemaWarnings)
    )
      return undefined;
    const m = value.metadata;
    if (
      typeof m.currentIndex !== "number" ||
      typeof m.totalSteps !== "number" ||
      typeof m.completedSteps !== "number" ||
      typeof m.executionState !== "string" ||
      !(typeof m.harness === "string" || m.harness === null) ||
      !(typeof m.model === "string" || m.model === null)
    )
      return undefined;
    if (
      !value.steps.every(
        (step) =>
          isRecord(step) &&
          Number.isInteger(step.index) &&
          typeof step.prompt === "string" &&
          typeof step.status === "string" &&
          (step.model === undefined || typeof step.model === "string")
      )
    )
      return undefined;
    if (
      !value.schemaWarnings.every(
        (warning) => isRecord(warning) && typeof warning.message === "string"
      )
    )
      return undefined;
    return value as unknown as WorkflowStatusResult;
  } catch {
    return undefined;
  }
}

export function workflowStatusSummary(
  _params: WorkflowStatusParams | undefined,
  result: WorkflowStatusResult
): string {
  const state = result.metadata.executionState;
  if (result.steps.length === 0) return `Workflow · ${state}`;
  const current = Math.min(
    result.metadata.totalSteps,
    Math.max(1, result.metadata.currentIndex + 1)
  );
  const harness = result.metadata.harness;
  return `Step ${current}/${result.metadata.totalSteps} · ${state}${harness ? ` · ${harness}` : ""}`;
}

export function workflowStatusSearchText(
  _params: WorkflowStatusParams | undefined,
  result: WorkflowStatusResult
): string[] {
  return [
    workflowStatusSummary(undefined, result),
    result.steps
      .map(
        (step) =>
          `${step.index + 1} · ${step.status} · ${step.prompt.split(/\r?\n/, 1)[0]} · ${result.metadata.harness ?? "workflow harness"}`
      )
      .concat(result.schemaWarnings.map((warning) => warning.message))
      .join("\n"),
  ];
}

function wrappedLines(text: string, width: number, fontSize: number): number {
  const charsPerLine = Math.max(16, Math.floor(width / (fontSize * 0.58)));
  return text
    .split("\n")
    .reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0
    );
}

export function estimateWorkflowStatusHeight(
  _params: WorkflowStatusParams | undefined,
  result: WorkflowStatusResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const available = Math.max(160, width ?? 640);
  const tableLines = result.steps.reduce(
    (sum, step) =>
      sum +
      wrappedLines(
        `${step.index + 1} · ${step.status} · ${step.prompt.split(/\r?\n/, 1)[0]} · ${result.metadata.harness ?? "workflow harness"}`,
        available,
        fontSize
      ),
    0
  );
  const warnings = result.schemaWarnings.reduce(
    (sum, warning) => sum + wrappedLines(warning.message, available, fontSize),
    0
  );
  return (
    72 +
    result.steps.length * 10 +
    tableLines * fontSize * 1.45 +
    warnings * fontSize * 1.45 +
    rawHeight
  );
}

export function workflowStatusProgress(result: WorkflowStatusResult): number {
  if (result.metadata.totalSteps <= 0) return 0;
  return Math.min(
    100,
    Math.max(
      0,
      (result.metadata.completedSteps / result.metadata.totalSteps) * 100
    )
  );
}

export function workflowStepStatus(
  value: string
): (typeof STEP_STATUS)[keyof typeof STEP_STATUS] {
  const allowed = Object.values(STEP_STATUS) as string[];
  return allowed.includes(value)
    ? (value as (typeof STEP_STATUS)[keyof typeof STEP_STATUS])
    : STEP_STATUS.PENDING;
}
