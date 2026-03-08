import React, { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { HARNESS_INFO } from "../../types/messages";
import {
  PromptItem,
  type PromptDetails,
  type PromptOverride,
} from "../prompts/PromptItem";
import { FinalPromptFooter } from "../prompts/FinalPromptFooter";
import { PromptCounter } from "../prompts/PromptCounter";
import { PanelBar } from "../shared";
import {
  MESSAGE_TYPES,
  STEP_STATUS,
  EXECUTION_STATES,
  FINAL_PROMPT_PHASES,
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
  const {
    prompts,
    currentStep,
    executionState,
    retryStates,
    cliOutputs,
    historyOutputs,
    finalPrompt,
    finalPromptStatus,
    finalPromptLoopCount,
    finalPromptPhase,
    finalPromptOutputs,
  } = useWorkflowStore();
  const {
    promptsCollapsed,
    togglePromptsCollapse,
    isViewingHistory,
    loadedWorkflows,
    activeWorkflowId,
    finalPromptFooterExpanded,
    toggleFinalPromptFooterExpanded,
    setFinalPromptFooterExpanded,
  } = useUiStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy === "cli";
  const { selectionTarget, selectPrompt, selectFinalPrompt } = useEditorStore();
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

  // Compute the prompt-level property overrides to surface as chips.
  //
  // A property is shown whenever it is explicitly set at the prompt level
  // (the field is not undefined), regardless of whether the value matches
  // the inherited workflow/global default. This gives a reliable "this
  // prompt has been customised" signal that doesn't change based on what
  // the workflow-level settings happen to be.
  const getPromptOverrides = (
    prompt: (typeof prompts)[0]
  ): PromptOverride[] => {
    const result: PromptOverride[] = [];

    // agent — show basename only
    if (prompt.agent !== undefined) {
      const basename = prompt.agent.replace(/.*[\\/]/, "");
      result.push({
        label: `agent: ${basename}`,
        title: `agent: ${prompt.agent}`,
      });
    }

    // skills — show count
    if (prompt.skills !== undefined && prompt.skills.length > 0) {
      result.push({
        label: `skills: ${prompt.skills.length}`,
        title: prompt.skills.join(", "),
      });
    }

    // allowDynamicExtension — show whenever explicitly set
    if (prompt.allowDynamicExtension !== undefined) {
      result.push({
        label: prompt.allowDynamicExtension ? "dynamic ext" : "no dynamic ext",
      });
    }

    // resumeSession — show whenever explicitly set
    if (prompt.resumeSession !== undefined) {
      result.push({
        label: prompt.resumeSession ? "resume" : "no resume",
      });
    }

    // priorContext — show whenever explicitly set
    if (prompt.priorContext !== undefined) {
      let ctxLabel: string;
      if (Array.isArray(prompt.priorContext)) {
        ctxLabel = `ctx: [${prompt.priorContext.join(",")}]`;
      } else {
        // "all" | "previous" | "none" | "finalPromptAll" | "finalPromptPrevious"
        const shortMap: Record<string, string> = {
          all: "all",
          previous: "prev",
          none: "none",
          finalPromptAll: "fp-all",
          finalPromptPrevious: "fp-prev",
        };
        ctxLabel = `ctx: ${shortMap[prompt.priorContext as string] ?? String(prompt.priorContext)}`;
      }
      result.push({
        label: ctxLabel,
        title: `priorContext: ${String(prompt.priorContext)}`,
      });
    }

    // endCondition — show whenever set (including null = explicitly disabled)
    if (prompt.endCondition !== undefined) {
      if (prompt.endCondition === null) {
        result.push({ label: "ec: disabled" });
      } else if (prompt.endCondition.script) {
        const script = prompt.endCondition.script;
        const basename = script.replace(/.*[\\/]/, "");
        const short =
          basename.length > 30 ? basename.substring(0, 30) + "…" : basename;
        result.push({
          label: `ec: ${short}`,
          title: `endCondition: ${script}`,
        });
      }
    }

    return result;
  };

  // Handle clicking a prompt to edit it (disabled in CLI watch mode)
  const handlePromptClick = useCallback(
    (index: number) => {
      if (isCLIManaged) return;
      const prompt = prompts[index];
      if (prompt) {
        selectPrompt({ kind: "queue", index }, prompt);
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
            const anchor = document.getElementById(
              `output-step-queue-${index}`
            );
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

  const handleFinalPromptSelect = useCallback(() => {
    if (isCLIManaged) return;
    if (finalPrompt) {
      selectFinalPrompt(finalPrompt);
    } else {
      setFinalPromptFooterExpanded(true);
      selectPrompt({ kind: "finalPrompt" }, { prompt: "" });
    }
  }, [
    isCLIManaged,
    finalPrompt,
    selectFinalPrompt,
    setFinalPromptFooterExpanded,
    selectPrompt,
  ]);

  const handleDisableFinalPrompt = useCallback(() => {
    if (isCLIManaged || !finalPrompt) return;
    sendMessage(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, { finalPrompt: null });
  }, [isCLIManaged, finalPrompt]);

  // Compute resolved harness/model for the final prompt using the same
  // three-tier logic as regular prompts, so defaults are shown correctly.
  const getFinalPromptHarnessModel = () => {
    if (!finalPrompt) return {};
    if (finalPrompt._runtime?.harness ?? finalPrompt._runtime?.model) {
      const h = finalPrompt._runtime!.harness;
      const m = finalPrompt._runtime!.model;
      return {
        harnessLabel: h
          ? (HARNESS_INFO[h as keyof typeof HARNESS_INFO]?.name ?? h)
          : undefined,
        harnessIsDefault: false,
        modelLabel: m,
        modelIsDefault: false,
      };
    }
    const harnessIsDefault = finalPrompt.harness === undefined;
    const modelIsDefault = finalPrompt.model === undefined;
    const effectiveHarness =
      finalPrompt.harness ??
      workflowProperties.harness ??
      globalSettings.harness;
    const effectiveModel =
      finalPrompt.model ?? workflowProperties.model ?? globalSettings.model;
    return {
      harnessLabel:
        HARNESS_INFO[effectiveHarness as keyof typeof HARNESS_INFO]?.name ??
        effectiveHarness,
      harnessIsDefault,
      modelLabel: effectiveModel,
      modelIsDefault,
    };
  };

  // Get the latest CLI output for the current final prompt loop
  const finalPromptLatestOutput = (() => {
    const outputs = finalPromptOutputs[finalPromptLoopCount];
    if (!outputs || outputs.length === 0) return null;
    return outputs[outputs.length - 1];
  })();

  // Compute overrides for the final prompt (same logic as regular prompts)
  const finalPromptOverrides = finalPrompt
    ? getPromptOverrides(finalPrompt)
    : undefined;

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
              const isSelected =
                selectionTarget.kind === "queue" &&
                selectionTarget.index === index;
              const harnessModel = getPromptHarnessModel(prompt);
              const overrides = getPromptOverrides(prompt);

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
                  overrides={overrides}
                />
              );
            })}
          </div>
        )}
      </div>

      <FinalPromptFooter
        finalPrompt={finalPrompt}
        status={finalPromptStatus}
        loopCount={finalPromptLoopCount}
        phase={finalPromptPhase}
        isExpanded={finalPromptFooterExpanded}
        isSelected={selectionTarget.kind === "finalPrompt"}
        isReadOnly={
          isCLIManaged ||
          (finalPromptPhase === FINAL_PROMPT_PHASES.FINAL_PROMPT &&
            finalPromptStatus === STEP_STATUS.RUNNING)
        }
        onSelect={handleFinalPromptSelect}
        onToggleExpanded={toggleFinalPromptFooterExpanded}
        onDisable={handleDisableFinalPrompt}
        {...getFinalPromptHarnessModel()}
        latestOutput={finalPromptLatestOutput}
        overrides={finalPromptOverrides}
      />
    </div>
  );
};
