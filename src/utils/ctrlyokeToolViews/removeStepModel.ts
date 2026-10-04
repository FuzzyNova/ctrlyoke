import { isRecord, tryParseJson, type ToolTerminalLine } from "./shared";
import { MCP_REMOVE_STEP_TOOL_NAME } from "../McpToolDefinitions";
import { displayIndex, parseIndex } from "./stepMutationShared";

export interface RemoveStepParams {
  index: number;
  name?: string;
}
export interface RemoveStepResult {
  changed?: boolean;
  note?: string;
  index?: number;
  name?: string;
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
    const raw: unknown = tryParseJson(text);
    if (
      !isRecord(raw) ||
      raw.success !== true ||
      (raw.operation !== undefined &&
        raw.operation !== MCP_REMOVE_STEP_TOOL_NAME)
    )
      return undefined;
    const step = isRecord(raw.removedStep) ? raw.removedStep : undefined;
    return {
      ...(typeof raw.changed === "boolean" ? { changed: raw.changed } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
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

export function removeStepSummary(
  params: RemoveStepParams | undefined,
  result: RemoveStepResult
): string {
  if (result.changed === false) return "No change";
  const index = params?.index ?? result.index;
  const name = params?.name ?? result.name;
  return `Removed step${index === undefined ? "" : ` ${displayIndex(index)}`}${name ? ` '${name}'` : ""}`;
}

export function removeStepSearchText(
  params: RemoveStepParams | undefined,
  result: RemoveStepResult
): string[] {
  return result.changed === false
    ? ["No change", ...(result.note ? [result.note] : [])]
    : [removeStepSummary(params, result)];
}

export function removeStepTerminalLines(
  _params: RemoveStepParams | undefined,
  result: RemoveStepResult
): ToolTerminalLine[] {
  return result.changed === false && result.note ? [{ text: result.note }] : [];
}
