import { describe, expect, it } from "vitest";
import {
  addStepRange,
  collapseStepSelection,
  normalizeStepIndices,
  selectAllSteps,
  selectStepRange,
  toggleStepIndex,
} from "@utils/stepMultiSelection";

describe("stepMultiSelection", () => {
  it("selects an inclusive range in either direction", () => {
    expect(selectStepRange(1, 4, 6)).toEqual([1, 2, 3, 4]);
    expect(selectStepRange(4, 1, 6)).toEqual([1, 2, 3, 4]);
  });

  it("toggles an index and returns sorted, unique values", () => {
    expect(toggleStepIndex([3, 1, 3], 2, 5)).toEqual([1, 2, 3]);
    expect(toggleStepIndex([1, 2, 3], 2, 5)).toEqual([1, 3]);
    expect(normalizeStepIndices([4, -1, 2, 2, 7], 5)).toEqual([2, 4]);
  });

  it("adds a range to the existing selection", () => {
    expect(addStepRange([0, 4], 2, 3, 6)).toEqual([0, 2, 3, 4]);
  });

  it("selects every queue index and collapses selections under two", () => {
    expect(selectAllSteps(4)).toEqual([0, 1, 2, 3]);
    expect(selectAllSteps(0)).toEqual([]);
    expect(collapseStepSelection({ indices: [1, 2], anchorIndex: 1 })).toEqual({
      indices: [1, 2],
      anchorIndex: 1,
    });
    expect(collapseStepSelection({ indices: [1], anchorIndex: 1 })).toBeNull();
    expect(collapseStepSelection(null)).toBeNull();
  });
});
