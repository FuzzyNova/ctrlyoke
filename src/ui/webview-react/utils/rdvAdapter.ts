/**
 * Adapter from ctrlyoke's internal UnifiedDiffHunk format to react-diff-view's HunkData format.
 *
 * Two entry points:
 *  - toRdvHunks()              — structured patch (e.g. from Claude) → HunkData[]
 *  - toRdvFromContent()        — raw old/new file content → { hunks, diffType }
 *  - parseUnifiedDiffToFiles() — raw unified diff text (git show output) → ParsedDiffFile[]
 */
import * as DiffLib from "diff";
import { getCollapsedLinesCountBetween, parseDiff } from "react-diff-view";
import type { HunkData, ChangeData, DiffType, ViewType } from "react-diff-view";
import {
  getStructuredPatchDiffLines,
  normalizeStructuredPatch,
} from "./diffUtils";
import {
  DEFAULT_OUTPUT_CONTENT_WIDTH,
  DEFAULT_OUTPUT_FONT_SIZE,
  MIN_DIFF_CODE_COLUMN_WIDTH,
  OUTPUT_RELAXED_LINE_HEIGHT,
  diffCharWidth,
  diffCodeColumns,
  diffGapDecorationHeight,
  diffHorizontalChrome,
  diffLineHeight,
  toolCallLineHeight,
} from "./outputLineMetrics";
import type { UnifiedDiffHunk } from "../types/cliEvents";
import {
  DIFF_CHANGE_TYPES,
  DIFF_LINE_TYPES,
  DIFF_PAYLOAD_KINDS,
  DIFF_SIDES,
  DIFF_VIEW_TYPES,
  type DiffChangeType,
  type DiffSide,
  type DiffPayloadKind,
} from "@root/types/DashboardConstants";
import type {
  WorkspaceDiffEntry,
  WorkspaceImageDiffSides,
} from "@root/types/HostedWorkspaceViewerTypes";

const RDV_CHANGE_TYPES = {
  INSERT: "insert",
  DELETE: "delete",
  NORMAL: "normal",
} as const;

// ── Multi-file unified diff parsing ──────────────────────────────────────────

export interface ParsedDiffFile {
  path: string;
  oldPath?: string;
  changeType: DiffChangeType;
  language?: string;
  hunks: HunkData[];
  diffType: DiffType;
  /** Present for non-text entries merged from the hosted diff response. */
  payloadKind?: Exclude<DiffPayloadKind, typeof DIFF_PAYLOAD_KINDS.TEXT>;
  image?: WorkspaceImageDiffSides;
}

const DEV_NULL = "/dev/null";

function realPath(path: string | undefined): string | undefined {
  return path && path !== DEV_NULL ? path : undefined;
}

function languageFromPath(filePath: string): string | undefined {
  const LANGUAGE_MAP: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    json: "json",
    jsonc: "jsonc",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    mdx: "mdx",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    xml: "xml",
    svg: "xml",
    sh: "shell",
    bash: "shell",
    ps1: "powershell",
    cs: "csharp",
    java: "java",
    kt: "kotlin",
    go: "go",
    rs: "rust",
    c: "c",
    cpp: "cpp",
    rb: "ruby",
    php: "php",
    swift: "swift",
    toml: "toml",
    ini: "ini",
    sql: "sql",
    graphql: "graphql",
    gql: "graphql",
    tf: "hcl",
    txt: "plaintext",
  };
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "properties";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return LANGUAGE_MAP[ext];
}

/**
 * Parse a raw unified diff string (e.g. from `git show --stat -p`) into an array
 * of `ParsedDiffFile` entries, one per changed file. Binary-file stanzas that
 * produce no hunks are returned with an empty hunks array so callers can skip them.
 */
export function parseUnifiedDiffToFiles(unifiedDiff: string): ParsedDiffFile[] {
  if (!unifiedDiff.trim()) return [];

  const firstPatchLine = unifiedDiff.search(/^diff --git /m);
  if (firstPatchLine === -1) return [];
  const patchText = unifiedDiff.slice(firstPatchLine);

  let files;
  try {
    files = parseDiff(patchText, { nearbySequences: "zip" });
  } catch {
    return [];
  }

  return files.map((file) => {
    const oldReal = realPath(file.oldPath);
    const newReal = realPath(file.newPath);
    const path = newReal ?? oldReal ?? "";
    return {
      path,
      // gitdiff-parser reports renames as type:"modify" with differing real
      // paths, so rename detection must not depend on file.type.
      oldPath: oldReal && newReal && oldReal !== newReal ? oldReal : undefined,
      changeType: newReal
        ? oldReal
          ? oldReal !== newReal
            ? DIFF_CHANGE_TYPES.RENAMED
            : DIFF_CHANGE_TYPES.MODIFIED
          : DIFF_CHANGE_TYPES.CREATED
        : DIFF_CHANGE_TYPES.DELETED,
      language: languageFromPath(path),
      hunks: (file.hunks ?? []) as HunkData[],
      diffType: (file.type as DiffType) ?? "modify",
    };
  });
}

