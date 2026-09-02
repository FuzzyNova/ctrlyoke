import React, { useCallback, useImperativeHandle, useState } from "react";
import type { RefObject } from "react";
import { DIFF_PAYLOAD_KINDS } from "@root/types/DashboardConstants";
import type { WorkspaceGitRefDiffEntry } from "@root/types/HostedWorkspaceViewerTypes";
import {
  VirtualizedPagedList,
  type VirtualizedListRange,
} from "@components/shared";
import {
  estimateDiffFileCardSize,
  type DiffFileRowEstimateOptions,
} from "@utils/diffFileRows";
import {
  usePagedGitRefDiff,
  type PagedGitRefDiffController,
  type PagedGitRefDiffFetcher,
} from "@hooks/usePagedGitRefDiff";
import { DiffFileCard, type DiffFileCardProps } from "./DiffFileCard";
import {
  type DiffFileListCommand,
  type DiffFileListHandle,
} from "./DiffFileList";
import { OpenFileButton } from "./OpenFileButton";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";

export interface DiffRefDiffListProps {
  gitRef: string;
  repo?: string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  pageSize?: number;
  enabled?: boolean;
  fetchPage?: PagedGitRefDiffFetcher;
  findQuery?: string;
  findCaseSensitive?: boolean;
  command: DiffFileListCommand;
  /** Primarily useful to let a parent own the hook instance. */
  controller?: PagedGitRefDiffController;
}
function sourceForEntry(
  entry: WorkspaceGitRefDiffEntry
): DiffFileCardProps["source"] {
  switch (entry.payloadKind) {
    case DIFF_PAYLOAD_KINDS.TEXT:
      return {
        kind: "content",
        oldContent: entry.oldContent,
        newContent: entry.newContent,
      };
    case DIFF_PAYLOAD_KINDS.IMAGE:
      return { kind: DIFF_PAYLOAD_KINDS.IMAGE, image: entry.image };
    case DIFF_PAYLOAD_KINDS.BINARY:
      return { kind: DIFF_PAYLOAD_KINDS.BINARY };
  }
}

function cardProps(
  entry: WorkspaceGitRefDiffEntry,
  findQuery: string | undefined,
  findCaseSensitive: boolean | undefined
): DiffFileCardProps {
  return {
    path: entry.path,
    oldPath: entry.oldPath,
    changeType: entry.changeType,
    language:
      entry.payloadKind === DIFF_PAYLOAD_KINDS.TEXT
        ? entry.language
        : undefined,
    findQuery,
    findCaseSensitive,
    source: sourceForEntry(entry),
    headerActions: <OpenFileButton path={entry.path} />,
  };
}

const PLACEHOLDER_CLASS =
  "h-16 rounded border border-panel-border bg-editor-bg/40 px-2.5 py-2 text-xs text-description-fg";
const EMPTY_EXPANDED_GAPS: DiffGapExpansionState = new Map();

export const DiffRefDiffList = React.forwardRef<
  DiffFileListHandle,
  DiffRefDiffListProps
