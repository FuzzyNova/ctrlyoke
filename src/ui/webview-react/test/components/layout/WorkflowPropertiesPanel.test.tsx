import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowPropertiesPanel } from "@components/layout/WorkflowPropertiesPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";

const postMessage = vi.fn();

function resetStores(): void {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useUiStore.setState({ settingsCollapsed: false });
}

describe("WorkflowPropertiesPanel permissions", () => {
  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

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

describe("WorkflowPropertiesPanel inherited defaults", () => {
  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
    useSettingsStore.getState().updateGlobalSetting("mcpServers", ["ctrlyoke"]);
    useSettingsStore
      .getState()
      .updateGlobalSetting("hooks", [
        { event: "postToolUse", command: "npm run format" },
      ]);
    useSettingsStore.getState().updateGlobalSetting("defaultPreCondition", {
      script: "test -f package.json",
      returns: "true",
    });
    useSettingsStore.getState().updateGlobalSetting("defaultEndCondition", {
      script: "npm test",
      returns: "true",
    });
  });

  afterEach(cleanup);

  it("shows global MCP, hooks, and condition defaults before a workflow override exists", () => {
    render(<WorkflowPropertiesPanel />);

    expect(screen.getByTitle("MCP")).toHaveClass("text-focus-border");
    expect(screen.getByTitle("Hooks")).toHaveClass("text-focus-border");
    expect(screen.getByTitle("Validation")).toHaveClass("text-focus-border");

    fireEvent.click(screen.getByTitle("MCP"));
    expect(screen.getByLabelText("ctrlyoke enabled")).toBeChecked();

    fireEvent.click(screen.getByTitle("Hooks"));
    expect(screen.getByDisplayValue("npm run format")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Validation"));
    expect(screen.getByLabelText("Enable Pre-Condition")).toBeChecked();
    expect(screen.getByLabelText("Enable End Condition")).toBeChecked();
    expect(
      screen.getByDisplayValue("test -f package.json")
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("npm test")).toBeInTheDocument();
  });

  it("persists null to explicitly disable inherited conditions", () => {
    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByTitle("Validation"));

    fireEvent.click(screen.getByLabelText("Enable Pre-Condition"));
    fireEvent.click(screen.getByLabelText("Enable End Condition"));

    expect(useSettingsStore.getState().workflowProperties).toMatchObject({
      preCondition: null,
      endCondition: null,
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "updateWorkflowProperty",
      property: "preCondition",
      value: null,
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "updateWorkflowProperty",
      property: "endCondition",
      value: null,
    });
  });

  it("marks Validation when only a global pre-condition is configured", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("defaultEndCondition", null);

    render(<WorkflowPropertiesPanel />);

    expect(screen.getByTitle("Validation")).toHaveClass("text-focus-border");
  });
});
