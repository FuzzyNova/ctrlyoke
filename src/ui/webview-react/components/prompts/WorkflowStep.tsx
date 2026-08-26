import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import React, { useState } from "react";
import { useLongPress } from "../../hooks/useLongPress";
import type { DraggableAttributes } from "@dnd-kit/core";
type SyntheticListenerMap = Record<string, Function>;
import { StatusIcon } from "./StatusIcon";
import { PromptStepDetails } from "./PromptStepDetails";
import type { PromptOverride } from "./PromptStepDetails";
export type { PromptOverride };
import type { HarnessId, StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";
import {
  formatTokenBreakdown,
  formatTokenCount,
  formatAttemptCostTooltip,
  resolveTokenTotal,
} from "@root/utils/TokenFormatting";
import { useSettingsStore } from "@store/settingsStore";
import { getUsageBarColorClass } from "@utils/usageBarColor";
import { DRAG_HANDLE_TOUCH_ACTION_STYLE } from "@utils/dndKit";

export interface EndConditionResult {
  passed: boolean;
  message?: string;
}

export interface StepDetails {
  duration?: number;
  endConditionResult?: EndConditionResult;
  message?: string;
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
  onClick?: () => void;
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
  startPositionDirection?: "rewind" | "forward";
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
   * When true, applies completed-section styling: slight dim + green left
   * accent to visually distinguish locked/done prompts from pending ones.
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
  /** Drag handle props from dnd-kit sortable */
  dragHandleProps?: {
    listeners: SyntheticListenerMap | undefined;
    attributes: DraggableAttributes;
  };
  /** Right-click context menu handler */
  onContextMenu?: (x: number, y: number) => void;
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
  dragHandleProps,
  isScript = false,
  onContextMenu,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const hideCost = useSettingsStore(
    (state) => state.fullGlobalSettings?.settings.ui.hideCost === true
  );
  const longPressHandlers = useLongPress(onContextMenu);

  // Derive context window percentage from live data only while this row is the
  // running step. After completion, the CLI output/runtime metadata is durable
  // and must win over any late live telemetry.
  const completedContext = latestOutput?.tokens?.contextWindowSize
    ? {
        used: latestOutput.tokens.contextWindowUsed ?? 0,
        size: latestOutput.tokens.contextWindowSize,
      }
    : runtimeMeta?.contextWindowSize
      ? {
          used: runtimeMeta.contextWindowUsed ?? 0,
          size: runtimeMeta.contextWindowSize,
        }
      : undefined;
  const ctx =
    isCurrent && liveContextWindow
      ? liveContextWindow
      : (completedContext ?? liveContextWindow);
  const contextPct = ctx?.size
    ? Math.round((ctx.used / ctx.size) * 100)
    : undefined;
  const attemptTokens = latestOutput?.tokens;
  const attemptTotalLabel = formatTokenCount(
    resolveTokenTotal(
      attemptTokens?.total,
      attemptTokens?.prompt,
      attemptTokens?.completion
    )
  );
  const attemptBreakdown = attemptTokens
    ? formatTokenBreakdown({
        input: attemptTokens.prompt,
        output: attemptTokens.completion,
        total: attemptTokens.total,
        cached: attemptTokens.cached,
        cacheCreated: attemptTokens.cacheCreated,
      })
    : "";
  const compactionCount = attemptTokens?.compactionCount;
  const visibleAttemptTotal =
    contextPct !== undefined &&
    compactionCount !== undefined &&
    compactionCount > 0 &&
    !!attemptTotalLabel;
  const contextLabel =
    ctx && contextPct !== undefined
      ? `${formatTokenCount(ctx.used)}/${formatTokenCount(ctx.size)} (${contextPct}%)`
      : undefined;
  const tokenTooltip = [
    contextLabel ? `Current context window: ${contextLabel}` : null,
    attemptTotalLabel ? `Attempt total: ${attemptTotalLabel} tokens` : null,
    attemptBreakdown || null,
    compactionCount !== undefined ? `Compactions: ${compactionCount}` : null,
    !hideCost && attemptTokens?.cost
      ? formatAttemptCostTooltip(attemptTokens.cost)
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

  // Build class names for the container
  const containerClasses = [
    "py-2 px-3",
    "cursor-pointer",
    "group",
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
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
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
      title={
        tokenTooltip ? `Click to edit\n\n${tokenTooltip}` : "Click to edit"
      }
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === KEYBOARD_KEYS.ENTER || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {/* Layout: drag handle | icon column | content column */}
      <div className="flex items-start gap-2">
        {dragHandleProps && (
          <span
            className="flex-shrink-0 cursor-grab active:cursor-grabbing text-description-fg hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
            style={DRAG_HANDLE_TOUCH_ACTION_STYLE}
            {...dragHandleProps.listeners}
            {...dragHandleProps.attributes}
            aria-label="Drag to reorder"
          >
            <i className="codicon codicon-grabber text-xs" />
          </span>
        )}
        {/* Icon column: status icon at top, set-start-position button at bottom */}
        <span className="flex-shrink-0 flex flex-col items-center self-stretch">
          <span className="mt-0.5">
            <StatusIcon status={status} disabled={isDisabled} />
          </span>
          {canSetStartPosition && isHovered && (
            <button
              className="mt-auto w-4 flex items-center justify-center text-description-fg hover:text-foreground mb-0.5"
              onClick={(e) => {
                e.stopPropagation();
                onSetStartPosition?.();
              }}
              title={`Set step ${displayNumber ?? index + 1} as start position`}
              aria-label={`Set step ${displayNumber ?? index + 1} as start position`}
            >
              <i
                className={`codicon ${startPositionDirection === "rewind" ? "codicon-debug-reverse-continue" : "codicon-debug-step-over"} text-xs`}
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
                <i className="codicon codicon-terminal-powershell text-xs opacity-60 flex-shrink-0" />
                <span
                  className={`text-xs leading-relaxed truncate ${titleTextClass}`}
                >
                  {name ? name : text}
                </span>
                {isDisabled && (
                  <span className="px-1 py-px rounded text-xxs bg-badge-bg text-badge-fg flex-shrink-0">
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
                />
              </div>
            </>
          ) : (
            // Prompt step variant (default)
            <>
              <div className="flex items-center gap-1 min-w-0">
                <i className="codicon codicon-comment text-xs opacity-60 flex-shrink-0" />
                <span
                  className={`text-xs leading-relaxed truncate ${titleTextClass}`}
                >
                  {name ? name : text}
                </span>
                {isDisabled && (
                  <span className="px-1 py-px rounded text-xxs bg-badge-bg text-badge-fg flex-shrink-0">
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
                />
              </div>
            </>
          )}
        </div>
        {contextPct !== undefined && (
          <div
            className="flex-shrink-0 flex flex-col items-center w-3 self-stretch ml-0.5"
            title={tokenTooltip || undefined}
          >
            {/* Track */}
            <div className="flex-1 w-1.5 rounded-full bg-ctx-bar-track overflow-hidden relative">
              {/* Fill */}
              <div
                key={contextPct}
                className={`absolute bottom-0 left-0 right-0 rounded-full animate-ctx-update ${getUsageBarColorClass(
                  contextPct
                )}`}
                style={{ height: `${contextPct}%` }}
              />
            </div>
            {/* Percentage label */}
            <span className="text-xxs leading-none text-description-fg opacity-75 mt-0.5">
              {contextPct}%
              {visibleAttemptTotal && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span>{attemptTotalLabel}</span>
                </>
              )}
            </span>
          </div>
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
