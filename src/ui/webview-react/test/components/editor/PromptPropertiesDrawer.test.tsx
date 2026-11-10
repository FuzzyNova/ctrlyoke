import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptPropertiesDrawer } from "@components/editor/PromptPropertiesDrawer";
import {
  PROPERTY_DEFAULTS,
  useEditorStore,
  type PropertyValues,
} from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { DRAWER_PAGES } from "@/types/drawerPages";
import {
  CONDITION_ACTIONS,
  EXECUTION_MODES,
  HARNESS_IDS,
  HOOK_EVENT_NAMES,
  PERMISSION_MODES,
  PRIOR_CONTEXT_DETAILS,
  PRIOR_CONTEXT_KEYWORDS,
  SECRET_REGISTRY_STATES,
  STEP_COLOR_MODES,
} from "@root/types/DashboardConstants";

function resetStores(): void {
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useWorkflowStore.getState().resetWorkflow();
  useExecutionPreviewStore.getState().reset();
  useSecretRegistryStore.getState().resetSecretRegistry();
}

function renderHarnessDrawer() {
  return render(
    <PromptPropertiesDrawer
      isOpen
      onClose={() => undefined}
      activePage={DRAWER_PAGES.HARNESS}
    />
  );
}

function renderValidationDrawer() {
  return render(
    <PromptPropertiesDrawer
      isOpen
      onClose={() => undefined}
      activePage={DRAWER_PAGES.VALIDATION}
    />
  );
}

function renderPermissionsDrawer() {
  return render(
    <PromptPropertiesDrawer
      isOpen
      onClose={() => undefined}
      activePage={DRAWER_PAGES.PERMISSIONS}
    />
  );
}

function chooseExecutionMode(label: string): void {
  const current = screen.getByRole("button", { name: /^Execution Mode/ });
  fireEvent.click(current);
  const optionNames: Record<string, string> = {
    Interactive: "Interactive, executionMode: interactive",
    Headless: "Headless, executionMode: headless",
    "Inherit (Interactive)": "Inherit (Interactive), omit executionMode",
    "Inherit (Headless)": "Inherit (Headless), omit executionMode",
  };
  fireEvent.click(screen.getByRole("button", { name: optionNames[label] }));
}

describe("PromptPropertiesDrawer landmark", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(cleanup);

  it("exposes a named prompt properties region", () => {
    renderHarnessDrawer();

    expect(
      screen.getByRole("region", { name: "Prompt Properties" })
    ).toHaveAttribute("aria-labelledby", "prompt-properties-heading");
  });

  it("shows the prompt-property reason for a script selection", () => {
    useWorkflowStore
      .getState()
      .setPrompts([{ type: "script", script: "true" } as never]);
    useEditorStore.setState({
      multiSelection: { indices: [0], anchorIndex: 0 },
    });
    renderHarnessDrawer();

    expect(screen.getByLabelText(/^Harness/)).toBeDisabled();
    expect(screen.getByLabelText(/^Harness/)).toHaveAttribute(
      "title",
      "Select only prompt steps to edit prompt properties."
    );
  });

  it("disables harness-scoped options when selected prompts have different harnesses", () => {
    useWorkflowStore
      .getState()
      .setPrompts([
        { prompt: "one", harness: "claude-cli" } as never,
        { prompt: "two", harness: "codex-cli" } as never,
      ]);
    useEditorStore.setState({
      multiSelection: { indices: [0, 1], anchorIndex: 0 },
    });
    renderHarnessDrawer();

    const model = screen.getByLabelText(/^Model/);
    expect(model).toBeDisabled();
    expect(model).toHaveAttribute(
      "title",
      expect.stringContaining(
        "Set a harness to change the model for all selected prompts."
      )
    );
  });
});

describe("PromptPropertiesDrawer harness-scoped fallbacks", () => {
  beforeEach(() => {
    resetStores();
    const settings = useSettingsStore.getState();
    settings.updateGlobalSetting("harness", HARNESS_IDS.CLAUDE_CLI);
    settings.updateGlobalSetting("harnessDefaultModels", {
      [HARNESS_IDS.ANTIGRAVITY_CLI]: "agy-default-model",
    });
    settings.updateGlobalSetting("harnessDefaultAdditionalArgs", {
      [HARNESS_IDS.ANTIGRAVITY_CLI]: "--agy-flag",
    });
    settings.updateWorkflowProperty("model", "workflow-model");
    settings.updateWorkflowProperty("additionalArgs", "--workflow-flag");
  });

  afterEach(cleanup);

  it("labels the fallback Inherit on the workflow's harness", () => {
    renderHarnessDrawer();

    expect(screen.getByRole("button", { name: /^Model/ })).toHaveTextContent(
      "Inherit (workflow-model)"
    );
    expect(
      screen.getByRole("button", { name: /^Additional Args/ })
    ).toHaveTextContent("Inherit (Custom)");
  });

  it("labels the fallback Default with the step harness's setting on another harness", () => {
    useEditorStore
      .getState()
      .setProperty("harness", HARNESS_IDS.ANTIGRAVITY_CLI);
    renderHarnessDrawer();

    expect(screen.getByRole("button", { name: /^Model/ })).toHaveTextContent(
      "Default (agy-default-model)"
    );
    expect(
      screen.getByRole("button", { name: /^Additional Args/ })
    ).toHaveTextContent("Default (Custom)");
    expect(
      screen.getAllByTitle(/^Using the settings default for /).length
    ).toBeGreaterThan(0);
  });
});

