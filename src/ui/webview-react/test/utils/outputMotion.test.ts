import { describe, expect, it } from "vitest";
import {
  OUTPUT_AUTOSCROLL_GLIDE_MAX_VIEWPORT_FRACTION,
  findEnteringRowKeys,
  readTranslateYPx,
  resolveAutoscrollGlideOffsetPx,
} from "@utils/outputMotion";

const rowsOf = (...keys: string[]) => keys.map((key) => ({ key }));

describe("findEnteringRowKeys", () => {
  it("returns appended keys in order", () => {
    expect(
      findEnteringRowKeys(rowsOf("a", "b"), rowsOf("a", "b", "c", "d"))
    ).toEqual(["c", "d"]);
  });

  it("returns nothing for the same rows array", () => {
    const rows = rowsOf("a", "b");
    expect(findEnteringRowKeys(rows, rows)).toEqual([]);
  });

  // A streaming response becoming its final response row is content the user
  // already saw; fading it would flash it.
  it("ignores a key that takes over the slot of a key that just disappeared", () => {
    expect(
      findEnteringRowKeys(
        rowsOf("header", "a:streaming-response"),
        rowsOf("header", "a:response", "a:stats")
      )
    ).toEqual(["a:stats"]);
  });

  it("still fades a key inserted into a slot whose previous key survived", () => {
    expect(
      findEnteringRowKeys(rowsOf("a", "c"), rowsOf("a", "b", "c"))
    ).toEqual(["b"]);
  });
});

describe("resolveAutoscrollGlideOffsetPx", () => {
  const viewportHeightPx = 600;
  const capPx =
    viewportHeightPx * OUTPUT_AUTOSCROLL_GLIDE_MAX_VIEWPORT_FRACTION;

  it("starts a glide from the applied delta", () => {
    expect(
      resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: 40,
        currentOffsetPx: 0,
        viewportHeightPx,
      })
    ).toBe(40);
  });

  it("adds the remaining offset of a running glide", () => {
    expect(
      resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: 20,
        currentOffsetPx: 15,
        viewportHeightPx,
      })
    ).toBe(35);
  });

  it("lands instantly when content shrank", () => {
    expect(
      resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: -30,
        currentOffsetPx: 0,
        viewportHeightPx,
      })
    ).toBeNull();
  });

  it("lands instantly past the viewport cap", () => {
    expect(
      resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: capPx + 1,
        currentOffsetPx: 0,
        viewportHeightPx,
      })
    ).toBeNull();
    expect(
      resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: capPx,
        currentOffsetPx: 0,
        viewportHeightPx,
      })
    ).toBe(capPx);
  });
});

describe("readTranslateYPx", () => {
  it("reads ty from a 2D and a 3D matrix", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    element.style.transform = "matrix(1, 0, 0, 1, 0, 12.5)";
    expect(readTranslateYPx(element)).toBe(12.5);
    element.style.transform =
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 7, 0, 1)";
    expect(readTranslateYPx(element)).toBe(7);
    element.remove();
  });

  it("treats no transform as zero", () => {
    const element = document.createElement("div");
    expect(readTranslateYPx(element)).toBe(0);
  });
});
