import React from "react";
import { StatusIcon } from "./StatusIcon";
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
  /** Optional prompt ID/name */
  id?: string;
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
  id: _id, // Used for key generation in parent
  retryState,
  details,
  latestOutput,
  isCurrent = false,
  isSelected = false,
  onClick,
}) => {
  void _id; // Suppress unused variable warning
  // Build class names for the container
  const containerClasses = [
    "py-2 px-3",
    "cursor-pointer",
    "border-b border-[var(--vscode-panel-border)]",
    "transition-colors",
  ];

  // Add hover and selection states
  if (isSelected) {
    containerClasses.push(
      "bg-[var(--vscode-list-activeSelectionBackground)]",
      "text-[var(--vscode-list-activeSelectionForeground)]"
    );
  } else if (isCurrent) {
    containerClasses.push(
      "bg-[var(--vscode-list-inactiveSelectionBackground)]"
    );
  } else {
    containerClasses.push("hover:bg-[var(--vscode-list-hoverBackground)]");
  }

  // Calculate duration from output if not in details
  const durationSeconds =
    details?.duration ??
    (latestOutput?.elapsed ? latestOutput.elapsed / 1000 : undefined);

  return (
    <div
      className={containerClasses.join(" ")}
      data-prompt-index={index}
      onClick={onClick}
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
        <span className="flex-shrink-0 mt-0.5">
          <StatusIcon status={status} />
        </span>
        <span className="flex-1 min-w-0 text-xs leading-relaxed text-[var(--vscode-foreground)]">
          <span className="font-medium">{index + 1}.</span> {truncate(text, 60)}
        </span>
      </div>

      {/* Retry indicator */}
      {retryState && retryState.currentRetry > 0 && (
        <div className="mt-1 pl-5 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--vscode-editorWarning-foreground)]">
          <i className="codicon codicon-refresh text-xs" />
          <span>
            Retry {retryState.currentRetry} of {retryState.maxRetries}
          </span>
        </div>
      )}

      {/* Duration */}
      {durationSeconds !== undefined && status === "completed" && (
        <div className="mt-1 pl-5 text-[11px] text-[var(--vscode-descriptionForeground)]">
          Duration: {durationSeconds.toFixed(1)}s
        </div>
      )}

      {/* End condition result */}
      {details?.endConditionResult && (
        <div className="mt-1 pl-5 flex items-center gap-1.5 text-[11px] text-[var(--vscode-descriptionForeground)]">
          <span>End condition:</span>
          {details.endConditionResult.passed ? (
            <i className="codicon codicon-pass text-[var(--vscode-charts-green)]" />
          ) : (
            <i className="codicon codicon-error text-[var(--vscode-charts-red)]" />
          )}
          {details.endConditionResult.message && (
            <span className="truncate">
              {details.endConditionResult.message}
            </span>
          )}
        </div>
      )}

      {/* Status message */}
      {details?.message && (
        <div className="mt-1 pl-5 text-[11px] italic text-[var(--vscode-descriptionForeground)]">
          {details.message}
        </div>
      )}
    </div>
  );
};
