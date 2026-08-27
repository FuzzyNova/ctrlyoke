import { describe, expect, it, vi, afterEach } from "vitest";
import {
  HostedHttpError,
  workspaceGitRefDiffPage,
  workspaceTree,
} from "@utils/hostedApi";
import {
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
} from "@root/types/HostedWorkspaceViewerTypes";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hostedApi workspaceTree", () => {
  it("serializes initial and range requests and forwards AbortSignal", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ entries: [] })))
      );
    const signal = new AbortController().signal;

    await workspaceTree(
      {
        path: "src",
        pageSize: 25,
        includeGitIgnored: false,
        anchorPath: "src/index.ts",
        sort: {
          key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
          direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
        },
      },
      signal
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/workspace-viewer/tree?path=src&includeGitIgnored=false&pageSize=25&anchorPath=src%2Findex.ts&sortKey=modifiedAt&sortDirection=descending"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal });

    await workspaceTree({
      listingId: "00000000-0000-4000-8000-000000000001",
      offset: 50,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/workspace-viewer/tree?listingId=00000000-0000-4000-8000-000000000001&offset=50"
    );
  });

  it("retains the HTTP status on hosted errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("expired", { status: 410 }))
    );

    try {
      await workspaceTree({ path: "", includeGitIgnored: true });
    } catch (error) {
      expect(error).toBeInstanceOf(HostedHttpError);
      expect((error as HostedHttpError).status).toBe(410);
    }
  });
});

describe("hostedApi workspaceGitRefDiffPage", () => {
  it("serializes initial and continuation requests with diffId-vs-pageSize handling", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ entries: [] })))
      );

    await workspaceGitRefDiffPage("~abcdef0", 0, 12, undefined, "repo-a");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/workspace-viewer/git-ref-diff-page?ref=%7Eabcdef0&offset=0&pageSize=12&repo=repo-a"
    );

    await workspaceGitRefDiffPage("~abcdef0", 12, 12, "diff-1", "repo-a");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/workspace-viewer/git-ref-diff-page?ref=%7Eabcdef0&offset=12&diffId=diff-1&repo=repo-a"
    );
  });
});
