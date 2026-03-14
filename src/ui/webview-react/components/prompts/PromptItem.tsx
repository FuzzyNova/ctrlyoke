import React, { useState } from "react";
import type { DraggableAttributes } from "@dnd-kit/core";
type SyntheticListenerMap = Record<string, Function>;
import { StatusIcon } from "./StatusIcon";
import { PromptItemDetails } from "./PromptItemDetails";
import type { PromptOverride } from "./PromptItemDetails";
export type { PromptOverride };
import type { StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { buildUndoCandidatesForOutputs, buildUndoDialogInputForPrompt, getPromptUndoSummary } from "../../utils/promptUndo";
import type { UndoDialogInput } from "../../utils/promptUndo";
import type { UndoExecutionTarget, WorkspaceSnapshot, UndoRecord } from "@root/types/OutputHistoryTypes";
import type { UndoFileInstruction } from "../../types/messages";
import { UndoChangesDialog } from "../output/UndoChangesDialog";
import { STEP_STATUS } from "../../types/messages";

export interface EndConditionResult {
  passed: boolean;
  message?: string;
}

export interface PromptDetails {
  duration?: number;
  endConditionResult?: EndConditionResult;
  message?: string;
}

interface PromptItemProps {
  /** Prompt text content */
  text: string;
  /** Prompt index (0-based) */
  index: number;
  /** Current status */
  status: StepStatus;
  /** Optional human-readable display name */
  name?: string;
  /** Retry state if retrying */
  retryState?: RetryState;
  /** Additional details (duration, end condition result) */
  details?: PromptDetails;
  /** Latest CLI output for this prompt */
  latestOutput?: CliOutput | null;
  /** Whether this is the currently running prompt */
  isCurrent?: boolean;
  /** Whether this prompt is selected for editing */
  isSelected?: boolean;
  /** Click handler for selection */
  onClick?: () => void;
  /** Harness display name (e.g. "Claude CLI") */
  harnessLabel?: string;
  /** True when harness is inherited (not set at prompt level) */
  harnessIsDefault?: boolean;
  /** Model display name (e.g. "sonnet") */
  modelLabel?: string;
  /** True when model is inherited (not set at prompt level) */
  modelIsDefault?: boolean;
  /** Prompt-level property overrides to display as compact chips */
  overrides?: PromptOverride[];
  /** Whether this prompt can be used to set the start position */
  canSetStartPosition?: boolean;
  /** Callback when set start position is clicked */
  onSetStartPosition?: () => void;
  /** Direction of position change (rewind = go backward, forward = skip ahead) */
  startPositionDirection?: "rewind" | "forward";
  /**
   * Visual 1-based position for tooltips (e.g. "Set step 3 as start position").
   * Separate from `index` because after drag-reorder the visual slot differs
   * from the original absolute index. Defaults to `index + 1` when omitted.
   */
  displayNumber?: number;
  /** When true, suppresses the bottom border (e.g. when a BoundaryBar follows) */
  hideBorderBottom?: boolean;
  /**
   * When true, applies completed-section styling: slight dim + green left
   * accent to visually distinguish locked/done prompts from pending ones.
   */
  dimmed?: boolean;
  /** Drag handle props from dnd-kit sortable */
  dragHandleProps?: {
    listeners: SyntheticListenerMap | undefined;
    attributes: DraggableAttributes;
  };
  /** When true, show prompt-level undo button for completed prompts */
  allowUndoActions?: boolean;
  /** Override: CLI outputs from history (used in history view instead of live store) */
  allCliOutputs?: CliOutput[];
  /** Override: workspace snapshot from history (used in history view instead of live store) */
  workspaceSnapshot?: WorkspaceSnapshot;
  /** Override: undo record from history (used in history view instead of live store) */
  undoRecord?: UndoRecord;
}

// Stable empty array used as a fallback in useWorkflowStore selectors.
// Never use `?? []` inline in a selector — a new array literal is a new
// reference on every call, which fools useSyncExternalStore into thinking
// the snapshot changed and triggers unnecessary (or crashing) re-renders.
const EMPTY_CLI_OUTPUTS: CliOutput[] = [];

/**
 * Truncate text to a maximum length with ellipsis
 */
const truncate = (text: string, maxLength: number = 60): string => {
  if (!text) return "";
  // Normalize whitespace to single spaces
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.substring(0, maxLength) + "...";
};

/**
 * PromptItem - Individual prompt in the prompts list
 *
 * Features:
 * - Status icon (pending/running/completed/failed)
 * - Prompt text (truncated)
 * - Retry indicator when retrying
 * - End condition result display
 * - Duration if available
 * - Visual indication for current/selected state
 */
export const PromptItem: React.FC<PromptItemProps> = ({
  text,
  index,
  status,
  name,
  retryState,
  details,
  latestOutput,
  isCurrent = false,
  isSelected = false,
  onClick,
  harnessLabel,
  harnessIsDefault,
  modelLabel,
  modelIsDefault,
  overrides,
  canSetStartPosition,
  onSetStartPosition,
  startPositionDirection,
  displayNumber,
  hideBorderBottom = false,
  dimmed = false,
  dragHandleProps,
  allowUndoActions = false,
  allCliOutputs: allCliOutputsProp,
  workspaceSnapshot: workspaceSnapshotProp,
  undoRecord: undoRecordProp,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  interface DialogState {
    mode: "undo" | "redo";
    input?: UndoDialogInput;
    redoInstructions?: UndoFileInstruction[];
    requestId: string;
  }
  const [dialogState, setDialogState] = useState<DialogState | null>(null);

  const workspaceSnapshots = useWorkflowStore((s) => s.workspaceSnapshots);
  const undoRecords = useWorkflowStore((s) => s.undoRecords);
  // Use a stable empty-array constant as fallback — `?? []` would create a new
  // array reference on every snapshot call, causing useSyncExternalStore to
  // always detect a "change" and call forceStoreRerender (React error #185).
  const stepCliOutputsFromStore = useWorkflowStore((s) => s.cliOutputs[index] ?? EMPTY_CLI_OUTPUTS);

  // In history view, caller passes allCliOutputsProp / workspaceSnapshotProp / undoRecordProp
  // from historyOutputs — use those in preference to the live store values.
  const stepCliOutputs = allCliOutputsProp ?? stepCliOutputsFromStore;

  const executionTarget: UndoExecutionTarget = { kind: "queue", stepIndex: index };
  const workspacePath = stepCliOutputs[stepCliOutputs.length - 1]?.workingDirectory ?? "";
  const targetKey = `queue-${index}`;
  const undoRecord = undoRecordProp ?? undoRecords[targetKey];
  const effectiveSnapshot = workspaceSnapshotProp ?? workspaceSnapshots[index];
  const isRedone = undoRecord?.isRedone === true;
  const hasUndoRecord = undoRecord != null;
  const showRedoButton = hasUndoRecord && !isRedone;

  // Build undo/redo action for completed prompts when allowUndoActions is enabled
  const undoAction = (() => {
    if (!allowUndoActions || status !== STEP_STATUS.COMPLETED) return undefined;

    if (showRedoButton && (undoRecord?.redoInstructions?.length ?? 0) > 0) {
      const count = undoRecord!.redoInstructions.length;
      return {
        label: `Redo ${count} change${count !== 1 ? "s" : ""}`,
        hasTier2: false,
        isRedo: true,
        onUndo: () => {
          setDialogState({
            mode: "redo",
            redoInstructions: undoRecord!.redoInstructions,
            requestId: crypto.randomUUID(),
          });
        },
      };
    }

    const candidates = buildUndoCandidatesForOutputs(stepCliOutputs, effectiveSnapshot);
    const { undoableCount, hasTier2 } = getPromptUndoSummary(candidates);
    if (undoableCount === 0) return undefined;
    return {
      label: `Undo ${undoableCount} change${undoableCount !== 1 ? "s" : ""}`,
      hasTier2,
      isRedo: false,
      onUndo: () => {
        const input = buildUndoDialogInputForPrompt(executionTarget, stepCliOutputs, effectiveSnapshot, workspacePath);
        setDialogState({
          mode: "undo",
          input,
          requestId: crypto.randomUUID(),
        });
      },
    };
  })();

  // Build class names for the container
  const containerClasses = [
    "py-2 px-3",
    "cursor-pointer",
    "group",
    hideBorderBottom ? "" : "border-b border-panel-border",
    "transition-colors",
    dimmed ? "opacity-80" : "",
  ];

  // Add hover and selection states
  if (isSelected) {
    containerClasses.push("bg-list-active-bg", "text-list-active-fg");
  } else if (isCurrent) {
    containerClasses.push("bg-list-inactive-bg");
  } else {
    containerClasses.push("hover:bg-list-hover-bg");
  }

  return (
    <div
      className={containerClasses.join(" ")}
      data-prompt-index={index}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title="Click to edit"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {/* Header: Icon + Index + Text */}
      <div className="flex items-start gap-2">
        {dragHandleProps && (
          <span
            className="flex-shrink-0 cursor-grab active:cursor-grabbing text-description-fg hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            {...dragHandleProps.listeners}
            {...dragHandleProps.attributes}
            aria-label="Drag to reorder"
          >
            <i className="codicon codicon-grabber text-[12px]" />
          </span>
        )}
        {canSetStartPosition && isHovered ? (
          <button
            className="flex-shrink-0 mt-0.5 w-4 flex items-center justify-center text-description-fg hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onSetStartPosition?.();
            }}
            title={`Set step ${displayNumber ?? index + 1} as start position`}
          >
            <i
              className={`codicon ${startPositionDirection === "rewind" ? "codicon-debug-reverse-continue" : "codicon-debug-step-over"} text-[12px]`}
            />
          </button>
        ) : (
          <span className="flex-shrink-0 mt-0.5">
            <StatusIcon status={status} />
          </span>
        )}
        <span
          className={`flex-1 min-w-0 text-xs leading-relaxed ${isSelected ? "text-list-active-fg" : "text-foreground"}`}
        >
          {name ? name : truncate(text, 60)}
        </span>
      </div>

      <PromptItemDetails
        status={status}
        harnessLabel={harnessLabel}
        harnessIsDefault={harnessIsDefault}
        modelLabel={modelLabel}
        modelIsDefault={modelIsDefault}
        retryState={retryState}
        latestOutput={latestOutput}
        details={details}
        isSelected={isSelected}
        overrides={overrides}
        undoAction={undoAction}
      />

      {dialogState && (
        <UndoChangesDialog
          mode={dialogState.mode}
          target={executionTarget}
          workspacePath={workspacePath}
          input={dialogState.input}
          redoInstructions={dialogState.redoInstructions}
          requestId={dialogState.requestId}
          onClose={() => setDialogState(null)}
        />
      )}
    </div>
  );
};
