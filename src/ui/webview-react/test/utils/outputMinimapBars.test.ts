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

  it("conserves added and removed totals across quantization", () => {
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              scrollFraction: 0.1,
              heightFraction: 0.4,
              addedLines: 7,
              removedLines: 3,
            }),
            makeBlock({
              scrollFraction: 0.35,
              heightFraction: 0.2,
              addedLines: 2,
              removedLines: 5,
            }),
          ],
        },
      ],
      10
    );

    expect(bars.reduce((sum, bar) => sum + bar.addedLines, 0)).toBe(9);
    expect(bars.reduce((sum, bar) => sum + bar.removedLines, 0)).toBe(8);
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

  it("quantizes run contributions within a block", () => {
    const bars = quantizeOutputMinimapBars(
      [
        {
          diffBlocks: [
            makeBlock({
              heightFraction: 1,
              runs: [
                { count: 2, addedLines: 2, removedLines: 0 },
                { count: 2, addedLines: 0, removedLines: 2 },
              ],
            }),
          ],
        },
      ],
      4
    );

    expect(bars).toEqual(
      [
        { row: 0, addedLines: 1, removedLines: 0, mixed: false },
        { row: 1, addedLines: 1, removedLines: 0, mixed: false },
        { row: 2, addedLines: 0, removedLines: 1, mixed: false },
        { row: 3, addedLines: 0, removedLines: 1, mixed: false },
      ].filter((bar) => bar.addedLines > 0 || bar.removedLines > 0)
    );
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
      { row: 0, addedLines: 1, removedLines: 1, mixed: false },
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
      { row: 0, addedLines: 1, removedLines: 1, mixed: true },
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
    expect(bars.reduce((sum, bar) => sum + bar.addedLines, 0)).toBe(4);
  });
});
