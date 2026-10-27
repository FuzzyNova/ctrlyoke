/**
 * Marks a step whose output is inside the output pane's viewport, for the
 * steps panel rows, the final step footer and the collapsed chip rail alike.
 */
import { useUiStore } from "@store/uiStore";
import { getTargetKey } from "@utils/outputProjection";
import { formatFinalPassRangeBadge } from "@root/utils/FinalStepLabels";
import { FINAL_STEP_PHASES } from "../../types/messages";

export const IN_OUTPUT_VIEW_TITLE = "Showing in the output pane";

/**
 * A primitive selector: only steps entering or leaving the output viewport
 * re-render as the pane scrolls.
 */
export function useIsStepInOutputView(index: number): boolean {
  return useUiStore((state) =>
    state.outputInViewTargetKeys.includes(
      getTargetKey({ kind: FINAL_STEP_PHASES.QUEUE, index })
    )
  );
}

/** 1-based final-step pass numbers, inclusive. */
export interface FinalPassRange {
  first: number;
  last: number;
}

/**
 * Pass number (1-based) of the first or last final-step pass in view, or 0.
 * The viewport is one contiguous stretch of output, so first..last covers
 * every pass on screen.
 */
function findFinalPassInView(
  inViewTargetKeys: readonly string[],
  passCount: number,
  edge: keyof FinalPassRange
): number {
  for (let offset = 0; offset < passCount; offset++) {
    const loopIndex = edge === "first" ? offset : passCount - 1 - offset;
    if (
      inViewTargetKeys.includes(
        getTargetKey({ kind: FINAL_STEP_PHASES.FINAL_STEP, index: loopIndex })
      )
    ) {
      return loopIndex + 1;
    }
  }
  return 0;
}

/**
 * Which of the final step's passes are on screen, or null for none.
 * `passCount` is how many passes may have output (`loopCount + 1`).
 */
export function useFinalStepPassesInOutputView(
  passCount: number
): FinalPassRange | null {
  const first = useUiStore((state) =>
    findFinalPassInView(state.outputInViewTargetKeys, passCount, "first")
  );
  const last = useUiStore((state) =>
    findFinalPassInView(state.outputInViewTargetKeys, passCount, "last")
  );
  return first > 0 ? { first, last } : null;
}

/** Tooltip for a final step whose output is on screen. */
export function describeFinalPassesInView(range: FinalPassRange): string {
  return `Showing ${formatFinalPassRangeBadge(range.first, range.last).toLowerCase()} in the output pane`;
}

/**
 * Edge bar drawn on an in-view step. Bars on adjacent steps join into one
 * bracket: the output viewport mapped onto the step list, which the minimap's
 * thumb cannot show once its minimum height spans several steps.
 * `className` places it (an edge and a width) inside a `relative` parent.
 */
export function InOutputViewBar({ className }: { className: string }) {
  return (
    <span
      className={`pointer-events-none absolute inset-y-0 bg-minimap-thumb-active ${className}`}
      aria-hidden="true"
    />
  );
}
