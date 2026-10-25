import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PagedFileHistoryFetcher,
  usePagedFileHistory,
} from "@hooks/usePagedFileHistory";
import type {
  WorkspaceFileHistoryEntry,
  WorkspaceFileHistoryPageResponse,
} from "@root/types/HostedWorkspaceViewerTypes";

const HISTORY_A = "00000000-0000-4000-8000-000000000001";
const HISTORY_B = "00000000-0000-4000-8000-000000000002";

function entry(index: number): WorkspaceFileHistoryEntry {
  return {
    hash: `hash-${index}`,
    shortHash: `short-${index}`,
    subject: `Change ${index}`,
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

function response(
  historyId: string,
  offset: number,
  entries: WorkspaceFileHistoryEntry[],
  totalEntries = 10
): WorkspaceFileHistoryPageResponse {
  return {
    historyId,
    pageSize: 3,
    totalEntries,
    hasMore: offset + entries.length < totalEntries,
    offset,
    entries,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderHistory(fetchPage: PagedFileHistoryFetcher) {
  return renderHook(() =>
    usePagedFileHistory({
      path: "src\\file.ts",
      repo: "repo-a",
      pageSize: 3,
      fetchPage,
    })
  );
}

afterEach(() => vi.restoreAllMocks());

describe("usePagedFileHistory", () => {
  it("requests only the initial page and the pages covering a visible overscan range", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValue(
        response(HISTORY_A, 0, [entry(0), entry(1), entry(2)])
      );
    const { result } = renderHistory(fetchPage);

    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));
    expect(fetchPage).toHaveBeenCalledTimes(1);

    act(() =>
      result.current.onRangeChange({
        visibleStartIndex: 3,
        visibleEndIndex: 5,
        overscanStartIndex: 3,
        overscanEndIndex: 8,
        startIndex: 3,
        endIndex: 5,
      })
    );

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([
      0, 3,
    ]);
  });

  it("fetches continuation pages sequentially when the viewport skips ahead", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValueOnce(
        response(HISTORY_A, 0, [entry(0), entry(1), entry(2)])
      )
      .mockResolvedValueOnce(
        response(HISTORY_A, 3, [entry(3), entry(4), entry(5)])
      )
      .mockResolvedValueOnce(
        response(HISTORY_A, 6, [entry(6), entry(7), entry(8)])
      );
    const { result } = renderHistory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));

    act(() =>
      result.current.onRangeChange({
        visibleStartIndex: 3,
        visibleEndIndex: 5,
        overscanStartIndex: 3,
        overscanEndIndex: 5,
        startIndex: 3,
        endIndex: 5,
      })
    );
    await waitFor(() =>
      expect(result.current.getEntry(3)?.hash).toBe("hash-3")
    );
    act(() => result.current.requestRange(6));
    await waitFor(() =>
      expect(result.current.getEntry(6)?.hash).toBe("hash-6")
    );
    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([
      0, 3, 6,
    ]);
  });

  it("discards a stale response after a path/repository generation changes", async () => {
    const first = deferred<WorkspaceFileHistoryPageResponse>();
    const second = deferred<WorkspaceFileHistoryPageResponse>();
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      (props: { path: string; repo: string }) =>
        usePagedFileHistory({ ...props, pageSize: 3, fetchPage }),
      { initialProps: { path: "src/file.ts", repo: "repo-a" } }
    );

    rerender({ path: "src/other.ts", repo: "repo-b" });
    await act(async () => {
      first.resolve(response(HISTORY_A, 0, [entry(0)]));
      second.resolve(response(HISTORY_B, 0, [entry(9)]));
      await Promise.all([first.promise, second.promise]);
    });

    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_B));
    expect(result.current.path).toBe("src/other.ts");
    expect(result.current.getEntry(0)?.hash).toBe("hash-9");
  });

  it("keeps a failed page retryable without clearing loaded pages", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValueOnce(
        response(HISTORY_A, 0, [entry(0), entry(1), entry(2)])
      )
      .mockRejectedValueOnce(new Error("page failed"))
      .mockResolvedValueOnce(
        response(HISTORY_A, 3, [entry(3), entry(4), entry(5)])
      );
    const { result } = renderHistory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));

    act(() => result.current.requestRange(3));
    await waitFor(() => expect(result.current.failedRanges).toHaveLength(1));
    expect(result.current.getEntry(0)?.hash).toBe("hash-0");

    act(() => result.current.retryPage(4));
    await waitFor(() =>
      expect(result.current.getEntry(4)?.hash).toBe("hash-4")
    );
    expect(result.current.failedRanges).toEqual([]);
  });

  it("fills a short first page when a requested row is inside its page window", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, [entry(0)]),
        hasMore: true,
        nextOffset: 5,
        nextCursor: "cursor-5",
      })
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 1, [entry(5)]),
        totalEntries: 2,
        hasMore: false,
        nextOffset: 6,
        nextCursor: "cursor-6",
      });
    const { result } = renderHistory(fetchPage);

    await waitFor(() => expect(result.current.getEntry(0)?.hash).toBe("hash-0"));
    act(() => result.current.requestRange(1));
    await waitFor(() => expect(result.current.getEntry(1)?.hash).toBe("hash-5"));

    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({
      offset: 1,
      nextOffset: 5,
      nextCursor: "cursor-5",
    });
  });

  it("retries a failed continuation from its unaligned offset", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, [entry(0)]),
        hasMore: true,
        nextOffset: 5,
        nextCursor: "cursor-5",
      })
      .mockRejectedValueOnce(new Error("page failed"))
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 1, [entry(5)]),
        totalEntries: 2,
        hasMore: false,
        nextOffset: 6,
        nextCursor: "cursor-6",
      });
    const { result } = renderHistory(fetchPage);

    await waitFor(() => expect(result.current.getEntry(0)?.hash).toBe("hash-0"));
    act(() => result.current.requestRange(1));
    await waitFor(() => expect(result.current.failedRanges).toHaveLength(1));

    act(() => result.current.retryPage(1));
    await waitFor(() => expect(result.current.getEntry(1)?.hash).toBe("hash-5"));

    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([
      0, 1, 1,
    ]);
    expect(fetchPage.mock.calls[1]?.[0].nextCursor).toBe("cursor-5");
    expect(fetchPage.mock.calls[2]?.[0].nextCursor).toBe("cursor-5");
  });

  it("continues from the raw Git cursor while packing filtered pages densely", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, [entry(0)]),
        totalEntries: 1,
        hasMore: true,
        nextOffset: 5,
      })
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 1, [entry(5)]),
        totalEntries: 2,
        hasMore: false,
        nextOffset: 6,
      });
    const { result } = renderHistory(fetchPage);

    await waitFor(() =>
      expect(result.current.getEntry(0)?.hash).toBe("hash-0")
    );
    act(() => result.current.requestRange(3));
    await waitFor(() =>
      expect(result.current.getEntry(1)?.hash).toBe("hash-5")
    );

    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({
      offset: 1,
      nextOffset: 5,
    });
    expect(result.current.getEntry(2)).toBeUndefined();
  });

  it("automatically advances past a fully filtered page without leaving placeholders", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, []),
        totalEntries: 0,
        hasMore: true,
        nextOffset: 4,
        nextCursor: "cursor-4",
      })
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, [entry(4)]),
        totalEntries: 1,
        hasMore: false,
        nextOffset: 5,
        nextCursor: "cursor-5",
      });
    const { result } = renderHistory(fetchPage);

    await waitFor(() =>
      expect(result.current.getEntry(0)?.hash).toBe("hash-4")
    );
    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({
      offset: 0,
      nextOffset: 4,
      nextCursor: "cursor-4",
    });
    expect(result.current.getEntry(1)).toBeUndefined();
  });

  it("does not repeat an empty continuation when the cursor stops advancing", async () => {
    const fetchPage = vi
      .fn<PagedFileHistoryFetcher>()
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, []),
        totalEntries: 0,
        hasMore: true,
        nextOffset: 4,
        nextCursor: "cursor-4",
      })
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, []),
        totalEntries: 0,
        hasMore: true,
        nextOffset: 4,
        nextCursor: "cursor-4",
      });
    renderHistory(fetchPage);

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls.map(([request]) => request.nextOffset)).toEqual([
      undefined,
      4,
    ]);
    expect(fetchPage.mock.calls.map(([request]) => request.nextCursor)).toEqual([
      undefined,
      "cursor-4",
    ]);
  });
});
