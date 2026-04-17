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
import React, { useState, useEffect, useCallback } from "react";
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
} from "@hooks/index";
import { StatusIcon } from "./StatusIcon";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  RUNNER_IDS,
  type StepStatus,
} from "../../types/messages";
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

// ─── ChipContent ─────────────────────────────────────────────────────────────

type ChipProps = {
  /** 1-based display slot (visual position, not absolute index) */
  slotNumber: number;
  status: ReturnType<ReturnType<typeof usePromptStatus>>;
  contextPct: number | undefined;
  canReorder: boolean;
  onChipClick: () => void;
  onOpenContextMenu: (x: number, y: number) => void;
};

function ChipContent({
  slotNumber,
  status,
  contextPct,
  canReorder,
  onChipClick,
  onOpenContextMenu,
}: ChipProps) {
  return (
    <div
      className={`relative flex flex-col px-1 py-1 border-b border-panel-border hover:bg-toolbar-hover-bg transition-colors${canReorder ? " cursor-grab active:cursor-grabbing" : " cursor-pointer"}`}
      role="button"
      tabIndex={0}
      onClick={onChipClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChipClick();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e.clientX, e.clientY);
      }}
      title={`Prompt ${slotNumber} — right-click for options`}
    >
      {/* Row 1: slot number + status icon */}
      <div className="flex items-center justify-between w-full">
        <span className="text-[10px] text-description-fg leading-none select-none">
          {slotNumber}
        </span>
        <StatusIcon status={status} className="text-[16px]" />
      </div>

      {/* Row 2: context % on its own row */}
      {contextPct !== undefined && (
        <div className="flex items-center justify-end w-full mt-0.5">
          <span className="text-[9px] text-description-fg leading-none">
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
  onChipClick: () => void;
  onOpenContextMenu: (x: number, y: number) => void;
};

function FinalStepChip({
  status,
  hasFinalStep,
  onChipClick,
  onOpenContextMenu,
}: FinalStepChipProps) {
  return (
    <div
      className="flex flex-col px-1 py-1 border-t-2 border-panel-border hover:bg-toolbar-hover-bg transition-colors cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={onChipClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChipClick();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e.clientX, e.clientY);
      }}
      title="Final Step — right-click for options"
    >
      {/* Row 1: "F" label + status icon */}
      <div className="flex items-center justify-between w-full">
        <span
          className={`text-[10px] leading-none select-none font-semibold ${hasFinalStep ? "text-terminal-ansiGreen" : "text-description-fg"}`}
        >
          F
        </span>
        <StatusIcon
          status={status}
          disabled={!hasFinalStep}
          className="text-[16px]"
        />
      </div>
    </div>
  );
}

// ─── SortableChip ─────────────────────────────────────────────────────────────

function SortableChip({
  id,
  disabled,
  ...chipProps
}: ChipProps & { id: string; disabled: boolean }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style = {
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ChipContent {...chipProps} />
    </div>
  );
}

// ─── PromptChipRail ───────────────────────────────────────────────────────────

interface PromptChipRailProps {
  /** Called when the user taps the header to expand to the full panel view. */
  onExpand: () => void;
}

/**
 * Compact sortable chip list. Width is owned by the parent container.
 *
 * The header is a single clickable row that triggers `onExpand`. Pending
 * prompts support drag-to-reorder (same logic as WorkflowStepsPanel).
 * Right-clicking a chip opens a single shared context menu with
 * position-management options. A final step chip is rendered at the bottom.
 */
