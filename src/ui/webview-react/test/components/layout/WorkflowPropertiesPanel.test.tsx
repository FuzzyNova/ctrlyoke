import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WorkflowPropertiesPanel } from "@components/layout/WorkflowPropertiesPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import { defineWorkflowVariable } from "@utils/workflowVars";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  PERMISSION_MODES,
  PROMPT_PROPERTIES,
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
  useSecretRegistryStore.getState().resetSecretRegistry();
}

describe("WorkflowPropertiesPanel permissions", () => {
  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  it("labels workflow fields with their workflow-relative schema path", () => {
    render(<WorkflowPropertiesPanel />);

    const fieldLabel = screen.getByText("Harness", { selector: "label" });
    expect(fieldLabel).toHaveAttribute(
      "title",
      expect.stringContaining("property: harness")
    );
    expect(fieldLabel).toHaveAttribute(
      "aria-label",
      "Harness, property harness"
    );
  });

  it("supports inherited, unlimited, and custom workflow step caps", () => {
    useSettingsStore.getState().updateGlobalSetting("maxSteps", 100);
    useSettingsStore.getState().updateWorkflowProperty("maxSteps", 7);
    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));

    const maxSteps = () =>
      screen.getByRole("button", { name: /property maxSteps/ });
    expect(maxSteps()).toHaveTextContent("Custom");

    fireEvent.click(maxSteps());
    fireEvent.click(screen.getByRole("button", { name: /^Inherit \(100\)/ }));
    expect(
      useSettingsStore.getState().workflowProperties.maxSteps
    ).toBeUndefined();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        property: PROMPT_PROPERTIES.MAX_STEPS,
        value: undefined,
      })
    );

    fireEvent.click(maxSteps());
    fireEvent.click(screen.getByRole("button", { name: /^Unlimited/ }));
    expect(useSettingsStore.getState().workflowProperties.maxSteps).toBe(-1);

    fireEvent.click(maxSteps());
    const customOptions = screen.getAllByRole("button", { name: /^Custom/ });
    fireEvent.click(customOptions[customOptions.length - 1]);
    expect(useSettingsStore.getState().workflowProperties.maxSteps).toBe(100);
    expect(screen.getByLabelText(/^Max Steps Custom/)).toHaveValue(100);
  });

  it.each([
    [100, "Inherit (100)"],
    [-1, "Inherit (Unlimited)"],
  ])(
    "shows the resolved global step cap in the inherit label",
    (value, label) => {
      useSettingsStore.getState().updateGlobalSetting("maxSteps", value);
      render(<WorkflowPropertiesPanel />);
      fireEvent.click(screen.getByRole("tab", { name: "Validation" }));

      expect(
        screen.getByRole("button", { name: /property maxSteps/ })
      ).toHaveTextContent(label);
    }
  );

  it("prefills Custom from the inherited cap, using 100 when it is unlimited", () => {
    useSettingsStore.getState().updateGlobalSetting("maxSteps", 42);
    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));

    fireEvent.click(screen.getByRole("button", { name: /property maxSteps/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));
    expect(screen.getByLabelText(/^Max Steps Custom/)).toHaveValue(42);

    act(() => {
      useSettingsStore.getState().updateGlobalSetting("maxSteps", -1);
      useSettingsStore.getState().updateWorkflowProperty("maxSteps", undefined);
    });
    fireEvent.click(screen.getByRole("button", { name: /property maxSteps/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));
    expect(screen.getByLabelText(/^Max Steps Custom/)).toHaveValue(100);
  });

  it("shows Set as Default only for a present step cap that differs globally", () => {
    useSettingsStore.getState().updateGlobalSetting("maxSteps", 100);
    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));

    expect(
      screen.queryByRole("button", { name: "Set as Default" })
    ).not.toBeInTheDocument();

    act(() => {
      useSettingsStore.getState().updateWorkflowProperty("maxSteps", 100);
    });
    expect(
      screen.queryByRole("button", { name: "Set as Default" })
    ).not.toBeInTheDocument();

    act(() => {
      useSettingsStore.getState().updateWorkflowProperty("maxSteps", 50);
    });
    expect(
      screen.getByRole("button", { name: "Set as Default" })
    ).toBeInTheDocument();
  });

  it("posts the raw unlimited value when setting Max Steps as default", () => {
    useSettingsStore.getState().updateGlobalSetting("maxSteps", 100);
    useSettingsStore.getState().updateWorkflowProperty("maxSteps", -1);
    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));

    fireEvent.click(screen.getByRole("button", { name: "Set as Default" }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.SET_AS_DEFAULT,
        property: PROMPT_PROPERTIES.MAX_STEPS,
        value: -1,
      })
    );
  });

  it("shows the global permission mode when a new workflow has no override", () => {
    useSettingsStore.getState().updateGlobalSetting("toolPermissions", {
      mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
      allowedTools: [],
      deniedTools: [],
    });

    render(<WorkflowPropertiesPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

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
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    expect(screen.getByLabelText("Allowed Tools")).not.toBeDisabled();
    expect(screen.getByLabelText("Denied Tools")).not.toBeDisabled();
  });

  it("reflects effective secret grants and shows the active summary", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "API_TOKEN",
        scope: "workspace",
        state: "managed-and-set",
        usedBy: { mcpServers: [], workflows: [] },
      },
      {
        name: "OTHER_TOKEN",
        scope: "workspace",
        state: "from-environment-and-detected",
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    useSettingsStore
      .getState()
      .updateWorkflowProperty("secrets", ["API_TOKEN"]);

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Secrets, property secrets" })
    );

    expect(
      screen.getByRole("button", { name: "API_TOKEN" })
    ).toBeInTheDocument();
    expect(screen.getByText("Active: API_TOKEN")).toBeInTheDocument();
  });

  it("locks inline-referenced names and keeps them granted after null clears inheritance", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "INLINE_TOKEN",
        scope: "workspace",
        state: "managed-and-set",
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    useSettingsStore.getState().updateWorkflowProperty("secrets", null);
    useWorkflowStore.getState().loadWorkflow({
      fileName: "workflow.ctrlyoke.yaml",
      workflowName: "Inline secret workflow",
      steps: [{ prompt: "Use !INLINE_TOKEN", secrets: null }],
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Secrets, property secrets" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "INLINE_TOKENGranted by prompt text" })
    );

    expect(screen.getByText("Granted by prompt text")).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "INLINE_TOKENGranted by prompt text" })
        .querySelector("input")
    ).toBeDisabled();
    expect(screen.getByText("Active: INLINE_TOKEN")).toBeInTheDocument();
    expect(useSettingsStore.getState().getEffectiveSecrets()).toEqual([]);
  });

  it("shows the default affordance when secret arrays differ", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("secrets", ["DEFAULT_TOKEN"]);
    useSettingsStore
      .getState()
      .updateWorkflowProperty("secrets", ["WORKFLOW_TOKEN"]);

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    expect(
      screen.getByRole("button", { name: /Set as Default/ })
    ).toBeInTheDocument();
  });

  it("surfaces an unresolved granted secret as a field diagnostic", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "MISSING_TOKEN",
        scope: "workspace",
        state: "from-environment-and-not-found",
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    useSettingsStore
      .getState()
      .updateWorkflowProperty("secrets", ["MISSING_TOKEN"]);

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    expect(
      screen.getByText(
        'Secret "MISSING_TOKEN" is not available from the managed registry or environment.'
      )
    ).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    expect(screen.getByLabelText("Allowed Tools")).toHaveTextContent(
      "shell(git:*)"
    );

    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.ANTIGRAVITY_CLI);

    expect(screen.getByLabelText("Allowed Tools")).toHaveTextContent(
      "shell(git:*)"
    );
    expect(screen.getByLabelText("Denied Tools")).toHaveTextContent(
      "shell(rm:*)"
    );
  });

  it("seeds all inherited roots when switching trusted roots to Custom", async () => {
    const userRoot = "/home/user/library";
    const workspaceRoot = "/workspace/shared";
    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      externalFileRootsByScope: {
        user: [userRoot],
        workspace: [{ path: workspaceRoot, decision: "allow" }],
      },
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    fireEvent.click(
      screen.getByRole("button", { name: /^Trusted External Roots/ })
    );
    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));

    expect(
      screen.getByTestId(`trusted-root-row-${userRoot}`)
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`trusted-root-row-${workspaceRoot}`)
    ).toBeInTheDocument();

    const pathInput = screen.getByRole("textbox", {
      name: "External directory path",
    });
    fireEvent.change(pathInput, { target: { value: "/workflow/only" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const messages = postMessage.mock.calls
      .map(
        ([message]) =>
          message as {
            properties?: { trustedExternalRoots?: unknown };
          }
      )
      .filter((message) =>
        Object.prototype.hasOwnProperty.call(
          message.properties ?? {},
          "trustedExternalRoots"
        )
      );
    expect(
      messages[messages.length - 1]?.properties?.trustedExternalRoots
    ).toEqual([userRoot, workspaceRoot, "/workflow/only"]);
  });

  it("excludes pending and denied workspace roots from the inherited set", () => {
    const userRoot = "/home/user/library";
    const approvedRoot = "/workspace/shared";
    const pendingRoot = "/workspace/undecided";
    const deniedRoot = "/workspace/rejected";
    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      externalFileRootsByScope: {
        user: [userRoot],
        workspace: [
          { path: approvedRoot, decision: "allow" },
          { path: pendingRoot },
          { path: deniedRoot, decision: "deny" },
        ],
      },
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    expect(
      screen.getByText("Inherit (Custom)", { exact: false })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /^Trusted External Roots/ })
    );
    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));

    expect(
      screen.getByTestId(`trusted-root-row-${userRoot}`)
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`trusted-root-row-${approvedRoot}`)
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`trusted-root-row-${pendingRoot}`)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`trusted-root-row-${deniedRoot}`)
    ).not.toBeInTheDocument();
  });
});

