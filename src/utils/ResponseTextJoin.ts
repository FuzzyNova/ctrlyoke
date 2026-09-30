/**
 * Single source for how discrete pieces of AI response text are stitched into
 * one `response` string — shared by the extension (response extraction,
 * follow-up persistence) and the webview (live follow-up merge, copy fallback).
 *
 * Every harness parser emits each TEXT event as a whole assistant message
 * (Claude content blocks, Codex `output_text` items, Copilot
 * `assistant.message`, OpenCode text parts, Qwen `parts`, Antigravity planner
 * responses), never a mid-sentence streaming delta, so a paragraph break
 * between pieces cannot split a word or sentence. Without it, consecutive
 * messages run together ("...in the trash.All of these...").
 */
export const RESPONSE_TEXT_SEPARATOR = "\n\n";

/**
 * Append `addition` to `existing`, inserting {@link RESPONSE_TEXT_SEPARATOR}
 * unless the boundary already has a line break (e.g. the `\n[Edited: ...]`
 * markers `extractTextFromEvents` emits). Only the boundary characters are
 * inspected, so repeated appends onto a large response stay linear.
 */
export function appendResponseText(existing: string, addition: string): string {
  if (!addition) return existing;
  if (!existing) return addition;
  if (existing.endsWith("\n") || addition.startsWith("\n")) {
    return existing + addition;
  }
  return existing + RESPONSE_TEXT_SEPARATOR + addition;
}

/** Join response pieces in order via {@link appendResponseText}. */
export function joinResponseText(parts: readonly string[]): string {
  let result = "";
  for (const part of parts) {
    result = appendResponseText(result, part);
  }
  return result;
}
