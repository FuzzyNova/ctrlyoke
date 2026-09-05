import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ParallelGroupPanel,
  deriveParallelGroupStatus,
  isStepExecutionLocked,
} from "@components/prompts/ParallelGroupPanel";
import { useSettingsStore } from "@store/settingsStore";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";

const group: ParallelGroupDefinition = {
  id: "group-1",
  startIndex: 0,
  endIndex: 1,
  failFast: true,
};
const steps: WorkflowStep[] = [{ prompt: "first" }, { prompt: "second" }];

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
});

describe("deriveParallelGroupStatus", () => {
  it("prioritizes active members", () => {
    expect(
      deriveParallelGroupStatus([
        { status: STEP_STATUS.SENT, enabled: true },
        { status: STEP_STATUS.FAILED, enabled: true },
      ])
    ).toBe("running");
  });

  it("reports terminal failures and cancellation", () => {
    expect(
      deriveParallelGroupStatus([
        { status: STEP_STATUS.FAILED, enabled: true },
        { status: STEP_STATUS.COMPLETED, enabled: true },
      ])
    ).toBe("failed");
    expect(
      deriveParallelGroupStatus([
        { status: STEP_STATUS.CANCELLED, enabled: true },
        { status: STEP_STATUS.CANCELLED, enabled: true },
      ])
    ).toBe("cancelled");
  });

  it("reports completed, skipped, and pending groups", () => {
    expect(
      deriveParallelGroupStatus([
        { status: STEP_STATUS.COMPLETED, enabled: true },
        { status: STEP_STATUS.SKIPPED, enabled: true },
      ])
    ).toBe("completed");
    expect(
      deriveParallelGroupStatus([
        { status: STEP_STATUS.PENDING, enabled: false },
        { status: STEP_STATUS.SKIPPED, enabled: true },
      ])
    ).toBe("skipped");
    expect(
      deriveParallelGroupStatus([
        { status: STEP_STATUS.SKIPPED, enabled: true },
        { status: STEP_STATUS.SKIPPED, enabled: true },
      ])
    ).toBe("skipped");
    expect(
      deriveParallelGroupStatus([
        { status: STEP_STATUS.PENDING, enabled: true },
        { status: STEP_STATUS.SKIPPED, enabled: true },
      ])
    ).toBe("pending");
  });
});

describe("ParallelGroupPanel", () => {
  it("renders members, sequential gate label, status, and failFast toggle", () => {
    const onFailFastChange = vi.fn();
    render(
      <ParallelGroupPanel
        group={group}
        steps={steps}
        currentStep={0}
        executionState={EXECUTION_STATES.IDLE}
        statuses={[STEP_STATUS.PENDING, STEP_STATUS.PENDING]}
        retryStates={{}}
        liveContextWindow={{}}
        canSetStartPosition
        getLatestOutput={() => null}
        getStepHarnessModel={() => ({
          harnessId: undefined,
          harnessLabel: undefined,
          harnessIsDefault: true,
          modelLabel: undefined,
          modelIsDefault: true,
        })}
        getStepOverrides={() => []}
        onStepClick={vi.fn()}
        onSetStartPosition={vi.fn()}
        onOpenContextMenu={vi.fn()}
        onFailFastChange={onFailFastChange}
      />
    );

    expect(screen.getByLabelText("Parallel steps 1 to 2")).toBeInTheDocument();
    expect(
      screen.queryByText("runs sequentially in this build")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("parallel-group-status")).toHaveTextContent(
      "pending"
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Fail fast" }));
    expect(onFailFastChange).toHaveBeenCalledWith(group, false);
  });

  it("restores status rails when identity colors are disabled", () => {
    render(
      <ParallelGroupPanel
        group={group}
        steps={steps}
        currentStep={0}
        executionState={EXECUTION_STATES.IDLE}
        statuses={[STEP_STATUS.FAILED, STEP_STATUS.PENDING]}
        retryStates={{}}
        liveContextWindow={{}}
        canSetStartPosition
        harnessColorSettings={{ enabled: false, byHarness: {}, script: "#808080" }}
        getLatestOutput={() => null}
        getStepHarnessModel={() => ({
          harnessId: undefined,
          harnessLabel: undefined,
          harnessIsDefault: true,
          modelLabel: undefined,
          modelIsDefault: true,
        })}
        getStepOverrides={() => []}
        onStepClick={vi.fn()}
        onSetStartPosition={vi.fn()}
        onOpenContextMenu={vi.fn()}
        onFailFastChange={vi.fn()}
      />
    );

    const rails = document.querySelectorAll(
      "[data-workflow-step-index] > div:first-child"
    );
    expect(rails).toHaveLength(2);
    expect(rails[0]).toHaveClass("bg-indicator-error");
    expect(rails[1]).toHaveClass("bg-indicator-success");
  });

  it("locks terminal members of an active partially settled group only", () => {
    const terminalStep: WorkflowStep = {
      prompt: "done",
      _runtime: { startedAt: 1, completedAt: 2 } as WorkflowStep["_runtime"],
    };
    const pendingStep: WorkflowStep = { prompt: "pending" };

    expect(
      isStepExecutionLocked(terminalStep, 0, 0, EXECUTION_STATES.PAUSED)
    ).toBe(true);
    expect(
      isStepExecutionLocked(pendingStep, 1, 0, EXECUTION_STATES.PAUSED)
    ).toBe(false);
    expect(
      isStepExecutionLocked(terminalStep, 0, 0, EXECUTION_STATES.IDLE)
    ).toBe(false);
  });
});
