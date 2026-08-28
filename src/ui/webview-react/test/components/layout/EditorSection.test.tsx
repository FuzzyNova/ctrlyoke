import React from "react";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSection } from "@components/layout/EditorSection";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { RUNNER_IDS, STEP_TYPES } from "@root/types/DashboardConstants";

const { attachmentTokenCount, promptFileAction, isElementNarrow } = vi.hoisted(
  () => ({
    attachmentTokenCount: { value: 128 },
    promptFileAction: {
      value: null as null | {
        icon: string;
        tooltip: string;
        disabled: boolean;
        onClick: () => void;
      },
    },
    isElementNarrow: { value: false },
  })
);

vi.mock("../../../components/editor/PromptEditor", () => ({
  PromptEditor: ({
    onPromptFileActionChange,
  }: {
    onPromptFileActionChange?: (action: typeof promptFileAction.value) => void;
  }) => {
    React.useEffect(() => {
      onPromptFileActionChange?.(promptFileAction.value);
      return () => onPromptFileActionChange?.(null);
    }, [onPromptFileActionChange]);
    return <div data-testid="prompt-editor" />;
  },
}));

vi.mock("../../../components/shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../components/shared")>();
  return {
    ...actual,
    PanelBar: () => <div data-testid="panel-bar" />,
    IconToggleButton: ({
      active,
      onToggle,
      activeTooltip,
      inactiveTooltip,
    }: {
      active: boolean;
      onToggle: (next: boolean) => void;
      activeTooltip: string;
      inactiveTooltip: string;
    }) => (
      <button
        type="button"
        title={active ? activeTooltip : inactiveTooltip}
        aria-label={active ? activeTooltip : inactiveTooltip}
        aria-pressed={active}
        onClick={() => onToggle(!active)}
      />
    ),
  };
});

vi.mock("../../../hooks/useAttachmentTokenCount", () => ({
  useAttachmentTokenCount: () => attachmentTokenCount.value,
}));

vi.mock("../../../hooks/useElementNarrow", () => ({
  useElementNarrow: () =>
    [React.createRef<HTMLElement>(), isElementNarrow.value] as const,
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
    attachmentTokenCount.value = 128;
    promptFileAction.value = null;
    isElementNarrow.value = false;
    resetStores();
  });

  it.each([
    ["prompt text", "file-symlink-file", "Convert to prompt file"],
    ["empty prompt", "file-symlink-file", "Write this prompt in a file"],
    ["prompt file", "go-to-file", "Open prompt file"],
  ])("renders the prompt-file action for %s", (_state, icon, tooltip) => {
    const onClick = vi.fn();
    promptFileAction.value = { icon, tooltip, disabled: false, onClick };

    render(<EditorSection />);

    const action = screen.getByRole("button", { name: tooltip });
    expect(action).toHaveAttribute("title", tooltip);
    expect(action.querySelector(`.codicon-${icon}`)).not.toBeNull();
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("hides the prompt-file action for script steps and CLI-managed workflows", () => {
    promptFileAction.value = {
      icon: "file-symlink-file",
      tooltip: "Convert to prompt file",
      disabled: false,
      onClick: vi.fn(),
    };
    useEditorStore.getState().setStepType(STEP_TYPES.SCRIPT);
    render(<EditorSection />);
    expect(
      screen.queryByRole("button", { name: "Convert to prompt file" })
    ).not.toBeInTheDocument();

    act(() => {
      useEditorStore.getState().setStepType(STEP_TYPES.PROMPT);
      useUiStore.setState({
        loadedWorkflows: [
          {
            id: "cli",
            externalOwner: { locality: "external", runner: RUNNER_IDS.CLI },
          } as never,
        ],
        activeWorkflowId: "cli",
      });
    });
    expect(
      screen.queryByRole("button", { name: "Convert to prompt file" })
    ).not.toBeInTheDocument();
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

  it("uses the shared magnitude formatter for large token counts", () => {
    attachmentTokenCount.value = 1_234_567;

    render(<EditorSection />);

    expect(screen.getByText("1.2M tokens")).toBeInTheDocument();
  });

  it("abbreviates the token label to 'tks' at narrow width", () => {
    isElementNarrow.value = true;

    render(<EditorSection />);

    expect(screen.getByText("128 tks")).toBeInTheDocument();
    expect(screen.queryByText("128 tokens")).not.toBeInTheDocument();
  });

  it("shows a dimmed inherited icon for the execution mode picker by default", () => {
    render(<EditorSection />);

    // Global default execution mode is interactive (see settingsStore defaults)
    const picker = screen.getByRole("button", { name: "Execution mode" });
    expect(picker).toHaveAttribute("aria-pressed", "false");
    expect(picker).toHaveClass("text-description-fg");
    expect(picker.querySelector(".codicon-debug-console")).not.toBeNull();
  });

  it("lets the user override the execution mode from the header picker", async () => {
    render(<EditorSection />);

    const picker = screen.getByRole("button", { name: "Execution mode" });
    await act(async () => {
      fireEvent.click(picker);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Headless" }));
    });

    expect(useEditorStore.getState().properties.executionMode).toBe("headless");
    expect(picker).toHaveAttribute("aria-pressed", "true");
    expect(picker).toHaveClass("text-widget-highlight-fg");
    expect(picker.querySelector(".codicon-terminal")).not.toBeNull();
  });
});
