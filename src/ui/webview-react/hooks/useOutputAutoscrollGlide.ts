import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { OutputScrollTarget } from "@store/uiStore";
import {
  OUTPUT_SCROLL_APPLY_PHASES,
  OUTPUT_SCROLL_TARGET_KINDS,
} from "@root/types/DashboardConstants";
import {
  OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS,
  type CubicBezierCurve,
  prefersReducedMotion,
  resolveAutoscrollGlideCurve,
  resolveAutoscrollGlideOffsetPx,
  sampleAutoscrollGlide,
  toCssCubicBezier,
} from "@utils/outputMotion";
import {
  OUTPUT_GLIDE_CLIP_SELECTOR,
  OUTPUT_ROW_CONTAINER_SELECTOR,
} from "@utils/outputDom";

const GLIDE_PHASES: ReadonlySet<string> = new Set(
  Object.values(OUTPUT_SCROLL_APPLY_PHASES)
);

interface UseOutputAutoscrollGlideInput {
  autoscrollEnabledRef: RefObject<boolean>;
  /** Live output is streaming into a visible pane. */
  isEnabledRef: RefObject<boolean>;
  outputRef: RefObject<HTMLDivElement | null>;
  pendingNavigationRef: RefObject<unknown | null>;
  scrollSeekPlaceholderRef: RefObject<boolean>;
}

interface RunningGlide {
  animation: Animation;
  clipElement: HTMLElement;
  curve: CubicBezierCurve;
  element: HTMLElement;
  offsetPx: number;
  /** The pane's `scrollTop` that `offsetPx` was measured against. */
  scrollTop: number;
}

/** The pane's `scrollTop` as of the last frame the browser painted. */
interface PaintedScroll {
  element: HTMLElement;
  listener: () => void;
  scrollTop: number;
}

/**
 * Scroll events are dispatched in the rendering steps, before paint, so the
 * value read in one is the value that frame shows. Commits between frames
 * (a clamp, the lock's write) move `scrollTop` without updating it.
 */
function trackPaintedScrollTop(element: HTMLElement): PaintedScroll {
  const painted: PaintedScroll = {
    element,
    listener: () => {
      painted.scrollTop = element.scrollTop;
    },
    scrollTop: element.scrollTop,
  };
  element.addEventListener("scroll", painted.listener, { passive: true });
  return painted;
}

/** Where a running glide is right now, read from its own clock and curve. */
function sampleRunningGlide(glide: RunningGlide) {
  const currentTime = glide.animation.currentTime;
  const elapsedMs = typeof currentTime === "number" ? currentTime : 0;
  return sampleAutoscrollGlide(
    glide.offsetPx,
    glide.curve,
    elapsedMs / OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS
  );
}

/**
 * Animates the bottom-pinned autoscroll without a second `scrollTop` writer.
 *
 * The anchor lock still writes `scrollTop` instantly. Right after it does,
 * the row container is translated down by the same delta and animated to
 * rest, so the content glides up into place. No scroll event fires, so the
 * latch and the echo attribution are untouched.
 *
 * Two side effects of the translation have to be contained:
 * - A transform adds to the scroller's scrollable overflow, so `scrollHeight`
 *   would grow by the offset and the next bottom apply would scroll into
 *   blank space. The wrapper around the container is set to
 *   `overflow-y: clip` for the glide's lifetime; `clip`, unlike `hidden`,
 *   creates no scroll container, so sticky section toggles keep working.
 * - Every client rect read mid-glide includes the offset. The glide therefore
 *   runs only for the BOTTOM target (resolved from `scrollHeight` alone), and
 *   `settleGlide` must run before anything else reads row geometry: user
 *   input, a non-bottom apply, or a viewport-anchor capture.
 *
 * The lock is not the only thing that moves `scrollTop`. A new row is first
 * laid out at its estimated height, the lock scrolls to that bottom, and the
 * row's real (usually smaller) size is measured and committed before the
 * frame paints. The pane shrinks under the bottom and the browser clamps
 * `scrollTop` back down without anyone writing it. A glide still translated by
 * the full estimated delta would then paint the content that far below where
 * the user last saw it — a jump up before gliding back down. So every commit
 * reconciles a running glide with where `scrollTop` actually is now.
 *
 * The same clamp can also land before any glide starts. A row replaced by its
 * completed form ("Editing" → "Edited", a running command → its exit) first
 * lays out shorter, the browser clamps `scrollTop` down, and the real height
 * is committed and scrolled to in the same frame. The lock's write delta is
 * then measured from the clamped value, so a glide sized from it would paint
 * the content that far too low. With no glide running, the delta is taken
 * from the last painted `scrollTop` instead.
 */
