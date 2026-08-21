import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PropertiesDrawer } from "@components/editor/PropertiesDrawer";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { DRAWER_PAGES } from "@/types/drawerPages";
import {
  EXECUTION_MODES,
  SECRET_REGISTRY_STATES,
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
    <PropertiesDrawer
      isOpen
      onClose={() => undefined}
      activePage={DRAWER_PAGES.HARNESS}
    />
  );
}

function renderValidationDrawer() {
  return render(
    <PropertiesDrawer
      isOpen
      onClose={() => undefined}
      activePage={DRAWER_PAGES.VALIDATION}
    />
  );
}

function renderPermissionsDrawer() {
  return render(
    <PropertiesDrawer
      isOpen
      onClose={() => undefined}
      activePage={DRAWER_PAGES.PERMISSIONS}
    />
  );
}

function chooseExecutionMode(label: string): void {
  const current = screen.getByRole("button", { name: "Execution Mode" });
  fireEvent.click(current);
  const option = screen
    .getAllByText(label)
    .map((element) => element.closest("button"))
    .find((button) => button && button !== current);
  if (!option) throw new Error(`Execution mode option not found: ${label}`);
  fireEvent.click(option);
}

describe("PropertiesDrawer execution mode", () => {
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
      screen.getByRole("button", { name: "Execution Mode" })
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
      screen.getByRole("button", { name: "Execution Mode" })
    ).toHaveTextContent("Inherit (Interactive)");

    act(() => {
      useSettingsStore.getState().clearWorkflowProperties();
    });

    expect(
      screen.getByRole("button", { name: "Execution Mode" })
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

    const label = screen.getByText("Execution Mode");
    expect(label).toHaveAttribute(
      "title",
      expect.stringContaining("always run headless")
    );
    expect(label).toHaveAttribute(
      "title",
      expect.stringContaining("TUI continuity")
    );
  });
});

describe("PropertiesDrawer Dry Run entry point", () => {
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

describe("PropertiesDrawer secrets", () => {
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
    fireEvent.click(screen.getByText("EXPLICIT_TOKEN").closest("button")!);

    expect(useEditorStore.getState().properties.secrets).toEqual([
      "EXPLICIT_TOKEN",
    ]);
  });
});

describe("PropertiesDrawer resume session", () => {
  const GUID = "63017930-45b0-4ec4-8094-8a57751e905b";

  beforeEach(() => {
    resetStores();
  });

  afterEach(cleanup);

  function renderContextDrawer() {
    return render(
      <PropertiesDrawer
        isOpen
        onClose={() => undefined}
        activePage={DRAWER_PAGES.CONTEXT}
      />
    );
  }

  function chooseResumeSession(label: string): void {
    const current = screen.getByRole("button", { name: "Resume Session" });
    fireEvent.click(current);
    const option = screen
      .getAllByText(label)
      .map((element) => element.closest("button"))
      .find((button) => button && button !== current);
    if (!option) throw new Error(`Resume Session option not found: ${label}`);
    fireEvent.click(option);
  }

  it("clears the session ID when the override falls back to inherit", () => {
    // Leaving it set kept an invisible GUID on the step (the Session ID input
    // is greyed out and shows the inherited value at this selection), and the
    // step then executed with `-r <guid>` the user had already removed.
    useSettingsStore.getState().updateGlobalSetting("resumeSession", true);
    renderContextDrawer();

    chooseResumeSession("Yes - Resume previous");
    act(() => {
      useEditorStore.getState().setProperty("sessionId", GUID);
    });
    expect(useEditorStore.getState().properties.sessionId).toBe(GUID);

    chooseResumeSession("Inherit (Yes)");

    expect(useEditorStore.getState().properties.resumeSession).toBeUndefined();
    expect(useEditorStore.getState().properties.sessionId).toBe("");
  });

  it("clears the session ID when resume is turned off", () => {
    renderContextDrawer();

    chooseResumeSession("Yes - Resume previous");
    act(() => {
      useEditorStore.getState().setProperty("sessionId", GUID);
    });

    chooseResumeSession("No - Create New");

    expect(useEditorStore.getState().properties.resumeSession).toBe(false);
    expect(useEditorStore.getState().properties.sessionId).toBe("");
  });
});
