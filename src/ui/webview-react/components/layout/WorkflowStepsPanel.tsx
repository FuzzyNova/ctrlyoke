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
  useSortableDndSensors,
  useIsViewingDeletedWorkflow,
  useIsSystemGeneratedWorkflow,
} from "@hooks/index";
import { HARNESS_INFO } from "../../types/messages";
import type { HarnessId } from "../../types/messages";
import {
  WorkflowStepItem,
  type StepDetails,
  type PromptOverride,
} from "../prompts/WorkflowStep";
import { FinalStepFooter } from "../prompts/FinalStepFooter";
import { PromptCounter } from "../prompts/PromptCounter";
import { PromptChipRail } from "../prompts/PromptChipRail";
import {
  ExecutingStepHighlight,
  PauseBoundary,
} from "../prompts/ExecutingStepHighlight";
import {
  MESSAGE_TYPES,
  STEP_STATUS,
  EXECUTION_STATES,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  RUNNER_IDS,
  type StepStatus,
} from "../../types/messages";
import { sendMessage } from "../../hooks/useMessageHandler";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import { ExitButton } from "../shared";
import {
  getStepAccentClass,
  isExecutionBusy,
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
type WorkflowStepDragHandleProps =
  WorkflowStepComponentProps["dragHandleProps"];

type StepHarnessModel = Pick<
  WorkflowStepComponentProps,
  | "harnessId"
  | "harnessLabel"
  | "harnessIsDefault"
  | "modelLabel"
  | "modelIsDefault"
>;

type StepContextMenuRequest = {
  step: WorkflowStep;
  setPositionTarget: number;
  deleteIndex: number;
  isCurrentStep: boolean;
  isExecutionTargetLocked: boolean;
  direction: "rewind" | "forward";
  outputText?: string;
};

type WorkflowStepRowProps = {
  step: WorkflowStep;
  index: number;
  slotNumber: number;
  currentStep: number;
  status: StepStatus;
  retryState?: WorkflowStepComponentProps["retryState"];
  latestOutput?: WorkflowStepComponentProps["latestOutput"];
  liveContextWindow?: WorkflowStepComponentProps["liveContextWindow"];
  isCurrent: boolean;
  isSelected: boolean;
  canSetStartPosition: boolean;
  startPositionDirection: "rewind" | "forward";
  setPositionTarget: number;
  isExecutionTargetLocked: boolean;
  hideBorderBottom?: boolean;
  dimmed?: boolean;
  dragHandleProps?: WorkflowStepDragHandleProps;
  getStepHarnessModel: (
    step: WorkflowStep,
    status: StepStatus
  ) => StepHarnessModel;
  getStepOverrides: (step: WorkflowStep) => PromptOverride[];
  onStepClick: (index: number) => void;
  onSetStartPosition: (index: number) => void;
  onOpenContextMenu: (
    x: number,
    y: number,
    request: StepContextMenuRequest
  ) => void;
};

/**
 * Keeps live output/context telemetry updates local to the affected row.
 * The panel itself must still re-render for workflow-level layout changes, but
 * unchanged rows should not repeat token formatting and DOM reconciliation.
 */
const WorkflowStepRow = React.memo<WorkflowStepRowProps>(
  ({
    step,
    index,
    slotNumber,
    currentStep,
    status,
    retryState,
    latestOutput,
    liveContextWindow,
    isCurrent,
    isSelected,
    canSetStartPosition,
    startPositionDirection,
    setPositionTarget,
    isExecutionTargetLocked,
    hideBorderBottom = false,
    dimmed = false,
    dragHandleProps,
    getStepHarnessModel,
    getStepOverrides,
    onStepClick,
    onSetStartPosition,
    onOpenContextMenu,
  }) => {
    const harnessModel = getStepHarnessModel(step, status);
    const overrides = getStepOverrides(step);
    const details: StepDetails = {};

    if (latestOutput?.elapsed) {
      details.duration = latestOutput.elapsed;
    }
    if (status === STEP_STATUS.FAILED && index < currentStep) {
      const failureMessage = !isScriptStep(step)
        ? step._runtime?.failureMessage
        : undefined;
      details.message = failureMessage
        ? `Workflow continued after failure: ${failureMessage}`
        : "Workflow continued after this step failed.";
    }

    const outputText = latestOutput?.response as string | undefined;
    const handleContextMenu = useCallback(
      (x: number, y: number) =>
        onOpenContextMenu(x, y, {
          step,
          setPositionTarget,
          deleteIndex: index,
          isCurrentStep: isCurrent,
          isExecutionTargetLocked,
          direction: startPositionDirection,
          outputText,
        }),
      [
        index,
        isCurrent,
        isExecutionTargetLocked,
        onOpenContextMenu,
        outputText,
        setPositionTarget,
        startPositionDirection,
        step,
      ]
    );

    return (
      <WorkflowStepItem
        text={getStepText(step)}
        index={index}
        displayNumber={slotNumber}
        name={step.name}
        status={status}
        retryState={retryState}
        details={details}
        latestOutput={latestOutput}
        liveContextWindow={liveContextWindow}
        runtimeMeta={step._runtime}
        isDisabled={step.enabled === false}
        isCurrent={isCurrent}
        isSelected={isSelected}
        onClick={() => onStepClick(index)}
        harnessId={harnessModel.harnessId}
        harnessLabel={harnessModel.harnessLabel}
        harnessIsDefault={harnessModel.harnessIsDefault}
        modelLabel={harnessModel.modelLabel}
        modelIsDefault={harnessModel.modelIsDefault}
        overrides={overrides}
        canSetStartPosition={canSetStartPosition}
        startPositionDirection={startPositionDirection}
        onSetStartPosition={() => onSetStartPosition(setPositionTarget)}
        onContextMenu={handleContextMenu}
        hideBorderBottom={hideBorderBottom}
        dimmed={dimmed}
        isScript={isScriptStep(step)}
        dragHandleProps={dragHandleProps}
      />
    );
  }
);

WorkflowStepRow.displayName = "WorkflowStepRow";

type SortableWrapperProps = Omit<WorkflowStepRowProps, "dragHandleProps"> & {
  id: string;
  disabled: boolean;
  /** Visual 1-based slot number rendered outside the draggable area */
  slotNumber: number;
  showPauseBoundaryBefore?: boolean;
};

const SortableWorkflowStepWrapper = React.memo(
  function SortableWorkflowStepWrapper({
    id,
    disabled,
    slotNumber,
    showPauseBoundaryBefore = false,
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
    return (
      // Number column sits outside setNodeRef so it stays anchored to the DOM
      // slot position while the content transforms during drag.
      <div
        className="relative flex items-stretch"
        data-workflow-step-index={stepItemProps.index}
      >
        {showPauseBoundaryBefore && <PauseBoundary />}
        <div className="w-[2px] flex-shrink-0 self-stretch" />
        <div className="flex-shrink-0 w-[26px] flex items-start justify-center pt-2 text-sm text-description-fg select-none">
          {slotNumber}
        </div>
        {stepItemProps.isCurrent && <ExecutingStepHighlight />}
        <div ref={setNodeRef} style={style} className="relative flex-1 min-w-0">
          <WorkflowStepRow
            {...stepItemProps}
            slotNumber={slotNumber}
            dragHandleProps={disabled ? undefined : { listeners, attributes }}
          />
        </div>
      </div>
    );
  }
);

SortableWorkflowStepWrapper.displayName = "SortableWorkflowStepWrapper";

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
    pendingRewind,
  } = useUiStore();

  const getPromptStatus = usePromptStatus();
  const stepClickHandler = useStepClickHandler();
  const getLatestOutput = useLatestStepOutput();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;
  // The lineage on screen was deleted while being viewed, or is an internal
  // system lineage (e.g. commit message generation) whose properties are
  // overridden by its owning feature on the next run regardless of what's
  // edited here — either way, nothing here has anywhere meaningful to write to.
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const isLineageReadOnly =
    isViewingDeletedWorkflow || isSystemGeneratedWorkflow;
  const { selectionTarget, selectPrompt, selectFinalStep, deselect } =
    useEditorStore();
  const { workflowProperties, globalSettings } = useSettingsStore();
  const [headerRef, isHeaderNarrow] = useElementNarrow<HTMLDivElement>(200);
  // Determine if workflow is running
  const isRunning = isWorkflowRunning(executionState);
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
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
    pendingRewind: pendingRewind ?? undefined,
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
  const getStepHarnessModel = useCallback(
    (step: (typeof steps)[0], status?: StepStatus) => {
      if (isScriptStep(step))
        return {
          harnessId: undefined,
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
          harnessId: h as HarnessId | undefined,
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
        harnessId: effectiveHarness as HarnessId | undefined,
        harnessLabel:
          HARNESS_INFO[effectiveHarness as keyof typeof HARNESS_INFO]?.name ??
          effectiveHarness,
        harnessIsDefault,
        modelLabel: effectiveModel,
        modelIsDefault,
      };
    },
    [globalSettings, workflowProperties]
  );

  // Compute the step-level property overrides to surface as chips.
  //
  // A property is shown when it is explicitly set at the step level AND
  // it meaningfully differs from (or adds to) the inherited workflow/global
  // default. Redundant chips — e.g. "ec: disabled" when the workflow is
  // already disabled — are suppressed so overrides reflect actual differences.
  const getStepOverrides = useCallback(
    (step: (typeof steps)[0]): PromptOverride[] => {
      const result: PromptOverride[] = [];

      if (step.executionMode !== undefined) {
        result.push({
          label:
            step.executionMode === EXECUTION_MODES.INTERACTIVE
              ? "Interactive"
              : "Headless",
          title: `executionMode: ${step.executionMode}`,
          icon:
            step.executionMode === EXECUTION_MODES.INTERACTIVE
              ? "debug-console"
              : "terminal",
        });
      }

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
          const hasCtrlYoke = step.mcpServers.some(
            (s) => typeof s === "string" && s === "ctrlyoke"
          );
          const serverIds = step.mcpServers.map((s) =>
            typeof s === "string" ? s : ((s as { id?: string }).id ?? "custom")
          );
          if (count === 0) {
            result.push({
              label: "MCP: 0",
              title: "MCP servers explicitly set to empty",
            });
          } else if (hasCtrlYoke && count === 1) {
            result.push({ label: "MCP[ctrlyoke]", title: "MCP: ctrlyoke" });
          } else if (hasCtrlYoke) {
            result.push({
              label: `MCP[ctrlyoke]+${count - 1}`,
              title: serverIds.join(", "),
            });
          } else {
            result.push({
              label: `MCP: ${count}`,
              title: serverIds.join(", "),
            });
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
    },
    [workflowProperties]
  );

  // Handle clicking a step to edit it (disabled in CLI watch mode)
  const handleStepClick = useCallback(
    (index: number) => {
      if (isCLIManaged) return;
      stepClickHandler(index);
    },
    [isCLIManaged, stepClickHandler]
  );

  const handleFinalStepSelect = useCallback(() => {
    if (isCLIManaged || isLineageReadOnly) return;
    if (finalStep) {
      selectFinalStep(finalStep);
    } else {
      setFinalStepFooterExpanded(true);
      selectPrompt({ kind: FINAL_STEP_PHASES.FINAL_STEP }, { prompt: "" });
    }
  }, [
    isCLIManaged,
    isLineageReadOnly,
    finalStep,
    selectFinalStep,
    setFinalStepFooterExpanded,
    selectPrompt,
  ]);

  const handleToggleFinalStepEnabled = useCallback(() => {
    if (isCLIManaged || isLineageReadOnly || !finalStep) return;
    const enabling = finalStep.enabled === false;
    sendMessage(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, {
      finalStep: buildWorkflowStepEnabledState(finalStep, enabling),
      ...(enabling ? { clearProperties: ["enabled"] } : {}),
    });
  }, [isCLIManaged, isLineageReadOnly, finalStep]);

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
      isLineageReadOnly ||
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
  }, [canPasteStep, isCLIManaged, isLineageReadOnly, selectionTarget]);

  const finalStepIsReadOnly =
    isCLIManaged ||
    isLineageReadOnly ||
    (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepStatus === STEP_STATUS.RUNNING);
  // A running final step remains selectable so its prompt can be reviewed and
  // edited locally. The editor footer prevents updating or deleting it until
  // execution finishes; only CLI-managed / read-only lineages block editor
  // selection outright.
  const finalStepSelectionIsReadOnly = isCLIManaged || isLineageReadOnly;

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
        harnessId: h as HarnessId | undefined,
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
      harnessId: effectiveHarness as HarnessId | undefined,
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

  const sensors = useSortableDndSensors();
  // While a step is in flight (RUNNING/PAUSING/CANCELLING), the step at
  // `currentStep` is the running step: it stays pinned at pending-slice position
  // 0 and is not draggable, but the pending tail after it can still be reordered.
  // PAUSED is not in flight — a pause is confirmed at a step boundary, so
  // `currentStep` is the next PENDING step and the whole pending slice is
  // reorderable, matching `PromptQueue.hasInFlightStep`. Idle keeps today's
  // behavior (the whole pending slice is reorderable).
  const executionOwnsCurrentStep = isExecutionBusy(executionState);
  const reorderableStepCount = executionOwnsCurrentStep
    ? steps.length - currentStep - 1
    : steps.length - currentStep;
  const canReorder =
    executionState !== EXECUTION_STATES.CANCELLING && reorderableStepCount > 1;

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
      let newIdx = sortableIds.indexOf(String(over.id));
      if (oldIdx === -1 || newIdx === -1) return;

      // While execution owns the queue, keep the running step pinned at slice
      // position 0: it can't be dragged (defensive — its handle is disabled) and
      // nothing can be dropped above it. This preserves `newPendingOrder[0] === 0`,
      // which the backend also enforces.
      if (executionOwnsCurrentStep) {
        if (oldIdx === 0) return;
        if (newIdx === 0) newIdx = 1;
      }

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
    [sortableIds, executionOwnsCurrentStep]
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
          <ExitButton
            className="ml-1"
            onClick={(e) => {
              e.stopPropagation();
              onRequestClose();
            }}
            title="Close steps"
            aria-label="Close steps panel"
          />
        )}
      </div>

      {/* Step list */}
      <div
        className={`flex-1 overflow-y-auto min-h-0${isLineageReadOnly ? " pointer-events-none opacity-60 select-none" : ""}`}
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
              isLineageReadOnly ||
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
          <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
            <p className="text-xs font-medium text-foreground">
              No workflow steps yet
            </p>
            <button
              type="button"
              className="rounded bg-btn-bg px-3 py-1.5 text-xs font-medium text-btn-fg hover:bg-btn-hover"
              onClick={() => sendMessage(MESSAGE_TYPES.NEW_WORKFLOW)}
            >
              Create from Template
            </button>
            <p className="text-xxs text-description-fg">
              Or ask the built-in <code>ctrlyoke-tech-support</code> agent for
              help getting started.
            </p>
            <a
              href="https://ctrlyoke.dev/docs"
              target="_blank"
              rel="noreferrer"
              className="text-xxs text-link-fg hover:underline"
            >
              ctrlyoke.dev/docs
            </a>
          </div>
        ) : (
          <div className="relative py-1">
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
                const latestOutput = getLatestOutput(index);
                const isSelected =
                  selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                  selectionTarget.index === index;
                const isExecutionTargetLocked =
                  isExecutionBusy(executionState) && index === currentStep;
                return (
                  <div
                    key={`step-${index}-${step.name || ""}`}
                    className="relative flex items-stretch"
                    data-workflow-step-index={index}
                  >
                    {/* Keep the status accent separate from the consistently sized number column. */}
                    <div
                      className={`w-[2px] flex-shrink-0 self-stretch ${getStepAccentClass(status)}`}
                    />
                    <div className="flex-shrink-0 w-[26px] flex items-start justify-center pt-2 text-sm text-description-fg select-none">
                      {slotNumber}
                    </div>
                    <div className="flex-1 min-w-0">
                      <WorkflowStepRow
                        step={step}
                        index={index}
                        slotNumber={slotNumber}
                        currentStep={currentStep}
                        status={status}
                        retryState={retryState}
                        latestOutput={latestOutput}
                        liveContextWindow={liveContextWindow?.[index]}
                        isCurrent={false}
                        isSelected={isSelected}
                        canSetStartPosition={canChangeStartPosition}
                        startPositionDirection="rewind"
                        setPositionTarget={index}
                        isExecutionTargetLocked={isExecutionTargetLocked}
                        hideBorderBottom={
                          sliceIdx === doneStepCount - 1 &&
                          doneStepCount < steps.length
                        }
                        dimmed
                        getStepHarnessModel={getStepHarnessModel}
                        getStepOverrides={getStepOverrides}
                        onStepClick={handleStepClick}
                        onSetStartPosition={handleSetStartPosition}
                        onOpenContextMenu={openContextMenu}
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
                  const latestOutput = getLatestOutput(index);
                  const isCurrent = isRunning && isCurrentStep;
                  const isSelected =
                    selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                    selectionTarget.index === index;
                  // Target index for set-position is currentStep + visual offset,
                  // matching the post-reorder backend index for this slot.
                  const setPositionTarget = currentStep + visualIdx;
                  const slotNumber = currentStep + visualIdx + 1;
                  const isExecutionTargetLocked =
                    isExecutionBusy(executionState) && isCurrentStep;
                  return (
                    <SortableWorkflowStepWrapper
                      key={id}
                      id={id}
                      disabled={!canReorder || isExecutionTargetLocked}
                      slotNumber={slotNumber}
                      showPauseBoundaryBefore={
                        isPaused && currentStep > 0 && visualIdx === 0
                      }
                      step={step}
                      index={index}
                      currentStep={currentStep}
                      status={status}
                      retryState={retryState}
                      latestOutput={latestOutput}
                      liveContextWindow={liveContextWindow?.[index]}
                      isCurrent={isCurrent}
                      isSelected={isSelected}
                      canSetStartPosition={
                        canChangeStartPosition && !isCurrentStep
                      }
                      startPositionDirection="forward"
                      setPositionTarget={setPositionTarget}
                      isExecutionTargetLocked={isExecutionTargetLocked}
                      getStepHarnessModel={getStepHarnessModel}
                      getStepOverrides={getStepOverrides}
                      onStepClick={handleStepClick}
                      onSetStartPosition={handleSetStartPosition}
                      onOpenContextMenu={openContextMenu}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </div>

      {isPaused &&
        currentStep === steps.length &&
        finalStep &&
        finalStep.enabled !== false && (
          <div className="relative h-0 flex-shrink-0">
            <PauseBoundary />
          </div>
        )}
      <FinalStepFooter
        finalStep={finalStep}
        status={finalStepStatus}
        loopCount={finalStepLoopCount}
        phase={finalStepPhase}
        isExpanded={finalStepFooterExpanded}
        isSelected={selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP}
        isReadOnly={finalStepIsReadOnly}
        isSelectionReadOnly={finalStepSelectionIsReadOnly}
        isNarrow={isHeaderNarrow}
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
