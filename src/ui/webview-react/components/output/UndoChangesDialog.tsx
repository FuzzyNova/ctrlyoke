import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { ExpandCollapseAllDiffsButton } from "../shared/ExpandCollapseAllDiffsButton";
import {
  DiffFileList,
  OpenFileButton,
  type DiffFileGroup,
} from "@components/diff";
import { MESSAGE_TYPES } from "../../types/messages";
import type { UndoFileInstruction } from "../../types/messages";
import { FINAL_STEP_PHASES } from "@root/types/DashboardConstants";
import type { UndoDialogInput } from "../../utils/promptUndo";
import {
  buildPromptUndoDialogModel,
  type AggregatedUndoFile,
  type PromptUndoDialogModel,
  type WorkflowStepEntry,
} from "../../utils/promptUndo";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { sendMessage } from "../../hooks/useMessageHandler";

export type { WorkflowStepEntry } from "../../utils/promptUndo";

export interface UndoChangesDialogProps {
  mode: "undo" | "redo";
  target: OutputExecutionTarget;
  workspacePath: string;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  requestId: string;
  onClose: () => void;
  workflowEntries?: WorkflowStepEntry[];
}

const RESULT_STATE = {
  IDLE: "idle",
  SUCCESS: "success",
  PARTIAL: "partial",
  ERROR: "error",
} as const;
const DIALOG_MODE = { UNDO: "undo", REDO: "redo" } as const;

function getAllSelectableRows(
  model: PromptUndoDialogModel,
  mode: "undo" | "redo",
  isWorkflowMode: boolean
) {
  if (isWorkflowMode) return model.workflowRows;
  return mode === DIALOG_MODE.REDO ? model.redoRows : model.allUndoRows;
}

function workflowTargetOrder(target: OutputExecutionTarget): number {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? target.stepIndex
    : Number.MAX_SAFE_INTEGER / 2 + target.loopIndex;
}

function sameWorkflowTarget(
  left: OutputExecutionTarget,
  right: OutputExecutionTarget
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === FINAL_STEP_PHASES.QUEUE) {
    return (
      right.kind === FINAL_STEP_PHASES.QUEUE &&
      left.stepIndex === right.stepIndex
    );
  }
  return (
    right.kind === FINAL_STEP_PHASES.FINAL_STEP &&
    left.loopIndex === right.loopIndex
  );
}

function expandAggregatedWorkflowSelection(
  files: AggregatedUndoFile[],
  checkedPaths: Set<string>,
  mode: "undo" | "redo"
): Array<{ target: OutputExecutionTarget; files: UndoFileInstruction[] }> {
  const selectedSteps = files
    .filter((file) => checkedPaths.has(file.key))
    .flatMap((file) => file.steps)
    .sort((left, right) => {
      const order =
        workflowTargetOrder(left.target) - workflowTargetOrder(right.target);
      return mode === DIALOG_MODE.UNDO ? -order : order;
    });

  const entries: Array<{
    target: OutputExecutionTarget;
    files: UndoFileInstruction[];
  }> = [];
  for (const step of selectedSteps) {
    const existing = entries.find((entry) =>
      sameWorkflowTarget(entry.target, step.target)
    );
    if (existing) existing.files.push(step.instruction);
    else entries.push({ target: step.target, files: [step.instruction] });
  }
  return entries;
}

