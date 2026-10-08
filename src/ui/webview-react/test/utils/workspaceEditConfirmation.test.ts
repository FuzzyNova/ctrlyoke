import { describe, expect, it } from "vitest";
import {
  confirmWorkspaceRename,
  getWorkspaceRenameConfirmation,
} from "@utils/workspaceEditConfirmation";

describe("workspace rename confirmation", () => {
  it("rejects an earlier pending request when a newer confirmation replaces it", async () => {
    const first = confirmWorkspaceRename(2);
    const second = confirmWorkspaceRename(3);
    await expect(first).resolves.toBe(false);
    expect(getWorkspaceRenameConfirmation()?.fileCount).toBe(3);
    getWorkspaceRenameConfirmation()?.respond(true);
    await expect(second).resolves.toBe(true);
  });
});
