import React, { useCallback } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type { WorkspaceCommitLogEntry } from "@root/types/HostedWorkspaceViewerTypes";
import { useCommitHistoryContextMenu } from "@hooks/useCommitHistoryContextMenu";

interface WorkspaceCommitHistoryPaneProps {
  onLoadMore: () => void;
  onRefresh: () => void;
}

export const WorkspaceCommitHistoryPane: React.FC<
  WorkspaceCommitHistoryPaneProps
> = ({ onLoadMore, onRefresh }) => {
  const commitHistory = useWorkspaceViewerStore((s) => s.commitHistory);
  const commitHistoryLoading = useWorkspaceViewerStore(
    (s) => s.commitHistoryLoading
  );
  const commitHistoryHasMore = useWorkspaceViewerStore(
    (s) => s.commitHistoryHasMore
  );
  const detached = useWorkspaceViewerStore((s) => s.detached);
  const currentBranch = useWorkspaceViewerStore((s) => s.currentBranch);
  const previousBranch = useWorkspaceViewerStore((s) => s.previousBranch);
  const setPreviousBranch = useWorkspaceViewerStore((s) => s.setPreviousBranch);

  const { openContextMenu, commitHistoryContextMenuPortal } =
    useCommitHistoryContextMenu({ onRefresh });

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent, commit: WorkspaceCommitLogEntry) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, commit);
    },
    [openContextMenu]
  );

  const handleRowClick = useCallback(
    (commit: WorkspaceCommitLogEntry) => {
      void useWorkspaceViewerStore.getState().openToGitRef(`~${commit.hash}`);
    },
    []
  );

  const handleReturnToBranch = useCallback(async () => {
    const branch = previousBranch ?? currentBranch;
    if (!branch) return;
    try {
      const { workspaceCheckoutBranch } = await import("@utils/hostedApi");
      await workspaceCheckoutBranch({ branch });
      setPreviousBranch(null);
      onRefresh();
    } catch {
      // ignore — the parent loadStatus/loadHistory will surface any error
    }
  }, [currentBranch, onRefresh, previousBranch, setPreviousBranch]);

  const returnBranchLabel = previousBranch ?? (currentBranch !== null ? currentBranch : null);

  return (
    <div className="flex flex-col min-h-0">
      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-1.5 flex-shrink-0">
        <span className="text-xs font-semibold uppercase text-editor-fg opacity-60">
          History
        </span>
        <button
          onClick={onRefresh}
          className="codicon codicon-refresh text-xs text-editor-fg opacity-60 hover:opacity-100 transition-opacity"
          title="Refresh commit history"
          aria-label="Refresh commit history"
        />
      </div>

      {/* Detached HEAD banner */}
      {detached && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-yellow-500/10 border-y border-yellow-500/20 flex-shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <i className="codicon codicon-warning text-xs text-yellow-400 flex-shrink-0" />
            <span className="text-xs text-editor-fg truncate">
              Detached HEAD
            </span>
          </div>
          {returnBranchLabel && (
            <button
              onClick={() => void handleReturnToBranch()}
              className="flex-shrink-0 text-xs text-btn-fg hover:underline whitespace-nowrap"
              title={`Return to branch ${returnBranchLabel}`}
            >
              Return to {returnBranchLabel}
            </button>
          )}
        </div>
      )}

      {/* Commit rows */}
      {commitHistory.length === 0 && !commitHistoryLoading ? (
        <p className="px-3 pb-2 pt-1 text-xs text-editor-fg opacity-40 select-none">
          No commits yet
        </p>
      ) : (
        <div className="flex flex-col">
          {commitHistory.map((commit) => (
            <CommitRow
              key={commit.hash}
              commit={commit}
              onClick={handleRowClick}
              onContextMenu={handleRowContextMenu}
            />
          ))}
        </div>
      )}

      {/* Load more / spinner */}
      {commitHistoryLoading && (
        <div className="flex items-center gap-2 px-3 py-2 text-editor-fg opacity-50">
          <i className="codicon codicon-loading animate-spin text-xs" />
          <span className="text-xs">Loading…</span>
        </div>
      )}
      {!commitHistoryLoading && commitHistoryHasMore && (
        <button
          onClick={onLoadMore}
          className="mx-3 mt-1 mb-2 px-2 py-1 text-xs text-btn-fg hover:underline text-left"
        >
          Load more…
        </button>
      )}

      {commitHistoryContextMenuPortal}
    </div>
  );
};

interface CommitRowProps {
  commit: WorkspaceCommitLogEntry;
  onClick: (commit: WorkspaceCommitLogEntry) => void;
  onContextMenu: (e: React.MouseEvent, commit: WorkspaceCommitLogEntry) => void;
}

const CommitRow: React.FC<CommitRowProps> = ({
  commit,
  onClick,
  onContextMenu,
}) => {
  return (
    <button
      className={`flex items-center gap-2 px-2 py-1 text-left hover:bg-list-hover-bg transition-colors w-full min-w-0 ${
        commit.isHead ? "bg-list-active-bg/40" : ""
      }`}
      onClick={() => onClick(commit)}
      onContextMenu={(e) => onContextMenu(e, commit)}
      title={`${commit.hash}\n${commit.subject}\n${commit.author} · ${commit.relativeDate}`}
    >
      <span className="font-mono text-xs text-editor-fg opacity-50 flex-shrink-0 w-12 truncate">
        {commit.shortHash}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-editor-fg">
        {commit.subject}
      </span>
      <span className="flex-shrink-0 text-xs text-editor-fg opacity-40">
        {commit.relativeDate}
      </span>
      {!commit.pushed && (
        <span
          className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-yellow-400 opacity-80"
          title="Not yet pushed"
        />
      )}
    </button>
  );
};
