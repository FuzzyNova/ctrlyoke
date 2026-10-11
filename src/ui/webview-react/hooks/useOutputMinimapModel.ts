import { useMemo } from "react";
import type {
  MinimapDiffBlock,
  MinimapStep,
} from "@components/output/OutputMinimap";
import type { WorkflowStep } from "@store/workflowStore";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import { getTargetKey, type OutputMessage } from "@utils/outputProjection";
import {
  estimateOutputDiffBlockHeight,
  parallelGroupActionTooltip,
  parallelGroupStepCount,
  type OutputRenderRow,
} from "@utils/outputRows";
import { measurePhase } from "@utils/performanceProfiler";
import {
  buildUndoDialogInputForPrompt,
  computePromptChangeSummary,
} from "@utils/promptUndo";
import type { CliOutput as CliOutputType } from "@/types/cliEvents";
import { FINAL_STEP_PHASES } from "@/types/messages";
import {
  OUTPUT_ROW_KINDS,
  UNDO_DIALOG_INTENTS,
} from "@root/types/DashboardConstants";
import type { OpenMinimapDialogInput } from "@hooks/useOutputUndoActions";
import type {
  OrderedHistoryEntry,
  StepOutput,
  UndoExecutionTarget,
  UndoRecord,
  WorkspaceSnapshot,
  WorkflowRunMetadata,
} from "@root/types/OutputHistoryTypes";
import { formatFinalPassLabel } from "@root/utils/FinalStepLabels";
import { getQueueStepLabel } from "@utils/stepLabels";

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
  anchorRowIndexByTarget?: Map<string, number>;
  finalStep: WorkflowStep | null;
  parallelGroups?: readonly ParallelGroupDefinition[];
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  firstRowIndexByTarget: Map<string, number>;
  historyOutputs: OutputHistoryView;
  isViewingHistory: boolean;
  lastCliIndexPerStep: Map<string, number>;
  outputFontSize: number;
  rowLayout: OutputRowLayoutModel;
  rows: OutputRenderRow[];
  hiddenTargetKeys: readonly string[];
  hiddenAtMs: Readonly<Record<string, number>>;
  stepOutputsMap: Map<string, CliOutputType[]>;
  steps: WorkflowStep[];
  undoRecords: Record<string, UndoRecord>;
  uniqueStepTargets: OutputMessage["target"][];
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
  onOpenMinimapDialog: (input: OpenMinimapDialogInput) => void;
}

function getStepName(
  step: WorkflowStep | null | undefined,
  fallback: string
): string {
  const name = step?.name?.trim();
  return name || fallback;
}

