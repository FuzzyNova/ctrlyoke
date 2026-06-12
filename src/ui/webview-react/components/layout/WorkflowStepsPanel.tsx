import React, { useCallback, useEffect, useState } from "react";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import {
  usePromptStatus,
  useStepClickHandler,
  useStepContextMenu,
  useFinalStepContextMenu,
  useLatestStepOutput,
  usePasteToEndContextMenu,
  useLongPress,
} from "@hooks/index";
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
import { triggerPanelAnimation } from "@utils/panelAnimation";
import {
  getStepAccentClass,
  isWorkflowActive,
  isWorkflowRunning,
} from "../../utils/status";
import {
  buildWorkflowStepEnabledState,
  isEditableClipboardTarget,
  readWorkflowStepFromClipboard,
  serializeWorkflowStepText,
  writeClipboardText,
} from "@utils/stepClipboard";

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
  ...stepItemProps
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
  const borderBgClass = stepItemProps.isCurrent
    ? "bg-status-idle animate-pulse-custom"
    : "bg-transparent";
  return (
    // Number column sits outside setNodeRef so it stays anchored to the DOM
    // slot position while the content transforms during drag.
    <div className="flex items-stretch">
      <div className={`w-[2px] flex-shrink-0 self-stretch ${borderBgClass}`} />
      <div className="flex-shrink-0 w-[26px] flex items-start justify-end pt-2 pr-1 text-xs text-description-fg select-none">
        {slotNumber}
      </div>
      <div ref={setNodeRef} style={style} className="relative flex-1 min-w-0">
        {stepItemProps.isCurrent && (
          <>
            <div
              className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] ${borderBgClass}`}
              aria-hidden="true"
            />
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[2px] ${borderBgClass}`}
              aria-hidden="true"
            />
          </>
        )}
        <WorkflowStepItem
          {...stepItemProps}
          displayNumber={slotNumber}
          dragHandleProps={disabled ? undefined : { listeners, attributes }}
        />
      </div>
    </div>
  );
}

/**
 * WorkflowStepsPanel - Left panel showing the list of steps in the workflow
 *
 * Features:
 * - Collapsible header with step count
 * - List of PromptStep components with status
 * - Click to select step for editing
 * - Empty state when no steps loaded
 * - Retry and end condition result display
 */
