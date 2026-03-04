import React, { useState, useCallback } from "react";
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
}) => {
  // Build class names for the container
  const containerClasses = [
    "py-2 px-3",
    "cursor-pointer",
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

  // Compact stats derived from latestOutput (elapsed is in seconds)
  const durationSeconds = details?.duration ?? latestOutput?.elapsed;
  const sessionId = latestOutput?.structured?.metadata?.sessionId;
  const tokens = latestOutput?.tokens;
  const contextPct =
    tokens?.contextWindowUsed !== undefined && tokens?.contextWindowSize
      ? Math.round((tokens.contextWindowUsed / tokens.contextWindowSize) * 100)
      : undefined;

  const [copied, setCopied] = useState(false);
  const handleCopySessionId = useCallback(async () => {
    if (!sessionId) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sessionId);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = sessionId;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }, [sessionId]);

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
        <span className={`flex-1 min-w-0 text-xs leading-relaxed ${isSelected ? "text-list-active-fg" : "text-foreground"}`}>
          <span className="font-medium">{index + 1}.</span>{" "}
          {name ? name : truncate(text, 60)}
        </span>
      </div>

      {/* Harness / model metadata */}
      {(harnessLabel || modelLabel) && (
        <div className={`mt-0.5 pl-5 flex items-center gap-1 text-[10px] opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}>
          {harnessLabel && (
            <span>
              {harnessLabel}
              {harnessIsDefault && (
                <span className="opacity-60"> (default)</span>
              )}
            </span>
          )}
          {harnessLabel && modelLabel && (
            <span className="opacity-40 mx-0.5">·</span>
          )}
          {modelLabel && (
            <span>
              {modelLabel}
              {modelIsDefault && (
                <span className="opacity-60"> (default)</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Retry indicator */}
      {retryState && retryState.currentRetry > 0 && (
        <div className="mt-1 pl-5 flex items-center gap-1.5 text-[11px] font-semibold text-warning-fg">
          <i className="codicon codicon-refresh text-xs" />
          <span>
            Retry {retryState.currentRetry} of {retryState.maxRetries}
          </span>
        </div>
      )}

      {/* Compact stats: context %, session ID, duration — for completed prompts */}
      {status === "completed" &&
        (contextPct !== undefined || sessionId || durationSeconds !== undefined) && (
          <div
            className={`mt-0.5 pl-5 flex items-center gap-1 text-[10px] opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
          >
            {[
              contextPct !== undefined ? (
                <span key="ctx">{contextPct}%</span>
              ) : null,
              sessionId ? (
                <span key="session" className="inline-flex items-center gap-0.5">
                  <span>{sessionId.substring(0, 6)}</span>
                  <button
                    type="button"
                    className="icon-btn py-0 px-0.5"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCopySessionId();
                    }}
                    title="Copy session ID"
                    aria-label="Copy session ID"
                  >
                    <i
                      className={`codicon text-[9px] ${copied ? "codicon-check" : "codicon-copy"}`}
                    />
                  </button>
                </span>
              ) : null,
              durationSeconds !== undefined ? (
                <span key="dur">{durationSeconds.toFixed(1)}s</span>
              ) : null,
            ]
              .filter(Boolean)
              .map((part, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="opacity-40">·</span>}
                  {part}
                </React.Fragment>
              ))}
          </div>
        )}

      {/* End condition result */}
      {details?.endConditionResult && (
        <div className={`mt-1 pl-5 flex items-center gap-1.5 text-[11px] ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}>
          <span>End condition:</span>
          {details.endConditionResult.passed ? (
            <i className="codicon codicon-pass text-bash-status-success" />
          ) : (
            <i className="codicon codicon-error text-bash-status-error" />
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
        <div className={`mt-1 pl-5 text-[11px] italic ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}>
          {details.message}
        </div>
      )}
    </div>
  );
};
