import { useSyncExternalStore } from "react";
import { Button } from "@components/shared/Button";
import { Modal } from "@components/shared/Modal";
import {
  getWorkspaceRenameConfirmation,
  subscribeWorkspaceRenameConfirmation,
} from "@utils/workspaceEditConfirmation";

export function WorkspaceRenameConfirmationModal() {
  const request = useSyncExternalStore(
    subscribeWorkspaceRenameConfirmation,
    getWorkspaceRenameConfirmation,
    () => null
  );
  if (!request) return null;
  return (
    <Modal
      isOpen
      onClose={() => request.respond(false)}
      title="Rename Workspace Files?"
      size="sm"
      elevated
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={() => request.respond(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => request.respond(true)}>
            Apply Rename
          </Button>
        </div>
      }
    >
      <p className="text-sm text-foreground">
        This rename will update {request.fileCount} unopened{" "}
        {request.fileCount === 1 ? "file" : "files"} on disk. Continue?
      </p>
    </Modal>
  );
}
