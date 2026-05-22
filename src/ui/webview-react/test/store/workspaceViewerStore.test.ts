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
