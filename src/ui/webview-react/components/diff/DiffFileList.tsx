import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { DiffFileCard, type DiffFileCardProps } from "./DiffFileCard";
import { VirtualizedList } from "@components/shared/VirtualizedList";
import { useElementTier } from "@hooks/useElementNarrow";
import { useUiStore } from "@store/uiStore";
import {
  DIFF_FILE_CONTENT_WIDTH_BUCKET,
  type DiffFileListRow,
  diffFileListRowGapClass,
  projectDiffFileListRows,
} from "@utils/diffFileRows";
import { DEFAULT_OUTPUT_CONTENT_WIDTH } from "@utils/outputLineMetrics";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";

export interface DiffFileListCommand {
  /** Changes whenever Expand all or Collapse all should reset local state. */
  version: number;
  collapsed: boolean;
}

interface CollapsedOverride {
  version: number;
  collapsed: boolean;
}

interface ExpandedGapsOverride {
  version: number;
  expandedGaps: DiffGapExpansionState;
}

const EMPTY_COLLAPSED_OVERRIDES = new Map<string, CollapsedOverride>();
const EMPTY_EXPANDED_GAPS_OVERRIDES = new Map<string, ExpandedGapsOverride>();
const EMPTY_EXPANDED_GAPS: DiffGapExpansionState = new Map();
const DIFF_SPLIT_VIEW_THRESHOLD = 1024;
const DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD = 30;
// Diff cards are orders of magnitude more expensive than workflow dropdown
// rows, so two nearby cards are enough to hide mount/unmount churn. A later
// fixture pass will calibrate this against real diff-card costs.
const DIFF_FILE_LIST_VIRTUALIZATION_OVERSCAN = 2;
const DEFAULT_CONTENT_WIDTH_BUCKET = Math.floor(
  DEFAULT_OUTPUT_CONTENT_WIDTH / DIFF_FILE_CONTENT_WIDTH_BUCKET
);

function resolveDiffFileContentWidthBucket(width: number): number {
  return Math.floor(width / DIFF_FILE_CONTENT_WIDTH_BUCKET);
}

export interface DiffFileGroup {
  /** Stable semantic identity for this group, independent of heading text/order. */
  key?: string;
  /** Optional heading; omit for a flat list. */
  heading?: string;
  /** Optional one-line explainer under the heading. */
  headingHint?: string;
  files: Array<DiffFileCardProps & { key: string }>;
}

