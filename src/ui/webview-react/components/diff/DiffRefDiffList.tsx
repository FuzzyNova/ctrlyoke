import React, { useCallback } from "react";
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

export interface DiffRefDiffListProps {
  ref: string;
  repo?: string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  pageSize?: number;
  enabled?: boolean;
  fetchPage?: PagedGitRefDiffFetcher;
  findQuery?: string;
  findCaseSensitive?: boolean;
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
      return { kind: "image", image: entry.image };
    case DIFF_PAYLOAD_KINDS.BINARY:
      return { kind: "binary" };
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
    language: entry.payloadKind === DIFF_PAYLOAD_KINDS.TEXT ? entry.language : undefined,
    findQuery,
    findCaseSensitive,
    source: sourceForEntry(entry),
  };
}

const PLACEHOLDER_CLASS =
  "h-16 rounded border border-panel-border bg-editor-bg/40 px-2.5 py-2 text-xs text-description-fg";

export function DiffRefDiffList({
  ref,
  repo,
  scrollContainerRef,
  pageSize,
  enabled,
  fetchPage,
  findQuery,
  findCaseSensitive,
  controller: controllerOverride,
}: DiffRefDiffListProps): React.ReactElement {
  const hookController = usePagedGitRefDiff({
    ref,
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
    (entry: WorkspaceGitRefDiffEntry) => entry.path,
    []
  );
  const renderItem = useCallback(
    (entry: WorkspaceGitRefDiffEntry, index: number) => (
      <DiffFileCard
        {...cardProps(entry, findQuery, findCaseSensitive)}
        ariaSetSize={controller.totalCount}
        ariaPosInSet={index + 1}
      />
    ),
    [controller, findCaseSensitive, findQuery]
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
            source: { kind: "binary" },
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
        listingId={controller.listingId ?? `git-ref-diff:${ref}:${repo ?? ""}`}
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
