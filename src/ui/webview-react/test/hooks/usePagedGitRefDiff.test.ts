import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PagedGitRefDiffFetcher,
  usePagedGitRefDiff,
} from "@hooks/usePagedGitRefDiff";
import type {
  WorkspaceGitRefDiffEntry,
  WorkspaceGitRefDiffPageResponse,
} from "@root/types/HostedWorkspaceViewerTypes";

const DIFF_A = "00000000-0000-4000-8000-000000000001";
const DIFF_B = "00000000-0000-4000-8000-000000000002";

function entry(index: number): WorkspaceGitRefDiffEntry {
  return {
    path: `src/file-${index}.ts`,
    changeType: "modified",
    payloadKind: "text",
    oldContent: `old ${index}`,
    newContent: `new ${index}`,
  };
}

function response(
  diffId: string,
  offset: number,
  entries: WorkspaceGitRefDiffEntry[],
  totalEntries = 10
): WorkspaceGitRefDiffPageResponse {
  return {
    diffId,
    pageSize: 3,
    totalEntries,
    offset,
    entries,
    commitInfo: {
      hash: "abcdef0123456789",
      shortHash: "abcdef0",
      subject: "Test commit",
      body: "",
      author: "Author",
      authorEmail: "author@example.com",
      date: "today",
      relativeDate: "today",
    },
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

function renderDiff(fetchPage: PagedGitRefDiffFetcher) {
  return renderHook(() =>
    usePagedGitRefDiff({
      ref: "~abcdef0123456789",
      repo: "repo-a",
      pageSize: 3,
      fetchPage,
    })
  );
}

afterEach(() => vi.restoreAllMocks());

describe("usePagedGitRefDiff", () => {
  it("requests only the initial page and pages covering a visible overscan range", async () => {
    const fetchPage = vi
      .fn<PagedGitRefDiffFetcher>()
      .mockResolvedValue(response(DIFF_A, 0, [entry(0), entry(1), entry(2)]));
    const { result } = renderDiff(fetchPage);

    await waitFor(() => expect(result.current.listingId).toBe(DIFF_A));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.refLabel).toBe("Commit abcdef0");
    expect(result.current.commitInfo?.hash).toBe("abcdef0123456789");

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

  it.each([
    ["~diff", "Working Tree Changes"],
    ["~staged", "Staged Changes"],
    ["~stash:2", "Stash #2"],
    ["~abcdef0123456789", "Commit abcdef0"],
  ])("derives the %s ref label", (ref, label) => {
    const fetchPage = vi
      .fn<PagedGitRefDiffFetcher>()
      .mockResolvedValue(response(DIFF_A, 0, []));
    const { result } = renderHook(() =>
      usePagedGitRefDiff({ ref, fetchPage })
    );

    expect(result.current.refLabel).toBe(label);
  });

  it("requests older pages when scrolling upward", async () => {
    const fetchPage = vi
      .fn<PagedGitRefDiffFetcher>()
      .mockResolvedValueOnce(response(DIFF_A, 0, [entry(0), entry(1), entry(2)]))
      .mockResolvedValueOnce(response(DIFF_A, 6, [entry(6), entry(7), entry(8)]))
      .mockResolvedValueOnce(response(DIFF_A, 3, [entry(3), entry(4), entry(5)]));
    const { result } = renderDiff(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(DIFF_A));

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
    await waitFor(() => expect(result.current.getEntry(6)?.path).toBe("src/file-6.ts"));

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
    await waitFor(() => expect(result.current.getEntry(3)?.path).toBe("src/file-3.ts"));
    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([
      0, 6, 3,
    ]);
  });

  it("discards a stale response after a ref/repository generation changes", async () => {
    const first = deferred<WorkspaceGitRefDiffPageResponse>();
    const second = deferred<WorkspaceGitRefDiffPageResponse>();
    const fetchPage = vi
      .fn<PagedGitRefDiffFetcher>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      (props: { ref: string; repo: string }) =>
        usePagedGitRefDiff({ ...props, pageSize: 3, fetchPage }),
      { initialProps: { ref: "~first", repo: "repo-a" } }
    );

    rerender({ ref: "~second", repo: "repo-b" });
    await act(async () => {
      first.resolve(response(DIFF_A, 0, [entry(0)]));
      second.resolve(response(DIFF_B, 0, [entry(9)]));
      await Promise.all([first.promise, second.promise]);
    });

    await waitFor(() => expect(result.current.listingId).toBe(DIFF_B));
    expect(result.current.ref).toBe("~second");
    expect(result.current.getEntry(0)?.path).toBe("src/file-9.ts");
  });

  it("keeps a failed page retryable without clearing loaded pages", async () => {
    const fetchPage = vi
      .fn<PagedGitRefDiffFetcher>()
      .mockResolvedValueOnce(response(DIFF_A, 0, [entry(0), entry(1), entry(2)]))
      .mockRejectedValueOnce(new Error("page failed"))
      .mockResolvedValueOnce(response(DIFF_A, 3, [entry(3), entry(4), entry(5)]));
    const { result } = renderDiff(fetchPage);
    await waitFor(() => expect(result.current.listingId).toBe(DIFF_A));

    act(() => result.current.requestRange(3));
    await waitFor(() => expect(result.current.failedRanges).toHaveLength(1));
    expect(result.current.getEntry(0)?.path).toBe("src/file-0.ts");

    act(() => result.current.retryPage(4));
    await waitFor(() =>
      expect(result.current.getEntry(4)?.path).toBe("src/file-4.ts")
    );
    expect(result.current.failedRanges).toEqual([]);
  });
});