export interface DiffFileListProps {
  groups: DiffFileGroup[];
  emptyMessage: string;
  command: DiffFileListCommand;
  /** Rendered above the list. */
  selectionSummary?: React.ReactNode;
  /** Parent-owned scroll element used by the future virtual-list path. */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export interface DiffFileListHandle {
  /** Capture the visible file before a global layout command changes estimates. */
  prepareGlobalLayoutChange: () => void;
}

interface DiffFileAnchor {
  key: string;
  viewportOffset: number;
}

export const DiffFileList = React.forwardRef<
  DiffFileListHandle,
  DiffFileListProps
>(function DiffFileList(
  { groups, emptyMessage, command, selectionSummary, scrollContainerRef },
  ref
) {
  // The list owns the one responsive measurement for all of its cards. The
  // bucket is a primitive so useElementTier only re-renders at meaningful
  // width changes, and its module-level resolver keeps the observer stable.
  const [contentWidthRef, contentWidthBucket] = useElementTier<
    number,
    HTMLDivElement
  >(resolveDiffFileContentWidthBucket, DEFAULT_CONTENT_WIDTH_BUCKET);
  const outputContentWidth =
    contentWidthBucket > 0
      ? contentWidthBucket * DIFF_FILE_CONTENT_WIDTH_BUCKET
      : undefined;
  const viewType =
    contentWidthBucket * DIFF_FILE_CONTENT_WIDTH_BUCKET >=
    DIFF_SPLIT_VIEW_THRESHOLD
      ? "split"
      : "unified";
  const outputFontSize = useUiStore((state) => state.outputFontSize);
  const rows = projectDiffFileListRows(
    { groups, selectionSummary },
    {
      collapsed: command.collapsed,
      outputFontSize,
      outputContentWidth,
      viewType,
    }
  );
  const fileRows = rows.filter(
    (row): row is Extract<DiffFileListRow, { kind: "file" }> =>
      row.kind === "file"
  );
  const fileRowKeySignature = fileRows.map((row) => row.key).join("\u0000");
  const activeFileRowKeys = useMemo(
    () =>
      new Set(
        fileRowKeySignature.length > 0
          ? fileRowKeySignature.split("\u0000")
          : []
      ),
    [fileRowKeySignature]
  );
  const filePositionByKey = useMemo(
    () => new Map(fileRows.map((row, index) => [row.key, index + 1])),
    [fileRows]
  );

  const [collapsedOverrides, setCollapsedOverrides] = useState(
    EMPTY_COLLAPSED_OVERRIDES
  );
  const [expandedGapsOverrides, setExpandedGapsOverrides] = useState(
    EMPTY_EXPANDED_GAPS_OVERRIDES
  );
  const [anchorRestore, setAnchorRestore] = useState<DiffFileAnchor | null>(
    null
  );

  useImperativeHandle(
    ref,
    () => ({
      prepareGlobalLayoutChange: () => {
        const container = scrollContainerRef?.current;
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const visibleFiles = container.querySelectorAll<HTMLElement>(
          "[data-diff-file-key]"
        );
        for (const file of visibleFiles) {
          const fileRect = file.getBoundingClientRect();
          if (
            fileRect.bottom > containerRect.top &&
            fileRect.top < containerRect.bottom
          ) {
            setAnchorRestore({
              key: file.dataset.diffFileKey ?? "",
              viewportOffset: fileRect.top - containerRect.top,
            });
            return;
          }
        }
        setAnchorRestore(null);
      },
    }),
    [scrollContainerRef]
  );

  // A command reset must take effect during this render. The effects below
  // only discard the entries after render, so an unchanged card cannot briefly
  // retain an override from the previous Expand/Collapse all command.
  const currentCollapsedOverrides = new Map<string, CollapsedOverride>();
  for (const [key, override] of collapsedOverrides) {
    if (override.version === command.version && activeFileRowKeys.has(key)) {
      currentCollapsedOverrides.set(key, override);
    }
  }
  const currentExpandedGapsOverrides = new Map<string, ExpandedGapsOverride>();
  for (const [key, override] of expandedGapsOverrides) {
    if (override.version === command.version && activeFileRowKeys.has(key)) {
      currentExpandedGapsOverrides.set(key, override);
    }
  }

  useEffect(() => {
    setCollapsedOverrides((previous) => {
      let next: Map<string, CollapsedOverride> | undefined;
      for (const [key, override] of previous) {
        if (
          override.version !== command.version ||
          !activeFileRowKeys.has(key)
        ) {
          next ??= new Map(previous);
          next.delete(key);
        }
      }
      return next ?? previous;
    });
    setExpandedGapsOverrides((previous) => {
      let next: Map<string, ExpandedGapsOverride> | undefined;
      for (const [key, override] of previous) {
        if (
          override.version !== command.version ||
          !activeFileRowKeys.has(key)
        ) {
          next ??= new Map(previous);
          next.delete(key);
        }
      }
      return next ?? previous;
    });
  }, [activeFileRowKeys, command.version, fileRowKeySignature]);

  const handleCollapsedChange = (key: string, collapsed: boolean): void => {
    setCollapsedOverrides((previous) => {
      const existing = previous.get(key);
      if (
        existing?.version === command.version &&
        existing.collapsed === collapsed
      ) {
        return previous;
      }
      const next = new Map(previous);
      next.set(key, { version: command.version, collapsed });
      return next;
    });
  };

  const handleExpandGap = (
    key: string,
    gapIndex: number,
    nextExpandedToLine: number
  ): void => {
    setExpandedGapsOverrides((previous) => {
      const existing = previous.get(key);
      const expandedGaps = new Map(existing?.expandedGaps);
      if (expandedGaps.get(gapIndex) === nextExpandedToLine) return previous;
      expandedGaps.set(gapIndex, nextExpandedToLine);
      const next = new Map(previous);
      next.set(key, {
        version: command.version,
        expandedGaps,
      });
      return next;
    });
  };

  const hasFiles = fileRows.length > 0;

  if (!hasFiles) {
    return (
      <div className="flex flex-col gap-3">
        {selectionSummary}
        <div className="flex items-center justify-center h-32 text-editor-fg opacity-40 select-none">
          <p className="text-sm">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  const renderRow = (row: DiffFileListRow): React.ReactNode => (
    <div
      key={row.key}
      className={diffFileListRowGapClass(row)}
      data-scroll-key={row.key}
      {...(row.kind === "file" ? { "data-diff-file-key": row.key } : {})}
    >
      {row.kind === "selection-summary" && row.content}
      {row.kind === "group-heading" && (
        <div className="flex flex-col gap-0.5">
          <h3 className="text-xs font-semibold text-description-fg">
            {row.heading}
          </h3>
          {row.headingHint && (
            <p className="text-xs text-description-fg italic">
              {row.headingHint}
            </p>
          )}
        </div>
      )}
      {row.kind === "file" && (
        <DiffFileCard
          {...row.file}
          ariaSetSize={fileRows.length}
          ariaPosInSet={filePositionByKey.get(row.key)}
          collapsed={
            currentCollapsedOverrides.get(row.key)?.collapsed ??
            command.collapsed
          }
          onCollapsedChange={(collapsed) =>
            handleCollapsedChange(row.key, collapsed)
          }
          expandedGaps={
            currentExpandedGapsOverrides.get(row.key)?.expandedGaps ??
            EMPTY_EXPANDED_GAPS
          }
          viewType={viewType}
          onExpandGap={(gapIndex, nextExpandedToLine) =>
            handleExpandGap(row.key, gapIndex, nextExpandedToLine)
          }
        />
      )}
    </div>
  );

  const shouldVirtualize =
    fileRows.length >= DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD &&
    scrollContainerRef !== undefined;
  const layoutResetKey = [
    viewType,
    outputFontSize,
    contentWidthBucket,
    command.version,
    command.collapsed,
  ].join(":");

  return (
    <div ref={contentWidthRef} className="flex flex-col">
      {shouldVirtualize && scrollContainerRef ? (
        <VirtualizedList
          items={rows}
          getItemKey={(row) => row.key}
          renderItem={renderRow}
          scrollContainerRef={scrollContainerRef}
          estimateItemSize={(row) => row.estimateSize}
          // The file-count check above deliberately controls this branch;
          // summary and heading rows must not move the threshold.
          threshold={1}
          overscan={DIFF_FILE_LIST_VIRTUALIZATION_OVERSCAN}
          layoutResetKey={layoutResetKey}
          scrollToKey={anchorRestore?.key ?? null}
          scrollToKeyOffset={anchorRestore?.viewportOffset}
          scrollToKeyRequest={anchorRestore ? command.version : undefined}
        />
      ) : (
        rows.map(renderRow)
      )}
    </div>
  );
});

DiffFileList.displayName = "DiffFileList";
