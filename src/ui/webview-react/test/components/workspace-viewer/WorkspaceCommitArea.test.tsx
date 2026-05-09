import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCommitArea } from "@components/workspace-viewer/WorkspaceCommitArea";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

vi.mock("@utils/hostedApi", () => ({
  workspaceCommit: vi.fn(),
  workspacePull: vi.fn(),
  workspacePush: vi.fn(),
  workspaceStage: vi.fn(),
}));

describe("WorkspaceCommitArea", () => {
  beforeEach(() => {
    useWorkspaceViewerStore.getState().close();
    useWorkspaceViewerStore.setState({
      commitMessage: "Ship it",
      committing: false,
      pulling: false,
      pushing: false,
      scmError: null,
      sourceControlFiles: [],
    });
  });

  it("renders push and pull labels with sync counts", () => {
    render(
      <WorkspaceCommitArea
        incomingCommitCount={2}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        outgoingCommitCount={1}
      />
    );

    expect(
      screen.getByRole("button", { name: "Push (1)" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pull (2)" })
    ).toBeInTheDocument();
  });

  it("renders the commit action as a full-width button", () => {
    render(
      <WorkspaceCommitArea
        incomingCommitCount={0}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        outgoingCommitCount={0}
      />
    );

    expect(screen.getByRole("button", { name: "Commit" }).className).toContain(
      "w-full"
    );
  });
});
