import React from "react";
import { ExecutionStateBadge } from "@components/shared/ExecutionStateBadge";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import {
  WorkflowTokenUsage,
  hasWorkflowTokenUsage,
} from "@components/workflow/WorkflowTokenUsage";
import type { ExecutionState } from "@root/types/DashboardConstants";
import type {
  WorktreeRunProjection,
  WorkflowTokenTotals,
} from "@root/types/CtrlYokeTypes";
import { sendMessage } from "@hooks/useMessageHandler";

/** The run identity/status data the banner displays — sourced from whichever run is currently displayed, live or historical. */
export interface RunBannerData {
  runId: number;
  startedAt: number;
  executionState: ExecutionState;
  tokenTotals?: WorkflowTokenTotals;
  /** Persisted projection from the displayed run's `_runtime.worktree`. */
  worktree?: WorktreeRunProjection;
}

function formatRelativeWorktreePath(worktree: WorktreeRunProjection): string {
  const target = worktree.worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const source = worktree.sourceCheckoutRoot
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const parentEnd = source.lastIndexOf("/");
  if (parentEnd < 0) return target;

  const parent = source.slice(0, parentEnd) || "/";
  const comparable = (value: string) =>
    /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
  const comparableParent = comparable(parent);
  const comparableTarget = comparable(target);
  if (
    comparableTarget === comparableParent ||
    comparableTarget.startsWith(`${comparableParent}/`)
  ) {
    return target.slice(parent.length + (parent === "/" ? 0 : 1));
  }
  return target;
}

function formatWorktreeOutcome(
  worktree: WorktreeRunProjection
): string | undefined {
  if (worktree.directoryState === "remove-failed") {
    return "⚠ worktree removal failed — branch safe, directory kept";
  }
  switch (worktree.landingOutcome) {
    case "landed":
      return `✓ branch ready — ${worktree.changedFileCount ?? 0} file${
        worktree.changedFileCount === 1 ? "" : "s"
      }`;
    case "no-changes":
      return "✓ no changes";
    case "blocked":
      return `⚠ commit blocked — worktree kept at ${formatRelativeWorktreePath(
        worktree
      )}`;
    default:
      return undefined;
  }
}

/** Settled managed runs cannot restore files into a checkout that no longer owns them. */
export function isManagedWorktreeUndoUnavailable(
  worktree: WorktreeRunProjection | undefined
): boolean {
  return (
    worktree?.mode === "managed" &&
    (worktree.lifecycleState === "settled" ||
      worktree.directoryState !== "present")
  );
}

function formatDirectoryState(worktree: WorktreeRunProjection): string {
  switch (worktree.directoryState) {
    case "removed":
      return " (removed)";
    case "missing":
      return " (missing)";
    case "remove-failed":
      return " (removal failed)";
    default:
      return "";
  }
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
  worktree,
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
        <span className="truncate min-w-0">
          Run {runId} &middot; {new Date(startedAt).toLocaleString()}
        </span>
        <ExecutionStateBadge state={executionState} />
        {worktree && (
          <>
            <span
              className="truncate"
              title={`Worktree branch: ${worktree.branchName}`}
            >
              {worktree.branchName}
            </span>
            {formatWorktreeOutcome(worktree) && (
              <span className="whitespace-nowrap">
                &middot; {formatWorktreeOutcome(worktree)}
              </span>
            )}
          </>
        )}
      </span>
      <span className="flex items-center gap-2 flex-shrink-0">
        {worktree && (
          <span
            className="hidden sm:inline truncate max-w-72"
            title={`Worktree: ${worktree.worktreePath}`}
          >
            Worktree: {formatRelativeWorktreePath(worktree)}
            {formatDirectoryState(worktree)}
          </span>
        )}
        {worktree && worktree.baseCommit && worktree.branchName && (
          <>
            <button
              type="button"
              onClick={() =>
                sendMessage(MESSAGE_TYPES.VIEW_WORKTREE_DIFF, {
                  sourceCheckoutRoot: worktree.sourceCheckoutRoot,
                  baseCommit: worktree.baseCommit,
                  branchName: worktree.branchName,
                })
              }
              title="View the recorded branch against its recorded base commit"
              className="text-link-fg hover:underline focus:outline-none"
            >
              View Diff
            </button>
            {worktree.directoryState === "present" && (
              <button
                type="button"
                onClick={() =>
                  sendMessage(MESSAGE_TYPES.OPEN_WORKTREE, {
                    worktreePath: worktree.worktreePath,
                  })
                }
                title="Open the worktree in a new window"
                className="text-link-fg hover:underline focus:outline-none"
              >
                Open Worktree in New Window
              </button>
            )}
          </>
        )}
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
            isPinned ? "Unpin (scrolls with output)" : "Pin to top of output"
          }
          aria-label={isPinned ? "Unpin run summary" : "Pin run summary"}
          aria-pressed={isPinned}
          className="icon-btn py-0.5 px-1"
        >
          <i
            className={`codicon ${isPinned ? "codicon-pinned" : "codicon-pin"}`}
          />
        </button>
      </span>
    </div>
  );
};
