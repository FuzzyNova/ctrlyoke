import {
  isRecord,
  isToolViewPromptTruncated,
  toolViewPromptPreview,
  tryParseJson,
  type ToolTerminalLine,
} from "./shared";
import {
  getHarnessDisplayName,
  getHarnessShortName,
  STEP_STATUS,
  STEP_TYPES,
} from "../../types/DashboardConstants";

export interface WorkflowStatusStep {
  index: number;
  type?: (typeof STEP_TYPES)[keyof typeof STEP_TYPES];
  name?: string;
  /** The prompt's first line; `promptTruncated` marks a shortened one. */
  prompt?: string;
  promptTruncated?: boolean;
  /** The script's first line; `scriptTruncated` marks a shortened one. */
  script?: string;
  scriptTruncated?: boolean;
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

export function parseWorkflowStatusParams(
  raw: unknown
): WorkflowStatusParams | undefined {
  return isRecord(raw) ? {} : undefined;
}

export function parseWorkflowStatusResultText(
  text: string
): WorkflowStatusResult | undefined {
  try {
    const value: unknown = tryParseJson(text);
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
          (step.name === undefined || typeof step.name === "string") &&
          (step.type === undefined ||
            step.type === STEP_TYPES.PROMPT ||
            step.type === STEP_TYPES.SCRIPT) &&
          (step.type === STEP_TYPES.SCRIPT
            ? typeof step.script === "string"
            : typeof step.prompt === "string") &&
          (step.promptTruncated === undefined ||
            typeof step.promptTruncated === "boolean") &&
          (step.scriptTruncated === undefined ||
            typeof step.scriptTruncated === "boolean") &&
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
  return `Step ${current}/${result.metadata.totalSteps} · ${state}${harness ? ` · ${getHarnessDisplayName(harness)}` : ""}`;
}

export function workflowStatusStepName(step: WorkflowStatusStep): string {
  return (
    step.name ||
    toolViewPromptPreview(workflowStatusStepText(step)) ||
    `Step ${step.index + 1}`
  );
}

export function workflowStatusStepText(step: WorkflowStatusStep): string {
  return step.type === STEP_TYPES.SCRIPT
    ? (step.script ?? "")
    : (step.prompt ?? "");
}

/** Hover text for a step's row, when the row hides part of its prompt. */
export function workflowStatusStepTitle(
  step: WorkflowStatusStep
): string | undefined {
  const text = workflowStatusStepText(step);
  return step.name || isToolViewPromptTruncated(text) ? text : undefined;
}

export function workflowStatusHarnessLabel(
  result: WorkflowStatusResult,
  step?: WorkflowStatusStep
): string {
  if (step?.type === STEP_TYPES.SCRIPT) return "Script";
  const harness = result.metadata.harness;
  return harness ? getHarnessShortName(harness) : "workflow harness";
}

/** Row prefix before the step name; the view offsets find matches past it. */
export function workflowStatusRowPrefix(step: WorkflowStatusStep): string {
  return `${step.index + 1} · ${step.status} · `;
}

export function workflowStatusRowLine(
  step: WorkflowStatusStep,
  result: WorkflowStatusResult
): string {
  return `${workflowStatusRowPrefix(step)}${workflowStatusStepName(step)} · ${workflowStatusHarnessLabel(result, step)}`;
}

export function workflowStatusSearchText(
  _params: WorkflowStatusParams | undefined,
  result: WorkflowStatusResult
): string[] {
  return [
    workflowStatusSummary(undefined, result),
    result.steps
      .map((step) => workflowStatusRowLine(step, result))
      .concat(result.schemaWarnings.map((warning) => warning.message))
      .join("\n"),
  ];
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

export function workflowStatusTerminalLines(
  _params: WorkflowStatusParams | undefined,
  result: WorkflowStatusResult
): ToolTerminalLine[] {
  const progress = workflowStatusProgress(result);
  return [
    {
      text: `${result.metadata.completedSteps}/${result.metadata.totalSteps} steps complete (${Math.round(progress)}%)`,
    },
    ...result.steps.map((step) => ({
      text: workflowStatusRowLine(step, result),
    })),
    ...result.schemaWarnings.map((warning) => ({
      text: `Warning: ${warning.message}`,
    })),
  ];
}

export function workflowStepStatus(
  value: string
): (typeof STEP_STATUS)[keyof typeof STEP_STATUS] {
  const allowed = Object.values(STEP_STATUS) as string[];
  return allowed.includes(value)
    ? (value as (typeof STEP_STATUS)[keyof typeof STEP_STATUS])
    : STEP_STATUS.PENDING;
}
