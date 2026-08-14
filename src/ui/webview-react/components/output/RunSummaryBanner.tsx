import React, { useCallback, useState } from "react";
import { ExecutionStateBadge } from "@components/shared/ExecutionStateBadge";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import {
  WorkflowTokenUsage,
  hasWorkflowTokenUsage,
} from "@components/workflow/WorkflowTokenUsage";
import { writeClipboardText } from "@utils/stepClipboard";
import type { ExecutionState } from "@root/types/DashboardConstants";
import type {
  WorktreeRunProjection,
  WorkflowViewAddress,
  WorkflowTokenTotals,
} from "@root/types/CtrlYokeTypes";
import { sendMessage } from "@hooks/useMessageHandler";

/** Bordered pill styling shared by the worktree row's action buttons, so two adjacent buttons never read as one run-together label. */
const WORKTREE_BUTTON_CLASS =
  "rounded border border-widget-border px-1.5 py-0.5 text-xs leading-none text-link-fg hover:bg-list-hover-bg focus:outline-none whitespace-nowrap";

type WorktreeOutcomeSeverity = "success" | "warning" | "error";

interface WorktreeOutcome {
  severity: WorktreeOutcomeSeverity;
  text: string;
}

const OUTCOME_TONE: Record<
  WorktreeOutcomeSeverity,
  { icon: string; className: string }
> = {
  success: { icon: "codicon-check", className: "text-indicator-success" },
  warning: { icon: "codicon-warning", className: "text-warning-fg" },
  error: { icon: "codicon-error", className: "text-indicator-error" },
};

/** The run identity/status data the banner displays — sourced from whichever run is currently displayed, live or historical. */
export interface RunBannerData {
  runId: number;
  startedAt: number;
  executionState: ExecutionState;
  tokenTotals?: WorkflowTokenTotals;
  /** Persisted projection from the displayed run's `_runtime.worktree`. */
  worktree?: WorktreeRunProjection;
  address?: Extract<WorkflowViewAddress, { kind: "run" }>;
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
): WorktreeOutcome | undefined {
  switch (worktree.mergeOutcome) {
    case "fast-forward":
      return { severity: "success", text: "Merged (fast-forward)" };
    case "merge-commit":
      return { severity: "success", text: "Merged (merge commit)" };
    case "conflict":
      return { severity: "warning", text: "Merge conflict — branch preserved" };
    case "blocked":
    case "abort-failed":
      return {
        severity: "error",
        text: "Auto merge blocked — source branch changed or checkout is dirty",
      };
  }
  if (worktree.directoryState === "remove-failed") {
    return {
      severity: "warning",
      text: "Worktree removal failed — branch safe, directory kept",
    };
  }
  switch (worktree.landingOutcome) {
    case "landed":
      return {
        severity: "success",
        text: `Branch ready — ${worktree.changedFileCount ?? 0} file${
          worktree.changedFileCount === 1 ? "" : "s"
        }`,
      };
    case "no-changes":
      return { severity: "success", text: "No changes" };
    case "blocked":
      return {
        severity: "warning",
        text: `Commit blocked — worktree kept at ${formatRelativeWorktreePath(
          worktree
        )}`,
      };
    default:
      return undefined;
  }
}

/**
 * Managed runs lose filesystem undo when their directory goes away, not when they
 * settle — a `keep: true` run settles with its checkout still present and stays
 * undoable. Mirrors the backend guard in `UndoRedoCoordinator`.
 */