describe("PromptPropertiesDrawer execution mode", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(cleanup);

  it("supports inherit, interactive, and headless without a null state", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("executionMode", EXECUTION_MODES.HEADLESS);
    renderHarnessDrawer();

    expect(
      screen.getByRole("button", { name: /^Execution Mode/ })
    ).toHaveTextContent("Inherit (Headless)");
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();

    chooseExecutionMode("Interactive");
    expect(useEditorStore.getState().properties.executionMode).toBe(
      EXECUTION_MODES.INTERACTIVE
    );

    chooseExecutionMode("Headless");
    expect(useEditorStore.getState().properties.executionMode).toBe(
      EXECUTION_MODES.HEADLESS
    );

    chooseExecutionMode("Inherit (Headless)");
    expect(useEditorStore.getState().properties.executionMode).toBeUndefined();
  });

  it("resolves the Inherit label through workflow and then global settings", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("executionMode", EXECUTION_MODES.HEADLESS);
    useSettingsStore
      .getState()
      .updateWorkflowProperty("executionMode", EXECUTION_MODES.INTERACTIVE);
    renderHarnessDrawer();

    expect(
      screen.getByRole("button", { name: /^Execution Mode/ })
    ).toHaveTextContent("Inherit (Interactive)");

    act(() => {
      useSettingsStore.getState().clearWorkflowProperties();
    });

    expect(
      screen.getByRole("button", { name: /^Execution Mode/ })
    ).toHaveTextContent("Inherit (Headless)");
  });

  it("reset all to inherit clears the execution mode override", () => {
    useEditorStore
      .getState()
      .setProperty("executionMode", EXECUTION_MODES.INTERACTIVE);
    renderHarnessDrawer();

    fireEvent.click(
      screen.getByRole("button", { name: "Reset all to inherit" })
    );

    expect(useEditorStore.getState().properties.executionMode).toBeUndefined();
  });

  it("exposes the headless condition and PTY continuity warnings in the tooltip", () => {
    renderHarnessDrawer();

    const label = screen.getByText("Execution Mode", { selector: "label" });
    expect(label).toHaveAttribute(
      "title",
      expect.stringContaining("always run headless")
    );
    expect(label).toHaveAttribute(
      "title",
      expect.stringContaining("TUI continuity")
    );
  });

  it("writes and resets the full step color control", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("stepColorMode", STEP_COLOR_MODES.HARNESS);
    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.COPILOT_CLI);
    renderHarnessDrawer();

    const color = screen.getByLabelText(/^Step Color, color:/);
    const reset = screen.getByRole("button", {
      name: "Reset step color to inherit",
    });
    expect(color).toHaveValue("#59a4f9");
    expect(reset).toBeDisabled();

    fireEvent.change(color, { target: { value: "#abcdef" } });
    fireEvent.blur(color);
    expect(useEditorStore.getState().properties.color).toBe("#abcdef");

    fireEvent.click(reset);
    expect(useEditorStore.getState().properties.color).toBeUndefined();
  });

  it("hides the step color control when step colors are off", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("stepColorMode", STEP_COLOR_MODES.NONE);
    renderHarnessDrawer();

    expect(
      screen.queryByLabelText(/^Step Color, color:/)
    ).not.toBeInTheDocument();
  });
});

