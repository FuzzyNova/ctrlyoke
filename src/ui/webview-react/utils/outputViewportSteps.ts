import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { getTargetKey } from "@utils/outputProjection";
import type { OutputRenderRow } from "@utils/outputRows";

/**
 * A contiguous run of output rows that reads as one step: a single step's
 * output, or a whole parallel group (its members' output interleaves, so the
 * group is the unit a reader is "in").
 */
export interface OutputStepSection {
  /** First row index (inclusive). */
  startRow: number;
  /** Last row index (exclusive). */
  endRow: number;
  /**
   * Rows that may stick at the top of the pane while this section fills it, in
   * row order. Every CLI header of a step (pre-condition, prompt, retries, end
   * condition) for an ordinary step; only the group header for a parallel
   * group, whose members' own headers stay in the stream.
   */
  headerRows: number[];
}

export interface OutputStepSectionModel {
  sections: OutputStepSection[];
  /**
   * The row shown under a sticky CLI header: the prompt or command row that
   * opens the header's block, cut down to its first lines.
   */
  previewRowByHeaderRow: Map<number, number>;
}

/** The header currently stuck to the top of the pane. */
export interface OutputStickyStep {
  headerRow: number;
  previewRow?: number;
  /**
   * Upward shift (<= 0) while the section's next header pushes this one out,
   * so two headers never overlap, or while the next step's output sits within
   * one header height below the viewport, so the header slides in and out.
   */
  offsetPx: number;
}

export interface OutputViewportStepsResult {
  /** `getTargetKey` of every step with a row in the viewport, in row order. */
  inViewTargetKeys: string[];
  sticky: OutputStickyStep | null;
}

export interface ResolveOutputViewportInput {
  rows: readonly OutputRenderRow[];
  model: OutputStepSectionModel;
  rowStarts: readonly number[];
  totalSize: number;
  /** Top of the readable area (below anything pinned), in row coordinates. */
  viewportTop: number;
  /** Bottom of the readable area, in row coordinates. */
  viewportBottom: number;
  /** Rendered height of the sticky header, for the push-out offset. */
  stickyHeightPx: number;
}

const PREVIEW_ROW_KINDS: ReadonlySet<OutputRenderRow["rowKind"]> = new Set([
  OUTPUT_ROW_KINDS.PROMPT,
  OUTPUT_ROW_KINDS.CLI_COMMAND,
  OUTPUT_ROW_KINDS.SCRIPT_COMMAND,
]);

/** Rows a header's prompt/command may sit behind before it is not "its" row. */
const PREVIEW_ROW_SEARCH_LIMIT = 3;

function findPreviewRow(
  rows: readonly OutputRenderRow[],
  headerRow: number
): number | undefined {
  const header = rows[headerRow];
  const targetKey = getTargetKey(header.target);
  const limit = Math.min(rows.length, headerRow + 1 + PREVIEW_ROW_SEARCH_LIMIT);
  for (let index = headerRow + 1; index < limit; index++) {
    const row = rows[index];
    if (
      row.rowKind === OUTPUT_ROW_KINDS.CLI_HEADER ||
      getTargetKey(row.target) !== targetKey
    ) {
      return undefined;
    }
    if (PREVIEW_ROW_KINDS.has(row.rowKind)) return index;
    if (row.groupEnd) return undefined;
  }
  return undefined;
}

/**
 * Splits the rows into step sections. A queue step inside a parallel group
 * belongs to the group's section; anything else to its own target's.
 */
export function buildOutputStepSections(
  rows: readonly OutputRenderRow[]
): OutputStepSectionModel {
  const groupIdByQueueIndex = new Map<number, string>();
  for (const row of rows) {
    if (row.rowKind !== OUTPUT_ROW_KINDS.PARALLEL_GROUP_HEADER) continue;
    for (let index = row.startIndex; index <= row.endIndex; index++) {
      groupIdByQueueIndex.set(index, row.groupId);
    }
  }

  const sections: OutputStepSection[] = [];
  const previewRowByHeaderRow = new Map<number, number>();
  let currentId: string | null = null;
  let current: (OutputStepSection & { isGroup: boolean }) | null = null;

  rows.forEach((row, index) => {
    const groupId =
      row.target.kind === FINAL_STEP_PHASES.QUEUE
        ? groupIdByQueueIndex.get(row.target.index)
        : undefined;
    const sectionId =
      groupId !== undefined ? `group:${groupId}` : getTargetKey(row.target);
    if (sectionId !== currentId || !current) {
      current = {
        startRow: index,
        endRow: index + 1,
        headerRows: [],
        isGroup: groupId !== undefined,
      };
      sections.push(current);
      currentId = sectionId;
    } else {
      current.endRow = index + 1;
    }

    if (current.isGroup) {
      if (row.rowKind === OUTPUT_ROW_KINDS.PARALLEL_GROUP_HEADER) {
        current.headerRows.push(index);
      }
    } else if (row.rowKind === OUTPUT_ROW_KINDS.CLI_HEADER) {
      current.headerRows.push(index);
      const previewRow = findPreviewRow(rows, index);
      if (previewRow !== undefined) {
        previewRowByHeaderRow.set(index, previewRow);
      }
    }
  });

  return {
    sections: sections.map(({ startRow, endRow, headerRows }) => ({
      startRow,
      endRow,
      headerRows,
    })),
    previewRowByHeaderRow,
  };
}

