import React, { useCallback, useMemo, useRef } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type {
  GitRefLabel,
  WorkspaceCommitLogEntry,
} from "@root/types/HostedWorkspaceViewerTypes";
import { useCommitHistoryContextMenu } from "@hooks/useCommitHistoryContextMenu";
import { useLongPress } from "@hooks/useLongPress";
import { workspaceCheckoutBranch } from "@utils/hostedApi";
import type { CommitGraphLane, CommitGraphRow } from "@utils/commitGraphLayout";
import { computeCommitGraphLayout } from "@utils/commitGraphLayout";

interface WorkspaceCommitHistoryPaneProps {
  onLoadMore: () => void;
  onRefresh: () => void;
  isMobile?: boolean;
}

/** Position of a commit relative to the current HEAD (current location). */
type HeadRelation = "ahead" | "at" | "behind";

/**
 * Branch color for a commit's graph node, mirroring a canonical git graph:
 * commits that exist only locally (unpushed) are "local", and commits shared
 * with (or only on) the remote are "remote".
 */
type GraphColor = "scm-graph-local" | "scm-graph-remote";

const ROW_HEIGHT = 24;
const GRAPH_LANE_WIDTH = 14;
const DESKTOP_INLINE_LANE_CAP = 5;
const MOBILE_INLINE_LANE_CAP = 3;

/** Tailwind text tokens provide the themed SVG currentColor values. */
const GRAPH_NODE_COLOR_CLASSES: Record<GraphColor, string> = {
  "scm-graph-local": "text-scm-graph-local",
  "scm-graph-remote": "text-scm-graph-remote",
};

/** Rotation-only lane colors; there is intentionally no ref-to-color map. */
const GRAPH_LANE_COLOR_CLASSES = [
  "text-scm-graph-local",
  "text-scm-graph-remote",
  "text-scm-graph-base",
  "text-scm-graph-local",
  "text-scm-graph-remote",
] as const;

function laneX(laneIndex: number): number {
  return (laneIndex + 1) * GRAPH_LANE_WIDTH;
}

function laneColorClass(lane: CommitGraphLane): string {
  return GRAPH_LANE_COLOR_CLASSES[
    lane.colorIndex % GRAPH_LANE_COLOR_CLASSES.length
  ];
}

function findLaneIndex(
  lanes: readonly CommitGraphLane[],
  target: CommitGraphLane,
  excluded: ReadonlySet<number>
): number {
  return lanes.findIndex(
    (lane, index) =>
      !excluded.has(index) &&
      lane.id === target.id &&
      lane.colorIndex === target.colorIndex
  );
}

function topTransitionPath(fromX: number, toX: number): string {
  if (fromX === toX) return `M ${fromX} 0 V ${ROW_HEIGHT / 2}`;
  const direction = toX > fromX ? 1 : -1;
  const radius = Math.min(Math.abs(toX - fromX), ROW_HEIGHT / 2);
  const turnX = fromX + direction * radius;
  return `M ${fromX} 0 V ${ROW_HEIGHT / 2 - radius} A ${radius} ${radius} 0 0 ${
    direction > 0 ? 1 : 0
  } ${turnX} ${ROW_HEIGHT / 2} H ${toX}`;
}

function bottomTransitionPath(fromX: number, toX: number): string {
  if (fromX === toX) return `M ${fromX} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}`;
  const direction = toX > fromX ? 1 : -1;
  const radius = Math.min(Math.abs(toX - fromX), ROW_HEIGHT / 2);
  const turnX = fromX + direction * radius;
  return `M ${fromX} ${ROW_HEIGHT / 2} A ${radius} ${radius} 0 0 ${
    direction > 0 ? 1 : 0
  } ${turnX} ${ROW_HEIGHT / 2 + radius} V ${ROW_HEIGHT} H ${toX}`;
}

function straightPath(x: number): string {
  return `M ${x} 0 V ${ROW_HEIGHT}`;
}

function lanePathClass(lane: CommitGraphLane): string {
  return `${laneColorClass(lane)} opacity-70`;
}

interface CommitGraphSvgProps {
  commit: WorkspaceCommitLogEntry;
  layout: CommitGraphRow;
  color: GraphColor;
  relation: HeadRelation;
  isSelected: boolean;
  onClick: (commit: WorkspaceCommitLogEntry) => void;
  onContextMenu: (e: React.MouseEvent, commit: WorkspaceCommitLogEntry) => void;
  onLongPressContextMenu: (
    x: number,
    y: number,
    commit: WorkspaceCommitLogEntry
  ) => void;
}