>(function DiffRefDiffList(
  {
    gitRef,
    repo,
    scrollContainerRef,
    pageSize,
    enabled,
    fetchPage,
    findQuery,
    findCaseSensitive,
    command,
    controller: controllerOverride,
  },
  ref
): React.ReactElement {
  const hookController = usePagedGitRefDiff({
    ref: gitRef,
    repo,
    pageSize,
    enabled: controllerOverride ? false : enabled,
    fetchPage,
  });
  const controller = controllerOverride ?? hookController;
  const [collapsedOverrides, setCollapsedOverrides] = useState(
    new Map<
      string,
      { listingId: string | null; version: number; collapsed: boolean }
    >()
  );
  const [expandedGapsOverrides, setExpandedGapsOverrides] = useState(
    new Map<
      string,
      {
        listingId: string | null;
        version: number;
        expandedGaps: DiffGapExpansionState;
      }
    >()
  );
  const [anchorRestore, setAnchorRestore] = useState<{
    index: number;
    viewportOffset: number;
  } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      prepareGlobalLayoutChange: () => {
        const container = scrollContainerRef.current;
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
            const row = file.closest<HTMLElement>("[data-index]");
            const index = Number(row?.dataset.index);
            if (Number.isSafeInteger(index)) {
              setAnchorRestore({
                index,
                viewportOffset: fileRect.top - containerRect.top,
              });
            }
            return;
          }
        }
        setAnchorRestore(null);
      },
    }),
    [scrollContainerRef]
  );

  const getItem = useCallback(
    (index: number) => controller.getEntry(index),
    [controller]
  );
  const getItemKey = useCallback(
    (entry: WorkspaceGitRefDiffEntry) => entry.path,
    []
  );
  const renderItem = useCallback(
    (entry: WorkspaceGitRefDiffEntry, index: number) => {
      const collapsedOverride = collapsedOverrides.get(entry.path);
      const expandedGapsOverride = expandedGapsOverrides.get(entry.path);
      return (
        <div data-diff-file-key={entry.path}>
          <DiffFileCard
            {...cardProps(entry, findQuery, findCaseSensitive)}
            ariaSetSize={controller.totalCount}
            ariaPosInSet={index + 1}
            collapsed={
              collapsedOverride?.listingId === controller.listingId &&
              collapsedOverride.version === command.version
                ? collapsedOverride.collapsed
                : command.collapsed
            }
            onCollapsedChange={(collapsed) =>
              setCollapsedOverrides((previous) => {
                const next = new Map(previous);
                next.set(entry.path, {
                  listingId: controller.listingId,
                  version: command.version,
                  collapsed,
                });
                return next;
              })
            }
            expandedGaps={
              expandedGapsOverride?.listingId === controller.listingId &&
              expandedGapsOverride.version === command.version
                ? expandedGapsOverride.expandedGaps
                : EMPTY_EXPANDED_GAPS
            }
            onExpandGap={(gapIndex, nextExpandedToLine) =>
              setExpandedGapsOverrides((previous) => {
                const existing = previous.get(entry.path);
                const expandedGaps = new Map(existing?.expandedGaps);
                expandedGaps.set(gapIndex, nextExpandedToLine);
                const next = new Map(previous);
                next.set(entry.path, {
                  listingId: controller.listingId,
                  version: command.version,
                  expandedGaps,
                });
                return next;
              })
            }
          />
        </div>
      );
    },
    [
      collapsedOverrides,
      command,
      controller,
      expandedGapsOverrides,
      findCaseSensitive,
      findQuery,
    ]
  );
  const renderPlaceholder = useCallback(
    (index: number) => (
      <div
        className={PLACEHOLDER_CLASS}
        data-git-ref-diff-placeholder="true"
        data-placeholder-index={index}
      >
        Loading diff…
      </div>
    ),
    []
  );
  const estimateItemSize = useCallback(
    (index: number): number => {
      const entry = controller.getEntry(index);
      const estimateOptions: DiffFileRowEstimateOptions = { collapsed: true };
      if (!entry) {
        return estimateDiffFileCardSize(
          {
            path: `placeholder-${index}`,
            changeType: "modified",
            source: { kind: DIFF_PAYLOAD_KINDS.BINARY },
          },
          estimateOptions
        );
      }
      return estimateDiffFileCardSize(
        cardProps(entry, findQuery, findCaseSensitive),
        estimateOptions
      );
    },
    [controller, findCaseSensitive, findQuery]
  );
  const onRangeChange = useCallback(
    (range: VirtualizedListRange): void => controller.onRangeChange(range),
    [controller]
  );

  if (controller.listingId === null && controller.initialLoading) {
    return (
      <div className="px-2.5 py-3 text-xs text-description-fg" role="status">
        Loading diff…
      </div>
    );
  }
  if (controller.listingId === null && controller.error) {
    return (
      <div className="px-2.5 py-3 text-xs text-description-fg" role="alert">
        <span>Unable to load diff.</span>
        <button
          type="button"
          className="ml-2 underline hover:text-foreground"
          onClick={() => controller.retry()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (controller.totalCount === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-editor-fg opacity-40 select-none">
        <p className="text-sm">No text changes to display</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {controller.failedRanges.map((failedRange) => (
        <div
          key={failedRange.offset}
          className="px-2.5 text-xs text-description-fg"
          role="alert"
        >
          <span>Some diff entries could not be loaded.</span>
          <button
            type="button"
            className="ml-2 underline hover:text-foreground"
            onClick={() => controller.retryPage(failedRange.offset)}
          >
            Retry page
          </button>
        </div>
      ))}
      <VirtualizedPagedList
        totalCount={controller.totalCount}
        listingId={
          controller.listingId ?? `git-ref-diff:${gitRef}:${repo ?? ""}`
        }
        getItem={getItem}
        getItemKey={getItemKey}
        renderItem={renderItem}
        renderPlaceholder={renderPlaceholder}
        scrollContainerRef={scrollContainerRef}
        estimateItemSize={estimateItemSize}
        onRangeChange={onRangeChange}
        layoutResetKey={`${controller.listingId ?? "pending"}:${controller.pageSize}:${command.version}:${command.collapsed}`}
        scrollToIndex={anchorRestore?.index ?? null}
        scrollToIndexOffset={anchorRestore?.viewportOffset}
        scrollToIndexRequest={anchorRestore ? command.version : undefined}
      />
    </div>
  );
});

DiffRefDiffList.displayName = "DiffRefDiffList";
