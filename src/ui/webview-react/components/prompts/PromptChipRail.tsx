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
import React, { useCallback, useMemo } from "react";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
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
  type HarnessId,
  type StepStatus,
} from "../../types/messages";
import {
  KEYBOARD_KEYS,
  STEP_COLOR_MODES,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import {
  getStepAccentClass,
  getStepKindIconClass,
  isExecutionBusy,
  isStepExecuting,
  isWorkflowRunning,
} from "../../utils/status";
import { resolveStepColor, type StepColorGroupMember } from "@utils/stepColor";
import { resolveEffectiveContextWindow } from "@utils/tokenUtils";
import { buildStepHoverTooltip } from "@root/utils/TokenFormatting";
import type { StepHarnessModel } from "./WorkflowStepRow";
import {
  buildWorkflowStepEnabledState,
  isScriptWorkflowStep,
} from "@utils/stepClipboard";
import { getExternalReadOnlyLabel } from "@utils/externalRunner";
import {
  ExecutingStepHighlight,
  PauseBoundary,
} from "./ExecutingStepHighlight";
import {
  deriveParallelGroupStatus,
  isStepExecutionLocked,
  PARALLEL_GROUP_RUNNING_STATUS,
} from "./ParallelGroupPanel";
import { Icon } from "../shared/Icon";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

/**
 * Chip-specific override of `getStepAccentClass`: RUNNING gets a pulsing
 * accent here because the chip has no other live-execution indicator at this
 * density. Every other status (including PENDING) defers to the shared
 * fallback so it stays in lockstep with the full panel and group rails.
 */
function getChipBorderClass(status: StepStatus): string {
  return status === STEP_STATUS.RUNNING
    ? "bg-status-idle animate-pulse-custom"
    : getStepAccentClass(status);
}

export type ChipSegment =
  | { kind: "step"; index: number }
  | { kind: "group"; group: ParallelGroupDefinition; indices: number[] };

/**
 * Walks every step 0..stepCount in order, folding each parallel group's
 * members into one "group" segment (in `group.startIndex` order, same as the
 * step list itself) and leaving every other step as its own "step" segment.
 *
 * Deliberately independent of `currentStep`/done-vs-pending: a group whose
 * anchor already settled but whose tail is still pending (the same
 * straddling case `WorkflowStepsPanel.straddlingParallelGroup` names) still
 * has to render as a single bordered group here, and every member chip
 * already derives its own status/props from its absolute index — so there is
 * nothing a done/pending split would add.
 */
export function buildChipSegments(
  stepCount: number,
  parallelGroups: readonly ParallelGroupDefinition[]
): ChipSegment[] {
  const groupsByStart = new Map(
    parallelGroups.map((group) => [group.startIndex, group])
  );
  const groupedIndices = new Set(
    parallelGroups.flatMap((group) =>
      Array.from(
        { length: group.endIndex - group.startIndex + 1 },
        (_, offset) => group.startIndex + offset
      )
    )
  );
  const segments: ChipSegment[] = [];
  for (let index = 0; index < stepCount; index++) {
    const group = groupsByStart.get(index);
    if (group) {
      segments.push({
        kind: "group",
        group,
        indices: Array.from(
          { length: group.endIndex - group.startIndex + 1 },
          (_, offset) => group.startIndex + offset
        ),
      });
    } else if (!groupedIndices.has(index)) {
      segments.push({ kind: "step", index });
    }
  }
  return segments;
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
  /**
   * Suppresses this chip's own running outline. Set for every chip rendered
   * inside a parallel group wrapper — a running group draws one outline
   * around the whole group instead of one per member, matching
   * `hideExecutingHighlight` on `WorkflowStepRowFrame`/`ParallelGroupPanel`.
   */
  hideExecutingHighlight?: boolean;
  showPauseBoundaryBefore: boolean;
  isScript: boolean;
  stepColor?: string;
  tooltip: string;
  onChipClick: () => void;
  onOpenContextMenu: (x: number, y: number) => void;
};

function ChipContent({
  stepIndex,
  slotNumber,
  status,
  contextPct,
  isExecuting,
  hideExecutingHighlight = false,
  showPauseBoundaryBefore,
  isScript,
  stepColor,
  tooltip,
  onChipClick,
  onOpenContextMenu,
}: ChipProps) {
  const longPressHandlers = useLongPress(onOpenContextMenu);
  return (
    <button
      type="button"
      data-workflow-chip-index={stepIndex}
      className="relative flex w-full appearance-none flex-col border-0 border-b border-panel-border bg-transparent px-1 py-1 text-left font-inherit text-inherit transition-colors hover:bg-toolbar-hover-bg"
      onClick={onChipClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e.clientX, e.clientY);
      }}
      {...longPressHandlers}
      title={tooltip}
      aria-label={`${isScript ? "Script" : "Prompt"} ${slotNumber}`}
    >
      {showPauseBoundaryBefore && <PauseBoundary />}
      {isExecuting && !hideExecutingHighlight && (
        <ExecutingStepHighlight
          borderClassName="border"
          testId="executing-chip-highlight"
        />
      )}
      {/* Left identity bar; status is carried by the icon below. */}
      <div
        data-chip-identity-bar
        className={`absolute left-0 top-0 bottom-0 w-[2px] ${stepColor ? "" : getChipBorderClass(status)}`}
        style={stepColor ? { backgroundColor: stepColor } : undefined}
      />
      {/* One centered row per piece of info, so nothing ever has to share
          horizontal space and crowd something else out:
          number, status icon, type icon. Numbers >= 1000 shrink to fit and
          get a tooltip with the full value instead of continuing to grow.
          Context % is conveyed by the right-edge fill bar below, not text. */}
      <div className="flex w-full flex-col items-center gap-y-0.5 overflow-hidden">
        <span
          className={`truncate font-semibold text-description-fg leading-none select-none ${
            slotNumber >= 1000 ? "text-xxs" : "text-sm"
          }`}
          title={slotNumber >= 1000 ? String(slotNumber) : undefined}
        >
          {slotNumber}
        </span>
        <StatusIcon status={status} />
        <Icon
          name={getStepKindIconClass(
            isScript ? STEP_TYPES.SCRIPT : STEP_TYPES.PROMPT
          )}
          className="text-xs text-description-fg"
        />
      </div>

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
    </button>
  );
}