const WorkflowStepsPanelInner: React.FC<{
  onRequestSidebar?: () => void;
  onRequestClose?: () => void;
}> = ({ onRequestSidebar, onRequestClose }) => {
  const {
    steps,
    currentStep,
    executionState,
    retryStates,
    liveOrderedEntries,
    finalStep,
    finalStepStatus,
    finalStepLoopCount,
    finalStepPhase,
    liveContextWindow,
  } = useWorkflowStore();
  const {
    stepsCollapsed,
    togglePromptsCollapse,
    loadedWorkflows,
    activeWorkflowId,
    finalStepFooterExpanded,
    toggleFinalStepFooterExpanded,
    setFinalStepFooterExpanded,
  } = useUiStore();

  const getPromptStatus = usePromptStatus();
  const stepClickHandler = useStepClickHandler();
  const getLatestOutput = useLatestStepOutput();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;
  const { selectionTarget, selectPrompt, selectFinalStep, deselect } =
    useEditorStore();
  const { workflowProperties, globalSettings } = useSettingsStore();
  const [headerRef, isHeaderNarrow] = useElementNarrow<HTMLDivElement>(200);
  // Determine if workflow is running
  const isRunning = isWorkflowRunning(executionState);
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;
  const canPasteStep = executionState !== EXECUTION_STATES.CANCELLING;
  const {
    openContextMenu,
    handleSetStartPosition,
    contextMenuPortal,
    setPositionModal,
  } = useStepContextMenu({
    isCLIManaged,
    canChangeStartPosition,
    canPasteStep,
    executionState,
    confirmResetOperations: globalSettings.confirmResetOperations,
    totalSteps: steps.length,
    currentStep,
  });

  const { openPasteToEndMenu, pasteToEndMenuPortal } = usePasteToEndContextMenu(
    {
      isCLIManaged,
      canPasteStep,
      executionState,
      totalSteps: steps.length,
    }
  );

  const bgLongPressHandlers = useLongPress(openPasteToEndMenu, 500, true);

  // Compute the harness/model to display for a step.
  //
  // For steps that have already started executing, use _runtime values so
  // the display shows what was actually used and doesn't change if the
  // workflow-level settings are later modified.
  //
  // For pending steps, compute from the three-tier precedence (step →
  // workflow → global) so the display stays live and reflects any changes.
  const getStepHarnessModel = (
    step: (typeof steps)[0],
    status?: StepStatus
  ) => {
    if (isScriptStep(step))
      return {
        harnessLabel: undefined,
        harnessIsDefault: true,
        modelLabel: undefined,
        modelIsDefault: true,
      };
    // Use runtime values when they're present, OR when the step has reached a
    // terminal status and any _runtime exists — this covers the case where a step
    // completed after the last SESSION_RESTORED so harness/model weren't yet in
    // the working file snapshot but were since delivered via STEP_STATUS_CHANGED.
    const isTerminalStatus =
      status === STEP_STATUS.COMPLETED ||
      status === STEP_STATUS.FAILED ||
      status === STEP_STATUS.CANCELLED ||
      status === STEP_STATUS.SKIPPED;
    if (
      (step._runtime?.harness ?? step._runtime?.model) ||
      (isTerminalStatus && step._runtime != null)
    ) {
      const h = step._runtime?.harness;
      const m = step._runtime?.model;
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
    const harnessIsDefault = step.harness === undefined;
    const modelIsDefault = step.model === undefined;
    const effectiveHarness =
      step.harness ?? workflowProperties.harness ?? globalSettings.harness;
    const effectiveModel =
      step.model ?? workflowProperties.model ?? globalSettings.model;
    return {
      harnessLabel:
        HARNESS_INFO[effectiveHarness as keyof typeof HARNESS_INFO]?.name ??
        effectiveHarness,
      harnessIsDefault,
      modelLabel: effectiveModel,
      modelIsDefault,
    };
  };

  // Compute the step-level property overrides to surface as chips.
  //
  // A property is shown when it is explicitly set at the step level AND
  // it meaningfully differs from (or adds to) the inherited workflow/global
  // default. Redundant chips — e.g. "ec: disabled" when the workflow is
  // already disabled — are suppressed so overrides reflect actual differences.
  const getStepOverrides = (step: (typeof steps)[0]): PromptOverride[] => {
    const result: PromptOverride[] = [];
    if (isScriptStep(step)) return result;

    // agent — show basename only, or explicit none when disabled
    if (step.agent === null) {
      result.push({
        label: "agent: none",
        title: "agent explicitly disabled",
      });
    } else if (step.agent != null) {
      const basename = step.agent.replace(/.*[\\/]/, "");
      result.push({
        label: `agent: ${basename}`,
        title: `agent: ${step.agent}`,
      });
    }

    // skills — show count, or explicit none when disabled
    if (step.skills === null) {
      result.push({
        label: "skills: none",
        title: "skills explicitly disabled",
      });
    } else if (step.skills != null && step.skills.length > 0) {
      result.push({
        label: `skills: ${step.skills.length}`,
        title: step.skills.join(", "),
      });
    }

    // mcpServers — show whenever explicitly set
    if (step.mcpServers !== undefined) {
      if (step.mcpServers === null) {
        result.push({
          label: "MCP: none",
          title: "MCP servers explicitly disabled",
        });
      } else if (Array.isArray(step.mcpServers)) {
        const count = step.mcpServers.length;
        const hasFlightpath = step.mcpServers.some(
          (s) => typeof s === "string" && s === "flightpath"
        );
        const serverIds = step.mcpServers.map((s) =>
          typeof s === "string" ? s : ((s as { id?: string }).id ?? "custom")
        );
        if (count === 0) {
          result.push({
            label: "MCP: 0",
            title: "MCP servers explicitly set to empty",
          });
        } else if (hasFlightpath && count === 1) {
          result.push({ label: "MCP[flightpath]", title: "MCP: flightpath" });
        } else if (hasFlightpath) {
          result.push({
            label: `MCP[flightpath]+${count - 1}`,
            title: serverIds.join(", "),
          });
        } else {
          result.push({ label: `MCP: ${count}`, title: serverIds.join(", ") });
        }
      }
    }

    // hooks — show when explicitly set
    if (step.hooks !== undefined) {
      if (step.hooks === null) {
        result.push({ label: "hooks: none" });
      } else if (Array.isArray(step.hooks) && step.hooks.length > 0) {
        result.push({ label: `hooks: ${step.hooks.length}` });
      }
    }

    // resumeSession — show whenever explicitly set
    if (step.resumeSession !== undefined) {
      result.push({
        label: step.resumeSession ? "resume" : "no resume",
      });
    }

    // priorContext — show whenever explicitly set
    if (step.priorContext !== undefined) {
      let ctxLabel: string;
      if (Array.isArray(step.priorContext)) {
        ctxLabel = `ctx: [${step.priorContext.join(",")}]`;
      } else {
        // "all" | "previous" | "none" | "finalStepAll" | "finalStepPrevious"
        const shortMap: Record<string, string> = {
          all: "all",
          previous: "prev",
          none: "none",
          finalStepAll: "fs-all",
          finalStepPrevious: "fs-prev",
        };
        ctxLabel = `ctx: ${shortMap[step.priorContext as string] ?? String(step.priorContext)}`;
      }
      result.push({
        label: ctxLabel,
        title: `priorContext: ${String(step.priorContext)}`,
      });
    }

    // endCondition — only show "ec: disabled" if the workflow actually has an
    // active end condition to override. If the workflow is already disabled/unset,
    // the chip is redundant (the step value matches the inherited default).
    if (step.endCondition !== undefined) {
      if (step.endCondition === null) {
        const workflowHasActiveEndCondition =
          workflowProperties.endCondition != null &&
          Boolean(workflowProperties.endCondition.script);
        if (workflowHasActiveEndCondition) {
          result.push({ label: "ec: disabled" });
        }
      } else if (step.endCondition.script) {
        const script = step.endCondition.script;
        const basename = script.replace(/.*[\\/]/, "");
        const short =
          basename.length > 30 ? basename.substring(0, 30) + "…" : basename;
        result.push({
          label: `ec: ${short}`,
          title: `endCondition: ${script}`,
        });
      }
    }

    // preCondition — only show "pc: disabled" if the workflow has an active
    // pre-condition to override. If the workflow has none, the chip is redundant.
    if (step.preCondition !== undefined) {
      if (step.preCondition === null) {
        const workflowHasActivePreCondition =
          workflowProperties.preCondition != null &&
          Boolean(workflowProperties.preCondition.script);
        if (workflowHasActivePreCondition) {
          result.push({ label: "pc: disabled" });
        }
      } else if (step.preCondition.script) {
        const script = step.preCondition.script;
        const basename = script.replace(/.*[\\/]/, "");
        const short =
          basename.length > 30 ? basename.substring(0, 30) + "…" : basename;
        result.push({
          label: `pc: ${short}`,
          title: `preCondition: ${script}`,
        });
      }
    }

    // additionalArgs — show when explicitly set or disabled
    if (step.additionalArgs !== undefined) {
      if (step.additionalArgs === null) {
        result.push({
          label: "args: none",
          title: "additionalArgs explicitly disabled",
        });
      } else {
        const short =
          step.additionalArgs.length > 20
            ? step.additionalArgs.substring(0, 20) + "…"
            : step.additionalArgs;
        result.push({
          label: `args: ${short}`,
          title: `additionalArgs: ${step.additionalArgs}`,
        });
      }
    }

    // toolPermissions — show when explicitly set or disabled
    if (step.toolPermissions !== undefined) {
      if (step.toolPermissions === null) {
        result.push({
          label: "perms: none",
          title: "toolPermissions explicitly disabled",
        });
      } else if (step.toolPermissions.mode) {
        const modeShort: Record<string, string> = {
          dangerouslyAllowAll: "allow all!",
          allowAll: "allow all",
          custom: "custom",
          passthrough: "pass-thru",
        };
        const short =
          modeShort[step.toolPermissions.mode] ?? step.toolPermissions.mode;
        result.push({
          label: `perms: ${short}`,
          title: `toolPermissions: ${step.toolPermissions.mode}`,
        });
      }
    }

    return result;
  };

  // Handle clicking a step to edit it (disabled in CLI watch mode)
  const handleStepClick = useCallback(
    (index: number) => {
      if (isCLIManaged) return;
      stepClickHandler(index);
    },
    [isCLIManaged, stepClickHandler]
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

  const handleToggleFinalStepEnabled = useCallback(() => {
    if (isCLIManaged || !finalStep) return;
    const enabling = finalStep.enabled === false;
    sendMessage(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, {
      finalStep: buildWorkflowStepEnabledState(finalStep, enabling),
      ...(enabling ? { clearProperties: ["enabled"] } : {}),
    });
  }, [isCLIManaged, finalStep]);

  const handleSelectedStepCopy = useCallback(() => {
    if (selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE) {
      return;
    }

    const selectedStep = steps[selectionTarget.index];
    if (!selectedStep) {
      return;
    }

    void writeClipboardText(serializeWorkflowStepText(selectedStep));
  }, [selectionTarget, steps]);

  const handleSelectedStepPaste = useCallback(() => {
    if (
      isCLIManaged ||
      !canPasteStep ||
      selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE
    ) {
      return;
    }

    const afterIndex = selectionTarget.index;
    void readWorkflowStepFromClipboard()
      .then((step) => {
        sendMessage(MESSAGE_TYPES.INSERT_WORKFLOW_STEP, {
          afterIndex,
          step,
        });
      })
      .catch(() => {});
  }, [canPasteStep, isCLIManaged, selectionTarget]);

  const finalStepIsReadOnly =
    isCLIManaged ||
    (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepStatus === STEP_STATUS.RUNNING);

  const { openFinalStepContextMenu, finalStepContextMenuPortal } =
    useFinalStepContextMenu({
      hasFinalStep: !!finalStep,
      isReadOnly: finalStepIsReadOnly,
      isDisabled: finalStep?.enabled === false,
      onToggleEnabled: handleToggleFinalStepEnabled,
    });

  // Compute resolved harness/model for the final step using the same
  // three-tier logic as regular steps, so defaults are shown correctly.
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

  // Compute overrides for the final step (same logic as regular steps)
  const finalStepOverrides = finalStep
    ? getStepOverrides(finalStep)
    : undefined;

  // Build details object for a step
  const getStepDetails = (
    step: (typeof steps)[0],
    index: number,
    status: StepStatus
  ): StepDetails => {
    const output = getLatestOutput(index);
    const details: StepDetails = {};

    if (output?.elapsed) {
      details.duration = output.elapsed;
    }

    if (status === STEP_STATUS.FAILED && index < currentStep) {
      const failureMessage = !isScriptStep(step)
        ? step._runtime?.failureMessage
        : undefined;
      details.message = failureMessage
        ? `Workflow continued after failure: ${failureMessage}`
        : "Workflow continued after this step failed.";
    }

    // TODO: End condition results would come from workflow state
    // This will be populated when end condition evaluation is complete

    return details;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const canReorder = canChangeStartPosition && steps.length - currentStep > 1;

  // Local sortable ID state — dnd-kit owns this for smooth drop animations.
  // IDs are stable absolute indices ("step-pending-N") so dnd-kit can track
  // items by identity across re-renders.
  const [sortableIds, setSortableIds] = useState<string[]>(() =>
    steps.slice(currentStep).map((_, i) => `step-pending-${currentStep + i}`)
  );

  // Sync local IDs when steps/currentStep change due to external events
  // (session load, set-position confirmed, etc.).
  useEffect(() => {
    setSortableIds(
      steps.slice(currentStep).map((_, i) => `step-pending-${currentStep + i}`)
    );
  }, [steps, currentStep]);

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
      // absolute indices. The stable IDs (e.g. "step-pending-4") encode the
      // original absolute index, but state.steps may have been reordered by a
      // prior drag — so the backend must index into the pending slice it holds,
      // not into the full steps array by original position.
      const newPendingOrder = newSortableIds.map((id) =>
        sortableIds.indexOf(id)
      );
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, { newPendingOrder });

      // Cancel any active queue-step selection — the selected index may now
      // refer to a different step after reorder.
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

  if (stepsCollapsed && !isMobileMode) {
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
          <i className="codicon codicon-chevron-right text-xs rotate-90 transition-transform duration-150" />
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
            <i className="codicon codicon-chevron-left text-xs" />
          </button>
        )}
        <i className="codicon codicon-list-ordered text-sm ml-1" />
        <span className="text-xs font-semibold uppercase tracking-wide ml-1.5">
          Steps
        </span>
        <div className="flex-1" />
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
            title="Close steps"
            aria-label="Close steps panel"
          >
            <i className="codicon codicon-close text-xs" />
          </button>
        )}
      </div>

      {/* Step list */}
      <div
        className="flex-1 overflow-y-auto min-h-0"
        role="listbox"
        tabIndex={0}
        onClick={(e) => {
          // Deselect the current step when clicking blank space in the list.
          // Only fire when the click target is this container itself (not a child).
          if (e.target === e.currentTarget) {
            deselect();
          }
        }}
        onContextMenu={(e) => {
          // Only open the paste menu when right-clicking blank background
          // (step items call e.stopPropagation() so they won't bubble here).
          e.preventDefault();
          openPasteToEndMenu(e.clientX, e.clientY);
        }}
        {...bgLongPressHandlers}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            deselect();
            return;
          }

          if (
            !e.ctrlKey ||
            e.altKey ||
            e.metaKey ||
            e.shiftKey ||
            isEditableClipboardTarget(e.target)
          ) {
            return;
          }

          const key = e.key.toLowerCase();
          if (key === "c") {
            if (selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE) {
              return;
            }
            e.preventDefault();
            handleSelectedStepCopy();
            return;
          }

          if (key === "v") {
            if (
              isCLIManaged ||
              !canPasteStep ||
              selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE
            ) {
              return;
            }
            e.preventDefault();
            handleSelectedStepPaste();
          }
        }}
      >
        {steps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center">
            <p className="text-xs italic text-description-fg">
              No steps loaded
            </p>
          </div>
        ) : (
          <div className="py-1">
            {/* Done steps (indices 0..doneStepCount-1).
                doneStepCount is capped at currentStep to guarantee no overlap with
                the pending section (which starts at currentStep). History entries
                are NOT used to further cap doneStepCount: a step should remain
                visible even if its output wasn't captured in the current history
                file (e.g. script step ran in session 1, AI step ran in
                session 2 appended to the same history, or output capture failed). */}
            {(() => {
              const doneStepCount = currentStep;
              return steps.slice(0, doneStepCount).map((step, sliceIdx) => {
                const index = sliceIdx;
                const slotNumber = index + 1;
                const status = getPromptStatus(step, index);
                const retryState = retryStates[index];
                const details = getStepDetails(step, index, status);
                const latestOutput = getLatestOutput(index);
                const isSelected =
                  selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                  selectionTarget.index === index;
                const harnessModel = getStepHarnessModel(step, status);
                const overrides = getStepOverrides(step);
                const runtimeMeta = step._runtime;
                const outputText = latestOutput?.response as string | undefined;
                const isDisabled = step.enabled === false;
                const isExecutionTargetLocked =
                  (isWorkflowActive(executionState) ||
                    executionState === EXECUTION_STATES.CANCELLING) &&
                  index === currentStep;
                return (
                  <div
                    key={`step-${index}-${step.name || ""}`}
                    className="flex items-stretch"
                  >
                    {/* 2px status accent — compensated by narrowing number col by 2px so numbers stay aligned with pending items */}
                    <div
                      className={`w-[2px] flex-shrink-0 self-stretch ${getStepAccentClass(status)}`}
                    />
                    <div className="flex-shrink-0 w-[26px] flex items-start justify-end pt-2 pr-1 text-xs text-description-fg select-none">
                      {slotNumber}
                    </div>
                    <div className="flex-1 min-w-0">
                      <WorkflowStepItem
                        text={getStepText(step)}
                        index={index}
                        displayNumber={slotNumber}
                        name={step.name}
                        status={status}
                        retryState={retryState}
                        details={details}
                        latestOutput={latestOutput}
                        liveContextWindow={liveContextWindow?.[index]}
                        runtimeMeta={runtimeMeta}
                        isDisabled={isDisabled}
                        isCurrent={false}
                        isSelected={isSelected}
                        onClick={() => handleStepClick(index)}
                        harnessLabel={harnessModel.harnessLabel}
                        harnessIsDefault={harnessModel.harnessIsDefault}
                        modelLabel={harnessModel.modelLabel}
                        modelIsDefault={harnessModel.modelIsDefault}
                        overrides={overrides}
                        canSetStartPosition={canChangeStartPosition}
                        startPositionDirection="rewind"
                        onSetStartPosition={() => handleSetStartPosition(index)}
                        onContextMenu={(x, y) =>
                          openContextMenu(x, y, {
                            step,
                            setPositionTarget: index,
                            deleteIndex: index,
                            isCurrentStep: false,
                            isExecutionTargetLocked,
                            direction: "rewind",
                            outputText,
                          })
                        }
                        hideBorderBottom={
                          sliceIdx === doneStepCount - 1 &&
                          doneStepCount < steps.length
                        }
                        dimmed
                        isScript={isScriptStep(step)}
                      />
                    </div>
                  </div>
                );
              });
            })()}

            {/* Sortable pending steps (currentStep..end) — includes current step */}
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
                  const index = parseInt(id.replace("step-pending-", ""));
                  const step = steps[index];
                  if (!step) return null;
                  // Use visual position, not absolute index, so isCurrentStep
                  // stays correct after local reorders (before backend confirms).
                  const isCurrentStep = visualIdx === 0;
                  const status = getPromptStatus(step, index);
                  const retryState = retryStates[index];
                  const details = getStepDetails(step, index, status);
                  const latestOutput = getLatestOutput(index);
                  const isCurrent = isRunning && isCurrentStep;
                  const isSelected =
                    selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                    selectionTarget.index === index;
                  const harnessModel = getStepHarnessModel(step, status);
                  const overrides = getStepOverrides(step);
                  const runtimeMeta = step._runtime;
                  // Target index for set-position is currentStep + visual offset,
                  // matching the post-reorder backend index for this slot.
                  const setPositionTarget = currentStep + visualIdx;
                  const slotNumber = currentStep + visualIdx + 1;
                  const outputText = latestOutput?.response as
                    | string
                    | undefined;
                  const isDisabled = step.enabled === false;
                  const isExecutionTargetLocked =
                    (isWorkflowActive(executionState) ||
                      executionState === EXECUTION_STATES.CANCELLING) &&
                    isCurrentStep;
                  return (
                    <SortableWorkflowStepWrapper
                      key={id}
                      id={id}
                      disabled={!canReorder}
                      slotNumber={slotNumber}
                      text={getStepText(step)}
                      index={index}
                      name={step.name}
                      status={status}
                      retryState={retryState}
                      details={details}
                      latestOutput={latestOutput}
                      liveContextWindow={liveContextWindow?.[index]}
                      runtimeMeta={runtimeMeta}
                      isDisabled={isDisabled}
                      isCurrent={isCurrent}
                      isSelected={isSelected}
                      onClick={() => handleStepClick(index)}
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
                          ? () => handleSetStartPosition(setPositionTarget)
                          : undefined
                      }
                      onContextMenu={(x, y) =>
                        openContextMenu(x, y, {
                          step,
                          setPositionTarget,
                          deleteIndex: index,
                          isCurrentStep,
                          isExecutionTargetLocked,
                          direction: "forward",
                          outputText,
                        })
                      }
                      isScript={isScriptStep(step)}
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
        isReadOnly={finalStepIsReadOnly}
        isDisabled={finalStep?.enabled === false}
        onSelect={handleFinalStepSelect}
        onToggleExpanded={toggleFinalStepFooterExpanded}
        onToggleEnabled={handleToggleFinalStepEnabled}
        onContextMenu={openFinalStepContextMenu}
        {...getFinalStepHarnessModel()}
        latestOutput={finalStepLatestOutput}
        overrides={finalStepOverrides}
      />
      {contextMenuPortal}
      {setPositionModal}
      {pasteToEndMenuPortal}
      {finalStepContextMenuPortal}
    </div>
  );
};

WorkflowStepsPanelInner.displayName = "WorkflowStepsPanel";

export const WorkflowStepsPanel = React.memo(WorkflowStepsPanelInner);
