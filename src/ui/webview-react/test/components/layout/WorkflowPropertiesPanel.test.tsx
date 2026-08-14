import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowPropertiesPanel } from "@components/layout/WorkflowPropertiesPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  PERMISSION_MODES,
  WORKTREE_KEEP_HELP_TEXT,
  WORKTREE_MODE_HELP_TEXT,
  WORKTREE_MODES,
} from "@root/types/DashboardConstants";

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

  it("keeps authored tool lists editable for a mode-only harness", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.CODEX_CLI);
    useSettingsStore.getState().updateWorkflowProperty("toolPermissions", {
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: ["shell(git:*)"],
      deniedTools: ["shell(rm:*)"],
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByTitle("Permissions"));

    expect(screen.getByLabelText("Allowed Tools")).not.toBeDisabled();
    expect(screen.getByLabelText("Denied Tools")).not.toBeDisabled();
  });

  it("preserves authored lists when the workflow harness changes", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.CODEX_CLI);
    useSettingsStore.getState().updateWorkflowProperty("toolPermissions", {
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: ["shell(git:*)"],
      deniedTools: ["shell(rm:*)"],
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByTitle("Permissions"));
    expect(screen.getByLabelText("Allowed Tools")).toHaveValue("shell(git:*)");

    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.ANTIGRAVITY_CLI);

    expect(screen.getByLabelText("Allowed Tools")).toHaveValue("shell(git:*)");
    expect(screen.getByLabelText("Denied Tools")).toHaveValue("shell(rm:*)");
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

describe("WorkflowPropertiesPanel execution mode", () => {
  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  it("renders the effective value and posts workflow overrides", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("executionMode", EXECUTION_MODES.HEADLESS);

    render(<WorkflowPropertiesPanel />);

    const executionMode = screen.getByRole("button", {
      name: "Execution Mode",
    });
    expect(executionMode).toHaveTextContent("Headless");
    expect(
      screen.queryByTitle("Set this as the default for new workflows")
    ).toBeNull();

    fireEvent.click(executionMode);
    fireEvent.click(screen.getByText("Interactive").closest("button")!);

    expect(useSettingsStore.getState().workflowProperties.executionMode).toBe(
      EXECUTION_MODES.INTERACTIVE
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: "updateWorkflowProperty",
      property: "executionMode",
      value: EXECUTION_MODES.INTERACTIVE,
    });
  });

  it("shows Set as Default only when the workflow value differs from global", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("executionMode", EXECUTION_MODES.HEADLESS);

    useSettingsStore
      .getState()
      .updateWorkflowProperty("executionMode", EXECUTION_MODES.INTERACTIVE);

    render(<WorkflowPropertiesPanel />);
    expect(
      screen.getByTitle("Set this as the default for new workflows")
    ).toBeInTheDocument();
  });
});

