import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PagedCommitHistoryFetcher,
  usePagedCommitHistory,
} from "@hooks/usePagedCommitHistory";
import type {
  WorkspaceCommitLogEntry,
  WorkspaceCommitLogResponse,
} from "@root/types/HostedWorkspaceViewerTypes";

const HISTORY_A = "00000000-0000-4000-8000-000000000001";
const HISTORY_B = "00000000-0000-4000-8000-000000000002";

function commit(index: number): WorkspaceCommitLogEntry {
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
  };
}

function response(
  historyId: string,
  offset: number,
  commits: WorkspaceCommitLogEntry[],
  detached = false,
  totalEntries = 10
): WorkspaceCommitLogResponse {
  return {
    historyId,
    pageSize: 3,
    totalEntries,
    offset,
    commits,
    hasMore: offset + commits.length < totalEntries,
    currentBranch: detached ? null : "main",
    detached,
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

function renderHistory(fetchPage: PagedCommitHistoryFetcher) {
  return renderHook(() =>
    usePagedCommitHistory({
      repo: "repo-a",
      branchHint: "main",
      detached: false,
      pageSize: 3,
      fetchPage,
    })
  );
}

afterEach(() => vi.restoreAllMocks());

describe("usePagedCommitHistory", () => {
  it("requests only the initial page and the pages covering a visible overscan range", async () => {
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValue(
        response(HISTORY_A, 0, [commit(0), commit(1), commit(2)])
      );
    const { result } = renderHistory(fetchPage);

    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0]).toMatchObject({
      repo: "repo-a",
      branchHint: "main",
      detached: false,
      offset: 0,
      pageSize: 3,
    });
    expect(result.current.currentBranch).toBe("main");
    expect(result.current.detached).toBe(false);

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

    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([
      0, 3, 6,
    ]);
  });

  it("requests older pages when scrolling upward", async () => {
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValueOnce(
        response(HISTORY_A, 0, [commit(0), commit(1), commit(2)])
      )
      .mockResolvedValueOnce(
        response(HISTORY_A, 6, [commit(6), commit(7), commit(8)])
      )
      .mockResolvedValueOnce(
        response(HISTORY_A, 3, [commit(3), commit(4), commit(5)])
      );
    const { result } = renderHistory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));

    act(() =>
      result.current.onRangeChange({
        visibleStartIndex: 6,
        visibleEndIndex: 8,
        overscanStartIndex: 6,
        overscanEndIndex: 8,
        startIndex: 6,
        endIndex: 8,
      })
    );
    await waitFor(() =>
      expect(result.current.getCommit(6)?.hash).toBe("hash-6")
    );

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
      expect(result.current.getCommit(3)?.hash).toBe("hash-3")
    );
    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([
      0, 6, 3,
    ]);
  });

  it("discards a stale response after the repository, branch hint, or detached state changes", async () => {
    const first = deferred<WorkspaceCommitLogResponse>();
    const second = deferred<WorkspaceCommitLogResponse>();
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      (props: { repo: string; branchHint: string; detached: boolean }) =>
        usePagedCommitHistory({ ...props, pageSize: 3, fetchPage }),
      {
        initialProps: {
          repo: "repo-a",
          branchHint: "main",
          detached: false,
        },
      }
    );

    rerender({ repo: "repo-b", branchHint: "release", detached: true });
    await act(async () => {
      first.resolve(response(HISTORY_A, 0, [commit(0)]));
      second.resolve(response(HISTORY_B, 0, [commit(9)], true));
      await Promise.all([first.promise, second.promise]);
    });

    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_B));
    expect(result.current.repo).toBe("repo-b");
    expect(result.current.branchHint).toBe("release");
    expect(result.current.currentBranch).toBeNull();
    expect(result.current.detached).toBe(true);
    expect(result.current.getCommit(0)?.hash).toBe("hash-9");
  });

  it("populates the initial listing even when the caller's detached guess was wrong", async () => {
    // The caller's `detached` option is the store's last-known state (`false`
    // by default) — a guess for the very first request, not a confirmed
    // fact. The workspace can already be in detached HEAD before the pane
    // ever mounts (e.g. reopening on a repo left detached from a prior
    // session), in which case the server's response legitimately disagrees
    // with that guess. The response must still populate the listing —
    // nothing else will ever correct a wrong initial guess otherwise.
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValue(response(HISTORY_A, 0, [commit(0)], true, 1));
    const { result } = renderHook(() =>
      usePagedCommitHistory({
        repo: "repo-a",
        detached: false,
        pageSize: 3,
        fetchPage,
      })
    );

    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));
    expect(result.current.detached).toBe(true);
    expect(result.current.currentBranch).toBeNull();
    expect(result.current.getCommit(0)?.hash).toBe("hash-0");
  });

  it("does not let an in-flight page from an old frozen listing shift the refreshed view", async () => {
    const stalePage = deferred<WorkspaceCommitLogResponse>();
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValueOnce(
        response(HISTORY_A, 0, [commit(0), commit(1), commit(2)])
      )
      .mockReturnValueOnce(stalePage.promise)
      .mockResolvedValueOnce(response(HISTORY_B, 0, [commit(9)]));
    const { result } = renderHistory(fetchPage);

    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));
    act(() => result.current.requestRange(3));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_B));

    await act(async () => {
      stalePage.resolve(
        response(HISTORY_A, 3, [commit(3), commit(4), commit(5)])
      );
      await stalePage.promise;
    });

    expect(result.current.listingId).toBe(HISTORY_B);
    expect(result.current.getCommit(0)?.hash).toBe("hash-9");
    expect(result.current.getCommit(3)).toBeUndefined();
  });

  it("keeps a failed page retryable without clearing loaded pages", async () => {
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValueOnce(
        response(HISTORY_A, 0, [commit(0), commit(1), commit(2)])
      )
      .mockRejectedValueOnce(new Error("page failed"))
      .mockResolvedValueOnce(
        response(HISTORY_A, 3, [commit(3), commit(4), commit(5)])
      );
    const { result } = renderHistory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));

    act(() => result.current.requestRange(3));
    await waitFor(() => expect(result.current.failedRanges).toHaveLength(1));
    expect(result.current.getCommit(0)?.hash).toBe("hash-0");

    act(() => result.current.retryPage(4));
    await waitFor(() =>
      expect(result.current.getCommit(4)?.hash).toBe("hash-4")
    );
    expect(result.current.failedRanges).toEqual([]);
  });

  it("keeps out-of-order page requests aligned and does not retain an unaligned failure", async () => {
    const fetchPage = vi.fn<PagedCommitHistoryFetcher>((request) => {
      if (request.offset === 0) {
        return Promise.resolve({
          ...response(
            HISTORY_A,
            0,
            Array.from({ length: 30 }, (_, i) => commit(i)),
            false,
            1007
          ),
          pageSize: 30,
        });
      }
      if (request.offset === 960) {
        return Promise.resolve({
          ...response(
            HISTORY_A,
            960,
            Array.from({ length: 30 }, (_, i) => commit(960 + i)),
            false,
            1007
          ),
          pageSize: 30,
        });
      }
      if (request.offset === 990) {
        return Promise.resolve({
          ...response(
            HISTORY_A,
            990,
            Array.from({ length: 17 }, (_, i) => commit(990 + i)),
            false,
            1007
          ),
          pageSize: 30,
        });
      }
      if (request.offset === 60) {
        return Promise.resolve({
          ...response(
            HISTORY_A,
            60,
            Array.from({ length: 30 }, (_, i) => commit(60 + i)),
            false,
            1007
          ),
          pageSize: 30,
        });
      }
      return Promise.reject(new Error(`unexpected offset ${request.offset}`));
    });
    const { result } = renderHook(() =>
      usePagedCommitHistory({
        repo: "repo-a",
        branchHint: "main",
        detached: false,
        pageSize: 30,
        fetchPage,
      })
    );

    await waitFor(() => expect(result.current.loadedCount).toBe(30));
    act(() => result.current.requestRange(990));
    await waitFor(() =>
      expect(result.current.getCommit(990)?.hash).toBe("hash-990")
    );
    act(() => result.current.requestRange(960));
    await waitFor(() =>
      expect(result.current.getCommit(960)?.hash).toBe("hash-960")
    );
    act(() =>
      result.current.onRangeChange({
        visibleStartIndex: 77,
        visibleEndIndex: 77,
        overscanStartIndex: 77,
        overscanEndIndex: 77,
        startIndex: 77,
        endIndex: 77,
      })
    );

    await waitFor(() => expect(result.current.inFlightOffsets).toEqual([]));
    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([
      0, 990, 960, 60,
    ]);
    expect(
      fetchPage.mock.calls.every(([request]) => request.offset % 30 === 0)
    ).toBe(true);
    expect(result.current.failedRanges).toEqual([]);
  });

  it("does not duplicate an aligned page request while it is in flight", async () => {
    const continuation = deferred<WorkspaceCommitLogResponse>();
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValueOnce({
        ...response(
          HISTORY_A,
          0,
          Array.from({ length: 10 }, (_, i) => commit(i)),
          false,
          30
        ),
        pageSize: 10,
        hasMore: true,
      })
      .mockReturnValueOnce(continuation.promise);
    const { result } = renderHook(() =>
      usePagedCommitHistory({
        repo: "repo-a",
        branchHint: "main",
        detached: false,
        pageSize: 10,
        fetchPage,
      })
    );
    await waitFor(() => expect(result.current.loadedCount).toBe(10));

    const range = {
      visibleStartIndex: 10,
      visibleEndIndex: 12,
      overscanStartIndex: 10,
      overscanEndIndex: 12,
      startIndex: 10,
      endIndex: 12,
    };
    act(() => result.current.onRangeChange(range));
    act(() => result.current.onRangeChange(range));

    expect(fetchPage).toHaveBeenCalledTimes(2);
    await act(async () => {
      continuation.resolve({
        ...response(
          HISTORY_A,
          10,
          Array.from({ length: 10 }, (_, i) => commit(10 + i)),
          false,
          30
        ),
        pageSize: 10,
        hasMore: true,
      });
      await continuation.promise;
    });
  });

  it("does not repeat an empty page that still reports more history", async () => {
    const fetchPage = vi.fn<PagedCommitHistoryFetcher>().mockResolvedValue({
      ...response(HISTORY_A, 0, [], false, 10),
      hasMore: true,
    });
    const { result } = renderHistory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));
    act(() =>
      result.current.onRangeChange({
        visibleStartIndex: 0,
        visibleEndIndex: 2,
        overscanStartIndex: 0,
        overscanEndIndex: 2,
        startIndex: 0,
        endIndex: 2,
      })
    );

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("continues paging by hasMore when the server omits a total", async () => {
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 0, [commit(0), commit(1), commit(2)]),
        totalEntries: undefined as unknown as number,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        ...response(HISTORY_A, 3, [commit(3)]),
        totalEntries: undefined as unknown as number,
        hasMore: false,
      });
    const { result } = renderHistory(fetchPage);

    await waitFor(() =>
      expect(result.current.getCommit(0)?.hash).toBe("hash-0")
    );
    act(() => result.current.requestRange(3));
    await waitFor(() =>
      expect(result.current.getCommit(3)?.hash).toBe("hash-3")
    );
    expect(fetchPage.mock.calls[1]?.[0].offset).toBe(3);
  });

  it("refreshes the current context as a new frozen listing", async () => {
    const fetchPage = vi
      .fn<PagedCommitHistoryFetcher>()
      .mockResolvedValueOnce(response(HISTORY_A, 0, [commit(0)]))
      .mockResolvedValueOnce(response(HISTORY_B, 0, [commit(1)]));
    const { result } = renderHistory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_A));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.listingId).toBe(HISTORY_B));
    expect(fetchPage.mock.calls[1][0]).toMatchObject({
      repo: "repo-a",
      branchHint: "main",
      detached: false,
      offset: 0,
      pageSize: 3,
    });
    expect(result.current.getCommit(0)?.hash).toBe("hash-1");
  });
});
