import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { CSS } from "@dnd-kit/utilities";
import { BoundaryBar } from "../prompts/BoundaryBar";
import { ResetConfirmModal } from "../shared/ResetConfirmModal";

type PromptItemComponentProps = React.ComponentProps<typeof PromptItem>;
type SortableWrapperProps = Omit<
  PromptItemComponentProps,
  "dragHandleProps"
> & {
  id: string;
  disabled: boolean;
};

function SortablePromptItemWrapper({
  id,
  disabled,
  ...promptItemProps
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
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <PromptItem
        {...promptItemProps}
        dragHandleProps={disabled ? undefined : { listeners, attributes }}
      />
    </div>
  );
}

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
  const { selectionTarget, selectPrompt, selectFinalPrompt, deselect } =
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
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;

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

  const handleClearState = useCallback(() => {
    if (!globalSettings.confirmResetOperations) {
      sendMessage(MESSAGE_TYPES.RESET_WORKFLOW_STATE, {});
    } else {
      setShowClearConfirm(true);
    }
  }, [globalSettings.confirmResetOperations, sendMessage]);

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

  const handleSetPositionClick = useCallback(
    (index: number) => {
      if (!globalSettings.confirmResetOperations) {
        sendMessage(MESSAGE_TYPES.SET_START_POSITION, { toIndex: index });
      } else {
        setSetPositionIndex(index);
      }
    },
    [globalSettings.confirmResetOperations, sendMessage]
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
    prompts.slice(currentStep).map((_, i) => `prompt-pending-${currentStep + i}`)
  );

  // Sync local IDs when prompts/currentStep change due to external events
  // (session load, set-position confirmed, etc.). We intentionally do NOT sync
  // on every render — only when the pending slice itself changes.
  const prevPromptsRef = useRef(prompts);
  const prevCurrentStepRef = useRef(currentStep);
  useEffect(() => {
    if (
      prevPromptsRef.current !== prompts ||
      prevCurrentStepRef.current !== currentStep
    ) {
      prevPromptsRef.current = prompts;
      prevCurrentStepRef.current = currentStep;
      setSortableIds(
        prompts.slice(currentStep).map((_, i) => `prompt-pending-${currentStep + i}`)
      );
    }
  });

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

      // Derive the absolute-index order for the backend
      const newPendingOrder = newSortableIds.map((id) =>
        parseInt(id.replace("prompt-pending-", ""))
      );
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, { newPendingOrder });

      // Cancel any active queue-prompt selection — the selected index may now
      // refer to a different prompt after reorder.
      const editorStore = useEditorStore.getState();
      if (editorStore.selectionTarget.kind === "queue") {
        editorStore.cancelEdit();
      }
    },
    [sortableIds, sendMessage]
  );

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
      </div>

      {/* Prompt list */}
      <div
        className="flex-1 overflow-y-auto min-h-0"
        onClick={(e) => {
          // Deselect the current prompt when clicking blank space in the list.
          // Only fire when the click target is this container itself (not a child).
          if (e.target === e.currentTarget) {
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
            {/* Done prompts (indices 0..currentStep-1) */}
            {prompts.slice(0, currentStep).map((prompt, sliceIdx) => {
              const index = sliceIdx;
              const status = getPromptStatus(prompt, index);
              const retryState = retryStates[index];
              const details = getPromptDetails(prompt, index);
              const latestOutput = getLatestOutput(index);
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
                />
              );
            })}

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
                    selectionTarget.kind === "queue" &&
                    selectionTarget.index === index;
                  const harnessModel = getPromptHarnessModel(prompt);
                  const overrides = getPromptOverrides(prompt);
                  // Target index for set-position is currentStep + visual offset,
                  // matching the post-reorder backend index for this slot.
                  const setPositionTarget = currentStep + visualIdx;
                  return (
                    <SortablePromptItemWrapper
                      key={id}
                      id={id}
                      disabled={!canReorder}
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
                      canSetStartPosition={
                        canChangeStartPosition && !isCurrentStep
                      }
                      startPositionDirection="forward"
                      onSetStartPosition={
                        !isCurrentStep
                          ? () => handleSetPositionClick(setPositionTarget)
                          : undefined
                      }
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
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
