import React from "react";
import { UndoChangesDialog } from "@components/output/UndoChangesDialog";
import type { WorkflowStepEntry } from "@components/output/UndoChangesDialog";
import type { UndoExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { UndoFileInstruction } from "@/types/messages";
import type { UndoDialogInput } from "@utils/promptUndo";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";

export interface MinimapDialogState {
  mode: "undo" | "redo";
  target: UndoExecutionTarget;
  address: WorkflowRunAddress;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  requestId: string;
}

export interface WorkflowDialogState {
  mode: "undo" | "redo";
  address: WorkflowRunAddress;
  entries: WorkflowStepEntry[];
  requestId: string;
}

interface OutputUndoDialogsProps {
  minimapDialogState: MinimapDialogState | null;
  workflowDialogState: WorkflowDialogState | null;
  onCloseMinimapDialog: () => void;
  onCloseWorkflowDialog: () => void;
}

export const OutputUndoDialogs: React.FC<OutputUndoDialogsProps> = ({
  minimapDialogState,
  workflowDialogState,
  onCloseMinimapDialog,
  onCloseWorkflowDialog,
}) => (
  <>
    {minimapDialogState && (
      <UndoChangesDialog
        mode={minimapDialogState.mode}
        target={minimapDialogState.target}
        workflowKey={minimapDialogState.address.workflowKey}
        runRef={minimapDialogState.address.runRef}
        input={minimapDialogState.input}
        redoInstructions={minimapDialogState.redoInstructions}
        requestId={minimapDialogState.requestId}
        onClose={onCloseMinimapDialog}
      />
    )}

    {workflowDialogState && (
      <UndoChangesDialog
        mode={workflowDialogState.mode}
        target={workflowDialogState.entries[0].target}
        workflowKey={workflowDialogState.address.workflowKey}
        runRef={workflowDialogState.address.runRef}
        requestId={workflowDialogState.requestId}
        workflowEntries={workflowDialogState.entries}
        onClose={onCloseWorkflowDialog}
      />
    )}
  </>
);
