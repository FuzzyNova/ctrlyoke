import { isRecord, toolViewPromptPreview, tryParseJson } from "./shared";
import type { ParallelGroupInsertPlacement } from "../../core/ParallelGroupTopology";
import {
  getHarnessShortName,
  QUEUE_POSITION,
} from "../../types/DashboardConstants";

export interface AppendStepInput {
  prompt: string;
  name?: string;
  harness?: string;
  model?: string;
}

export type AppendQueueItem =
  AppendStepInput | { parallel: AppendStepInput[]; failFast?: boolean };

export interface AppendStepParams {
  steps: AppendQueueItem[];
  position?: string | number;
}

export interface AppendStepResult {
  success: true;
  stepsAdded: number;
  insertIndex: number;
  insertedEndIndex: number;
  destination: AppendStepDestination;
  placement: ParallelGroupInsertPlacement;
  parallelGroupsAdded: Array<{
    id: string;
    startIndex: number;
    endIndex: number;
    failFast: boolean;
  }>;
  joinedParallelGroup?: {
    id: string;
    startIndex: number;
    endIndex: number;
    promoted: boolean;
  };
}

const APPEND_STEP_DESTINATIONS = {
  QUEUE: "queue",
  ACTIVE_PARALLEL_GROUP: "activeParallelGroup",
} as const;
export const APPEND_STEP_DEFAULT_HARNESS_LABEL = "Workflow default";

type AppendStepDestination =
  (typeof APPEND_STEP_DESTINATIONS)[keyof typeof APPEND_STEP_DESTINATIONS];

function parseStep(value: unknown): AppendStepInput | undefined {
  if (!isRecord(value) || typeof value.prompt !== "string") return undefined;
  return {
    prompt: value.prompt,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.harness === "string" ? { harness: value.harness } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
  };
}

export function parseAppendStepParams(
  raw: unknown
): AppendStepParams | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.steps)) return undefined;
  const steps: AppendQueueItem[] = [];
  for (const item of raw.steps) {
    if (isRecord(item) && Array.isArray(item.parallel)) {
      const parallel = item.parallel.map(parseStep);
      if (parallel.some((step) => step === undefined)) return undefined;
      steps.push({
        parallel: parallel as AppendStepInput[],
        ...(typeof item.failFast === "boolean"
          ? { failFast: item.failFast }
          : {}),
      });
    } else {
      const step = parseStep(item);
      if (!step) return undefined;
      steps.push(step);
    }
  }
  return {
    steps,
    ...(typeof raw.position === "string" || typeof raw.position === "number"
      ? { position: raw.position }
      : {}),
  };
}

export function parseAppendStepResultText(
  text: string
): AppendStepResult | undefined {
  try {
    const parsed: unknown = tryParseJson(text);
    if (
      !isRecord(parsed) ||
      parsed.success !== true ||
      !Number.isInteger(parsed.stepsAdded) ||
      !Number.isInteger(parsed.insertIndex) ||
      !Number.isInteger(parsed.insertedEndIndex) ||
      (parsed.destination !== APPEND_STEP_DESTINATIONS.QUEUE &&
        parsed.destination !==
          APPEND_STEP_DESTINATIONS.ACTIVE_PARALLEL_GROUP) ||
      !isRecord(parsed.placement) ||
      !Number.isInteger(parsed.placement.insertedIndex) ||
      !Array.isArray(parsed.parallelGroupsAdded)
    ) {
      return undefined;
    }
    const parallelGroupsAdded = parsed.parallelGroupsAdded;
    if (
      parallelGroupsAdded.some(
        (group) =>
          !isRecord(group) ||
          typeof group.id !== "string" ||
          !Number.isInteger(group.startIndex) ||
          !Number.isInteger(group.endIndex) ||
          typeof group.failFast !== "boolean"
      )
    ) {
      return undefined;
    }
    return parsed as unknown as AppendStepResult;
  } catch {
    return undefined;
  }
}

function formatIndex(index: number): string {
  return `#${index + 1}`;
}

function pluralSteps(count: number): string {
  return `${count} ${count === 1 ? "step" : "steps"}`;
}

export function appendStepSummary(
  params: AppendStepParams | undefined,
  result: AppendStepResult
): string {
  const count = pluralSteps(result.stepsAdded);
  const start = formatIndex(result.insertIndex);
  const end = formatIndex(result.insertedEndIndex);
  const range =
    result.insertIndex === result.insertedEndIndex ? start : `${start}–${end}`;
  if (!params) return `Appended ${count} at ${range}`;
  if (result.destination === APPEND_STEP_DESTINATIONS.ACTIVE_PARALLEL_GROUP) {
    return `Appended ${count} at ${start} (parallel with current)`;
  }
  const position =
    params.position === QUEUE_POSITION.NEXT ||
    params.position === QUEUE_POSITION.END
      ? params.position
      : typeof params.position === "number"
        ? `position ${params.position + 1}`
        : undefined;
  return `Appended ${count} at ${start}${position ? ` (${position})` : ""}`;
}

export function appendStepPromptPreview(step: AppendStepInput): string {
  return toolViewPromptPreview(step.prompt);
}

export function appendStepHarnessModelLabel(step: AppendStepInput): string {
  return (
    [step.harness && getHarnessShortName(step.harness), step.model]
      .filter(Boolean)
      .join(" / ") || APPEND_STEP_DEFAULT_HARNESS_LABEL
  );
}

export function appendStepParallelGroupLine(
  startIndex: number,
  endIndex: number,
  failFast: boolean
): string {
  return `Parallel group · ${formatIndex(startIndex)}–${formatIndex(endIndex)} failFast ${failFast ? "on" : "off"}`;
}

export function appendStepRowLine(
  index: number,
  step: AppendStepInput
): string {
  return `${formatIndex(index)} · ${step.name ?? "Step"} · ${appendStepHarnessModelLabel(step)} · ${appendStepPromptPreview(step)}`;
}

export function appendStepSearchText(
  params: AppendStepParams | undefined,
  result: AppendStepResult
): string[] {
  const summary = appendStepSummary(params, result);
  if (!params) return [summary];
  const lines: string[] = [];
  let index = result.insertIndex;
  for (const item of params.steps) {
    const steps = "parallel" in item ? item.parallel : [item];
    const group = "parallel" in item;
    if (group) {
      const start = index;
      lines.push(
        appendStepParallelGroupLine(
          start,
          start + steps.length - 1,
          item.failFast !== false
        )
      );
    }
    for (const step of steps) {
      lines.push(appendStepRowLine(index++, step));
    }
  }
  return [summary, lines.join("\n")];
}
