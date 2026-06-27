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
  const { steps: prompts } = useWorkflowStore();
  const { selectPrompt } = useEditorStore();

  return useCallback(
    (index: number) => {
      const prompt = prompts[index];
      if (!prompt) return;
      selectPrompt({ kind: FINAL_STEP_PHASES.QUEUE, index }, prompt);
      const target = { kind: FINAL_STEP_PHASES.QUEUE, index } as const;

      requestAnimationFrame(() => {
        const navigationController = getActiveOutputNavigationController();
        if (navigationController?.getTargetScrollFraction(target) == null) {
          return;
        }

        navigationController.scrollToTarget(target, {
          behavior: "smooth",
          align: "start",
        });
      });
    },
    [prompts, selectPrompt]
  );
}
