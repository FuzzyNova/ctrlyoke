import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualizedPagedListProps } from "@components/shared/VirtualizedPagedList";
import { DiffFileHistoryList } from "@components/diff/DiffFileHistoryList";
import type {
  WorkspaceFileHistoryDiffResponse,
  WorkspaceFileHistoryEntry,
} from "@root/types/HostedWorkspaceViewerTypes";
import type { PagedFileHistoryController } from "@hooks/usePagedFileHistory";

const { usePagedFileHistory } = vi.hoisted(() => ({
  usePagedFileHistory: vi.fn(),
}));

vi.mock("@hooks/usePagedFileHistory", () => ({ usePagedFileHistory }));
vi.mock("@components/output/DiffView", () => ({
  DiffView: ({ collapsed }: { collapsed?: boolean }) => (
    <div data-testid="loaded-diff" data-collapsed={String(collapsed)} />
  ),
}));
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

function detail(hash: string): WorkspaceFileHistoryDiffResponse {
  return {
    hash,
    shortHash: hash,
    subject: "Subject",
    body: "",
    author: "Author",
    authorEmail: "author@example.com",
    date: "2026-08-25T12:00:00.000Z",
    relativeDate: "today",
    path: "src/file.ts",
    oldPath: "src/file.ts",
    changeType: "modified",
    payloadKind: "text",
    language: "typescript",
    oldContent: "before",
    newContent: "after",
  };
}

const COLLAPSED = { version: 0, collapsed: true };

function controller(loadedCount = 1): PagedFileHistoryController {
  const loaded = new Map(
    Array.from({ length: loadedCount }, (_, index) => [index, entry(index)])
  );
  return {
    path: "src/file.ts",
    listingId: "history-1",
    totalCount: 2,
    pageSize: 1,
    getEntry: (index) => loaded.get(index),
    uniqueLoadedCount: loadedCount,
    loadedCount,
    loadedOffsets: [...loaded.keys()],
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
        command={COLLAPSED}
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

  it("expands entries from pages that load after Expand all", async () => {
    const fetchDetail = vi.fn((_path: string, commit: string) =>
      Promise.resolve(detail(commit))
    );
    const expanded = { version: 1, collapsed: false };
    const props = {
      path: "src/file.ts",
      scrollContainerRef: createRef<HTMLDivElement>(),
      fetchDetail,
      command: expanded,
    };
    const { rerender } = render(
      <DiffFileHistoryList {...props} controller={controller(1)} />
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("loaded-diff")).toHaveLength(1)
    );

    rerender(<DiffFileHistoryList {...props} controller={controller(2)} />);

    await waitFor(() =>
      expect(screen.getAllByTestId("loaded-diff")).toHaveLength(2)
    );
    expect(fetchDetail.mock.calls.map(([, commit]) => commit)).toEqual([
      "hash-0",
      "hash-1",
    ]);
  });

  it("keeps a card's own toggle until the next Expand or Collapse all", async () => {
    const fetchDetail = vi.fn((_path: string, commit: string) =>
      Promise.resolve(detail(commit))
    );
    const props = {
      path: "src/file.ts",
      scrollContainerRef: createRef<HTMLDivElement>(),
      fetchDetail,
      controller: controller(1),
    };
    const { rerender } = render(
      <DiffFileHistoryList {...props} command={COLLAPSED} />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand history diff" })
    );
    await waitFor(() =>
      expect(screen.getByTestId("loaded-diff")).toHaveAttribute(
        "data-collapsed",
        "false"
      )
    );

    rerender(
      <DiffFileHistoryList
        {...props}
        command={{ version: 1, collapsed: true }}
      />
    );
    expect(screen.getByTestId("loaded-diff")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
  });
});
