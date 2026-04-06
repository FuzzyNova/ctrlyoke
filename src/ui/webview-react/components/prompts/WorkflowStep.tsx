import React, { useState } from "react";
import type { DraggableAttributes } from "@dnd-kit/core";
type SyntheticListenerMap = Record<string, Function>;
import { StatusIcon } from "./StatusIcon";
import { PromptStepDetails } from "./PromptStepDetails";
import type { PromptOverride } from "./PromptStepDetails";
export type { PromptOverride };
import type { StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";

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
  /** When true, renders the script step variant (terminal icon, Script badge, command text) */
  isScript?: boolean;
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
export const WorkflowStepItem: React.FC<WorkflowStepProps> = ({
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
  isScript = false,
}) => {
  const [isHovered, setIsHovered] = useState(false);

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
      {/* Layout: drag handle | icon column | content column */}
      <div className="flex items-start gap-2">
        {dragHandleProps && (
          <span
            className="flex-shrink-0 cursor-grab active:cursor-grabbing text-description-fg hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
            {...dragHandleProps.listeners}
            {...dragHandleProps.attributes}
            aria-label="Drag to reorder"
          >
            <i className="codicon codicon-grabber text-[12px]" />
          </span>
        )}
        {/* Icon column: status icon at top, set-start-position button at bottom */}
        <span className="flex-shrink-0 flex flex-col items-center self-stretch">
          <span className="mt-0.5">
            <StatusIcon status={status} />
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
                className={`codicon ${startPositionDirection === "rewind" ? "codicon-debug-reverse-continue" : "codicon-debug-step-over"} text-[12px]`}
              />
            </button>
          )}
        </span>
        {/* Content column: title + details */}
        <div className="flex-1 min-w-0">
          {isScript ? (
            // Script step variant
            <>
              <div className="flex items-center gap-1 min-w-0">
                <i className="codicon codicon-terminal-powershell text-[11px] opacity-60 flex-shrink-0" />
                <span
                  className={`text-xs leading-relaxed truncate ${isSelected ? "text-list-active-fg" : "text-foreground"}`}
                >
                  {name ? name : text}
                </span>
              </div>
              {/* Script command subtitle — only shown when a name is displayed in the title row */}
              {name && text && (
                <div
                  className={`mt-0.5 text-[10px] opacity-60 font-mono truncate ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
                  title={text}
                >
                  {truncate(text, 60)}
                </div>
              )}
              {/* Status details (duration, end condition) but no harness/model */}
              <PromptStepDetails
                status={status}
                retryState={retryState}
                latestOutput={latestOutput}
                details={details}
                isSelected={isSelected}
              />
            </>
          ) : (
            // Prompt step variant (default)
            <>
              <div className="flex items-center gap-1 min-w-0">
                <i className="codicon codicon-comment text-[11px] opacity-60 flex-shrink-0" />
                <span
                  className={`text-xs leading-relaxed truncate ${isSelected ? "text-list-active-fg" : "text-foreground"}`}
                >
                  {name ? name : text}
                </span>
              </div>
              <PromptStepDetails
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
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};
