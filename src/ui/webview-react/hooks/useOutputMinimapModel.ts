import { useMemo } from "react";
import type {
  MinimapDiffBlock,
  MinimapStep,
} from "@components/output/OutputMinimap";
import type { WorkflowStep } from "@store/workflowStore";
import type { OutputMessage } from "@utils/outputProjection";
import {
  estimateOutputDiffBlockHeight,
  type OutputRenderRow,
} from "@utils/outputRows";
import { measureOutputPhase } from "@utils/outputPerformance";
import {
  buildUndoDialogInputForPrompt,
  computePromptUndoActions,
} from "@utils/promptUndo";
import type { CliOutput as CliOutputType } from "@/types/cliEvents";
import { FINAL_STEP_PHASES, STEP_TYPES } from "@/types/messages";
import type {
  OpenMinimapRedoDialogInput,
  OpenMinimapUndoDialogInput,
} from "@hooks/useOutputUndoActions";
import type {
  OrderedHistoryEntry,
  StepOutput,
  UndoExecutionTarget,
  UndoRecord,
  WorkspaceSnapshot,
  WorkflowRunMetadata,
} from "@root/types/OutputHistoryTypes";

type OutputHistoryView = {
  orderedEntries: OrderedHistoryEntry[];
  promptOutputs: Record<number, StepOutput>;
  finalStepOutputs?: Record<number, StepOutput>;
  runMetadata: WorkflowRunMetadata;
} | null;

interface OutputRowLayoutModel {
  rowStartsByIndex: number[];
  rowStartsByKey: Map<string, number>;
  totalSize: number;
}

interface UseOutputMinimapModelInput {
  allMessages: OutputMessage[];
  allowUndoActions: boolean;
  finalStep: WorkflowStep | null;
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  firstRowIndexByTarget: Map<string, number>;
  historyOutputs: OutputHistoryView;
  isViewingHistory: boolean;
  lastCliIndexPerStep: Map<string, number>;
  outputFontSize: number;
  rowLayout: OutputRowLayoutModel;
  rows: OutputRenderRow[];
  stepOutputsMap: Map<string, CliOutputType[]>;
  steps: WorkflowStep[];
  undoRecords: Record<string, UndoRecord>;
  uniqueStepTargets: OutputMessage["target"][];
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
  onOpenMinimapRedoDialog: (input: OpenMinimapRedoDialogInput) => void;
  onOpenMinimapUndoDialog: (input: OpenMinimapUndoDialogInput) => void;
}

function getStepName(
  step: WorkflowStep | null | undefined,
  fallback: string
): string {
  const name = step?.name?.trim();
  return name || fallback;
}

function getQueueStepFallbackName(
  step: WorkflowStep | null | undefined,
  stepIndex: number
): string {
  return step?.type === STEP_TYPES.SCRIPT
    ? `Script ${stepIndex + 1}`
    : `Prompt ${stepIndex + 1}`;
}

function getStepScrollFractions(
  uniqueStepTargets: OutputMessage["target"][],
  firstRowIndexByTarget: Map<string, number>,
  rowLayout: OutputRowLayoutModel,
  rowCount: number
): Map<string, number> {
  return measureOutputPhase(
    "stepScrollFractions",
    { targets: uniqueStepTargets.length, rows: rowCount },
    () => {
      const fractions = new Map<string, number>();
      const totalSize = Math.max(1, rowLayout.totalSize);

      for (const target of uniqueStepTargets) {
        const targetKey = `${target.kind}:${target.index}`;
        const rowIndex = firstRowIndexByTarget.get(targetKey);
        if (rowIndex === undefined) continue;
        fractions.set(
          targetKey,
          rowLayout.rowStartsByIndex[rowIndex] / totalSize
        );
      }

      return fractions;
    }
  );
}

