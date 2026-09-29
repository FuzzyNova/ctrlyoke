import type { ParallelGroupInsertPlacement } from "../../../../../core/ParallelGroupTopology";
import { QUEUE_POSITION } from "@root/types/DashboardConstants";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    const parsed: unknown = JSON.parse(text);
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
  return step.prompt.split(/\r?\n/, 1)[0] ?? "";
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
  return `${formatIndex(index)} · ${step.name ?? "Step"} · ${[step.harness, step.model].filter(Boolean).join(" / ") || APPEND_STEP_DEFAULT_HARNESS_LABEL} · ${appendStepPromptPreview(step)}`;
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

function wrappedLines(text: string, width: number, fontSize: number): number {
  const charsPerLine = Math.max(12, Math.floor(width / (fontSize * 0.58)));
  return text
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0
    );
}

export function estimateAppendStepHeight(
  params: AppendStepParams | undefined,
  result: AppendStepResult,
  width: number | undefined,
  fontSize: number,
  promptsExpanded = false,
  rawHeight = 0
): number {
  const availableWidth = Math.max(160, width ?? 640);
  let height = 38;
  if (params) {
    for (const item of params.steps) {
      const grouped = "parallel" in item;
      const steps = grouped ? item.parallel : [item];
      if (grouped) height += 30;
      for (const step of steps) {
        const prompt = promptsExpanded
          ? step.prompt
          : appendStepPromptPreview(step);
        const detail = `${formatIndex(result.insertIndex)} ${step.name ?? "Step"} ${step.harness ?? "workflow harness"}${step.model ? ` / ${step.model}` : ""}`;
        height +=
          Math.max(1, wrappedLines(detail, availableWidth, fontSize)) *
          fontSize *
          1.55;
        height +=
          Math.max(1, wrappedLines(prompt, availableWidth, fontSize)) *
          fontSize *
          1.45;
        height += 12;
      }
    }
  }
  return height + rawHeight;
}
