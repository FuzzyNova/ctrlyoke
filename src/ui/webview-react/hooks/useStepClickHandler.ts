import { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useEditorStore } from "@store/editorStore";
import { FINAL_STEP_PHASES } from "../types/messages";
import { getActiveOutputNavigationController } from "@utils/outputNavigation";

/**
 * Returns a `handleStepClick(index)` callback that selects the prompt for
 * editing and scrolls the output panel to its anchor.
 *
 * Single source of truth shared by WorkflowStepsPanel and PromptChipRail.
 * Callers can add their own guards (e.g. isCLIManaged) before invoking it.
 */
export function useStepClickHandler() {
  const selectPrompt = useEditorStore((state) => state.selectPrompt);

  return useCallback(
    (index: number) => {
      // Read the current step at event time so status/runtime updates do not
      // invalidate this callback and every memoized workflow row.
      const prompt = useWorkflowStore.getState().steps[index];
      if (!prompt) return;
      selectPrompt({ kind: FINAL_STEP_PHASES.QUEUE, index }, prompt);
      const target = { kind: FINAL_STEP_PHASES.QUEUE, index } as const;

      requestAnimationFrame(() => {
        const navigationController = getActiveOutputNavigationController();
        const scrollFraction =
          navigationController?.getTargetScrollFraction(target) ?? null;

        if (navigationController == null || scrollFraction == null) {
          return;
        }

        navigationController.scrollToTarget(target, {
          behavior: "smooth",
          align: "start",
        });
      });
    },
    [selectPrompt]
  );
}
