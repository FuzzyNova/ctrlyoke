import React, { useState, useCallback } from "react";
import type { StepStatus } from "../../types/messages";
import type { RetryState, CliOutput } from "../../store/workflowStore";
import type { PromptDetails } from "./PromptItem";

interface PromptItemDetailsProps {
  status: StepStatus;
  harnessLabel?: string;
  harnessIsDefault?: boolean;
  modelLabel?: string;
  modelIsDefault?: boolean;
  retryState?: RetryState;
  latestOutput?: CliOutput | null;
  details?: PromptDetails;
  isSelected?: boolean;
}

/**
 * PromptItemDetails - Shared secondary metadata rows for prompt display.
 *
 * Renders harness/model info, retry state, compact stats (context %, session ID,
 * duration), end condition result, and status message. Used by both PromptItem
 * and FinalPromptFooter so future additions automatically appear in both places.
 */
export const PromptItemDetails: React.FC<PromptItemDetailsProps> = ({
  status,
  harnessLabel,
  harnessIsDefault,
  modelLabel,
  modelIsDefault,
  retryState,
  latestOutput,
  details,
  isSelected = false,
}) => {
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
    <>
      {/* Harness / model metadata */}
      {(harnessLabel || modelLabel) && (
        <div
          className={`mt-0.5 pl-5 flex items-center gap-1 text-[10px] opacity-75 ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
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
        <div
          className={`mt-1 pl-5 flex items-center gap-1.5 text-[11px] ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
        >
          <span>End condition:</span>
          {details.endConditionResult.passed ? (
            <i className="codicon codicon-pass text-bash-status-success" />
          ) : (
            <i className="codicon codicon-error text-bash-status-error" />
          )}
          {details.endConditionResult.message && (
            <span className="truncate">{details.endConditionResult.message}</span>
          )}
        </div>
      )}

      {/* Status message */}
      {details?.message && (
        <div
          className={`mt-1 pl-5 text-[11px] italic ${isSelected ? "text-list-active-fg" : "text-description-fg"}`}
        >
          {details.message}
        </div>
      )}
    </>
  );
};
