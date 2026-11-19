import type { CliOutput } from "../types/WebviewMessageTypes";

/** How full the model's context window is, in tokens. */
export interface OutputContextWindow {
  used: number;
  size: number;
}

type ContextWindowSource = Pick<CliOutput, "tokens" | "contextWindow">;

/**
 * The context window an attempt's output should display: a reading observed
 * after the attempt recorded its own usage (`contextWindow`, from a
 * post-completion follow-up turn) wins over the one in its recorded `tokens`.
 * Single source for every reader, so the step card, chip rail, output footer
 * and exports agree.
 */
export function getOutputContextWindow(
  output: ContextWindowSource | null | undefined
): OutputContextWindow | undefined {
  if (output?.contextWindow?.size) {
    return output.contextWindow;
  }
  const size = output?.tokens?.contextWindowSize;
  return size
    ? { used: output.tokens?.contextWindowUsed ?? 0, size }
    : undefined;
}

/** True when the output's own recorded usage includes a context window. */
export function hasRecordedContextWindow(
  output: ContextWindowSource | undefined
): boolean {
  return !!output?.tokens?.contextWindowSize;
}

/**
 * Attach a context window observed by a post-completion follow-up. It is kept
 * beside `tokens` rather than written into them: an attempt that recorded no
 * usage has no `tokens` to update, and a context-only `TokenStats` would read
 * as a zero-token attempt in totals, footers and `history show --json`.
 */
export function withFollowUpContextWindow<T extends CliOutput>(
  output: T,
  contextWindow: OutputContextWindow | undefined
): T {
  if (!contextWindow?.size) {
    return output;
  }
  return {
    ...output,
    contextWindow: { used: contextWindow.used, size: contextWindow.size },
  };
}
