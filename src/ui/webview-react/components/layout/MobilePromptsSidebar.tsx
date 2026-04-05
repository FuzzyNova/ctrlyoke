import React from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { sendMessage } from "@hooks/useMessageHandler";
import { calcContextPct } from "@utils/tokenUtils";
import { StatusIcon } from "../prompts/StatusIcon";
import {
  STEP_STATUS,
  EXECUTION_STATES,
  MESSAGE_TYPES,
  FINAL_PROMPT_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "../../types/messages";
import type { StepStatus } from "../../types/messages";

/**
 * MobilePromptsSidebar — compact 72 px sidebar showing prompt chips.
 *
 * Each chip layout:
 *   Row 1: [prompt number]  [status icon]
 *   Row 2: [set-start btn]  [context %]   ← shown when relevant
 *
 * At the top: a header bar matching the fullwidth PromptsPanel header height,
 * with an expand arrow and the list-unordered icon.
 */
export const MobilePromptsSidebar: React.FC = () => {
  const {
    prompts,
    currentStep,
    executionState,
    liveOrderedEntries,
    historyOutputs,
  } = useWorkflowStore();
  const { setMobilePromptsMode, isViewingHistory } = useUiStore();
  const { selectPrompt } = useEditorStore();

  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;

  const getPromptStatus = (
    prompt: (typeof prompts)[0],
    index: number
  ): StepStatus => {
    if (isRunning) {
      if (index === currentStep) return STEP_STATUS.RUNNING;
      if (index < currentStep) return STEP_STATUS.COMPLETED;
    }
    if (
      executionState === EXECUTION_STATES.CANCELLING &&
      index === currentStep
    ) {
      return STEP_STATUS.CANCELLED;
    }
    if (executionState === EXECUTION_STATES.ERROR && index === currentStep) {
      return STEP_STATUS.FAILED;
    }
    if (prompt.status) return prompt.status;
    if (index < currentStep) return STEP_STATUS.COMPLETED;
    return STEP_STATUS.PENDING;
  };

  const getContextPct = (index: number): number | undefined => {
    const entries =
      isViewingHistory && historyOutputs
        ? historyOutputs.orderedEntries
        : liveOrderedEntries;
    const cliEntry = [...entries]
      .reverse()
      .find(
        (e) =>
          e.kind === OUTPUT_HISTORY_KINDS.CLI &&
          "target" in e &&
          (e as any).target?.kind === FINAL_PROMPT_PHASES.QUEUE &&
          (e as any).target?.stepIndex === index
      );
    if (!cliEntry) return undefined;
    const tokens = (cliEntry as any).cliOutput?.tokens;
    return calcContextPct(tokens?.contextWindowUsed, tokens?.contextWindowSize);
  };

  const handlePromptClick = (index: number) => {
    const prompt = prompts[index];
    if (!prompt) return;
    selectPrompt({ kind: FINAL_PROMPT_PHASES.QUEUE, index }, prompt);

    // Scroll the output area to this step's anchor, same as fullwidth PromptsPanel.
    let hasOutput: boolean;
    if (isViewingHistory && historyOutputs) {
      hasOutput = historyOutputs.orderedEntries.some(
        (e) =>
          "target" in e &&
          e.target.kind === FINAL_PROMPT_PHASES.QUEUE &&
          (e.target as any).stepIndex === index
      );
    } else {
      hasOutput = liveOrderedEntries.some(
        (e) =>
          e.kind === OUTPUT_HISTORY_KINDS.CLI &&
          "target" in e &&
          (e as any).target?.kind === FINAL_PROMPT_PHASES.QUEUE &&
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
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header bar — same 30px height as the fullwidth PromptsPanel header.
          Expand arrow sits at the same horizontal position as the collapse arrow
          in fullwidth mode so users can keep their finger in the same spot. */}
      <div className="flex items-center h-[30px] flex-shrink-0 border-b border-panel-border bg-sidebar-bg">
        <button
          className="flex items-center justify-center w-[20px] h-[20px] ml-1 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
          onClick={() => setMobilePromptsMode("fullwidth")}
          title="Expand prompts"
          aria-label="Expand prompts to full view"
        >
          <i className="codicon codicon-arrow-right text-[12px]" />
        </button>
        <i className="codicon codicon-list-unordered text-[14px] ml-1" />
      </div>

      {/* Prompt chips */}
      <div className="flex-1 overflow-y-auto">
        {prompts.map((prompt, index) => {
          const status = getPromptStatus(prompt, index);
          const contextPct = getContextPct(index);
          // Match PromptsPanel: any prompt that isn't the current active step
          // can have start position changed (done = rewind, pending = skip ahead).
          const canSetStart =
            canChangeStartPosition && index !== currentStep;
          const hasSecondRow = canSetStart || contextPct !== undefined;

          return (
            <div
              key={index}
              className="flex flex-col px-1 py-1 border-b border-panel-border cursor-pointer hover:bg-toolbar-hover-bg transition-colors"
              onClick={() => handlePromptClick(index)}
              title={`Prompt ${index + 1}`}
            >
              {/* Row 1: slot number + status icon */}
              <div className="flex items-center justify-between w-full">
                <span className="text-[10px] text-description-fg leading-none select-none">
                  {index + 1}
                </span>
                <StatusIcon status={status} className="text-[16px]" />
              </div>

              {/* Row 2: set-start button + context % (only when relevant) */}
              {hasSecondRow && (
                <div className="flex items-center justify-between w-full mt-0.5">
                  {canSetStart ? (
                    <button
                      className="flex items-center justify-center w-[14px] h-[14px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        sendMessage(MESSAGE_TYPES.SET_START_POSITION, {
                          toIndex: index,
                        });
                      }}
                      title={`Start from prompt ${index + 1}`}
                      aria-label={`Set start position to prompt ${index + 1}`}
                    >
                      <i className="codicon codicon-debug-step-into text-[9px]" />
                    </button>
                  ) : (
                    <span />
                  )}
                  {contextPct !== undefined && (
                    <span className="text-[9px] text-description-fg leading-none">
                      {contextPct}%
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {prompts.length === 0 && (
          <div className="flex items-center justify-center py-4">
            <span className="text-[9px] text-description-fg text-center px-1">
              No prompts
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
