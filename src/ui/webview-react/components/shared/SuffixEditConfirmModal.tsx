import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useSettingsStore } from "../../store/settingsStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

interface SuffixEditConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirms losing unsaved edits to a rewound run's suffix before discarding a
 * continuation or starting a new run instead. Always our own modal — never a
 * native OS/VS Code dialog — so hosted browser clients (which never see VS
 * Code's own UI) can see and act on this prompt too.
 *
 * Only rendered when the extension is asking for confirmation in the first
 * place — when confirmContinuationDiscardOperations is off, the message
 * handler resends the action with confirmEditedSuffix: true before this
 * component ever mounts, so the "Don't ask again" checkbox here only needs to
 * flip the setting for next time.
 */
export const SuffixEditConfirmModal: React.FC<SuffixEditConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}) => {
  const vscode = useVsCodeApi();
  const { globalSettings } = useSettingsStore();
  // "Don't ask again" checkbox: checked means confirmContinuationDiscardOperations = false
  const [dontAsk, setDontAsk] = useState(
    !globalSettings.confirmContinuationDiscardOperations
  );

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setDontAsk(checked);
    // Persist setting immediately so it survives cancel too
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_CONFIRM_CONTINUATION_DISCARD,
      value: !checked, // confirmContinuationDiscardOperations = !dontAsk
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
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-foreground">{message}</p>

      {/* Don't ask again toggle */}
      <label
        htmlFor="suffix-edit-discard-dont-ask"
        className="mt-4 flex items-center gap-2 cursor-pointer select-none text-sm text-description-fg hover:text-foreground transition-colors"
      >
        <input
          id="suffix-edit-discard-dont-ask"
          type="checkbox"
          checked={dontAsk}
          onChange={handleCheckboxChange}
          aria-label="Don't ask me again for continuation discard operations"
          className="w-3.5 h-3.5 accent-button-bg cursor-pointer"
        />
        Don't ask me again for continuation discard operations
      </label>
    </Modal>
  );
};
