import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { ExpandCollapseAllDiffsButton } from "../shared/ExpandCollapseAllDiffsButton";
import {
  DiffFileList,
  OpenFileButton,
  type DiffFileGroup,
  type DiffFileListHandle,
} from "@components/diff";
import { MESSAGE_TYPES } from "../../types/messages";
import type { UndoFileInstruction } from "../../types/messages";
import {
  FINAL_STEP_PHASES,
  UNDO_DIALOG_INTENTS,
  UNDO_DIALOG_SCOPE_MODES,
  UNDO_REDO_DIRECTIONS,
} from "@root/types/DashboardConstants";
import type {
  UndoDialogIntent,
  UndoRedoDirection,
} from "@root/types/DashboardConstants";
import type { UndoDialogInput } from "../../utils/promptUndo";
import {
  buildPromptUndoDialogModel,
  type AggregatedUndoFile,
  type PromptUndoDialogModel,
  type WorkflowStepEntry,
} from "../../utils/promptUndo";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { RunRef, WorkflowKey } from "@root/types/CtrlYokeTypes";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { sendMessage } from "../../hooks/useMessageHandler";

export type { WorkflowStepEntry } from "../../utils/promptUndo";

export interface UndoChangesDialogProps {
  mode: UndoRedoDirection;
  intent?: UndoDialogIntent;
  target: OutputExecutionTarget;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  /** Legacy display-only input; never sent to the extension host. */
  workspacePath?: string;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  requestId: string;
  onClose: () => void;
  workflowEntries?: WorkflowStepEntry[];
  workflowName?: string;
  stepLabel?: string;
  stepName?: string;
}

