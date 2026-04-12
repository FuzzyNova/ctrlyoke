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
import { sendMessage } from "@hooks/useMessageHandler";
import {
  usePromptStatus,
  useContextPct,
  useStepClickHandler,
} from "@hooks/index";
import { StatusIcon } from "./StatusIcon";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  FINAL_STEP_PHASES,
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
  canSetStart: boolean;
  startPositionDirection: "rewind" | "forward";
  canReorder: boolean;
  onChipClick: () => void;
  onSetStart: (e: React.MouseEvent) => void;
};

function ChipContent({
  slotNumber,
  status,
  contextPct,
  canSetStart,
  startPositionDirection,
  canReorder,
  onChipClick,
  onSetStart,
}: ChipProps) {
  const hasSecondRow = canSetStart || contextPct !== undefined;

  return (
    <div
      className={`flex flex-col px-1 py-1 border-b border-panel-border hover:bg-toolbar-hover-bg transition-colors${canReorder ? " cursor-grab active:cursor-grabbing" : " cursor-pointer"}`}
      role="button"
      tabIndex={0}
      onClick={onChipClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChipClick();
        }
      }}
      title={`Prompt ${slotNumber}`}
    >
      {/* Row 1: slot number + status icon */}
      <div className="flex items-center justify-between w-full">
        <span className="text-[10px] text-description-fg leading-none select-none">
          {slotNumber}
        </span>
        <StatusIcon status={status} className="text-[16px]" />
      </div>

      {/* Row 2: set-start button + context % (only when relevant) */}
      {hasSecondRow && (
        <div className="flex items-center justify-between w-full mt-0.5">
          {canSetStart ? (
            <button
              className="flex items-center justify-center w-[14px] h-[14px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
              onClick={onSetStart}
              title={`Start from prompt ${slotNumber}`}
              aria-label={`Set start position to prompt ${slotNumber}`}
            >
              <i
                className={`codicon ${startPositionDirection === "rewind" ? "codicon-debug-reverse-continue" : "codicon-debug-step-over"} text-[9px]`}
              />
            </button>
          ) : (
            <span />
          )}
          {contextPct !== undefined && (
            <span className="text-[9px] text-description-fg leading-none">
              {contextPct}%
            </span>
          )}
        </div>
      )}
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
 */
export const PromptChipRail: React.FC<PromptChipRailProps> = ({ onExpand }) => {
  const { steps: prompts, currentStep, executionState } = useWorkflowStore();

  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;
  const canReorder = canChangeStartPosition && prompts.length - currentStep > 1;

  const getPromptStatus = usePromptStatus();
  const getContextPct = useContextPct();
  const handleStepClick = useStepClickHandler();

  const [sortableIds, setSortableIds] = useState<string[]>(() =>
    prompts
      .slice(currentStep)
      .map((_, i) => `chip-pending-${currentStep + i}`)
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
      {/* Header: single clickable row, expands to full panel on click */}
      <div
        className="flex items-center justify-center h-[30px] flex-shrink-0 border-b border-panel-border bg-sidebar-bg cursor-pointer hover:bg-toolbar-hover-bg transition-colors"
        onClick={onExpand}
        role="button"
        tabIndex={0}
        aria-label="Expand prompts"
        title="Expand prompts"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onExpand();
        }}
      >
        <i className="codicon codicon-list-unordered text-[12px] text-description-fg" />
      </div>

      {/* Prompt chips — scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0">
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
                  canSetStart={canChangeStartPosition}
                  startPositionDirection="rewind"
                  canReorder={false}
                  onChipClick={() => handleStepClick(i)}
                  onSetStart={(e) => {
                    e.stopPropagation();
                    sendMessage(MESSAGE_TYPES.SET_START_POSITION, {
                      toIndex: i,
                    });
                  }}
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
                      canSetStart={canChangeStartPosition && !isCurrentStep}
                      startPositionDirection="forward"
                      canReorder={canReorder && !isCurrentStep}
                      onChipClick={() => handleStepClick(index)}
                      onSetStart={(e) => {
                        e.stopPropagation();
                        sendMessage(MESSAGE_TYPES.SET_START_POSITION, {
                          toIndex: currentStep + visualIdx,
                        });
                      }}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </>
        )}
      </div>
    </div>
  );
};
