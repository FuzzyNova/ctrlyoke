import React, { useCallback, useRef } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type {
  GitRefLabel,
  WorkspaceCommitLogEntry,
} from "@root/types/HostedWorkspaceViewerTypes";
import { useCommitHistoryContextMenu } from "@hooks/useCommitHistoryContextMenu";
import { useLongPress } from "@hooks/useLongPress";
import { workspaceCheckoutBranch } from "@utils/hostedApi";

interface WorkspaceCommitHistoryPaneProps {
  onLoadMore: () => void;
  onRefresh: () => void;
}

/** Position of a commit relative to the current HEAD (current location). */
type HeadRelation = "ahead" | "at" | "behind";

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
  const setMobileDiffVisible = useWorkspaceViewerStore(
    (s) => s.setMobileDiffVisible
  );

  const { openContextMenu, commitHistoryContextMenuPortal } =
    useCommitHistoryContextMenu({ onRefresh });

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent, commit: WorkspaceCommitLogEntry) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, commit);
    },
    [openContextMenu]
  );

  const handleRowLongPressContextMenu = useCallback(
    (x: number, y: number, commit: WorkspaceCommitLogEntry) => {
      openContextMenu(x, y, commit);
    },
    [openContextMenu]
  );

  const handleRowClick = useCallback(
    (commit: WorkspaceCommitLogEntry) => {
      void useWorkspaceViewerStore.getState().openToGitRef(`~${commit.hash}`);
      setMobileDiffVisible(true);
    },
    [setMobileDiffVisible]
  );

  const handleReturnToBranch = useCallback(async () => {
    const branch = previousBranch ?? currentBranch;
    if (!branch) return;
    try {
      await workspaceCheckoutBranch({ branch });
      setPreviousBranch(null);
      onRefresh();
    } catch {
      // ignore — the parent loadStatus/loadHistory will surface any error
    }
  }, [currentBranch, onRefresh, previousBranch, setPreviousBranch]);

  const returnBranchLabel =
    previousBranch ?? (currentBranch !== null ? currentBranch : null);

  // The checked-out commit (HEAD) anchors ahead/behind styling. Commits listed
  // above it are newer ("ahead"); below are older ("behind").
  const headIndex = commitHistory.findIndex((c) => c.isHead);
  const relationFor = (index: number): HeadRelation => {
    if (headIndex < 0 || index === headIndex) return "at";
    return index < headIndex ? "ahead" : "behind";
  };

  return (
    <div className="flex flex-col min-h-0">
      {/* Section header */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold uppercase text-editor-fg opacity-60">
            History
          </span>
          {currentBranch ? (
            <span
              className="flex items-center gap-1 min-w-0 text-xs text-scm-graph-local"
              title={`Current branch: ${currentBranch}`}
            >
              <i className="codicon codicon-git-branch text-xs flex-shrink-0" />
              <span className="truncate">{currentBranch}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <i className="codicon codicon-git-commit text-xs flex-shrink-0" />
              detached
            </span>
          )}
        </div>
        <button
          onClick={onRefresh}
          className="codicon codicon-refresh text-xs text-editor-fg opacity-60 hover:opacity-100 transition-opacity flex-shrink-0"
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
          {commitHistory.map((commit, index) => (
            <CommitRow
              key={commit.hash}
              commit={commit}
              relation={relationFor(index)}
              isFirst={index === 0}
              isLast={index === commitHistory.length - 1}
              onClick={handleRowClick}
              onContextMenu={handleRowContextMenu}
              onLongPressContextMenu={handleRowLongPressContextMenu}
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

interface CommitGraphGutterProps {
  relation: HeadRelation;
  isHead: boolean;
  isMerge: boolean;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Single-lane git-graph gutter: a vertical connector line with one node per
 * commit. The HEAD node is highlighted as the current location; "ahead"
 * commits (newer than HEAD) are dimmed/hollow; merge commits get a base-color
 * ring. This intentionally does not render parallel branch lanes.
 */
const CommitGraphGutter: React.FC<CommitGraphGutterProps> = ({
  relation,
  isHead,
  isMerge,
  isFirst,
  isLast,
}) => {
  const ahead = relation === "ahead";

  // Node styling by relation; HEAD wins as the highlighted current location.
  let nodeClass: string;
  if (isHead) {
    nodeClass =
      "w-3 h-3 bg-scm-graph-local ring-2 ring-scm-graph-local/40 ring-offset-0";
  } else if (ahead) {
    nodeClass = "w-2.5 h-2.5 border-2 border-scm-graph-local bg-editor-bg";
  } else {
    nodeClass = "w-2.5 h-2.5 bg-scm-graph-local";
  }
  const mergeRing = isMerge && !isHead ? " ring-1 ring-scm-graph-base" : "";

  return (
    <span
      className={`relative flex-shrink-0 w-5 self-stretch flex items-center justify-center ${
        ahead ? "opacity-60" : ""
      }`}
      aria-hidden="true"
    >
      {/* top connector (toward newer commit) */}
      {!isFirst && (
        <span className="absolute top-0 left-1/2 -translate-x-1/2 h-1/2 w-px bg-scm-graph-local/30" />
      )}
      {/* bottom connector (toward older commit) */}
      {!isLast && (
        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 h-1/2 w-px bg-scm-graph-local/30" />
      )}
      <span className={`relative rounded-full ${nodeClass}${mergeRing}`} />
    </span>
  );
};

interface RefPillProps {
  label: GitRefLabel;
}

const RefPill: React.FC<RefPillProps> = ({ label }) => {
  const colorClass =
    label.type === "remoteBranch"
      ? "border-scm-graph-remote text-scm-graph-remote"
      : label.type === "tag"
        ? "border-scm-graph-base text-scm-graph-base"
        : "border-scm-graph-local text-scm-graph-local";
  const icon =
    label.type === "remoteBranch"
      ? "codicon-cloud"
      : label.type === "tag"
        ? "codicon-tag"
        : label.type === "head"
          ? "codicon-target"
          : "codicon-git-branch";
  return (
    <span
      className={`flex items-center gap-0.5 px-1 py-px rounded border text-xxs leading-none whitespace-nowrap ${colorClass}`}
      title={label.name}
    >
      <i className={`codicon ${icon} text-xxs`} />
      {label.name}
    </span>
  );
};

interface CommitRowProps {
  commit: WorkspaceCommitLogEntry;
  relation: HeadRelation;
  isFirst: boolean;
  isLast: boolean;
  onClick: (commit: WorkspaceCommitLogEntry) => void;
  onContextMenu: (e: React.MouseEvent, commit: WorkspaceCommitLogEntry) => void;
  onLongPressContextMenu: (
    x: number,
    y: number,
    commit: WorkspaceCommitLogEntry
  ) => void;
}

const CommitRow: React.FC<CommitRowProps> = ({
  commit,
  relation,
  isFirst,
  isLast,
  onClick,
  onContextMenu,
  onLongPressContextMenu,
}) => {
  const ignoreNextClickRef = useRef(false);
  const longPressHandlers = useLongPress((x, y) => {
    ignoreNextClickRef.current = true;
    onLongPressContextMenu(x, y, commit);
  });

  return (
    <button
      className={`flex items-center gap-2 px-2 py-1 text-left hover:bg-list-hover-bg transition-colors w-full min-w-0 ${
        commit.isHead ? "bg-list-active-bg/40" : ""
      }`}
      onClick={(e) => {
        if (ignoreNextClickRef.current) {
          ignoreNextClickRef.current = false;
          e.preventDefault();
          return;
        }
        onClick(commit);
      }}
      onContextMenu={(e) => onContextMenu(e, commit)}
      {...longPressHandlers}
      title={`${commit.hash}\n${commit.subject}\n${commit.author} · ${commit.relativeDate}`}
    >
      <CommitGraphGutter
        relation={relation}
        isHead={commit.isHead}
        isMerge={commit.isMerge}
        isFirst={isFirst}
        isLast={isLast}
      />
      <span className="font-mono text-xs text-editor-fg opacity-50 flex-shrink-0 w-12 truncate">
        {commit.shortHash}
      </span>
      {commit.refs.length > 0 && (
        <span className="flex items-center gap-1 flex-shrink-0">
          {commit.refs.map((ref) => (
            <RefPill key={`${ref.type}:${ref.name}`} label={ref} />
          ))}
        </span>
      )}
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