const RESULT_STATE = {
  IDLE: "idle",
  SUCCESS: "success",
  PARTIAL: "partial",
  ERROR: "error",
} as const;
function getAllSelectableRows(
  model: PromptUndoDialogModel,
  isWorkflowMode: boolean,
  activeDirection: UndoRedoDirection
) {
  if (isWorkflowMode) {
    return model.workflowRows.filter(
      (row) => row.direction === activeDirection
    );
  }
  return activeDirection === UNDO_REDO_DIRECTIONS.REDO
    ? model.redoRows
    : model.allUndoRows;
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
  activeDirection: UndoRedoDirection
): Array<{ target: OutputExecutionTarget; files: UndoFileInstruction[] }> {
  const selectedSteps = files
    .filter((file) => checkedPaths.has(file.key))
    .flatMap((file) => file.steps)
    .filter((step) => step.direction === activeDirection)
    .filter(
      (
        step
      ): step is (typeof files)[number]["steps"][number] & {
        instruction: UndoFileInstruction;
      } => step.instruction !== null
    )
    .sort((left, right) => {
      const order =
        workflowTargetOrder(left.target) - workflowTargetOrder(right.target);
      return activeDirection === UNDO_REDO_DIRECTIONS.UNDO ? -order : order;
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
  intent = UNDO_DIALOG_INTENTS.ACT,
  target,
  workflowKey,
  runRef,
  input,
  redoInstructions,
  requestId,
  onClose,
  workflowEntries,
  workflowName,
  stepLabel,
  stepName,
}) => {
  const isWorkflowMode = (workflowEntries?.length ?? 0) > 0;
  const model = useMemo(() => {
    const undoModel = buildPromptUndoDialogModel({
      mode: UNDO_REDO_DIRECTIONS.UNDO,
      input,
      workflowEntries,
    });
    const redoModel = buildPromptUndoDialogModel({
      mode: UNDO_REDO_DIRECTIONS.REDO,
      redoInstructions,
      workflowEntries,
    });

    return {
      workflowRows: [...undoModel.workflowRows, ...redoModel.workflowRows],
      workflowFiles: [...undoModel.workflowFiles, ...redoModel.workflowFiles],
      redoRows: redoModel.redoRows,
      tier1Rows: undoModel.tier1Rows,
      tier2Rows: undoModel.tier2Rows,
      allUndoRows: undoModel.allUndoRows,
      groups: isWorkflowMode
        ? [
            {
              key: UNDO_DIALOG_SCOPE_MODES.WORKFLOW,
              files: [...undoModel.workflowRows, ...redoModel.workflowRows],
            },
          ]
        : [...undoModel.groups, ...redoModel.groups],
    } satisfies PromptUndoDialogModel;
  }, [input, isWorkflowMode, redoInstructions, workflowEntries]);

  const initialChecked = useMemo(() => {
    if (intent === UNDO_DIALOG_INTENTS.VIEW) return new Set<string>();
    return new Set(
      getAllSelectableRows(model, isWorkflowMode, mode)
        .filter((row) => row.instruction !== null)
        .map((row) => row.key)
    );
  }, [intent, isWorkflowMode, mode, model]);

  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(initialChecked);
  const [activeDirection, setActiveDirection] =
    useState<UndoRedoDirection>(mode);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const diffFileListRef = useRef<DiffFileListHandle>(null);
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

  const selectableRows = useMemo(
    () =>
      model.workflowRows.length > 0 || isWorkflowMode
        ? model.workflowRows
        : [...model.allUndoRows, ...model.redoRows],
    [isWorkflowMode, model.allUndoRows, model.redoRows, model.workflowRows]
  );
  const checkableRows = selectableRows.filter(
    (row) => row.instruction !== null && row.direction === activeDirection
  );
  const checkableCount = checkableRows.length;
  const checkedCount = checkableRows.filter((row) =>
    checkedPaths.has(row.key)
  ).length;
  const allCheckableChecked =
    checkedCount === checkableCount && checkableCount > 0;

  const handleToggle = useCallback(
    (key: string, checked: boolean) => {
      const row = selectableRows.find((candidate) => candidate.key === key);
      if (checked && row && row.direction !== activeDirection) {
        setActiveDirection(row.direction);
        setCheckedPaths(new Set([key]));
        return;
      }
      setCheckedPaths((previous) => {
        const next = new Set(previous);
        if (checked) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [activeDirection, selectableRows]
  );

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
        activeDirection
      );
      if (entries.length === 0) return;
      setIsSubmitting(true);
      sendMessage(
        activeDirection === UNDO_REDO_DIRECTIONS.REDO
          ? MESSAGE_TYPES.REDO_WORKFLOW_CHANGES
          : MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES,
        { data: { requestId, workflowKey, runRef, entries } }
      );
    } else if (activeDirection === UNDO_REDO_DIRECTIONS.REDO) {
      const selectedInstructions = model.redoRows
        .filter((row) => checkedPaths.has(row.key))
        .map((row) => row.instruction as UndoFileInstruction);
      if (selectedInstructions.length === 0) return;
      setIsSubmitting(true);
      sendMessage(MESSAGE_TYPES.REDO_PROMPT_CHANGES, {
        data: {
          requestId,
          target,
          workflowKey,
          runRef,
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
          workflowKey,
          runRef,
          files: instructions,
        },
      });
    }
  }

  const hasDiffs = selectableRows.some((row) => row.hasDiff);
  const canConfirm =
    checkedCount > 0 && !isSubmitting && resultState === RESULT_STATE.IDLE;

  function handleExpandAllDiffs() {
    diffFileListRef.current?.prepareGlobalLayoutChange();
    setUndoDialogDiffsCollapsed(false);
    setDialogDiffResetVersion((version) => version + 1);
  }

  function handleCollapseAllDiffs() {
    diffFileListRef.current?.prepareGlobalLayoutChange();
    setUndoDialogDiffsCollapsed(true);
    setDialogDiffResetVersion((version) => version + 1);
  }

  const scopeMode = isWorkflowMode
    ? UNDO_DIALOG_SCOPE_MODES.WORKFLOW
    : (input?.scope.mode ?? UNDO_DIALOG_SCOPE_MODES.PROMPT);
  const dialogTitle =
    scopeMode === UNDO_DIALOG_SCOPE_MODES.WORKFLOW
      ? "Workflow changes"
      : scopeMode === UNDO_DIALOG_SCOPE_MODES.SINGLE_FILE
        ? "File changes"
        : "Step changes";
  const undoneCount = selectableRows.filter(
    (row) => row.direction === UNDO_REDO_DIRECTIONS.REDO
  ).length;
  const changeCountSubtitle = `${selectableRows.length} file${
    selectableRows.length !== 1 ? "s" : ""
  }${undoneCount > 0 ? ` · ${undoneCount} undone` : ""}`;
  // WorkflowDialogState requires this label; the optional prop only supports
  // the prompt/file dialog shapes that do not need a workflow subtitle.
  const dialogSubtitle =
    scopeMode === UNDO_DIALOG_SCOPE_MODES.WORKFLOW
      ? `${workflowName!} · ${changeCountSubtitle}`
      : input?.scope.mode === UNDO_DIALOG_SCOPE_MODES.SINGLE_FILE
        ? input.scope.path
        : [stepLabel, stepName].filter(Boolean).length > 0
          ? `${[stepLabel, stepName].filter(Boolean).join(" — ")} · ${changeCountSubtitle}`
          : undefined;
  const confirmLabel =
    activeDirection === UNDO_REDO_DIRECTIONS.REDO
      ? `Redo ${checkedCount} file${checkedCount !== 1 ? "s" : ""}`
      : `Undo ${checkedCount} file${checkedCount !== 1 ? "s" : ""}`;
  const submittingLabel =
    activeDirection === UNDO_REDO_DIRECTIONS.REDO ? "Redoing…" : "Undoing…";

  const dialogGroups = useMemo<DiffFileGroup[]>(
    () =>
      model.groups.map((group) => ({
        key: group.key,
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
          const stateChip =
            row.direction === UNDO_REDO_DIRECTIONS.REDO ? (
              <span className="rounded-sm bg-severity-info-bg px-1.5 py-0.5 text-[10px] font-sans font-medium text-terminal-ansiGreen">
                Undone
              </span>
            ) : undefined;
          return {
            key,
            ...file,
            headerActions: (
              <>
                {stateChip}
                <OpenFileButton path={file.path} />
              </>
            ),
            selection: {
              checked: checkedPaths.has(key),
              onChange: (checked: boolean) => handleToggle(key, checked),
              ...(instruction === null ? { disabledReason } : {}),
            },
          };
        }),
      })),
    [checkedPaths, handleToggle, model.groups]
  );

  const hasBothDirections =
    selectableRows.some((row) => row.direction === UNDO_REDO_DIRECTIONS.UNDO) &&
    selectableRows.some((row) => row.direction === UNDO_REDO_DIRECTIONS.REDO);
  const selectionSummary =
    checkableCount > 0 && resultState === RESULT_STATE.IDLE ? (
      <div>
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
        {hasBothDirections && (
          <p className="mt-1 text-xs text-description-fg">
            Undo and redo are applied separately.
          </p>
        )}
      </div>
    ) : undefined;

  const footer = (
    <>
      <Button
        variant={intent === UNDO_DIALOG_INTENTS.VIEW ? "primary" : "secondary"}
        size="md"
        onClick={onClose}
        disabled={isSubmitting}
      >
        {intent === UNDO_DIALOG_INTENTS.VIEW ? "Close" : "Cancel"}
      </Button>
      <Button
        variant={intent === UNDO_DIALOG_INTENTS.VIEW ? "secondary" : "primary"}
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
    : activeDirection === UNDO_REDO_DIRECTIONS.REDO
      ? "No redo instructions available."
      : input?.scope.mode === UNDO_DIALOG_SCOPE_MODES.SINGLE_FILE
        ? "No file changes found for this diff."
        : "No file changes found for this prompt.";

  return (
    <Modal
      isOpen
      title={dialogTitle}
      onClose={onClose}
      size="full"
      footer={footer}
      bodyRef={bodyRef}
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
          mode={activeDirection}
        />
      )}
      <DiffFileList
        ref={diffFileListRef}
        groups={dialogGroups}
        emptyMessage={emptyMessage}
        command={{
          version: dialogDiffResetVersion,
          collapsed: dialogDiffsCollapsed,
        }}
        selectionSummary={selectionSummary}
        scrollContainerRef={bodyRef}
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
  mode: UndoRedoDirection;
}