function getStepScrollFractions(
  uniqueStepTargets: OutputMessage["target"][],
  anchorRowIndexByTarget: Map<string, number>,
  rowLayout: OutputRowLayoutModel,
  rowCount: number
): Map<string, number> {
  return measurePhase(
    "stepScrollFractions",
    { targets: uniqueStepTargets.length, rows: rowCount },
    () => {
      const fractions = new Map<string, number>();
      const totalSize = Math.max(1, rowLayout.totalSize);

      for (const target of uniqueStepTargets) {
        const targetKey = getTargetKey(target);
        const rowIndex = anchorRowIndexByTarget.get(targetKey);
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
  anchorRowIndexByTarget,
  firstRowIndexByTarget,
  finalStep,
  parallelGroups,
  finalStepWorkspaceSnapshots,
  historyOutputs,
  isViewingHistory,
  lastCliIndexPerStep,
  outputFontSize,
  rowLayout,
  rows,
  hiddenTargetKeys,
  hiddenAtMs,
  stepOutputsMap,
  steps,
  undoRecords,
  uniqueStepTargets,
  workspaceSnapshots,
  onOpenMinimapDialog,
}: UseOutputMinimapModelInput) {
  const stepScrollFractions = useMemo(
    () =>
      getStepScrollFractions(
        uniqueStepTargets,
        anchorRowIndexByTarget ?? firstRowIndexByTarget,
        rowLayout,
        rows.length
      ),
    [
      anchorRowIndexByTarget,
      firstRowIndexByTarget,
      rowLayout,
      rows.length,
      uniqueStepTargets,
    ]
  );

  const minimapSteps = useMemo((): MinimapStep[] => {
    return measurePhase(
      "minimapSteps",
      {
        targets: uniqueStepTargets.length,
        rows: rows.length,
        totalSize: rowLayout.totalSize,
      },
      () => {
        const totalSize = Math.max(1, rowLayout.totalSize);
        const newestTimestampByTarget = new Map<string, number>();
        for (const message of allMessages) {
          const key = getTargetKey(message.target);
          const previous = newestTimestampByTarget.get(key);
          if (previous === undefined || message.timestamp > previous) {
            newestTimestampByTarget.set(key, message.timestamp);
          }
        }

        return uniqueStepTargets.flatMap<MinimapStep>((msgTarget) => {
          const key = getTargetKey(msgTarget);
          const firstRowIndex = (
            anchorRowIndexByTarget ?? firstRowIndexByTarget
          ).get(key);
          if (firstRowIndex === undefined) return [];

          const kind = msgTarget.kind;
          const stepIndex = msgTarget.index;
          const isFinalStep = kind === FINAL_STEP_PHASES.FINAL_STEP;
          const workflowStep = isFinalStep ? finalStep : steps[stepIndex];
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
          const label = isFinalStep
            ? getStepName(workflowStep, formatFinalPassLabel(stepIndex + 1))
            : getStepName(workflowStep, getQueueStepLabel(stepIndex));
          const scrollFraction =
            stepScrollFractions.get(key) ??
            rowLayout.rowStartsByIndex[firstRowIndex] / totalSize;
          const hidden = hiddenTargetKeys.includes(key);
          const selected =
            hiddenTargetKeys.length > 0 && !hiddenTargetKeys.includes(key);
          const hiddenTimestamp = hiddenAtMs[key];
          const hasHiddenActivity =
            hidden &&
            hiddenTimestamp !== undefined &&
            (newestTimestampByTarget.get(key) ?? 0) > hiddenTimestamp;
          const diffBlocks: MinimapDiffBlock[] = rows.flatMap((row) => {
            if (
              row.rowKind !== OUTPUT_ROW_KINDS.STRUCTURED_EVENT ||
              row.target.kind !== msgTarget.kind ||
              row.target.index !== msgTarget.index ||
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

          const noAction = null;
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
                hidden,
                selected,
                hasHiddenActivity,
                changeAction: noAction,
                changeSummary: null,
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
                hidden,
                selected,
                hasHiddenActivity,
                changeAction: noAction,
                changeSummary: null,
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
                hidden,
                selected,
                hasHiddenActivity,
                changeAction: noAction,
                changeSummary: null,
                diffBlocks,
              },
            ];
          }

          const undoTarget: UndoExecutionTarget = isFinalStep
            ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
            : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };

          const groupForLabels = concurrentGroup;
          if (concurrentGroup) {
            return [
              {
                key,
                kind,
                stepIndex,
                firstMessageIndex: firstRowIndex,
                scrollFraction,
                label,
                hidden,
                selected,
                hasHiddenActivity,
                changeAction: noAction,
                changeSummary: null,
                diffBlocks,
              },
            ];
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
            effectiveSnapshot = isFinalStep
              ? finalStepWorkspaceSnapshots[stepIndex]
              : workspaceSnapshots[stepIndex];
            effectiveUndoRecord =
              undoRecords[
                isFinalStep ? `finalStep-${stepIndex}` : `queue-${stepIndex}`
              ];
          }

          const workspacePath = lastOutput.workingDirectory ?? "";
          const summary = computePromptChangeSummary(
            stepOutputs,
            effectiveUndoRecord,
            groupForLabels ? groupSnapshot : effectiveSnapshot
          );
          const alreadyUndone =
            effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
              ? effectiveUndoRecord.redoInstructions
              : undefined;
          const input = buildUndoDialogInputForPrompt(
            undoTarget,
            stepOutputs,
            effectiveSnapshot,
            workspacePath,
            alreadyUndone
          );
          const changeAction: MinimapStep["changeAction"] =
            summary.total > 0
              ? {
                  label: summary.label,
                  title: groupForLabels
                    ? parallelGroupActionTooltip(
                        summary.title,
                        parallelGroupStepCount(groupForLabels)
                      )
                    : summary.title,
                  onTrigger: () => {
                    onOpenMinimapDialog({
                      target: undoTarget,
                      snapshot: effectiveSnapshot,
                      input,
                      redoInstructions: alreadyUndone,
                      intent: UNDO_DIALOG_INTENTS.VIEW,
                      stepLabel: isFinalStep
                        ? label
                        : getQueueStepLabel(stepIndex),
                      stepName: isFinalStep
                        ? getStepName(finalStep, label)
                        : workflowStep?.name?.trim() || undefined,
                    });
                  },
                }
              : null;

          return [
            {
              key,
              kind,
              stepIndex,
              firstMessageIndex: firstRowIndex,
              scrollFraction,
              label,
              hidden,
              selected,
              hasHiddenActivity,
              changeAction,
              changeSummary: summary,
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
    anchorRowIndexByTarget,
    firstRowIndexByTarget,
    hiddenAtMs,
    hiddenTargetKeys,
    historyOutputs,
    isViewingHistory,
    lastCliIndexPerStep,
    onOpenMinimapDialog,
    outputFontSize,
    parallelGroups,
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
