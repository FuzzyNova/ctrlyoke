import {
  isRecord,
  toolViewPromptPreview,
  tryParseJson,
  type ToolTerminalLine,
} from "./shared";
import { MCP_EDIT_STEP_TOOL_NAME } from "../McpToolDefinitions";
import {
  displayIndex,
  parseIndex,
  STEP_MUTATION_PROMPT_FIELD,
} from "./stepMutationShared";

export interface EditStepParams {
  index: number;
  updates: Record<string, unknown>;
  clearProperties: string[];
}

export interface EditStepResult {
  changed?: boolean;
  note?: string;
  index?: number;
  updates?: Record<string, unknown>;
  clearProperties: string[];
  before?: Record<string, unknown>;
  name?: string;
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
    const raw: unknown = tryParseJson(text);
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
      ...(typeof raw.changed === "boolean" ? { changed: raw.changed } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
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

export function editStepChangedFields(
  params: EditStepParams | undefined,
  result: EditStepResult
): string[] {
  if (result.changed === false) return [];
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
  if (result.changed === false) return "No change";
  const index = params?.index ?? result.index;
  const fields = editStepChangedFields(params, result);
  return `Edited step${index === undefined ? "" : ` ${displayIndex(index)}`}${fields.length ? ` — ${fields.join(", ")}` : ""}`;
}

export function editStepSearchText(
  params: EditStepParams | undefined,
  result: EditStepResult
): string[] {
  if (result.changed === false)
    return ["No change", ...(result.note ? [result.note] : [])];
  const updates = params?.updates ?? result.updates ?? {};
  const clears = params?.clearProperties?.length
    ? params.clearProperties
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
    editStepSummary(params, result),
    [...details, ...(prompt === undefined ? [] : [prompt])]
      .filter(Boolean)
      .join("\n"),
  ];
}

export function editStepTerminalLines(
  params: EditStepParams | undefined,
  result: EditStepResult
): ToolTerminalLine[] {
  if (result.changed === false)
    return result.note ? [{ text: result.note }] : [];
  const updates = params?.updates ?? result.updates ?? {};
  const clears = params?.clearProperties?.length
    ? params.clearProperties
    : result.clearProperties;
  const lines = Object.entries(updates)
    .filter(([key]) => key !== STEP_MUTATION_PROMPT_FIELD)
    .map(([key, value]) => `${key}: ${String(value)}`);
  lines.push(...clears.map((key) => `${key}: inherited default`));
  const prompt = updates.prompt;
  if (typeof prompt === "string")
    lines.push(`prompt: ${toolViewPromptPreview(prompt)}`);
  return lines.map((text) => ({ text }));
}
