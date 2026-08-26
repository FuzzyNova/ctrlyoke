/**
 * Tests for workspaceViewerStore — focusing on the pending-navigation actions
 * added to support CodeMirror link clicks opening the workspace viewer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { WORKSPACE_ENTRY_KINDS } from "@root/types/DashboardConstants";

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
});

function store() {
  return useWorkspaceViewerStore.getState();
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("pendingNavigation starts null", () => {
    expect(store().pendingNavigation).toBeNull();
  });

  it("modal starts closed", () => {
    expect(store().isOpen).toBe(false);
  });

  it("search state starts with its defaults", () => {
    expect(store().searchQuery).toBe("");
    expect(store().searchScope).toBe("both");
    expect(store().searchIncludeGitIgnored).toBe(false);
    expect(store().searchResults).toEqual([]);
    expect(store().searchLoading).toBe(false);
    expect(store().searchTruncated).toBe(false);
  });
});

describe("search state", () => {
  it("updates each search field through its setter", () => {
    const result = {
      kind: WORKSPACE_ENTRY_KINDS.FILE,
      path: "src/search.ts",
      name: "search.ts",
    };

    store().setSearchQuery("search");
    store().setSearchScope("content");
    store().setSearchIncludeGitIgnored(true);
    store().setSearchResults([result]);
    store().setSearchLoading(true);
    store().setSearchTruncated(true);

    expect(store().searchQuery).toBe("search");
    expect(store().searchScope).toBe("content");
    expect(store().searchIncludeGitIgnored).toBe(true);
    expect(store().searchResults).toEqual([result]);
    expect(store().searchLoading).toBe(true);
    expect(store().searchTruncated).toBe(true);
  });

  it('accepts the "search" active tab', () => {
    store().setActiveTab("search");
    expect(store().activeTab).toBe("search");
  });

  it("close clears transient search state but preserves file drafts", () => {
    useWorkspaceViewerStore.setState({
      fileDrafts: { "src/draft.ts": { content: "draft" } },
    });
    store().setSearchQuery("query");
    store().setSearchResults([
      {
        kind: WORKSPACE_ENTRY_KINDS.FILE,
        path: "src/query.ts",
        name: "query.ts",
      },
    ]);
    store().setSearchLoading(true);
    store().setSearchTruncated(true);

    store().close();

    expect(store().searchQuery).toBe("");
    expect(store().searchResults).toEqual([]);
    expect(store().searchLoading).toBe(false);
    expect(store().searchTruncated).toBe(false);
    expect(store().fileDrafts).toEqual({
      "src/draft.ts": { content: "draft" },
    });
  });
});

// ---------------------------------------------------------------------------
// openToFile
// ---------------------------------------------------------------------------

describe("openToFile", () => {
  it("opens the modal on the explorer tab", () => {
    store().openToFile("src/foo.ts");
    expect(store().isOpen).toBe(true);
    expect(store().activeTab).toBe("explorer");
  });

  it("sets a file pending navigation with the given path", () => {
    store().openToFile("src/foo.ts");
    const nav = store().pendingNavigation;
    expect(nav).not.toBeNull();
    expect(nav?.type).toBe(WORKSPACE_ENTRY_KINDS.FILE);
    if (nav?.type === WORKSPACE_ENTRY_KINDS.FILE) {
      expect(nav.filePath).toBe("src/foo.ts");
      expect(nav.startLine).toBeUndefined();
      expect(nav.endLine).toBeUndefined();
    }
  });

  it("stores optional line range for selection", () => {
    store().openToFile("src/bar.ts", 10, 20);
    const nav = store().pendingNavigation;
    if (nav?.type === WORKSPACE_ENTRY_KINDS.FILE) {
      expect(nav.startLine).toBe(10);
      expect(nav.endLine).toBe(20);
    }
  });

  it("switches to explorer tab even when modal was on source-control tab", () => {
    store().setActiveTab("sourceControl");
    store().openToFile("src/baz.ts");
    expect(store().activeTab).toBe("explorer");
  });
});

// ---------------------------------------------------------------------------
// openToDirectory
// ---------------------------------------------------------------------------

describe("openToDirectory", () => {
  it("opens the modal on the explorer tab", () => {
    store().openToDirectory("src/ui");
    expect(store().isOpen).toBe(true);
    expect(store().activeTab).toBe("explorer");
  });

  it("sets a directory pending navigation", () => {
    store().openToDirectory("src/components");
    const nav = store().pendingNavigation;
    expect(nav).not.toBeNull();
    expect(nav?.type).toBe(WORKSPACE_ENTRY_KINDS.DIRECTORY);
    if (nav?.type === WORKSPACE_ENTRY_KINDS.DIRECTORY) {
      expect(nav.dirPath).toBe("src/components");
    }
  });
});

// ---------------------------------------------------------------------------
// clearPendingNavigation
// ---------------------------------------------------------------------------

describe("clearPendingNavigation", () => {
  it("resets pendingNavigation to null", () => {
    store().openToFile("src/foo.ts");
    expect(store().pendingNavigation).not.toBeNull();

    store().clearPendingNavigation();
    expect(store().pendingNavigation).toBeNull();
  });

  it("is a no-op when pendingNavigation is already null", () => {
    expect(store().pendingNavigation).toBeNull();
    store().clearPendingNavigation();
    expect(store().pendingNavigation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reset clears pendingNavigation
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("clears pendingNavigation along with other state", () => {
    store().openToFile("src/foo.ts");
    store().reset();
    expect(store().pendingNavigation).toBeNull();
    expect(store().isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Commit history state
// ---------------------------------------------------------------------------

const sampleCommit = {
  hash: "abc1234567890abcdef",
  shortHash: "abc1234",
  subject: "feat: add commit history panel",
  author: "Dev",
  relativeDate: "2 days ago",
  isHead: true,
  pushed: true,
  refs: [],
  isMerge: false,
  parentHashes: [],
};

describe("setCommitHistory", () => {
  it("sets commits, hasMore, currentBranch, and detached", () => {
    store().setCommitHistory([sampleCommit], true, "main", false);
    const s = store();
    expect(s.commitHistory).toHaveLength(1);
    expect(s.commitHistoryHasMore).toBe(true);
    expect(s.currentBranch).toBe("main");
    expect(s.detached).toBe(false);
  });

  it("sets detached=true when in detached HEAD state", () => {
    store().setCommitHistory([sampleCommit], false, null, true);
    expect(store().detached).toBe(true);
    expect(store().currentBranch).toBeNull();
  });
});

describe("appendCommitHistory", () => {
  it("appends new commits to existing history", () => {
    store().setCommitHistory([sampleCommit], true, "main", false);
    const extra = {
      ...sampleCommit,
      hash: "def456",
      shortHash: "def456",
      subject: "fix: bug",
    };
    store().appendCommitHistory([extra], false);
    expect(store().commitHistory).toHaveLength(2);
    expect(store().commitHistoryHasMore).toBe(false);
  });
});

describe("setCommitHistoryLoading", () => {
  it("sets loading flag", () => {
    store().setCommitHistoryLoading(true);
    expect(store().commitHistoryLoading).toBe(true);
    store().setCommitHistoryLoading(false);
    expect(store().commitHistoryLoading).toBe(false);
  });
});

describe("setPreviousBranch", () => {
  it("stores and clears the previousBranch", () => {
    store().setPreviousBranch("main");
    expect(store().previousBranch).toBe("main");
    store().setPreviousBranch(null);
    expect(store().previousBranch).toBeNull();
  });
});

describe("selectDiff", () => {
  it("clears any active multi-file git-ref diff", () => {
    useWorkspaceViewerStore.setState({
      diffFiles: [],
      diffRefLabel: "Commit abc1234",
      diffRefLoading: true,
    });

    store().selectDiff("src/file.ts");

    expect(store().selectedDiffPath).toBe("src/file.ts");
    expect(store().diffFiles).toBeNull();
    expect(store().diffRefLabel).toBeNull();
    expect(store().diffRefLoading).toBe(false);
  });
});

describe("close() clears commit history loading", () => {
  it("resets commitHistoryLoading on close", () => {
    store().setCommitHistoryLoading(true);
    store().close();
    expect(store().commitHistoryLoading).toBe(false);
  });

  it("resets diffFiles and diffRefLoading on close", () => {
    store().close();
    expect(store().diffFiles).toBeNull();
    expect(store().diffRefLabel).toBeNull();
    expect(store().diffRefLoading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// openToDiff + diffRef (navigation deep-link / back-forward restore)
// ---------------------------------------------------------------------------

describe("openToDiff", () => {
  it("opens the source-control tab with a pending diff", () => {
    store().openToDiff("src/file.ts");
    expect(store().isOpen).toBe(true);
    expect(store().activeTab).toBe("sourceControl");
    expect(store().selectedDiffPath).toBe("src/file.ts");
    expect(store().pendingDiff).toBe("src/file.ts");
  });

  it("clears any active ref-diff view", () => {
    store().openToDiff("src/file.ts");
    expect(store().diffRef).toBeNull();
    expect(store().diffFiles).toBeNull();
    expect(store().diffRefLabel).toBeNull();
  });

  it("clearPendingDiff resets the pending diff", () => {
    store().openToDiff("src/file.ts");
    store().clearPendingDiff();
    expect(store().pendingDiff).toBeNull();
  });
});

describe("diffRef tracking", () => {
  it("selectDiff clears diffRef", () => {
    useWorkspaceViewerStore.setState({ diffRef: "abc123" });
    store().selectDiff("src/file.ts");
    expect(store().diffRef).toBeNull();
  });

  it("clearDiff clears diffRef and pendingDiff", () => {
    useWorkspaceViewerStore.setState({ diffRef: "abc123", pendingDiff: "x" });
    store().clearDiff();
    expect(store().diffRef).toBeNull();
    expect(store().pendingDiff).toBeNull();
  });

  it("close clears diffRef and pendingDiff", () => {
    useWorkspaceViewerStore.setState({ diffRef: "abc123", pendingDiff: "x" });
    store().close();
    expect(store().diffRef).toBeNull();
    expect(store().pendingDiff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setLoadedImage
// ---------------------------------------------------------------------------

describe("setLoadedImage", () => {
  it("loads an image data URI as a read-only, non-dirty selection", () => {
    store().setLoadedImage("images/logo.png", "data:image/png;base64,AAAA");
    expect(store().selectedFilePath).toBe("images/logo.png");
    expect(store().fileImageDataUri).toBe("data:image/png;base64,AAAA");
    expect(store().fileContent).toBe("");
    expect(store().fileDirty).toBe(false);
  });

  it("is cleared when a normal text file is loaded afterwards", () => {
    store().setLoadedImage("images/logo.png", "data:image/png;base64,AAAA");
    store().setLoadedFileContent("src/app.ts", "export const x = 1;");
    expect(store().fileImageDataUri).toBeNull();
    expect(store().fileContent).toBe("export const x = 1;");
  });
});

// ---------------------------------------------------------------------------
// setRepos — repo selector defaulting
// ---------------------------------------------------------------------------

describe("setRepos", () => {
  const repo = (id: string) => ({ id, label: id, rootPath: `/${id}` });
  // Identity prefix→id map for the common case where a root's folder name
  // equals the repo id.
  const identityMap = (...ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, id]));

  it("defaults the selection to the first repo when nothing is selected", () => {
    store().setRepos(
      [repo("alpha"), repo("beta")],
      identityMap("alpha", "beta")
    );
    expect(store().selectedRepoId).toBe("alpha");
  });

  it("keeps the current selection when it is still present", () => {
    store().setRepos(
      [repo("alpha"), repo("beta")],
      identityMap("alpha", "beta")
    );
    store().setSelectedRepoId("beta");
    store().setRepos(
      [repo("alpha"), repo("beta"), repo("gamma")],
      identityMap("alpha", "beta", "gamma")
    );
    expect(store().selectedRepoId).toBe("beta");
  });

  it("re-defaults when the current selection disappears", () => {
    store().setRepos(
      [repo("alpha"), repo("beta")],
      identityMap("alpha", "beta")
    );
    store().setSelectedRepoId("beta");
    store().setRepos(
      [repo("alpha"), repo("gamma")],
      identityMap("alpha", "gamma")
    );
    expect(store().selectedRepoId).toBe("alpha");
  });

  it("follows the open file's root when no selection is valid", () => {
    // A folder-name-prefixed diff path identifies its repo by first segment.
    store().selectDiff("beta/src/index.ts");
    store().setRepos(
      [repo("alpha"), repo("beta")],
      identityMap("alpha", "beta")
    );
    expect(store().selectedRepoId).toBe("beta");
  });

  it("follows the open file when the prefix differs from the repo id", () => {
    // A root nested below its git toplevel prefixes with its folder name
    // ("frontend") while the repo id is the toplevel basename ("monorepo").
    // The server-supplied map is authoritative — matching label/id would miss.
    store().selectDiff("frontend/src/index.ts");
    store().setRepos([repo("monorepo"), repo("other")], {
      frontend: "monorepo",
      backend: "monorepo",
    });
    expect(store().selectedRepoId).toBe("monorepo");
  });

  it("falls back to the first repo when the prefix has no mapping", () => {
    store().selectDiff("unmapped/src/index.ts");
    store().setRepos(
      [repo("alpha"), repo("beta")],
      identityMap("alpha", "beta")
    );
    expect(store().selectedRepoId).toBe("alpha");
  });
});

describe("openToFileHistory", () => {
  it("opens Source Control with a normalized, repo-scoped pending request", () => {
    store().setSelectedRepoId("repo-b");
    store().openToFileHistory("src\\file.ts");

    expect(store().activeTab).toBe("sourceControl");
    expect(store().fileHistoryPath).toBe("src/file.ts");
    expect(store().fileHistoryRepoId).toBe("repo-b");
    expect(store().pendingFileHistory).toEqual({
      path: "src/file.ts",
      repoId: "repo-b",
      generation: 1,
    });
  });

  it("bumps its generation and leaves only the newest request current", () => {
    store().openToFileHistory("src/first.ts");
    const staleRequest = store().pendingFileHistory;

    store().openToFileHistory("src/second.ts");

    expect(store().fileHistoryGeneration).toBe(2);
    expect(store().pendingFileHistory?.path).toBe("src/second.ts");
    expect(store().pendingFileHistory?.generation).not.toBe(
      staleRequest?.generation
    );
  });

  it("does not change mobile diff visibility", () => {
    store().setMobileDiffVisible(false);
    store().openToFileHistory("src/file.ts");
    expect(store().mobileDiffVisible).toBe(false);
  });
});
