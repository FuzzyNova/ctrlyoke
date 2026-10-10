import type { DiffFileCardProps } from "../components/diff/DiffFileCard";
import type {
  DiffFileGroup,
  DiffFileListProps,
} from "../components/diff/DiffFileList";
import {
  bucketOutputContentWidth,
  DEFAULT_OUTPUT_CONTENT_WIDTH,
  DEFAULT_OUTPUT_FONT_SIZE,
} from "./outputLineMetrics";
import { countStructuredPatchDisplayLines } from "./outputUtils";
import {
  buildDiffRenderPlanFromStats,
  getRenderedDiffStats,
  toRdvHunks,
} from "./rdvAdapter";
import {
  DIFF_FILE_LIST_ROW_KINDS,
  DIFF_FILE_SOURCE_KINDS,
  DIFF_PAYLOAD_KINDS,
  DIFF_VIEW_TYPES,
  WORKSPACE_ENTRY_KINDS,
  type DiffViewType,
} from "@root/types/DashboardConstants";

/** The existing `gap-3` between list items, folded into each row's size. */
export const DIFF_FILE_LIST_ROW_GAP = 12;

/** `.border` on the card contributes one pixel on each vertical edge. */
export const DIFF_FILE_CARD_BORDER_HEIGHT = 2;

/** The header's `.border-b` contributes one pixel below its content. */
export const DIFF_FILE_CARD_HEADER_BORDER_HEIGHT = 1;

/** `.py-1` on the card header contributes 4px above and below its text. */
export const DIFF_FILE_CARD_HEADER_VERTICAL_PADDING = 8;

/** Tailwind `text-xs` resolves to a 16px line box in the card header. */
export const DIFF_FILE_CARD_HEADER_LINE_HEIGHT = 16;

/** The card header displays the basename and directory on separate lines. */
export const DIFF_FILE_CARD_PATH_LINE_COUNT = 2;

/** `.gap-0.5` separates the optional note from the path row. */
export const DIFF_FILE_CARD_NOTE_GAP = 2;

/** `DiffView` receives `outerMarginClassName="my-1"` (4px on both edges). */
export const DIFF_FILE_DIFF_VIEW_MARGIN_HEIGHT = 8;

/** Card header `px-2.5` (20px) plus note `pl-5` (20px). */
const DIFF_FILE_CARD_NOTE_HORIZONTAL_CHROME = 40;
/** Summary and heading rows use Tailwind `text-xs`'s 16px line box. */
const DIFF_FILE_LIST_TEXT_LINE_HEIGHT = 16;
/** Approximate monospace advance used by the note's `wrap-anywhere`. */
const DIFF_FILE_HEADER_CHAR_WIDTH = 0.6;
const DIFF_FILE_NON_TEXT_TOGGLE_HEIGHT = 24;
const DIFF_FILE_IMAGE_PREVIEW_HEIGHT = 256;
const DIFF_FILE_BINARY_PREVIEW_HEIGHT = 22;
/** Deferred history cards start collapsed; their unloaded body has no height. */
const DIFF_FILE_DEFERRED_PREVIEW_HEIGHT = 0;
const GROUP_KEY_SEPARATOR = "\u001f";

export interface DiffFileRowEstimateOptions {
  collapsed?: boolean;
  viewType?: DiffViewType;
  outputFontSize?: number;
  outputContentWidth?: number;
  /** `ui.wordWrap`; defaults to true. */
  wordWrap?: boolean;
}

interface DiffFileListRowBase {
  key: string;
  estimateSize: number;
  /** True when the old flex `gap-3` placed space after this row. */
  hasInterRowGap: boolean;
}

