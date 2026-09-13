import React, { useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type {
  GitRefLabel,
  WorkspaceCommitLogEntry,
} from "@root/types/HostedWorkspaceViewerTypes";
import { useCommitHistoryContextMenu } from "@hooks/useCommitHistoryContextMenu";
import { useLongPress } from "@hooks/useLongPress";
import { useElementTier } from "@hooks/useElementNarrow";
import {
  usePagedCommitHistory,
  type PagedCommitHistoryController,
  type PagedCommitHistoryFetcher,
} from "@hooks/usePagedCommitHistory";
import {
  useVirtualizedListFoundation,
  type VirtualizedListRange,
} from "@components/shared/VirtualizedListFoundation";
import { workspaceCheckoutBranch } from "@utils/hostedApi";
import type { CommitGraphLane, CommitGraphRow } from "@utils/commitGraphLayout";
import {
  computeCommitGraphLayout,
  TRUNK_COLOR_INDEX,
} from "@utils/commitGraphLayout";
import {
  GIT_HEAD_RELATIONS,
  GIT_REF_LABEL_TYPES,
} from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

export interface WorkspaceCommitHistoryPaneProps {
  onRefresh: () => void;
  isMobile?: boolean;
  pageSize?: number;
  fetchPage?: PagedCommitHistoryFetcher;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** Primarily useful to host the pane in a focused test or alternate view. */
  controller?: PagedCommitHistoryController;
}

type HeadRelation =
  (typeof GIT_HEAD_RELATIONS)[keyof typeof GIT_HEAD_RELATIONS];

const ROW_HEIGHT = 24;
const GRAPH_LANE_WIDTH = 14;
const DESKTOP_INLINE_LANE_CAP = 5;
const MOBILE_INLINE_LANE_CAP = 3;
const GRAPH_OVERSCAN = 12;
/** How much of the pane's measured width the graph column may claim before it scrolls. */
const GRAPH_RAIL_MAX_PARENT_FRACTION = 0.5;

/**
 * Buckets a measured width to the nearest lane-width increment so
 * `useElementTier` only re-renders when the cap would actually shift by a
 * visible amount, not on every sub-pixel ResizeObserver tick.
 */
function resolveContainerWidthBucket(width: number): number {
  return Math.max(0, Math.floor(width / GRAPH_LANE_WIDTH)) * GRAPH_LANE_WIDTH;
}

const TRUNK_COLOR_CLASSES = {
  local: "text-scm-graph-local",
  remote: "text-scm-graph-remote",
} as const;

const GRAPH_BRANCH_COLOR_CLASSES = [
  "text-scm-graph-fg1",
  "text-scm-graph-fg2",
  "text-scm-graph-fg3",
  "text-scm-graph-fg4",
  "text-scm-graph-fg5",
] as const;

function laneX(laneIndex: number): number {
  return (laneIndex + 1) * GRAPH_LANE_WIDTH;
}

function resolveLaneColorClass(
  lane: CommitGraphLane,
  trunkColorClass: string
): string {
  if (lane.colorIndex === TRUNK_COLOR_INDEX) return trunkColorClass;
  return GRAPH_BRANCH_COLOR_CLASSES[
    (lane.colorIndex - 1) % GRAPH_BRANCH_COLOR_CLASSES.length
  ];
}

function topTransitionPath(fromX: number, toX: number): string {
  if (fromX === toX) return `M ${fromX} 0 V ${ROW_HEIGHT / 2}`;
  const direction = toX > fromX ? 1 : -1;
  const radius = Math.min(Math.abs(toX - fromX), ROW_HEIGHT / 2);
  const turnX = fromX + direction * radius;
  const sweep = direction > 0 ? 0 : 1;
  return `M ${fromX} 0 V ${ROW_HEIGHT / 2 - radius} A ${radius} ${radius} 0 0 ${sweep} ${turnX} ${ROW_HEIGHT / 2} H ${toX}`;
}

function bottomTransitionPath(fromX: number, toX: number): string {
  if (fromX === toX) return `M ${fromX} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}`;
  const direction = toX > fromX ? 1 : -1;
  const radius = Math.min(Math.abs(toX - fromX), ROW_HEIGHT / 2);
  const turnX = toX - direction * radius;
  const sweep = direction > 0 ? 1 : 0;
  return `M ${fromX} ${ROW_HEIGHT / 2} H ${turnX} A ${radius} ${radius} 0 0 ${sweep} ${toX} ${ROW_HEIGHT}`;
}

function straightBottomHalfPath(x: number): string {
  return `M ${x} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}`;
}

function lanePathClass(lane: CommitGraphLane, trunkColorClass: string): string {
  return `${resolveLaneColorClass(lane, trunkColorClass)} opacity-70`;
}

interface CommitGraphRowSvgProps {
  commit: WorkspaceCommitLogEntry;
  layout: CommitGraphRow;
  trunkColorClass: string;
  relation: HeadRelation;
  isSelected: boolean;
  rowTop: number;
}

/** Draws a realized row inside the pane's single tall SVG surface. */
const CommitGraphRowSvg: React.FC<CommitGraphRowSvgProps> = ({
  commit,
  layout,
  trunkColorClass,
  relation,
  isSelected,
  rowTop,
}) => {
  const circleIndex = layout.laneIndex;
  const nodeX = laneX(circleIndex);
  const nodeY = ROW_HEIGHT / 2;
  const nodeSource =
    layout.inputLanes[circleIndex] ??
    ({
      id: commit.hash,
      colorIndex: TRUNK_COLOR_INDEX,
    } satisfies CommitGraphLane);

  // Ports VS Code's `renderSCMHistoryItemGraph` (scmHistory.ts) matching
  // strategy: walk input lanes in order against a single
  // monotonically-increasing output pointer, instead of searching
  // `outputLanes` by id/color. `computeCommitGraphLayout` always builds
  // `outputLanes` by iterating `inputLanes` in that same relative order, so
  // positional matching is both sufficient and correct on its own — a
  // search can latch onto a same-id lane sitting at the wrong position
  // (e.g. a second, still-waiting duplicate of this exact lane), drawing a
  // curve out to that stale slot that only gets resolved — and visually
  // "loops back" — several rows later when the real match is found.
  let outputPointer = 0;
  const inputPaths = layout.inputLanes.map((lane, inputIndex) => {
    const inputX = laneX(inputIndex);
    if (lane.id === commit.hash) {
      if (inputIndex === circleIndex) outputPointer += 1;
      return {
        key: `incoming-node-${inputIndex}`,
        d: topTransitionPath(inputX, nodeX),
        lane,
      };
    }
    if (
      outputPointer < layout.outputLanes.length &&
      layout.outputLanes[outputPointer].id === lane.id
    ) {
      const outputIndex = outputPointer;
      outputPointer += 1;
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

  // Locate each parent's own output lane for the outgoing (bottom-half)
  // curves. The first parent always inherits the current commit's own
  // column — `computeCommitGraphLayout` writes it in-place at
  // `circleIndex` — so it needs no search (and a search could wrongly
  // match an unrelated lane waiting on that same commit). Every other
  // parent is appended after all pass-through lanes, so it is always the
  // *last* lane in `outputLanes` with that id (matches VS Code's
  // `findLastIndex` in the same function).
  const nodeOutputIndices = new Set<number>();
  const outputIndicesForParents = commit.parentHashes.map(
    (parentHash, parentIndex) => {
      if (parentIndex === 0) {
        if (
          circleIndex < layout.outputLanes.length &&
          layout.outputLanes[circleIndex].id === parentHash
        ) {
          nodeOutputIndices.add(circleIndex);
          return circleIndex;
        }
        return -1;
      }
      for (let index = layout.outputLanes.length - 1; index >= 0; index--) {
        if (
          !nodeOutputIndices.has(index) &&
          layout.outputLanes[index].id === parentHash
        ) {
          nodeOutputIndices.add(index);
          return index;
        }
      }
      return -1;
    }
  );

  // Every output lane's top half (0 to nodeY) was already drawn above, either
  // as part of `inputPaths` (a continuing lane) or not at all (a lane born at
  // this node has nothing above it). Drawing a full-height line here as well
  // double-strokes that top half — the double-drawn segment reads as thicker
  // than the single-drawn segment below it (a "checkered" line), and a lane
  // that shifted columns gets a straight stub poking out of the curve that
  // actually carries it there (a "spur"). So only ever draw the bottom half.
  const outputPaths = layout.outputLanes.map((lane, outputIndex) => {
    const outputX = laneX(outputIndex);
    const nodeParentIndex = outputIndicesForParents.indexOf(outputIndex);
    return {
      key: `outgoing-${outputIndex}`,
      d:
        nodeParentIndex >= 0
          ? bottomTransitionPath(nodeX, outputX)
          : straightBottomHalfPath(outputX),
      lane,
    };
  });
  const ahead = relation === GIT_HEAD_RELATIONS.AHEAD;
  const rowClass = `transition-colors ${
    isSelected
      ? "bg-list-active-bg"
      : `hover:bg-list-hover-bg${commit.isHead ? " bg-list-active-bg/40" : ""}`
  }${ahead ? " opacity-60" : ""}`;
  const nodeClass = resolveLaneColorClass(nodeSource, trunkColorClass);

  return (
    <g
      className={rowClass}
      data-testid={`commit-graph-svg-${commit.hash}`}
      transform={`translate(0 ${rowTop})`}
      aria-hidden="true"
    >
      {[...inputPaths, ...outputPaths].map(({ key, d, lane }) => (
        <path
          key={key}
          d={d}
          className={lanePathClass(lane, trunkColorClass)}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {commit.isMerge && !commit.isHead && (
        <circle
          cx={nodeX}
          cy={nodeY}
          r="6.5"
          className={nodeClass}
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
    </g>
  );
};

interface CommitGraphHitAreaProps {
  commit: WorkspaceCommitLogEntry;
  graphWidth: number;
  branchTooltip: string | undefined;
  relation: HeadRelation;
  isSelected: boolean;
  rowTop: number;
  onClick: (commit: WorkspaceCommitLogEntry) => void;
  onContextMenu: (e: React.MouseEvent, commit: WorkspaceCommitLogEntry) => void;
  onLongPressContextMenu: (
    x: number,
    y: number,
    commit: WorkspaceCommitLogEntry
  ) => void;
}

const CommitGraphHitArea: React.FC<CommitGraphHitAreaProps> = ({
  commit,
  graphWidth,
  branchTooltip,
  relation,
  isSelected,
  rowTop,
  onClick,
  onContextMenu,
  onLongPressContextMenu,
}) => {
  const ignoreNextClickRef = useRef(false);
  const longPressHandlers = useLongPress((x, y) => {
    ignoreNextClickRef.current = true;
    onLongPressContextMenu(x, y, commit);
  });
  const rowClass = `flex items-center justify-center h-6 transition-colors ${
    isSelected
      ? "bg-list-active-bg"
      : `hover:bg-list-hover-bg${commit.isHead ? " bg-list-active-bg/40" : ""}`
  }${relation === GIT_HEAD_RELATIONS.AHEAD ? " opacity-60" : ""}`;

  return (
    <div
      className={rowClass}
      style={{
        width: graphWidth,
        height: ROW_HEIGHT,
        top: rowTop,
        left: 0,
        position: "absolute",
      }}
      title={branchTooltip}
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
      aria-hidden="true"
    />
  );
};

interface RowPresentation {
  trunkColorClass: string;
  nodeColorClass: string;
  branchTooltip: string | undefined;
}

interface CommitHistoryVirtualizedRowsProps {
  controller: PagedCommitHistoryController;
  commits: readonly WorkspaceCommitLogEntry[];
  graphLayout: readonly CommitGraphRow[];
  rowPresentation: readonly RowPresentation[];
  diffRef: string | null;
  graphRailWidth: number;
  graphContentWidth: number;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onRangeChange: (range: VirtualizedListRange) => void;
  onClick: (commit: WorkspaceCommitLogEntry) => void;
  onContextMenu: (e: React.MouseEvent, commit: WorkspaceCommitLogEntry) => void;
  onLongPressContextMenu: (
    x: number,
    y: number,
    commit: WorkspaceCommitLogEntry
  ) => void;
}

const CommitHistoryVirtualizedRows: React.FC<
  CommitHistoryVirtualizedRowsProps
> = ({
  controller,
  commits,
  graphLayout,
  rowPresentation,
  diffRef,
  graphRailWidth,
  graphContentWidth,
  scrollContainerRef,
  onRangeChange,
  onClick,
  onContextMenu,
  onLongPressContextMenu,
}) => {
  const getCommit = useCallback(
    (index: number): WorkspaceCommitLogEntry | undefined => commits[index],
    [commits]
  );
  const getItemKey = useCallback(
    (index: number): string =>
      getCommit(index)?.hash ?? `commit-history-placeholder-${index}`,
    [getCommit]
  );
  const { rowVirtualizer } = useVirtualizedListFoundation({
    count: controller.totalCount,
    scrollContainerRef,
    estimateSize: () => ROW_HEIGHT,
    overscan: GRAPH_OVERSCAN,
    layoutResetKey: `${controller.listingId ?? "pending"}:${controller.pageSize}`,
    rangeNotificationKey: controller.listingId ?? "commit-history-pending",
    onRangeChange,
    getItemKey,
  });
  const measuredVirtualItems = rowVirtualizer.getVirtualItems();
  // A parent-owned scroll element can be unresolved for the first render
  // (notably in jsdom and while a pane is entering layout). Keep the first
  // row visible until TanStack reports its measured range.
  const virtualItems =
    measuredVirtualItems.length === 0 && controller.totalCount > 0
      ? Array.from(
          {
            length: Math.min(controller.totalCount, GRAPH_OVERSCAN * 2 + 1),
          },
          (_unused, index) => ({
            index,
            key: getItemKey(index),
            start: index * ROW_HEIGHT,
          })
        )
      : measuredVirtualItems;
  const totalHeight = Math.max(
    rowVirtualizer.getTotalSize(),
    controller.totalCount * ROW_HEIGHT
  );

  return (
    <div
      data-testid="commit-history-virtualized-list"
      role="list"
      style={{ height: totalHeight, position: "relative", minWidth: 0 }}
    >
      <div
        className="absolute left-0 top-0 overflow-x-auto overflow-y-visible"
        style={{ width: graphRailWidth, height: totalHeight }}
        data-testid="commit-graph-rail"
      >
        <svg
          data-testid="commit-graph-surface"
          width={graphContentWidth}
          height={totalHeight}
          viewBox={`0 0 ${graphContentWidth} ${totalHeight}`}
          style={{
            display: "block",
            overflow: "visible",
            pointerEvents: "none",
          }}
          aria-hidden="true"
        >
          {virtualItems.map((virtualRow) => {
            const commit = getCommit(virtualRow.index);
            const presentation = commit
              ? rowPresentation[virtualRow.index]
              : undefined;
            const layout = commit ? graphLayout[virtualRow.index] : undefined;
            if (!commit || !presentation || !layout) return null;
            return (
              <CommitGraphRowSvg
                key={virtualRow.key}
                commit={commit}
                layout={layout}
                trunkColorClass={presentation.trunkColorClass}
                relation={relationForIndex(commits, virtualRow.index)}
                isSelected={diffRef === `~${commit.hash}`}
                rowTop={virtualRow.start}
              />
            );
          })}
        </svg>
        {virtualItems.map((virtualRow) => {
          const commit = getCommit(virtualRow.index);
          const presentation = commit
            ? rowPresentation[virtualRow.index]
            : undefined;
          if (!commit || !presentation) return null;
          return (
            <CommitGraphHitArea
              key={`hit-${virtualRow.key}`}
              commit={commit}
              graphWidth={graphContentWidth}
              branchTooltip={presentation.branchTooltip}
              relation={relationForIndex(commits, virtualRow.index)}
              isSelected={diffRef === `~${commit.hash}`}
              rowTop={virtualRow.start}
              onClick={onClick}
              onContextMenu={onContextMenu}
              onLongPressContextMenu={onLongPressContextMenu}
            />
          );
        })}
      </div>
      {virtualItems.map((virtualRow) => {
        const commit = getCommit(virtualRow.index);
        const presentation = commit
          ? rowPresentation[virtualRow.index]
          : undefined;
        return (
          <div
            key={virtualRow.key}
            role="listitem"
            aria-posinset={virtualRow.index + 1}
            aria-setsize={controller.totalCount}
            data-index={virtualRow.index}
            data-commit-row={commit?.hash}
            data-virtual-placeholder={
              commit && presentation ? undefined : "true"
            }
            className="absolute right-0"
            style={{
              top: virtualRow.start,
              minHeight: ROW_HEIGHT,
              left: graphRailWidth,
            }}
          >
            {commit && presentation ? (
              <CommitRow
                commit={commit}
                colorClass={presentation.nodeColorClass}
                isSelected={diffRef === `~${commit.hash}`}
                onClick={onClick}
                onContextMenu={onContextMenu}
                onLongPressContextMenu={onLongPressContextMenu}
              />
            ) : (
              <div
                className="flex h-6 items-center px-2 text-xs text-editor-fg opacity-40"
                style={{ height: ROW_HEIGHT }}
              >
                Loading…
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

function relationForIndex(
  commits: readonly WorkspaceCommitLogEntry[],
  index: number
): HeadRelation {
  const headIndex = commits.findIndex((commit) => commit.isHead);
  if (headIndex < 0 || index === headIndex) return GIT_HEAD_RELATIONS.AT;
  return index < headIndex
    ? GIT_HEAD_RELATIONS.AHEAD
    : GIT_HEAD_RELATIONS.BEHIND;
}

const REF_PILL_BORDER_CLASS: Record<string, string> = {
  "text-scm-graph-local": "border-scm-graph-local",
  "text-scm-graph-remote": "border-scm-graph-remote",
  "text-scm-graph-fg1": "border-scm-graph-fg1",
  "text-scm-graph-fg2": "border-scm-graph-fg2",
  "text-scm-graph-fg3": "border-scm-graph-fg3",
  "text-scm-graph-fg4": "border-scm-graph-fg4",
  "text-scm-graph-fg5": "border-scm-graph-fg5",
};

interface RefPillProps {
  label: GitRefLabel;
  colorClass: string;
  iconOnly?: boolean;
}

const RefPill: React.FC<RefPillProps> = ({ label, colorClass, iconOnly }) => {
  const borderColorClass =
    REF_PILL_BORDER_CLASS[colorClass] ?? "border-scm-graph-local";
  const icon =
    label.type === GIT_REF_LABEL_TYPES.REMOTE_BRANCH
      ? "codicon-cloud"
      : label.type === GIT_REF_LABEL_TYPES.TAG
        ? "codicon-tag"
        : label.type === GIT_REF_LABEL_TYPES.HEAD
          ? "codicon-target"
          : "codicon-git-branch";
  return (
    <span
      className={`flex items-center gap-0.5 px-1 py-px rounded border text-xxs leading-none whitespace-nowrap ${colorClass} ${borderColorClass}`}
      title={label.name}
    >
      <Icon name={icon} className="text-xxs" />
      {!iconOnly && label.name}
    </span>
  );
};

interface CommitRowProps {
  commit: WorkspaceCommitLogEntry;
  colorClass: string;
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
  colorClass,
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
      data-testid={`commit-row-${commit.hash}`}
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
              colorClass={colorClass}
              iconOnly={
                ref.type === GIT_REF_LABEL_TYPES.REMOTE_BRANCH &&
                commit.refs.some(
                  (r) => r.type === GIT_REF_LABEL_TYPES.LOCAL_BRANCH
                )
              }
            />
          ))}
        </span>
      )}
    </button>
  );
};

export const WorkspaceCommitHistoryPane: React.FC<
  WorkspaceCommitHistoryPaneProps
> = ({
  onRefresh,
  isMobile = false,
  pageSize,
  fetchPage,
  scrollContainerRef,
  controller: controllerOverride,
}) => {
  const detachedContext = useWorkspaceViewerStore((s) => s.detached);
  const previousBranch = useWorkspaceViewerStore((s) => s.previousBranch);
  const setPreviousBranch = useWorkspaceViewerStore((s) => s.setPreviousBranch);
  const diffRef = useWorkspaceViewerStore((s) => s.diffRef);
  const setMobileDiffVisible = useWorkspaceViewerStore(
    (s) => s.setMobileDiffVisible
  );
  const selectedRepoId = useWorkspaceViewerStore((s) => s.selectedRepoId);
  const ownScrollContainerRef = useRef<HTMLDivElement>(null);
  const historyScrollContainerRef = scrollContainerRef ?? ownScrollContainerRef;
  const [containerWidthCallbackRef, containerWidthBucket] = useElementTier<
    number,
    HTMLDivElement
  >(resolveContainerWidthBucket, 0);
  const setHistoryScrollContainerNode = useCallback(
    (node: HTMLDivElement | null) => {
      historyScrollContainerRef.current = node;
      containerWidthCallbackRef(node);
    },
    [containerWidthCallbackRef, historyScrollContainerRef]
  );

  const hookController = usePagedCommitHistory({
    repo: selectedRepoId ?? undefined,
    branchHint: detachedContext && previousBranch ? previousBranch : undefined,
    detached: detachedContext,
    pageSize,
    enabled: controllerOverride ? false : undefined,
    fetchPage,
  });
  const controller = controllerOverride ?? hookController;
  const detached = controller.detached;
  const currentBranch = controller.currentBranch;

  const handleRefresh = useCallback(() => {
    controller.refresh();
    onRefresh();
  }, [controller, onRefresh]);

  const { openContextMenu, commitHistoryContextMenuPortal } =
    useCommitHistoryContextMenu({ onRefresh: handleRefresh });

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
      handleRefresh();
    } catch {
      // The parent status refresh remains the source of truth for failures.
    }
  }, [
    currentBranch,
    handleRefresh,
    previousBranch,
    selectedRepoId,
    setPreviousBranch,
  ]);

  const returnBranchLabel =
    previousBranch ?? (currentBranch !== null ? currentBranch : null);

  // Feed the stateful graph fold only the loaded contiguous prefix. A page
  // fetched beyond a sparse gap stays a placeholder until the gap is filled.
  const { getCommit: getCommitAt, loadedOffsets, totalCount } = controller;
  const loadedPrefix = useMemo(() => {
    const prefix: WorkspaceCommitLogEntry[] = [];
    if (!loadedOffsets.includes(0)) return prefix;
    for (let index = 0; index < totalCount; index += 1) {
      const commit = getCommitAt(index);
      if (!commit) break;
      prefix.push(commit);
    }
    return prefix;
  }, [getCommitAt, loadedOffsets, totalCount]);

  const graphLayout = useMemo(
    () => computeCommitGraphLayout(loadedPrefix),
    [loadedPrefix]
  );
  const hasUnpushed = loadedPrefix.some((commit) => !commit.pushed);
  const rowPresentation = useMemo(() => {
    const lastSeenBranchName = new Map<number, string>();
    return loadedPrefix.map((commit, index) => {
      const layout = graphLayout[index];
      const trunkColorClass =
        hasUnpushed && commit.pushed
          ? TRUNK_COLOR_CLASSES.remote
          : TRUNK_COLOR_CLASSES.local;
      const nodeSource =
        layout.inputLanes[layout.laneIndex] ??
        ({
          id: commit.hash,
          colorIndex: TRUNK_COLOR_INDEX,
        } satisfies CommitGraphLane);
      const nodeColorClass = resolveLaneColorClass(nodeSource, trunkColorClass);
      if (commit.refs.length > 0) {
        lastSeenBranchName.set(
          nodeSource.colorIndex,
          commit.refs.map((ref) => ref.name).join(", ")
        );
      }
      return {
        trunkColorClass,
        nodeColorClass,
        branchTooltip: lastSeenBranchName.get(nodeSource.colorIndex),
      };
    });
  }, [graphLayout, hasUnpushed, loadedPrefix]);
  const graphLaneCount = Math.max(
    1,
    ...graphLayout.map((row) =>
      Math.max(row.laneIndex + 1, row.inputLanes.length, row.outputLanes.length)
    )
  );
  const graphContentWidth = (graphLaneCount + 1) * GRAPH_LANE_WIDTH;
  // Before the pane's width has been measured, fall back to a fixed lane
  // cap so the first paint doesn't flash the full (possibly very wide)
  // graph. Once measured, the graph column may grow up to
  // `GRAPH_RAIL_MAX_PARENT_FRACTION` of the pane before it scrolls.
  const inlineLaneCap = isMobile
    ? MOBILE_INLINE_LANE_CAP
    : DESKTOP_INLINE_LANE_CAP;
  const fallbackGraphRailWidth =
    (Math.min(graphLaneCount, inlineLaneCap) + 1) * GRAPH_LANE_WIDTH;
  const graphRailWidth =
    containerWidthBucket > 0
      ? Math.min(
          graphContentWidth,
          Math.max(
            GRAPH_LANE_WIDTH,
            Math.floor(containerWidthBucket * GRAPH_RAIL_MAX_PARENT_FRACTION)
          )
        )
      : Math.min(graphContentWidth, fallbackGraphRailWidth);

  const handleRangeChange = useCallback(
    (range: VirtualizedListRange): void => controller.onRangeChange(range),
    [controller]
  );

  return (
    <div className="flex h-full min-h-0 flex-col cy-no-select">
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
              <Icon name="git-branch" className="text-xs flex-shrink-0" />
              <span className="truncate">{currentBranch}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <Icon name="git-commit" className="text-xs flex-shrink-0" />
              detached
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          className="codicon codicon-refresh text-xs text-editor-fg opacity-60 hover:opacity-100 transition-opacity flex-shrink-0"
          title="Refresh commit history"
          aria-label="Refresh commit history"
        />
      </div>

      {detached && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-yellow-500/10 border-y border-yellow-500/20 flex-shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Icon
              name="warning"
              className="text-xs text-yellow-400 flex-shrink-0"
            />
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

      <div
        ref={setHistoryScrollContainerNode}
        data-testid="commit-history-scroll-container"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        {totalCount === 0 && !controller.initialLoading ? (
          <p className="px-3 pb-2 pt-1 text-xs text-editor-fg opacity-40 select-none">
            No commits yet
          </p>
        ) : totalCount > 0 ? (
          <CommitHistoryVirtualizedRows
            controller={controller}
            commits={loadedPrefix}
            graphLayout={graphLayout}
            rowPresentation={rowPresentation}
            diffRef={diffRef}
            graphRailWidth={graphRailWidth}
            graphContentWidth={graphContentWidth}
            scrollContainerRef={historyScrollContainerRef}
            onRangeChange={handleRangeChange}
            onClick={handleRowClick}
            onContextMenu={handleRowContextMenu}
            onLongPressContextMenu={handleRowLongPressContextMenu}
          />
        ) : null}
      </div>

      {controller.isLoading && (
        <div className="flex items-center gap-2 px-3 py-2 text-editor-fg opacity-50 flex-shrink-0">
          <Icon name="loading" className="animate-spin text-xs" />
          <span className="text-xs">Loading…</span>
        </div>
      )}

      {commitHistoryContextMenuPortal}
    </div>
  );
};
