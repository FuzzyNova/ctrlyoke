import type { ToolResult } from "../../../types/cliEvents";
import { getToolResultText } from "../../../utils/toolResultText";
import type { RowFindDecoration } from "../../../utils/outputFind";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sliceFindMatches(
  matches: RowFindDecoration["matches"] | undefined,
  start: number,
  length: number
): RowFindDecoration["matches"] {
  const end = start + length;
  return (matches ?? [])
    .filter((match) => match.start < end && match.end > start)
    .map((match) => ({
      ...match,
      start: Math.max(0, match.start - start),
      end: Math.min(length, match.end - start),
    }));
}

/** Longest prompt preview a ctrlyoke tool view shows before truncating. */
export const TOOL_VIEW_PROMPT_PREVIEW_MAX_CHARS = 160;

/** First line of a prompt, capped so one huge single-line prompt cannot dominate a view. */
export function toolViewPromptPreview(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > TOOL_VIEW_PROMPT_PREVIEW_MAX_CHARS
    ? `${firstLine.slice(0, TOOL_VIEW_PROMPT_PREVIEW_MAX_CHARS).trimEnd()}…`
    : firstLine;
}

/** True when the preview hides part of the prompt (extra lines or characters). */
export function isToolViewPromptTruncated(prompt: string): boolean {
  return toolViewPromptPreview(prompt) !== prompt;
}

export function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function wrappedTextLines(
  text: string,
  width: number,
  fontSize: number,
  minimumCharsPerLine: number
): number {
  const charsPerLine = Math.max(
    minimumCharsPerLine,
    Math.floor(width / (fontSize * 0.58))
  );
  return text
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0
    );
}

const MCP_TEXT_CONTENT_TYPE = "text";

function unwrapContentText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const texts = value.flatMap((item) =>
      isRecord(item) &&
      item.type === MCP_TEXT_CONTENT_TYPE &&
      typeof item.text === "string"
        ? [item.text]
        : []
    );
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    return unwrapContentText(value.content);
  }
  return undefined;
}

/** Unwrap protocol content blocks some MCP clients store around result text. */
export function unwrapCtrlYokeToolResultText(result: ToolResult): string {
  const text = getToolResultText(result);
  const parsed = tryParseJson(text);
  return parsed === undefined ? text : (unwrapContentText(parsed) ?? text);
}
