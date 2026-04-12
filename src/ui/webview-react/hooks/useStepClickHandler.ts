import { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { OUTPUT_HISTORY_KINDS, FINAL_STEP_PHASES } from "../types/messages";

/**
 * Returns a `handleStepClick(index)` callback that selects the prompt for
 * editing and scrolls the output panel to its anchor.
 *
 * Single source of truth shared by WorkflowStepsPanel and PromptChipRail.
 * Callers can add their own guards (e.g. isCLIManaged) before invoking it.
 */
export function useStepClickHandler() {
  const {
    steps: prompts,
    liveOrderedEntries,
    historyOutputs,
  } = useWorkflowStore();
  const { isViewingHistory } = useUiStore();
  const { selectPrompt } = useEditorStore();

  return useCallback(
    (index: number) => {
      const prompt = prompts[index];
      if (!prompt) return;
      selectPrompt({ kind: FINAL_STEP_PHASES.QUEUE, index }, prompt);

      let hasOutput: boolean;
      if (isViewingHistory && historyOutputs) {
        hasOutput = historyOutputs.orderedEntries.some(
          (e) =>
            "target" in e &&
            e.target.kind === FINAL_STEP_PHASES.QUEUE &&
            (e.target as any).stepIndex === index
        );
      } else {
        hasOutput = liveOrderedEntries.some(
          (e) =>
            e.kind === OUTPUT_HISTORY_KINDS.CLI &&
            "target" in e &&
            (e as any).target?.kind === FINAL_STEP_PHASES.QUEUE &&
            (e as any).target?.stepIndex === index
        );
      }

      if (hasOutput) {
        requestAnimationFrame(() => {
          const anchor = document.getElementById(`output-step-queue-${index}`);
          const container = document.getElementById("output-content");
          if (anchor && container) {
            const anchorTop = anchor.getBoundingClientRect().top;
            const containerTop = container.getBoundingClientRect().top;
            container.scrollTo({
              top: container.scrollTop + (anchorTop - containerTop),
              behavior: "smooth",
            });
          }
        });
      }
    },
    [
      prompts,
      selectPrompt,
      liveOrderedEntries,
      isViewingHistory,
      historyOutputs,
    ]
  );
}
