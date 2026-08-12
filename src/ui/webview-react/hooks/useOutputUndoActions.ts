import { useCallback, useMemo, useState } from "react";
import type {
  MinimapDialogState,
  WorkflowDialogState,
} from "@components/layout/output-section/OutputUndoDialogs";
import type { WorkflowStepEntry } from "@components/output/UndoChangesDialog";
import type { OutputRowFileUndoRequest } from "@components/output/OutputRow";
import { generateId } from "@utils/string";
import type { OutputMessage } from "@utils/outputProjection";
import type { CliOutput as CliOutputType } from "@/types/cliEvents";
import {
  buildUndoCandidatesForOutputs,
  buildUndoDialogInputForPrompt,
  buildUndoDialogInputForSpecificEvent,
  sameFilePath,
} from "@utils/promptUndo";
import type { CliHeaderRow, StructuredEventRow } from "@utils/outputRows";
import type {
  OrderedHistoryEntry,
  StepOutput,
  UndoExecutionTarget,
  UndoRecord,
  WorkspaceSnapshot,
  WorkflowRunMetadata,
} from "@root/types/OutputHistoryTypes";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { useUiStore } from "@store/uiStore";

type OutputHistoryView = {
  orderedEntries: OrderedHistoryEntry[];
  promptOutputs: Record<number, StepOutput>;
  finalStepOutputs?: Record<number, StepOutput>;
  runMetadata: WorkflowRunMetadata;
} | null;

interface UseOutputUndoActionsInput {
  allMessages: OutputMessage[];
  allowUndoActions: boolean;
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  historyOutputs: OutputHistoryView;
  isViewingHistory: boolean;
  lastCliIndexPerStep: Map<string, number>;
  stepOutputsMap: Map<string, CliOutputType[]>;
  undoRecords: Record<string, UndoRecord>;
  uniqueStepTargets: OutputMessage["target"][];
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
}

export interface OpenMinimapUndoDialogInput {
  target: UndoExecutionTarget;
  workspacePath: string;
  input: MinimapDialogState["input"];
}

export interface OpenMinimapRedoDialogInput {
  target: UndoExecutionTarget;
  workspacePath: string;
  redoInstructions: MinimapDialogState["redoInstructions"];
}

