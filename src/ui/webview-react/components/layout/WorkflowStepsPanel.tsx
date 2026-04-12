import React, { useCallback, useEffect, useState } from "react";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { usePromptStatus, useStepClickHandler } from "@hooks/index";
import { HARNESS_INFO } from "../../types/messages";
import {
  WorkflowStepItem,
  type StepDetails,
  type PromptOverride,
} from "../prompts/WorkflowStep";
import { FinalStepFooter } from "../prompts/FinalStepFooter";
import { PromptCounter } from "../prompts/PromptCounter";
import { PromptChipRail } from "../prompts/PromptChipRail";
import {
  MESSAGE_TYPES,
  STEP_STATUS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  RUNNER_IDS,
} from "../../types/messages";
import { sendMessage } from "../../hooks/useMessageHandler";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { BoundaryBar } from "../prompts/BoundaryBar";
import { ResetConfirmModal } from "../shared/ResetConfirmModal";
import { triggerPanelAnimation } from "@utils/panelAnimation";

/** Local type guard for script steps */
function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

/** Get the displayable text content of a step */
function getStepText(step: WorkflowStep): string {
  return isScriptStep(step) ? step.script : step.prompt;
}

type WorkflowStepComponentProps = React.ComponentProps<typeof WorkflowStepItem>;
type SortableWrapperProps = Omit<
  WorkflowStepComponentProps,
  "dragHandleProps"
> & {
  id: string;
  disabled: boolean;
  /** Visual 1-based slot number rendered outside the draggable area */
  slotNumber: number;
};

function SortableWorkflowStepWrapper({
  id,
  disabled,
  slotNumber,
  ...promptStepProps
}: SortableWrapperProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const style = {
    // Restrict to vertical axis only — prevent horizontal drift during drag
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    // Number column sits outside setNodeRef so it stays anchored to the DOM
    // slot position while the content transforms during drag.
    <div className="flex items-stretch">
      <div className="flex-shrink-0 w-7 flex items-start justify-end pt-2 pr-1 text-[11px] text-description-fg select-none">
        {slotNumber}
      </div>
      <div ref={setNodeRef} style={style} className="flex-1 min-w-0">
        <WorkflowStepItem
          {...promptStepProps}
          displayNumber={slotNumber}
          dragHandleProps={disabled ? undefined : { listeners, attributes }}
        />
      </div>
    </div>
  );
}

/**
 * WorkflowStepsPanel - Left panel showing the list of prompts in the workflow
 *
 * Features:
 * - Collapsible header with prompt count
 * - List of PromptStep components with status
 * - Click to select prompt for editing
 * - Empty state when no prompts loaded
 * - Retry and end condition result display
 */
