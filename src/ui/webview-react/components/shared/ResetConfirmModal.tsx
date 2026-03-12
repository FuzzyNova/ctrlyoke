import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useSettingsStore } from "../../store/settingsStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

interface ResetConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * ResetConfirmModal - Shared position/reset action confirmation dialog
 *
 * Features:
 * - Consistent confirmation UX for queue position and reset operations
 * - "Don't ask me again" checkbox that persists to VS Code settings
 * - Reads confirmResetOperations from global settings (defaults to true = always ask)
 * - Uses primary variant since position changes are recoverable (not destructive)
 */
export const ResetConfirmModal: React.FC<ResetConfirmModalProps> = ({
  isOpen,
  title,
  message,
  detail,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}) => {
  const vscode = useVsCodeApi();
  const { globalSettings } = useSettingsStore();
  // "Don't ask again" checkbox: checked means confirmResetOperations = false
  const [dontAsk, setDontAsk] = useState(
    !globalSettings.confirmResetOperations
  );

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setDontAsk(checked);
    // Persist setting immediately so it survives cancel too
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_CONFIRM_RESET,
      value: !checked, // confirmResetOperations = !dontAsk
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
          <Button variant="primary" size="md" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-foreground">{message}</p>
      {detail && <p className="mt-2 text-sm text-description-fg">{detail}</p>}

      {/* Don't ask again toggle */}
      <label className="mt-4 flex items-center gap-2 cursor-pointer select-none text-sm text-description-fg hover:text-foreground transition-colors">
        <input
          type="checkbox"
          checked={dontAsk}
          onChange={handleCheckboxChange}
          className="w-3.5 h-3.5 accent-button-bg cursor-pointer"
        />
        Don't ask me again for these operations
      </label>
    </Modal>
  );
};
