/**
 * Motion for live output: new rows fade in, and the bottom-pinned autoscroll
 * glides instead of jumping.
 *
 * Neither effect may touch `scrollTop` or change geometry the anchor lock
 * reads. The fade animates opacity only. The glide is a FLIP: the lock writes
 * `scrollTop` instantly as it always has, and the row container is then
 * translated back down by the same delta and animated to rest, so no scroll
 * event fires and the auto-scroll latch never sees it.
 */

export const OUTPUT_ROW_ENTER_DURATION_MS = 200;
export const OUTPUT_ROW_ENTER_EASING = "ease-out";
export const OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS = 300;

export interface CubicBezierCurve {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Curve for a glide that starts from rest: a gentle ease-in (the long, flat
 * first handle) into a soft landing. A glide that takes over from a running
 * one keeps this shape but bends its first handle to start at the running
 * glide's speed (`resolveAutoscrollGlideCurve`).
 */
export const OUTPUT_AUTOSCROLL_GLIDE_CURVE: CubicBezierCurve = {
  x1: 0.4,
  y1: 0,
  x2: 0.2,
  y2: 1,
};
/**
 * Largest glide offset, as a fraction of the viewport. While the glide runs
 * the user briefly sees up to that much content above the final viewport, and
 * the virtualizer only mounts rows for the final scroll position plus its
 * overscan, so a longer glide could reveal unmounted space. Bigger jumps land
 * instantly.
 */
export const OUTPUT_AUTOSCROLL_GLIDE_MAX_VIEWPORT_FRACTION = 0.5;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

interface KeyedRow {
  key: string;
}

/**
 * Keys in `nextRows` that are genuinely new output, in order.
 *
 * A key that takes over the slot of a key that just disappeared is a
 * re-keying of content that was already on screen, not new output: a
 * streaming response becomes its final response row in place, and a streaming
 * activity becomes its structured event rows. Fading those would flash
 * content the user has already read.
 */
export function findEnteringRowKeys(
  previousRows: readonly KeyedRow[],
  nextRows: readonly KeyedRow[]
): string[] {
  if (previousRows === nextRows) {
    return [];
  }
  const previousKeys = new Set(previousRows.map((row) => row.key));
  let nextKeys: Set<string> | null = null;
  const entering: string[] = [];
  nextRows.forEach((row, index) => {
    if (previousKeys.has(row.key)) {
      return;
    }
    const rowInSlotBefore = previousRows[index];
    if (rowInSlotBefore) {
      nextKeys ??= new Set(nextRows.map((nextRow) => nextRow.key));
      if (!nextKeys.has(rowInSlotBefore.key)) {
        return;
      }
    }
    entering.push(row.key);
  });
  return entering;
}

/**
 * Starting offset for the next glide, or `null` when the pane should land
 * instantly instead.
 *
 * `currentOffsetPx` is what is still left of a running glide, so a run of
 * streaming chunks adds up to one continuous motion rather than restarting
 * from rest on every chunk. A shrink (negative delta) or a jump past the cap
 * lands instantly.
 */
export function resolveAutoscrollGlideOffsetPx({
  appliedDeltaPx,
  currentOffsetPx,
  viewportHeightPx,
}: {
  appliedDeltaPx: number;
  currentOffsetPx: number;
  viewportHeightPx: number;
}): number | null {
  if (appliedDeltaPx <= 0) {
    return null;
  }
  const offsetPx = currentOffsetPx + appliedDeltaPx;
  if (
    offsetPx < 1 ||
    offsetPx > viewportHeightPx * OUTPUT_AUTOSCROLL_GLIDE_MAX_VIEWPORT_FRACTION
  ) {
    return null;
  }
  return offsetPx;
}

export function toCssCubicBezier({ x1, y1, x2, y2 }: CubicBezierCurve): string {
  return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
}

/** One axis of a cubic bezier anchored at 0 and 1, at parameter `t`. */
function bezierAxis(p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezierAxisDerivative(p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/**
 * Progress and its rate of change for a CSS `cubic-bezier` easing at time
 * fraction `x` in [0, 1] — the same function the browser animates with, so a
 * running glide's offset and speed can be read without a style flush.
 */
export function sampleCubicBezier(
  curve: CubicBezierCurve,
  x: number
): { progress: number; slope: number } {
  const clampedX = Math.min(1, Math.max(0, x));
  // Newton's method on x(t) = x; x(t) is monotone for handles in [0, 1].
  let t = clampedX;
  for (let iteration = 0; iteration < 8; iteration++) {
    const dx = bezierAxisDerivative(curve.x1, curve.x2, t);
    if (Math.abs(dx) < 1e-6) break;
    t -= (bezierAxis(curve.x1, curve.x2, t) - clampedX) / dx;
    t = Math.min(1, Math.max(0, t));
  }
  const dx = bezierAxisDerivative(curve.x1, curve.x2, t);
  const dy = bezierAxisDerivative(curve.y1, curve.y2, t);
  return {
    progress: bezierAxis(curve.y1, curve.y2, t),
    slope: Math.abs(dx) < 1e-6 ? 0 : dy / dx,
  };
}

/**
 * State of a running glide at time fraction `x`: how much offset is left and
 * how fast it is closing, in px per unit of time fraction.
 */
export function sampleAutoscrollGlide(
  offsetPx: number,
  curve: CubicBezierCurve,
  x: number
): { remainingOffsetPx: number; speedPx: number } {
  const { progress, slope } = sampleCubicBezier(curve, x);
  return {
    remainingOffsetPx: offsetPx * (1 - progress),
    speedPx: offsetPx * slope,
  };
}

/**
 * Curve for a glide of `offsetPx` that must start at `initialSpeedPx`.
 *
 * Restarting on the rest curve would drop the content to zero speed every
 * time a new chunk lands mid-glide, and a fast-start curve would kick it
 * forward instead — either reads as a stutter in a burst of short events.
 * A CSS bezier's starting slope is `y1 / x1`, so bending the first handle to
 * `speed / offset` hands the motion over at the speed it already had. `x1`
 * shortens only when the slope needs `y1` above 1, which would overshoot.
 */
export function resolveAutoscrollGlideCurve(
  initialSpeedPx: number,
  offsetPx: number
): CubicBezierCurve {
  const base = OUTPUT_AUTOSCROLL_GLIDE_CURVE;
  const slope = offsetPx > 0 ? initialSpeedPx / offsetPx : 0;
  if (!(slope > 0)) {
    return base;
  }
  const x1 = Math.min(base.x1, 1 / slope);
  return { ...base, x1, y1: slope * x1 };
}
