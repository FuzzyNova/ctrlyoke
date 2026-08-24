import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningWorkflowItem } from "@components/workflow/RunningWorkflowItem";
import { EXECUTION_STATES } from "@/types/messages";

const callbacks = {
  onClick: vi.fn(),
  onPause: vi.fn(),
  onCancelPause: vi.fn(),
  onResume: vi.fn(),
  onStop: vi.fn(),
};

describe("RunningWorkflowItem", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("freezes pause-aware elapsed time and offers Continue plus Stop", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));

    render(
      <RunningWorkflowItem
        workflow={{
          id: "paused",
          workflowName: "Paused workflow",
          filePath: "paused.prompt.md",
          executionState: EXECUTION_STATES.PAUSED,
          currentStep: 1,
          totalSteps: 2,
          executionTimeMs: 65_000,
          executionTimeUpdatedAt: Date.now() - 60_000,
        }}
        isCurrent
        hasActiveTerminal
        {...callbacks}
      />
    );

    expect(screen.getByText("1:05")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("1:05")).toBeInTheDocument();
  });

  it("ticks forward from accumulated active time while running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));

    render(
      <RunningWorkflowItem
        workflow={{
          id: "running",
          workflowName: "Running workflow",
          filePath: "running.prompt.md",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
          executionTimeMs: 65_000,
          executionTimeUpdatedAt: Date.now(),
        }}
        isCurrent
        hasActiveTerminal
        {...callbacks}
      />
    );

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("1:07")).toBeInTheDocument();
  });

  it("keeps Copy unavailable when the running lineage is not in recent history", () => {
    const onOpenContextMenu = vi.fn();
    const { container } = render(
      <RunningWorkflowItem
        workflow={{
          id: "running",
          workflowKey: "wf" as never,
          runRef: "run-1" as never,
          workflowName: "Running workflow",
          filePath: "running.prompt.md",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
        }}
        isCurrent
        hasActiveTerminal={false}
        onOpenContextMenu={onOpenContextMenu}
        {...callbacks}
      />
    );

    fireEvent.contextMenu(container.querySelector(".running-workflow-item")!, {
      clientX: 10,
      clientY: 20,
    });

    expect(onOpenContextMenu).toHaveBeenCalledWith(
      10,
      20,
      expect.objectContaining({
        scope: "lineage",
        runDirectory: undefined,
        isExecuting: true,
      }),
      expect.any(HTMLButtonElement)
    );
  });

  it("shows the active worktree branch beside the terminal icon", () => {
    const { container } = render(
      <RunningWorkflowItem
        workflow={{
          id: "running",
          workflowName: "Running workflow",
          filePath: "running.prompt.md",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
          worktree: {
            branchName: "feature/auth",
            worktreePath: "C:/worktrees/feature-auth",
          },
        }}
        isCurrent
        hasActiveTerminal
        {...callbacks}
      />
    );

    const terminal = screen.getByLabelText("Terminal session is still running");
    const branch = container.querySelector(".codicon-source-control")!;
    expect(terminal).toBeInTheDocument();
    expect(branch).toHaveClass("codicon-source-control");
    expect(branch).toHaveAttribute(
      "title",
      "Branch: feature/auth\nWorktree: C:/worktrees/feature-auth"
    );
  });
});
