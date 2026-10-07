import type { ComponentProps } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RunSummaryBanner } from "@components/output/RunSummaryBanner";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { EXECUTION_STATES } from "@/types/messages";
import { workspaceWorktreeDiff } from "@utils/hostedApi";
import { useUiStore } from "@store/uiStore";

vi.hoisted(() => {
  window.__ctrlyokeStandalone = true;
});

vi.mock("@utils/hostedApi", () => ({
  workspaceWorktreeDiff: vi.fn(),
}));

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
      worktree={worktree}
      isPinned={true}
      onTogglePinned={vi.fn()}
      showBackToLive={false}
      {...overrides}
    />
  );
}

describe("RunSummaryBanner in the hosted browser (isStandalone)", () => {
  beforeEach(() => {
    useWorkspaceViewerStore.getState().reset();
    useUiStore.setState({ hostCapabilities: [] });
    vi.mocked(workspaceWorktreeDiff).mockReset();
  });

  it("shows a copy-path action when the host cannot open a new native window", () => {
    renderBanner();

    expect(
      screen.queryByRole("button", { name: "Open Worktree in New Window" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy worktree path" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View Diff" })
    ).toBeInTheDocument();
  });

  it("opens the recorded branch diff in the workspace viewer instead of posting a message", () => {
    vi.mocked(workspaceWorktreeDiff).mockResolvedValue({ unifiedDiff: "" });
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "View Diff" }));

    expect(workspaceWorktreeDiff).toHaveBeenCalledWith(
      worktree.sourceCheckoutRoot,
      worktree.baseCommit,
      worktree.branchName
    );
    const state = useWorkspaceViewerStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.activeTab).toBe("sourceControl");
  });
});
