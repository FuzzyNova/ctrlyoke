import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useSettingsStore } from "../../store/settingsStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";
import {
  RERUN_CONFIRMATION_MODES,
  type RerunConfirmationMode,
} from "@root/types/DashboardConstants";
import { RERUN_CONFIRMATION_MODE_OPTIONS_META } from "@root/types/SchemaUiMetadata";

interface RerunConfirmModalProps {
  workflowName: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** What each `ui.confirmRerunOperations` choice means, shown under its label. */
const RERUN_CONFIRMATION_MODE_HINTS: Record<RerunConfirmationMode, string> = {
  [RERUN_CONFIRMATION_MODES.ALWAYS]: "Ask for every workflow, favorites too.",
  [RERUN_CONFIRMATION_MODES.EXCEPT_FAVORITES]:
    "Ask unless the workflow is a favorite.",
  [RERUN_CONFIRMATION_MODES.NEVER]: "Re-run straight away, without asking.",
};

/**
 * Asks before Re-run starts a new run from the first step. Re-run sits beside
 * the workflow picker, so a stray tap on a conversation-style workflow would
 * otherwise replay every step.
 *
 * The dialog shows every `ui.confirmRerunOperations` choice with the current
 * one selected, so the user can see why it appeared and change it in place.
 * A choice is saved as soon as it is picked, so it survives Cancel too.
 * Mount it only while open: the selection is seeded from the setting when the
 * modal mounts.
 */
export const RerunConfirmModal: React.FC<RerunConfirmModalProps> = ({
  workflowName,
  onConfirm,
  onCancel,
}) => {
  const vscode = useVsCodeApi();
  const openedMode = useSettingsStore(
    (state) => state.globalSettings.confirmRerunOperations
  );
  const [mode, setMode] = useState<RerunConfirmationMode>(openedMode);

  const handleModeChange = (value: RerunConfirmationMode) => {
    setMode(value);
    vscode.postMessage({ type: MESSAGE_TYPES.UPDATE_CONFIRM_RERUN, value });
  };

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title="Re-run Workflow"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={onConfirm}>
            Re-run
          </Button>
        </>
      }
    >
      <p className="text-foreground">
        {workflowName
          ? `Start a new run of "${workflowName}" from its first step?`
          : "Start a new run of this workflow from its first step?"}
      </p>
      <p className="mt-2 text-sm text-description-fg">
        The current run stays in history.
      </p>

      <fieldset className="mt-4 space-y-2">
        <legend className="mb-2 text-sm text-description-fg">
          Ask before re-running
        </legend>
        {Object.values(RERUN_CONFIRMATION_MODE_OPTIONS_META).map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-sm border border-panel-border px-3 py-2 text-sm text-foreground"
          >
            <input
              type="radio"
              name="rerun-confirmation-mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => handleModeChange(option.value)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-focus-border"
            />
            <span className="flex flex-col">
              {option.label}
              <span className="text-xs text-description-fg">
                {RERUN_CONFIRMATION_MODE_HINTS[option.value]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </Modal>
  );
};
