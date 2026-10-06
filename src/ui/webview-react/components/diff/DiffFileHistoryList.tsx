import React, { useCallback } from "react";
import type { RefObject } from "react";
import {
  DiffFileCard,
  type DeferredDiffDetailFetcher,
  type DiffFileCardProps,
} from "./DiffFileCard";
import {
  VirtualizedPagedList,
  type VirtualizedListRange,
} from "@components/shared";
import {
  estimateDiffFileCardSize,
  type DiffFileRowEstimateOptions,
} from "@utils/diffFileRows";
import {
  usePagedFileHistory,
  type PagedFileHistoryController,
  type PagedFileHistoryFetcher,
} from "@hooks/usePagedFileHistory";
import type { WorkspaceFileHistoryEntry } from "@root/types/HostedWorkspaceViewerTypes";
import { DIFF_FILE_SOURCE_KINDS } from "@root/types/DashboardConstants";

export interface DiffFileHistoryListProps {
  path: string;
  repo?: string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  pageSize?: number;
  enabled?: boolean;
  fetchPage?: PagedFileHistoryFetcher;
  fetchDetail?: DeferredDiffDetailFetcher;
  findQuery?: string;
  findCaseSensitive?: boolean;
  /** Primarily useful to host the list in a focused test or alternate pane. */
  controller?: PagedFileHistoryController;
}

function commitNote(entry: WorkspaceFileHistoryEntry): string {
  return [entry.subject, entry.shortHash, entry.author, entry.relativeDate]
    .filter(Boolean)
    .join(" · ");
}

function cardProps(
  entry: WorkspaceFileHistoryEntry,
  repo: string | undefined,
  fetchDetail: DeferredDiffDetailFetcher | undefined,
  findQuery: string | undefined,
  findCaseSensitive: boolean | undefined
): DiffFileCardProps {
  return {
    path: entry.path,
    oldPath: entry.oldPath === entry.path ? undefined : entry.oldPath,
    changeType: entry.oldPath !== entry.path ? "renamed" : "modified",
    note: commitNote(entry),
    findQuery,
    findCaseSensitive,
    source: {
      kind: DIFF_FILE_SOURCE_KINDS.DEFERRED,
      commit: entry.hash,
      state: "not-loaded",
      ...(repo === undefined ? {} : { repo }),
      ...(fetchDetail === undefined ? {} : { fetchDetail }),
    },
  };
}

const PLACEHOLDER_CLASS =
  "h-16 rounded-sm border border-panel-border bg-editor-bg/40 px-2.5 py-2 text-xs text-description-fg";

export function DiffFileHistoryList({
  path,
  repo,
  scrollContainerRef,
  pageSize,
  enabled,
  fetchPage,
  fetchDetail,
  findQuery,
  findCaseSensitive,
  controller: controllerOverride,
}: DiffFileHistoryListProps): React.ReactElement {
  const hookController = usePagedFileHistory({
    path,
    repo,
    pageSize,
    enabled: controllerOverride ? false : enabled,
    fetchPage,
  });
  const controller = controllerOverride ?? hookController;

  const getItem = useCallback(
    (index: number) => controller.getEntry(index),
    [controller]
  );
  const getItemKey = useCallback(
    (entry: WorkspaceFileHistoryEntry) => entry.hash,
    []
  );
  const renderItem = useCallback(
    (entry: WorkspaceFileHistoryEntry, index: number) => {
      const props = cardProps(
        entry,
        repo,
        fetchDetail,
        findQuery,
        findCaseSensitive
      );
      return (
        <DiffFileCard
          {...props}
          ariaSetSize={controller.totalCount}
          ariaPosInSet={index + 1}
        />
      );
    },
    [controller, fetchDetail, findCaseSensitive, findQuery, repo]
  );
  const renderPlaceholder = useCallback(
    (index: number) => (
      <div
        className={PLACEHOLDER_CLASS}
        data-file-history-placeholder="true"
        data-placeholder-index={index}
      >
        Loading file history…
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
            path,
            changeType: "modified",
            source: {
              kind: DIFF_FILE_SOURCE_KINDS.DEFERRED,
              commit: `placeholder-${index}`,
              state: "not-loaded",
            },
          },
          estimateOptions
        );
      }
      return estimateDiffFileCardSize(
        cardProps(entry, repo, fetchDetail, findQuery, findCaseSensitive),
        estimateOptions
      );
    },
    [controller, fetchDetail, findCaseSensitive, findQuery, path, repo]
  );
  const onRangeChange = useCallback(
    (range: VirtualizedListRange): void => controller.onRangeChange(range),
    [controller]
  );

  if (controller.listingId === null && controller.initialLoading) {
    return (
      <div className="px-2.5 py-3 text-xs text-description-fg" role="status">
        Loading file history…
      </div>
    );
  }
  if (controller.listingId === null && controller.error) {
    return (
      <div className="px-2.5 py-3 text-xs text-description-fg" role="alert">
        <span>Unable to load file history.</span>
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

  return (
    <div className="flex flex-col gap-2">
      {controller.failedRanges.map((failedRange) => (
        <div
          key={failedRange.offset}
          className="px-2.5 text-xs text-description-fg"
          role="alert"
        >
          <span>Some history entries could not be loaded.</span>
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
        listingId={controller.listingId ?? `file-history:${path}:${repo ?? ""}`}
        getItem={getItem}
        getItemKey={getItemKey}
        renderItem={renderItem}
        renderPlaceholder={renderPlaceholder}
        scrollContainerRef={scrollContainerRef}
        estimateItemSize={estimateItemSize}
        onRangeChange={onRangeChange}
        layoutResetKey={`${controller.listingId ?? "pending"}:${controller.pageSize}`}
      />
    </div>
  );
}

export const FileHistoryList = DiffFileHistoryList;
