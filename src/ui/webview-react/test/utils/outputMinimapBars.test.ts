import { describe, expect, it } from "vitest";
import { quantizeOutputMinimapBars } from "@utils/outputMinimapBars";

function makeBlock(
  overrides: Partial<
    Parameters<
      typeof quantizeOutputMinimapBars
    >[0][number]["diffBlocks"][number]
  > = {}
) {
  return {
    scrollFraction: 0,
    heightFraction: 1,
    addedLines: 0,
    removedLines: 0,
    runs: [],
    isCollapsed: false,
    ...overrides,
  };
}

describe("quantizeOutputMinimapBars", () => {
  it("bounds the bar count by rail height regardless of input size", () => {
    const diffBlocks = Array.from({ length: 200 }, (_, index) =>
      makeBlock({
        scrollFraction: (index % 100) / 100,
        heightFraction: 0.1,
        addedLines: 1,
      })
    );

    const bars = quantizeOutputMinimapBars([{ diffBlocks }], 20);

    expect(bars.length).toBeLessThanOrEqual(20);
  });

  it("paints every pixel a merged run spans", () => {
    // `appendRenderedDiffRun` merges consecutive identically-painted rows and
    // only grows `count`, so a 40-row insertion block arrives with
    // addedLines: 1. Treating that 1 as the run's total once collapsed the
    // whole band to a single lit pixel, leaving the rail blank under a
    // viewport that was solid green.
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              scrollFraction: 0,
              heightFraction: 1,
              addedLines: 40,
              runs: [{ count: 40, addedLines: 1, removedLines: 0 }],
            }),
          ],
        },
      ],
      10
    );

    expect(bars.map((bar) => bar.row)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bars.every((bar) => bar.addedCoverage === 1)).toBe(true);
    expect(bars.every((bar) => bar.removedCoverage === 0)).toBe(true);
  });

  it("leaves context-only runs unpainted", () => {
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              heightFraction: 1,
              addedLines: 1,
              runs: [
                { count: 1, addedLines: 1, removedLines: 0 },
                { count: 3, addedLines: 0, removedLines: 0 },
              ],
            }),
          ],
        },
      ],
      4
    );

    expect(bars.map((bar) => bar.row)).toEqual([0]);
  });

  it("returns no bars before the rail has a measurable height", () => {
    expect(
      quantizeOutputMinimapBars(
        [{ diffBlocks: [makeBlock({ addedLines: 1 })] }],
        0
      )
    ).toEqual([]);
  });

  it("produces contiguous bars when a block spans many rail rows", () => {
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              scrollFraction: 0.2,
              heightFraction: 0.5,
              addedLines: 5,
            }),
          ],
        },
      ],
      10
    );

    expect(bars.map((bar) => bar.row)).toEqual([2, 3, 4, 5, 6]);
  });

  it("splits a run-less block vertically by its totals", () => {
    // Without run detail the block keeps the unquantized minimap's
    // top-to-bottom gradient: the removed share on top, added below.
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              heightFraction: 1,
              addedLines: 6,
              removedLines: 2,
            }),
          ],
        },
      ],
      8
    );

    expect(bars.map((bar) => bar.removedCoverage > bar.addedCoverage)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("quantizes run contributions within a block", () => {
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              heightFraction: 1,
              runs: [
                { count: 2, addedLines: 1, removedLines: 0 },
                { count: 2, addedLines: 0, removedLines: 1 },
              ],
            }),
          ],
        },
      ],
      4
    );

    expect(bars).toEqual([
      { row: 0, addedCoverage: 1, removedCoverage: 0, mixed: false },
      { row: 1, addedCoverage: 1, removedCoverage: 0, mixed: false },
      { row: 2, addedCoverage: 0, removedCoverage: 1, mixed: false },
      { row: 3, addedCoverage: 0, removedCoverage: 1, mixed: false },
    ]);
  });

  it("marks a bar mixed only when a genuinely paired split-view run touches it", () => {
    // Two unrelated solo (unified-view) runs of opposite type, quantized onto
    // the same single rail row — the old per-run rendering would show
    // whichever line painted last, never a blend, so this must stay solid.
    const solo = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              heightFraction: 1,
              runs: [
                { count: 1, addedLines: 1, removedLines: 0 },
                { count: 1, addedLines: 0, removedLines: 1 },
              ],
            }),
          ],
        },
      ],
      1
    );
    expect(solo).toEqual([
      { row: 0, addedCoverage: 0.5, removedCoverage: 0.5, mixed: false },
    ]);

    // A single split-view paired delete+insert run is genuinely mixed.
    const paired = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              heightFraction: 1,
              runs: [{ count: 1, addedLines: 1, removedLines: 1 }],
            }),
          ],
        },
      ],
      1
    );
    expect(paired).toEqual([
      { row: 0, addedCoverage: 0.5, removedCoverage: 0.5, mixed: true },
    ]);
  });

  it("always marks a collapsed block's summary line mixed", () => {
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              scrollFraction: 0.5,
              addedLines: 3,
              removedLines: 1,
              isCollapsed: true,
            }),
          ],
        },
      ],
      10
    );

    expect(bars.every((bar) => bar.mixed)).toBe(true);
    expect(bars.length).toBeGreaterThan(0);
  });

  it("does not drop a block whose scrollFraction lands at or past the rail edge", () => {
    // Content near the very end of a long run can have a scrollFraction that
    // rounds up to (or past) 1 — the block must still render at least one bar
    // clipped into the rail, not vanish entirely.
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              scrollFraction: 1,
              heightFraction: 0.1,
              addedLines: 4,
            }),
          ],
        },
      ],
      10
    );

    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((bar) => bar.addedCoverage > 0)).toBe(true);
  });
});
