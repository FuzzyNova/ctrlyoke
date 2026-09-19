import { useCallback, useMemo, useState } from "react";
import type {
  MinimapDialogState,
  WorkflowDialogState,
} from "@components/layout/output-section/OutputUndoDialogs";
import type { WorkflowStepEntry } from "@components/output/UndoChangesDialog";
import type { OutputRowFileUndoRequest } from "@components/output/OutputRow";
import { generateId } from "@utils/string";
import { getTargetKey, type OutputMessage } from "@utils/outputProjection";
import type { CliOutput as CliOutputType } from "@/types/cliEvents";
import {
  buildUndoCandidatesForOutputs,
  buildUndoDialogInputForPrompt,
  buildUndoDialogInputForSpecificEvent,
  sameFilePath,
} from "@utils/promptUndo";
import type {
  CliHeaderRow,
  OutputRowPromptUndoMeta,
  ParallelGroupHeaderRow,
  StructuredEventRow,
} from "@utils/outputRows";
import type { OutputMessageTarget } from "@utils/outputProjection";
import type {
  OrderedHistoryEntry,
  StepOutput,
  UndoExecutionTarget,
  UndoRecord,
  WorkspaceSnapshot,
  WorkflowRunMetadata,
} from "@root/types/OutputHistoryTypes";
import { FINAL_STEP_PHASES } from "@/types/messages";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import { useUiStore } from "@store/uiStore";
import {
  UNDO_DIALOG_INTENTS,
  UNDO_REDO_DIRECTIONS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { useWorkflowDisplayName } from "@hooks/useWorkflowDisplayName";

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
  parallelGroups?: readonly ParallelGroupDefinition[];
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

/**
 * The execution-side spelling of an output row's target. Every prompt/file undo
 * entry point needs it, so it is derived once rather than re-branched per
 * handler.
 */
function toUndoExecutionTarget(
  target: OutputMessageTarget
): UndoExecutionTarget {
  return target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: target.index }
    : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: target.index };
}

