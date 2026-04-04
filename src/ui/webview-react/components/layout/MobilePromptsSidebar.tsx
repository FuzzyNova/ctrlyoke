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
} from "../../types/messages";
import type { StepStatus } from "../../types/messages";

/**
 * MobilePromptsSidebar — compact 72 px sidebar showing prompt chips.
 *
 * Each chip shows:
 *  - Status icon (24 px, centered)
 *  - "Set start" button (only when canChangeStartPosition)
 *  - Context % (if tokens available)
 *  - Slot number below the chip
 *
 * At the top: a button to expand to full-width overlay mode.
 */
export const MobilePromptsSidebar: React.FC = () => {
  const {
    prompts,
    currentStep,
    executionState,
    liveOrderedEntries,
  } = useWorkflowStore();
  const { setMobilePromptsMode } = useUiStore();
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
    const cliEntry = [...liveOrderedEntries]
      .reverse()
      .find(
        (e) =>
          e.kind === "cli" &&
          "target" in e &&
          (e as any).target?.kind === FINAL_PROMPT_PHASES.QUEUE &&
          (e as any).target?.stepIndex === index
      );
    if (!cliEntry) return undefined;
    const tokens = (cliEntry as any).cliOutput?.tokens;
    return calcContextPct(tokens?.contextWindowUsed, tokens?.contextWindowSize);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Expand to fullwidth button */}
      <button
        className="flex items-center justify-center h-[36px] flex-shrink-0 border-b border-panel-border text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
        onClick={() => setMobilePromptsMode("fullwidth")}
        title="Expand prompts"
        aria-label="Expand prompts to full view"
      >
        <i className="codicon codicon-layout-panel-left text-[16px]" />
      </button>

      {/* Prompt chips */}
      <div className="flex-1 overflow-y-auto">
        {prompts.map((prompt, index) => {
          const status = getPromptStatus(prompt, index);
          const contextPct = getContextPct(index);
          const isPending = index >= currentStep;
          const canSetStart =
            canChangeStartPosition && isPending && index > 0;

          return (
            <div
              key={index}
              className="flex flex-col items-center py-1.5 border-b border-panel-border cursor-pointer hover:bg-toolbar-hover-bg transition-colors"
              onClick={() =>
                selectPrompt(
                  { kind: FINAL_PROMPT_PHASES.QUEUE, index },
                  prompt
                )
              }
              title={`Prompt ${index + 1}`}
            >
              {/* Status icon */}
              <StatusIcon status={status} className="text-[18px]" />

              {/* Context % */}
              {contextPct !== undefined && (
                <span className="text-[9px] text-description-fg leading-tight mt-0.5">
                  {contextPct}%
                </span>
              )}

              {/* Set start position button */}
              {canSetStart && (
                <button
                  className="flex items-center justify-center w-[16px] h-[16px] mt-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    sendMessage(MESSAGE_TYPES.SET_START_POSITION, {
                      toIndex: index,
                    });
                  }}
                  title={`Start from prompt ${index + 1}`}
                  aria-label={`Set start position to prompt ${index + 1}`}
                >
                  <i className="codicon codicon-debug-step-into text-[10px]" />
                </button>
              )}

              {/* Slot number */}
              <span className="text-[9px] text-description-fg leading-tight mt-0.5 select-none">
                {index + 1}
              </span>
            </div>
          );
        })}

        {prompts.length === 0 && (
          <div className="flex items-center justify-center h-full py-4">
            <span className="text-[10px] text-description-fg text-center px-1">
              No prompts
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
