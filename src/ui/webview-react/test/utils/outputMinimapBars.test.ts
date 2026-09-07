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
        { row: 0, addedLines: 1, removedLines: 0 },
        { row: 1, addedLines: 1, removedLines: 0 },
        { row: 2, addedLines: 0, removedLines: 1 },
        { row: 3, addedLines: 0, removedLines: 1 },
      ].filter((bar) => bar.addedLines > 0 || bar.removedLines > 0)
    );
  });
});
