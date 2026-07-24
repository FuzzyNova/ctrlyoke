import React from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

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
 */
export const SuffixEditConfirmModal: React.FC<SuffixEditConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}) => {
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
    </Modal>
  );
};