export function useOutputUndoActions({
  allMessages,
  allowUndoActions,
  finalStepWorkspaceSnapshots,
  historyOutputs,
  isViewingHistory,
  lastCliIndexPerStep,
  stepOutputsMap,
  undoRecords,
  uniqueStepTargets,
  workspaceSnapshots,
}: UseOutputUndoActionsInput) {
  const runAddress = useUiStore((state) =>
    state.displayedViewAddress?.kind === "run"
      ? {
          workflowKey: state.displayedViewAddress.workflowKey,
          runRef: state.displayedViewAddress.runRef,
        }
      : null
  );
  const [minimapDialogState, setMinimapDialogState] =
    useState<MinimapDialogState | null>(null);
  const [workflowDialogState, setWorkflowDialogState] =
    useState<WorkflowDialogState | null>(null);

  const workflowUndoRedoData = useMemo(() => {
    if (!allowUndoActions) {
      return { undoEntries: [], redoEntries: [] };
    }

    const undoEntries: WorkflowStepEntry[] = [];
    const redoEntries: WorkflowStepEntry[] = [];

    for (const msgTarget of uniqueStepTargets) {
      const key = `${msgTarget.kind}:${msgTarget.index}`;
      const lastCliIdx = lastCliIndexPerStep.get(key);
      if (lastCliIdx === undefined) continue;

      const lastMsg = allMessages[lastCliIdx];
      const lastOutput = lastMsg?.data as CliOutputType | undefined;
      if (!lastOutput || lastOutput.isStreaming) continue;

      const isFinalStep = msgTarget.kind === FINAL_STEP_PHASES.FINAL_STEP;
      const stepIndex = msgTarget.index;

      let effectiveSnapshot: WorkspaceSnapshot | undefined;
      let effectiveUndoRecord: UndoRecord | undefined;

      if (isViewingHistory && historyOutputs) {
        effectiveSnapshot = isFinalStep
          ? historyOutputs.finalStepOutputs?.[stepIndex]?.workspaceSnapshot
          : historyOutputs.promptOutputs[stepIndex]?.workspaceSnapshot;
        effectiveUndoRecord = isFinalStep
          ? historyOutputs.finalStepOutputs?.[stepIndex]?.undoRecord
          : historyOutputs.promptOutputs[stepIndex]?.undoRecord;
      } else {
        const targetKey = isFinalStep
          ? `finalStep-${stepIndex}`
          : `queue-${stepIndex}`;
        effectiveSnapshot = isFinalStep
          ? finalStepWorkspaceSnapshots[stepIndex]
          : workspaceSnapshots[stepIndex];
        effectiveUndoRecord = undoRecords[targetKey];
      }

      const stepOutputs = (stepOutputsMap.get(key) ?? []) as CliOutputType[];
      const undoTarget: UndoExecutionTarget = isFinalStep
        ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
        : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };
      const label = isFinalStep
        ? `Final Step Loop ${stepIndex + 1}`
        : `Prompt ${stepIndex + 1}`;

      const redoInstructions =
        effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
          ? (effectiveUndoRecord.redoInstructions ?? [])
          : [];

      if (redoInstructions.length > 0) {
        redoEntries.push({ target: undoTarget, label, redoInstructions });
      }

      const allCandidates = buildUndoCandidatesForOutputs(
        stepOutputs,
        effectiveSnapshot
      );
      const candidates =
        redoInstructions.length > 0
          ? allCandidates.filter(
              (candidate) =>
                !redoInstructions.some((instruction) =>
                  sameFilePath(candidate.path, instruction.path)
                )
            )
          : allCandidates;
      const undoCandidates = candidates.filter(
        (candidate) => candidate.instruction !== null
      );
      if (undoCandidates.length > 0) {
        undoEntries.push({ target: undoTarget, label, undoCandidates });
      }
    }

    return { undoEntries, redoEntries };
  }, [
    allowUndoActions,
    allMessages,
    finalStepWorkspaceSnapshots,
    historyOutputs,
    isViewingHistory,
    lastCliIndexPerStep,
    stepOutputsMap,
    undoRecords,
    uniqueStepTargets,
    workspaceSnapshots,
  ]);

  const openMinimapUndoDialog = useCallback(
    ({ target, input }: OpenMinimapUndoDialogInput) => {
      if (!runAddress) return;
      setMinimapDialogState({
        mode: "undo",
        target,
        address: runAddress,
        input,
        requestId: generateId(),
      });
    },
    [runAddress]
  );

  const openMinimapRedoDialog = useCallback(
    ({
      target,
      redoInstructions,
      // workspacePath remains a UI-only value used to build the diff model.
      // It is intentionally not persisted in dialog state or sent to the host.
    }: OpenMinimapRedoDialogInput) => {
      if (!runAddress) return;
      setMinimapDialogState({
        mode: "redo",
        target,
        address: runAddress,
        redoInstructions,
        requestId: generateId(),
      });
    },
    [runAddress]
  );

  const handlePromptUndo = useCallback(
    (row: CliHeaderRow) => {
      if (!row.promptUndo || !runAddress) return;
      const target: UndoExecutionTarget = row.isFinalStep
        ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: row.stepIndex }
        : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: row.stepIndex };
      const alreadyUndone =
        row.promptUndo.undoRecord != null &&
        row.promptUndo.undoRecord.isRedone !== true
          ? row.promptUndo.undoRecord.redoInstructions
          : undefined;
      const input = buildUndoDialogInputForPrompt(
        target,
        row.promptUndo.allStepOutputs,
        row.promptUndo.workspaceSnapshot,
        row.promptUndo.workspacePath,
        alreadyUndone
      );
      openMinimapUndoDialog({
        target,
        workspacePath: row.promptUndo.workspacePath,
        input,
      });
    },
    [openMinimapUndoDialog, runAddress]
  );

  const handlePromptRedo = useCallback(
    (row: CliHeaderRow) => {
      if (!row.promptUndo?.undoRecord?.redoInstructions?.length || !runAddress)
        return;
      const target: UndoExecutionTarget = row.isFinalStep
        ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: row.stepIndex }
        : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: row.stepIndex };
      openMinimapRedoDialog({
        target,
        workspacePath: row.promptUndo.workspacePath,
        redoInstructions: row.promptUndo.undoRecord.redoInstructions,
      });
    },
    [openMinimapRedoDialog, runAddress]
  );

  const handleFileUndo = useCallback(
    (row: StructuredEventRow, request: OutputRowFileUndoRequest) => {
      const target: UndoExecutionTarget =
        row.target.kind === FINAL_STEP_PHASES.FINAL_STEP
          ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: row.target.index }
          : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: row.target.index };
      const stepOutputs = stepOutputsMap.get(
        `${row.target.kind}:${row.target.index}`
      );
      const workspacePath =
        stepOutputs && stepOutputs.length > 0
          ? (stepOutputs[stepOutputs.length - 1]?.workingDirectory ?? "")
          : "";
      const showRedo =
        row.undoRecord != null && row.undoRecord.isRedone !== true;

      if (showRedo) {
        const fileRedoInstruction = row.undoRecord?.redoInstructions.find(
          (item) => sameFilePath(item.path, request.path)
        );
        if (fileRedoInstruction) {
          openMinimapRedoDialog({
            target,
            workspacePath,
            redoInstructions: [fileRedoInstruction],
          });
        }
        return;
      }

      const input = buildUndoDialogInputForSpecificEvent(
        target,
        request.eventIndex,
        request.path,
        request.event,
        row.workspaceSnapshot,
        workspacePath,
        {
          oldContent: request.oldContent,
          newContent: request.newContent,
          structuredPatch: request.structuredPatch,
        }
      );

      openMinimapUndoDialog({
        target,
        workspacePath,
        input,
      });
    },
    [openMinimapRedoDialog, openMinimapUndoDialog, stepOutputsMap]
  );

  const handleWorkflowUndo = useCallback(() => {
    if (!runAddress) return;
    setWorkflowDialogState({
      mode: "undo",
      address: runAddress,
      entries: workflowUndoRedoData.undoEntries,
      requestId: generateId(),
    });
  }, [runAddress, workflowUndoRedoData]);

  const handleWorkflowRedo = useCallback(() => {
    if (!runAddress) return;
    setWorkflowDialogState({
      mode: "redo",
      address: runAddress,
      entries: workflowUndoRedoData.redoEntries,
      requestId: generateId(),
    });
  }, [runAddress, workflowUndoRedoData]);

  const closeMinimapDialog = useCallback(() => {
    setMinimapDialogState(null);
  }, []);

  const closeWorkflowDialog = useCallback(() => {
    setWorkflowDialogState(null);
  }, []);

  return {
    closeMinimapDialog,
    closeWorkflowDialog,
    handleFileUndo,
    handlePromptRedo,
    handlePromptUndo,
    handleWorkflowRedo,
    handleWorkflowUndo,
    minimapDialogState,
    openMinimapRedoDialog,
    openMinimapUndoDialog,
    workflowDialogState,
    workflowUndoRedoData,
  };
}