export function useOutputUndoActions({
  allMessages,
  allowUndoActions,
  finalStepWorkspaceSnapshots,
  parallelGroups,
  historyOutputs,
  isViewingHistory,
  lastCliIndexPerStep,
  stepOutputsMap,
  undoRecords,
  uniqueStepTargets,
  workspaceSnapshots,
}: UseOutputUndoActionsInput) {
  // Select the stored address reference itself — a selector that builds a fresh
  // object returns a new snapshot on every read, which makes zustand's
  // useSyncExternalStore re-render forever ("Maximum update depth exceeded").
  // Derive the run-only shape in a memo instead.
  const displayedViewAddress = useUiStore(
    (state) => state.displayedViewAddress
  );
  const runAddress = useMemo<WorkflowRunAddress | null>(
    () =>
      displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
        ? {
            workflowKey: displayedViewAddress.workflowKey,
            runRef: displayedViewAddress.runRef,
          }
        : null,
    [displayedViewAddress]
  );
  const workflowDisplayName = useWorkflowDisplayName();
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
      const key = getTargetKey(msgTarget);
      const lastCliIdx = lastCliIndexPerStep.get(key);
      if (lastCliIdx === undefined) continue;

      const lastMsg = allMessages[lastCliIdx];
      const lastOutput = lastMsg?.data as CliOutputType | undefined;
      if (!lastOutput || lastOutput.isStreaming) continue;

      const isFinalStep = msgTarget.kind === FINAL_STEP_PHASES.FINAL_STEP;
      const stepIndex = msgTarget.index;
      const parallelGroup = isFinalStep
        ? undefined
        : parallelGroups?.find(
            (group) =>
              stepIndex >= group.startIndex &&
              stepIndex <= group.endIndex &&
              group.startIndex !== group.endIndex
          );
      const groupSnapshot = parallelGroup
        ? isViewingHistory && historyOutputs
          ? historyOutputs.promptOutputs[parallelGroup.startIndex]
              ?.workspaceSnapshot
          : workspaceSnapshots[parallelGroup.startIndex]
        : undefined;
      const concurrentGroup =
        parallelGroup?.id === groupSnapshot?.parallelGroupId
          ? parallelGroup
          : undefined;
      if (concurrentGroup && stepIndex !== concurrentGroup.startIndex) {
        continue;
      }

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
      if (concurrentGroup) {
        effectiveSnapshot = groupSnapshot;
      }
      const undoTarget: UndoExecutionTarget = isFinalStep
        ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
        : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };
      const label = isFinalStep
        ? `Final Step Loop ${stepIndex + 1}`
        : concurrentGroup
          ? `Parallel steps ${concurrentGroup.startIndex + 1}–${concurrentGroup.endIndex + 1}`
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
    parallelGroups,
    stepOutputsMap,
    undoRecords,
    uniqueStepTargets,
    workspaceSnapshots,
  ]);

  const openMinimapUndoDialog = useCallback(
    ({ target, input }: OpenMinimapUndoDialogInput) => {
      if (!runAddress) return;
      setMinimapDialogState({
        mode: UNDO_REDO_DIRECTIONS.UNDO,
        intent: UNDO_DIALOG_INTENTS.ACT,
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
        mode: UNDO_REDO_DIRECTIONS.REDO,
        intent: UNDO_DIALOG_INTENTS.ACT,
        target,
        address: runAddress,
        redoInstructions,
        requestId: generateId(),
      });
    },
    [runAddress]
  );

  const handlePromptUndoMeta = useCallback(
    (
      target: OutputMessageTarget,
      promptUndo: OutputRowPromptUndoMeta | undefined
    ) => {
      if (!promptUndo || !runAddress) return;
      const undoTarget = toUndoExecutionTarget(target);
      const alreadyUndone =
        promptUndo.undoRecord != null && promptUndo.undoRecord.isRedone !== true
          ? promptUndo.undoRecord.redoInstructions
          : undefined;
      const input = buildUndoDialogInputForPrompt(
        undoTarget,
        promptUndo.allStepOutputs,
        promptUndo.workspaceSnapshot,
        promptUndo.workspacePath,
        alreadyUndone
      );
      openMinimapUndoDialog({
        target: undoTarget,
        workspacePath: promptUndo.workspacePath,
        input,
      });
    },
    [openMinimapUndoDialog, runAddress]
  );

  // Widened past `CliHeaderRow` so a parallel group's header row — which
  // carries the same group-wide `promptUndo` meta — reuses this handler.
  const handlePromptUndo = useCallback(
    (row: CliHeaderRow | ParallelGroupHeaderRow) =>
      handlePromptUndoMeta(row.target, row.promptUndo),
    [handlePromptUndoMeta]
  );

  // Widened alongside `handlePromptUndo`: a parallel group's redo is offered on
  // its header row, whose `target` is the group's first member — the same
  // target the group's undo record is stored against.
  const handlePromptRedo = useCallback(
    (row: CliHeaderRow | ParallelGroupHeaderRow) => {
      if (!row.promptUndo?.undoRecord?.redoInstructions?.length || !runAddress)
        return;
      openMinimapRedoDialog({
        target: toUndoExecutionTarget(row.target),
        workspacePath: row.promptUndo.workspacePath,
        redoInstructions: row.promptUndo.undoRecord.redoInstructions,
      });
    },
    [openMinimapRedoDialog, runAddress]
  );

  const handleFileUndo = useCallback(
    (row: StructuredEventRow, request: OutputRowFileUndoRequest) => {
      const target = toUndoExecutionTarget(row.target);
      const stepOutputs = stepOutputsMap.get(getTargetKey(row.target));
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
      mode: UNDO_REDO_DIRECTIONS.UNDO,
      intent: UNDO_DIALOG_INTENTS.ACT,
      address: runAddress,
      entries: workflowUndoRedoData.undoEntries,
      workflowName: workflowDisplayName,
      requestId: generateId(),
    });
  }, [runAddress, workflowDisplayName, workflowUndoRedoData]);

  const handleWorkflowRedo = useCallback(() => {
    if (!runAddress) return;
    setWorkflowDialogState({
      mode: UNDO_REDO_DIRECTIONS.REDO,
      intent: UNDO_DIALOG_INTENTS.ACT,
      address: runAddress,
      entries: workflowUndoRedoData.redoEntries,
      workflowName: workflowDisplayName,
      requestId: generateId(),
    });
  }, [runAddress, workflowDisplayName, workflowUndoRedoData]);

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
    handlePromptUndoMeta,
    handleWorkflowRedo,
    handleWorkflowUndo,
    minimapDialogState,
    openMinimapRedoDialog,
    openMinimapUndoDialog,
    workflowDialogState,
    workflowUndoRedoData,
  };
}
