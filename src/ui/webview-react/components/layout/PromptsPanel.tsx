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
  STEP_STATUS,
  EXECUTION_STATES,
  type StepStatus,
} from "../../types/messages";

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
  const { prompts, currentStep, executionState, retryStates, cliOutputs } =
    useWorkflowStore();
  const { promptsCollapsed, togglePromptsCollapse } = useUiStore();
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

  // Handle clicking a prompt to edit it
  const handlePromptClick = useCallback(
    (index: number) => {
      // Get the prompt data
      const prompt = prompts[index];
      if (prompt) {
        // Select the prompt for editing
        selectPrompt(index, prompt);
      }
    },
    [prompts, selectPrompt]
  );

  // Determine if workflow is running
  const isRunning = executionState === EXECUTION_STATES.RUNNING;

  // Get the status for a prompt based on workflow state
  const getPromptStatus = (
    promptData: (typeof prompts)[0],
    index: number
  ): StepStatus => {
    // If prompt has explicit status, use it
    if (promptData.status) {
      return promptData.status;
    }
    // Otherwise derive from position
    if (isRunning && index === currentStep) {
      return STEP_STATUS.RUNNING;
    }
    if (index < currentStep) {
      return STEP_STATUS.COMPLETED;
    }
    return STEP_STATUS.PENDING;
  };

  // Get latest output for a step
  const getLatestOutput = (index: number) => {
    const outputs = cliOutputs[index];
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
      details.duration = output.elapsed / 1000;
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
        <span className="ml-auto">
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
