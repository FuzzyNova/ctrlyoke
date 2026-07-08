/**
 * Tests for workspaceViewerStore — focusing on the pending-navigation actions
 * added to support CodeMirror link clicks opening the workspace viewer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

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
    expect(nav?.type).toBe("file");
    if (nav?.type === "file") {
      expect(nav.filePath).toBe("src/foo.ts");
      expect(nav.startLine).toBeUndefined();
      expect(nav.endLine).toBeUndefined();
    }
  });

  it("stores optional line range for selection", () => {
    store().openToFile("src/bar.ts", 10, 20);
    const nav = store().pendingNavigation;
    if (nav?.type === "file") {
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
    expect(nav?.type).toBe("directory");
    if (nav?.type === "directory") {
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