export function useOutputMinimapModel({
  allMessages,
  allowUndoActions,
  finalStep,
  finalStepWorkspaceSnapshots,
  firstRowIndexByTarget,
  historyOutputs,
  isViewingHistory,
  lastCliIndexPerStep,
  outputFontSize,
  rowLayout,
  rows,
  stepOutputsMap,
  steps,
  undoRecords,
  uniqueStepTargets,
  workspaceSnapshots,
  onOpenMinimapRedoDialog,
  onOpenMinimapUndoDialog,
}: UseOutputMinimapModelInput) {
  const stepScrollFractions = useMemo(
    () =>
      getStepScrollFractions(
        uniqueStepTargets,
        firstRowIndexByTarget,
        rowLayout,
        rows.length
      ),
    [firstRowIndexByTarget, rowLayout, rows.length, uniqueStepTargets]
  );

  const minimapSteps = useMemo((): MinimapStep[] => {
    return measureOutputPhase(
      "minimapSteps",
      {
        targets: uniqueStepTargets.length,
        rows: rows.length,
        totalSize: rowLayout.totalSize,
      },
      () => {
        const totalSize = Math.max(1, rowLayout.totalSize);

        return uniqueStepTargets.flatMap((msgTarget) => {
          const key = `${msgTarget.kind}:${msgTarget.index}`;
          const firstRowIndex = firstRowIndexByTarget.get(key);
          if (firstRowIndex === undefined) return [];

          const kind = msgTarget.kind;
          const stepIndex = msgTarget.index;
          const isFinalStep = kind === FINAL_STEP_PHASES.FINAL_STEP;
          const workflowStep = isFinalStep ? finalStep : steps[stepIndex];
          const label = isFinalStep
            ? getStepName(workflowStep, `Final Step Loop ${stepIndex + 1}`)
            : getStepName(
                workflowStep,
                getQueueStepFallbackName(workflowStep, stepIndex)
              );
          const scrollFraction =
            stepScrollFractions.get(key) ??
            rowLayout.rowStartsByIndex[firstRowIndex] / totalSize;
          const diffBlocks: MinimapDiffBlock[] = rows.flatMap((row) => {
            if (
              row.rowKind !== "structured-event" ||
              row.target?.kind !== msgTarget.kind ||
              row.target?.index !== msgTarget.index ||
              !row.diff
            ) {
              return [];
            }

            return [
              {
                key: row.diff.key,
                rowKey: row.key,
                scrollFraction:
                  (rowLayout.rowStartsByKey.get(row.key) ?? 0) / totalSize,
                heightFraction:
                  estimateOutputDiffBlockHeight(row, outputFontSize) /
                  totalSize,
                addedLines: row.diff.addedLines,
                removedLines: row.diff.removedLines,
                runs: row.diff.runs,
                isCollapsed: row.diff.isCollapsed,
              },
            ];
          });

          const noActions: MinimapStep["undoActions"] = {
            undo: null,
            redo: null,
          };
          const stepOutputs = stepOutputsMap.get(key) ?? [];

          if (!allowUndoActions) {
            return [
              {
                key,
                kind,
                stepIndex,
                firstMessageIndex: firstRowIndex,
                scrollFraction,
                label,
                undoActions: noActions,
                diffBlocks,
              },
            ];
          }

          const lastCliIdx = lastCliIndexPerStep.get(key);
          if (lastCliIdx === undefined) {
            return [
              {
                key,
                kind,
                stepIndex,
                firstMessageIndex: firstRowIndex,
                scrollFraction,
                label,
                undoActions: noActions,
                diffBlocks,
              },
            ];
          }

          const lastMsg = allMessages[lastCliIdx];
          const lastOutput = lastMsg?.data as CliOutputType | undefined;
          if (!lastOutput || lastOutput.isStreaming) {
            return [
              {
                key,
                kind,
                stepIndex,
                firstMessageIndex: firstRowIndex,
                scrollFraction,
                label,
                undoActions: noActions,
                diffBlocks,
              },
            ];
          }

          const undoTarget: UndoExecutionTarget = isFinalStep
            ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
            : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };

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
            effectiveSnapshot = isFinalStep
              ? finalStepWorkspaceSnapshots[stepIndex]
              : workspaceSnapshots[stepIndex];
            effectiveUndoRecord =
              undoRecords[
                isFinalStep ? `finalStep-${stepIndex}` : `queue-${stepIndex}`
              ];
          }

          const workspacePath = lastOutput.workingDirectory ?? "";
          const actions = computePromptUndoActions(
            stepOutputs,
            effectiveUndoRecord,
            effectiveSnapshot
          );

          const undoActions: MinimapStep["undoActions"] = {
            redo: actions.redo
              ? {
                  label: actions.redo.label,
                  onTrigger: () => {
                    onOpenMinimapRedoDialog({
                      target: undoTarget,
                      workspacePath,
                      redoInstructions: effectiveUndoRecord?.redoInstructions,
                    });
                  },
                }
              : null,
            undo: actions.undo
              ? {
                  label: actions.undo.label,
                  onTrigger: () => {
                    const alreadyUndone =
                      effectiveUndoRecord != null &&
                      effectiveUndoRecord.isRedone !== true
                        ? effectiveUndoRecord.redoInstructions
                        : undefined;
                    const input = buildUndoDialogInputForPrompt(
                      undoTarget,
                      stepOutputs,
                      effectiveSnapshot,
                      workspacePath,
                      alreadyUndone
                    );
                    onOpenMinimapUndoDialog({
                      target: undoTarget,
                      workspacePath,
                      input,
                    });
                  },
                }
              : null,
          };

          return [
            {
              key,
              kind,
              stepIndex,
              firstMessageIndex: firstRowIndex,
              scrollFraction,
              label,
              undoActions,
              diffBlocks,
            },
          ];
        });
      }
    );
  }, [
    allMessages,
    allowUndoActions,
    finalStep,
    finalStepWorkspaceSnapshots,
    firstRowIndexByTarget,
    historyOutputs,
    isViewingHistory,
    lastCliIndexPerStep,
    onOpenMinimapRedoDialog,
    onOpenMinimapUndoDialog,
    outputFontSize,
    rowLayout,
    rows,
    stepOutputsMap,
    stepScrollFractions,
    steps,
    undoRecords,
    uniqueStepTargets,
    workspaceSnapshots,
  ]);

  return { minimapSteps, stepScrollFractions };
}
