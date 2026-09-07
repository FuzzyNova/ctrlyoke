/**
 * The compact, whole-run representation of diff overlays used by the
 * minimap. This input is deliberately structural so a future summary pass
 * can produce the same bars without constructing view-specific MinimapStep
 * objects.
 */
export interface MinimapBarRun {
  count: number;
  addedLines: number;
  removedLines: number;
}

export interface MinimapBarBlock {
  scrollFraction: number;
  heightFraction: number;
  addedLines: number;
  removedLines: number;
  runs: readonly MinimapBarRun[];
  isCollapsed: boolean;
}

export interface MinimapBarStep {
  diffBlocks: readonly MinimapBarBlock[];
}

export interface OutputMinimapBar {
  /** Zero-based pixel row in the minimap rail. */
  row: number;
  addedLines: number;
  removedLines: number;
}

interface WeightedRow {
  row: number;
  weight: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function rowsForInterval(
  start: number,
  end: number,
  railRows: number
): WeightedRow[] {
  const clippedStart = Math.max(0, start);
  const clippedEnd = Math.min(railRows, end);
  if (clippedEnd <= clippedStart) return [];

  const rows: WeightedRow[] = [];
  for (let row = Math.floor(clippedStart); row < Math.ceil(clippedEnd); row++) {
    const weight = Math.min(clippedEnd, row + 1) - Math.max(clippedStart, row);
    if (weight > 0) rows.push({ row, weight });
  }
  return rows;
}

function allocateLines(lines: number, rows: readonly WeightedRow[]): number[] {
  if (lines <= 0 || rows.length === 0) return rows.map(() => 0);

  const totalWeight = rows.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return rows.map(() => 0);

  const exact = rows.map((entry) => (lines * entry.weight) / totalWeight);
  if (!Number.isInteger(lines)) return exact;

  const allocated = exact.map(Math.floor);
  let remainder = lines - allocated.reduce((sum, value) => sum + value, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - allocated[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of byFraction) {
    if (remainder === 0) break;
    allocated[index]++;
    remainder--;
  }
  return allocated;
}

function addContribution(
  bars: Array<{ addedLines: number; removedLines: number }>,
  start: number,
  end: number,
  addedLines: number,
  removedLines: number,
  railRows: number
): void {
  const rows = rowsForInterval(start, end, railRows);
  if (rows.length === 0) return;

  const added = allocateLines(finiteNonNegative(addedLines), rows);
  const removed = allocateLines(finiteNonNegative(removedLines), rows);
  for (let index = 0; index < rows.length; index++) {
    bars[rows[index].row].addedLines += added[index];
    bars[rows[index].row].removedLines += removed[index];
  }
}

/**
 * Projects all diff overlays onto the minimap's pixel rows.
 *
 * Each source region's line counts are distributed across the pixels it
 * occupies, preserving added/removed totals while allowing overlapping
 * blocks from different steps to accumulate in the same bar. A block's run
 * data is used when present because it is the more detailed representation
 * painted by the unquantized minimap.
 */
export function quantizeOutputMinimapBars(
  steps: readonly MinimapBarStep[],
  railHeightPx: number
): OutputMinimapBar[] {
  const railRows = Math.floor(finiteNonNegative(railHeightPx));
  if (railRows === 0) return [];

  const bars = Array.from({ length: railRows }, () => ({
    addedLines: 0,
    removedLines: 0,
  }));

  for (const step of steps) {
    for (const block of step.diffBlocks) {
      const blockStart = finiteNonNegative(block.scrollFraction) * railRows;

      if (block.isCollapsed) {
        const collapsedStart = Math.min(
          Math.max(0, blockStart),
          Math.max(0, railRows - 2)
        );
        addContribution(
          bars,
          collapsedStart,
          collapsedStart + 2,
          block.addedLines,
          block.removedLines,
          railRows
        );
        continue;
      }

      const blockHeight = Math.max(
        1,
        finiteNonNegative(block.heightFraction) * railRows
      );
      const totalRunRows = block.runs.reduce(
        (sum, run) => sum + finiteNonNegative(run.count),
        0
      );

      if (totalRunRows > 0) {
        let offsetRows = 0;
        for (const run of block.runs) {
          const runRows = finiteNonNegative(run.count);
          if (runRows > 0) {
            const runStart =
              blockStart + (offsetRows / totalRunRows) * blockHeight;
            const runEnd =
              blockStart +
              ((offsetRows + runRows) / totalRunRows) * blockHeight;
            addContribution(
              bars,
              runStart,
              runEnd,
              run.addedLines,
              run.removedLines,
              railRows
            );
          }
          offsetRows += runRows;
        }
      } else {
        addContribution(
          bars,
          blockStart,
          blockStart + blockHeight,
          block.addedLines,
          block.removedLines,
          railRows
        );
      }
    }
  }

  return bars.flatMap((bar, row) =>
    bar.addedLines > 0 || bar.removedLines > 0 ? [{ row, ...bar }] : []
  );
}