export function isManagedWorktreeUndoUnavailable(
  worktree: WorktreeRunProjection | undefined
): boolean {
  return worktree?.mode === "managed" && worktree.directoryState !== "present";
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
  address,
  isPinned,
  onTogglePinned,
  showBackToLive,
  onBackToLive,
}) => {
  const worktreeOutcome = worktree
    ? formatWorktreeOutcome(worktree)
    : undefined;
  const [copiedBranch, setCopiedBranch] = useState(false);
  const branchName = worktree?.branchName;

  const handleCopyBranch = useCallback(async () => {
    if (!branchName) return;
    try {
      await writeClipboardText(branchName);
    } catch {
      return;
    }
    setCopiedBranch(true);
    window.setTimeout(() => setCopiedBranch(false), 1200);
  }, [branchName]);

  const hasDiffButton = Boolean(worktree?.baseCommit && branchName);
  const hasOpenButton = Boolean(
    worktree?.baseCommit && branchName && worktree.directoryState === "present"
  );
  const hasMergeButton = Boolean(
    address &&
      worktree?.baseCommit &&
      branchName &&
      worktree.mode === "managed" &&
      worktree.branchState === "present" &&
      worktree.landingOutcome === "landed"
  );
  const hasWorktreeButtons = hasDiffButton || hasOpenButton || hasMergeButton;

  return (
    <div
      className={`flex flex-col gap-1 px-3 py-1.5 text-[length:var(--fp-output-font-size-sm)] text-description-fg bg-editor-bg border-b border-widget-border flex-shrink-0 ${
        isPinned ? "sticky top-0 z-10" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate min-w-0">
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
      {worktree && (
        <div className="flex min-w-0 flex-col gap-1 rounded border border-widget-border px-2 py-1.5">
          {/* Worktree identity + merge/landing outcome — outcome wraps to its
              own row on narrow widths rather than truncating alongside it. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className="min-w-0 truncate font-semibold text-foreground"
              title={`Worktree: ${worktree.worktreePath}`}
            >
              Worktree: {formatRelativeWorktreePath(worktree)}
              {formatDirectoryState(worktree)}
            </span>
            {worktreeOutcome && (
              <span
                className={`inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap ${OUTCOME_TONE[worktreeOutcome.severity].className}`}
                title={worktreeOutcome.text}
              >
                <i
                  className={`codicon ${OUTCOME_TONE[worktreeOutcome.severity].icon} text-xs`}
                />
                {worktreeOutcome.text}
              </span>
            )}
          </div>

          {/* Branch name (what you copy for `git merge <branch>`) + actions,
              floated right as bordered buttons so two actions never read as
              one run-together label. Both sides wrap to their own row on
              narrow widths. */}
          {branchName && (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="flex min-w-0 flex-shrink items-center gap-1">
                <span className="flex-shrink-0">Branch:</span>
                <span
                  className="min-w-0 truncate font-mono"
                  title={branchName}
                >
                  {branchName}
                </span>
                <button
                  type="button"
                  onClick={handleCopyBranch}
                  title="Copy branch name"
                  aria-label="Copy branch name"
                  className="icon-btn flex-shrink-0 py-0 px-1"
                >
                  <i
                    className={`codicon ${copiedBranch ? "codicon-check" : "codicon-copy"}`}
                  />
                </button>
              </span>
              {hasWorktreeButtons && (
                <span className="flex flex-shrink-0 flex-wrap items-center gap-1">
                  {hasDiffButton && (
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
                      className={WORKTREE_BUTTON_CLASS}
                    >
                      View Diff
                    </button>
                  )}
                  {hasOpenButton && (
                    <button
                      type="button"
                      onClick={() =>
                        sendMessage(MESSAGE_TYPES.OPEN_WORKTREE, {
                          worktreePath: worktree.worktreePath,
                        })
                      }
                      title="Open the worktree in a new window"
                      aria-label="Open Worktree in New Window"
                      className={WORKTREE_BUTTON_CLASS}
                    >
                      Open Worktree
                    </button>
                  )}
                  {hasMergeButton && (
                    <button
                      type="button"
                      onClick={() =>
                        sendMessage(MESSAGE_TYPES.MERGE_WORKTREE, { address })
                      }
                      title="Merge the managed branch into the captured source checkout"
                      className={WORKTREE_BUTTON_CLASS}
                    >
                      Merge
                    </button>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
