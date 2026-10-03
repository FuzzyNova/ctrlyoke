import { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useEditorStore } from "@store/editorStore";
import { FINAL_STEP_PHASES } from "../types/messages";
import { getActiveOutputNavigationController } from "@utils/outputNavigation";
import type { StepClickModifiers } from "../components/prompts/WorkflowStep";

/**
 * Returns a `handleStepClick(index, modifiers)` callback that selects the prompt for
 * editing and scrolls the output panel to its anchor.
 *
 * Single source of truth shared by WorkflowStepsPanel and PromptChipRail.
 * Callers can add their own guards (e.g. isExternallyManaged) before invoking it.
 */
export function useStepClickHandler() {
  return useCallback(
    (
      index: number,
      modifiers: StepClickModifiers = { range: false, toggle: false }
    ) => {
      // Read the current step at event time so status/runtime updates do not
      // invalidate this callback and every memoized workflow row.
      const prompt = useWorkflowStore.getState().steps[index];
      if (!prompt) return;
      const editor = useEditorStore.getState();
      if (modifiers.range && modifiers.toggle) {
        editor.addMultiSelectionRange(index);
      } else if (modifiers.range) {
        editor.extendMultiSelectionByRange(index);
      } else if (modifiers.toggle) {
        editor.toggleMultiSelection(index);
      } else {
        editor.selectPrompt({ kind: FINAL_STEP_PHASES.QUEUE, index }, prompt);
      }
      const selected = useEditorStore.getState();
      const remainsSelected =
        (selected.multiSelection?.indices.includes(index) ?? false) ||
        (selected.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
          selected.selectionTarget.index === index);
      if (!remainsSelected) return;
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
    []
  );
}
