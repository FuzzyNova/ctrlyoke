import { describe, expect, it } from "vitest";
import {
  OUTPUT_AUTOSCROLL_GLIDE_CURVE,
  OUTPUT_AUTOSCROLL_GLIDE_MAX_VIEWPORT_FRACTION,
  findEnteringRowKeys,
  resolveAutoscrollGlideCurve,
  resolveAutoscrollGlideOffsetPx,
  sampleAutoscrollGlide,
  sampleCubicBezier,
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

  it("takes a shrink back out of a running glide", () => {
    expect(
      resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: -72,
        currentOffsetPx: 96,
        viewportHeightPx,
      })
    ).toBe(24);
    expect(
      resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: -96,
        currentOffsetPx: 96,
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

describe("sampleCubicBezier", () => {
  it("matches the endpoints and a linear curve exactly", () => {
    const curve = OUTPUT_AUTOSCROLL_GLIDE_CURVE;
    expect(sampleCubicBezier(curve, 0).progress).toBeCloseTo(0, 6);
    expect(sampleCubicBezier(curve, 1).progress).toBeCloseTo(1, 6);
    const linear = { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
    expect(sampleCubicBezier(linear, 0.37).progress).toBeCloseTo(0.37, 6);
    expect(sampleCubicBezier(linear, 0.37).slope).toBeCloseTo(1, 6);
  });

  // The complaint this curve answers: the old one was at full speed almost
  // immediately. From rest it must start slow and be fastest mid-glide.
  it("eases in from rest on the glide curve", () => {
    const curve = OUTPUT_AUTOSCROLL_GLIDE_CURVE;
    expect(sampleCubicBezier(curve, 0).slope).toBeCloseTo(0, 6);
    expect(sampleCubicBezier(curve, 0.1).slope).toBeLessThan(
      sampleCubicBezier(curve, 0.4).slope
    );
  });
});

describe("resolveAutoscrollGlideCurve", () => {
  it("keeps the rest curve when nothing is moving", () => {
    expect(resolveAutoscrollGlideCurve(0, 40)).toEqual(
      OUTPUT_AUTOSCROLL_GLIDE_CURVE
    );
  });

  it.each([0.3, 1.5, 6])(
    "hands a running glide over at its speed (slope %s)",
    (slope) => {
      const offsetPx = 50;
      const speedPx = slope * offsetPx;
      const curve = resolveAutoscrollGlideCurve(speedPx, offsetPx);
      expect(curve.y1).toBeLessThanOrEqual(1);
      expect(curve.x1).toBeLessThanOrEqual(OUTPUT_AUTOSCROLL_GLIDE_CURVE.x1);
      expect(sampleAutoscrollGlide(offsetPx, curve, 0).speedPx).toBeCloseTo(
        speedPx,
        3
      );
    }
  );
});