/**
 * Attach structured image/binary entries to the parsed textual diff list.
 * Binary-only stanzas are retained even when react-diff-view has no hunks for
 * them, while textual entries keep their parsed hunks and metadata.
 */
export function mergeNonTextDiffEntries(
  files: ParsedDiffFile[],
  entries: readonly WorkspaceDiffEntry[] | undefined
): ParsedDiffFile[] {
  if (!entries || entries.length === 0) return files;

  const merged = new Map(files.map((file) => [file.path, file]));
  for (const entry of entries) {
    const existing = merged.get(entry.path);
    merged.set(entry.path, {
      path: entry.path,
      oldPath: entry.oldPath ?? existing?.oldPath,
      changeType: entry.changeType,
      language: existing?.language,
      hunks: existing?.hunks ?? [],
      diffType: existing?.diffType ?? "modify",
      payloadKind:
        entry.payloadKind === DIFF_PAYLOAD_KINDS.TEXT
          ? undefined
          : entry.payloadKind,
      image: entry.image,
    });
  }

  return [...merged.values()];
}

export interface RenderedDiffRun {
  count: number;
  addedLines: number;
  removedLines: number;
}

type DiffGapExpansionModel = "none" | "exact" | "base-only-missing-old-content";

export interface DiffGapExpansionPlanState {
  model: DiffGapExpansionModel;
  requestedGaps: number;
  appliedGaps: number;
}

export interface DiffRenderPlan {
  viewType: ViewType;
  isCollapsed: boolean;
  renderedRows: number;
  addedLines: number;
  removedLines: number;
  runs: RenderedDiffRun[];
  lineHeight: number;
  toolLineHeight: number;
  headerHeight: number;
  decorationHeight: number;
  /** Collapsed "Show N hidden lines" bars still present between hunks. */
  gapDecorationRows: number;
  /** Total height those bars contribute — already folded into {@link bodyHeight}. */
  gapDecorationsHeight: number;
  bodyHeight: number;
  diffBlockHeight: number;
  totalHeight: number;
  gapExpansion: DiffGapExpansionPlanState;
}

export interface DiffRenderPlanOptions {
  viewType: ViewType;
  collapsed?: boolean;
  outputFontSize?: number;
  outputContentWidth?: number;
  hunks?: readonly HunkData[];
  layoutMode?: "file-edit" | "standalone";
  gapExpansion?: DiffGapExpansionPlanState;
  /**
   * Wrapped line count of the `● Edited <path>` header this diff hangs under.
   * A long path wraps to a second line, and that line is a third of a collapsed
   * diff row's total height — leaving it at 1 makes every such row miss by a
   * full line height.
   */
  toolHeaderLines?: number;
}

/**
 * DiffView's own frame around the summary line: `my-2` (16, of which the bottom
 * half collapses into ToolCallBlock's) plus the header's `mb-1` (4) and the
 * expanded diff container's 1px border top and bottom (2).
 */
const DIFF_VERTICAL_CHROME_HEIGHT = 28;
const STANDALONE_DIFF_HEIGHT = 72;

function getRenderedRows(runs: readonly RenderedDiffRun[]): number {
  return runs.reduce((sum, run) => sum + run.count, 0);
}

function normalizeDiffLineForLayout(line: string): string {
  return line.replace(/\r\n/g, "\n").replace(/\t/g, "    ");
}

function getWrappedVisualLineCount(line: string, charsPerLine: number): number {
  const normalized = normalizeDiffLineForLayout(line);
  if (normalized.length === 0) {
    return 1;
  }

  return normalized.split("\n").reduce((total, segment) => {
    if (segment.length === 0) {
      return total + 1;
    }
    return total + Math.max(1, Math.ceil(segment.length / charsPerLine));
  }, 0);
}

