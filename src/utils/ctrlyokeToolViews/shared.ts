import type { ToolResult } from "../../types/CliOutputTypes";
import { getToolResultText } from "../toolResultText";
import { promptFirstLinePreview } from "../TextUtils";

export const TOOL_TERMINAL_TONES = {
  warning: "warning",
  muted: "muted",
  untrusted: "untrusted",
} as const;

export type ToolTerminalTone =
  (typeof TOOL_TERMINAL_TONES)[keyof typeof TOOL_TERMINAL_TONES];

export interface ToolTerminalLine {
  text: string;
  tone?: ToolTerminalTone;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Longest prompt preview a ctrlyoke tool view shows before truncating. */
export const TOOL_VIEW_PROMPT_PREVIEW_MAX_CHARS = 160;

/** First line of a prompt, capped so one huge single-line prompt cannot dominate a view. */
export function toolViewPromptPreview(prompt: string): string {
  return promptFirstLinePreview(prompt, TOOL_VIEW_PROMPT_PREVIEW_MAX_CHARS);
}

/** True when the preview hides part of the prompt (extra lines or characters). */
export function isToolViewPromptTruncated(prompt: string): boolean {
  return toolViewPromptPreview(prompt) !== prompt;
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