/** JSX-rendered swimlanes for one commit row. */
const CommitGraphSvg: React.FC<CommitGraphSvgProps> = ({
  commit,
  layout,
  color,
  relation,
  isSelected,
  onClick,
  onContextMenu,
  onLongPressContextMenu,
}) => {
  const ignoreNextClickRef = useRef(false);
  const longPressHandlers = useLongPress((x, y) => {
    ignoreNextClickRef.current = true;
    onLongPressContextMenu(x, y, commit);
  });
  const ahead = relation === "ahead";
  const laneCount = Math.max(
    layout.laneIndex + 1,
    layout.inputLanes.length,
    layout.outputLanes.length,
    1
  );
  const width = (laneCount + 1) * GRAPH_LANE_WIDTH;
  const nodeX = laneX(layout.laneIndex);
  const nodeY = ROW_HEIGHT / 2;
  const nodeSource =
    layout.inputLanes[layout.laneIndex] ??
    ({ id: commit.hash, colorIndex: 0 } satisfies CommitGraphLane);
  const nodeOutputIndices = new Set<number>();

  const outputIndicesForParents = commit.parentHashes.map(
    (parentHash, parentIndex) => {
      const expectedLane = {
        id: parentHash,
        colorIndex:
          (nodeSource.colorIndex + parentIndex) %
          GRAPH_LANE_COLOR_CLASSES.length,
      };
      const outputIndex = findLaneIndex(
        layout.outputLanes,
        expectedLane,
        nodeOutputIndices
      );
      if (outputIndex >= 0) nodeOutputIndices.add(outputIndex);
      return outputIndex;
    }
  );

  const usedOutputIndices = new Set(nodeOutputIndices);
  const inputPaths = layout.inputLanes.map((lane, inputIndex) => {
    const inputX = laneX(inputIndex);
    if (lane.id === commit.hash) {
      return {
        key: `incoming-node-${inputIndex}`,
        d: topTransitionPath(inputX, nodeX),
        lane,
      };
    }

    const outputIndex = findLaneIndex(
      layout.outputLanes,
      lane,
      usedOutputIndices
    );
    if (outputIndex >= 0) {
      usedOutputIndices.add(outputIndex);
      return {
        key: `incoming-${inputIndex}-${outputIndex}`,
        d: topTransitionPath(inputX, laneX(outputIndex)),
        lane,
      };
    }

    return {
      key: `incoming-terminal-${inputIndex}`,
      d: `M ${inputX} 0 V ${nodeY}`,
      lane,
    };
  });

  const outputPaths = layout.outputLanes.map((lane, outputIndex) => {
    const outputX = laneX(outputIndex);
    const nodeParentIndex = outputIndicesForParents.indexOf(outputIndex);
    return {
      key: `outgoing-${outputIndex}`,
      d:
        nodeParentIndex >= 0
          ? bottomTransitionPath(nodeX, outputX)
          : straightPath(outputX),
      lane,
    };
  });

  const nodeClass = GRAPH_NODE_COLOR_CLASSES[color];
  const rowClass = `flex flex-shrink-0 items-center justify-center h-6 transition-colors ${
    isSelected
      ? "bg-list-active-bg"
      : `hover:bg-list-hover-bg${commit.isHead ? " bg-list-active-bg/40" : ""}`
  }${ahead ? " opacity-60" : ""}`;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (ignoreNextClickRef.current) {
      ignoreNextClickRef.current = false;
      e.preventDefault();
      return;
    }
    onClick(commit);
  };

  return (
    <div
      className={rowClass}
      style={{ width, height: ROW_HEIGHT }}
      data-testid={`commit-graph-svg-${commit.hash}`}
      onClick={handleClick}
      onContextMenu={(e) => onContextMenu(e, commit)}
      {...longPressHandlers}
      aria-hidden="true"
    >
      <svg
        width={width}
        height={ROW_HEIGHT}
        viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
        aria-hidden="true"
      >
        {[...inputPaths, ...outputPaths].map(({ key, d, lane }) => (
          <path
            key={key}
            d={d}
            className={lanePathClass(lane)}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {commit.isMerge && !commit.isHead && (
          <circle
            cx={nodeX}
            cy={nodeY}
            r="6.5"
            className="text-scm-graph-base"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          />
        )}
        {commit.isHead && (
          <circle
            cx={nodeX}
            cy={nodeY}
            r="7"
            className={nodeClass}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        )}
        <circle
          cx={nodeX}
          cy={nodeY}
          r={commit.isHead ? 5 : 4.5}
          className={`${nodeClass}${ahead ? " fill-editor-bg" : " fill-current"}`}
          stroke="currentColor"
          strokeWidth={ahead ? 1.75 : 0}
        />
      </svg>
    </div>
  );
};

export const WorkspaceCommitHistoryPane: React.FC<
  WorkspaceCommitHistoryPaneProps
> = ({ onLoadMore, onRefresh, isMobile = false }) => {
  const commitHistory = useWorkspaceViewerStore((s) => s.commitHistory);
  const commitHistoryLoading = useWorkspaceViewerStore(
    (s) => s.commitHistoryLoading
  );
  const commitHistoryHasMore = useWorkspaceViewerStore(
    (s) => s.commitHistoryHasMore
  );
  // Raw ref shown in the diff pane; for a commit it is `~<hash>`. Used to mark
  // the row whose commit is currently being viewed.
  const diffRef = useWorkspaceViewerStore((s) => s.diffRef);
  const detached = useWorkspaceViewerStore((s) => s.detached);
  const currentBranch = useWorkspaceViewerStore((s) => s.currentBranch);
  const previousBranch = useWorkspaceViewerStore((s) => s.previousBranch);
  const setPreviousBranch = useWorkspaceViewerStore((s) => s.setPreviousBranch);
  const setMobileDiffVisible = useWorkspaceViewerStore(
    (s) => s.setMobileDiffVisible
  );
  const selectedRepoId = useWorkspaceViewerStore((s) => s.selectedRepoId);

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
      await workspaceCheckoutBranch({
        branch,
        repo: selectedRepoId ?? undefined,
      });
      setPreviousBranch(null);
      onRefresh();
    } catch {
      // ignore — the parent loadStatus/loadHistory will surface any error
    }
  }, [
    currentBranch,
    onRefresh,
    previousBranch,
    selectedRepoId,
    setPreviousBranch,
  ]);

  const returnBranchLabel =
    previousBranch ?? (currentBranch !== null ? currentBranch : null);

  // The checked-out commit (HEAD) anchors ahead/behind styling. Commits listed
  // above it are newer ("ahead"); below are older ("behind").
  const headIndex = commitHistory.findIndex((c) => c.isHead);
  const relationFor = (index: number): HeadRelation => {
    if (headIndex < 0 || index === headIndex) return "at";
    return index < headIndex ? "ahead" : "behind";
  };

  // If the branch has any unpushed commits, it's ahead of its remote: those
  // commits are colored "local" and the shared history they diverged from is
  // colored "remote". Otherwise (in sync) everything is "local".
  const hasUnpushed = commitHistory.some((c) => !c.pushed);
  const colorFor = (commit: WorkspaceCommitLogEntry): GraphColor =>
    hasUnpushed && commit.pushed ? "scm-graph-remote" : "scm-graph-local";
  const graphLayout = useMemo(
    () => computeCommitGraphLayout(commitHistory),
    [commitHistory]
  );
  const graphLaneCount = Math.max(
    1,
    ...graphLayout.map((row) =>
      Math.max(row.laneIndex + 1, row.inputLanes.length, row.outputLanes.length)
    )
  );
  const inlineLaneCap = isMobile
    ? MOBILE_INLINE_LANE_CAP
    : DESKTOP_INLINE_LANE_CAP;
  const graphRailWidth =
    (Math.min(graphLaneCount, inlineLaneCap) + 1) * GRAPH_LANE_WIDTH;

  return (
    <div className="flex flex-col min-h-0 select-none [-webkit-touch-callout:none]">
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
        <div className="flex min-w-0">
          <div
            className="flex-shrink-0 overflow-x-auto overflow-y-visible"
            style={{ width: graphRailWidth }}
            data-testid="commit-graph-rail"
          >
            <div className="min-w-0">
              {commitHistory.map((commit, index) => (
                <CommitGraphSvg
                  key={commit.hash}
                  commit={commit}
                  layout={graphLayout[index]}
                  relation={relationFor(index)}
                  color={colorFor(commit)}
                  isSelected={diffRef === `~${commit.hash}`}
                  onClick={handleRowClick}
                  onContextMenu={handleRowContextMenu}
                  onLongPressContextMenu={handleRowLongPressContextMenu}
                />
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-0 overflow-hidden">
            {commitHistory.map((commit) => (
              <CommitRow
                key={commit.hash}
                commit={commit}
                isSelected={diffRef === `~${commit.hash}`}
                onClick={handleRowClick}
                onContextMenu={handleRowContextMenu}
                onLongPressContextMenu={handleRowLongPressContextMenu}
              />
            ))}
          </div>
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

interface RefPillProps {
  label: GitRefLabel;
  /** Render only the icon, with no branch-name text (used when a remote ref
   *  is on the same commit as its in-sync local branch — the cloud icon
   *  alone conveys "also pushed here"). */
  iconOnly?: boolean;
}

const RefPill: React.FC<RefPillProps> = ({ label, iconOnly }) => {
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
      {!iconOnly && label.name}
    </span>
  );
};

interface CommitRowProps {
  commit: WorkspaceCommitLogEntry;
  /** This commit is the one currently shown in the diff pane. */
  isSelected: boolean;
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
  isSelected,
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
      className={`fp-list-row flex items-center gap-2 px-2 text-left transition-colors w-full min-w-0 h-6 overflow-hidden ${
        isSelected
          ? "fp-list-row-selected bg-list-active-bg"
          : `hover:bg-list-hover-bg${commit.isHead ? " bg-list-active-bg/40" : ""}`
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
      style={{ height: ROW_HEIGHT }}
      title={`${commit.hash}\n${commit.subject}\n${commit.author} · ${commit.relativeDate}${
        commit.pushed ? "" : "\nNot yet pushed"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-xs text-editor-fg">
        {commit.subject}
      </span>
      {commit.refs.length > 0 && (
        <span className="flex items-center gap-1 flex-shrink-0">
          {commit.refs.map((ref) => (
            <RefPill
              key={`${ref.type}:${ref.name}`}
              label={ref}
              iconOnly={
                ref.type === "remoteBranch" &&
                commit.refs.some((r) => r.type === "localBranch")
              }
            />
          ))}
        </span>
      )}
    </button>
  );
};