export function useOutputAutoscrollGlide({
  autoscrollEnabledRef,
  isEnabledRef,
  outputRef,
  pendingNavigationRef,
  scrollSeekPlaceholderRef,
}: UseOutputAutoscrollGlideInput) {
  const runningGlideRef = useRef<RunningGlide | null>(null);
  const paintedScrollRef = useRef<PaintedScroll | null>(null);

  const releaseGlide = useCallback((glide: RunningGlide) => {
    if (runningGlideRef.current === glide) {
      runningGlideRef.current = null;
    }
    glide.clipElement.style.removeProperty("overflow-y");
  }, []);

  const settleGlide = useCallback(() => {
    const running = runningGlideRef.current;
    if (!running) return;
    running.animation.cancel();
    releaseGlide(running);
  }, [releaseGlide]);

  /**
   * Replaces any running glide with one that holds the content where the user
   * last saw it after `scrollTop` moved by `scrollDeltaPx` since that glide
   * was measured, or lands instantly when that cannot glide.
   */
  const retargetGlide = useCallback(
    (
      scrollElement: HTMLDivElement,
      container: HTMLElement,
      scrollDeltaPx: number
    ) => {
      const running = runningGlideRef.current;
      const { remainingOffsetPx, speedPx } =
        running && running.element === container
          ? sampleRunningGlide(running)
          : { remainingOffsetPx: 0, speedPx: 0 };
      settleGlide();

      const clipElement = container.parentElement;
      if (
        !clipElement?.matches(OUTPUT_GLIDE_CLIP_SELECTOR) ||
        typeof container.animate !== "function"
      ) {
        return;
      }
      const offsetPx = resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx: scrollDeltaPx,
        currentOffsetPx: remainingOffsetPx,
        viewportHeightPx: scrollElement.clientHeight,
      });
      if (offsetPx === null) {
        return;
      }

      // A glide that takes over from a running one starts at its speed.
      const curve = resolveAutoscrollGlideCurve(speedPx, offsetPx);
      clipElement.style.overflowY = "clip";
      const animation = container.animate(
        [
          { transform: `translateY(${offsetPx}px)` },
          { transform: "translateY(0)" },
        ],
        {
          duration: OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS,
          easing: toCssCubicBezier(curve),
        }
      );
      const glide: RunningGlide = {
        animation,
        clipElement,
        curve,
        element: container,
        offsetPx,
        scrollTop: scrollElement.scrollTop,
      };
      runningGlideRef.current = glide;
      animation.onfinish = () => releaseGlide(glide);
    },
    [releaseGlide, settleGlide]
  );

  const glideAfterScrollWrite = useCallback(
    (phase: string, target: OutputScrollTarget, appliedDeltaPx: number) => {
      const scrollElement = outputRef.current;
      const container = scrollElement?.querySelector<HTMLElement>(
        OUTPUT_ROW_CONTAINER_SELECTOR
      );
      if (
        !scrollElement ||
        !container ||
        !isEnabledRef.current ||
        !autoscrollEnabledRef.current ||
        target.kind !== OUTPUT_SCROLL_TARGET_KINDS.BOTTOM ||
        !GLIDE_PHASES.has(phase) ||
        pendingNavigationRef.current !== null ||
        scrollSeekPlaceholderRef.current ||
        prefersReducedMotion()
      ) {
        settleGlide();
        return;
      }
      // Measured from where the content last stood, not from where this write
      // started: a clamp that landed in between moved the pane too. That is
      // the running glide's own `scrollTop`, or with none running the last
      // painted one.
      const running = runningGlideRef.current;
      const painted = paintedScrollRef.current;
      const scrollDeltaPx =
        running && running.element === container
          ? scrollElement.scrollTop - running.scrollTop
          : painted?.element === scrollElement
            ? scrollElement.scrollTop - painted.scrollTop
            : appliedDeltaPx;
      retargetGlide(scrollElement, container, scrollDeltaPx);
    },
    [
      autoscrollEnabledRef,
      isEnabledRef,
      outputRef,
      pendingNavigationRef,
      retargetGlide,
      scrollSeekPlaceholderRef,
      settleGlide,
    ]
  );

  // Runs after every commit, before paint. Reads `scrollTop` only while a
  // glide is running, so an idle pane pays nothing for it.
  useLayoutEffect(() => {
    const running = runningGlideRef.current;
    const scrollElement = outputRef.current;
    if (!running || !scrollElement) return;
    if (!running.element.isConnected) {
      settleGlide();
      return;
    }
    const scrollDeltaPx = scrollElement.scrollTop - running.scrollTop;
    if (Math.abs(scrollDeltaPx) < 1) return;
    retargetGlide(scrollElement, running.element, scrollDeltaPx);
  });

  // Follows the pane element across remounts; an unchanged pane costs one
  // comparison per commit.
  useLayoutEffect(() => {
    const scrollElement = outputRef.current;
    const painted = paintedScrollRef.current;
    if (painted?.element === scrollElement) return;
    painted?.element.removeEventListener("scroll", painted.listener);
    paintedScrollRef.current = scrollElement
      ? trackPaintedScrollTop(scrollElement)
      : null;
  });

  useEffect(
    () => () => {
      const painted = paintedScrollRef.current;
      painted?.element.removeEventListener("scroll", painted.listener);
      paintedScrollRef.current = null;
    },
    []
  );

  useEffect(() => settleGlide, [settleGlide]);

  return { glideAfterScrollWrite, settleGlide };
}