// ─── FinalStepChip ────────────────────────────────────────────────────────────

type FinalStepChipProps = {
  status: StepStatus;
  stepColor?: string;
  hasFinalStep: boolean;
  isDisabled: boolean;
  showPauseBoundaryBefore: boolean;
  onChipClick: () => void;
  onOpenContextMenu: (x: number, y: number) => void;
};

function FinalStepChip({
  status,
  stepColor,
  hasFinalStep,
  isDisabled,
  showPauseBoundaryBefore,
  onChipClick,
  onOpenContextMenu,
}: FinalStepChipProps) {
  const borderBarClass = stepColor ? "" : getChipBorderClass(status);
  const longPressHandlers = useLongPress(onOpenContextMenu);
  return (
    <button
      type="button"
      className="relative flex h-10 appearance-none flex-col items-center justify-center overflow-hidden border-0 border-t-2 border-panel-border bg-transparent px-1 text-inherit transition-colors hover:bg-toolbar-hover-bg"
      onClick={onChipClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e.clientX, e.clientY);
      }}
      {...longPressHandlers}
      title="Final Step — right-click for options"
      aria-label="Final step"
    >
      {showPauseBoundaryBefore && <PauseBoundary />}
      {/* Left status border bar */}
      <div
        data-final-step-identity-bar
        className={`absolute left-0 top-0 bottom-0 w-[2px] ${borderBarClass}`}
        style={stepColor ? { backgroundColor: stepColor } : undefined}
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
    </button>
  );
}

// ─── PromptChipRail ───────────────────────────────────────────────────────────

