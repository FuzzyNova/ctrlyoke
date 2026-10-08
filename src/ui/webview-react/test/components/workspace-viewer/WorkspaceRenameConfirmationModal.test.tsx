import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceRenameConfirmationModal } from "@components/workspace-viewer/WorkspaceRenameConfirmationModal";
import {
  confirmWorkspaceRename,
  getWorkspaceRenameConfirmation,
} from "@utils/workspaceEditConfirmation";

describe("WorkspaceRenameConfirmationModal", () => {
  beforeEach(() => {
    getWorkspaceRenameConfirmation()?.respond(false);
  });

  it("shows the unopened file count and confirms the rename", async () => {
    const user = userEvent.setup();
    const confirmation = confirmWorkspaceRename(3);
    render(<WorkspaceRenameConfirmationModal />);

    expect(
      screen.getByText(/update 3 unopened files on disk/i)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply Rename" }));

    await expect(confirmation).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels when dismissed", async () => {
    const user = userEvent.setup();
    const confirmation = confirmWorkspaceRename(1);
    render(<WorkspaceRenameConfirmationModal />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await expect(confirmation).resolves.toBe(false);
  });
});