describe("PromptPropertiesDrawer sandbox", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(cleanup);

  function chooseSandbox(label: string): void {
    fireEvent.click(screen.getByRole("button", { name: /^Sandbox,/ }));
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`^${label}\\b`) })
    );
  }

  it("writes On and Off as booleans, None as null and clears the override for Inherit", () => {
    renderPermissionsDrawer();
    expect(screen.getByRole("button", { name: /^Sandbox,/ })).toHaveTextContent(
      "Inherit (Off)"
    );

    chooseSandbox("On");
    expect(useEditorStore.getState().properties.sandbox).toBe(true);

    chooseSandbox("Off");
    expect(useEditorStore.getState().properties.sandbox).toBe(false);

    chooseSandbox("None");
    expect(useEditorStore.getState().properties.sandbox).toBeNull();
    expect(screen.getByRole("button", { name: /^Sandbox,/ })).toHaveTextContent(
      "None"
    );

    chooseSandbox("Inherit");
    expect(useEditorStore.getState().properties.sandbox).toBeUndefined();
  });

  it("names the value Inherit resolves to: the workflow's, else the default", () => {
    useSettingsStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, sandbox: true },
    }));
    const { unmount } = renderPermissionsDrawer();
    expect(screen.getByRole("button", { name: /^Sandbox,/ })).toHaveTextContent(
      "Inherit (On)"
    );
    unmount();

    useSettingsStore.setState((state) => ({
      workflowProperties: { ...state.workflowProperties, sandbox: false },
    }));
    renderPermissionsDrawer();
    expect(screen.getByRole("button", { name: /^Sandbox,/ })).toHaveTextContent(
      "Inherit (Off)"
    );
  });

  it("shows the sandbox mode only while the sandbox resolves to On", () => {
    const mode = () => screen.queryByRole("button", { name: /^Sandbox mode,/ });
    // resetSettings keeps globalSettings, so pin the default explicitly.
    useSettingsStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, sandbox: false },
    }));
    const { unmount } = renderPermissionsDrawer();
    // Inherit (Off) by default.
    expect(mode()).not.toBeInTheDocument();
    chooseSandbox("On");
    expect(mode()).toBeInTheDocument();
    unmount();

    // None passes no sandbox flags, so the mode is meaningless there too.
    useEditorStore.setState((state) => ({
      properties: { ...state.properties, sandbox: null },
    }));
    const second = renderPermissionsDrawer();
    expect(mode()).not.toBeInTheDocument();
    second.unmount();

    // Inheriting On from the workflow shows it.
    useEditorStore.setState((state) => ({
      properties: { ...state.properties, sandbox: undefined },
    }));
    useSettingsStore.setState((state) => ({
      workflowProperties: { ...state.workflowProperties, sandbox: true },
    }));
    renderPermissionsDrawer();
    expect(mode()).toBeInTheDocument();
  });

  it("places tool permission mode after the sandbox and secrets controls", () => {
    renderPermissionsDrawer();
    const sandbox = screen.getByRole("button", { name: /^Sandbox,/ });
    const permissionMode = screen.getByRole("button", {
      name: /^Tool Permission Mode/,
    });
    const allowed = screen.getByLabelText("Allowed Tools");
    expect(
      sandbox.compareDocumentPosition(permissionMode) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      permissionMode.compareDocumentPosition(allowed) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("writes the sandbox mode and names the mode Inherit resolves to", () => {
    useEditorStore.setState((state) => ({
      properties: { ...state.properties, sandbox: true },
    }));
    renderPermissionsDrawer();
    const mode = () => screen.getByRole("button", { name: /^Sandbox mode,/ });
    expect(mode()).toHaveTextContent("Inherit (Workspace write)");
    fireEvent.click(mode());
    fireEvent.click(screen.getByRole("button", { name: /^Read-only\b/ }));
    expect(useEditorStore.getState().properties.sandboxMode).toBe("read-only");
  });
});

describe("PromptPropertiesDrawer reset all to inherit", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(cleanup);

  // `Required<>` makes this a compile-time inventory: a property added to
  // PropertyValues without an entry here fails typecheck, so the reset test
  // below covers every drawer control by construction.
  const OVERRIDES: Required<PropertyValues> = {
    harness: HARNESS_IDS.CODEX_CLI,
    model: "custom-model",
    executionMode: EXECUTION_MODES.HEADLESS,
    color: "#abcdef",
    agent: "custom-agent",
    skills: ["custom-skill"],
    secrets: ["CUSTOM_SECRET"],
    resumeSession: true,
    sessionId: "session-123",
    mcpServers: ["custom-server"],
    hooks: [{ event: HOOK_EVENT_NAMES.STOP, command: "echo done" }],
    errorBehavior: { onError: CONDITION_ACTIONS.CONTINUE },
    endCondition: { script: "exit 0" },
    preCondition: { script: "exit 0" },
    priorContext: PRIOR_CONTEXT_KEYWORDS.ALL,
    priorContextDetail: PRIOR_CONTEXT_DETAILS.SUMMARY,
    additionalArgs: "--custom",
    toolPermissions: { mode: PERMISSION_MODES.CUSTOM },
    sandbox: true,
    sandboxMode: "read-only",
  };

  it("returns every step property to its inherit default", () => {
    useEditorStore.setState({ properties: { ...OVERRIDES } });
    renderPermissionsDrawer();
    expect(screen.getByRole("button", { name: /^Sandbox,/ })).toHaveTextContent(
      "On"
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reset all to inherit" })
    );

    const properties = useEditorStore.getState().properties;
    for (const key of Object.keys(OVERRIDES) as (keyof PropertyValues)[]) {
      expect(properties[key], key).toEqual(PROPERTY_DEFAULTS[key]);
    }
    expect(screen.getByRole("button", { name: /^Sandbox,/ })).toHaveTextContent(
      /^Inherit/
    );
  });
});

