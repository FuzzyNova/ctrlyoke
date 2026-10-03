import {
  DIFF_VIEW_TYPES,
  type DiffViewType,
} from "@root/types/DashboardConstants";
import { formatBytes } from "./number";

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

/**
 * `ActivityAttribution`'s "⚡ Step N · name" label above the first row of an
 * activity slice: a `text-xs` line (16px, measured) plus `mb-1`. It is a fixed
 * cost the row's own content estimate cannot see, so it is charged here.
 *
 * The identity bar is an inset box shadow, so it adds no measured geometry and
 * does not need an estimator allowance.
 */
export const OUTPUT_ROW_ACTIVITY_LABEL_HEIGHT = 20;

/** Fallback output font size when a caller has no `uiStore.outputFontSize` to hand. */
export const DEFAULT_OUTPUT_FONT_SIZE = 13;
/** Fallback pane width when the output pane has not been measured yet. */
export const DEFAULT_OUTPUT_CONTENT_WIDTH = 760;
/** Never estimate against a width narrower than this — it explodes line counts. */
export const MIN_OUTPUT_CONTENT_WIDTH = 240;
/** Width bucket used to avoid retaining one geometry entry per pixel resize. */
export const OUTPUT_CONTENT_WIDTH_BUCKET = 32;
/** Minimum output width before diffs use split view. */
export const DIFF_SPLIT_VIEW_THRESHOLD = 1024;

/** Floor a pane width to the shared geometry bucket. */
export function bucketOutputContentWidth(width: number): number {
  return Math.floor(width / OUTPUT_CONTENT_WIDTH_BUCKET);
}

/**
 * Output-section header breakpoint shared by the header layout and dense
 * tool-call controls. Keep the control labels visible until the header enters
 * the same narrow layout tier.
 */
export const OUTPUT_SECTION_HEADER_NARROW_THRESHOLD = 650;

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
 * render at `--cy-output-font-size-sm` = base − 1px.
 */
export function toolResultLineHeight(outputFontSize: number): number {
  return (outputFontSize - 1) * OUTPUT_RELAXED_LINE_HEIGHT;
}

/**
 * `line-height` on react-diff-view's `.diff-line`. Unlike the ● block's
 * `leading-relaxed`, this one comes from the vendored stylesheet
 * (`react-diff-view/style/index.css`), which globals.css theme-maps but never
 * overrides.
 */
export const DIFF_LINE_HEIGHT = 1.5;

/**
 * Height of one rendered diff row, derived rather than calibrated: globals.css
 * sets `.diff { font-size: var(--cy-output-font-size-sm) }` (base − 1) and the
 * vendored `.diff-line { line-height: 1.5 }` is never overridden, so at the
 * default 13px base a diff row is exactly 18px. The 2026-08-13 profiler log
 * corroborates it — the diff bodies large enough to swamp their chrome measured
 * 3006 = 18×167, 2124 = 18×118, 504 = 18×28, 396 = 18×22 and 288 = 18×16.
 *
 * Because the height is exact, a residual on a diff estimate is always a wrong
 * **row count** (wrapping, gaps, view type), never a wrong row height.
 */
export function diffLineHeight(outputFontSize: number): number {
  return (outputFontSize - 1) * DIFF_LINE_HEIGHT;
}

/** `py-0.5` on DiffView's gap decoration bar (Tailwind's default spacing scale, unoverridden here). */
export const DIFF_GAP_DECORATION_VERTICAL_PADDING = 4;

/**
 * Height of one "Show N hidden lines" gap decoration bar between hunks.
 * Renders outside `.diff-line` (it is DiffView's own markup, not react-diff-view's
 * vendored row CSS), at the same `text-[length:var(--cy-output-font-size-xs)]`
 * class as the diff's own header line — so it shares that line's already-measured
 * `leading-relaxed` line height, plus its own `py-0.5` the header line doesn't have.
 */
export function diffGapDecorationHeight(outputFontSize: number): number {
  return (
    (outputFontSize - 2) * OUTPUT_RELAXED_LINE_HEIGHT +
    DIFF_GAP_DECORATION_VERTICAL_PADDING
  );
}

/**
 * Advance width of one glyph in the diff table's monospace font, which is what
 * `ch` resolves to inside it. `.diff` renders at `--cy-output-font-size-sm`
 * (base − 1) in `--vscode-editor-font-family`; 0.55em is Consolas, the Windows
 * VS Code default, and the other common editor faces sit within a few percent
 * of it.
 */
