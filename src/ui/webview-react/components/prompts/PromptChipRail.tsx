/**
 * PromptChipRail — compact chip list for collapsed/narrow prompt navigation.
 *
 * Renders one chip per prompt showing its slot number + status icon. Used in:
 *  - Desktop: the collapsed WorkflowStepsPanel (32px wide Panel bar)
 *  - Mobile: the 32px sidebar that pushes the output panel right
 *
 * Width is determined by the parent container. Internal layout adapts to the
 * available space — no fixed width is applied here.
 */
import React, { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useEditorStore } from "@store/editorStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { sendMessage } from "@hooks/useMessageHandler";
import {
  usePromptStatus,
  useContextPct,
  useStepClickHandler,
  useStepContextMenu,
  useFinalStepContextMenu,
  useLongPress,
  useLatestStepOutput,
  useFinalStepLatestOutput,
  usePasteToEndContextMenu,
  useIsViewingDeletedWorkflow,
  useIsSystemGeneratedWorkflow,
  useActiveWorkflowExternalOwner,
} from "@hooks/index";
import { StatusIcon } from "./StatusIcon";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  type StepStatus,
} from "../../types/messages";
import { KEYBOARD_KEYS, STEP_TYPES } from "@root/types/DashboardConstants";
import {
  getStepAccentClass,
  isExecutionBusy,
  isWorkflowRunning,
} from "../../utils/status";
import {
  buildWorkflowStepEnabledState,
  isScriptWorkflowStep,
} from "@utils/stepClipboard";
import { getExternalReadOnlyLabel } from "@utils/externalRunner";
import {
  ExecutingStepHighlight,
  PauseBoundary,
} from "./ExecutingStepHighlight";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isScriptStep(step: { type?: string }): boolean {
  return step.type === STEP_TYPES.SCRIPT;
}

function getChipBorderClass(status: StepStatus): string {
  switch (status) {
    case STEP_STATUS.RUNNING:
      return "bg-status-idle animate-pulse-custom";
    case STEP_STATUS.PENDING:
      return "bg-transparent";
    default:
      return getStepAccentClass(status);
  }
}

// ─── ChipContent ─────────────────────────────────────────────────────────────

type ChipProps = {
  /** Absolute workflow step index. */
  stepIndex: number;
  /** 1-based display slot (visual position, not absolute index) */
  slotNumber: number;
  status: ReturnType<ReturnType<typeof usePromptStatus>>;
  contextPct: number | undefined;
  isExecuting: boolean;
  showPauseBoundaryBefore: boolean;
  isScript: boolean;
  onChipClick: () => void;
  onOpenContextMenu: (x: number, y: number) => void;
};