function getApproximateDiffCharsPerLine(
  viewType: ViewType,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const baseWidth =
    outputContentWidth && outputContentWidth > 0
      ? outputContentWidth
      : DEFAULT_OUTPUT_CONTENT_WIDTH;
  const codeColumns = diffCodeColumns(viewType);
  // Chrome and glyph width both come from the diff table's own CSS now — see
  // diffHorizontalChrome. The calibrated constants they replace (168 unified,
  // 224 split, plus a 24px inter-column gap that a `table-layout: fixed` table
  // does not have) charged ~50px too much, which is 13% of a phone pane and
  // made every wrap-bound estimate run long.
  const codeColumnWidth = Math.max(
    MIN_DIFF_CODE_COLUMN_WIDTH,
    (baseWidth - diffHorizontalChrome(viewType, outputFontSize)) / codeColumns
  );
  return Math.max(
    8,
    Math.floor(codeColumnWidth / diffCharWidth(outputFontSize))
  );
}

function estimateRenderedVisualRows(
  hunks: readonly HunkData[],
  viewType: ViewType,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const charsPerLine = getApproximateDiffCharsPerLine(
    viewType,
    outputContentWidth,
    outputFontSize
  );
  let visualRows = 0;

  for (const hunk of hunks) {
    if (viewType === DIFF_VIEW_TYPES.UNIFIED) {
      for (const change of hunk.changes) {
        visualRows += getWrappedVisualLineCount(change.content, charsPerLine);
      }
      continue;
    }

    for (let index = 0; index < hunk.changes.length; index++) {
      const current = hunk.changes[index];
      if (current.type === RDV_CHANGE_TYPES.NORMAL) {
        visualRows += getWrappedVisualLineCount(current.content, charsPerLine);
        continue;
      }

      if (current.type === RDV_CHANGE_TYPES.DELETE) {
        const next = hunk.changes[index + 1];
        if (next?.type === RDV_CHANGE_TYPES.INSERT) {
          visualRows += Math.max(
            getWrappedVisualLineCount(current.content, charsPerLine),
            getWrappedVisualLineCount(next.content, charsPerLine)
          );
          index++;
          continue;
        }
      }

      visualRows += getWrappedVisualLineCount(current.content, charsPerLine);
    }
  }

  return Math.max(0, visualRows);
}

/**
 * Number of collapsed "Show N hidden lines" gap bars still present in `hunks`.
 * Mirrors DiffView.tsx's own render loop exactly: a gap exists between two
 * adjacent hunks whenever `getCollapsedLinesCountBetween` is positive, and a
 * fully-expanded gap (chunk/all mode via `expandFromRawCode`) merges its two
 * hunks into one, removing the pair this counts.
 */
function countCollapsedDiffGaps(hunks: readonly HunkData[]): number {
  let count = 0;
  for (let index = 1; index < hunks.length; index++) {
    if (getCollapsedLinesCountBetween(hunks[index - 1], hunks[index]) > 0) {
      count++;
    }
  }
  return count;
}

function getDefaultGapExpansionPlanState(): DiffGapExpansionPlanState {
  return {
    model: "none",
    requestedGaps: 0,
    appliedGaps: 0,
  };
}

function isDisplayableLine(line: string): boolean {
  return !(
    line === "\\ No newline at end of file" ||
    line.startsWith("@@ ") ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ")
  );
}

export function toRdvHunks(hunks: UnifiedDiffHunk[]): HunkData[] {
  const normalized = normalizeStructuredPatch(hunks);
  return normalized.map((hunk): HunkData => {
    const changes: ChangeData[] = [];
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;

    for (const line of hunk.lines) {
      if (!isDisplayableLine(line)) continue;
      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === "+") {
        changes.push({
          type: RDV_CHANGE_TYPES.INSERT,
          isInsert: true,
          lineNumber: newLineNumber,
          content,
        });
        newLineNumber++;
      } else if (prefix === "-") {
        changes.push({
          type: RDV_CHANGE_TYPES.DELETE,
          isDelete: true,
          lineNumber: oldLineNumber,
          content,
        });
        oldLineNumber++;
      } else if (prefix === " ") {
        changes.push({
          type: RDV_CHANGE_TYPES.NORMAL,
          isNormal: true,
          oldLineNumber,
          newLineNumber,
          content,
        });
        oldLineNumber++;
        newLineNumber++;
      }
    }

    return {
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      changes,
    };
  });
}

