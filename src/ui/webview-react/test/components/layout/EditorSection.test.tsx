import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSection } from "@components/layout/EditorSection";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";

vi.mock("../../../components/editor/PromptEditor", () => ({
  PromptEditor: () => <div data-testid="prompt-editor" />,
}));

vi.mock("../../../components/shared", () => ({
  PanelBar: () => <div data-testid="panel-bar" />,
  IconToggleButton: ({
    active,
    onToggle,
    activeLabel,
    inactiveLabel,
  }: {
    active: boolean;
    onToggle: (next: boolean) => void;
    activeLabel?: string;
    inactiveLabel?: string;
  }) => (
    <button
      type="button"
      aria-label={active ? activeLabel : inactiveLabel}
      onClick={() => onToggle(!active)}
    />
  ),
}));

vi.mock("../../../hooks/useAttachmentTokenCount", () => ({
  useAttachmentTokenCount: () => 128,
}));

vi.mock("../../../hooks/useElementNarrow", () => ({
  useElementNarrow: () => [React.createRef<HTMLElement>(), false] as const,
}));

function resetStores() {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useUiStore.setState({
    editorCollapsed: false,
    loadedWorkflows: [],
    activeWorkflowId: null,
  });
}

describe("EditorSection", () => {
  beforeEach(() => {
    resetStores();
  });

  it("defaults new steps to enabled and lets the user disable them", () => {
    render(<EditorSection />);

    // When enabled, button offers to disable; aria-pressed=false (not disabled)
    const toggleButton = screen.getByRole("button", { name: "Disable step" });
    expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    expect(toggleButton).toHaveClass("text-description-fg");

    fireEvent.click(toggleButton);

    expect(useEditorStore.getState().stepEnabled).toBe(false);
    // After disabling, button offers to enable; aria-pressed=true (disabled is active)
    const enableButton = screen.getByRole("button", { name: "Enable step" });
    expect(enableButton).toHaveAttribute("aria-pressed", "true");
    expect(enableButton).toHaveClass("text-warning-fg");
  });

  it("loads the disabled state when editing an existing disabled step", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Disabled step", enabled: false }],
    });

    const step = useWorkflowStore.getState().steps[0];
    useEditorStore.getState().enterEditMode(0, step);

    render(<EditorSection />);

    // When disabled, button offers to enable; aria-pressed=true (disabled is active)
    const toggleButton = screen.getByRole("button", { name: "Enable step" });
    expect(toggleButton).toHaveAttribute("aria-pressed", "true");
    expect(toggleButton).toHaveClass("text-warning-fg");
    expect(screen.getByText("Editing: Prompt 1 of 1")).toBeInTheDocument();
  });
});
