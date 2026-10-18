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
export const OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS = 160;
export const OUTPUT_AUTOSCROLL_GLIDE_EASING = "cubic-bezier(0.2, 0, 0, 1)";
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

/** Current vertical translation of an element, from its computed transform. */
export function readTranslateYPx(element: Element): number {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") {
    return 0;
  }
  const values = /^matrix(3d)?\((.+)\)$/.exec(transform)?.[2]?.split(",");
  if (!values) {
    return 0;
  }
  // matrix(a, b, c, d, tx, ty) / matrix3d(..., tx, ty, tz, 1)
  const ty = Number(values[transform.startsWith("matrix3d") ? 13 : 5]);
  return Number.isFinite(ty) ? ty : 0;
}
