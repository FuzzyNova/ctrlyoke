import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PagedWorkspaceDirectoryFetcher,
  usePagedWorkspaceDirectory,
} from "@hooks/usePagedWorkspaceDirectory";
import { HostedHttpError } from "@utils/hostedApi";
import {
  DEFAULT_WORKSPACE_ENTRY_SORT,
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
} from "@root/types/HostedWorkspaceViewerTypes";
import type {
  WorkspaceEntrySort,
  WorkspaceTreeEntry,
  WorkspaceTreePageResponse,
} from "@root/types/HostedWorkspaceViewerTypes";

const LISTING_A = "00000000-0000-4000-8000-000000000001";
const LISTING_B = "00000000-0000-4000-8000-000000000002";

function entry(index: number, path = `file-${index}.ts`): WorkspaceTreeEntry {
  return { name: path, path, kind: "file" };
}

function response(
  listingId: string,
  offset: number,
  entries: WorkspaceTreeEntry[],
  totalEntries = 10,
  path = "src"
): WorkspaceTreePageResponse {
  return {
    listingId,
    pageSize: 3,
    rootLabel: "repo",
    path,
    parentPath: "",
    isGitRepo: true,
    isRootsList: false,
    totalEntries,
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

function initialResponse(listingId = LISTING_A, path = "src") {
  return response(listingId, 0, [entry(0), entry(1), entry(2)], 10, path);
}

function renderDirectory(
  fetchPage: PagedWorkspaceDirectoryFetcher,
  pageSize?: number,
  options: { sort?: WorkspaceEntrySort; anchorPath?: string } = {}
) {
  return renderHook(
    (props: {
      path: string;
      includeGitIgnored?: boolean;
      sort?: WorkspaceEntrySort;
      anchorPath?: string;
    }) =>
      usePagedWorkspaceDirectory({
        path: props.path,
        includeGitIgnored: props.includeGitIgnored ?? true,
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(props.sort === undefined ? {} : { sort: props.sort }),
        ...(props.anchorPath === undefined
          ? {}
          : { anchorPath: props.anchorPath }),
        fetchPage,
      }),
    {
      initialProps: {
        path: "src",
        includeGitIgnored: true,
        ...options,
      },
    }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePagedWorkspaceDirectory", () => {
  it("aligns viewport ranges and looks up sparse entries in O(1)", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValue(initialResponse());
    const { result } = renderDirectory(fetchPage);

    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({
      path: "src",
      sort: DEFAULT_WORKSPACE_ENTRY_SORT,
    });
    expect(result.current.getEntry(1)?.path).toBe("file-1.ts");
    expect(result.current.getEntry(4)).toBeUndefined();

    act(() => {
      result.current.onRangeChange({
        visibleStartIndex: 3,
        visibleEndIndex: 4,
        overscanStartIndex: 3,
        overscanEndIndex: 5,
        startIndex: 3,
        endIndex: 4,
      });
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      { listingId: LISTING_A, offset: 3 },
      expect.any(AbortSignal)
    );
  });

  it("requests a far end page directly and prefetches only in scroll direction", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValue(initialResponse());
    const { result } = renderDirectory(fetchPage, 3);
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));
    fetchPage.mockResolvedValue(response(LISTING_A, 9, [entry(9)]));

    act(() => {
      result.current.onRangeChange({
        visibleStartIndex: 9,
        visibleEndIndex: 9,
        overscanStartIndex: 9,
        overscanEndIndex: 9,
        startIndex: 9,
        endIndex: 9,
      });
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      { listingId: LISTING_A, offset: 9 },
      expect.any(AbortSignal)
    );
  });

  it("replays viewport ranges observed while the initial page is loading", async () => {
    const initial = deferred<WorkspaceTreePageResponse>();
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(response(LISTING_A, 9, [entry(9)]));
    const { result } = renderDirectory(fetchPage, 3);

    act(() => {
      result.current.onRangeChange({
        visibleStartIndex: 9,
        visibleEndIndex: 9,
        overscanStartIndex: 9,
        overscanEndIndex: 9,
        startIndex: 9,
        endIndex: 9,
      });
    });
    await act(async () => {
      initial.resolve(initialResponse());
      await initial.promise;
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(result.current.getEntry(9)?.path).toBe("file-9.ts")
    );
    expect(fetchPage).toHaveBeenLastCalledWith(
      { listingId: LISTING_A, offset: 9 },
      expect.any(AbortSignal)
    );
  });

  it("deduplicates repeated in-flight range requests", async () => {
    const range = deferred<WorkspaceTreePageResponse>();
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValueOnce(initialResponse())
      .mockReturnValueOnce(range.promise);
    const { result } = renderDirectory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));

    act(() => {
      result.current.requestRange(4);
      result.current.requestRange(5);
    });
    expect(
      fetchPage.mock.calls.filter(
        ([request]) => "offset" in request && request.offset === 3
      )
    ).toHaveLength(1);
    expect(result.current.inFlightOffsets).toEqual([3]);

    await act(async () => {
      range.resolve(response(LISTING_A, 3, [entry(3), entry(4), entry(5)]));
      await range.promise;
    });
    await waitFor(() =>
      expect(result.current.getEntry(4)?.path).toBe("file-4.ts")
    );
  });

  it("aborts and ignores stale navigation responses", async () => {
    const first = deferred<WorkspaceTreePageResponse>();
    const second = deferred<WorkspaceTreePageResponse>();
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderDirectory(fetchPage);

    act(() => result.current.navigate("other"));
    expect(first.promise).toBeDefined();
    expect((fetchPage.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);

    await act(async () => {
      first.resolve(initialResponse(LISTING_A, "src"));
      second.resolve(initialResponse(LISTING_B, "other"));
      await Promise.all([first.promise, second.promise]);
    });
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_B));
    expect(result.current.path).toBe("other");
  });

  it("ignores responses with the wrong path, listing, or options", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValue(initialResponse());
    const { result, rerender } = renderDirectory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));

    fetchPage.mockResolvedValue(
      response(LISTING_A, 3, [entry(3)], 10, "wrong")
    );
    act(() => result.current.requestRange(3));
    await waitFor(() => expect(result.current.inFlightOffsets).toEqual([]));
    expect(result.current.getEntry(3)).toBeUndefined();

    const staleOptions = deferred<WorkspaceTreePageResponse>();
    fetchPage.mockReturnValueOnce(staleOptions.promise);
    act(() => result.current.requestRange(3));
    fetchPage.mockResolvedValueOnce(initialResponse(LISTING_B));
    rerender({ path: "src", includeGitIgnored: false });
    await act(async () => {
      staleOptions.resolve(response(LISTING_A, 3, [entry(3)]));
      await staleOptions.promise;
    });
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_B));
    expect(result.current.getEntry(3)).toBeUndefined();
  });

  it("restarts exactly once for a sort change, preserves the path, and restores the visible anchor", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValueOnce(initialResponse())
      .mockResolvedValueOnce(
        response(LISTING_B, 0, [entry(0), entry(1), entry(2)], 10)
      );
    const { result, rerender } = renderDirectory(fetchPage, 3);

    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));
    act(() => {
      result.current.onRangeChange({
        visibleStartIndex: 1,
        visibleEndIndex: 2,
        overscanStartIndex: 0,
        overscanEndIndex: 2,
        startIndex: 1,
        endIndex: 2,
      });
    });

    rerender({
      path: "src",
      includeGitIgnored: true,
      sort: {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
      },
    });

    await waitFor(() => expect(result.current.listingId).toBe(LISTING_B));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.path).toBe("src");
    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({
      path: "src",
      anchorPath: "file-1.ts",
      sort: {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
      },
    });
    expect(result.current.scrollRestoration).toMatchObject({
      index: 1,
      offset: 0,
    });
  });

  it("does not reload for an anchor-only prop change", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValue(initialResponse());
    const { result, rerender } = renderDirectory(fetchPage, undefined, {
      anchorPath: "file-0.ts",
    });

    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));
    rerender({
      path: "src",
      includeGitIgnored: true,
      anchorPath: "file-2.ts",
    });

    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale sort response after aborting the previous generation", async () => {
    const first = deferred<WorkspaceTreePageResponse>();
    const second = deferred<WorkspaceTreePageResponse>();
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderDirectory(fetchPage);

    rerender({
      path: "src",
      includeGitIgnored: true,
      sort: {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
      },
    });
    expect((fetchPage.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);

    await act(async () => {
      first.resolve(initialResponse(LISTING_A));
      second.resolve(initialResponse(LISTING_B));
      await Promise.all([first.promise, second.promise]);
    });

    await waitFor(() => expect(result.current.listingId).toBe(LISTING_B));
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("reports progress and preserves loaded rows when a page fails", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValueOnce(initialResponse())
      .mockRejectedValueOnce(new Error("page failed"));
    const { result } = renderDirectory(fetchPage);
    await waitFor(() => expect(result.current.uniqueLoadedCount).toBe(3));

    act(() => result.current.requestRange(3));
    await waitFor(() => expect(result.current.failedRanges).toHaveLength(1));
    expect(result.current.failedRanges[0]).toMatchObject({
      offset: 3,
      endOffset: 6,
    });
    expect(result.current.getEntry(0)?.path).toBe("file-0.ts");
    expect(result.current.uniqueLoadedCount).toBe(3);
  });

  it("retries exactly the failed page without retrying other loaded pages", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValueOnce(initialResponse())
      .mockRejectedValueOnce(new Error("page failed"))
      .mockResolvedValueOnce(
        response(LISTING_A, 3, [entry(3), entry(4), entry(5)])
      );
    const { result } = renderDirectory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));
    act(() => result.current.requestRange(3));
    await waitFor(() => expect(result.current.failedRanges).toHaveLength(1));

    act(() => result.current.retryPage(4));
    await waitFor(() =>
      expect(result.current.getEntry(4)?.path).toBe("file-4.ts")
    );
    expect(result.current.failedRanges).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("refreshes around an anchor and exposes one-shot scroll restoration", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValueOnce(initialResponse())
      .mockResolvedValueOnce(
        response(LISTING_B, 3, [entry(3, "anchor.ts"), entry(4)], 10)
      );
    const { result } = renderDirectory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));

    act(() => result.current.refresh({ anchorPath: "anchor.ts" }));
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_B));
    expect(result.current.scrollRestoration).toMatchObject({
      index: 3,
      offset: 3,
    });
    act(() => result.current.consumeScrollRestoration());
    expect(result.current.scrollRestoration).toBeNull();
    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({
      path: "src",
      anchorPath: "anchor.ts",
    });
  });

  it("restarts once on an expired range using the nearest loaded anchor", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValueOnce(initialResponse())
      .mockRejectedValueOnce(new HostedHttpError(410, "expired"))
      .mockResolvedValueOnce(
        response(LISTING_B, 0, [entry(0), entry(1, "file-1.ts"), entry(2)], 10)
      );
    const { result } = renderDirectory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));

    act(() => {
      result.current.onRangeChange({
        visibleStartIndex: 4,
        visibleEndIndex: 4,
        overscanStartIndex: 4,
        overscanEndIndex: 4,
        startIndex: 4,
        endIndex: 4,
      });
    });
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_B));
    expect(fetchPage.mock.calls[2]?.[0]).toMatchObject({
      path: "src",
      anchorPath: "file-2.ts",
    });
  });

  it("turns a repeated expiration into inline retry state", async () => {
    const fetchPage = vi
      .fn<PagedWorkspaceDirectoryFetcher>()
      .mockResolvedValueOnce(initialResponse())
      .mockRejectedValueOnce(new HostedHttpError(410, "expired"))
      .mockRejectedValueOnce(new HostedHttpError(410, "expired again"));
    const { result } = renderDirectory(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(LISTING_A));
    act(() => result.current.requestRange(3));

    await waitFor(() =>
      expect(result.current.initialError?.message).toBe("expired again")
    );
    expect(result.current.isInitialLoading).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
