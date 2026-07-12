import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowPropertiesPanel } from "@components/layout/WorkflowPropertiesPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";

function resetStores(): void {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useUiStore.setState({ settingsCollapsed: false });
}

describe("WorkflowPropertiesPanel permissions", () => {
  beforeEach(resetStores);

  afterEach(cleanup);

  it("shows the global permission mode when a new workflow has no override", () => {
    useSettingsStore.getState().updateGlobalSetting("toolPermissions", {
      mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
      allowedTools: [],
      deniedTools: [],
    });

    render(<WorkflowPropertiesPanel />);

    fireEvent.click(screen.getByTitle("Permissions"));

    expect(
      screen.getByText("Dangerously Allow All (yolo)")
    ).toBeInTheDocument();
  });
});
