import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptChipRail } from "@components/prompts/PromptChipRail";
import {
  HARNESS_CHART_COLORS,
  HARNESS_IDS,
} from "@root/types/DashboardConstants";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
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

  it("renders the status row before the context row in the three-row layout", () => {
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
    const contextLabel = screen.getByText("50%");
    expect(statusIcon).not.toBeNull();
    expect(contextLabel).toBeInTheDocument();
    expect(
      (statusIcon?.compareDocumentPosition(contextLabel) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
