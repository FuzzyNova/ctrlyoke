import React from "react";
import { ExecutionStateBadge } from "@components/shared/ExecutionStateBadge";
import {
  WorkflowTokenUsage,
  hasWorkflowTokenUsage,
} from "@components/workflow/WorkflowTokenUsage";
import type { ExecutionState } from "@root/types/DashboardConstants";
import type { WorkflowTokenTotals } from "@root/types/CtrlYokeTypes";

/** The run identity/status data the banner displays — sourced from whichever run is currently displayed, live or historical. */
export interface RunBannerData {
  runId: number;
  startedAt: number;
  executionState: ExecutionState;
  tokenTotals?: WorkflowTokenTotals;
}

export interface RunSummaryBannerProps extends RunBannerData {
  /** Fixed to the top of the scroll container instead of scrolling with content. */
  isPinned: boolean;
  onTogglePinned: () => void;
  /** True while browsing history and a different run is executing live. */
  showBackToLive: boolean;
  onBackToLive?: () => void;
}

/**
 * Always-visible run identity strip at the top of the output pane — run
 * number, start date, execution state, and (when available) the run's
 * token/cost totals. Replaces the header's cramped centered usage display
 * (see OutputSectionHeader) and the history-only banner it grew out of:
 * this one renders for live runs too, not just while browsing history.
 */
export const RunSummaryBanner: React.FC<RunSummaryBannerProps> = ({
  runId,
  startedAt,
  executionState,
  tokenTotals,
  isPinned,
  onTogglePinned,
  showBackToLive,
  onBackToLive,
}) => {
  return (
    <div
      className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[length:var(--fp-output-font-size-sm)] text-description-fg bg-editor-bg border-b border-widget-border flex-shrink-0 ${
        isPinned ? "sticky top-0 z-10" : ""
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="truncate">
          Run {runId} &middot; {new Date(startedAt).toLocaleString()}
        </span>
        <ExecutionStateBadge state={executionState} />
      </span>
      <span className="flex items-center gap-2 flex-shrink-0">
        {hasWorkflowTokenUsage(tokenTotals) && (
          <WorkflowTokenUsage totals={tokenTotals} />
        )}
        {showBackToLive && onBackToLive && (
          <button
            type="button"
            onClick={onBackToLive}
            className="text-link-fg hover:underline focus:outline-none"
          >
            Back to Live{" "}
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-indicator-success animate-pulse align-middle" />
          </button>
        )}
        <button
          type="button"
          onClick={onTogglePinned}
          title={
            isPinned
              ? "Unpin (scrolls with output)"
              : "Pin to top of output"
          }
          aria-label={isPinned ? "Unpin run summary" : "Pin run summary"}
          aria-pressed={isPinned}
          className="icon-btn py-0.5 px-1"
        >
          <i className={`codicon ${isPinned ? "codicon-pinned" : "codicon-pin"}`} />
        </button>
      </span>
    </div>
  );
};
