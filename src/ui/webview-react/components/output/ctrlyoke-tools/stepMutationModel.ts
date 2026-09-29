import { toRdvFromContent, buildDiffRenderPlan } from "@utils/rdvAdapter";
import { DIFF_VIEW_TYPES } from "@root/types/DashboardConstants";
import {
  MCP_EDIT_STEP_TOOL_NAME,
  MCP_REMOVE_STEP_TOOL_NAME,
  MCP_REORDER_STEPS_TOOL_NAME,
} from "@root/utils/McpToolDefinitions";

export const STEP_MUTATION_PROMPT_FIELD = "prompt" as const;

export interface EditStepParams {
  index: number;
  updates: Record<string, unknown>;
  clearProperties: string[];
}

export interface EditStepResult {
  index?: number;
  updates?: Record<string, unknown>;
  clearProperties: string[];
  before?: Record<string, unknown>;
  name?: string;
}

export interface RemoveStepParams {
  index: number;
  name?: string;
}

export interface RemoveStepResult {
  index?: number;
  name?: string;
}

export interface ReorderStepsParams {
  indices: number[];
}

export interface ReorderStepsResult {
  indices: number[];
  newQueueSize?: number;
}

export interface SubmitCommitMessageParams {
  message: string;
}

export interface SubmitCommitMessageResult {
  success: true;
  outputPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIndex(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

export function parseEditStepParams(raw: unknown): EditStepParams | undefined {
  if (
    !isRecord(raw) ||
    parseIndex(raw.index) === undefined ||
    !isRecord(raw.updates)
  )
    return undefined;
  if (
    raw.clearProperties !== undefined &&
    (!Array.isArray(raw.clearProperties) ||
      !raw.clearProperties.every((item) => typeof item === "string"))
  )
    return undefined;
  return {
    index: raw.index as number,
    updates: raw.updates,
    clearProperties: (raw.clearProperties as string[] | undefined) ?? [],
  };
}

export function parseEditStepResultText(
  text: string
): EditStepResult | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (
      !isRecord(raw) ||
      raw.success !== true ||
      (raw.operation !== undefined && raw.operation !== MCP_EDIT_STEP_TOOL_NAME)
    )
      return undefined;
    if (
      raw.clearProperties !== undefined &&
      (!Array.isArray(raw.clearProperties) ||
        !raw.clearProperties.every((item) => typeof item === "string"))
    )
      return undefined;
    return {
      ...(parseIndex(raw.index) !== undefined
        ? { index: raw.index as number }
        : {}),
      ...(isRecord(raw.updates) ? { updates: raw.updates } : {}),
      clearProperties: (raw.clearProperties as string[] | undefined) ?? [],
      ...(isRecord(raw.before) ? { before: raw.before } : {}),
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    };
  } catch {
    return undefined;
  }
}

export function parseRemoveStepParams(
  raw: unknown
): RemoveStepParams | undefined {
  if (!isRecord(raw) || parseIndex(raw.index) === undefined) return undefined;
  return {
    index: raw.index as number,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
  };
}

export function parseRemoveStepResultText(
  text: string
): RemoveStepResult | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (
      !isRecord(raw) ||
      raw.success !== true ||
      (raw.operation !== undefined &&
        raw.operation !== MCP_REMOVE_STEP_TOOL_NAME)
    )
      return undefined;
    const step = isRecord(raw.removedStep) ? raw.removedStep : undefined;
    return {
      ...(parseIndex(raw.index) !== undefined
        ? { index: raw.index as number }
        : {}),
      ...(typeof raw.name === "string"
        ? { name: raw.name }
        : typeof step?.name === "string"
          ? { name: step.name }
          : {}),
    };
  } catch {
    return undefined;
  }
}

export function parseReorderStepsParams(
  raw: unknown
): ReorderStepsParams | undefined {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.indices) ||
    !raw.indices.every((index) => parseIndex(index) !== undefined)
  )
    return undefined;
  return { indices: raw.indices as number[] };
}

