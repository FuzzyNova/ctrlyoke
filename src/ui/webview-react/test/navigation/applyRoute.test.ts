import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyRoute, isApplyingRoute } from "@/navigation/applyRoute";
import { MESSAGE_TYPES } from "@/types/messages";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type { WorkflowSummary } from "@root/types/CtrlYokeTypes";

function fakeVsCode() {
  return { postMessage: vi.fn() };
}

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useUiStore.getState().setLoadedWorkflows([]);
  useUiStore.getState().setActiveWorkflowWorkingFilePath(null);
});

describe("applyRoute — workspace viewer", () => {
  it("opens an explorer file route with pending navigation", () => {
    applyRoute(
      { viewer: "explorer", file: "src/a.ts", lines: [3, 9] },
      fakeVsCode()
    );
    const wv = useWorkspaceViewerStore.getState();
    expect(wv.isOpen).toBe(true);
    expect(wv.activeTab).toBe("explorer");
    expect(wv.pendingNavigation).toEqual({
      type: "file",
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 9,
    });
  });

  it("opens an explorer directory route", () => {
    applyRoute({ viewer: "explorer", dir: "src/sub" }, fakeVsCode());
    const wv = useWorkspaceViewerStore.getState();
    expect(wv.isOpen).toBe(true);
    expect(wv.pendingNavigation).toEqual({
      type: "directory",
      dirPath: "src/sub",
    });
  });

  it("selects the diff file on a source-control route", () => {
    applyRoute({ viewer: "sourceControl", file: "src/a.ts" }, fakeVsCode());
    const wv = useWorkspaceViewerStore.getState();
    expect(wv.isOpen).toBe(true);
    expect(wv.activeTab).toBe("sourceControl");
    expect(wv.selectedDiffPath).toBe("src/a.ts");
    // pendingDiff is set so the SCM pane reloads the diff content.
    expect(wv.pendingDiff).toBe("src/a.ts");
  });

  it("opens a git-ref diff on a source-control ref route", () => {
    applyRoute({ viewer: "sourceControl", ref: "abc123" }, fakeVsCode());
    const wv = useWorkspaceViewerStore.getState();
    expect(wv.isOpen).toBe(true);
    expect(wv.activeTab).toBe("sourceControl");
    expect(wv.diffRef).toBe("abc123");
  });

  it("closes the viewer when the route has no viewer", () => {
    useWorkspaceViewerStore.getState().open();
    applyRoute({ workflow: "a.yaml" }, fakeVsCode());
    expect(useWorkspaceViewerStore.getState().isOpen).toBe(false);
  });

  it("clears the applying guard after returning", () => {
    applyRoute({ viewer: "explorer", file: "src/a.ts" }, fakeVsCode());
    expect(isApplyingRoute()).toBe(false);
  });
});

describe("applyRoute — workflow", () => {
  it("posts LOAD_WORKFLOW when the path is not already loaded", () => {
    const api = fakeVsCode();
    applyRoute({ workflow: "src/m.yaml" }, api);
    expect(useUiStore.getState().activeWorkflowWorkingFilePath).toBe(
      "src/m.yaml"
    );
    expect(api.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_WORKFLOW,
      filePath: "src/m.yaml",
    });
  });

  it("posts SWITCH_WORKFLOW when the path matches a loaded workflow", () => {
    useUiStore
      .getState()
      .setLoadedWorkflows([
        { id: "w1", workingFilePath: "src/m.yaml" } as unknown as WorkflowSummary,
      ]);
    const api = fakeVsCode();
    applyRoute({ workflow: "src/m.yaml" }, api);
    expect(api.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SWITCH_WORKFLOW,
      workflowId: "w1",
    });
  });

  it("does nothing when the workflow is already active", () => {
    useUiStore.getState().setActiveWorkflowWorkingFilePath("src/m.yaml");
    const api = fakeVsCode();
    applyRoute({ workflow: "src/m.yaml" }, api);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  // Regression: routes are forward-slash normalized, but loadedWorkflows carry
  // native paths (backslashes on Windows). Back/forward to a running workflow
  // must still resolve to its live instance via SWITCH_WORKFLOW — otherwise it
  // falls through to LOAD_WORKFLOW and the workflow is reloaded as STOPPED.
  it("matches a loaded workflow whose path uses native separators", () => {
    useUiStore.getState().setLoadedWorkflows([
      {
        id: "w1",
        workingFilePath: "c:\\dev\\proj\\.ctrlyoke\\.queue\\m.ctrlyoke.json",
      } as unknown as WorkflowSummary,
    ]);
    const api = fakeVsCode();
    applyRoute(
      { workflow: "c:/dev/proj/.ctrlyoke/.queue/m.ctrlyoke.json" },
      api
    );
    expect(api.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SWITCH_WORKFLOW,
      workflowId: "w1",
    });
  });

  it("treats a separator-only difference as already active (no-op)", () => {
    useUiStore
      .getState()
      .setActiveWorkflowWorkingFilePath("c:\\dev\\proj\\m.ctrlyoke.json");
    const api = fakeVsCode();
    applyRoute({ workflow: "c:/dev/proj/m.ctrlyoke.json" }, api);
    expect(api.postMessage).not.toHaveBeenCalled();
  });
});
