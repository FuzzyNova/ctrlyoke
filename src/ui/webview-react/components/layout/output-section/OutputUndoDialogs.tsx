import React from "react";
import { UndoChangesDialog } from "@components/output/UndoChangesDialog";
import type { WorkflowStepEntry } from "@components/output/UndoChangesDialog";
import type { UndoExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { UndoFileInstruction } from "@/types/messages";
import type { UndoDialogInput } from "@utils/promptUndo";

export interface MinimapDialogState {
  mode: "undo" | "redo";
  target: UndoExecutionTarget;
  workspacePath: string;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  requestId: string;
}

export interface WorkflowDialogState {
  mode: "undo" | "redo";
  workspacePath: string;
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
        workspacePath={minimapDialogState.workspacePath}
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
        workspacePath={workflowDialogState.workspacePath}
        requestId={workflowDialogState.requestId}
        workflowEntries={workflowDialogState.entries}
        onClose={onCloseWorkflowDialog}
      />
    )}
  </>
);
