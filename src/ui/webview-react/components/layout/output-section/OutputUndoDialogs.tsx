import React from "react";
import { UndoChangesDialog } from "@components/output/UndoChangesDialog";
import type { WorkflowStepEntry } from "@components/output/UndoChangesDialog";
import type { UndoExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { UndoFileInstruction } from "@/types/messages";
import type { UndoDialogInput } from "@utils/promptUndo";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";
import type {
  UndoDialogIntent,
  UndoRedoDirection,
} from "@root/types/DashboardConstants";

export interface MinimapDialogState {
  mode: UndoRedoDirection;
  intent: UndoDialogIntent;
  target: UndoExecutionTarget;
  address: WorkflowRunAddress;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  stepLabel?: string;
  stepName?: string;
  requestId: string;
}

export interface WorkflowDialogState {
  mode: UndoRedoDirection;
  intent: UndoDialogIntent;
  address: WorkflowRunAddress;
  entries: WorkflowStepEntry[];
  workflowName: string;
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
        intent={minimapDialogState.intent}
        target={minimapDialogState.target}
        workflowKey={minimapDialogState.address.workflowKey}
        runRef={minimapDialogState.address.runRef}
        input={minimapDialogState.input}
        redoInstructions={minimapDialogState.redoInstructions}
        stepLabel={minimapDialogState.stepLabel}
        stepName={minimapDialogState.stepName}
        requestId={minimapDialogState.requestId}
        onClose={onCloseMinimapDialog}
      />
    )}

    {workflowDialogState && workflowDialogState.entries.length > 0 && (
      <UndoChangesDialog
        mode={workflowDialogState.mode}
        intent={workflowDialogState.intent}
        target={workflowDialogState.entries[0].target}
        workflowKey={workflowDialogState.address.workflowKey}
        runRef={workflowDialogState.address.runRef}
        requestId={workflowDialogState.requestId}
        workflowEntries={workflowDialogState.entries}
        workflowName={workflowDialogState.workflowName}
        onClose={onCloseWorkflowDialog}
      />
    )}
  </>
);