describe("WorkflowPropertiesPanel worktree authoring", () => {
  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  function chooseWorktreeMode(label: string): void {
    fireEvent.click(screen.getByLabelText("Worktree"));
    fireEvent.click(screen.getByRole("button", { name: label }));
  }

  it("renders None as one control and keeps the prompt drawer free of worktree", async () => {
    render(<WorkflowPropertiesPanel />);

    expect(screen.getByLabelText("Worktree")).toHaveTextContent("None");
    expect(screen.queryByLabelText("Worktree branch")).not.toBeInTheDocument();
    expect(screen.getByText("Worktree", { selector: "label" })).toHaveAttribute(
      "title",
      WORKTREE_MODE_HELP_TEXT
    );
  });

  it("reveals only Named fields and seeds them from the settings default", () => {
    useSettingsStore.getState().updateGlobalSetting("worktree", {
      mode: WORKTREE_MODES.NAMED,
      branch: "ui-work",
      base: "main",
      setup: "npm ci",
    });

    render(<WorkflowPropertiesPanel />);
    chooseWorktreeMode("Named");

    expect(screen.getByLabelText("Worktree branch")).toHaveValue("ui-work");
    expect(screen.getByLabelText("Worktree base")).toHaveValue("main");
    expect(screen.getByLabelText("Worktree setup")).toHaveValue("npm ci");
    expect(screen.queryByText(/Keep directory/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Merge on done/i)).not.toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateWorkflowProperties",
        properties: {
          worktree: {
            mode: WORKTREE_MODES.NAMED,
            branch: "ui-work",
            base: "main",
            setup: "npm ci",
          },
        },
      })
    );
  });

  it("reveals Managed base/setup/keep/merge, seeds them from defaults, and explains undo", () => {
    useSettingsStore.getState().updateGlobalSetting("worktree", {
      mode: WORKTREE_MODES.MANAGED,
      base: "main",
      setup: "npm ci",
      keep: true,
      merge: true,
    });

    render(<WorkflowPropertiesPanel />);
    chooseWorktreeMode("Managed");

    expect(screen.getByLabelText("Worktree base")).toHaveValue("main");
    expect(screen.getByLabelText("Worktree setup")).toHaveValue("npm ci");
    expect(screen.getByLabelText("Keep directory")).toBeChecked();
    expect(screen.getByLabelText("Merge")).toBeChecked();
    expect(screen.queryByLabelText("Worktree branch")).not.toBeInTheDocument();
    expect(
      screen.getByText("Keep directory", { selector: "label" })
    ).toHaveAttribute("title", WORKTREE_KEEP_HELP_TEXT);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateWorkflowProperties",
        properties: {
          worktree: {
            mode: WORKTREE_MODES.MANAGED,
            base: "main",
            setup: "npm ci",
            keep: true,
            merge: true,
          },
        },
      })
    );
  });

  it("surfaces an empty named branch as a field diagnostic", () => {
    useSettingsStore.getState().updateWorkflowProperty("worktree", {
      mode: WORKTREE_MODES.NAMED,
      branch: "",
    });

    render(<WorkflowPropertiesPanel />);

    expect(
      screen.getByText("Branch is required for named worktree mode.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Worktree branch")).toHaveClass(
      "border-input-error-border"
    );
  });

  it("records a mode change and its seeded fields as one undo entry", () => {
    useSettingsStore.getState().updateGlobalSetting("worktree", {
      mode: WORKTREE_MODES.NAMED,
      branch: "ui-work",
      base: "main",
      setup: "npm ci",
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "workflow.ctrlyoke.yaml",
      workflowName: "Workflow",
      steps: [],
    });

    render(<WorkflowPropertiesPanel />);
    chooseWorktreeMode("Named");

    expect(useWorkflowStore.temporal.getState().pastStates).toHaveLength(1);
  });

  it("treats absent, false, and none as the same default", () => {
    useSettingsStore.getState().updateGlobalSetting("worktree", {
      mode: WORKTREE_MODES.NONE,
    });
    useSettingsStore.getState().updateWorkflowProperty("worktree", false);
    render(<WorkflowPropertiesPanel />);

    const worktreeField =
      screen.getByLabelText("Worktree").parentElement?.parentElement;
    expect(
      worktreeField?.querySelector(
        '[title="Set this as the default for new workflows"]'
      )
    ).toBeNull();
  });

  it("normalizes the legacy none sentinel for default comparison", () => {
    useSettingsStore.getState().updateGlobalSetting("worktree", {
      mode: WORKTREE_MODES.NONE,
    });
    useSettingsStore
      .getState()
      .updateWorkflowProperty("worktree", "none" as never);
    render(<WorkflowPropertiesPanel />);

    const worktreeField =
      screen.getByLabelText("Worktree").parentElement?.parentElement;
    expect(
      worktreeField?.querySelector(
        '[title="Set this as the default for new workflows"]'
      )
    ).toBeNull();
  });

  it("resets worktree together with the other workflow properties", () => {
    useSettingsStore.getState().updateGlobalSetting("worktree", {
      mode: WORKTREE_MODES.NAMED,
      branch: "default-branch",
    });
    useSettingsStore.getState().updateWorkflowProperty("worktree", false);
    render(<WorkflowPropertiesPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Reset all to defaults" })
    );

    expect(useSettingsStore.getState().workflowProperties.worktree).toEqual({
      mode: WORKTREE_MODES.NAMED,
      branch: "default-branch",
      base: undefined,
      setup: undefined,
    });
  });
});