export function toRdvFromContent(
  oldContent: string,
  newContent: string
): { hunks: HunkData[]; diffType: DiffType } {
  const old = oldContent.replace(/\r\n/g, "\n");
  const next = newContent.replace(/\r\n/g, "\n");
  const rawPatch = DiffLib.createPatch("file", old, next);
  // parseDiff requires git-diff-style header; createPatch emits Index:/=== headers instead
  const patchLines = rawPatch.split("\n");
  const gitDiff = ["diff --git a/file b/file", ...patchLines.slice(2)].join(
    "\n"
  );
  const [file] = parseDiff(gitDiff, { nearbySequences: "zip" });
  return {
    hunks: (file?.hunks ?? []) as HunkData[],
    diffType: (file?.type as DiffType) ?? "modify",
  };
}

function appendRenderedDiffRun(
  runs: RenderedDiffRun[],
  next: RenderedDiffRun
): void {
  const last = runs[runs.length - 1];
  if (
    last &&
    last.addedLines === next.addedLines &&
    last.removedLines === next.removedLines
  ) {
    last.count += next.count;
    return;
  }

  runs.push({ ...next });
}

/**
 * Convert react-diff-view hunks into the same rendered row model used by the UI.
 *
 * - `unified`: each diff change maps to one rendered row
 * - `split`: adjacent delete+insert changes share one rendered row
 */
export function getRenderedDiffStats(
  hunks: HunkData[],
  viewType: ViewType
): { added: number; removed: number; runs: RenderedDiffRun[] } {
  let added = 0;
  let removed = 0;
  const runs: RenderedDiffRun[] = [];

  const pushRow = (addedLines: number, removedLines: number) => {
    added += addedLines;
    removed += removedLines;
    appendRenderedDiffRun(runs, { count: 1, addedLines, removedLines });
  };

  for (const hunk of hunks) {
    if (viewType === DIFF_VIEW_TYPES.UNIFIED) {
      for (const change of hunk.changes) {
        if (change.type === RDV_CHANGE_TYPES.INSERT) {
          pushRow(1, 0);
        } else if (change.type === RDV_CHANGE_TYPES.DELETE) {
          pushRow(0, 1);
        } else {
          pushRow(0, 0);
        }
      }
      continue;
    }

    for (let i = 0; i < hunk.changes.length; i++) {
      const current = hunk.changes[i];

      if (current.type === RDV_CHANGE_TYPES.NORMAL) {
        pushRow(0, 0);
        continue;
      }

      if (current.type === RDV_CHANGE_TYPES.DELETE) {
        const next = hunk.changes[i + 1];
        if (next?.type === RDV_CHANGE_TYPES.INSERT) {
          pushRow(1, 1);
          i++;
          continue;
        }

        pushRow(0, 1);
        continue;
      }

      pushRow(1, 0);
    }
  }

  return { added, removed, runs };
}