export type DiffFileListRow =
  | (DiffFileListRowBase & {
      kind: typeof DIFF_FILE_LIST_ROW_KINDS.SELECTION_SUMMARY;
      content: NonNullable<DiffFileListProps["selectionSummary"]>;
    })
  | (DiffFileListRowBase & {
      kind: typeof DIFF_FILE_LIST_ROW_KINDS.GROUP_HEADING;
      groupKey: string;
      heading: string;
      headingHint?: string;
    })
  | (DiffFileListRowBase & {
      kind: typeof WORKSPACE_ENTRY_KINDS.FILE;
      groupKey: string;
      fileKey: string;
      file: DiffFileCardProps & { key: string };
    });

interface ContentSourceMetrics {
  oldLineCount: number;
  newLineCount: number;
  lineCount: number;
  changedLineCount: number;
  hasDisplayableContent: boolean;
}

const contentSourceMetricsCache = new WeakMap<object, ContentSourceMetrics>();
const diffGeometryCache = new WeakMap<object, Map<string, number>>();

function normalizedOptions(
  options: DiffFileRowEstimateOptions
): Required<DiffFileRowEstimateOptions> {
  return {
    collapsed: options.collapsed ?? false,
    viewType: options.viewType ?? DIFF_VIEW_TYPES.UNIFIED,
    outputFontSize: options.outputFontSize ?? DEFAULT_OUTPUT_FONT_SIZE,
    outputContentWidth:
      options.outputContentWidth && options.outputContentWidth > 0
        ? options.outputContentWidth
        : DEFAULT_OUTPUT_CONTENT_WIDTH,
    wordWrap: options.wordWrap ?? true,
  };
}

function contentWidthBucket(outputContentWidth: number): number {
  return bucketOutputContentWidth(outputContentWidth);
}

function countContentLines(content: string | undefined): string[] {
  if (!content) return [];
  return content.replace(/\r\n/g, "\n").split("\n");
}

function getContentSourceMetrics(
  source: Extract<
    DiffFileCardProps["source"],
    { kind: typeof WORKSPACE_ENTRY_KINDS.CONTENT }
  >
): ContentSourceMetrics {
  const cached = contentSourceMetricsCache.get(source);
  if (cached) return cached;

  const oldLines = countContentLines(source.oldContent);
  const newLines = countContentLines(source.newContent);
  const lineCount = Math.max(oldLines.length, newLines.length);
  let changedLineCount = 0;
  for (let index = 0; index < lineCount; index++) {
    if (oldLines[index] !== newLines[index]) changedLineCount++;
  }

  const metrics: ContentSourceMetrics = {
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    lineCount,
    changedLineCount,
    hasDisplayableContent: lineCount > 0,
  };
  contentSourceMetricsCache.set(source, metrics);
  return metrics;
}

function countWrappedNoteLines(
  note: string,
  outputContentWidth: number,
  outputFontSize: number
): number {
  const availableWidth = Math.max(
    64,
    outputContentWidth - DIFF_FILE_CARD_NOTE_HORIZONTAL_CHROME
  );
  const charsPerLine = Math.max(
    8,
    Math.floor(availableWidth / (outputFontSize * DIFF_FILE_HEADER_CHAR_WIDTH))
  );
  return note.split(/\r?\n/).reduce((lineCount, line) => {
    return lineCount + Math.max(1, Math.ceil(line.length / charsPerLine));
  }, 0);
}

function estimateCardChrome(
  file: DiffFileCardProps,
  options: Required<DiffFileRowEstimateOptions>,
  hasDiffView: boolean
): number {
  const hasDirectory = file.path.includes("/") || file.path.includes("\\");
  const hasOldDirectory =
    file.oldPath?.includes("/") || file.oldPath?.includes("\\");
  const pathLineCount =
    hasDirectory || hasOldDirectory ? DIFF_FILE_CARD_PATH_LINE_COUNT : 1;
  const noteLines = file.note
    ? countWrappedNoteLines(
        file.note,
        options.outputContentWidth,
        options.outputFontSize
      )
    : 0;

  return (
    DIFF_FILE_CARD_BORDER_HEIGHT +
    DIFF_FILE_CARD_HEADER_BORDER_HEIGHT +
    DIFF_FILE_CARD_HEADER_VERTICAL_PADDING +
    pathLineCount * DIFF_FILE_CARD_HEADER_LINE_HEIGHT +
    (noteLines > 0
      ? DIFF_FILE_CARD_NOTE_GAP + noteLines * DIFF_FILE_CARD_HEADER_LINE_HEIGHT
      : 0) +
    (hasDiffView ? DIFF_FILE_DIFF_VIEW_MARGIN_HEIGHT : 0)
  );
}