/** Index of the last row starting at or before `offset` (0 when none does). */
function findRowAt(rowStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = rowStarts.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rowStarts[mid] <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function findSectionContaining(
  sections: readonly OutputStepSection[],
  rowIndex: number
): OutputStepSection | undefined {
  let low = 0;
  let high = sections.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const section = sections[mid];
    if (rowIndex < section.startRow) high = mid - 1;
    else if (rowIndex >= section.endRow) low = mid + 1;
    else return section;
  }
  return undefined;
}

/**
 * Which steps are on screen, and which header (if any) sticks at the top.
 *
 * A header sticks only while its section is the *only* one in view and the
 * header itself has scrolled above the top: with a second step on screen there
 * is nothing to disambiguate, and once the real header is back in view the
 * sticky copy steps aside for it — which, because the copy is drawn exactly
 * where the real header lands, reads as the header falling back into place.
 */
export function resolveOutputViewportSteps({
  rows,
  model,
  rowStarts,
  totalSize,
  viewportTop,
  viewportBottom,
  stickyHeightPx,
}: ResolveOutputViewportInput): OutputViewportStepsResult {
  if (
    rows.length === 0 ||
    rowStarts.length < rows.length ||
    viewportBottom <= viewportTop
  ) {
    return { inViewTargetKeys: [], sticky: null };
  }

  const rowEnd = (index: number) =>
    index + 1 < rows.length ? rowStarts[index + 1] : totalSize;
  let firstRow = findRowAt(rowStarts, viewportTop);
  // Skip zero-height rows ending exactly at the top edge.
  while (firstRow < rows.length - 1 && rowEnd(firstRow) <= viewportTop) {
    firstRow++;
  }
  const lastRow = Math.max(
    firstRow,
    findRowAt(rowStarts, Math.max(viewportTop, viewportBottom - 1))
  );

  const inViewTargetKeys: string[] = [];
  const seen = new Set<string>();
  for (let index = firstRow; index <= lastRow; index++) {
    const key = getTargetKey(rows[index].target);
    if (seen.has(key)) continue;
    seen.add(key);
    inViewTargetKeys.push(key);
  }

  const section = findSectionContaining(model.sections, firstRow);
  if (!section || lastRow >= section.endRow) {
    return { inViewTargetKeys, sticky: null };
  }

  let headerPosition = -1;
  for (let i = section.headerRows.length - 1; i >= 0; i--) {
    if (rowStarts[section.headerRows[i]] < viewportTop) {
      headerPosition = i;
      break;
    }
  }
  if (headerPosition < 0) {
    return { inViewTargetKeys, sticky: null };
  }

  const headerRow = section.headerRows[headerPosition];
  const nextHeaderRow = section.headerRows[headerPosition + 1];
  const pushOffsetPx =
    nextHeaderRow === undefined
      ? 0
      : Math.min(0, rowStarts[nextHeaderRow] - viewportTop - stickyHeightPx);
  // The next step's output is just below the bottom edge: tie the header to
  // that distance, so scrolling up past a step boundary slides it in from the
  // top over its own height instead of popping in the moment the lower step
  // leaves, and scrolling down slides it back out before that step arrives.
  const revealOffsetPx =
    section.endRow < rows.length
      ? Math.min(0, rowStarts[section.endRow] - viewportBottom - stickyHeightPx)
      : 0;
  const offsetPx = Math.min(pushOffsetPx, revealOffsetPx);

  return {
    inViewTargetKeys,
    sticky: {
      headerRow,
      previewRow: model.previewRowByHeaderRow.get(headerRow),
      offsetPx,
    },
  };
}
