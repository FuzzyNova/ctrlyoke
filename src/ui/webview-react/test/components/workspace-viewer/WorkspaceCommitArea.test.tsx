import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCommitArea } from "@components/workspace-viewer/WorkspaceCommitArea";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  workspaceGenerateCommitMessage,
  workspacePush,
} from "@utils/hostedApi";

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
      screen.getByRole("button", { name: "Push commits" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pull commits" })
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

      const generateButton = screen.getByRole("button", {
        name: "Generate commit message",
      });

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

      await user.click(
        screen.getByRole("button", { name: "Generate commit message" })
      );

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

      await user.click(
        screen.getByRole("button", { name: "Generate commit message" })
      );

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("feat: test");
      });
    });

    it("disables the commit message input while generating and keeps the stop button enabled", async () => {
      const user = userEvent.setup();
      // Return a promise that never resolves to keep the loading state active.
      vi.mocked(workspaceGenerateCommitMessage).mockReturnValue(
        new Promise(() => {})
      );
      renderCommitArea();

      const generateButton = screen.getByRole("button", {
        name: "Generate commit message",
      });
      await user.click(generateButton);

      await waitFor(() => {
        expect(generateButton).not.toBeDisabled();
        expect(
          screen.getByRole("textbox", { name: "Commit message" })
        ).toBeDisabled();
        expect(
          screen.getByPlaceholderText("Generating commit message")
        ).toBeInTheDocument();
        expect(
          generateButton.querySelector(".codicon-stop-circle")
        ).not.toBeNull();
      });
    });

    it("re-enables the commit message input when generation is canceled", async () => {
      const user = userEvent.setup();
      vi.mocked(workspaceGenerateCommitMessage).mockImplementation(
        (_instructions, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          })
      );
      renderCommitArea();

      const generateButton = screen.getByRole("button", {
        name: "Generate commit message",
      });
      const commitMessageInput = screen.getByRole("textbox", {
        name: "Commit message",
      });
      await user.click(generateButton);

      await waitFor(() => expect(commitMessageInput).toBeDisabled());
      await user.click(generateButton);

      await waitFor(() => expect(commitMessageInput).not.toBeDisabled());
      expect(commitMessageInput).toHaveValue("Ship it");
    });

    it("does not crash when workspaceGenerateCommitMessage rejects", async () => {
      const user = userEvent.setup();
      vi.mocked(workspaceGenerateCommitMessage).mockRejectedValue(
        new Error("Network error")
      );
      renderCommitArea();

      const generateButton = screen.getByRole("button", {
        name: "Generate commit message",
      });
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

  describe("repo selector", () => {
    beforeEach(() => {
      vi.clearAllMocks();
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

    it("hides the selector in a single-repo workspace", () => {
      useWorkspaceViewerStore.setState({
        repos: [{ id: "only", label: "only", rootPath: "/only" }],
        selectedRepoId: "only",
      });
      renderCommitArea();

      expect(
        screen.queryByRole("combobox", { name: "Select repository" })
      ).toBeNull();
    });

    it("shows the selector and scopes push to the chosen repo", async () => {
      const user = userEvent.setup();
      vi.mocked(workspacePush).mockResolvedValue({
        branch: "main",
        remote: "origin",
      });
      useWorkspaceViewerStore.setState({
        repos: [
          { id: "alpha", label: "alpha", rootPath: "/alpha" },
          { id: "beta", label: "beta", rootPath: "/beta" },
        ],
        selectedRepoId: "alpha",
      });
      renderCommitArea();

      const select = screen.getByRole("combobox", {
        name: "Select repository",
      });
      await user.selectOptions(select, "beta");
      expect(useWorkspaceViewerStore.getState().selectedRepoId).toBe("beta");

      await user.click(screen.getByRole("button", { name: /Push/ }));
      expect(workspacePush).toHaveBeenCalledWith("beta");
    });
  });
});
