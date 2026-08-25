import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualizedPagedListProps } from "@components/shared/VirtualizedPagedList";
import { DiffFileHistoryList } from "@components/diff/DiffFileHistoryList";
import type { WorkspaceFileHistoryEntry } from "@root/types/HostedWorkspaceViewerTypes";
import type { PagedFileHistoryController } from "@hooks/usePagedFileHistory";

const { usePagedFileHistory } = vi.hoisted(() => ({
  usePagedFileHistory: vi.fn(),
}));

vi.mock("@hooks/usePagedFileHistory", () => ({ usePagedFileHistory }));
vi.mock("@components/shared", () => ({
  VirtualizedPagedList: <T,>(props: VirtualizedPagedListProps<T>) => (
    <div data-testid="virtualized-paged-list">
      {[0, 1].map((index) => {
        const item = props.getItem(index);
        return (
          <div key={index} data-test-row={index}>
            {item
              ? props.renderItem(item, index)
              : props.renderPlaceholder(index)}
          </div>
        );
      })}
    </div>
  ),
}));

function entry(index: number): WorkspaceFileHistoryEntry {
  return {
    hash: `hash-${index}`,
    shortHash: `short-${index}`,
    subject: `Subject ${index}`,
    author: "Author",
    relativeDate: "today",
    isHead: index === 0,
    pushed: true,
    refs: [],
    isMerge: false,
    parentHashes: [],
    path: "src/file.ts",
    oldPath: "src/file.ts",
  };
}

function controller(): PagedFileHistoryController {
  const loaded = new Map([[0, entry(0)]]);
  return {
    path: "src/file.ts",
    listingId: "history-1",
    totalCount: 2,
    pageSize: 1,
    getEntry: (index) => loaded.get(index),
    uniqueLoadedCount: 1,
    loadedCount: 1,
    loadedOffsets: [0],
    inFlightOffsets: [],
    failedRanges: [],
    initialLoading: false,
    isInitialLoading: false,
    pageLoading: false,
    isLoading: false,
    error: null,
    initialError: null,
    navigate: vi.fn(),
    refresh: vi.fn(),
    retry: vi.fn(),
    retryPage: vi.fn(),
    requestRange: vi.fn(),
    loadRange: vi.fn(),
    onRangeChange: vi.fn(),
    onViewportRangeChange: vi.fn(),
    navigateTo: vi.fn(),
  };
}

describe("DiffFileHistoryList", () => {
  beforeEach(() => {
    usePagedFileHistory.mockReturnValue(controller());
  });

  it("uses VirtualizedPagedList and keeps placeholders free of card ARIA metadata", () => {
    render(
      <DiffFileHistoryList
        path="src/file.ts"
        scrollContainerRef={createRef<HTMLDivElement>()}
        controller={controller()}
      />
    );

    expect(screen.getByTestId("virtualized-paged-list")).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveAttribute("aria-posinset", "1");
    const placeholder = screen
      .getByTestId("virtualized-paged-list")
      .querySelector('[data-file-history-placeholder="true"]');
    expect(placeholder).toBeInTheDocument();
    expect(placeholder?.closest("article")).toBeNull();
    expect(placeholder?.getAttribute("aria-posinset")).toBeNull();
  });
});
