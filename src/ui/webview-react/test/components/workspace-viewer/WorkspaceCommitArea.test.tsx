import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCommitArea } from "@components/workspace-viewer/WorkspaceCommitArea";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceGenerateCommitMessage } from "@utils/hostedApi";

vi.mock("@utils/hostedApi", () => ({
  workspaceCommit: vi.fn(),
  workspacePull: vi.fn(),
  workspacePush: vi.fn(),
  workspaceStage: vi.fn(),
  workspaceGenerateCommitMessage: vi.fn(),
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

  describe("generate button", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      useWorkspaceViewerStore.setState({ generatingCommitMessage: false });
    });

    function renderCommitArea() {
      return render(
        <WorkspaceCommitArea
          incomingCommitCount={0}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          outgoingCommitCount={0}
        />
      );
    }

    it("renders the generate button", () => {
      renderCommitArea();

      const generateButton = screen.getByTestId("generate-commit-message-btn");

      expect(generateButton).toBeInTheDocument();
      expect(
        generateButton.querySelector(
          ".custom-icon.icon-generate-commit-message"
        )
      ).not.toBeNull();
    });

    it("calls workspaceGenerateCommitMessage when generate button is clicked", async () => {
      const user = userEvent.setup();
      vi.mocked(workspaceGenerateCommitMessage).mockResolvedValue({
        message: "feat: test",
        staged: true,
        truncated: false,
      });
      renderCommitArea();

      await user.click(screen.getByTestId("generate-commit-message-btn"));

      await waitFor(() => {
        expect(workspaceGenerateCommitMessage).toHaveBeenCalledOnce();
      });
    });

    it("populates the commit message textarea on success", async () => {
      const user = userEvent.setup();
      vi.mocked(workspaceGenerateCommitMessage).mockResolvedValue({
        message: "feat: test",
        staged: true,
        truncated: false,
      });
      renderCommitArea();

      await user.click(screen.getByTestId("generate-commit-message-btn"));

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("feat: test");
      });
    });

    it("shows the stop icon while generating and keeps the button enabled", async () => {
      const user = userEvent.setup();
      // Return a promise that never resolves to keep the loading state active.
      vi.mocked(workspaceGenerateCommitMessage).mockReturnValue(
        new Promise(() => {})
      );
      renderCommitArea();

      const generateButton = screen.getByTestId("generate-commit-message-btn");
      await user.click(generateButton);

      await waitFor(() => {
        expect(generateButton).not.toBeDisabled();
        expect(
          generateButton.querySelector(".codicon-stop-circle")
        ).not.toBeNull();
      });
    });

    it("does not crash when workspaceGenerateCommitMessage rejects", async () => {
      const user = userEvent.setup();
      vi.mocked(workspaceGenerateCommitMessage).mockRejectedValue(
        new Error("Network error")
      );
      renderCommitArea();

      const generateButton = screen.getByTestId("generate-commit-message-btn");
      await user.click(generateButton);

      // After the rejection the error is caught and the button re-enables.
      await waitFor(() => {
        expect(generateButton).not.toBeDisabled();
      });
      // The component should still be present in the document.
      expect(
        screen.getByRole("button", { name: "Commit" })
      ).toBeInTheDocument();
    });
  });
});
