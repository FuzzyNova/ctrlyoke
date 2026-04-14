import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
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

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
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

      {/* Don't ask again toggle */}
      <label
        htmlFor="delete-dont-ask"
        className="mt-4 flex items-center gap-2 cursor-pointer select-none text-sm text-description-fg hover:text-foreground transition-colors"
      >
        <input
          id="delete-dont-ask"
          type="checkbox"
          checked={dontAsk}
          onChange={handleCheckboxChange}
          aria-label="Don't ask me again for delete operations"
          className="w-3.5 h-3.5 accent-button-bg cursor-pointer"
        />
        Don't ask me again for delete operations
      </label>
    </Modal>
  );
};
