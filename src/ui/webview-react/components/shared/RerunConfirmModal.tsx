import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { DontAskAgainCheckbox } from "./DontAskAgainCheckbox";
import { useSettingsStore } from "../../store/settingsStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";
import {
  RERUN_CONFIRMATION_MODES,
  type RerunConfirmationMode,
} from "@root/types/DashboardConstants";

interface RerunConfirmModalProps {
  workflowName: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Asks before Re-run starts a new run from the first step. Re-run sits beside
 * the workflow picker, so a stray tap on a conversation-style workflow would
 * otherwise replay every step. Which workflows ask is `ui.confirmRerunOperations`.
 *
 * Mount it only while open: the "Don't ask again" box is seeded from the
 * setting when the modal mounts. Checking it switches the setting to `never`;
 * unchecking it restores the mode the dialog opened under.
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
  const [dontAsk, setDontAsk] = useState(false);

  const handleCheckboxChange = (checked: boolean) => {
    setDontAsk(checked);
    const value: RerunConfirmationMode = checked
      ? RERUN_CONFIRMATION_MODES.NEVER
      : openedMode;
    // Persist setting immediately so it survives cancel too
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
        {openedMode === RERUN_CONFIRMATION_MODES.EXCEPT_FAVORITES &&
          " Favorite this workflow to re-run it without being asked."}
      </p>

      <DontAskAgainCheckbox
        id="rerun-dont-ask"
        label="Don't ask me again before re-running"
        checked={dontAsk}
        onChange={handleCheckboxChange}
      />
    </Modal>
  );
};
