import { isRecord, tryParseJson } from "./shared";
import type { ToolTerminalLine } from "./shared";
import {
  EXECUTION_STATES,
  getHarnessDisplayName,
} from "../../types/DashboardConstants";
import { formatFinalPassBadge } from "../FinalStepLabels";

export interface GlobalStatusWorkflow {
  workflowKey: string;
  runRef: string | null;
  workflowName: string;
  executionState: string;
  harness: string | null;
  model: string | null;
  currentStep: number | null;
  finalStepPass: number | null;
  totalSteps: number;
  completedSteps: number;
}

export interface GlobalStatusResult {
  workflowCount: number;
  workflows: GlobalStatusWorkflow[];
  truncated: boolean;
  omittedCount: number;
  note?: string;
}

export interface GlobalStatusParams {
  workflowKey?: string;
  runRef?: string;
}
export function parseGlobalStatusParams(
  raw: unknown
): GlobalStatusParams | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.workflowKey !== undefined && typeof raw.workflowKey !== "string")
    return undefined;
  if (raw.runRef !== undefined && typeof raw.runRef !== "string")
    return undefined;
  return {
    ...(typeof raw.workflowKey === "string"
      ? { workflowKey: raw.workflowKey }
      : {}),
    ...(typeof raw.runRef === "string" ? { runRef: raw.runRef } : {}),
  };
}

export function parseGlobalStatusResultText(
  text: string
): GlobalStatusResult | undefined {
  try {
    const value: unknown = tryParseJson(text);
    if (
      !isRecord(value) ||
      !Number.isInteger(value.workflowCount) ||
      !Array.isArray(value.workflows) ||
      typeof value.truncated !== "boolean" ||
      !Number.isInteger(value.omittedCount)
    )
      return undefined;
    if (
      !value.workflows.every(
        (w) =>
          isRecord(w) &&
          typeof w.workflowKey === "string" &&
          typeof w.workflowName === "string" &&
          typeof w.executionState === "string" &&
          (typeof w.harness === "string" || w.harness === null) &&
          (typeof w.model === "string" || w.model === null) &&
          (Number.isInteger(w.currentStep) || w.currentStep === null) &&
          (Number.isInteger(w.finalStepPass) || w.finalStepPass === null) &&
          Number.isInteger(w.totalSteps) &&
          Number.isInteger(w.completedSteps)
      )
    )
      return undefined;
    return {
      workflowCount: value.workflowCount as number,
      workflows: value.workflows as GlobalStatusWorkflow[],
      truncated: value.truncated,
      omittedCount: value.omittedCount as number,
      ...(typeof value.note === "string" ? { note: value.note } : {}),
    };
  } catch {
    return undefined;
  }
}

export function globalStatusSummary(
  _params: GlobalStatusParams | undefined,
  result: GlobalStatusResult
): string {
  const running = result.workflows.filter(
    (workflow) => workflow.executionState === EXECUTION_STATES.RUNNING
  ).length;
  return `${result.workflowCount} workflow${result.workflowCount === 1 ? "" : "s"} (${running} running)`;
}

export function globalStatusHarnessLabel(
  workflow: GlobalStatusWorkflow
): string {
  return workflow.harness
    ? getHarnessDisplayName(workflow.harness)
    : "workflow harness";
}

export function globalStatusSearchText(
  params: GlobalStatusParams | undefined,
  result: GlobalStatusResult
): string[] {
  const lines = result.workflows.map(
    (w) =>
      `${w.executionState} · ${w.workflowName} · ${w.workflowKey} · ${w.finalStepPass === null ? `${w.currentStep}/${w.totalSteps}` : formatFinalPassBadge(w.finalStepPass)} · ${globalStatusHarnessLabel(w)}`
  );
  if (result.truncated)
    lines.push(`Truncated · ${result.omittedCount} omitted`);
  if (result.note) lines.push(result.note);
  return [globalStatusSummary(params, result), lines.join("\n")];
}

export function globalStatusTerminalLines(
  _params: GlobalStatusParams | undefined,
  result: GlobalStatusResult
): ToolTerminalLine[] {
  return result.workflows.map((workflow) => ({
    text: `${workflow.workflowName} · ${workflow.executionState} · ${globalStatusHarnessLabel(workflow)}`,
  }));
}
