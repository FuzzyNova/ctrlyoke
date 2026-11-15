import type { AskUserQuestionOption } from "../../../types/CliOutputTypes";

/**
 * Shared ask-user-question option parsing helpers.
 *
 * `parseAskUserQuestionOptionRecord` normalizes object-form options used by
 * Claude, Codex, Copilot, and Antigravity. `splitDescriptionPreview` separates
 * prose from an ASCII-art preview for Qwen and OpenCode, whose question tools
 * have no `preview` field and whose models put a mockup after a blank line.
 */

/** A line that looks like part of an ASCII-art mockup rather than prose. */
const ASCII_ART_LINE = /[\\/|()<>^~_=]/;

/**
 * Normalize an object-form ask-user-question option.
 */
export function parseAskUserQuestionOptionRecord(
  raw: unknown
): AskUserQuestionOption {
  const option = (raw ?? {}) as Record<string, unknown>;
  return {
    label: typeof option.label === "string" ? option.label : "",
    description:
      typeof option.description === "string" ? option.description : undefined,
    preview: typeof option.preview === "string" ? option.preview : undefined,
  };
}

/**
 * Split an ask-user-question option description into prose and a preview
 * block. The paragraphs after the first become a preview only when they hold
 * at least two lines that look like ASCII art; otherwise the description is
 * ordinary multi-paragraph prose and is returned whole.
 */
export function splitDescriptionPreview(description: string): {
  description: string;
  preview?: string;
} {
  const paragraphs = description.split(/\r?\n\s*\r?\n/);
  if (paragraphs.length < 2) {
    return { description };
  }

  const preview = paragraphs.slice(1).join("\n\n").trimEnd();
  const asciiLines = preview
    .split(/\r?\n/)
    .filter((line) => ASCII_ART_LINE.test(line));
  if (asciiLines.length < 2) {
    return { description };
  }

  return { description: paragraphs[0].trim(), preview };
}
