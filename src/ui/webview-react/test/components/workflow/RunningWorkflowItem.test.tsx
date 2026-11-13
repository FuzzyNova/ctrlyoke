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
import { ROW_ACTION_BUTTON_CLASS } from "@components/workflow/WorkflowRowLayout";
import { EXECUTION_STATES, RUNNER_IDS } from "@/types/messages";
import { usePauseRequestStore } from "@store/pauseRequestStore";
import { workflowRunAddress, workflowViewAddressKey } from "@utils/viewAddress";

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

  it("keeps the clock slot aligned and reflects enabled, paused, and unscheduled states", () => {
    const base = {
      workflow: {
        id: "clock-row",
        workflowKey: "workflow-clock" as never,
        runRef: "run-clock" as never,
        workflowName: "Clock row",
        filePath: "clock.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.RUNNING,
        currentStep: 0,
        totalSteps: 1,
      },
      isCurrent: false,
      hasActiveTerminal: false,
      ...callbacks,
    };
    const nextRun = new Date(Date.now() + 60_000).getTime();
    const schedule = {
      trigger: { at: new Date(nextRun + 60_000).toISOString().slice(0, 16) },
      hostId: "host",
    };
    const { rerender } = render(
      <RunningWorkflowItem
        {...base}
        lineage={
          {
            address: { workflowKey: "workflow-clock" as never, kind: "draft" },
            workflowName: "Clock row",
            schedule: { ...schedule, enabled: true },
            scheduleNextRunAt: nextRun,
          } as never
        }
      />
    );
    const enabled = screen.getByRole("button", {
      name: new RegExp("Next run"),
    });
    expect(enabled).toHaveClass("text-focus-fg");
    expect(enabled.closest(".workflow-row-trailing")).not.toBeNull();
    rerender(
      <RunningWorkflowItem
        {...base}
        lineage={
          {
            address: { workflowKey: "workflow-clock" as never, kind: "draft" },
            workflowName: "Clock row",
            schedule: { ...schedule, enabled: false },
          } as never
        }
      />
    );
    expect(
      screen.getByRole("button", { name: /Paused/ })
    ).toHaveClass("opacity-60");
    rerender(<RunningWorkflowItem {...base} />);
    expect(
      screen.getByRole("button", { name: "Schedule workflow…" })
    ).toHaveClass("opacity-0");
  });

  it("puts pause/stop on the metadata line in the shared action-button box", () => {
    // Running rows must line up with the recent rows beneath them: same row
    // grid, controls at the end of the second line, same 20px button box as
    // the favourite/remove buttons.
    render(
      <RunningWorkflowItem
        workflow={{
          id: "aligned",
          workflowKey: "workflow-a" as never,
          runRef: "run-1" as never,
          workflowName: "Aligned workflow",
          filePath: "aligned.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
          totalSteps: 1,
        }}
        isCurrent={false}
        hasActiveTerminal={false}
        {...callbacks}
      />
    );
    expect(screen.getByRole("listitem")).toHaveClass("workflow-row");
    for (const name of ["Pause", "Stop"]) {
      const button = screen.getByRole("button", { name });
      expect(button.closest(".workflow-row-trailing")).not.toBeNull();
      expect(button.closest(".workflow-row-primary")).toBeNull();
      expect(button).toHaveClass(...ROW_ACTION_BUTTON_CLASS.split(" "));
    }
  });

  it("renders an unanswered pause request exactly like the pausing state", () => {
    const workflow = {
      id: "pause-requested",
      workflowKey: "workflow-a" as never,
      runRef: "run-1" as never,
      workflowName: "Busy workflow",
      filePath: "busy.ctrlyoke.yaml",
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 0,
      totalSteps: 2,
    };
    render(
      <RunningWorkflowItem
        workflow={workflow}
        isCurrent
        hasActiveTerminal={false}
        {...callbacks}
      />
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    act(() => {
      usePauseRequestStore.setState({
        pending: {
          [workflowViewAddressKey(workflowRunAddress(workflow)!)]: {
            address: workflowRunAddress(workflow)!,
            observedState: "running|",
          },
        },
      });
    });

    const row = screen.getByRole("listitem");
    expect(row).toHaveAccessibleName(/pausing/i);
    expect(
      screen.queryByRole("button", { name: "Pause" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel pause" }));
    expect(callbacks.onCancelPause).toHaveBeenCalledTimes(1);
    act(() => {
      usePauseRequestStore.setState({ pending: {} });
    });
  });

  it("shows Final step for a final-step-only workflow with an empty queue", () => {
    render(
      <RunningWorkflowItem
        workflow={{
          id: "final-step-only",
          workflowName: "Bug drain",
          filePath: "bug-drain.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
          totalSteps: 0,
          finalStepRunning: true,
        }}
        isCurrent
        hasActiveTerminal={false}
        {...callbacks}
      />
    );

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Final step")).toBeInTheDocument();
    expect(row).toHaveAccessibleName(/final step/i);
  });

  it("ticks in tenths of a second under a minute, then whole seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));

    render(
      <RunningWorkflowItem
        workflow={{
          id: "quick",
          workflowName: "Quick workflow",
          filePath: "quick.prompt.md",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
          totalSteps: 1,
          executionTimeMs: 59_500,
          executionTimeUpdatedAt: Date.now(),
        }}
        isCurrent
        hasActiveTerminal={false}
        {...callbacks}
      />
    );

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("0:59.8")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_200);
    });
    expect(screen.getByText("1:01")).toBeInTheDocument();
  });

  it("formats an hour or more of run time as h:mm:ss", () => {
    render(
      <RunningWorkflowItem
        workflow={{
          id: "long",
          workflowName: "Long workflow",
          filePath: "long.prompt.md",
          executionState: EXECUTION_STATES.PAUSED,
          currentStep: 1,
          totalSteps: 2,
          executionTimeMs: 8_419_000,
        }}
        isCurrent
        hasActiveTerminal={false}
        {...callbacks}
      />
    );

    expect(screen.getByText("2:20:19")).toBeInTheDocument();
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
    // The spoken form is phrased for a screen reader rather than mirroring the
    // visible string verbatim; what must never differ is which state it names.
    expect(row).toHaveAccessibleName(/final step/i);
    expect(row).not.toHaveAccessibleName(/step 2 of 2/);
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
      // Spelled out so a screen reader does not read "2/2" as "two slash two".
      expect(row).toHaveAccessibleName(/step 2 of 2/);
      expect(row).not.toHaveAccessibleName(/final step/i);
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
    const branch = container.querySelector(".codicon-worktree-compact")!;
    expect(terminal).toBeInTheDocument();
    expect(branch).toHaveClass("codicon-worktree-compact");
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