export function parseReorderStepsResultText(
  text: string
): ReorderStepsResult | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (
      !isRecord(raw) ||
      raw.success !== true ||
      (raw.operation !== undefined &&
        raw.operation !== MCP_REORDER_STEPS_TOOL_NAME)
    )
      return undefined;
    if (
      raw.indices !== undefined &&
      (!Array.isArray(raw.indices) ||
        !raw.indices.every((index) => parseIndex(index) !== undefined))
    )
      return undefined;
    return {
      indices: (raw.indices as number[] | undefined) ?? [],
      ...(parseIndex(raw.newQueueSize) !== undefined
        ? { newQueueSize: raw.newQueueSize as number }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function parseSubmitCommitMessageParams(
  raw: unknown
): SubmitCommitMessageParams | undefined {
  return isRecord(raw) && typeof raw.message === "string"
    ? { message: raw.message }
    : undefined;
}

export function parseSubmitCommitMessageResultText(
  text: string
): SubmitCommitMessageResult | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.success !== true) return undefined;
    return {
      success: true,
      ...(typeof raw.outputPath === "string"
        ? { outputPath: raw.outputPath }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function displayIndex(index: number): string {
  return `#${index + 1}`;
}

function stepIndex(
  params: { index: number } | undefined,
  result: { index?: number }
): number | undefined {
  return params?.index ?? result.index;
}

export function editStepChangedFields(
  params: EditStepParams | undefined,
  result: EditStepResult
): string[] {
  const updates = params?.updates ?? result.updates ?? {};
  return [
    ...Object.keys(updates),
    ...(params?.clearProperties?.length
      ? params.clearProperties
      : result.clearProperties
    ).filter((field) => !Object.prototype.hasOwnProperty.call(updates, field)),
  ];
}

export function editStepSummary(
  params: EditStepParams | undefined,
  result: EditStepResult
): string {
  const index = stepIndex(params, result);
  const fields = editStepChangedFields(params, result);
  return `Edited step${index === undefined ? "" : ` ${displayIndex(index)}`}${fields.length ? ` — ${fields.join(", ")}` : ""}`;
}

export function removeStepSummary(
  params: RemoveStepParams | undefined,
  result: RemoveStepResult
): string {
  const index = stepIndex(params, result);
  const name = params?.name ?? result.name;
  return `Removed step${index === undefined ? "" : ` ${displayIndex(index)}`}${name ? ` '${name}'` : ""}`;
}

export function reorderStepPairs(
  params: ReorderStepsParams | undefined,
  result: ReorderStepsResult
): string[] {
  const indices = params?.indices.length ? params.indices : result.indices;
  return indices.map(
    (from, to) => `${displayIndex(from)} → ${displayIndex(to)}`
  );
}

export function reorderStepsSummary(
  params: ReorderStepsParams | undefined,
  result: ReorderStepsResult
): string {
  const count =
    params?.indices.length || result.indices.length || result.newQueueSize;
  return `Reordered ${count ?? 0} ${count === 1 ? "step" : "steps"}`;
}

export function commitMessageSummary(
  params: SubmitCommitMessageParams | undefined
): string {
  const firstLine = params?.message.trim().split(/\r?\n/, 1)[0];
  return firstLine || "Submitted commit message";
}

export function stepMutationSearchText(
  params:
    | EditStepParams
    | RemoveStepParams
    | ReorderStepsParams
    | SubmitCommitMessageParams
    | undefined,
  result:
    | EditStepResult
    | RemoveStepResult
    | ReorderStepsResult
    | SubmitCommitMessageResult
): string[] {
  if ("clearProperties" in result) {
    const editParams = params && "updates" in params ? params : undefined;
    const updates = editParams?.updates ?? result.updates ?? {};
    const clears = editParams?.clearProperties?.length
      ? editParams.clearProperties
      : result.clearProperties;
    const details = Object.entries(updates).map(([key, value]) => {
      if (key === STEP_MUTATION_PROMPT_FIELD) return "prompt: updated below";
      const before = result.before?.[key];
      const change = Object.prototype.hasOwnProperty.call(
        result.before ?? {},
        key
      )
        ? `${String(before)} → ${String(value)}`
        : String(value);
      return `${key}: ${change}`;
    });
    details.push(...clears.map((key) => `${key}: inherited default`));
    const prompt =
      typeof updates.prompt === "string" ? updates.prompt : undefined;
    return [
      editStepSummary(editParams, result),
      [...details, ...(prompt === undefined ? [] : [prompt])]
        .filter(Boolean)
        .join("\n"),
    ];
  }
  if ("indices" in result)
    return [
      reorderStepsSummary(params as ReorderStepsParams | undefined, result),
      reorderStepPairs(params as ReorderStepsParams | undefined, result).join(
        "\n"
      ),
    ];
  if ("message" in (params ?? {})) {
    const message = (params as SubmitCommitMessageParams).message;
    return [commitMessageSummary(params as SubmitCommitMessageParams), message];
  }
  if ("index" in result || (params && "index" in params))
    return [
      removeStepSummary(
        params as RemoveStepParams | undefined,
        result as RemoveStepResult
      ),
    ];
  return ["Submitted commit message"];
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

export function estimateStepMutationHeight(
  params:
    | EditStepParams
    | RemoveStepParams
    | ReorderStepsParams
    | SubmitCommitMessageParams
    | undefined,
  result:
    | EditStepResult
    | RemoveStepResult
    | ReorderStepsResult
    | SubmitCommitMessageResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const availableWidth = Math.max(160, width ?? 640);
  const text = stepMutationSearchText(params, result);
  let height =
    38 +
    text.reduce(
      (sum, line) =>
        sum + wrappedLines(line, availableWidth, fontSize) * fontSize * 1.5,
      0
    );
  if ("clearProperties" in result) {
    const prompt =
      params && "updates" in params
        ? params.updates.prompt
        : result.updates?.prompt;
    if (typeof prompt === "string") {
      const oldPrompt =
        typeof result.before?.prompt === "string" ? result.before.prompt : "";
      const hunks = toRdvFromContent(oldPrompt, prompt).hunks;
      height += buildDiffRenderPlan(hunks, {
        viewType: DIFF_VIEW_TYPES.UNIFIED,
        outputFontSize: fontSize,
        outputContentWidth: availableWidth,
      }).totalHeight;
    }
  }
  if ("message" in (params ?? {}))
    height +=
      wrappedLines(
        (params as SubmitCommitMessageParams).message,
        availableWidth,
        fontSize
      ) *
        fontSize *
        1.55 +
      8;
  return height + rawHeight;
}
