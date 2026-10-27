/**
 * Marks a queue step whose output is inside the output pane's viewport, for
 * the steps panel rows and the collapsed chip rail alike.
 */
import { useUiStore } from "@store/uiStore";
import { getTargetKey } from "@utils/outputProjection";
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