export const PromptChipRail: React.FC<PromptChipRailProps> = ({ onExpand }) => {
  const {
    steps: prompts,
    currentStep,
    executionState,
    finalStep,
    finalStepStatus,
    finalStepPhase,
  } = useWorkflowStore();
  const { loadedWorkflows, activeWorkflowId, setFinalStepFooterExpanded } =
    useUiStore();
  const { selectFinalStep, selectPrompt } = useEditorStore();
  const { globalSettings } = useSettingsStore();

  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;

  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;
  const canReorder = canChangeStartPosition && prompts.length - currentStep > 1;

  const getPromptStatus = usePromptStatus();
  const getContextPct = useContextPct();
  const handleStepClick = useStepClickHandler();

  const { openContextMenu, contextMenuPortal, setPositionModal } =
    useStepContextMenu({
      isCLIManaged,
      canChangeStartPosition,
      confirmResetOperations: globalSettings.confirmResetOperations,
      totalSteps: prompts.length,
      currentStep,
    });

  // Final step derived state
  const hasFinalStep = !!finalStep;
  const finalStepIsReadOnly =
    isCLIManaged ||
    (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepStatus === STEP_STATUS.RUNNING);
  const finalStepEffectiveStatus: StepStatus = hasFinalStep
    ? (finalStepStatus ?? STEP_STATUS.PENDING)
    : STEP_STATUS.PENDING;

  const handleFinalStepClick = useCallback(() => {
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

  const { openFinalStepContextMenu, finalStepContextMenuPortal } =
    useFinalStepContextMenu({
      hasFinalStep: !!finalStep,
      isReadOnly: finalStepIsReadOnly,
      onDisable: handleDisableFinalStep,
    });

  const [sortableIds, setSortableIds] = useState<string[]>(() =>
    prompts.slice(currentStep).map((_, i) => `chip-pending-${currentStep + i}`)
  );

  useEffect(() => {
    setSortableIds(
      prompts
        .slice(currentStep)
        .map((_, i) => `chip-pending-${currentStep + i}`)
    );
  }, [prompts, currentStep]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIdx = sortableIds.indexOf(String(active.id));
      const newIdx = sortableIds.indexOf(String(over.id));
      if (oldIdx === -1 || newIdx === -1) return;

      const newSortableIds = arrayMove(sortableIds, oldIdx, newIdx);
      setSortableIds(newSortableIds);

      const newPendingOrder = newSortableIds.map((id) =>
        sortableIds.indexOf(id)
      );
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, { newPendingOrder });

      const editorStore = useEditorStore.getState();
      if (editorStore.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        editorStore.cancelEdit();
      }
    },
    [sortableIds]
  );

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
          if (e.key === "Enter" || e.key === " ") onExpand();
        }}
      >
        <i className="codicon codicon-chevron-right text-[12px] text-description-fg" />
        <i className="codicon codicon-list-unordered text-[12px] text-description-fg mt-1" />
      </div>

      {/* Prompt chips — scrollable, scrollbars hidden */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 scrollbar-hide">
        {prompts.length === 0 ? (
          <div className="flex items-center justify-center py-2">
            <i className="codicon codicon-dash text-[10px] text-description-fg" />
          </div>
        ) : (
          <>
            {/* Done chips — static */}
            {prompts.slice(0, currentStep).map((prompt, i) => {
              const status = getPromptStatus(prompt, i);
              const contextPct = getContextPct(i);
              return (
                <ChipContent
                  key={i}
                  slotNumber={i + 1}
                  status={status}
                  contextPct={contextPct}
                  canReorder={false}
                  onChipClick={() => handleStepClick(i)}
                  onOpenContextMenu={(x, y) =>
                    openContextMenu(x, y, {
                      setPositionTarget: i,
                      deleteIndex: i,
                      isCurrentStep: false,
                      direction: "rewind",
                      status,
                    })
                  }
                />
              );
            })}

            {/* Pending chips — sortable */}
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
                  const index = parseInt(id.replace("chip-pending-", ""));
                  const prompt = prompts[index];
                  if (!prompt) return null;
                  const isCurrentStep = visualIdx === 0;
                  const status = getPromptStatus(prompt, index);
                  const contextPct = getContextPct(index);
                  const slotNumber = currentStep + visualIdx + 1;
                  return (
                    <SortableChip
                      key={id}
                      id={id}
                      disabled={!canReorder}
                      slotNumber={slotNumber}
                      status={status}
                      contextPct={contextPct}
                      canReorder={canReorder && !isCurrentStep}
                      onChipClick={() => handleStepClick(index)}
                      onOpenContextMenu={(x, y) =>
                        openContextMenu(x, y, {
                          setPositionTarget: currentStep + visualIdx,
                          deleteIndex: index,
                          isCurrentStep,
                          direction: "forward",
                          status,
                        })
                      }
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </>
        )}
      </div>

      {/* Final step chip — pinned at bottom, always visible */}
      <FinalStepChip
        status={finalStepEffectiveStatus}
        hasFinalStep={hasFinalStep}
        onChipClick={handleFinalStepClick}
        onOpenContextMenu={openFinalStepContextMenu}
      />

      {contextMenuPortal}
      {setPositionModal}
      {finalStepContextMenuPortal}
    </div>
  );
};
