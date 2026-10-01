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
  aggregateWorkflowUndoFiles,
  createPromptChangeSummary,
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
import { useWorkspaceSnapshotContent } from "@hooks/useWorkspaceSnapshotContent";
import { WebviewLog } from "@utils/logger";

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

export interface OpenMinimapDialogInput {
  target: UndoExecutionTarget;
  intent: MinimapDialogState["intent"];
  input?: MinimapDialogState["input"];
  redoInstructions: MinimapDialogState["redoInstructions"];
  stepLabel?: string;
  stepName?: string;
  mode?: MinimapDialogState["mode"];
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
  const requestSnapshotContent = useWorkspaceSnapshotContent();
  const [minimapDialogState, setMinimapDialogState] =
    useState<MinimapDialogState | null>(null);
  const [workflowDialogState, setWorkflowDialogState] =
    useState<WorkflowDialogState | null>(null);

  const workflowChangeData = useMemo(() => {
    const emptyWorkflowChangeData = () => ({
      entries: [] as WorkflowStepEntry[],
      summary: createPromptChangeSummary(0, 0, 0, 0),
    });
    if (!allowUndoActions) return emptyWorkflowChangeData();

    try {
      const entries: WorkflowStepEntry[] = [];

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
        if (candidates.length > 0 || redoInstructions.length > 0) {
          entries.push({
            target: undoTarget,
            label,
            undoCandidates: candidates,
            redoInstructions,
          });
        }
      }

      const files = aggregateWorkflowUndoFiles(entries);
      const blocked = files.filter(
        (file) => file.steps[0]?.instruction === null
      ).length;
      const undoable = files.filter(
        (file) =>
          file.direction === UNDO_REDO_DIRECTIONS.UNDO &&
          file.steps[0]?.instruction !== null
      ).length;
      const undone = files.filter(
        (file) =>
          file.direction === UNDO_REDO_DIRECTIONS.REDO &&
          file.steps[0]?.instruction !== null
      ).length;

      return {
        entries,
        summary: createPromptChangeSummary(
          files.length,
          undoable,
          undone,
          blocked
        ),
      };
    } catch (error) {
      WebviewLog.error(
        "[undo] Failed to build workflow change data; disabling workflow undo",
        error instanceof Error ? error.message : String(error)
      );
      return emptyWorkflowChangeData();
    }
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

  const openMinimapDialog = useCallback(
    ({
      target,
      input,
      redoInstructions,
      intent,
      stepLabel,
      stepName,
      mode = UNDO_REDO_DIRECTIONS.UNDO,
    }: OpenMinimapDialogInput) => {
      if (!runAddress) return;
      setMinimapDialogState({
        mode,
        intent,
        target,
        address: runAddress,
        input,
        redoInstructions,
        stepLabel,
        stepName,
        requestId: generateId(),
      });
    },
    [runAddress]
  );

  const handlePromptViewMeta = useCallback(
    async (
      target: OutputMessageTarget,
      promptUndo: OutputRowPromptUndoMeta | undefined,
      stepLabel?: string,
      stepName?: string
    ) => {
      if (!promptUndo || !runAddress) return;
      const undoTarget = toUndoExecutionTarget(target);
      const indexedSnapshot = promptUndo.workspaceSnapshot;
      const loadedChanges = await Promise.all(
        (indexedSnapshot?.changedFiles ?? []).map(async (change) => {
          if (!change.contentAvailableOnDemand) return change;
          const content = await requestSnapshotContent(
            runAddress,
            undoTarget,
            change.path
          );
          return { ...change, ...content, contentAvailableOnDemand: undefined };
        })
      );
      const workspaceSnapshot = indexedSnapshot
        ? { ...indexedSnapshot, changedFiles: loadedChanges }
        : undefined;
      const alreadyUndone =
        promptUndo.undoRecord != null && promptUndo.undoRecord.isRedone !== true
          ? promptUndo.undoRecord.redoInstructions
          : undefined;
      const input = buildUndoDialogInputForPrompt(
        undoTarget,
        promptUndo.allStepOutputs,
        workspaceSnapshot,
        promptUndo.workspacePath,
        alreadyUndone
      );
      openMinimapDialog({
        target: undoTarget,
        input,
        redoInstructions: alreadyUndone,
        intent: UNDO_DIALOG_INTENTS.VIEW,
        stepLabel,
        stepName,
      });
    },
    [openMinimapDialog, requestSnapshotContent, runAddress]
  );

  // Widened past `CliHeaderRow` so a parallel group's header row — which
  // carries the same group-wide `promptUndo` meta — reuses this handler.
  const handlePromptView = useCallback(
    (row: CliHeaderRow | ParallelGroupHeaderRow) =>
      handlePromptViewMeta(
        row.target,
        row.promptUndo,
        "stepLabel" in row ? row.stepLabel : undefined,
        "stepName" in row ? row.stepName : undefined
      ),
    [handlePromptViewMeta]
  );

  const handleFileUndo = useCallback(
    async (row: StructuredEventRow, request: OutputRowFileUndoRequest) => {
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
          openMinimapDialog({
            target,
            redoInstructions: [fileRedoInstruction],
            intent: UNDO_DIALOG_INTENTS.ACT,
            mode: UNDO_REDO_DIRECTIONS.REDO,
          });
        }
        return;
      }

      let workspaceSnapshot = row.workspaceSnapshot;
      const indexedChange = workspaceSnapshot?.changedFiles.find(
        (change) => sameFilePath(change.path, request.path)
      );
      if (indexedChange?.contentAvailableOnDemand && runAddress) {
        const snapshot = workspaceSnapshot;
        if (!snapshot) return;
        const content = await requestSnapshotContent(
          runAddress,
          target,
          indexedChange.path
        );
        workspaceSnapshot = {
          ...snapshot,
          changedFiles: snapshot.changedFiles.map((change) =>
            sameFilePath(change.path, indexedChange.path)
              ? { ...change, ...content, contentAvailableOnDemand: undefined }
              : change
          ),
        };
      }

      const input = buildUndoDialogInputForSpecificEvent(
        target,
        request.eventIndex,
        request.path,
        request.event,
        workspaceSnapshot,
        workspacePath,
        {
          oldContent: request.oldContent,
          newContent: request.newContent,
          structuredPatch: request.structuredPatch,
        }
      );

      openMinimapDialog({
        target,
        input,
        redoInstructions: undefined,
        intent: UNDO_DIALOG_INTENTS.ACT,
      });
    },
    [openMinimapDialog, requestSnapshotContent, runAddress, stepOutputsMap]
  );

  const handleWorkflowView = useCallback(() => {
    if (!runAddress) return;
    const openWorkflowDialog = (entries: WorkflowStepEntry[]) => {
      setWorkflowDialogState({
        mode: UNDO_REDO_DIRECTIONS.UNDO,
        intent: UNDO_DIALOG_INTENTS.VIEW,
        address: runAddress,
        entries,
        workflowName: workflowDisplayName,
        requestId: generateId(),
      });
    };
    const needsSnapshotContent = workflowChangeData.entries.some((entry) => {
      const snapshot =
        entry.target.kind === FINAL_STEP_PHASES.FINAL_STEP
          ? historyOutputs?.finalStepOutputs?.[entry.target.loopIndex]
              ?.workspaceSnapshot
          : historyOutputs?.promptOutputs[entry.target.stepIndex]
              ?.workspaceSnapshot;
      return (
        snapshot?.changedFiles.some((change) => change.contentAvailableOnDemand) ??
        false
      );
    });
    if (!needsSnapshotContent) {
      openWorkflowDialog(workflowChangeData.entries);
      return;
    }
    void Promise.all(
      workflowChangeData.entries.map(async (entry) => {
        const outputTarget = entry.target;
        const indexedSnapshot =
          outputTarget.kind === FINAL_STEP_PHASES.FINAL_STEP
            ? historyOutputs?.finalStepOutputs?.[outputTarget.loopIndex]
                ?.workspaceSnapshot
            : historyOutputs?.promptOutputs[outputTarget.stepIndex]
                ?.workspaceSnapshot;
        if (!indexedSnapshot) return entry;
        const candidates = await Promise.all(
          (entry.undoCandidates ?? []).map(async (candidate) => {
            const change = indexedSnapshot.changedFiles.find(
              (file) =>
                file.contentAvailableOnDemand &&
                sameFilePath(file.path, candidate.path)
            );
            if (!change) return candidate;
            const content = await requestSnapshotContent(
              runAddress,
              outputTarget,
              change.path
            );
            return {
              ...candidate,
              ...(content.contentToRestore !== undefined
                ? {
                    instruction: {
                      path: candidate.path,
                      action: "restore-content" as const,
                      contentToRestore: content.contentToRestore,
                    },
                  }
                : {}),
              ...(content.beforeContent !== undefined
                ? { oldContent: content.beforeContent }
                : {}),
            };
          })
        );
        return { ...entry, undoCandidates: candidates };
      })
    ).then(openWorkflowDialog);
  }, [historyOutputs, requestSnapshotContent, runAddress, workflowChangeData.entries, workflowDisplayName]);

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
    handlePromptView,
    handlePromptViewMeta,
    handleWorkflowView,
    minimapDialogState,
    openMinimapDialog,
    workflowDialogState,
    workflowChangeEntries: workflowChangeData.entries,
    workflowChangeSummary: workflowChangeData.summary,
  };
}
