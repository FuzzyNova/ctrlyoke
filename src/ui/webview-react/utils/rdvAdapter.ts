/**
 * Adapter from FlightPath's internal UnifiedDiffHunk format to react-diff-view's HunkData format.
 *
 * Two entry points:
 *  - toRdvHunks()       — structured patch (e.g. from Claude) → HunkData[]
 *  - toRdvFromContent() — raw old/new file content → { hunks, diffType }
 */
import * as DiffLib from "diff";
import { parseDiff } from "react-diff-view";
import type { HunkData, ChangeData, DiffType, ViewType } from "react-diff-view";
import { normalizeStructuredPatch } from "./diffUtils";
import type { UnifiedDiffHunk } from "../types/cliEvents";

export interface RenderedDiffRun {
  count: number;
  addedLines: number;
  removedLines: number;
}

export type DiffGapExpansionModel =
  | "none"
  | "exact"
  | "base-only-missing-old-content";

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
  bodyHeight: number;
  diffBlockHeight: number;
  totalHeight: number;
  gapExpansion: DiffGapExpansionPlanState;
}

export interface DiffRenderPlanOptions {
  viewType: ViewType;
  collapsed?: boolean;
  outputFontSize?: number;
  layoutMode?: "file-edit" | "standalone";
  gapExpansion?: DiffGapExpansionPlanState;
}

const DEFAULT_OUTPUT_FONT_SIZE = 13;
const DIFF_VERTICAL_CHROME_HEIGHT = 28;
const STANDALONE_DIFF_HEIGHT = 72;

function getRenderedRows(runs: readonly RenderedDiffRun[]): number {
  return runs.reduce((sum, run) => sum + run.count, 0);
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
          type: "insert",
          isInsert: true,
          lineNumber: newLineNumber,
          content,
        });
        newLineNumber++;
      } else if (prefix === "-") {
        changes.push({
          type: "delete",
          isDelete: true,
          lineNumber: oldLineNumber,
          content,
        });
        oldLineNumber++;
      } else if (prefix === " ") {
        changes.push({
          type: "normal",
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
    if (viewType === "unified") {
      for (const change of hunk.changes) {
        if (change.type === "insert") {
          pushRow(1, 0);
        } else if (change.type === "delete") {
          pushRow(0, 1);
        } else {
          pushRow(0, 0);
        }
      }
      continue;
    }

    for (let i = 0; i < hunk.changes.length; i++) {
      const current = hunk.changes[i];

      if (current.type === "normal") {
        pushRow(0, 0);
        continue;
      }

      if (current.type === "delete") {
        const next = hunk.changes[i + 1];
        if (next?.type === "insert") {
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
      bodyHeight: 0,
      diffBlockHeight: STANDALONE_DIFF_HEIGHT,
      totalHeight: STANDALONE_DIFF_HEIGHT,
      gapExpansion,
    };
  }

  const toolLineHeight = Math.max(22, outputFontSize * 1.7);
  const headerHeight = Math.max(24, outputFontSize * 1.9);
  const lineHeight = Math.max(18, (outputFontSize - 1) * 1.55);
  const decorationHeight = DIFF_VERTICAL_CHROME_HEIGHT;
  const bodyHeight = collapsed ? 0 : renderedRows * lineHeight;
  const diffBlockHeight =
    headerHeight + (collapsed ? 0 : Math.max(1, renderedRows) * lineHeight);

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
  return buildDiffRenderPlanFromStats(getRenderedDiffStats(hunks, options.viewType), options);
}
