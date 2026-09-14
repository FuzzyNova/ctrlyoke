import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SaveWorkflowDialog } from "@components/workflow/SaveWorkflowDialog";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { WORKFLOW_FILE_FORMATS } from "@/types/messages";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

vi.hoisted(() => {
  window.__ctrlyokeStandalone = true;
});

describe("SaveWorkflowDialog Browse in the hosted browser (isStandalone)", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        workspaceRoot: "C:/dev/ctrlyoke",
      },
    }));
  });

  afterEach(cleanup);

  it("opens the hosted file browser at the workspace root, not the raw absolute path", () => {
    useUiStore.getState().openSaveWorkflowDialog({
      requestId: "save-1",
      address: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      title: "Save workflow",
      defaultPath: "C:\\dev\\ctrlyoke\\workflow.ctrlyoke.yaml",
      defaultFormat: WORKFLOW_FILE_FORMATS.YAML,
    });

    render(<SaveWorkflowDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    expect(useUiStore.getState().fileBrowserState?.initialPath).toBe("");
  });

  it("strips the workspace root prefix down to a workspace-relative subdirectory", () => {
    useUiStore.getState().openSaveWorkflowDialog({
      requestId: "save-2",
      address: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      title: "Save workflow",
      defaultPath: "C:\\dev\\ctrlyoke\\sub\\dir\\workflow.ctrlyoke.yaml",
      defaultFormat: WORKFLOW_FILE_FORMATS.YAML,
    });

    render(<SaveWorkflowDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    expect(useUiStore.getState().fileBrowserState?.initialPath).toBe("sub/dir");
  });
});
