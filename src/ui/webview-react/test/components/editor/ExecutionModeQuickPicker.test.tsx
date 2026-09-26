import { fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionModeQuickPicker } from "@components/editor/ExecutionModeQuickPicker";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { EXECUTION_MODES } from "@root/types/DashboardConstants";

function resetStores() {
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
}

describe("ExecutionModeQuickPicker", () => {
  beforeEach(() => {
    resetStores();
  });

  it("shows a dimmed debug-console icon when inheriting an interactive workflow default", () => {
    render(<ExecutionModeQuickPicker />);

    const trigger = screen.getByRole("button", { name: "Execution mode" });
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    expect(trigger).toHaveClass("text-description-fg");
    expect(trigger.querySelector(".codicon-debug-console")).not.toBeNull();
    expect(trigger.querySelector(".codicon-terminal")).toBeNull();
  });

  it("shows a dimmed terminal icon when inheriting a headless workflow default", () => {
    useSettingsStore
      .getState()
      .updateWorkflowProperty("executionMode", EXECUTION_MODES.HEADLESS);

    render(<ExecutionModeQuickPicker />);

    const trigger = screen.getByRole("button", { name: "Execution mode" });
    expect(trigger).toHaveClass("text-description-fg");
    expect(trigger.querySelector(".codicon-terminal")).not.toBeNull();
  });

  it("opens a dropdown with Inherit, Interactive, and Headless in that order", async () => {
    render(<ExecutionModeQuickPicker />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Execution mode" }));
    });

    const options = screen.getAllByRole("button", {
      name: /Inherit|Interactive|Headless/,
    });
    expect(options.map((o) => o.textContent)).toEqual([
      "Inherit (Interactive)",
      "Interactive",
      "Headless",
    ]);
  });

  it("applies a headless override and highlights the icon", async () => {
    render(<ExecutionModeQuickPicker />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Execution mode" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Headless/ }));
    });

    expect(useEditorStore.getState().properties.executionMode).toBe(
      EXECUTION_MODES.HEADLESS
    );
    const trigger = screen.getByRole("button", { name: "Execution mode" });
    expect(trigger).toHaveAttribute("aria-pressed", "true");
    expect(trigger).toHaveClass("text-widget-highlight-fg");
    expect(trigger.querySelector(".codicon-terminal")).not.toBeNull();
  });

  it("clears the override when Inherit is selected again", async () => {
    useEditorStore.getState().setProperty("executionMode", "headless");
    render(<ExecutionModeQuickPicker />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Execution mode" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /^Inherit \(Interactive\)/ })
      );
    });

    expect(useEditorStore.getState().properties.executionMode).toBeUndefined();
    expect(
      screen.getByRole("button", { name: "Execution mode" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("is disabled in CLI-managed workflows and does not open the dropdown", () => {
    render(<ExecutionModeQuickPicker disabled />);

    const trigger = screen.getByRole("button", { name: "Execution mode" });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(
      screen.queryByRole("button", { name: /^Headless/ })
    ).not.toBeInTheDocument();
  });
});
