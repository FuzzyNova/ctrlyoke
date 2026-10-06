import {
  KEYBOARD_KEYS,
  WORKTREE_POSITION_DIRECTIONS,
  type WorktreePositionDirection,
} from "@root/types/DashboardConstants";
import React from "react";
import { useLongPress } from "../../hooks/useLongPress";
import { StatusIcon } from "./StatusIcon";
import { ContextWindowBar } from "./ContextWindowBar";
import { PromptStepDetails } from "./PromptStepDetails";
import type { PromptOverride } from "./PromptStepDetails";
export type { PromptOverride };
import type { HarnessId, StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";
import {
  formatTokenCount,
  resolveTokenTotal,
  buildStepHoverTooltip,
} from "@root/utils/TokenFormatting";
import { useSettingsStore } from "@store/settingsStore";
import { resolveEffectiveContextWindow } from "@utils/tokenUtils";
import { getStepKindIconClass } from "@utils/status";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";
import { detectPlatform } from "@utils/platform";
import { UI_PLATFORMS } from "@root/types/DashboardConstants";
import {
  DRAG_HANDLE_TOUCH_ACTION_STYLE,
  type WorkflowStepDragHandleProps,
} from "@utils/dndKit";

export interface EndConditionResult {
  passed: boolean;
  message?: string;
}

export interface StepDetails {
  duration?: number;
  endConditionResult?: EndConditionResult;
  message?: string;
}

export type StepClickModifiers = { range: boolean; toggle: boolean };

function getStepClickModifiers(event: React.MouseEvent): StepClickModifiers {
  const isMac = detectPlatform() === UI_PLATFORMS.MAC;
  return {
    range: event.shiftKey,
    toggle: isMac ? event.metaKey : event.ctrlKey,
  };
}

interface WorkflowStepProps {
  /** Prompt text content */
  text: string;
  /** Prompt index (0-based) */
  index: number;
  /** Current status */
  status: StepStatus;
  /** True when the step is present but disabled from execution. */
  isDisabled?: boolean;
  /** Optional human-readable display name */
  name?: string;
  /** Retry state if retrying */
  retryState?: RetryState;
  /** Additional details (duration, end condition result) */
  details?: StepDetails;
  /** Latest CLI output for this prompt */
  latestOutput?: CliOutput | null;
  /** Whether this is the currently running prompt */
  isCurrent?: boolean;
  /** Whether this prompt is selected for editing */
  isSelected?: boolean;
  /** Click handler for selection */
  onClick?: (modifiers: StepClickModifiers) => void;
  /** Harness ID for the icon shown before the harness label */
  harnessId?: HarnessId;
  /** Harness display name (e.g. "Claude Code") */
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
  startPositionDirection?: WorktreePositionDirection;
  /**
   * Visual 1-based position for tooltips (e.g. "Set step 3 as start position").
   * Separate from `index` because after drag-reorder the visual slot differs
   * from the original absolute index. Defaults to `index + 1` when omitted.
   */
  displayNumber?: number;
  /** When true, suppresses the bottom border*/
  hideBorderBottom?: boolean;
  /** When true, renders the script step variant (terminal icon, Script badge, command text) */
  isScript?: boolean;
  /**
   * When true, applies completed-section styling with slight dimming. The
   * parent panel renders the 2px left rail, whose color identifies the step.
   */
  dimmed?: boolean;
  /** Live context window usage (updated during running step; falls back to latestOutput for completed) */
  liveContextWindow?: { used: number; size: number };
  /** Cached runtime metadata used to restore completed-step display after undo/redo */
  runtimeMeta?: {
    sessionId?: string;
    elapsed?: number;
    contextWindowUsed?: number;
    contextWindowSize?: number;
    failureMessage?: string;
  };
  /** Right-click context menu handler */
  onContextMenu?: (x: number, y: number) => void;
  /**
   * dnd-kit's `listeners`/`attributes` for this row's drag handle, or
   * `undefined` when the row isn't draggable. Rendered as the trailing item
   * inside this component's own container (rather than as a separate column
   * around it) so the handle picks up the same hover background and bottom
   * border as the rest of the step for free.
   */
  dragHandleProps?: WorkflowStepDragHandleProps;
}

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
 * WorkflowStep - Individual step in the workflow steps list.
 *
 * Renders both AI prompt steps and script steps via the `isScript` prop.
 * Shared chrome (drag handle, status icon, set-start-position button) is always present.
 */
const WorkflowStepItemInner: React.FC<WorkflowStepProps> = ({
  text,
  index,
  status,
  isDisabled = false,
  name,
  retryState,
  details,
  latestOutput,
  isCurrent = false,
  isSelected = false,
  onClick,
  harnessId,
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
  liveContextWindow,
  runtimeMeta,
  isScript = false,
  onContextMenu,
  dragHandleProps,
}) => {
  const longPressTriggeredAtRef = React.useRef<number | null>(null);
  const showCostEstimates = useSettingsStore(
    (state) => state.fullGlobalSettings?.settings.ui.showCostEstimates !== false
  );
  const longPressHandlers = useLongPress((x, y) => {
    longPressTriggeredAtRef.current = Date.now();
    onContextMenu?.(x, y);
  });

  // Derive context window percentage from live data only while this row is the
  // running step. After completion, the CLI output/runtime metadata is durable
  // and must win over any late live telemetry.
  const ctx = resolveEffectiveContextWindow({
    isCurrent,
    liveContextWindow,
    latestOutputTokens: latestOutput?.tokens,
    runtimeContextWindow: runtimeMeta,
  });
  const attemptTokens = latestOutput?.tokens;
  const attemptTotalLabel = formatTokenCount(
    resolveTokenTotal(
      attemptTokens?.total,
      attemptTokens?.prompt,
      attemptTokens?.completion
    )
  );
  const hoverTooltip = buildStepHoverTooltip({
    primaryAction: onContextMenu
      ? "Click to edit — right-click for options"
      : "Click to edit",
    contextWindow: ctx,
    harness: harnessId,
    attemptTokens,
    showCostEstimates,
  });

  // Build class names for the container
  const containerClasses = [
    "py-2 px-3",
    "cursor-pointer",
    "group",
    "cy-no-select",
    hideBorderBottom ? "" : "border-b border-panel-border",
    "transition-colors",
    dimmed ? "opacity-80" : "",
    isDisabled ? "opacity-85" : "",
  ];

  const titleTextClass = isSelected
    ? "text-list-active-fg"
    : isDisabled
      ? "text-description-fg"
      : "text-foreground";
  const detailsClass = isDisabled && !isSelected ? "opacity-80" : "";

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
      onClick={(event) => {
        if (
          longPressTriggeredAtRef.current !== null &&
          Date.now() - longPressTriggeredAtRef.current < 1000
        ) {
          longPressTriggeredAtRef.current = null;
          return;
        }
        onClick?.(getStepClickModifiers(event));
      }}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      {...longPressHandlers}
      title={hoverTooltip}
      role="button"
      tabIndex={0}
      aria-label={`Step ${displayNumber ?? index + 1}`}
      onKeyDown={(e) => {
        if (e.key === KEYBOARD_KEYS.ENTER || e.key === " ") {
          e.preventDefault();
          onClick?.({ range: false, toggle: false });
        }
      }}
    >
      {/* Layout: icon column | content column | (context bar) | (drag handle) */}
      <div className="flex items-start gap-2">
        {/* Icon column: status icon at top, set-start-position button at bottom.
            Always the same shape regardless of draggability — the drag handle
            lives at the trailing edge of the row instead, so this column never
            shifts and stays aligned across done/pending/locked rows. */}
        <span className="shrink-0 flex flex-col items-center self-stretch">
          <span className="mt-0.5">
            <StatusIcon status={status} disabled={isDisabled} animate />
          </span>
          {canSetStartPosition && (
            <button
              className="mt-auto w-4 flex items-center justify-center text-description-fg hover:text-foreground mb-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onSetStartPosition?.();
              }}
              title={`Set step ${displayNumber ?? index + 1} as start position`}
              aria-label={`Set step ${displayNumber ?? index + 1} as start position`}
            >
              <Icon
                name={
                  startPositionDirection === WORKTREE_POSITION_DIRECTIONS.REWIND
                    ? "codicon-debug-reverse-continue"
                    : "codicon-debug-step-over"
                }
                className="text-xs"
              />
            </button>
          )}
        </span>
        {/* Content column: title + details */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {isScript ? (
            // Script step variant
            <>
              <div className="flex items-center gap-1 min-w-0">
                <Icon
                  name={getStepKindIconClass(STEP_TYPES.SCRIPT)}
                  className="text-xs opacity-60 shrink-0"
                />
                <span
                  className={`text-xs leading-relaxed truncate ${titleTextClass}`}
                >
                  {name ? name : text}
                </span>
                {isDisabled && (
                  <span className="px-1 py-px rounded-sm text-xxs bg-badge-bg text-badge-fg shrink-0">
                    Disabled
                  </span>
                )}
              </div>
              {/* Script command subtitle — only shown when a name is displayed in the title row */}
              {name && text && (
                <div
                  className={`mt-0.5 text-xxs opacity-60 font-mono truncate ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
                  title={text}
                >
                  {truncate(text, 60)}
                </div>
              )}
              {/* Status details (duration, end condition) but no harness/model */}
              <div className={detailsClass}>
                <PromptStepDetails
                  status={status}
                  retryState={retryState}
                  latestOutput={latestOutput}
                  details={details}
                  runtimeMeta={runtimeMeta}
                  isSelected={isSelected}
                  attemptTotalLabel={attemptTotalLabel}
                />
              </div>
            </>
          ) : (
            // Prompt step variant (default)
            <>
              <div className="flex items-center gap-1 min-w-0">
                <Icon
                  name={getStepKindIconClass(STEP_TYPES.PROMPT)}
                  className="text-xs opacity-60 shrink-0"
                />
                <span
                  className={`text-xs leading-relaxed truncate ${titleTextClass}`}
                >
                  {name ? name : text}
                </span>
                {isDisabled && (
                  <span className="px-1 py-px rounded-sm text-xxs bg-badge-bg text-badge-fg shrink-0">
                    Disabled
                  </span>
                )}
              </div>
              <div className={detailsClass}>
                <PromptStepDetails
                  status={status}
                  harnessId={harnessId}
                  harnessLabel={harnessLabel}
                  harnessIsDefault={harnessIsDefault}
                  modelLabel={modelLabel}
                  modelIsDefault={modelIsDefault}
                  retryState={retryState}
                  latestOutput={latestOutput}
                  details={details}
                  runtimeMeta={runtimeMeta}
                  isSelected={isSelected}
                  overrides={overrides}
                  attemptTotalLabel={attemptTotalLabel}
                />
              </div>
            </>
          )}
        </div>
        <ContextWindowBar
          contextWindow={ctx}
          attemptTokens={attemptTokens}
          harnessId={harnessId}
        />
        {dragHandleProps && (
          <button
            type="button"
            className="shrink-0 w-3 flex items-center justify-center self-stretch cursor-grab active:cursor-grabbing text-description-fg hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            style={DRAG_HANDLE_TOUCH_ACTION_STYLE}
            onClick={(e) => e.stopPropagation()}
            // Dragging/long-pressing the handle must never surface the row's
            // context menu. A real right-click on the handle is one source,
            // but on Windows a touch/pen press-and-hold — the same gesture
            // used to start a touch drag — also dispatches a genuine
            // `contextmenu` DOM event at the handle before any drag movement
            // is detected. Stopping it here (rather than only in the row's
            // onContextMenu) keeps it from ever reaching that handler.
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            // Prevents a touch press on the handle from also starting the
            // row's own long-press timer (see useLongPress) — that timer
            // opens the context menu directly in JS, independent of the
            // native contextmenu event suppressed above.
            onTouchStart={(e) => e.stopPropagation()}
            {...(dragHandleProps.listeners ?? {})}
            {...dragHandleProps.attributes}
            aria-label="Drag to reorder"
          >
            <Icon name="grabber" className="text-xs" />
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Step rows receive frequent live execution updates from the workflow store.
 * Keep direct consumers from re-running token/usage formatting when their
 * display props have not changed.
 */
export const WorkflowStepItem = React.memo(WorkflowStepItemInner);

WorkflowStepItem.displayName = "WorkflowStepItem";