const ResultBanner: React.FC<ResultBannerProps> = ({
  result,
  undoResult,
  mode,
}) => {
  const successVerb =
    mode === UNDO_REDO_DIRECTIONS.REDO ? "re-applied" : "restored";
  const failVerb = mode === UNDO_REDO_DIRECTIONS.REDO ? "Redo" : "Undo";
  if (result === RESULT_STATE.SUCCESS) {
    return (
      <div className="mb-3 flex gap-2 rounded-sm px-3 py-2 text-xs bg-severity-info-bg text-info-fg border border-info-fg/30">
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
      <div className="mb-3 flex gap-2 rounded-sm px-3 py-2 text-xs bg-severity-warning-bg text-warning-fg border border-warning-fg/30">
        <span>⚠️</span>
        <div>
          <div>
            {undoResult?.restoredFiles.length ?? 0} {successVerb},{" "}
            {undoResult?.failedFiles.length ?? 0} failed.
          </div>
          {undoResult?.failedFiles.map((file) => (
            <div key={file.path} className="mt-0.5 font-mono wrap-anywhere">
              {file.path}: {file.error}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 flex gap-2 rounded-sm px-3 py-2 text-xs bg-severity-error-bg text-error-fg border border-error-fg/30">
      <span>❌</span>
      <div>
        <div>{failVerb} failed.</div>
        {undoResult?.failedFiles.map((file) => (
          <div key={file.path} className="mt-0.5 font-mono wrap-anywhere">
            {file.path}: {file.error}
          </div>
        ))}
      </div>
    </div>
  );
};