export function buildDiffRenderPlanFromStats(
  stats: { added: number; removed: number; runs: RenderedDiffRun[] },
  options: DiffRenderPlanOptions
): DiffRenderPlan {
  const {
    viewType,
    collapsed = false,
    outputFontSize = DEFAULT_OUTPUT_FONT_SIZE,
    outputContentWidth,
    layoutMode = "file-edit",
    gapExpansion = getDefaultGapExpansionPlanState(),
  } = options;
  const renderedRows = getRenderedRows(stats.runs);

  if (layoutMode === "standalone") {
    return {
      viewType,
      isCollapsed: collapsed,
      renderedRows,
      addedLines: stats.added,
      removedLines: stats.removed,
      runs: stats.runs,
      lineHeight: STANDALONE_DIFF_HEIGHT,
      toolLineHeight: STANDALONE_DIFF_HEIGHT,
      headerHeight: 0,
      decorationHeight: 0,
      gapDecorationRows: 0,
      gapDecorationsHeight: 0,
      bodyHeight: 0,
      diffBlockHeight: STANDALONE_DIFF_HEIGHT,
      totalHeight: STANDALONE_DIFF_HEIGHT,
      gapExpansion,
    };
  }

  // The ● header the diff hangs under, and DiffView's own "Show diff" summary
  // line (xs font, one line — its content never wraps in practice). Both
  // inherit `leading-relaxed` from TOOL_CALL_TERMINAL.
  const toolLineHeight =
    Math.max(1, options.toolHeaderLines ?? 1) *
    toolCallLineHeight(outputFontSize);
  const headerHeight = (outputFontSize - 2) * OUTPUT_RELAXED_LINE_HEIGHT;
  // Measured geometry, not calibration — see diffLineHeight. The invented
  // `max(18, (fs - 1) * 1.55)` this replaces resolved to 18.6 at the default
  // font size against a real grid of exactly 18, quietly adding 3.3% to every
  // diff (~100px on the 167-row diff in the 2026-08-13 log), and its 18px floor
  // over-predicted every row for any base font below 13.
  const lineHeight = diffLineHeight(outputFontSize);
  const decorationHeight = DIFF_VERTICAL_CHROME_HEIGHT;
  const visualRenderedRows =
    options.hunks && options.hunks.length > 0
      ? estimateRenderedVisualRows(
          options.hunks,
          viewType,
          outputContentWidth,
          outputFontSize
        )
      : renderedRows;
  // Each collapsed gap between hunks renders its own "Show N hidden lines" bar
  // — a real row `estimateRenderedVisualRows` never walks, since it only sums
  // `hunk.changes`. A multi-hunk diff with any gap still open under-counted by
  // exactly this much.
  const gapDecorationRows = options.hunks
    ? countCollapsedDiffGaps(options.hunks)
    : 0;
  const gapDecorationsHeight = collapsed
    ? 0
    : gapDecorationRows * diffGapDecorationHeight(outputFontSize);
  const bodyHeight = collapsed
    ? 0
    : visualRenderedRows * lineHeight + gapDecorationsHeight;
  const diffBlockHeight =
    headerHeight +
    (collapsed
      ? 0
      : Math.max(1, visualRenderedRows) * lineHeight + gapDecorationsHeight);

  return {
    viewType,
    isCollapsed: collapsed,
    renderedRows,
    addedLines: stats.added,
    removedLines: stats.removed,
    runs: stats.runs,
    lineHeight,
    toolLineHeight,
    headerHeight,
    decorationHeight,
    gapDecorationRows,
    gapDecorationsHeight,
    bodyHeight,
    diffBlockHeight,
    totalHeight: toolLineHeight + headerHeight + decorationHeight + bodyHeight,
    gapExpansion,
  };
}

export function buildDiffRenderPlan(
  hunks: HunkData[],
  options: DiffRenderPlanOptions
): DiffRenderPlan {
  return buildDiffRenderPlanFromStats(
    getRenderedDiffStats(hunks, options.viewType),
    {
      ...options,
      hunks,
    }
  );
}

// ── Active find-match location ───────────────────────────────────────────────

export interface DiffActiveMatchLocation {
  /** Which react-diff-view token side (and gutter) the match's line renders on. */
  side: DiffSide;
  /** 1-based old/new line number, matching ChangeData.lineNumber conventions. */
  lineNumber: number;
  /** Offset range within the line's content (patch prefix character excluded). */
  start: number;
  end: number;
}

/**
 * Maps a "diff" find-field character offset (as produced by
 * `getStructuredPatchText` — rendered diff line content flattened and joined
 * with "\n", without prefixes or marker lines) back to the specific patch line and side it
 * falls on, so the active occurrence can be marked in react-diff-view's token
 * tree and scrolled to precisely.
 *
 * Must replay the exact same line sequence `getStructuredPatchText` searched
 * over (post `normalizeStructuredPatch` dedup) so offsets line up; it does not
 * re-derive from the (possibly gap-expanded) render hunks, which can contain
 * lines that were never part of the searched patch text.
 */
export function locateActiveDiffMatch(
  structuredPatch: UnifiedDiffHunk[] | undefined,
  matchStart: number,
  matchEnd: number
): DiffActiveMatchLocation | null {
  const diffLines = getStructuredPatchDiffLines(
    normalizeStructuredPatch(structuredPatch)
  );
  let cursor = 0;

  for (const line of diffLines) {
    const lineStart = cursor;
    const lineEnd = lineStart + line.content.length;
    cursor = lineEnd + 1; // Match the "\n" join between rendered line content.

    if (matchStart >= lineStart && matchStart < lineEnd) {
      const side: DiffSide =
        line.type === DIFF_LINE_TYPES.REMOVED ? DIFF_SIDES.OLD : DIFF_SIDES.NEW;
      return {
        side,
        lineNumber:
          side === DIFF_SIDES.OLD ? line.oldLineNum! : line.newLineNum!,
        start: matchStart - lineStart,
        end: Math.max(
          matchStart - lineStart,
          Math.min(line.content.length, matchEnd - lineStart)
        ),
      };
    }
  }

  return null;
}