function getPatchEstimate(
  file: DiffFileCardProps,
  collapsed: boolean,
  options: Required<DiffFileRowEstimateOptions>
): number {
  if (file.source.kind !== DIFF_FILE_SOURCE_KINDS.PATCH) return 0;
  const displayLineCount = countStructuredPatchDisplayLines(
    file.source.structuredPatch
  );
  if (displayLineCount === 0) return 0;

  // Structured patches are already line-structured, so deriving their hunk
  // geometry is cheap and lets the shared plan account for hidden gaps without
  // parsing raw content or tokenizing syntax.
  const hunks = toRdvHunks(file.source.structuredPatch);

  return buildDiffRenderPlanFromStats(
    {
      added: 0,
      removed: 0,
      runs: [
        {
          count: displayLineCount,
          addedLines: 0,
          removedLines: 0,
        },
      ],
    },
    {
      viewType: options.viewType,
      collapsed,
      outputFontSize: options.outputFontSize,
      outputContentWidth: options.outputContentWidth,
      hunks,
      layoutMode: "file-edit",
      wordWrap: options.wordWrap,
    }
  ).diffBlockHeight;
}

function getContentEstimate(
  file: DiffFileCardProps,
  collapsed: boolean,
  options: Required<DiffFileRowEstimateOptions>
): number {
  if (file.source.kind !== WORKSPACE_ENTRY_KINDS.CONTENT) return 0;
  const metrics = getContentSourceMetrics(file.source);
  if (!metrics.hasDisplayableContent) return 0;

  // DiffView can only build a body from a complete old/new pair. With one
  // side absent, or with identical content, it still renders its summary but
  // has no diff table below it.
  const hasDiffBody =
    file.source.oldContent !== undefined &&
    file.source.newContent !== undefined &&
    metrics.changedLineCount > 0;
  // A raw-content diff needs context around changed lines, but doing a real
  // diff here would run the expensive parser for an offscreen card. Unified
  // layout displays replacements as two rows (delete + insert), while split
  // layout pairs them into one row. Keep the allowance bounded by the source
  // line count; this is deliberately a cheap upper-bound estimate, not a diff.
  const replacementRows =
    metrics.changedLineCount *
    (options.viewType === DIFF_VIEW_TYPES.UNIFIED ? 2 : 1);
  const contextRows = Math.min(
    6,
    Math.floor(Math.max(0, metrics.lineCount - metrics.changedLineCount) * 0.15)
  );
  const estimatedRows = Math.min(
    metrics.lineCount * (options.viewType === DIFF_VIEW_TYPES.UNIFIED ? 2 : 1),
    replacementRows + contextRows
  );
  const plan = buildDiffRenderPlanFromStats(
    hasDiffBody
      ? {
          added: 0,
          removed: 0,
          runs: [
            {
              count: estimatedRows,
              addedLines: 0,
              removedLines: 0,
            },
          ],
        }
      : { added: 0, removed: 0, runs: [] },
    {
      viewType: options.viewType,
      // No-body content has only the summary line, regardless of the card's
      // expanded state. This avoids charging a synthetic diff row for it.
      collapsed: collapsed || !hasDiffBody,
      outputFontSize: options.outputFontSize,
      outputContentWidth: options.outputContentWidth,
      layoutMode: "file-edit",
    }
  );
  return plan.diffBlockHeight;
}

