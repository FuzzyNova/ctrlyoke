import React, { useCallback, useState } from "react";
import { ExecutionStateBadge } from "@components/shared/ExecutionStateBadge";
import {
  MESSAGE_TYPES,
  WORKTREE_BRANCH_STATES,
  WORKTREE_DIRECTORY_STATES,
  WORKTREE_LANDING_OUTCOMES,
  WORKTREE_MODES,
  DASHBOARD_HOST_CAPABILITIES,
} from "@root/types/DashboardConstants";
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
  WorkflowStopReason,
  WorkspaceWorktreeOwnership,
} from "@root/types/CtrlYokeTypes";
import {
  formatRelativeWorktreePath,
  formatWorktreeOutcome,
  type WorktreeOutcomeSeverity,
} from "@root/utils/formatWorktreeOutcome";
import { sendMessage } from "@hooks/useMessageHandler";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { Icon } from "../shared/Icon";

/** Bordered pill styling shared by the worktree row's action buttons, so two adjacent buttons never read as one run-together label. */
const WORKTREE_BUTTON_CLASS =
  "rounded-sm border border-widget-border px-1.5 py-0.5 text-xs leading-none text-link-fg hover:bg-list-hover-bg focus:outline-hidden whitespace-nowrap";

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
  stopReason?: WorkflowStopReason;
  tokenTotals?: WorkflowTokenTotals;
  /** Persisted projection from the displayed run's `_runtime.worktree`. */
  worktree?: WorktreeRunProjection;
  address?: Extract<WorkflowViewAddress, { kind: "run" }>;
}

/**
 * Managed runs lose filesystem undo when their directory goes away, not when they
 * settle — a `keep: true` run settles with its checkout still present and stays
 * undoable. Mirrors the backend guard in `UndoRedoCoordinator`.
 */
export function isManagedWorktreeUndoUnavailable(
  worktree: WorktreeRunProjection | undefined
): boolean {
  return (
    worktree?.mode === WORKTREE_MODES.MANAGED &&
    worktree.directoryState !== WORKTREE_DIRECTORY_STATES.PRESENT
  );
}