describe("PromptPropertiesDrawer Dry Run entry point", () => {
  beforeEach(resetStores);

  afterEach(cleanup);

  it("opens a step-scoped Dry Run for the current unsaved editor step", () => {
    useEditorStore.getState().setPromptText("unsaved prompt");
    renderValidationDrawer();

    fireEvent.click(screen.getByRole("button", { name: "Dry Run Step" }));

    expect(useExecutionPreviewStore.getState().scope).toEqual({
      kind: "step",
      stepIndex: 0,
    });
  });
});

describe("PromptPropertiesDrawer secrets", () => {
  beforeEach(resetStores);

  afterEach(cleanup);

  it("renders names from the user and workspace secret registries", () => {
    useSecretRegistryStore.getState().setEntries("user", [
      {
        name: "USER_TOKEN",
        scope: "user",
        state: SECRET_REGISTRY_STATES.MANAGED_AND_SET,
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "WORKSPACE_TOKEN",
        scope: "workspace",
        state: SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED,
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);

    renderPermissionsDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Secrets" }));

    expect(screen.getByText("USER_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("WORKSPACE_TOKEN")).toBeInTheDocument();
  });

  it("locks inline references and excludes them from explicit grants", () => {
    useEditorStore.getState().setPromptText("Use !INLINE_TOKEN here");
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "INLINE_TOKEN",
        scope: "workspace",
        state: SECRET_REGISTRY_STATES.MANAGED_AND_SET,
        usedBy: { mcpServers: [], workflows: [] },
      },
      {
        name: "EXPLICIT_TOKEN",
        scope: "workspace",
        state: SECRET_REGISTRY_STATES.MANAGED_AND_SET,
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);

    renderPermissionsDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Secrets" }));

    const inlineRow = screen.getByRole("button", {
      name: "INLINE_TOKENGranted by prompt text",
    });
    expect(inlineRow.querySelector("input")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /EXPLICIT_TOKEN/ }));

    expect(useEditorStore.getState().properties.secrets).toEqual([
      "EXPLICIT_TOKEN",
    ]);
  });
});

describe("PromptPropertiesDrawer resume session", () => {
  const GUID = "63017930-45b0-4ec4-8094-8a57751e905b";

  beforeEach(() => {
    resetStores();
  });

  afterEach(cleanup);

  function renderContextDrawer() {
    return render(
      <PromptPropertiesDrawer
        isOpen
        onClose={() => undefined}
        activePage={DRAWER_PAGES.CONTEXT}
      />
    );
  }

  function chooseResumeSession(label: string): void {
    const current = screen.getByRole("button", { name: /^Resume Session/ });
    fireEvent.click(current);
    const optionNames: Record<string, string> = {
      Resume: "Resume, resumeSession: true",
      "New Session": "New Session, resumeSession: false",
      "Inherit (Resume)": "Inherit (Resume), omit resumeSession",
    };
    fireEvent.click(screen.getByRole("button", { name: optionNames[label] }));
  }

  it("clears the session ID when the override falls back to inherit", () => {
    // Leaving it set kept an invisible GUID on the step (the Session ID input
    // is greyed out and shows the inherited value at this selection), and the
    // step then executed with `-r <guid>` the user had already removed.
    useSettingsStore.getState().updateGlobalSetting("resumeSession", true);
    renderContextDrawer();

    chooseResumeSession("Resume");
    act(() => {
      useEditorStore.getState().setProperty("sessionId", GUID);
    });
    expect(useEditorStore.getState().properties.sessionId).toBe(GUID);

    chooseResumeSession("Inherit (Resume)");

    expect(useEditorStore.getState().properties.resumeSession).toBeUndefined();
    expect(useEditorStore.getState().properties.sessionId).toBe("");
  });

  it("clears the session ID when resume is turned off", () => {
    renderContextDrawer();

    chooseResumeSession("Resume");
    act(() => {
      useEditorStore.getState().setProperty("sessionId", GUID);
    });

    chooseResumeSession("New Session");

    expect(useEditorStore.getState().properties.resumeSession).toBe(false);
    expect(useEditorStore.getState().properties.sessionId).toBe("");
  });
});
