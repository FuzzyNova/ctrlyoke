import React from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
  dontWarnAgain?: boolean;
  onDontWarnAgainChange?: (checked: boolean) => void;
  dontWarnAgainLabel?: string;
}

/** Shared confirmation dialog for operations that delete user files. */
export const DeleteConfirmationModal: React.FC<
  DeleteConfirmationModalProps
> = ({
  isOpen,
  onClose,
  title,
  message,
  detail,
  confirmLabel,
  onConfirm,
  dontWarnAgain,
  onDontWarnAgainChange,
  dontWarnAgainLabel,
}) => (
  <Modal
    isOpen={isOpen}
    onClose={onClose}
    elevated
    title={title}
    size="sm"
    footer={
      <>
        <Button variant="secondary" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" size="md" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </>
    }
  >
    <p className="text-foreground">{message}</p>
    {detail && <p className="mt-2 text-sm text-description-fg">{detail}</p>}
    {onDontWarnAgainChange && dontWarnAgainLabel && (
      <label
        htmlFor="delete-confirmation-dont-warn"
        className="mt-4 flex cursor-pointer items-center gap-2 select-none text-sm text-description-fg transition-colors hover:text-foreground"
      >
        <input
          id="delete-confirmation-dont-warn"
          type="checkbox"
          checked={dontWarnAgain ?? false}
          onChange={(event) => onDontWarnAgainChange(event.target.checked)}
          aria-label={dontWarnAgainLabel}
          className="h-3.5 w-3.5 cursor-pointer accent-button-bg"
        />
        Don't warn me again
      </label>
    )}
  </Modal>
);
