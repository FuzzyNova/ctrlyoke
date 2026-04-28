import React, { useState, useCallback } from "react";
import { STEP_STATUS } from "../../types/messages";
import type { StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";
import type { StepDetails } from "./WorkflowStep";

/**
 * A single prompt-level property override to display in the overrides row.
 * label: short display text (e.g. "resume", "ec: my-script.js", "ctx: all")
 * title: optional full tooltip text for truncated/abbreviated values
 */
export interface PromptOverride {
  label: string;
  title?: string;
}

interface PromptStepDetailsProps {
  status: StepStatus;
  harnessLabel?: string;
  harnessIsDefault?: boolean;
  modelLabel?: string;
  modelIsDefault?: boolean;
  retryState?: RetryState;
  latestOutput?: CliOutput | null;
  details?: StepDetails;
  isSelected?: boolean;
  runtimeMeta?: {
    sessionId?: string;
    elapsed?: number;
  };
  /** Prompt-level property overrides to display as compact chips */
  overrides?: PromptOverride[];
}

/**
 * PromptStepDetails - Shared secondary metadata rows for prompt display.
 *
 * Renders harness/model info, retry state, compact stats (context %, session ID,
 * duration), end condition result, status message, and property overrides.
 * Used by both PromptStep and FinalStepFooter so future additions automatically
 * appear in both places.
 */
export const PromptStepDetails: React.FC<PromptStepDetailsProps> = ({
  status,
  harnessLabel,
  harnessIsDefault,
  modelLabel,
  modelIsDefault,
  retryState,
  latestOutput,
  details,
  isSelected = false,
  runtimeMeta,
  overrides,
}) => {
  const durationSeconds =
    details?.duration ?? latestOutput?.elapsed ?? runtimeMeta?.elapsed;
  const sessionId =
    latestOutput?.structured?.metadata?.sessionId ?? runtimeMeta?.sessionId;
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
    <>
      {/* Harness / model metadata */}
      {(harnessLabel || modelLabel) && (
        <div
          className={`mt-0.5 flex items-center gap-1 text-xxs opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
        >
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
              {modelIsDefault && <span className="opacity-60"> (default)</span>}
            </span>
          )}
        </div>
      )}

      {/* Retry indicator */}
      {retryState && retryState.currentRetry > 0 && (
        <div className="mt-1 pl-5 flex items-center gap-1.5 text-xs font-semibold text-warning-fg">
          <i className="codicon codicon-refresh text-xs" />
          <span>
            Retry {retryState.currentRetry} of {retryState.maxRetries}
          </span>
        </div>
      )}

      {/* Compact stats — for completed prompts: [duration] [sessionId {copy}] */}
      {status === STEP_STATUS.COMPLETED &&
        (sessionId || durationSeconds !== undefined) && (
          <div
            className={`mt-0.5 flex items-center gap-1 text-xxs opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
          >
            {[
              durationSeconds !== undefined ? (
                <span key="dur">{durationSeconds.toFixed(1)}s</span>
              ) : null,
              sessionId ? (
                <span
                  key="session"
                  className="inline-flex items-center gap-0.5"
                >
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
                      className={`codicon text-xxs ${copied ? "codicon-check" : "codicon-copy"}`}
                    />
                  </button>
                </span>
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
        <div
          className={`mt-1 pl-5 flex items-center gap-1.5 text-xs ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
        >
          <span>End condition:</span>
          {details.endConditionResult.passed ? (
            <i className="codicon codicon-pass text-indicator-success" />
          ) : (
            <i className="codicon codicon-error text-indicator-error" />
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
        <div
          className={`mt-1 pl-5 text-xs italic ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
        >
          {details.message}
        </div>
      )}

      {/* Property overrides — compact chips for prompt-level overrides */}
      {overrides && overrides.length > 0 && (
        <div
          className={`mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xxs opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
        >
          {overrides.map((override, i) => (
            <span
              key={i}
              className="inline-flex items-center px-1 rounded bg-badge-bg text-badge-fg opacity-90"
              title={override.title ?? override.label}
            >
              {override.label}
            </span>
          ))}
        </div>
      )}
    </>
  );
};