interface PromptChipRailProps {
  /** Called when the user taps the header to expand to the full panel view. */
  onExpand: () => void;
  /** Shared effective harness resolution used by the expanded step surfaces. */
  getStepHarnessModel?: (
    step: WorkflowStep,
    status: StepStatus
  ) => StepHarnessModel;
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
export const PromptChipRail: React.FC<PromptChipRailProps> = ({
  onExpand,
  getStepHarnessModel,
}) => {
  const {
    steps: prompts,
    parallelGroups,
    currentStep,
    activeStepIndices,
    executionState,
    finalStep,
    finalStepStatus,
    finalStepPhase,
    liveContextWindow,
  } = useWorkflowStore();
  const { setFinalStepFooterExpanded } = useUiStore();
  const { selectFinalStep, selectPrompt, deselect } = useEditorStore();
  const { globalSettings, workflowProperties } = useSettingsStore();
  const hideCost = useSettingsStore(
    (state) => state.fullGlobalSettings?.settings.ui.hideCost === true
  );

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

  const { openContextMenu, contextMenuPortal, setPositionModal, deleteModal } =
    useStepContextMenu({
      isExternallyManaged,
      externalReadOnlyLabel,
      canChangeStartPosition,
      canPasteStep,
      executionState,
      confirmResetOperations: globalSettings.confirmResetOperations,
      confirmDeleteOperations: globalSettings.confirmDeleteOperations,
      totalSteps: prompts.length,
      currentStep,
      parallelGroups,
      pendingGroups: parallelGroups
        .filter((group) => group.startIndex >= currentStep)
        .map((group) => ({
          id: group.id,
          start: group.startIndex - currentStep,
          end: group.endIndex - currentStep,
          failFast: group.failFast,
        })),
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

  const getChipHarnessId = (
    step: WorkflowStep,
    status: StepStatus
  ): HarnessId | undefined => {
    if (isScriptStep(step)) return undefined;
    if (getStepHarnessModel) return getStepHarnessModel(step, status).harnessId;
    return (
      (step._runtime?.harness as HarnessId | undefined) ??
      (step.harness as HarnessId | undefined) ??
      (workflowProperties.harness as HarnessId | undefined) ??
      globalSettings.harness
    );
  };

  const getChipStepColor = (
    step: WorkflowStep,
    index: number,
    status: StepStatus
  ): string | undefined => {
    const group = parallelGroups.find(
      (candidate) =>
        index >= candidate.startIndex && index <= candidate.endIndex
    );
    const offsetInGroup = group ? index - group.startIndex : undefined;
    const groupMembers: StepColorGroupMember[] | undefined = group
      ? globalSettings.stepColorMode === STEP_COLOR_MODES.HARNESS
        ? prompts
            .slice(group.startIndex, group.endIndex + 1)
            .map((memberStep, offset) => ({
              step: memberStep,
              harnessId: getChipHarnessId(
                memberStep,
                getPromptStatus(memberStep, group.startIndex + offset)
              ),
              offsetInGroup: offset,
            }))
        : undefined
      : undefined;

    return resolveStepColor({
      step,
      harnessId: getChipHarnessId(step, status),
      stepIndex: index,
      stepColorMode: globalSettings.stepColorMode,
      settings: globalSettings.harnessColors,
      group,
      offsetInGroup,
      groupMembers,
    });
  };

  // Full hover tooltip for a chip: same primary-action + context/token detail
  // lines as the expanded WorkflowStep row, single-sourced via
  // buildStepHoverTooltip/resolveEffectiveContextWindow so the two surfaces
  // never drift out of sync.
  const buildChipTooltip = (
    step: WorkflowStep,
    index: number,
    status: StepStatus,
    isCurrentChip: boolean
  ): string => {
    const latestOutput = getLatestOutput(index);
    const runtimeMeta = !isScriptWorkflowStep(step) ? step._runtime : undefined;
    const ctx = resolveEffectiveContextWindow({
      isCurrent: isCurrentChip,
      liveContextWindow: liveContextWindow?.[index],
      latestOutputTokens: latestOutput?.tokens,
      runtimeContextWindow: runtimeMeta,
    });
    return buildStepHoverTooltip({
      primaryAction: `${isScriptStep(step) ? "Script" : "Prompt"} ${index + 1} — click to edit, right-click for options`,
      contextWindow: ctx,
      harness: getChipHarnessId(step, status),
      attemptTokens: latestOutput?.tokens,
      hideCost,
    });
  };

  const chipSegments = useMemo(
    () => buildChipSegments(prompts.length, parallelGroups),
    [prompts.length, parallelGroups]
  );

  // Single per-chip renderer shared by standalone chips and parallel-group
  // members — every prop below is already a pure function of the step's
  // absolute index vs. `currentStep`, so folding the once-separate done/
  // pending loops into one pass over `chipSegments` changes nothing about
  // what renders (a done index never equals `currentStep`, so the
  // pending-only conditionals below just evaluate to their old defaults).
  const renderPromptChip = (index: number, hideExecutingHighlight = false) => {
    const prompt = prompts[index];
    const status = getPromptStatus(prompt, index);
    const contextPct = getContextPct(index);
    const isCurrentStep = index === currentStep;
    // Not `isCurrentStep`: every live member of a parallel group is
    // executing, and only the anchor sits at `currentStep`.
    const isExecuting = isStepExecuting(
      executionState,
      index,
      currentStep,
      activeStepIndices
    );
    // Only an in-flight step is locked; PAUSED stops at a step boundary, so
    // the current chip is the next PENDING step.
    const isExecutionTargetLocked =
      isStepExecutionLocked(prompt, index, currentStep, executionState) ||
      (isExecutionBusy(executionState) && isCurrentStep);
    return (
      <ChipContent
        key={index}
        stepIndex={index}
        slotNumber={index + 1}
        status={status}
        contextPct={contextPct}
        stepColor={getChipStepColor(prompt, index, status)}
        isExecuting={isExecuting}
        hideExecutingHighlight={hideExecutingHighlight}
        showPauseBoundaryBefore={
          isPaused && currentStep > 0 && index === currentStep
        }
        isScript={isScriptStep(prompt)}
        tooltip={buildChipTooltip(prompt, index, status, isExecuting)}
        onChipClick={() => handleStepClick(index)}
        onOpenContextMenu={(x, y) =>
          openContextMenu(x, y, {
            step: prompt,
            setPositionTarget: index,
            deleteIndex: index,
            isCurrentStep,
            isExecutionTargetLocked,
            direction: index < currentStep ? "rewind" : "forward",
            outputText: getLatestOutput(index)?.response as
              string | undefined,
            latestOutput: getLatestOutput(index),
            runtimeMeta: !isScriptWorkflowStep(prompt)
              ? prompt._runtime
              : undefined,
            liveContextWindow: liveContextWindow?.[index],
          })
        }
      />
    );
  };

  // A parallel group's chips get one thin bordered wrapper with a
  // worktree-compact header, in place of the individual indication a
  // standalone chip's identity bar already gives — mirroring
  // `ParallelGroupPanel`'s treatment in the full panel. Its running
  // highlight surrounds the whole wrapper instead of any one member (each
  // member chip is rendered with `hideExecutingHighlight`), via the same
  // `deriveParallelGroupStatus`/`PARALLEL_GROUP_RUNNING_STATUS` single
  // source `ParallelGroupPanel` uses.
  const renderParallelGroupChips = (
    group: ParallelGroupDefinition,
    indices: number[]
  ) => {
    const groupStatus = deriveParallelGroupStatus(
      indices.map((index) => {
        const step = prompts[index];
        return {
          status: getPromptStatus(step, index),
          enabled: step.enabled !== false,
        };
      })
    );
    return (
      <div
        key={`group-${group.id}`}
        className="relative mx-0.5 my-0.5 overflow-hidden rounded-sm border border-panel-border"
        data-testid={`chip-parallel-group-${group.id}`}
      >
        {groupStatus === PARALLEL_GROUP_RUNNING_STATUS && (
          <ExecutingStepHighlight testId="parallel-group-chip-executing-highlight" />
        )}
        <div
          className="flex items-center justify-center border-b border-panel-border py-0.5"
          title={`Parallel steps ${group.startIndex + 1}–${group.endIndex + 1}`}
        >
          <Icon
            name="worktree-compact"
            className="text-xxs text-description-fg"
          />
        </div>
        {indices.map((index) => renderPromptChip(index, true))}
      </div>
    );
  };

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
  const finalStepColor = finalStep
    ? resolveStepColor({
        step: finalStep,
        harnessId: getChipHarnessId(finalStep, finalStepEffectiveStatus),
        stepIndex: prompts.length,
        stepColorMode: globalSettings.stepColorMode,
        settings: globalSettings.harnessColors,
      })
    : undefined;

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
    string | undefined;

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
      <button
        type="button"
        className="flex flex-shrink-0 appearance-none flex-col items-center justify-center border-0 border-b border-panel-border bg-transparent p-0 py-1.5 transition-colors hover:bg-toolbar-hover-bg"
        onClick={onExpand}
        aria-label="Expand prompts"
        title="Expand prompts"
      >
        <Icon name="chevron-right" className="text-xs text-description-fg" />
        <Icon
          name="list-ordered"
          className="text-xs text-description-fg mt-1"
        />
      </button>

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
            <Icon name="dash" className="text-xxs text-description-fg" />
          </div>
        ) : (
          <div className="relative">
            {/* One chip per standalone step; parallel-group members render
                inside their group's bordered wrapper instead. Segments cover
                the full step list in order, so this single pass replaces
                what used to be a done-slice loop and a pending-slice loop. */}
            {chipSegments.map((segment) =>
              segment.kind === "group"
                ? renderParallelGroupChips(segment.group, segment.indices)
                : renderPromptChip(segment.index)
            )}
          </div>
        )}
      </div>

      {/* Final step chip — pinned at bottom, always visible */}
      <FinalStepChip
        status={finalStepEffectiveStatus}
        stepColor={finalStepColor}
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
      {deleteModal}
      {pasteToEndMenuPortal}
      {finalStepContextMenuPortal}
    </div>
  );
};