export const WorkflowStepsPanel: React.FC<{
  onRequestSidebar?: () => void;
  onRequestClose?: () => void;
}> = ({
  onRequestSidebar,
  onRequestClose,
}) => {
  const {
    steps: prompts,
    currentStep,
    executionState,
    retryStates,
    liveOrderedEntries,
    historyOutputs,
    finalStep,
    finalStepStatus,
    finalStepLoopCount,
    finalStepPhase,
  } = useWorkflowStore();
  const {
    stepsCollapsed: promptsCollapsed,
    togglePromptsCollapse,
    isViewingHistory,
    loadedWorkflows,
    activeWorkflowId,
    finalStepFooterExpanded,
    toggleFinalStepFooterExpanded,
    setFinalStepFooterExpanded,
  } = useUiStore();

  const getPromptStatus = usePromptStatus();
  const handleStepClick = useStepClickHandler();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;
  const { selectionTarget, selectPrompt, selectFinalStep, deselect } =
    useEditorStore();
  const { workflowProperties, globalSettings } = useSettingsStore();
  const [headerRef, isHeaderNarrow] = useElementNarrow<HTMLDivElement>(200);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [setPositionIndex, setSetPositionIndex] = useState<number | null>(null);

  // Compute the harness/model to display for a prompt.
  //
  // For prompts that have already started executing, use _runtime values so
  // the display shows what was actually used and doesn't change if the
  // workflow-level settings are later modified.
  //
  // For pending prompts, compute from the three-tier precedence (prompt →
  // workflow → global) so the display stays live and reflects any changes.
  const getPromptHarnessModel = (prompt: (typeof prompts)[0]) => {
    if (isScriptStep(prompt))
      return {
        harnessLabel: undefined,
        harnessIsDefault: true,
        modelLabel: undefined,
        modelIsDefault: true,
      };
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
  // A property is shown when it is explicitly set at the prompt level AND
  // it meaningfully differs from (or adds to) the inherited workflow/global
  // default. Redundant chips — e.g. "ec: disabled" when the workflow is
  // already disabled — are suppressed so overrides reflect actual differences.
  const getPromptOverrides = (
    prompt: (typeof prompts)[0]
  ): PromptOverride[] => {
    const result: PromptOverride[] = [];
    if (isScriptStep(prompt)) return result;

    // agent — show basename only, or explicit none when disabled
    if (prompt.agent === null) {
      result.push({
        label: "agent: none",
        title: "agent explicitly disabled",
      });
    } else if (prompt.agent != null) {
      const basename = prompt.agent.replace(/.*[\\/]/, "");
      result.push({
        label: `agent: ${basename}`,
        title: `agent: ${prompt.agent}`,
      });
    }

    // skills — show count, or explicit none when disabled
    if (prompt.skills === null) {
      result.push({
        label: "skills: none",
        title: "skills explicitly disabled",
      });
    } else if (prompt.skills != null && prompt.skills.length > 0) {
      result.push({
        label: `skills: ${prompt.skills.length}`,
        title: prompt.skills.join(", "),
      });
    }

    // mcpServers — show whenever explicitly set
    if (prompt.mcpServers !== undefined) {
      const hasFlightpath =
        Array.isArray(prompt.mcpServers) &&
        prompt.mcpServers.includes("flightpath");
      result.push({
        label: hasFlightpath ? "dynamic ext" : "no dynamic ext",
      });
    }

    // hooks — show when explicitly set
    if (prompt.hooks !== undefined) {
      if (prompt.hooks === null) {
        result.push({ label: "hooks: none" });
      } else if (Array.isArray(prompt.hooks) && prompt.hooks.length > 0) {
        result.push({ label: `hooks: ${prompt.hooks.length}` });
      }
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
        // "all" | "previous" | "none" | "finalStepAll" | "finalStepPrevious"
        const shortMap: Record<string, string> = {
          all: "all",
          previous: "prev",
          none: "none",
          finalStepAll: "fs-all",
          finalStepPrevious: "fs-prev",
        };
        ctxLabel = `ctx: ${shortMap[prompt.priorContext as string] ?? String(prompt.priorContext)}`;
      }
      result.push({
        label: ctxLabel,
        title: `priorContext: ${String(prompt.priorContext)}`,
      });
    }

    // endCondition — only show "ec: disabled" if the workflow actually has an
    // active end condition to override. If the workflow is already disabled/unset,
    // the chip is redundant (the prompt value matches the inherited default).
    if (prompt.endCondition !== undefined) {
      if (prompt.endCondition === null) {
        const workflowHasActiveEndCondition =
          workflowProperties.endCondition != null &&
          Boolean(workflowProperties.endCondition.script);
        if (workflowHasActiveEndCondition) {
          result.push({ label: "ec: disabled" });
        }
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
      handleStepClick(index);
    },
    [isCLIManaged, handleStepClick]
  );

  const handleFinalStepSelect = useCallback(() => {
    if (isCLIManaged) return;
    if (finalStep) {
      selectFinalStep(finalStep);
    } else {
      setFinalStepFooterExpanded(true);
      selectPrompt({ kind: FINAL_STEP_PHASES.FINAL_STEP }, { prompt: "" });
    }
  }, [
    isCLIManaged,
    finalStep,
    selectFinalStep,
    setFinalStepFooterExpanded,
    selectPrompt,
  ]);

  const handleDisableFinalStep = useCallback(() => {
    if (isCLIManaged || !finalStep) return;
    sendMessage(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, { finalStep: null });
  }, [isCLIManaged, finalStep]);

  // Compute resolved harness/model for the final step using the same
  // three-tier logic as regular prompts, so defaults are shown correctly.
  const getFinalStepHarnessModel = () => {
    if (!finalStep || isScriptStep(finalStep)) return {};
    if (finalStep._runtime?.harness ?? finalStep._runtime?.model) {
      const h = finalStep._runtime!.harness;
      const m = finalStep._runtime!.model;
      return {
        harnessLabel: h
          ? (HARNESS_INFO[h as keyof typeof HARNESS_INFO]?.name ?? h)
          : undefined,
        harnessIsDefault: false,
        modelLabel: m,
        modelIsDefault: false,
      };
    }
    const harnessIsDefault = finalStep.harness === undefined;
    const modelIsDefault = finalStep.model === undefined;
    const effectiveHarness =
      finalStep.harness ?? workflowProperties.harness ?? globalSettings.harness;
    const effectiveModel =
      finalStep.model ?? workflowProperties.model ?? globalSettings.model;
    return {
      harnessLabel:
        HARNESS_INFO[effectiveHarness as keyof typeof HARNESS_INFO]?.name ??
        effectiveHarness,
      harnessIsDefault,
      modelLabel: effectiveModel,
      modelIsDefault,
    };
  };

  // Get the latest CLI output for the current final step loop
  const finalStepLatestOutput = (() => {
    const cliEntries = liveOrderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in e &&
        (e as any).target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
        (e as any).target.loopIndex === finalStepLoopCount
    );
    if (cliEntries.length === 0) return null;
    return (cliEntries[cliEntries.length - 1] as any).cliOutput;
  })();

  // Compute overrides for the final step (same logic as regular prompts)
  const finalStepOverrides = finalStep
    ? getPromptOverrides(finalStep)
    : undefined;

  // Determine if workflow is running
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;

  // Show eraser button when the workflow has run but is not actively executing.
  // Allows resetting completion state so all prompts become editable before re-running.
  // Hidden in CLI watch mode (read-only).
  // Also check prompt statuses directly — after an undo, executionState may
  // still be IDLE even though prompts were restored to a completed/error state.
  const hasCompletedPrompts = prompts.some((p) =>
    isScriptStep(p)
      ? p._runtime?.completedAt !== undefined
      : p.status && p.status !== STEP_STATUS.PENDING
  );
  const canClearState =
    !isCLIManaged &&
    prompts.length > 0 &&
    !isRunning &&
    executionState !== EXECUTION_STATES.CANCELLING &&
    ((executionState !== EXECUTION_STATES.IDLE && executionState !== null) ||
      hasCompletedPrompts);

  const handleClearState = useCallback(() => {
    if (!globalSettings.confirmResetOperations) {
      sendMessage(MESSAGE_TYPES.RESET_WORKFLOW_STATE, {});
    } else {
      setShowClearConfirm(true);
    }
  }, [globalSettings.confirmResetOperations]);

  // Get latest output for a step (history-aware)
  const getLatestOutput = (index: number) => {
    const cliEntries =
      isViewingHistory && historyOutputs
        ? historyOutputs.orderedEntries.filter(
            (e) =>
              e.kind === OUTPUT_HISTORY_KINDS.CLI &&
              "target" in e &&
              e.target.kind === FINAL_STEP_PHASES.QUEUE &&
              (e.target as any).stepIndex === index
          )
        : liveOrderedEntries.filter(
            (e) =>
              e.kind === OUTPUT_HISTORY_KINDS.CLI &&
              "target" in e &&
              (e as any).target.kind === FINAL_STEP_PHASES.QUEUE &&
              (e as any).target.stepIndex === index
          );
    if (cliEntries.length === 0) return null;
    return (cliEntries[cliEntries.length - 1] as any).cliOutput as any;
  };

  // Build details object for a prompt
  const getPromptDetails = (
    _prompt: (typeof prompts)[0],
    index: number
  ): StepDetails => {
    void _prompt; // Reserved for future use (end condition results)
    const output = getLatestOutput(index);
    const details: StepDetails = {};

    if (output?.elapsed) {
      details.duration = output.elapsed;
    }

    // TODO: End condition results would come from workflow state
    // This will be populated when end condition evaluation is complete

    return details;
  };

  const handleSetPositionClick = useCallback(
    (index: number) => {
      if (!globalSettings.confirmResetOperations) {
        sendMessage(MESSAGE_TYPES.SET_START_POSITION, { toIndex: index });
      } else {
        setSetPositionIndex(index);
      }
    },
    [globalSettings.confirmResetOperations]
  );

  const handleSetPositionConfirm = useCallback(() => {
    if (setPositionIndex === null) return;
    sendMessage(MESSAGE_TYPES.SET_START_POSITION, {
      toIndex: setPositionIndex,
    });
    setSetPositionIndex(null);
  }, [setPositionIndex]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const canReorder = canChangeStartPosition && prompts.length - currentStep > 1;

  const completedCount = prompts
    .slice(0, currentStep)
    .filter((p, i) => getPromptStatus(p, i) !== STEP_STATUS.SKIPPED).length;
  const skippedCount = currentStep - completedCount;

  // Local sortable ID state — dnd-kit owns this for smooth drop animations.
  // IDs are stable absolute indices ("prompt-pending-N") so dnd-kit can track
  // items by identity across re-renders.
  const [sortableIds, setSortableIds] = useState<string[]>(() =>
    prompts
      .slice(currentStep)
      .map((_, i) => `prompt-pending-${currentStep + i}`)
  );

  // Sync local IDs when prompts/currentStep change due to external events
  // (session load, set-position confirmed, etc.).
  useEffect(() => {
    setSortableIds(
      prompts
        .slice(currentStep)
        .map((_, i) => `prompt-pending-${currentStep + i}`)
    );
  }, [prompts, currentStep]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIdx = sortableIds.indexOf(String(active.id));
      const newIdx = sortableIds.indexOf(String(over.id));
      if (oldIdx === -1 || newIdx === -1) return;

      // Update local state first so dnd-kit animates to the new position (not back)
      const newSortableIds = arrayMove(sortableIds, oldIdx, newIdx);
      setSortableIds(newSortableIds);

      // Send positions within the current pending slice (0-based), not original
      // absolute indices. The stable IDs (e.g. "prompt-pending-4") encode the
      // original absolute index, but state.steps may have been reordered by a
      // prior drag — so the backend must index into the pending slice it holds,
      // not into the full prompts array by original position.
      const newPendingOrder = newSortableIds.map((id) =>
        sortableIds.indexOf(id)
      );
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, { newPendingOrder });

      // Cancel any active queue-prompt selection — the selected index may now
      // refer to a different prompt after reorder.
      const editorStore = useEditorStore.getState();
      if (editorStore.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        editorStore.cancelEdit();
      }
    },
    [sortableIds]
  );

  // In mobile mode (onRequestClose present), disable all collapse interactions —
  // the panel is a full-screen overlay and has its own close button.
  const isMobileMode = Boolean(onRequestClose);

  function handleToggle() {
    if (isMobileMode) return;
    triggerPanelAnimation();
    togglePromptsCollapse();
  }

  if (promptsCollapsed && !isMobileMode) {
    return <PromptChipRail onExpand={handleToggle} />;
  }

  return (
    <div className="flex flex-col h-full bg-editor-bg">
      {/* Header — clickable to collapse in desktop mode; non-interactive in mobile */}
      <div
        ref={headerRef}
        className={`flex items-center h-[30px] px-2 border-b border-panel-border bg-sidebar-bg flex-shrink-0 transition-colors${isMobileMode ? "" : " cursor-pointer select-none text-description-fg hover:text-foreground"}`}
        onClick={isMobileMode ? undefined : handleToggle}
        role={isMobileMode ? undefined : "button"}
        aria-label={isMobileMode ? undefined : "Collapse steps"}
        tabIndex={isMobileMode ? undefined : 0}
        onKeyDown={
          isMobileMode ? undefined : (e) => e.key === "Enter" && handleToggle()
        }
      >
        {/* Left: collapse chevron (desktop) OR collapse-to-sidebar arrow (mobile fullwidth) */}
        {!isMobileMode && (
          <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
        )}
        {onRequestSidebar && (
          <button
            className="flex items-center justify-center w-[20px] h-[20px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onRequestSidebar();
            }}
            title="Collapse to sidebar"
            aria-label="Collapse steps to sidebar"
          >
            <i className="codicon codicon-arrow-left text-[12px]" />
          </button>
        )}
        <i className="codicon codicon-list-unordered text-[14px] ml-1" />
        <span className="text-[11px] font-semibold uppercase tracking-wide ml-1.5">
          Steps
        </span>
        <div className="flex-1 flex justify-center">
          {canClearState && (
            <button
              className="flex items-center justify-center w-[20px] h-[20px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                handleClearState();
              }}
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
        {onRequestClose && (
          <button
            className="flex items-center justify-center w-[20px] h-[20px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors ml-1"
            onClick={(e) => {
              e.stopPropagation();
              onRequestClose();
            }}
            title="Close prompts"
            aria-label="Close prompts panel"
          >
            <i className="codicon codicon-close text-[12px]" />
          </button>
        )}
      </div>

      {/* Prompt list */}
      <div
        className="flex-1 overflow-y-auto min-h-0"
        role="listbox"
        tabIndex={0}
        onClick={(e) => {
          // Deselect the current prompt when clicking blank space in the list.
          // Only fire when the click target is this container itself (not a child).
          if (e.target === e.currentTarget) {
            deselect();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            deselect();
          }
        }}
      >
        {prompts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center">
            <p className="text-xs italic text-description-fg">
              No prompts loaded
            </p>
          </div>
        ) : (
          <div className="py-1">
            {/* Done prompts (indices 0..doneStepCount-1).
                doneStepCount is capped at currentStep to guarantee no overlap with
                the pending section (which starts at currentStep). History entries
                are NOT used to further cap doneStepCount: a step should remain
                visible even if its output wasn't captured in the current history
                file (e.g. script step ran in session 1, prompt step ran in
                session 2 appended to the same history, or output capture failed). */}
            {(() => {
              const doneStepCount = currentStep;
              return prompts.slice(0, doneStepCount).map((prompt, sliceIdx) => {
                const index = sliceIdx;
                const slotNumber = index + 1;
                const status = getPromptStatus(prompt, index);
                const retryState = retryStates[index];
                const details = getPromptDetails(prompt, index);
                const latestOutput = getLatestOutput(index);
                const isSelected =
                  selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                  selectionTarget.index === index;
                const harnessModel = getPromptHarnessModel(prompt);
                const overrides = getPromptOverrides(prompt);
                return (
                  <div
                    key={`prompt-${index}-${prompt.name || ""}`}
                    className="flex items-stretch"
                  >
                    {/* 2px green accent — compensated by narrowing number col by 2px so numbers stay aligned with pending items */}
                    <div className="w-[2px] flex-shrink-0 self-stretch bg-bash-status-success" />
                    <div className="flex-shrink-0 w-[26px] flex items-start justify-end pt-2 pr-1 text-[11px] text-description-fg select-none">
                      {slotNumber}
                    </div>
                    <div className="flex-1 min-w-0">
                      <WorkflowStepItem
                        text={getStepText(prompt)}
                        index={index}
                        displayNumber={slotNumber}
                        name={prompt.name}
                        status={status}
                        retryState={retryState}
                        details={details}
                        latestOutput={latestOutput}
                        isCurrent={false}
                        isSelected={isSelected}
                        onClick={() => handlePromptClick(index)}
                        harnessLabel={harnessModel.harnessLabel}
                        harnessIsDefault={harnessModel.harnessIsDefault}
                        modelLabel={harnessModel.modelLabel}
                        modelIsDefault={harnessModel.modelIsDefault}
                        overrides={overrides}
                        canSetStartPosition={canChangeStartPosition}
                        startPositionDirection="rewind"
                        onSetStartPosition={() => handleSetPositionClick(index)}
                        hideBorderBottom={
                          sliceIdx === doneStepCount - 1 &&
                          doneStepCount < prompts.length
                        }
                        dimmed
                        isScript={isScriptStep(prompt)}
                      />
                    </div>
                  </div>
                );
              });
            })()}

            {/* Boundary bar between done and pending */}
            {currentStep > 0 && currentStep < prompts.length && (
              <BoundaryBar
                completedCount={completedCount}
                skippedCount={skippedCount}
              />
            )}

            {/* Sortable pending prompts (currentStep..end) — includes current step */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={sortableIds}
                strategy={verticalListSortingStrategy}
              >
                {sortableIds.map((id, visualIdx) => {
                  const index = parseInt(id.replace("prompt-pending-", ""));
                  const prompt = prompts[index];
                  if (!prompt) return null;
                  // Use visual position, not absolute index, so isCurrentStep
                  // stays correct after local reorders (before backend confirms).
                  const isCurrentStep = visualIdx === 0;
                  const status = getPromptStatus(prompt, index);
                  const retryState = retryStates[index];
                  const details = getPromptDetails(prompt, index);
                  const latestOutput = getLatestOutput(index);
                  const isCurrent = isRunning && isCurrentStep;
                  const isSelected =
                    selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                    selectionTarget.index === index;
                  const harnessModel = getPromptHarnessModel(prompt);
                  const overrides = getPromptOverrides(prompt);
                  // Target index for set-position is currentStep + visual offset,
                  // matching the post-reorder backend index for this slot.
                  const setPositionTarget = currentStep + visualIdx;
                  const slotNumber = currentStep + visualIdx + 1;
                  return (
                    <SortableWorkflowStepWrapper
                      key={id}
                      id={id}
                      disabled={!canReorder}
                      slotNumber={slotNumber}
                      text={getStepText(prompt)}
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
                      canSetStartPosition={
                        canChangeStartPosition && !isCurrentStep
                      }
                      startPositionDirection="forward"
                      onSetStartPosition={
                        !isCurrentStep
                          ? () => handleSetPositionClick(setPositionTarget)
                          : undefined
                      }
                      isScript={isScriptStep(prompt)}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </div>

      <FinalStepFooter
        finalStep={finalStep}
        status={finalStepStatus}
        loopCount={finalStepLoopCount}
        phase={finalStepPhase}
        isExpanded={finalStepFooterExpanded}
        isSelected={selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP}
        isReadOnly={
          isCLIManaged ||
          (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP &&
            finalStepStatus === STEP_STATUS.RUNNING)
        }
        onSelect={handleFinalStepSelect}
        onToggleExpanded={toggleFinalStepFooterExpanded}
        onDisable={handleDisableFinalStep}
        {...getFinalStepHarnessModel()}
        latestOutput={finalStepLatestOutput}
        overrides={finalStepOverrides}
      />
      <ResetConfirmModal
        isOpen={showClearConfirm}
        title="Clear Workflow State"
        message="Are you sure you want to clear all workflow state?"
        detail="All prompt statuses will reset to pending. This cannot be undone."
        confirmLabel="Clear All"
        onConfirm={() => {
          sendMessage(MESSAGE_TYPES.RESET_WORKFLOW_STATE, {});
          setShowClearConfirm(false);
        }}
        onCancel={() => setShowClearConfirm(false)}
      />
      {setPositionIndex !== null &&
        (() => {
          const isRewind = setPositionIndex < currentStep;
          const stepN = setPositionIndex + 1;
          const total = prompts.length;
          const detail = isRewind
            ? stepN > 1
              ? `Steps ${stepN}–${total} will reset to pending. Steps 1–${stepN - 1} remain completed.`
              : `All ${total} steps will reset to pending.`
            : `Steps ${currentStep + 1}–${stepN - 1} will be marked as skipped. Steps ${stepN}–${total} remain pending.`;
          return (
            <ResetConfirmModal
              isOpen={true}
              title="Set Start Position"
              message={`Start workflow from step ${stepN}?`}
              detail={detail}
              confirmLabel="Set Position"
              onConfirm={handleSetPositionConfirm}
              onCancel={() => setSetPositionIndex(null)}
            />
          );
        })()}
    </div>
  );
};