export function diffCharWidth(outputFontSize: number): number {
  return Math.max(5.5, (outputFontSize - 1) * 0.55);
}

/**
 * Horizontal space the diff table spends on anything that is not code.
 *
 * Every term is read off the DOM rather than fitted. `.diff-gutter-col` is
 * `width: 7ch` and *both* view types render two of them (unified numbers old
 * and new in separate columns; split gives each side its own). `.diff-code`
 * carries `padding: 0 0 0 .5em`, once per code column — one unified, two split.
 * The table sits inside a 1px-bordered wrapper, itself inside OutputRow's
 * `px-[var(--spacing-md)]`; the ● gutter is *not* subtracted, because diffs
 * render through ToolCallBlock's `fullBleed` slot and span it.
 *
 * The constants this replaced (168 unified / 224 split, plus a 24px "column
 * gap" a `table-layout: fixed` table does not have) overstated it by ~50px,
 * which on a phone is 13% of the pane. Every diff in the 2026-08-13 03:54 log
 * that was built at a known width over-predicted by 15-20% as a result — 598
 * vs 524, 440 vs 378, 753 vs 666, 550 vs 468 — all in the same direction,
 * which is the signature of lost width rather than of a bad wrap model.
 */
export function diffHorizontalChrome(
  viewType: DiffViewType,
  outputFontSize: number
): number {
  const codeColumns = diffCodeColumns(viewType);
  return (
    OUTPUT_ROW_HORIZONTAL_PADDING +
    DIFF_WRAPPER_BORDER_WIDTH +
    DIFF_GUTTER_COLUMNS *
      DIFF_GUTTER_COLUMN_CH *
      diffCharWidth(outputFontSize) +
    codeColumns * DIFF_CODE_CELL_PADDING_EM * (outputFontSize - 1)
  );
}

/** Code columns the diff table renders: one for unified, one per side for split. */
export function diffCodeColumns(viewType: DiffViewType): number {
  return viewType === DIFF_VIEW_TYPES.SPLIT ? 2 : 1;
}

/** `.diff-gutter-col { width: 7ch }`, rendered twice by both view types. */
const DIFF_GUTTER_COLUMNS = 2;
const DIFF_GUTTER_COLUMN_CH = 7;
/** `.diff-code { padding: 0 0 0 .5em }`. */
const DIFF_CODE_CELL_PADDING_EM = 0.5;
/** The `border` on DiffView's `overflow-x-auto` wrapper, both edges. */
const DIFF_WRAPPER_BORDER_WIDTH = 2;
/** Never wrap against a code column narrower than this — it explodes row counts. */
export const MIN_DIFF_CODE_COLUMN_WIDTH = 120;

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

/** `Wrote (1.5 KB)` — the completed file-write header label, shared with its estimator. */
export function fileWriteActionLabel(content?: string): string {
  return content
    ? `Wrote (${formatBytes(new TextEncoder().encode(content).length)})`
    : "Wrote";
}

/**
 * Flex basis, in `ch`, of a file-operation header's path. The header is a
 * wrapping flex row, so when fewer than this many columns remain beside the
 * action label the path drops onto its own line instead of being squeezed
 * into a sliver between the label and a trailing Undo button.
 */
export const FILE_OPERATION_PATH_MIN_CH = 20;

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
  // ("Edited", "Wrote (1.5 KB)", …) can share the path's first line — and
  // only while at least FILE_OPERATION_PATH_MIN_CH columns remain beside it.
  const besideLabelWidth =
    availableWidth - (actionLabel.length * charWidth + gapWidth);
  const pathOnOwnLine =
    besideLabelWidth < FILE_OPERATION_PATH_MIN_CH * charWidth;
  const pathWidth = pathOnOwnLine ? availableWidth : besideLabelWidth;
  const pathCharsPerLine = Math.max(8, Math.floor(pathWidth / charWidth));
  return (
    (pathOnOwnLine ? 1 : 0) +
    Math.max(1, Math.ceil(path.length / pathCharsPerLine))
  );
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

/** Height `ActivityAttribution` adds above a row that opens an activity slice. */
export function outputRowActivityChrome(row: {
  activityFirst?: boolean;
}): number {
  return row.activityFirst ? OUTPUT_ROW_ACTIVITY_LABEL_HEIGHT : 0;
}