export const UndoChangesDialog: React.FC<UndoChangesDialogProps> = ({
  mode,
  target,
  workspacePath,
  input,
  redoInstructions,
  requestId,
  onClose,
  workflowEntries,
}) => {
  const isWorkflowMode = (workflowEntries?.length ?? 0) > 0;
  const model = useMemo(
    () =>
      buildPromptUndoDialogModel({
        mode,
        input,
        redoInstructions,
        workflowEntries,
      }),
    [input, mode, redoInstructions, workflowEntries]
  );

  const initialChecked = useMemo(() => {
    if (isWorkflowMode) {
      return new Set(
        model.workflowRows
          .filter((row) => row.instruction !== null)
          .map((row) => row.key)
      );
    }
    if (mode === DIALOG_MODE.REDO) {
      return new Set(model.redoRows.map((row) => row.key));
    }
    return new Set(
      model.tier1Rows
        .filter((row) => row.instruction !== null)
        .map((row) => row.key)
    );
  }, [isWorkflowMode, mode, model]);

  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(initialChecked);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultState, setResultState] = useState<
    "idle" | "success" | "partial" | "error"
  >(RESULT_STATE.IDLE);
  const [dialogDiffResetVersion, setDialogDiffResetVersion] = useState(0);

  const dialogDiffsCollapsed = useUiStore((s) => s.undoDialogDiffsCollapsed);
  const setUndoDialogDiffsCollapsed = useUiStore(
    (s) => s.setUndoDialogDiffsCollapsed
  );
  const undoResult = useWorkflowStore((s) => s.undoResults[requestId]);
  const clearUndoResult = useWorkflowStore((s) => s.clearUndoResult);

  useEffect(() => {
    if (!undoResult) return;
    if (undoResult.failedFiles.length === 0) {
      setResultState(RESULT_STATE.SUCCESS);
    } else if (undoResult.restoredFiles.length > 0) {
      setResultState(RESULT_STATE.PARTIAL);
    } else {
      setResultState(RESULT_STATE.ERROR);
    }
    setIsSubmitting(false);
    const timer = setTimeout(() => {
      clearUndoResult(requestId);
      onClose();
    }, 1800);
    return () => clearTimeout(timer);
  }, [clearUndoResult, onClose, requestId, undoResult]);

  const selectableRows = getAllSelectableRows(model, mode, isWorkflowMode);
  const checkableRows = selectableRows.filter(
    (row) => row.instruction !== null
  );
  const checkableCount = checkableRows.length;
  const checkedCount = checkableRows.filter((row) =>
    checkedPaths.has(row.key)
  ).length;
  const allCheckableChecked =
    checkedCount === checkableCount && checkableCount > 0;

  function handleToggle(key: string, checked: boolean) {
    setCheckedPaths((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function handleSelectAll() {
    if (allCheckableChecked) {
      setCheckedPaths(new Set());
    } else {
      setCheckedPaths(new Set(checkableRows.map((row) => row.key)));
    }
  }

  function handleConfirm() {
    if (isWorkflowMode) {
      const entries = expandAggregatedWorkflowSelection(
        model.workflowFiles,
        checkedPaths,
        mode
      );
      if (entries.length === 0) return;
      setIsSubmitting(true);
      sendMessage(
        mode === DIALOG_MODE.REDO
          ? MESSAGE_TYPES.REDO_WORKFLOW_CHANGES
          : MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES,
        { data: { requestId, workspacePath, entries } }
      );
    } else if (mode === DIALOG_MODE.REDO) {
      const selectedInstructions = model.redoRows
        .filter((row) => checkedPaths.has(row.key))
        .map((row) => row.instruction as UndoFileInstruction);
      if (selectedInstructions.length === 0) return;
      setIsSubmitting(true);
      sendMessage(MESSAGE_TYPES.REDO_PROMPT_CHANGES, {
        data: {
          requestId,
          target,
          workspacePath,
          files: selectedInstructions,
        },
      });
    } else {
      const instructions = model.allUndoRows
        .filter((row) => checkedPaths.has(row.key) && row.instruction !== null)
        .map((row) => row.instruction as UndoFileInstruction);
      if (instructions.length === 0) return;
      setIsSubmitting(true);
      sendMessage(MESSAGE_TYPES.UNDO_PROMPT_CHANGES, {
        data: {
          requestId,
          target,
          workspacePath,
          files: instructions,
        },
      });
    }
  }

  const hasDiffs = selectableRows.some((row) => row.hasDiff);
  const canConfirm =
    checkedCount > 0 && !isSubmitting && resultState === RESULT_STATE.IDLE;

  function handleExpandAllDiffs() {
    setUndoDialogDiffsCollapsed(false);
    setDialogDiffResetVersion((version) => version + 1);
  }

  function handleCollapseAllDiffs() {
    setUndoDialogDiffsCollapsed(true);
    setDialogDiffResetVersion((version) => version + 1);
  }

  const isSingleFileUndo =
    !isWorkflowMode &&
    mode === DIALOG_MODE.UNDO &&
    input?.scope.mode === "singleFile";
  const dialogTitle = isWorkflowMode
    ? mode === DIALOG_MODE.REDO
      ? "Redo workflow changes"
      : "Undo workflow changes"
    : mode === DIALOG_MODE.REDO
      ? "Redo Changes"
      : "Undo Changes";
  const dialogSubtitle =
    isSingleFileUndo && input?.scope.mode === "singleFile"
      ? input.scope.path
      : undefined;
  const confirmLabel =
    mode === DIALOG_MODE.REDO
      ? `Redo Selected (${checkedCount})`
      : `Undo Selected (${checkedCount})`;
  const submittingLabel = mode === DIALOG_MODE.REDO ? "Redoing…" : "Undoing…";

  const dialogGroups = useMemo<DiffFileGroup[]>(
    () =>
      model.groups.map((group) => ({
        heading: group.heading,
        headingHint: group.headingHint,
        files: group.files.map((row) => {
          const {
            key,
            instruction,
            hasDiff: _hasDiff,
            disabledReason,
            ...file
          } = row;
          return {
            key,
            ...file,
            globallyCollapsed: dialogDiffsCollapsed,
            localResetVersion: dialogDiffResetVersion,
            headerActions: <OpenFileButton path={file.path} />,
            selection: {
              checked: checkedPaths.has(key),
              onChange: (checked: boolean) => handleToggle(key, checked),
              ...(instruction === null ? { disabledReason } : {}),
            },
          };
        }),
      })),
    [checkedPaths, dialogDiffResetVersion, dialogDiffsCollapsed, model.groups]
  );

  const selectionSummary =
    checkableCount > 0 && resultState === RESULT_STATE.IDLE ? (
      <div className="flex items-center justify-between">
        <span className="text-xs text-description-fg">
          {checkedCount} of {checkableCount} file
          {checkableCount !== 1 ? "s" : ""} selected
        </span>
        <button
          type="button"
          onClick={handleSelectAll}
          className="text-xs text-link-fg hover:text-link-active-fg transition-colors"
        >
          {allCheckableChecked ? "Deselect all" : "Select all"}
        </button>
      </div>
    ) : undefined;

  const footer = (
    <>
      <Button
        variant="secondary"
        size="md"
        onClick={onClose}
        disabled={isSubmitting}
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        size="md"
        onClick={handleConfirm}
        disabled={!canConfirm}
      >
        {isSubmitting ? (
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 border-2 border-btn-fg border-t-transparent rounded-full animate-spin" />
            {submittingLabel}
          </span>
        ) : (
          confirmLabel
        )}
      </Button>
    </>
  );

  const emptyMessage = isWorkflowMode
    ? "No file changes found across workflow steps."
    : mode === DIALOG_MODE.REDO
      ? "No redo instructions available."
      : input?.scope.mode === "singleFile"
        ? "No file changes found for this diff."
        : "No file changes found for this prompt.";

  return (
    <Modal
      isOpen
      title={dialogTitle}
      onClose={onClose}
      size="full"
      footer={footer}
      bodyClassName="px-3 py-2"
      headerSubtitle={dialogSubtitle}
      headerActions={
        hasDiffs && resultState === RESULT_STATE.IDLE ? (
          <ExpandCollapseAllDiffsButton
            anyDiffCollapsed={dialogDiffsCollapsed}
            onExpand={handleExpandAllDiffs}
            onCollapse={handleCollapseAllDiffs}
          />
        ) : undefined
      }
    >
      {resultState !== RESULT_STATE.IDLE && (
        <ResultBanner
          result={resultState}
          undoResult={undoResult}
          mode={mode}
        />
      )}
      <DiffFileList
        groups={dialogGroups}
        emptyMessage={emptyMessage}
        selectionSummary={selectionSummary}
      />
    </Modal>
  );
};

interface ResultBannerProps {
  result: "success" | "partial" | "error";
  undoResult:
    | {
        restoredFiles: string[];
        failedFiles: Array<{ path: string; error: string }>;
      }
    | undefined;
  mode: "undo" | "redo";
}

const ResultBanner: React.FC<ResultBannerProps> = ({
  result,
  undoResult,
  mode,
}) => {
  const successVerb = mode === DIALOG_MODE.REDO ? "re-applied" : "restored";
  const failVerb = mode === DIALOG_MODE.REDO ? "Redo" : "Undo";
  if (result === RESULT_STATE.SUCCESS) {
    return (
      <div className="mb-3 flex gap-2 rounded px-3 py-2 text-xs bg-severity-info-bg text-info-fg border border-info-fg border-opacity-30">
        <span>✅</span>
        <span>
          {undoResult?.restoredFiles.length ?? 0} file
          {(undoResult?.restoredFiles.length ?? 0) !== 1 ? "s" : ""}{" "}
          {successVerb} successfully.
        </span>
      </div>
    );
  }

  if (result === RESULT_STATE.PARTIAL) {
    return (
      <div className="mb-3 flex gap-2 rounded px-3 py-2 text-xs bg-severity-warning-bg text-warning-fg border border-warning-fg border-opacity-30">
        <span>⚠️</span>
        <div>
          <div>
            {undoResult?.restoredFiles.length ?? 0} {successVerb},{" "}
            {undoResult?.failedFiles.length ?? 0} failed.
          </div>
          {undoResult?.failedFiles.map((file) => (
            <div
              key={file.path}
              className="mt-0.5 font-mono [overflow-wrap:anywhere]"
            >
              {file.path}: {file.error}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 flex gap-2 rounded px-3 py-2 text-xs bg-severity-error-bg text-error-fg border border-error-fg border-opacity-30">
      <span>❌</span>
      <div>
        <div>{failVerb} failed.</div>
        {undoResult?.failedFiles.map((file) => (
          <div
            key={file.path}
            className="mt-0.5 font-mono [overflow-wrap:anywhere]"
          >
            {file.path}: {file.error}
          </div>
        ))}
      </div>
    </div>
  );
};
