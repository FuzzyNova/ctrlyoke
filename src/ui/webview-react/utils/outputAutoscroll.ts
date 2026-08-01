/**
 * Sticky-bottom auto-scroll latch.
 *
 * The output pane pins itself to the bottom while new output streams in. The
 * hard part is deciding when that pin is *released*: the naive rule ("armed iff
 * the viewport is at the bottom right now") re-evaluates on every scroll event,
 * including the ones the pane itself provokes, so a single frame where content
 * grew before the pinning write landed permanently unpins the view.
 *
 * This latch is hysteretic instead. Re-arming is generous and unconditional
 * (land near the bottom, you're pinned), releasing requires a decisive *upward*
 * user gesture. Content growth moves the bottom away from the viewport without
 * moving the viewport, so it can never release the latch.
 */
import {
  OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX,
  OUTPUT_AUTOSCROLL_RELEASE_MIN_PX,
  OUTPUT_AUTOSCROLL_RELEASE_VIEWPORT_FRACTION,
} from "./outputScrollConstants";

export interface AutoscrollLatchInput {
  /** Current gap between the viewport bottom and the content bottom. */
  distanceFromBottomPx: number;
  /** Scroll container height, used to scale the release distance. */
  viewportHeightPx: number;
  /** Whether auto-scroll is currently armed. */
  isArmed: boolean;
  /** Whether this scroll event moved the viewport toward the top. */
  movedUp: boolean;
  /**
   * Whether the movement can be attributed to the user rather than to our own
   * scroll-target writes or a virtualizer size correction.
   */
  isUserDriven: boolean;
}

/** Gap from the bottom of a scroll container's content, floored at 0. */
export function getDistanceFromBottomPx(element: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): number {
  return Math.max(
    0,
    element.scrollHeight - element.scrollTop - element.clientHeight
  );
}

/** How far above the bottom the user must scroll before the pin releases. */
export function getAutoscrollReleaseThresholdPx(
  viewportHeightPx: number
): number {
  return Math.max(
    OUTPUT_AUTOSCROLL_RELEASE_MIN_PX,
    viewportHeightPx * OUTPUT_AUTOSCROLL_RELEASE_VIEWPORT_FRACTION
  );
}

/** True when the viewport is close enough to the bottom to (re-)arm the pin. */
export function isWithinAutoscrollRearmThreshold(
  distanceFromBottomPx: number
): boolean {
  return distanceFromBottomPx <= OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX;
}

/**
 * Next armed state for the auto-scroll latch. Pure so the state machine can be
 * tested without a DOM: callers own reading geometry and deciding attribution.
 */
export function nextAutoscrollArmed({
  distanceFromBottomPx,
  viewportHeightPx,
  isArmed,
  movedUp,
  isUserDriven,
}: AutoscrollLatchInput): boolean {
  if (isWithinAutoscrollRearmThreshold(distanceFromBottomPx)) {
    return true;
  }
  if (!isArmed) {
    return false;
  }
  // Growth, downward scrolling, and our own corrections all leave the pin
  // intact — only a user gesture that walks meaningfully away from the bottom
  // releases it.
  if (!movedUp || !isUserDriven) {
    return true;
  }
  return distanceFromBottomPx <= getAutoscrollReleaseThresholdPx(
    viewportHeightPx
  );
}