function getImageEstimate(file: DiffFileCardProps, collapsed: boolean): number {
  if (file.source.kind !== DIFF_PAYLOAD_KINDS.IMAGE) return 0;
  return (
    DIFF_FILE_NON_TEXT_TOGGLE_HEIGHT +
    (collapsed ? 0 : DIFF_FILE_IMAGE_PREVIEW_HEIGHT)
  );
}

function getBinaryEstimate(
  file: DiffFileCardProps,
  collapsed: boolean
): number {
  if (file.source.kind !== DIFF_PAYLOAD_KINDS.BINARY) return 0;
  return (
    DIFF_FILE_NON_TEXT_TOGGLE_HEIGHT +
    (collapsed ? 0 : DIFF_FILE_BINARY_PREVIEW_HEIGHT)
  );
}

function getDeferredEstimate(
  file: DiffFileCardProps,
  _collapsed: boolean
): number {
  return file.source.kind === DIFF_FILE_SOURCE_KINDS.DEFERRED
    ? DIFF_FILE_DEFERRED_PREVIEW_HEIGHT
    : 0;
}

function getHunkEstimate(
  file: DiffFileCardProps,
  collapsed: boolean,
  options: Required<DiffFileRowEstimateOptions>
): number {
  if (file.source.kind !== DIFF_FILE_SOURCE_KINDS.HUNKS) return 0;
  if (!file.source.hunks.some((hunk) => hunk.changes.length > 0)) return 0;

  const stats = getRenderedDiffStats(file.source.hunks, options.viewType);
  return buildDiffRenderPlanFromStats(stats, {
    viewType: options.viewType,
    collapsed,
    outputFontSize: options.outputFontSize,
    outputContentWidth: options.outputContentWidth,
    hunks: file.source.hunks,
    layoutMode: "file-edit",
    wordWrap: options.wordWrap,
  }).diffBlockHeight;
}

function getDiffBodyEstimate(
  file: DiffFileCardProps,
  options: Required<DiffFileRowEstimateOptions>
): number {
  const collapsed = options.collapsed;
  const cacheKey = [
    collapsed ? "collapsed" : "expanded",
    options.viewType,
    options.outputFontSize,
    contentWidthBucket(options.outputContentWidth),
    options.wordWrap ? "wrap" : "nowrap",
  ].join(GROUP_KEY_SEPARATOR);
  let sourceCache = diffGeometryCache.get(file.source);
  if (!sourceCache) {
    sourceCache = new Map<string, number>();
    diffGeometryCache.set(file.source, sourceCache);
  }
  const cached = sourceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const estimate =
    file.source.kind === DIFF_FILE_SOURCE_KINDS.HUNKS
      ? getHunkEstimate(file, collapsed, options)
      : file.source.kind === DIFF_FILE_SOURCE_KINDS.PATCH
        ? getPatchEstimate(file, collapsed, options)
        : file.source.kind === WORKSPACE_ENTRY_KINDS.CONTENT
          ? getContentEstimate(file, collapsed, options)
          : file.source.kind === DIFF_PAYLOAD_KINDS.IMAGE
            ? getImageEstimate(file, collapsed)
            : file.source.kind === DIFF_PAYLOAD_KINDS.BINARY
              ? getBinaryEstimate(file, collapsed)
              : getDeferredEstimate(file, collapsed);
  sourceCache.set(cacheKey, estimate);
  return estimate;
}

export function estimateDiffFileCardSize(
  file: DiffFileCardProps,
  options: DiffFileRowEstimateOptions = {}
): number {
  const resolvedOptions = normalizedOptions(options);
  const diffBodyEstimate = getDiffBodyEstimate(file, resolvedOptions);
  return (
    estimateCardChrome(file, resolvedOptions, diffBodyEstimate > 0) +
    diffBodyEstimate
  );
}

