/**
 * The compact, whole-run representation of diff overlays used by the
 * minimap. This input is deliberately structural so a future summary pass
 * can produce the same bars without constructing view-specific MinimapStep
 * objects.
 */
export interface MinimapBarRun {
  /** Rendered diff rows this run spans. */
  count: number;
  /**
   * Lines added/removed by *each row* of the run — not the run's total.
   * `appendRenderedDiffRun` merges consecutive rows that paint identically
   * and only grows `count`, so a 40-row block of insertions arrives as one
   * `{ count: 40, addedLines: 1, removedLines: 0 }` run. These two numbers
   * therefore only choose the run's color; its extent comes from `count`.
   */
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
  /**
   * How much of this pixel row is painted in each color. A source region
   * spanning the row fully contributes 1, and overlapping regions accumulate
   * — these are coverage weights, not line counts. The diff track shows
   * *where* changes sit, so every pixel a change touches gets a bar.
   */
  addedCoverage: number;
  removedCoverage: number;
  /**
   * True only when a genuinely paired (split-view delete+insert) row
   * contributed to this bar. A bar can end up with both coverages simply
   * because two unrelated solo (unified-view) runs were quantized onto the
   * same rail pixel — that case renders solid, not split, matching how a
   * unified diff never mixes colors on one row.
   */
  mixed: boolean;
}

interface WeightedRow {
  row: number;
  weight: number;
}

interface BarAccumulator {
  addedCoverage: number;
  removedCoverage: number;
  mixed: boolean;
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

/**
 * Paints `[start, end)` of the rail in the color implied by `addedLines` /
 * `removedLines`, which are read only for their ratio. Every pixel the
 * interval touches receives coverage, so a tall region reads as a solid band
 * instead of collapsing to however many lines it happens to carry.
 */
function addCoverage(
  bars: BarAccumulator[],
  start: number,
  end: number,
  addedLines: number,
  removedLines: number,
  railRows: number,
  isMixedSource: boolean
): void {
  const added = finiteNonNegative(addedLines);
  const removed = finiteNonNegative(removedLines);
  const changed = added + removed;
  // A context-only run paints nothing, exactly like the transparent run band
  // the unquantized minimap rendered for it.
  if (changed === 0) return;

  const rows = rowsForInterval(start, end, railRows);
  if (rows.length === 0) return;

  for (const { row, weight } of rows) {
    const bar = bars[row];
    bar.addedCoverage += (weight * added) / changed;
    bar.removedCoverage += (weight * removed) / changed;
    if (isMixedSource) bar.mixed = true;
  }
}

/**
 * Projects all diff overlays onto the minimap's pixel rows.
 *
 * Each source region covers the pixels it occupies in its own color, so the
 * rail reproduces the bands the unquantized minimap drew per run — the diff
 * track is a map of *where* changes are, and its bars have to line up with
 * whatever the viewport thumb is sitting over. Line counts never decide a
 * bar's extent (that comes from run row counts and block heights), only which
 * color it takes and, where colors meet inside one pixel, in what proportion.
 *
 * A bar's `mixed` flag is set only when a genuinely paired split-view row (a
 * single run carrying both added and removed lines) touches it, or for a
 * collapsed block's summary line — never merely because two unrelated solo
 * (unified-view) runs were quantized onto the same pixel. That keeps a
 * unified diff rendering solid full-width bars even when zoomed out, matching
 * the live diff view's own per-row coloring.
 */
export function quantizeOutputMinimapBars(
  steps: readonly MinimapBarStep[],
  railHeightPx: number
): OutputMinimapBar[] {
  const railRows = Math.floor(finiteNonNegative(railHeightPx));
  if (railRows === 0) return [];

  const bars: BarAccumulator[] = Array.from({ length: railRows }, () => ({
    addedCoverage: 0,
    removedCoverage: 0,
    mixed: false,
  }));

  for (const step of steps) {
    for (const block of step.diffBlocks) {
      // Clamped into [0, railRows - 1) so a block whose scrollFraction rounds
      // up to (or past) the rail's last row still starts inside bounds —
      // otherwise rowsForInterval sees an empty interval and the whole block
      // is silently dropped instead of clipped, which is exactly what makes
      // diffs near the end of a long run vanish from the rail even though the
      // scroll thumb sits right on top of them.
      const blockStart = Math.min(
        finiteNonNegative(block.scrollFraction) * railRows,
        Math.max(0, railRows - 1)
      );

      if (block.isCollapsed) {
        const collapsedStart = Math.min(blockStart, Math.max(0, railRows - 2));
        addCoverage(
          bars,
          collapsedStart,
          collapsedStart + 2,
          block.addedLines,
          block.removedLines,
          railRows,
          true
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
            addCoverage(
              bars,
              runStart,
              runEnd,
              run.addedLines,
              run.removedLines,
              railRows,
              run.addedLines > 0 && run.removedLines > 0
            );
          }
          offsetRows += runRows;
        }
        continue;
      }

      // No run detail: split the block vertically by its totals — the same
      // top-to-bottom red-then-green gradient the unquantized minimap drew.
      const blockLines =
        finiteNonNegative(block.addedLines) +
        finiteNonNegative(block.removedLines);
      if (blockLines === 0) continue;

      const removedEnd =
        blockStart +
        (blockHeight * finiteNonNegative(block.removedLines)) / blockLines;
      addCoverage(bars, blockStart, removedEnd, 0, 1, railRows, false);
      addCoverage(
        bars,
        removedEnd,
        blockStart + blockHeight,
        1,
        0,
        railRows,
        false
      );
    }
  }

  return bars.flatMap((bar, row) =>
    bar.addedCoverage > 0 || bar.removedCoverage > 0 ? [{ row, ...bar }] : []
  );
}
