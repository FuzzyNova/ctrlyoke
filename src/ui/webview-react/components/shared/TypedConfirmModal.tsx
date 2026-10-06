import React, { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";

interface TypedConfirmModalProps {
  isOpen: boolean;
  title: string;
  /** The phrase the user must type; matched case-insensitively and trimmed. */
  phrase: string;
  confirmLabel: string;
  /** Extra gate on top of the phrase, e.g. while a preview is loading. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

/** True when `value` spells `phrase`, ignoring case and surrounding space (iOS capitalizes the first letter). */
export function matchesConfirmationPhrase(
  value: string,
  phrase: string
): boolean {
  return value.trim().toLowerCase() === phrase.toLowerCase();
}

/**
 * Confirmation for operations too broad to leave to a single tap: the confirm
 * button stays disabled until the user types `phrase`. It never offers "Don't
 * ask again" and ignores `confirmDeleteOperations` on purpose.
 */
export const TypedConfirmModal: React.FC<TypedConfirmModalProps> = ({
  isOpen,
  title,
  phrase,
  confirmLabel,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}) => {
  const inputId = useId();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!isOpen) setTyped("");
  }, [isOpen]);

  const canConfirm =
    !confirmDisabled && matchesConfirmationPhrase(typed, phrase);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      size="md"
      fullWidthOnNarrow
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="md"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-foreground">{children}</div>
      <label
        htmlFor={inputId}
        className="mt-4 block text-sm text-description-fg"
      >
        Type <code className="text-foreground">{phrase}</code> to confirm.
      </label>
      <input
        id={inputId}
        type="text"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === KEYBOARD_KEYS.ENTER && canConfirm) onConfirm();
        }}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="mt-1 w-full bg-input-bg border border-input-border rounded-sm px-2 py-1.5 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
      />
    </Modal>
  );
};
