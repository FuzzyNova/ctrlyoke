import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptChipRail } from "@components/prompts/PromptChipRail";
import {
  HARNESS_CHART_COLORS,
  HARNESS_IDS,
  STEP_COLOR_MODES,
} from "@root/types/DashboardConstants";
import { getUniqueStepColor } from "@utils/stepColor";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
} from "@/types/messages";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkflowStore } from "@store/workflowStore";
import type { StepHarnessModel } from "@components/prompts/WorkflowStepRow";

function resetStores() {
  useWorkflowStore.getState().resetWorkflow();
  useSettingsStore.getState().resetSettings();
}

function getStepHarnessModel(): StepHarnessModel {
  return {
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    harnessLabel: "Claude",
    harnessIsDefault: true,
    modelLabel: undefined,
    modelIsDefault: true,
  };
}

describe("PromptChipRail", () => {
  beforeEach(resetStores);

  it("keeps status in an icon and paints the identity border from the resolver", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("stepColorMode", STEP_COLOR_MODES.HARNESS);
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        { prompt: "Failed prompt" },
        { type: "script", script: "npm test" },
      ],
      executionState: EXECUTION_STATES.IDLE,
      results: [{ status: STEP_STATUS.FAILED }],
    });

    render(
      <PromptChipRail
        onExpand={vi.fn()}
        getStepHarnessModel={getStepHarnessModel}
      />
    );

    const failedChip = document.querySelector('[data-workflow-chip-index="0"]');
    const scriptChip = document.querySelector('[data-workflow-chip-index="1"]');
    expect(failedChip).not.toBeNull();
    expect(scriptChip).not.toBeNull();

    expect(failedChip).toHaveTextContent("1");
    expect(failedChip?.querySelector(".codicon-comment")).not.toBeNull();
    expect(failedChip?.querySelector('[aria-label="failed"]')).not.toBeNull();
    expect(failedChip?.querySelector("[data-chip-identity-bar]")).toHaveStyle(
      `background-color: ${HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI]}`
    );
    expect(
      failedChip?.querySelector("[data-chip-identity-bar]")
    ).not.toHaveClass("bg-indicator-error");

    expect(
      scriptChip?.querySelector(".codicon-terminal-powershell")
    ).not.toBeNull();
    expect(scriptChip?.querySelector('[aria-label="pending"]')).not.toBeNull();
  });

  it("expands from the header when Space is pressed", async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    render(<PromptChipRail onExpand={onExpand} />);

    const expandButton = screen.getByRole("button", { name: "Expand prompts" });
    expandButton.focus();
    await user.keyboard(" ");

    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("selects a prompt chip when Space is pressed", async () => {
    const user = userEvent.setup();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "First prompt" }],
      executionState: EXECUTION_STATES.IDLE,
    });

    render(<PromptChipRail onExpand={vi.fn()} />);

    const chip = screen.getByRole("button", { name: "Prompt 1" });
    chip.focus();
    await user.keyboard(" ");

    expect(useEditorStore.getState().selectedPromptIndex).toBe(0);
  });

  it("selects the final-step chip when Space is pressed", async () => {
    const user = userEvent.setup();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [],
      finalStep: { prompt: "Final prompt" },
      executionState: EXECUTION_STATES.IDLE,
    });

    render(<PromptChipRail onExpand={vi.fn()} />);

    const chip = screen.getByRole("button", { name: "Final step" });
    chip.focus();
    await user.keyboard(" ");

    expect(useEditorStore.getState().selectionTarget).toEqual({
      kind: FINAL_STEP_PHASES.FINAL_STEP,
    });
  });

  it("restores the status border when identity colors are disabled", () => {
    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      harnessColors: {
        ...useSettingsStore.getState().globalSettings.harnessColors!,
      },
      stepColorMode: STEP_COLOR_MODES.NONE,
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Failed prompt" }],
      executionState: EXECUTION_STATES.IDLE,
      results: [{ status: STEP_STATUS.FAILED }],
    });

    render(
      <PromptChipRail
        onExpand={vi.fn()}
        getStepHarnessModel={getStepHarnessModel}
      />
    );

    expect(
      document.querySelector(
        '[data-workflow-chip-index="0"] [data-chip-identity-bar]'
      )
    ).toHaveClass("bg-indicator-error");
    expect(
      document.querySelector(
        '[data-workflow-chip-index="0"] [data-chip-identity-bar]'
      )
    ).not.toHaveAttribute("style");
  });

  it("uses the unique palette for steps instead of harness colors", () => {
    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      stepColorMode: STEP_COLOR_MODES.UNIQUE,
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "First" }, { prompt: "Second" }],
      executionState: EXECUTION_STATES.IDLE,
    });

    render(
      <PromptChipRail
        onExpand={vi.fn()}
        getStepHarnessModel={getStepHarnessModel}
      />
    );

    expect(
      document.querySelector(
        '[data-workflow-chip-index="0"] [data-chip-identity-bar]'
      )
    ).toHaveStyle(`background-color: ${getUniqueStepColor(0)}`);
    expect(
      document.querySelector(
        '[data-workflow-chip-index="1"] [data-chip-identity-bar]'
      )
    ).toHaveStyle(`background-color: ${getUniqueStepColor(1)}`);
  });

  it("seeds the final step after the last regular step", () => {
    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      stepColorMode: STEP_COLOR_MODES.UNIQUE,
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Only step" }],
      finalStep: { prompt: "Final step" },
      executionState: EXECUTION_STATES.IDLE,
    });

    render(<PromptChipRail onExpand={vi.fn()} />);

    const stepBar = document.querySelector(
      '[data-workflow-chip-index="0"] [data-chip-identity-bar]'
    );
    const finalBar = document.querySelector("[data-final-step-identity-bar]");
    expect(stepBar).toHaveStyle(`background-color: ${getUniqueStepColor(0)}`);
    expect(finalBar).toHaveStyle(`background-color: ${getUniqueStepColor(1)}`);
    expect(finalBar).not.toHaveStyle(
      `background-color: ${getUniqueStepColor(0)}`
    );
  });

  it("renders the status icon before the context fill bar", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        {
          prompt: "Context prompt",
          _runtime: { contextWindowUsed: 50, contextWindowSize: 100 },
        },
      ],
    });

    render(
      <PromptChipRail
        onExpand={vi.fn()}
        getStepHarnessModel={getStepHarnessModel}
      />
    );

    const chip = document.querySelector('[data-workflow-chip-index="0"]');
    const statusIcon = chip?.querySelector('[aria-label="pending"]');
    const contextFillBar = chip?.querySelector(".animate-ctx-update");
    expect(statusIcon).not.toBeNull();
    expect(contextFillBar).not.toBeNull();
    expect(contextFillBar).toHaveStyle("height: 50%");
    expect(
      (statusIcon?.compareDocumentPosition(contextFillBar!) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("wraps a parallel group's chips in a bordered header with the worktree icon", () => {
    const group = {
      id: "group-1",
      startIndex: 0,
      endIndex: 1,
      failFast: true,
    };
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "first" }, { prompt: "second" }, { prompt: "after" }],
      parallelGroups: [group],
      executionState: EXECUTION_STATES.IDLE,
    });

    render(<PromptChipRail onExpand={vi.fn()} />);

    const groupWrapper = screen.getByTestId(`chip-parallel-group-${group.id}`);
    expect(
      groupWrapper.querySelector(".codicon-type-hierarchy-sub")
    ).not.toBeNull();
    expect(
      within(groupWrapper).getByRole("button", { name: "Prompt 1" })
    ).toBeInTheDocument();
    expect(
      within(groupWrapper).getByRole("button", { name: "Prompt 2" })
    ).toBeInTheDocument();

    // The step after the group renders as its own chip, outside the wrapper.
    const afterChip = screen.getByRole("button", { name: "Prompt 3" });
    expect(groupWrapper.contains(afterChip)).toBe(false);
  });

  it("outlines the whole running group's chips, not an individual chip", () => {
    const group = {
      id: "group-2",
      startIndex: 0,
      endIndex: 1,
      failFast: true,
    };
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "still running" }, { prompt: "settled first" }],
      parallelGroups: [group],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      activeStepIndices: [0],
      results: [
        { status: STEP_STATUS.RUNNING },
        { status: STEP_STATUS.COMPLETED },
      ],
    });

    render(<PromptChipRail onExpand={vi.fn()} />);

    const groupWrapper = screen.getByTestId(`chip-parallel-group-${group.id}`);
    expect(
      within(groupWrapper).getByTestId(
        "parallel-group-chip-executing-highlight"
      )
    ).toBeInTheDocument();
    expect(
      within(groupWrapper).queryByTestId("executing-chip-highlight")
    ).not.toBeInTheDocument();
  });
});
