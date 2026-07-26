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
import { DRAWER_PAGES } from "@/types/drawerPages";
import { EXECUTION_MODES } from "@root/types/DashboardConstants";

function resetStores(): void {
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useWorkflowStore.getState().resetWorkflow();
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
