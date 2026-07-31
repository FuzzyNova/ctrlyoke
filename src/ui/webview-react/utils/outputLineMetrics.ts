/**
 * Measured DOM geometry of the output pane's rows.
 *
 * Every number here is a real CSS value read off the rendered markup, not a
 * calibrated fudge factor — which is why row estimators must prefer these over
 * inventing their own multipliers. Validated against profiler measurements:
 * a ● block's height is exactly
 *
 *   TOOL_CALL_BLOCK_VERTICAL_CHROME
 *     + headerLines * toolCallLineHeight(fs)
 *     + resultLines * toolResultLineHeight(fs)
 *
 * for every bash/file-operation row in a profiling session (zero residual).
 */

/**
 * Tailwind `leading-relaxed`, set once on `TOOL_CALL_TERMINAL` and inherited by
 * every line inside a ● block. It is unitless, so each element resolves it
 * against its *own* font size — which is why header and body lines differ.
 */
export const OUTPUT_RELAXED_LINE_HEIGHT = 1.625;

/** ToolCallBlock's `my-2`: 8px above the header line, 8px below the last body line. */
export const TOOL_CALL_BLOCK_VERTICAL_CHROME = 16;

/** One half of {@link TOOL_CALL_BLOCK_VERTICAL_CHROME}, for estimators that add the two edges separately. */
export const TOOL_CALL_BLOCK_HALF_VERTICAL_CHROME =
  TOOL_CALL_BLOCK_VERTICAL_CHROME / 2;

/**
 * `px-[var(--spacing-md)]` on OutputRow's CLI-group wrapper — the only
 * horizontal padding a ● block sees. Body content inside ToolCallBlock carries
 * none of its own (see TOOL_RESULT_LINE in outputStyles.ts), and the gutter
 * column is subtracted separately by the caller.
 */
export const OUTPUT_ROW_HORIZONTAL_PADDING = 16;

/** `pt-[var(--spacing-sm)]` on the first row of a CLI output group. */
export const OUTPUT_ROW_GROUP_START_PADDING = 6;

/** `pb-[var(--spacing-sm)]` plus the 1px `border-b` on the last row of a CLI output group. */
export const OUTPUT_ROW_GROUP_END_PADDING = 7;

/** Fallback output font size when a caller has no `uiStore.outputFontSize` to hand. */
export const DEFAULT_OUTPUT_FONT_SIZE = 13;
/** Fallback pane width when the output pane has not been measured yet. */
export const DEFAULT_OUTPUT_CONTENT_WIDTH = 760;
/** Never estimate against a width narrower than this — it explodes line counts. */
export const MIN_OUTPUT_CONTENT_WIDTH = 240;

/** Usable text width for a row, given the pane width and the row's horizontal chrome. */
export function resolveOutputContentWidth(
  outputContentWidth: number | undefined,
  chrome: number
): number {
  const baseWidth =
    outputContentWidth && outputContentWidth > 0
      ? outputContentWidth
      : DEFAULT_OUTPUT_CONTENT_WIDTH;
  return Math.max(MIN_OUTPUT_CONTENT_WIDTH, baseWidth - chrome);
}

/**
 * Horizontal space ToolCallBlock's gutter column takes from its content: the ●
 * glyph plus the `gap-x-2` separator. Everything in the content column (header
 * text, ⎿ result/error lines, tool parameters) is narrower by this much.
 * Diffs are exempt — they render full-bleed, spanning the gutter.
 */
export function toolCallGutterWidth(outputFontSize: number): number {
  return Math.max(5.5, outputFontSize * 0.6) + 8;
}

/** Height of one ● header line (`TOOL_CALL_LINE`, base output font). */
export function toolCallLineHeight(outputFontSize: number): number {
  return outputFontSize * OUTPUT_RELAXED_LINE_HEIGHT;
}

/**
 * Height of one ⎿ body line (`TOOL_RESULT_LINE` / `TOOL_ERROR_LINE`), which
 * render at `--fp-output-font-size-sm` = base − 1px.
 */
export function toolResultLineHeight(outputFontSize: number): number {
  return (outputFontSize - 1) * OUTPUT_RELAXED_LINE_HEIGHT;
}

/**
 * Width the `⎿` marker and its `gap-1` take from a result line's text column.
 * The marker is `shrink-0`, so unlike the text it never wraps.
 */
export function toolResultPrefixWidth(outputFontSize: number): number {
  return Math.max(5.5, (outputFontSize - 1) * 0.6) + 4;
}

/**
 * Representative file-edit action label (FileOperationOutput also renders
 * "Editing" and "Edit failed:" depending on status). Only its width matters
 * here, and the header's wrap point is insensitive to the few pixels between
 * them.
 */
export const FILE_EDIT_ACTION_LABEL = "Edited";

/**
 * Wrapped line count of a `● <action> <path>` header, e.g. `● Edited src/…`.
 *
 * Lives here rather than in outputRows so the diff render plan can reuse it: a
 * file-operation row that renders a diff has the very same header, and getting
 * its line count wrong is the largest single source of estimate error on
 * collapsed diff rows.
 */
export function estimateFileOperationHeaderLines(
  actionLabel: string,
  path: string,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const availableWidth = resolveOutputContentWidth(
    outputContentWidth,
    OUTPUT_ROW_HORIZONTAL_PADDING
  );
  const charWidth = Math.max(5.5, outputFontSize * 0.6);
  const gapWidth = Math.max(4, outputFontSize * 0.35);
  // The ● is not inline — it lives in ToolCallBlock's gutter, which the caller
  // has already subtracted from outputContentWidth. Only the action label
  // ("Edited", "Wrote (N bytes)", …) still shares the path's first line.
  const pathWidth = Math.max(
    64,
    availableWidth - (actionLabel.length * charWidth + gapWidth)
  );
  const pathCharsPerLine = Math.max(8, Math.floor(pathWidth / charWidth));
  return Math.max(1, Math.ceil(path.length / pathCharsPerLine));
}

/**
 * Vertical padding OutputRow adds to a row because of where it sits in its CLI
 * group. Small, but it is the entire explanation for the `stats` (+7) and
 * `cli-header` (+6) estimate bias — those two row kinds are always a group's
 * last and first row respectively.
 */
export function outputRowGroupPadding(row: {
  groupStart?: boolean;
  groupEnd?: boolean;
}): number {
  return (
    (row.groupStart ? OUTPUT_ROW_GROUP_START_PADDING : 0) +
    (row.groupEnd ? OUTPUT_ROW_GROUP_END_PADDING : 0)
  );
}