function formatDirectoryState(worktree: WorktreeRunProjection): string {
  switch (worktree.directoryState) {
    case WORKTREE_DIRECTORY_STATES.REMOVED:
      return " (removed)";
    case WORKTREE_DIRECTORY_STATES.MISSING:
      return " (missing)";
    case WORKTREE_DIRECTORY_STATES.REMOVE_FAILED:
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
  /** Root element, measured by the pane to offset sticky content below it. */
  containerRef?: React.Ref<HTMLDivElement>;
}

export const WorkspaceWorktreeOwnershipBanner: React.FC<{
  ownership: WorkspaceWorktreeOwnership;
}> = ({ ownership }) => (
  <div className="flex items-center gap-1 px-3 py-1.5 text-(length:--cy-output-font-size-sm) text-description-fg bg-editor-bg border-b border-widget-border">
    <Icon name="worktree-compact" />
    <span>
      This is branch <code className="font-mono">{ownership.branchName}</code>,
      owned by <code className="font-mono">{ownership.sourceCheckoutRoot}</code>
    </span>
  </div>
);

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
  stopReason,
  tokenTotals,
  worktree,
  address,
  isPinned,
  onTogglePinned,
  showBackToLive,
  onBackToLive,
  containerRef,
}) => {
  const worktreeOutcome = worktree
    ? formatWorktreeOutcome(worktree)
    : undefined;
  const [copiedBranch, setCopiedBranch] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const canOpenWorktree = useUiStore((state) =>
    state.hostCapabilities.includes(
      DASHBOARD_HOST_CAPABILITIES.openFolderWindow
    )
  );
  const canOpenGitDiff = useUiStore((state) =>
    state.hostCapabilities.includes(DASHBOARD_HOST_CAPABILITIES.openGitDiff)
  );
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

  const handleCopyPath = useCallback(async () => {
    if (!worktree?.worktreePath) return;
    try {
      await writeClipboardText(worktree.worktreePath);
    } catch {
      return;
    }
    setCopiedPath(true);
    window.setTimeout(() => setCopiedPath(false), 1200);
  }, [worktree?.worktreePath]);

  const hasDiffButton = Boolean(worktree?.baseCommit && branchName);
  const hasOpenButton = Boolean(
    canOpenWorktree &&
    worktree?.baseCommit &&
    branchName &&
    worktree.directoryState === WORKTREE_DIRECTORY_STATES.PRESENT
  );
  const hasMergeButton = Boolean(
    address &&
    worktree?.baseCommit &&
    branchName &&
    worktree.mode === WORKTREE_MODES.MANAGED &&
    worktree.branchState === WORKTREE_BRANCH_STATES.PRESENT &&
    worktree.landingOutcome === WORKTREE_LANDING_OUTCOMES.LANDED
  );
  const hasWorktreeButtons =
    hasDiffButton || hasOpenButton || hasMergeButton || !canOpenWorktree;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col gap-1 px-3 py-1.5 text-(length:--cy-output-font-size-sm) text-description-fg bg-editor-bg border-b border-widget-border shrink-0 ${
        isPinned ? "sticky top-0 z-header" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate min-w-0" data-testid="run-id-banner">
            Run {runId} &middot; {new Date(startedAt).toLocaleString()}
          </span>
          <ExecutionStateBadge
            state={executionState}
            labelOverride={stopReason ? "Limit stop" : undefined}
            titleOverride={stopReason?.message}
          />
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {hasWorkflowTokenUsage(tokenTotals) && (
            <WorkflowTokenUsage totals={tokenTotals} />
          )}
          {showBackToLive && onBackToLive && (
            <button
              type="button"
              onClick={onBackToLive}
              className="text-link-fg hover:underline focus:outline-hidden"
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
            <Icon name={isPinned ? "codicon-pinned" : "codicon-pin"} />
          </button>
        </span>
      </div>
      {stopReason && (
        <div
          className="text-warning-fg"
          data-testid="run-stop-reason"
          role="status"
        >
          {stopReason.message}
        </div>
      )}
      {worktree && (
        <div className="flex min-w-0 flex-col gap-1 rounded-sm border border-widget-border px-2 py-1.5">
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
                className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap ${OUTCOME_TONE[worktreeOutcome.severity].className}`}
                title={worktreeOutcome.text}
              >
                <Icon
                  name={OUTCOME_TONE[worktreeOutcome.severity].icon}
                  className="text-xs"
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
              <span className="flex min-w-0 shrink items-center gap-1">
                <span className="shrink-0">Branch:</span>
                <span className="min-w-0 truncate font-mono" title={branchName}>
                  {branchName}
                </span>
                <button
                  type="button"
                  onClick={handleCopyBranch}
                  title="Copy branch name"
                  aria-label="Copy branch name"
                  className="icon-btn shrink-0 py-0 px-1"
                >
                  <Icon
                    name={copiedBranch ? "codicon-check" : "codicon-copy"}
                  />
                </button>
              </span>
              {hasWorktreeButtons && (
                <span className="flex shrink-0 flex-wrap items-center gap-1">
                  {!canOpenWorktree && worktree.worktreePath && (
                    <button
                      type="button"
                      onClick={handleCopyPath}
                      title="Copy worktree path"
                      aria-label="Copy worktree path"
                      className={WORKTREE_BUTTON_CLASS}
                    >
                      <Icon
                        name={copiedPath ? "codicon-check" : "codicon-copy"}
                      />
                      {copiedPath ? "Copied" : "Copy path"}
                    </button>
                  )}
                  {hasDiffButton && (
                    <button
                      type="button"
                      onClick={() => {
                        const baseCommit = worktree.baseCommit;
                        if (!baseCommit) return;
                        if (!canOpenGitDiff) {
                          void useWorkspaceViewerStore
                            .getState()
                            .openToWorktreeDiff(
                              worktree.sourceCheckoutRoot,
                              baseCommit,
                              worktree.branchName
                            );
                        } else {
                          sendMessage(MESSAGE_TYPES.VIEW_WORKTREE_DIFF, {
                            sourceCheckoutRoot: worktree.sourceCheckoutRoot,
                            baseCommit,
                            branchName: worktree.branchName,
                          });
                        }
                      }}
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
