/** Remove a UTF-8 byte order mark represented as U+FEFF at the start of text. */
export function stripLeadingBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/**
 * Preview cap for a one-row-per-step listing (`ctrlyoke history steps`, the
 * MCP `workflow_status` tool), where every step's prompt is shown at once.
 */
export const STEP_LISTING_PROMPT_PREVIEW_MAX_CHARS = 120;

/**
 * A prompt's first line, capped at `maxChars` (plus a trailing ellipsis) so
 * one long single-line prompt cannot dominate a step listing.
 */
export function promptFirstLinePreview(
  prompt: string,
  maxChars: number
): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > maxChars
    ? `${firstLine.slice(0, maxChars).trimEnd()}\u2026`
    : firstLine;
}
