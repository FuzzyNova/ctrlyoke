import React, { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { HARNESS_INFO } from "../../types/messages";
import { PromptItem, type PromptDetails } from "../prompts/PromptItem";
import { PromptCounter } from "../prompts/PromptCounter";
import { PanelBar } from "../shared";
import {
  MESSAGE_TYPES,
  STEP_STATUS,
  EXECUTION_STATES,
  type StepStatus,
} from "../../types/messages";
import { sendMessage } from "../../hooks/useMessageHandler";

/**
 * PromptsPanel - Left panel showing the list of prompts in the workflow
 *
 * Features:
 * - Collapsible header with prompt count
 * - List of PromptItem components with status
 * - Click to select prompt for editing
 * - Empty state when no prompts loaded
 * - Retry and end condition result display
 */
export const PromptsPanel: React.FC<{
  panelBarOrientation?: "horizontal" | "vertical";
}> = ({ panelBarOrientation = "vertical" }) => {
  const { prompts, currentStep, executionState, retryStates, cliOutputs, historyOutputs } =
    useWorkflowStore();
  const { promptsCollapsed, togglePromptsCollapse, isViewingHistory, loadedWorkflows, activeWorkflowId } = useUiStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy === "cli";
  const { selectedPromptIndex, selectPrompt } = useEditorStore();
  const { workflowProperties, globalSettings } = useSettingsStore();
  const [headerRef, isHeaderNarrow] = useElementNarrow<HTMLDivElement>(200);

  // Compute the harness/model to display for a prompt.
  //
  // For prompts that have already started executing, use _runtime values so
  // the display shows what was actually used and doesn't change if the
  // workflow-level settings are later modified.
  //
  // For pending prompts, compute from the three-tier precedence (prompt →
  // workflow → global) so the display stays live and reflects any changes.
  const getPromptHarnessModel = (prompt: (typeof prompts)[0]) => {
    if (prompt._runtime?.harness ?? prompt._runtime?.model) {
      const h = prompt._runtime!.harness;
      const m = prompt._runtime!.model;
      return {
        harnessLabel: h
          ? (HARNESS_INFO[h as keyof typeof HARNESS_INFO]?.name ?? h)
          : undefined,
        harnessIsDefault: false,
        modelLabel: m,
        modelIsDefault: false,
      };
    }

    // Pending / queued — reflect live settings with default indicators
    const harnessIsDefault = prompt.harness === undefined;
    const modelIsDefault = prompt.model === undefined;
    const effectiveHarness =
      prompt.harness ?? workflowProperties.harness ?? globalSettings.harness;
    const effectiveModel =
      prompt.model ?? workflowProperties.model ?? globalSettings.model;
    return {
      harnessLabel:
        HARNESS_INFO[effectiveHarness as keyof typeof HARNESS_INFO]?.name ??
        effectiveHarness,
      harnessIsDefault,
      modelLabel: effectiveModel,
      modelIsDefault,
    };
  };

  // Handle clicking a prompt to edit it (disabled in CLI watch mode)
  const handlePromptClick = useCallback(
    (index: number) => {
      if (isCLIManaged) return;
      const prompt = prompts[index];
      if (prompt) {
        selectPrompt(index, prompt);
        // Scroll to this step's output if it exists.
        // In history mode, check historyOutputs; otherwise check live cliOutputs.
        let hasOutput: boolean;
        if (isViewingHistory && historyOutputs) {
          const step = historyOutputs.steps[index];
          hasOutput =
            (step?.cliOutputs?.length ?? 0) > 0 ||
            (step?.statusMessages?.length ?? 0) > 0;
        } else {
          hasOutput = (cliOutputs[index]?.length ?? 0) > 0;
        }
        if (hasOutput) {
          requestAnimationFrame(() => {
            const anchor = document.getElementById(`output-step-${index}`);
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
      }
    },
    [prompts, selectPrompt, cliOutputs, isViewingHistory, historyOutputs]
  );

  // Determine if workflow is running
  const isRunning = executionState === EXECUTION_STATES.RUNNING;

  // Show eraser button when the workflow has run but is not actively executing.
  // Allows resetting completion state so all prompts become editable before re-running.
  // Hidden in CLI watch mode (read-only).
  const canClearState =
    !isCLIManaged &&
    prompts.length > 0 &&
    !isRunning &&
    executionState !== EXECUTION_STATES.CANCELLING &&
    executionState !== EXECUTION_STATES.IDLE &&
    executionState !== null;

  const handleClearState = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Don't collapse the panel
    sendMessage(MESSAGE_TYPES.RESET_WORKFLOW_STATE);
  }, []);

  // Get the status for a prompt based on workflow state
  const getPromptStatus = (
    promptData: (typeof prompts)[0],
    index: number
  ): StepStatus => {
    // When running, position wins for current and past steps.
    // This prevents stale RUNNING icons when currentStep advances without
    // an explicit STEP_STATUS_CHANGED being sent (e.g., CLI watch mode).
    if (isRunning) {
      if (index === currentStep) return STEP_STATUS.RUNNING;
      if (index < currentStep) return STEP_STATUS.COMPLETED;
    }
    // Use explicit status for non-running states or future steps
    // (covers COMPLETED, ERROR, etc. set by STEP_STATUS_CHANGED)
    if (promptData.status) {
      return promptData.status;
    }
    // Position-based fallback
    if (index < currentStep) {
      return STEP_STATUS.COMPLETED;
    }
    return STEP_STATUS.PENDING;
  };

  // Get latest output for a step (history-aware)
  const getLatestOutput = (index: number) => {
    const outputs =
      isViewingHistory && historyOutputs
        ? historyOutputs.steps[index]?.cliOutputs
        : cliOutputs[index];
    if (!outputs || outputs.length === 0) return null;
    return outputs[outputs.length - 1];
  };

  // Build details object for a prompt
  const getPromptDetails = (
    _prompt: (typeof prompts)[0],
    index: number
  ): PromptDetails => {
    void _prompt; // Reserved for future use (end condition results)
    const output = getLatestOutput(index);
    const details: PromptDetails = {};

    if (output?.elapsed) {
      details.duration = output.elapsed;
    }

    // TODO: End condition results would come from workflow state
    // This will be populated when end condition evaluation is complete

    return details;
  };

  if (promptsCollapsed) {
    return (
      <PanelBar
        orientation={panelBarOrientation}
        icon="list-unordered"
        title="Prompts"
        onClick={togglePromptsCollapse}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-editor-bg">
      {/* Header - clickable to collapse */}
      <div
        ref={headerRef}
        className="flex items-center h-[30px] px-2 border-b border-panel-border bg-sidebar-bg flex-shrink-0 cursor-pointer select-none text-description-fg hover:text-foreground transition-colors"
        onClick={togglePromptsCollapse}
        role="button"
        aria-label="Collapse prompts"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && togglePromptsCollapse()}
      >
        <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
        <i className="codicon codicon-list-unordered text-[14px] ml-1" />
        <span className="text-[11px] font-semibold uppercase tracking-wide ml-1.5">
          Prompts
        </span>
        <div className="flex-1 flex justify-center">
          {canClearState && (
            <button
              className="flex items-center justify-center w-[20px] h-[20px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
              onClick={handleClearState}
              title="Clear workflow state — reset all prompts to pending so you can edit them before re-running"
              aria-label="Clear workflow state"
            >
              <i className="codicon codicon-eraser text-[12px]" />
            </button>
          )}
        </div>
        <span>
          <PromptCounter narrow={isHeaderNarrow} />
        </span>
      </div>

      {/* Prompt list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {prompts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center">
            <p className="text-xs italic text-description-fg">
              No prompts loaded
            </p>
          </div>
        ) : (
          <div className="py-1">
            {prompts.map((prompt, index) => {
              const status = getPromptStatus(prompt, index);
              const retryState = retryStates[index];
              const details = getPromptDetails(prompt, index);
              const latestOutput = getLatestOutput(index);
              const isCurrent = isRunning && index === currentStep;
              const isSelected = selectedPromptIndex === index;
              const harnessModel = getPromptHarnessModel(prompt);

              return (
                <PromptItem
                  key={`prompt-${index}-${prompt.name || ""}`}
                  text={prompt.prompt}
                  index={index}
                  name={prompt.name}
                  status={status}
                  retryState={retryState}
                  details={details}
                  latestOutput={latestOutput}
                  isCurrent={isCurrent}
                  isSelected={isSelected}
                  onClick={() => handlePromptClick(index)}
                  harnessLabel={harnessModel.harnessLabel}
                  harnessIsDefault={harnessModel.harnessIsDefault}
                  modelLabel={harnessModel.modelLabel}
                  modelIsDefault={harnessModel.modelIsDefault}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
