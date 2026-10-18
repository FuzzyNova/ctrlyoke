import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { OutputScrollTarget } from "@store/uiStore";
import {
  OUTPUT_SCROLL_APPLY_PHASES,
  OUTPUT_SCROLL_TARGET_KINDS,
} from "@root/types/DashboardConstants";
import {
  OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS,
  OUTPUT_AUTOSCROLL_GLIDE_EASING,
  prefersReducedMotion,
  readTranslateYPx,
  resolveAutoscrollGlideOffsetPx,
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
  element: HTMLElement;
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
      const currentOffsetPx =
        running && container && running.element === container
          ? readTranslateYPx(container)
          : 0;
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
        currentOffsetPx,
        viewportHeightPx: scrollElement.clientHeight,
      });
      if (offsetPx === null) {
        return;
      }

      clipElement.style.overflowY = "clip";
      const animation = container.animate(
        [
          { transform: `translateY(${offsetPx}px)` },
          { transform: "translateY(0)" },
        ],
        {
          duration: OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS,
          easing: OUTPUT_AUTOSCROLL_GLIDE_EASING,
        }
      );
      const glide: RunningGlide = {
        animation,
        clipElement,
        element: container,
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