function fallbackGroupKey(group: DiffFileGroup): string {
  // File keys are the only stable identity available when a caller omits the
  // semantic group key. Heading text and array position deliberately do not
  // participate; callers with duplicate file-key sets must provide `key`.
  return `files${GROUP_KEY_SEPARATOR}${group.files
    .map((file) => file.key)
    .sort()
    .join(GROUP_KEY_SEPARATOR)}`;
}

function getGroupKey(group: DiffFileGroup): string {
  return group.key ?? fallbackGroupKey(group);
}

function hasRenderableSelectionSummary(
  selectionSummary: DiffFileListProps["selectionSummary"]
): selectionSummary is NonNullable<DiffFileListProps["selectionSummary"]> {
  return (
    selectionSummary !== undefined &&
    selectionSummary !== null &&
    selectionSummary !== false
  );
}

function headingEstimate(headingHint: string | undefined): number {
  return (
    DIFF_FILE_LIST_TEXT_LINE_HEIGHT +
    (headingHint
      ? DIFF_FILE_CARD_NOTE_GAP + DIFF_FILE_LIST_TEXT_LINE_HEIGHT
      : 0)
  );
}

function addInterRowSpacing(rows: DiffFileListRow[]): DiffFileListRow[] {
  return rows.map((row, index) => {
    const next = rows[index + 1];
    const hasInterRowGap =
      next !== undefined &&
      !(
        row.kind === DIFF_FILE_LIST_ROW_KINDS.GROUP_HEADING &&
        next.kind === WORKSPACE_ENTRY_KINDS.FILE &&
        row.groupKey === next.groupKey
      );
    return {
      ...row,
      hasInterRowGap,
      estimateSize:
        row.estimateSize + (hasInterRowGap ? DIFF_FILE_LIST_ROW_GAP : 0),
    };
  });
}

export function projectDiffFileListRows(
  props: Pick<DiffFileListProps, "groups" | "selectionSummary">,
  options: DiffFileRowEstimateOptions = {}
): DiffFileListRow[] {
  const resolvedOptions = normalizedOptions(options);
  const nonEmptyGroups = props.groups.filter((group) => group.files.length > 0);
  const rows: DiffFileListRow[] = [];

  if (hasRenderableSelectionSummary(props.selectionSummary)) {
    rows.push({
      kind: DIFF_FILE_LIST_ROW_KINDS.SELECTION_SUMMARY,
      key: DIFF_FILE_LIST_ROW_KINDS.SELECTION_SUMMARY,
      content: props.selectionSummary,
      estimateSize: DIFF_FILE_LIST_TEXT_LINE_HEIGHT,
      hasInterRowGap: false,
    });
  }

  const hasHeadings =
    nonEmptyGroups.length > 1 &&
    nonEmptyGroups.some((group) => group.heading !== undefined);

  for (const group of nonEmptyGroups) {
    const groupKey = getGroupKey(group);
    if (hasHeadings && group.heading) {
      rows.push({
        kind: DIFF_FILE_LIST_ROW_KINDS.GROUP_HEADING,
        key: `${groupKey}${GROUP_KEY_SEPARATOR}heading`,
        groupKey,
        heading: group.heading,
        ...(group.headingHint ? { headingHint: group.headingHint } : {}),
        estimateSize: headingEstimate(group.headingHint),
        hasInterRowGap: false,
      });
    }
    for (const file of group.files) {
      rows.push({
        kind: WORKSPACE_ENTRY_KINDS.FILE,
        key: `${groupKey}${GROUP_KEY_SEPARATOR}${file.key}`,
        groupKey,
        fileKey: file.key,
        file,
        estimateSize: estimateDiffFileCardSize(file, resolvedOptions),
        hasInterRowGap: false,
      });
    }
  }

  return addInterRowSpacing(rows);
}

export function diffFileListRowKey(row: DiffFileListRow): string {
  return row.key;
}

export function diffFileListRowGapClass(row: DiffFileListRow): string {
  return row.hasInterRowGap ? "pb-3" : "";
}
