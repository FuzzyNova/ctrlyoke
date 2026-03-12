import React, { useState } from "react";
import type { DraggableAttributes } from "@dnd-kit/core";
type SyntheticListenerMap = Record<string, Function>;
import { StatusIcon } from "./StatusIcon";
import { PromptItemDetails } from "./PromptItemDetails";
import type { PromptOverride } from "./PromptItemDetails";
export type { PromptOverride };
import type { StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";

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
  dragHandleProps,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  // Build class names for the container
  const containerClasses = [
    "py-2 px-3",
    "cursor-pointer",
    "group",
    "border-b border-panel-border",
    "transition-colors",
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
            title={`Set step ${index + 1} as start position`}
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
          <span className="font-medium">{index + 1}.</span>{" "}
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
      />
    </div>
  );
};
