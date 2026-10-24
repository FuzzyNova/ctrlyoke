import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { DontAskAgainCheckbox } from "./DontAskAgainCheckbox";
import { useSettingsStore } from "../../store/settingsStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

interface DeleteConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  /** Optional additional descriptive text shown below message */
  detail?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * DeleteConfirmModal - Shared destructive-action confirmation dialog
 *
 * Features:
 * - Consistent delete confirmation UX for both prompts and workflows
 * - "Don't ask me again" checkbox that persists to VS Code settings
 * - Reads confirmDeleteOperations from global settings (defaults to true = always ask)
 */
export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  title,
  message,
  detail,
  onConfirm,
  onCancel,
}) => {
  const vscode = useVsCodeApi();
  const { globalSettings } = useSettingsStore();
  // "Don't ask again" checkbox: checked means confirmDeleteOperations = false
  const [dontAsk, setDontAsk] = useState(
    !globalSettings.confirmDeleteOperations
  );

  const handleCheckboxChange = (checked: boolean) => {
    setDontAsk(checked);
    // Persist setting immediately so it survives cancel too
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_CONFIRM_DELETE,
      value: !checked, // confirmDeleteOperations = !dontAsk
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" size="md" onClick={onConfirm}>
            Delete
          </Button>
        </>
      }
    >
      <p className="text-foreground">{message}</p>
      {detail && <p className="mt-2 text-sm text-description-fg">{detail}</p>}

      <DontAskAgainCheckbox
        id="delete-dont-ask"
        label="Don't ask me again for delete operations"
        checked={dontAsk}
        onChange={handleCheckboxChange}
      />
    </Modal>
  );
};
