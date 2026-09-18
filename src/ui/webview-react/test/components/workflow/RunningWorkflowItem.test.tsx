import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningWorkflowItem } from "@components/workflow/RunningWorkflowItem";
import { EXECUTION_STATES, RUNNER_IDS } from "@/types/messages";

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

  it("shows Final step in the count and accessible name while the final step runs", () => {
    render(
      <RunningWorkflowItem
        workflow={{
          id: "final-step",
          workflowName: "Final-step workflow",
          filePath: "final-step.prompt.md",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 2,
          totalSteps: 2,
          finalStepRunning: true,
        }}
        isCurrent
        hasActiveTerminal={false}
        {...callbacks}
      />
    );

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Final step")).toBeInTheDocument();
    expect(row).toHaveAccessibleName(/Final step/);
    expect(row).not.toHaveAccessibleName(/2\/2/);
  });

  it.each([
    { label: "false", finalStepRunning: false },
    { label: "absent", finalStepRunning: undefined },
  ])(
    "shows clamped numeric progress in the count and accessible name when finalStepRunning is $label",
    ({ finalStepRunning }) => {
      render(
        <RunningWorkflowItem
          workflow={{
            id: `queue-${finalStepRunning ?? "absent"}`,
            workflowName: "Queued workflow",
            filePath: "queued.prompt.md",
            executionState: EXECUTION_STATES.RUNNING,
            currentStep: 3,
            totalSteps: 2,
            finalStepRunning,
          }}
          isCurrent
          hasActiveTerminal={false}
          {...callbacks}
        />
      );

      const row = screen.getByRole("listitem");
      expect(within(row).getByText("2/2")).toBeInTheDocument();
      expect(row).toHaveAccessibleName(/2\/2/);
      expect(row).not.toHaveAccessibleName(/Final step/);
    }
  );

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
    render(
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

    fireEvent.contextMenu(
      screen.getByRole("listitem", { name: /Running workflow/ }),
      {
        clientX: 10,
        clientY: 20,
      }
    );

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

  it("badges a sibling-VS-Code-owned row as 'Other VS Code Window' and hides local controls", () => {
    render(
      <RunningWorkflowItem
        workflow={{
          id: "sibling-owned",
          workflowName: "Sibling-owned workflow",
          filePath: "sibling.prompt.md",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
          externalOwner: { locality: "external", runner: RUNNER_IDS.VSCODE },
        }}
        isCurrent
        hasActiveTerminal={false}
        {...callbacks}
      />
    );

    const badge = screen.getByText("Other VS Code Window");
    expect(badge).toHaveAttribute(
      "title",
      "Read-only — workflow is running via another ctrlyoke window"
    );
    expect(
      screen.queryByRole("button", { name: "Pause" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop" })
    ).not.toBeInTheDocument();
  });

  it("badges a CLI-owned row as 'CLI'", () => {
    render(
      <RunningWorkflowItem
        workflow={{
          id: "cli-owned",
          workflowName: "CLI-owned workflow",
          filePath: "cli.prompt.md",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
          externalOwner: { locality: "external", runner: RUNNER_IDS.CLI },
        }}
        isCurrent
        hasActiveTerminal={false}
        {...callbacks}
      />
    );

    expect(screen.getByText("CLI")).toBeInTheDocument();
  });
});
