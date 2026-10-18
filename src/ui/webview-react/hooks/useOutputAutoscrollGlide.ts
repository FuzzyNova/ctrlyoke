import { useCallback, useEffect, useRef } from "react";
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
 */
export function useOutputAutoscrollGlide({
  autoscrollEnabledRef,
  isEnabledRef,
  outputRef,
  pendingNavigationRef,
  scrollSeekPlaceholderRef,
}: UseOutputAutoscrollGlideInput) {
  const runningGlideRef = useRef<RunningGlide | null>(null);

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

  const glideAfterScrollWrite = useCallback(
    (phase: string, target: OutputScrollTarget, appliedDeltaPx: number) => {
      const scrollElement = outputRef.current;
      const container = scrollElement?.querySelector<HTMLElement>(
        OUTPUT_ROW_CONTAINER_SELECTOR
      );
      const running = runningGlideRef.current;
      const { remainingOffsetPx, speedPx } =
        running && container && running.element === container
          ? sampleRunningGlide(running)
          : { remainingOffsetPx: 0, speedPx: 0 };
      settleGlide();

      const clipElement = container?.parentElement;
      if (
        !scrollElement ||
        !container ||
        !clipElement?.matches(OUTPUT_GLIDE_CLIP_SELECTOR) ||
        typeof container.animate !== "function" ||
        !isEnabledRef.current ||
        !autoscrollEnabledRef.current ||
        target.kind !== OUTPUT_SCROLL_TARGET_KINDS.BOTTOM ||
        !GLIDE_PHASES.has(phase) ||
        pendingNavigationRef.current !== null ||
        scrollSeekPlaceholderRef.current ||
        prefersReducedMotion()
      ) {
        return;
      }
      const offsetPx = resolveAutoscrollGlideOffsetPx({
        appliedDeltaPx,
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
      };
      runningGlideRef.current = glide;
      animation.onfinish = () => releaseGlide(glide);
    },
    [
      autoscrollEnabledRef,
      isEnabledRef,
      outputRef,
      pendingNavigationRef,
      releaseGlide,
      scrollSeekPlaceholderRef,
      settleGlide,
    ]
  );

  useEffect(() => settleGlide, [settleGlide]);

  return { glideAfterScrollWrite, settleGlide };
}