function ChipContent({
  stepIndex,
  slotNumber,
  status,
  contextPct,
  isExecuting,
  showPauseBoundaryBefore,
  isScript,
  onChipClick,
  onOpenContextMenu,
}: ChipProps) {
  const borderBarClass = getChipBorderClass(status);
  const longPressHandlers = useLongPress(onOpenContextMenu);
  return (
    <div
      data-workflow-chip-index={stepIndex}
      className="relative flex flex-col px-1 py-1 border-b border-panel-border hover:bg-toolbar-hover-bg transition-colors cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={onChipClick}
      onKeyDown={(e) => {
        if (e.key === KEYBOARD_KEYS.ENTER || e.key === " ") {
          e.preventDefault();
          onChipClick();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e.clientX, e.clientY);
      }}
      {...longPressHandlers}
      title={`${isScript ? "Script" : "Prompt"} ${slotNumber} — right-click for options`}
    >
      {showPauseBoundaryBefore && <PauseBoundary orientation="vertical" />}
      {isExecuting && (
        <ExecutingStepHighlight
          borderClassName="border"
          testId="executing-chip-highlight"
        />
      )}
      {/* Left status border bar */}
      <div
        className={`absolute left-0 top-0 bottom-0 w-[2px] ${borderBarClass}`}
      />
      {/* Row 1: slot number + type icon */}
      <div className="flex items-center justify-between w-full">
        <span className="text-xxs text-description-fg leading-none select-none">
          {slotNumber}
        </span>
        <i
          className={`codicon ${isScript ? "codicon-terminal-powershell" : "codicon-comment"} text-xs text-description-fg`}
        />
      </div>

      {/* Row 2: context % on its own row */}
      {contextPct !== undefined && (
        <div className="flex items-center justify-end w-full mt-0.5">
          <span className="text-xxs text-description-fg leading-none">
            {contextPct}%
          </span>
        </div>
      )}
      {/* 2px right-edge context fill bar */}
      {contextPct !== undefined && (
        <div className="absolute right-0 top-0 bottom-0 w-[2px] overflow-hidden">
          <div
            key={contextPct}
            className={`absolute bottom-0 left-0 right-0 animate-ctx-update ${
              contextPct >= 85
                ? "bg-error-fg opacity-90"
                : contextPct >= 70
                  ? "bg-warning-fg opacity-70"
                  : "bg-description-fg opacity-50"
            }`}
            style={{ height: `${contextPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ─── FinalStepChip ────────────────────────────────────────────────────────────

type FinalStepChipProps = {
  status: StepStatus;
  hasFinalStep: boolean;
  isDisabled: boolean;
  showPauseBoundaryBefore: boolean;
  onChipClick: () => void;
  onOpenContextMenu: (x: number, y: number) => void;
};

function FinalStepChip({
  status,
  hasFinalStep,
  isDisabled,
  showPauseBoundaryBefore,
  onChipClick,
  onOpenContextMenu,
}: FinalStepChipProps) {
  const borderBarClass = getChipBorderClass(status);
  const longPressHandlers = useLongPress(onOpenContextMenu);
  return (
    <div
      className="relative flex flex-col px-1 h-10 items-center justify-center border-t-2 border-panel-border hover:bg-toolbar-hover-bg transition-colors cursor-pointer overflow-hidden"
      role="button"
      tabIndex={0}
      onClick={onChipClick}
      onKeyDown={(e) => {
        if (e.key === KEYBOARD_KEYS.ENTER || e.key === " ") {
          e.preventDefault();
          onChipClick();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e.clientX, e.clientY);
      }}
      {...longPressHandlers}
      title="Final Step — right-click for options"
    >
      {showPauseBoundaryBefore && <PauseBoundary orientation="vertical" />}
      {/* Left status border bar */}
      <div
        className={`absolute left-0 top-0 bottom-0 w-[2px] ${borderBarClass}`}
      />
      {/* Row 1: "FINAL" label */}
      <div className="flex justify-center w-full">
        <span
          className={`text-xxs leading-none select-none font-semibold ${hasFinalStep ? "text-terminal-ansiGreen" : "text-description-fg"}`}
        >
          FINAL
        </span>
      </div>
      {/* Row 2: status icon centered */}
      <div className="flex justify-center w-full mt-0.5">
        <StatusIcon
          status={status}
          disabled={!hasFinalStep || isDisabled}
          className="text-base"
        />
      </div>
    </div>
  );
}

// ─── PromptChipRail ───────────────────────────────────────────────────────────

interface PromptChipRailProps {
  /** Called when the user taps the header to expand to the full panel view. */
  onExpand: () => void;
}

/**
 * Compact chip list. Width is owned by the parent container.
 *
 * The header is a single clickable row that triggers `onExpand`. This rail is
 * "info at a glance" only — reordering requires expanding to the full
 * WorkflowStepsPanel, or the Move Up/Down context menu items below.
 * Right-clicking (or long-pressing) a chip opens a single shared context menu
 * with position-management options. A final step chip is rendered at the
 * bottom.
 */
export const PromptChipRail: React.FC<PromptChipRailProps> = ({ onExpand }) => {
  const {
    steps: prompts,
    currentStep,
    executionState,
    finalStep,
    finalStepStatus,
    finalStepPhase,
    liveContextWindow,
  } = useWorkflowStore();
  const { setFinalStepFooterExpanded } = useUiStore();
  const { selectFinalStep, selectPrompt, deselect } = useEditorStore();
  const { globalSettings } = useSettingsStore();

  const activeExternalOwner = useActiveWorkflowExternalOwner();
  const isExternallyManaged = activeExternalOwner != null;
  const externalReadOnlyLabel = getExternalReadOnlyLabel(activeExternalOwner);
  // The lineage on screen was deleted while being viewed, or is an internal
  // system lineage (e.g. commit message generation) whose properties are
  // overridden by its owning feature on the next run regardless of what's
  // edited here — either way, nothing here has anywhere meaningful to write to.
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const isLineageReadOnly =
    isViewingDeletedWorkflow || isSystemGeneratedWorkflow;

  const isRunning = isWorkflowRunning(executionState);
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;
  const canPasteStep = executionState !== EXECUTION_STATES.CANCELLING;

  const getLatestOutput = useLatestStepOutput();

  const getPromptStatus = usePromptStatus();
  const getContextPct = useContextPct();
  const handleStepClick = useStepClickHandler();

  const { openContextMenu, contextMenuPortal, setPositionModal } =
    useStepContextMenu({
      isExternallyManaged,
      externalReadOnlyLabel,
      canChangeStartPosition,
      canPasteStep,
      executionState,
      confirmResetOperations: globalSettings.confirmResetOperations,
      totalSteps: prompts.length,
      currentStep,
    });

  const { openPasteToEndMenu, pasteToEndMenuPortal } = usePasteToEndContextMenu(
    {
      isExternallyManaged,
      externalReadOnlyLabel,
      canPasteStep,
      executionState,
      totalSteps: prompts.length,
    }
  );

  const bgLongPressHandlers = useLongPress(openPasteToEndMenu, 500, true);

  // Final step derived state
  const hasFinalStep = !!finalStep;
  const finalStepIsReadOnly =
    isExternallyManaged ||
    isLineageReadOnly ||
    (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepStatus === STEP_STATUS.RUNNING);
  const finalStepEffectiveStatus: StepStatus = hasFinalStep
    ? (finalStepStatus ?? STEP_STATUS.PENDING)
    : STEP_STATUS.PENDING;

  const handleFinalStepClick = useCallback(() => {
    if (isExternallyManaged || isLineageReadOnly) return;
    if (finalStep) {
      selectFinalStep(finalStep);
    } else {
      setFinalStepFooterExpanded(true);
      selectPrompt({ kind: FINAL_STEP_PHASES.FINAL_STEP }, { prompt: "" });
    }
  }, [
    isExternallyManaged,
    isLineageReadOnly,
    finalStep,
    selectFinalStep,
    setFinalStepFooterExpanded,
    selectPrompt,
  ]);

  const handleToggleFinalStepEnabled = useCallback(() => {
    if (isExternallyManaged || isLineageReadOnly || !finalStep) return;
    const enabling = finalStep.enabled === false;
    sendMessage(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, {
      finalStep: buildWorkflowStepEnabledState(finalStep, enabling),
      ...(enabling ? { clearProperties: ["enabled"] } : {}),
    });
  }, [isExternallyManaged, isLineageReadOnly, finalStep]);

  const finalStepLatestOutput = useFinalStepLatestOutput();
  const finalStepOutputText = finalStepLatestOutput?.response as
    | string
    | undefined;

  const { openFinalStepContextMenu, finalStepContextMenuPortal } =
    useFinalStepContextMenu({
      finalStep,
      isReadOnly: finalStepIsReadOnly,
      isDisabled: finalStep?.enabled === false,
      onToggleEnabled: handleToggleFinalStepEnabled,
      outputText: finalStepOutputText,
      latestOutput: finalStepLatestOutput,
      runtimeMeta:
        finalStep && !isScriptWorkflowStep(finalStep)
          ? finalStep._runtime
          : undefined,
    });

  return (
    <div className="flex flex-col h-full">
      {/* Header: chevron + list icon stacked, expands to full panel on click */}
      <div
        className="flex flex-col items-center justify-center py-1.5 flex-shrink-0 border-b border-panel-border cursor-pointer hover:bg-toolbar-hover-bg transition-colors select-none"
        onClick={onExpand}
        role="button"
        tabIndex={0}
        aria-label="Expand prompts"
        title="Expand prompts"
        onKeyDown={(e) => {
          if (e.key === KEYBOARD_KEYS.ENTER || e.key === " ") onExpand();
        }}
      >
        <i className="codicon codicon-chevron-right text-xs text-description-fg" />
        <i className="codicon codicon-list-ordered text-xs text-description-fg mt-1" />
      </div>

      {/* Prompt chips — scrollable, scrollbars hidden */}
      <div
        className={`flex-1 overflow-y-auto overflow-x-hidden min-h-0 scrollbar-hide${isLineageReadOnly ? " pointer-events-none opacity-60 select-none" : ""}`}
        role="listbox"
        tabIndex={0}
        onClick={(e) => {
          // Deselect the current step when clicking blank space in the rail.
          // Only fire when the click target is this container itself (not a child).
          if (e.target === e.currentTarget) {
            deselect();
          }
        }}
        onContextMenu={(e) => {
          // Only open the paste menu when right-clicking blank background
          // (chip items call e.stopPropagation() so they won't bubble here).
          e.preventDefault();
          openPasteToEndMenu(e.clientX, e.clientY);
        }}
        {...bgLongPressHandlers}
        onKeyDown={(e) => {
          if (e.key === KEYBOARD_KEYS.ESCAPE) {
            deselect();
          }
        }}
      >
        {prompts.length === 0 ? (
          <div className="flex items-center justify-center py-2">
            <i className="codicon codicon-dash text-xxs text-description-fg" />
          </div>
        ) : (
          <div className="relative">
            {/* Done chips — static */}
            {prompts.slice(0, currentStep).map((prompt, i) => {
              const status = getPromptStatus(prompt, i);
              const contextPct = getContextPct(i);
              return (
                <ChipContent
                  key={i}
                  stepIndex={i}
                  slotNumber={i + 1}
                  status={status}
                  contextPct={contextPct}
                  isExecuting={false}
                  showPauseBoundaryBefore={false}
                  isScript={isScriptStep(prompt)}
                  onChipClick={() => handleStepClick(i)}
                  onOpenContextMenu={(x, y) =>
                    openContextMenu(x, y, {
                      step: prompt,
                      setPositionTarget: i,
                      deleteIndex: i,
                      isCurrentStep: false,
                      isExecutionTargetLocked: false,
                      direction: "rewind",
                      outputText: getLatestOutput(i)?.response as
                        | string
                        | undefined,
                      latestOutput: getLatestOutput(i),
                      runtimeMeta: !isScriptWorkflowStep(prompt)
                        ? prompt._runtime
                        : undefined,
                      liveContextWindow: liveContextWindow?.[i],
                    })
                  }
                />
              );
            })}

            {/* Pending chips — static; reorder via Move Up/Down in the
                context menu, or expand to the full panel to drag. */}
            {prompts.slice(currentStep).map((prompt, visualIdx) => {
              const index = currentStep + visualIdx;
              const isCurrentStep = visualIdx === 0;
              const status = getPromptStatus(prompt, index);
              const contextPct = getContextPct(index);
              const slotNumber = index + 1;
              // Only an in-flight step is locked; PAUSED stops at a step
              // boundary, so the current chip is the next PENDING step.
              const isExecutionTargetLocked =
                isExecutionBusy(executionState) && isCurrentStep;
              return (
                <ChipContent
                  key={index}
                  stepIndex={index}
                  slotNumber={slotNumber}
                  status={status}
                  contextPct={contextPct}
                  isExecuting={isRunning && isCurrentStep}
                  showPauseBoundaryBefore={
                    isPaused && currentStep > 0 && visualIdx === 0
                  }
                  isScript={isScriptStep(prompt)}
                  onChipClick={() => handleStepClick(index)}
                  onOpenContextMenu={(x, y) =>
                    openContextMenu(x, y, {
                      step: prompt,
                      setPositionTarget: index,
                      deleteIndex: index,
                      isCurrentStep,
                      isExecutionTargetLocked,
                      direction: "forward",
                      outputText: getLatestOutput(index)?.response as
                        | string
                        | undefined,
                      latestOutput: getLatestOutput(index),
                      runtimeMeta: !isScriptWorkflowStep(prompt)
                        ? prompt._runtime
                        : undefined,
                      liveContextWindow: liveContextWindow?.[index],
                    })
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Final step chip — pinned at bottom, always visible */}
      <FinalStepChip
        status={finalStepEffectiveStatus}
        hasFinalStep={hasFinalStep}
        isDisabled={finalStep?.enabled === false}
        showPauseBoundaryBefore={
          isPaused &&
          currentStep === prompts.length &&
          hasFinalStep &&
          finalStep?.enabled !== false
        }
        onChipClick={handleFinalStepClick}
        onOpenContextMenu={openFinalStepContextMenu}
      />

      {contextMenuPortal}
      {setPositionModal}
      {pasteToEndMenuPortal}
      {finalStepContextMenuPortal}
    </div>
  );
};
