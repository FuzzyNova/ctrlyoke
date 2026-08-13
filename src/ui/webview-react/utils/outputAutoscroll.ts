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
  OUTPUT_MEASUREMENT_REFLOW_MIN_DELTA_PX,
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

export interface ProgrammaticScrollEchoInput {
  /** Scroll position reported by the event being attributed. */
  scrollTop: number;
  /** Exact scrollTop the pane's own last scroll-target write set, if any. */
  lastProgrammaticScrollTop: number | null;
  /** Whether a real wheel/touch input landed inside the input grace window. */
  hasRecentUserScrollInput: boolean;
}

/**
 * Whether a scroll event is the echo of the pane's own scroll-target write.
 *
 * Attribution has to be by *position*, not by timing. The obvious guard — raise
 * a flag around the write, lower it on the next animation frame — cannot cover a
 * burst, and the anchor lock writes in bursts: each write arms the flag and
 * schedules its own frame to disarm, so an early frame lowers it before the
 * browser dispatches the (coalesced, frequently late) scroll event. Whatever
 * escapes then looks exactly like a user scroll, and re-anchoring on it turns a
 * correction the lock made into the pane's new resting place.
 *
 * A position match survives any number of dropped frames. Requiring no recent
 * real input is what keeps a user who happens to land on that exact pixel from
 * being ignored — touch and wheel both stamp their input before the resulting
 * scroll event arrives.
 */
export function isProgrammaticScrollEcho({
  scrollTop,
  lastProgrammaticScrollTop,
  hasRecentUserScrollInput,
}: ProgrammaticScrollEchoInput): boolean {
  return (
    lastProgrammaticScrollTop !== null &&
    !hasRecentUserScrollInput &&
    Math.abs(scrollTop - lastProgrammaticScrollTop) < 1
  );
}

/**
 * Who moved the output pane. One verdict per scroll event, in the order the
 * handler's guards apply, so the classification and the control flow cannot
 * drift apart.
 */
export const OUTPUT_SCROLL_VERDICTS = {
  /** Layout work is suppressed wholesale (collapsed pane, tab switch, ...). */
  suppressedLayoutWork: "suppressed-layout-work",
  /** The `isProgrammaticScroll` timing flag was still raised. */
  programmaticFlag: "programmatic-flag",
  /** A measurement flush owns the pane for the duration of its rAF chain. */
  measurementFlush: "measurement-flush",
  /** Position-matched echo of the anchor lock's own write. */
  programmaticEcho: "programmatic-echo",
  /** Nothing of ours claimed it — treated as the user. */
  userScroll: "user-scroll",
} as const;

export type OutputScrollVerdict =
  (typeof OUTPUT_SCROLL_VERDICTS)[keyof typeof OUTPUT_SCROLL_VERDICTS];

export interface OutputScrollAttributionInput extends ProgrammaticScrollEchoInput {
  isLayoutWorkSuppressed: boolean;
  isProgrammaticScrollFlagRaised: boolean;
  isMeasurementFlushInProgress: boolean;
}

/**
 * Attribute one scroll event.
 *
 * Split out from the handler so every event can be *classified before any of
 * them is dropped*. Three of these verdicts used to be bare early returns that
 * ran ahead of all logging, so a settle window — precisely the window where the
 * pane misbehaves — recorded no scroll activity at all: on 2026-08-13 00:25:59
 * a measurement flush was in progress for the whole burst, and `scrollTop` moved
 * ~116px between two of the lock's own applies with nothing in the log to say
 * what moved it. Returning a verdict instead of returning early lets the caller
 * log first and branch second.
 */
export function classifyOutputScrollEvent({
  hasRecentUserScrollInput,
  isLayoutWorkSuppressed,
  isMeasurementFlushInProgress,
  isProgrammaticScrollFlagRaised,
  lastProgrammaticScrollTop,
  scrollTop,
}: OutputScrollAttributionInput): OutputScrollVerdict {
  if (isLayoutWorkSuppressed) {
    return OUTPUT_SCROLL_VERDICTS.suppressedLayoutWork;
  }
  if (isProgrammaticScrollFlagRaised) {
    return OUTPUT_SCROLL_VERDICTS.programmaticFlag;
  }
  if (isMeasurementFlushInProgress) {
    return OUTPUT_SCROLL_VERDICTS.measurementFlush;
  }
  if (
    isProgrammaticScrollEcho({
      scrollTop,
      lastProgrammaticScrollTop,
      hasRecentUserScrollInput,
    })
  ) {
    return OUTPUT_SCROLL_VERDICTS.programmaticEcho;
  }
  return OUTPUT_SCROLL_VERDICTS.userScroll;
}

export interface MeasurementCorrectionSyncInput {
  /** Signed height change this measurement reported for the row. */
  heightDeltaPx: number;
  /** Viewport-space top of the row that just resized. */
  rowTopPx: number;
  /**
   * Viewport-space top of the position the anchor row is pinned to, or of the
   * scroll container when no row anchor is committed.
   */
  anchorTopPx: number;
}

/**
 * Whether a row's new measurement must bump the layout version *synchronously*
 * so the anchor lock's correction batches into the same commit as the reflow.
 *
 * The distinction that matters is "does this resize move the anchor", and the
 * answer is purely ordinal: rows are laid out in sequence, so a row starting
 * before the anchor displaces it and a row starting at or after it does not.
 *
 * This used to ask whether the row sat entirely above the *viewport* instead,
 * which is a much narrower set. The anchor is not at the viewport top — the
 * lock pins it wherever the user left it, routinely a few hundred pixels down —
 * so every resize in the band between the viewport top and the anchor, plus
 * every row straddling the top edge, failed the test and took the batched rAF
 * path. That path lands the correction one paint *after* the reflow, which is
 * the visible "jump to B, snap back to A" flash: on 2026-08-13 00:26:00 five
 * such corrections ran over 460ms against an anchor committed at offset 314.75
 * in a 586px viewport.
 *
 * There is deliberately no magnitude threshold beyond the sub-pixel no-op
 * floor. A 24px one lived here on the theory that only large reflows earned a
 * synchronous bump, but a threshold like that *is* the amplitude of the flash
 * it admits — every displacement under it paints before its correction. Nor
 * does it buy the render it was meant to save: `measureElement` runs inside
 * TanStack's ResizeObserver callback, whose own `resizeItem` -> `notify()`
 * re-renders in that same synchronous stack, so React batches this bump into a
 * render that was already going to happen. The rAF path is the one that adds a
 * render, later and separately.
 */
export function shouldSyncMeasurementCorrection({
  anchorTopPx,
  heightDeltaPx,
  rowTopPx,
}: MeasurementCorrectionSyncInput): boolean {
  return (
    Math.abs(heightDeltaPx) >= OUTPUT_MEASUREMENT_REFLOW_MIN_DELTA_PX &&
    rowTopPx < anchorTopPx
  );
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
  return (
    distanceFromBottomPx <= getAutoscrollReleaseThresholdPx(viewportHeightPx)
  );
}
