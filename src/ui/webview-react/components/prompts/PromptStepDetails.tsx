import React, { useState, useCallback } from "react";
import { STEP_STATUS } from "../../types/messages";
import type { HarnessId, StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";
import type { StepDetails } from "./WorkflowStep";
import { HarnessIcon } from "@components/shared/HarnessIcon";
import { Icon } from "../shared/Icon";
import { formatRetryDenominator } from "../../../../utils/LimitUtils";

/**
 * A single prompt-level property override to display in the overrides row.
 * label: short display text (e.g. "resume", "ec: my-script.js", "ctx: all")
 * title: optional full tooltip text for truncated/abbreviated values
 */
export interface PromptOverride {
  label: string;
  title?: string;
  icon?: string;
}

interface PromptStepDetailsProps {
  status: StepStatus;
  /** Harness ID for the icon shown before the harness label */
  harnessId?: HarnessId;
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
  /** Formatted attempt token total (e.g. "14.2k"), shown alongside duration/session ID regardless of compaction state */
  attemptTotalLabel?: string;
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
  harnessId,
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
  attemptTotalLabel,
}) => {
  const showCompactStats =
    status === STEP_STATUS.COMPLETED ||
    status === STEP_STATUS.FAILED ||
    status === STEP_STATUS.CANCELLED;
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
      {/* Harness / model metadata — shares a line when there's room; the
          model (with its separator) wraps to its own line instead of
          truncating when the row is too narrow to fit both. */}
      {(harnessLabel || modelLabel) && (
        <div
          className={`mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xxs opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
        >
          {harnessLabel && (
            <span
              className="inline-flex min-w-0 max-w-full items-center gap-1"
              title={
                harnessIsDefault ? `${harnessLabel} (default)` : harnessLabel
              }
            >
              {harnessId && (
                <HarnessIcon
                  harnessId={harnessId}
                  size={12}
                  className="opacity-90 flex-shrink-0"
                />
              )}
              <span className="truncate">
                {harnessLabel}
                {harnessIsDefault && (
                  <span className="opacity-60"> (default)</span>
                )}
              </span>
            </span>
          )}
          {modelLabel && (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1">
              {harnessLabel && (
                <span className="flex-shrink-0 opacity-40">·</span>
              )}
              <span
                className="truncate"
                title={modelIsDefault ? `${modelLabel} (default)` : modelLabel}
              >
                {modelLabel}
                {modelIsDefault && (
                  <span className="opacity-60"> (default)</span>
                )}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Retry indicator */}
      {retryState && retryState.currentRetry > 0 && (
        <div className="mt-1 pl-5 flex items-center gap-1.5 text-xs font-semibold text-warning-fg">
          <Icon name="refresh" className="text-xs" />
          <span>
            Retry {retryState.currentRetry} of {formatRetryDenominator(retryState.maxRetries)}
          </span>
        </div>
      )}

      {/* Compact stats — for terminal prompts: [duration] [token total] [sessionId {copy}], wrapping like the overrides row at narrow widths */}
      {showCompactStats &&
        (sessionId || durationSeconds !== undefined || attemptTotalLabel) && (
          <div
            className={`mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xxs opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
          >
            {[
              durationSeconds !== undefined ? (
                <span key="dur">{durationSeconds.toFixed(1)}s</span>
              ) : null,
              attemptTotalLabel ? (
                <span key="tokens">{attemptTotalLabel} tks</span>
              ) : null,
              sessionId ? (
                <span
                  key="session"
                  className="inline-flex items-center gap-0.5"
                >
                  <span>{sessionId.slice(-6)}</span>
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
                    <Icon
                      name={copied ? "codicon-check" : "codicon-copy"}
                      className="text-xxs"
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
            <Icon name="pass" className="text-indicator-success" />
          ) : (
            <Icon name="error" className="text-indicator-error" />
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
              {override.icon && (
                <Icon name={override.icon} className="mr-0.5" />
              )}
              {override.label}
            </span>
          ))}
        </div>
      )}
    </>
  );
};
