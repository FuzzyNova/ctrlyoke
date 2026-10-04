import { isRecord, tryParseJson } from "./shared";
import { MCP_REORDER_STEPS_TOOL_NAME } from "../McpToolDefinitions";
import { displayIndex, parseIndex } from "./stepMutationShared";

export interface ReorderStepsParams {
  indices: number[];
}
export interface ReorderStepsResult {
  changed?: boolean;
  note?: string;
  indices: number[];
  newQueueSize?: number;
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
    const raw: unknown = tryParseJson(text);
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
      ...(typeof raw.changed === "boolean" ? { changed: raw.changed } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      indices: (raw.indices as number[] | undefined) ?? [],
      ...(parseIndex(raw.newQueueSize) !== undefined
        ? { newQueueSize: raw.newQueueSize as number }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function reorderStepPairs(
  params: ReorderStepsParams | undefined,
  result: ReorderStepsResult
): string[] {
  const indices = params?.indices.length ? params.indices : result.indices;
  if (result.changed === false) return [];
  const slots = [...indices].sort((left, right) => left - right);
  return indices.map(
    (from, position) =>
      `${displayIndex(from)} → ${displayIndex(slots[position])}`
  );
}

export function reorderStepsSummary(
  params: ReorderStepsParams | undefined,
  result: ReorderStepsResult
): string {
  if (result.changed === false) return "No change";
  const count =
    params?.indices.length || result.indices.length || result.newQueueSize;
  return `Reordered ${count ?? 0} ${count === 1 ? "step" : "steps"}`;
}

export function reorderStepsSearchText(
  params: ReorderStepsParams | undefined,
  result: ReorderStepsResult
): string[] {
  return result.changed === false
    ? ["No change", ...(result.note ? [result.note] : [])]
    : [
        reorderStepsSummary(params, result),
        reorderStepPairs(params, result).join("\n"),
      ];
}