describe("WorkflowPropertiesPanel variables", () => {
  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  it("renders variables loaded from the workflow", () => {
    useSettingsStore.getState().setWorkflowProperties({
      vars: { region: "us-east-1", retries: "3" },
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));

    expect(screen.getByLabelText("Name for region")).toHaveValue("region");
    expect(screen.getByLabelText("Value for region")).toHaveValue("us-east-1");
    expect(screen.getByLabelText("Name for retries")).toHaveValue("retries");
    expect(screen.getByLabelText("Value for retries")).toHaveValue("3");
  });

  it("posts a new variable through workflow-property updates", () => {
    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));

    fireEvent.click(screen.getByRole("button", { name: "+ Add variable" }));
    const name = screen.getByLabelText("variable name");
    fireEvent.change(name, { target: { value: "region" } });
    fireEvent.blur(name);
    const value = screen.getByLabelText("Value for region");
    fireEvent.change(value, { target: { value: "us-east-1" } });
    fireEvent.blur(value);

    expect(postMessage).toHaveBeenLastCalledWith({
      type: "updateWorkflowProperty",
      property: "vars",
      value: { region: "us-east-1" },
    });
  });

  it("round-trips an edited variable value", () => {
    useSettingsStore.getState().setWorkflowProperties({
      vars: { region: "us-east-1" },
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    const value = screen.getByLabelText("Value for region");
    fireEvent.change(value, { target: { value: "eu-west-1" } });
    fireEvent.blur(value);

    expect(useSettingsStore.getState().workflowProperties.vars).toEqual({
      region: "eu-west-1",
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "updateWorkflowProperty",
      property: "vars",
      value: { region: "eu-west-1" },
    });
  });

  it("opens the Context page and focuses a variable the editor asks to reveal", async () => {
    useSettingsStore.getState().setWorkflowProperties({
      vars: { region: "us-east-1", retries: "3" },
    });
    render(<WorkflowPropertiesPanel />);

    act(() => {
      useUiStore.getState().revealWorkflowVariable("retries", {
        mobile: false,
      });
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Value for retries")).toHaveFocus()
    );
    expect(useUiStore.getState().workflowVariableRevealRequest).toBeNull();
  });

  it("adds an undefined variable with an empty value for the editor's quick fix", async () => {
    useSettingsStore.getState().setWorkflowProperties({
      vars: { region: "us-east-1" },
    });
    render(<WorkflowPropertiesPanel />);

    act(() => {
      defineWorkflowVariable({ postMessage }, "testvar");
      useUiStore.getState().revealWorkflowVariable("testvar", {
        mobile: false,
      });
    });

    expect(postMessage).toHaveBeenLastCalledWith({
      type: "updateWorkflowProperty",
      property: "vars",
      value: { region: "us-east-1", testvar: "" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Value for testvar")).toHaveFocus()
    );
  });

  it("removes vars when every variable is cleared", () => {
    useSettingsStore.getState().setWorkflowProperties({
      vars: { region: "us-east-1" },
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete region" }));

    expect(useSettingsStore.getState().workflowProperties.vars).toBeUndefined();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "updateWorkflowProperty",
      property: "vars",
      value: undefined,
    });
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
      expected: "true",
    });
    useSettingsStore.getState().updateGlobalSetting("defaultEndCondition", {
      script: "npm test",
      expected: "true",
    });
  });

  afterEach(cleanup);

  it("shows global MCP, hooks, and condition defaults before a workflow override exists", () => {
    render(<WorkflowPropertiesPanel />);

    expect(screen.getByRole("tab", { name: "MCP" })).toHaveClass(
      "text-focus-border"
    );
    expect(screen.getByRole("tab", { name: "Hooks" })).toHaveClass(
      "text-focus-border"
    );
    expect(screen.getByRole("tab", { name: "Validation" })).toHaveClass(
      "text-focus-border"
    );

    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(screen.getByLabelText("ctrlyoke enabled")).toBeChecked();

    fireEvent.click(screen.getByRole("tab", { name: "Hooks" }));
    expect(screen.getByText("npm run format")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));
    expect(screen.getByLabelText("Enable Pre-Condition")).toBeChecked();
    expect(screen.getByLabelText("Enable End Condition")).toBeChecked();
    expect(document.getElementById("settings-pre-script")).toHaveTextContent(
      "test -f package.json"
    );
    expect(document.getElementById("settings-end-script")).toHaveTextContent(
      "npm test"
    );
  });

  it("persists null to explicitly disable inherited conditions", () => {
    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));

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

    expect(screen.getByRole("tab", { name: "Validation" })).toHaveClass(
      "text-focus-border"
    );
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
      name: /^Execution Mode/,
    });
    expect(executionMode).toHaveTextContent("Headless");
    expect(screen.queryByRole("button", { name: /Set as Default/ })).toBeNull();

    fireEvent.click(executionMode);
    fireEvent.click(screen.getByRole("button", { name: /^Interactive,/ }));

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
      screen.getByRole("button", { name: /Set as Default/ })
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
    fireEvent.click(
      screen.getByRole("button", { name: /^Worktree, property worktree/ })
    );
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`^${label}`) })
    );
  }

  it("renders None as one control and keeps the prompt drawer free of worktree", async () => {
    render(<WorkflowPropertiesPanel />);

    expect(
      screen.getByRole("button", { name: /^Worktree, property worktree/ })
    ).toHaveTextContent("None");
    expect(screen.queryByLabelText("Worktree branch")).not.toBeInTheDocument();
    expect(screen.getByText("Worktree", { selector: "label" })).toHaveAttribute(
      "title",
      expect.stringContaining("property: worktree")
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

    expect(screen.getByLabelText("Worktree branch")).toHaveTextContent(
      "ui-work"
    );
    expect(screen.getByLabelText("Worktree base")).toHaveTextContent("main");
    expect(screen.getByLabelText("Worktree setup")).toHaveTextContent("npm ci");
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

    expect(screen.getByLabelText("Worktree base")).toHaveTextContent("main");
    expect(screen.getByLabelText("Worktree setup")).toHaveTextContent("npm ci");
    expect(screen.getByLabelText("Keep directory")).toBeChecked();
    expect(screen.getByLabelText("Merge")).toBeChecked();
    expect(screen.queryByLabelText("Worktree branch")).not.toBeInTheDocument();
    expect(
      screen.getByText("Keep directory", { selector: "label" })
    ).toHaveAttribute(
      "title",
      expect.stringContaining("property: worktree.keep")
    );
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

  it("keeps worktree setup single-line and blurs on Enter", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().updateGlobalSetting("worktree", {
      mode: WORKTREE_MODES.NAMED,
      branch: "ui-work",
      base: "main",
      setup: "npm ci",
    });

    render(<WorkflowPropertiesPanel />);
    chooseWorktreeMode("Named");

    const setup = screen.getByLabelText("Worktree setup");
    await user.click(setup);
    await user.keyboard("{Enter}");

    expect(setup).toHaveTextContent("npm ci");
    expect(setup).not.toHaveTextContent("\n");
    expect(setup).not.toHaveFocus();
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
    const branch = screen.getByLabelText("Worktree branch");
    expect(branch.parentElement?.parentElement?.parentElement).toHaveClass(
      "border-input-error-border"
    );
  });

  it("commits branch edits on blur and links its diagnostic", () => {
    useSettingsStore.getState().updateWorkflowProperty("worktree", {
      mode: WORKTREE_MODES.NAMED,
      branch: "",
    });

    render(<WorkflowPropertiesPanel />);

    const branch = screen.getByLabelText("Worktree branch");
    expect(branch).toHaveAttribute(
      "aria-describedby",
      "settings-worktree-branch-diagnostic"
    );
    expect(
      screen.getByText("Branch is required for named worktree mode.")
    ).toBeInTheDocument();

    const view = EditorView.findFromDOM(branch);
    if (!view) throw new Error("Branch CodeMirror view was not rendered");
    act(() => {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: "feature/new",
        },
      });
    });
    fireEvent.blur(branch);

    expect(
      useSettingsStore.getState().workflowProperties.worktree
    ).toMatchObject({
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/new",
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateWorkflowProperty",
        property: "worktree",
        value: expect.objectContaining({
          mode: WORKTREE_MODES.NAMED,
          branch: "feature/new",
        }),
      })
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
    useSettingsStore.getState().updateGlobalSetting("worktree", false);
    useSettingsStore.getState().updateWorkflowProperty("worktree", false);
    render(<WorkflowPropertiesPanel />);

    const worktreeField = screen.getByRole("button", {
      name: /^Worktree, property worktree/,
    }).parentElement?.parentElement;
    expect(
      within(worktreeField as HTMLElement).queryByRole("button", {
        name: /Set as Default/,
      })
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

  it("keeps reset and collapse as sibling controls", () => {
    render(<WorkflowPropertiesPanel />);

    const collapseButton = screen.getByRole("button", {
      name: "Collapse workflow properties",
    });
    const resetButton = screen.getByRole("button", {
      name: "Reset all to defaults",
    });

    expect(collapseButton).not.toContainElement(resetButton);
  });
});
