import type { ComponentProps } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RunSummaryBanner } from "@components/output/RunSummaryBanner";
import { EXECUTION_STATES, MESSAGE_TYPES } from "@/types/messages";
import { isManagedWorktreeUndoUnavailable } from "@components/output/RunSummaryBanner";
import type {
  WorkflowViewAddress,
  RunRef,
  WorkflowKey,
  WorkflowTokenTotals,
} from "@root/types/CtrlYokeTypes";

const tokenTotals: WorkflowTokenTotals = {
  total: 410_000,
  coverage: "complete",
  reportedAttemptCount: 1,
  attemptCount: 1,
  isFinal: true,
  costUsd: 0.41,
  byHarness: {},
  byLocalDay: {},
};

const worktree = {
  mode: "named" as const,
  branchName: "feature/historical",
  worktreePath: "C:/dev/FlightPath.worktrees/feature-historical",
  sourceCheckoutRoot: "C:/dev/FlightPath",
  baseCommit: "base-commit",
  changedFileCount: 12,
  directoryState: "present" as const,
  landingOutcome: "landed" as const,
  branchState: "present" as const,
  mergeOutcome: undefined,
};

function renderBanner(
  overrides: Partial<ComponentProps<typeof RunSummaryBanner>> = {}
) {
  return render(
    <RunSummaryBanner
      runId={14}
      startedAt={Date.parse("2026-08-10T12:10:23Z")}
      executionState={EXECUTION_STATES.COMPLETED}
      tokenTotals={tokenTotals}
      isPinned={true}
      onTogglePinned={vi.fn()}
      showBackToLive={false}
      onBackToLive={vi.fn()}
      {...overrides}
    />
  );
}

describe("RunSummaryBanner", () => {
  beforeEach(() => {
    vi.mocked(window.vscodeApi!.postMessage).mockClear();
  });

  it("shows the run number, date, status, and token/cost totals", () => {
    renderBanner();

    expect(screen.getByText(/Run 14/)).toBeInTheDocument();
    expect(screen.getByText(EXECUTION_STATES.COMPLETED)).toBeInTheDocument();
    expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
      "410k · ≈$0.41"
    );
  });

  it("renders nothing for token usage when there is no usable total", () => {
    renderBanner({ tokenTotals: undefined });

    expect(
      screen.queryByTestId("workflow-token-usage")
    ).not.toBeInTheDocument();
  });

  it("renders the persisted branch, landing outcome, and source-relative worktree path", () => {
    renderBanner({ worktree });

    expect(screen.getByText("feature/historical")).toBeInTheDocument();
    expect(screen.getByText(/✓ branch ready — 12 files/)).toBeInTheDocument();
    expect(
      screen.getByText("Worktree: FlightPath.worktrees/feature-historical")
    ).toBeInTheDocument();
  });

  it.each([
    ["fast-forward", "✓ merged (fast-forward)"],
    ["merge-commit", "✓ merged (merge commit)"],
    ["conflict", "⚠ merge conflict — branch preserved"],
    ["blocked", "⚠ merge blocked — source branch changed or checkout is dirty"],
  ] as const)("renders the persisted %s merge outcome", (mergeOutcome, text) => {
    renderBanner({
      worktree: {
        ...worktree,
        mode: "managed",
        mergeOutcome,
      },
    });
    expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
  });

  it("sends Merge for a present landed managed run", () => {
    const address = {
      workflowKey: "workflow-key" as WorkflowKey,
      kind: "run",
      runRef: "run-1" as RunRef,
    } satisfies Extract<WorkflowViewAddress, { kind: "run" }>;
    renderBanner({
      address,
      worktree: { ...worktree, mode: "managed" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(window.vscodeApi!.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.MERGE_WORKTREE,
      address,
    });
  });

  it("applies sticky positioning only while pinned", () => {
    const { container, rerender } = renderBanner({ isPinned: true });
    expect(container.firstChild).toHaveClass("sticky");

    rerender(
      <RunSummaryBanner
        runId={14}
        startedAt={Date.now()}
        executionState={EXECUTION_STATES.COMPLETED}
        tokenTotals={tokenTotals}
        isPinned={false}
        onTogglePinned={vi.fn()}
        showBackToLive={false}
      />
    );
    expect(container.firstChild).not.toHaveClass("sticky");
  });

  it("shows a pinned icon when pinned and a plain pin icon when unpinned, toggling on click", () => {
    const onTogglePinned = vi.fn();
    const { container, rerender } = renderBanner({
      isPinned: true,
      onTogglePinned,
    });

    const pinButton = screen.getByRole("button", {
      name: "Unpin run summary",
    });
    expect(container.querySelector(".codicon-pinned")).not.toBeNull();

    fireEvent.click(pinButton);
    expect(onTogglePinned).toHaveBeenCalledOnce();

    rerender(
      <RunSummaryBanner
        runId={14}
        startedAt={Date.now()}
        executionState={EXECUTION_STATES.COMPLETED}
        tokenTotals={tokenTotals}
        isPinned={false}
        onTogglePinned={onTogglePinned}
        showBackToLive={false}
      />
    );
    expect(
      screen.getByRole("button", { name: "Pin run summary" })
    ).toBeInTheDocument();
    expect(container.querySelector(".codicon-pin")).not.toBeNull();
  });

  it("shows Back to Live only when browsing history during a live execution", () => {
    const onBackToLive = vi.fn();
    renderBanner({ showBackToLive: true, onBackToLive });

    const backToLive = screen.getByRole("button", { name: /Back to Live/ });
    fireEvent.click(backToLive);
    expect(onBackToLive).toHaveBeenCalledOnce();
  });

  it("hides Back to Live when not applicable", () => {
    renderBanner({ showBackToLive: false });

    expect(
      screen.queryByRole("button", { name: /Back to Live/ })
    ).not.toBeInTheDocument();
  });

  it("uses the recorded base and branch for View Diff and opens only a present worktree", () => {
    const firstRender = renderBanner({ worktree });

    fireEvent.click(screen.getByRole("button", { name: "View Diff" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Worktree in New Window" })
    );

    expect(window.vscodeApi!.postMessage).toHaveBeenNthCalledWith(1, {
      type: MESSAGE_TYPES.VIEW_WORKTREE_DIFF,
      sourceCheckoutRoot: worktree.sourceCheckoutRoot,
      baseCommit: worktree.baseCommit,
      branchName: worktree.branchName,
    });
    expect(window.vscodeApi!.postMessage).toHaveBeenNthCalledWith(2, {
      type: MESSAGE_TYPES.OPEN_WORKTREE,
      worktreePath: worktree.worktreePath,
    });

    firstRender.unmount();
    renderBanner({
      worktree: { ...worktree, directoryState: "removed" },
    });
    expect(
      screen.queryByRole("button", { name: "Open Worktree in New Window" })
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "View Diff" })).toHaveLength(
      1
    );
  });

  it("disables filesystem undo for settled managed runs while retaining diff actions", () => {
    expect(isManagedWorktreeUndoUnavailable(worktree)).toBe(false);
    expect(
      isManagedWorktreeUndoUnavailable({
        ...worktree,
        mode: "managed",
        lifecycleState: "settled",
        directoryState: "removed",
      })
    ).toBe(true);
  });
});
