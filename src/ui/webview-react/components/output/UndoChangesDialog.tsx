import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { MESSAGE_TYPES } from "../../types/messages";
import type { UndoFileInstruction, UndoFileCandidate } from "../../types/messages";
import type { UndoDialogInput } from "../../utils/promptUndo";
import type { SnapshotFileChange, PromptChangeType, OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import { useWorkflowStore } from "@store/workflowStore";
import { sendMessage } from "../../hooks/useMessageHandler";
import { DiffView } from "./ToolCallOutput";
import { getLanguageFromPath } from "@utils/hljsUtils";

// ============================================================================
// Types
// ============================================================================

export interface UndoChangesDialogProps {
  mode: "undo" | "redo";
  target: OutputExecutionTarget;
  workspacePath: string;
  input?: UndoDialogInput;               // required for mode="undo"
  redoInstructions?: UndoFileInstruction[]; // required for mode="redo"
  requestId: string;
  onClose: () => void;
}

interface FileRow {
  path: string;
  changeType: PromptChangeType;
  tier: "tier1" | "tier2";
  instruction: UndoFileInstruction | null;
  contentCaptureSkipped?: boolean;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}

// ============================================================================
// Local state constants
// ============================================================================

const RESULT_STATE = { IDLE: "idle", SUCCESS: "success", PARTIAL: "partial", ERROR: "error" } as const;
const DIALOG_MODE = { UNDO: "undo", REDO: "redo" } as const;

// ============================================================================
// Helpers
// ============================================================================

/** Resolve an undo instruction from a snapshot file change. */
function resolveSnapshotInstruction(snap: SnapshotFileChange): UndoFileInstruction | null {
  switch (snap.changeType) {
    case "created":
      return { path: snap.path, action: "delete" };
    case "modified":
      if (snap.structuredPatch && snap.structuredPatch.length > 0)
        return { path: snap.path, action: "reverse-patch", structuredPatch: snap.structuredPatch };
      return null;
    case "deleted":
      if (snap.contentToRestore != null)
        return { path: snap.path, action: "restore-content", contentToRestore: snap.contentToRestore };
      return null;
    default:
      return null;
  }
}

/** Build the display label for a change type. */
const CHANGE_TYPE_LABEL: Record<PromptChangeType, string> = {
  created: "created",
  modified: "modified",
  deleted: "deleted",
};

const CHANGE_TYPE_COLORS: Record<PromptChangeType, string> = {
  created: "text-diff-added-fg",
  modified: "text-warning-fg",
  deleted: "text-bash-status-error",
};

// ============================================================================
// Redo helpers
// ============================================================================

/** Map redo instruction action to a human-readable badge label. */
function redoActionBadgeLabel(action: UndoFileInstruction["action"]): string {
  switch (action) {
    case "restore-content": return "modified/created";
    case "delete": return "deleted";
    default: return action;
  }
}

function redoActionBadgeColor(action: UndoFileInstruction["action"]): string {
  switch (action) {
    case "delete": return "text-bash-status-error";
    default: return "text-warning-fg";
  }
}

// ============================================================================
// FileRowItem
// ============================================================================

interface FileRowItemProps {
  row: FileRow;
  checked: boolean;
  onChange: (path: string, checked: boolean) => void;
}

const FileRowItem: React.FC<FileRowItemProps> = ({ row, checked, onChange }) => {
  const undoable = row.instruction !== null;
  const isDisabled = !undoable;
  const hasDiff = (row.structuredPatch && row.structuredPatch.length > 0) || (row.oldContent && row.newContent);

  const nonUndoableReason = row.contentCaptureSkipped ? "Content not captured" : "Cannot undo";

  return (
    <div className={`rounded ${isDisabled ? "opacity-50" : ""}`}>
      <div
        className={`flex items-start gap-2 py-1.5 px-2 text-sm ${
          isDisabled ? "" : "hover:bg-list-hover-bg rounded"
        }`}
      >
        {/* Checkbox (undoable) or spacer (non-undoable) */}
        {undoable ? (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(row.path, e.target.checked)}
            className="mt-0.5 w-3.5 h-3.5 accent-btn-bg cursor-pointer shrink-0"
          />
        ) : (
          <span className="mt-0.5 w-3.5 h-3.5 shrink-0" />
        )}

        {/* File path */}
        <span className={`flex-1 font-mono text-xs break-all ${isDisabled ? "text-description-fg" : "text-foreground"}`}>
          {row.path}
        </span>

        {/* Change type badge */}
        <span className={`shrink-0 text-xs font-medium ${CHANGE_TYPE_COLORS[row.changeType]}`}>
          {CHANGE_TYPE_LABEL[row.changeType]}
        </span>

        {/* Tier 2 note or non-undoable reason */}
        {row.tier === "tier2" && undoable && (
          <span className="shrink-0 text-xs text-description-fg italic">(may include other changes)</span>
        )}
        {isDisabled && (
          <span className="shrink-0 text-xs text-description-fg italic">{nonUndoableReason}</span>
        )}
      </div>

      {/* Collapsible diff (starts collapsed) */}
      {hasDiff && (
        <DiffView
          oldContent={row.oldContent}
          newContent={row.newContent}
          structuredPatch={row.structuredPatch}
          language={getLanguageFromPath(row.path)}
          globallyCollapsed={true}
          className="ml-5"
        />
      )}
    </div>
  );
};

// ============================================================================
// UndoChangesDialog
// ============================================================================

export const UndoChangesDialog: React.FC<UndoChangesDialogProps> = ({
  mode,
  target,
  workspacePath,
  input,
  redoInstructions,
  requestId,
  onClose,
}) => {
  // ── Redo mode ──────────────────────────────────────────────────────────────
  const redoRows = useMemo(
    () => (redoInstructions ?? []).map((inst) => ({ path: inst.path, instruction: inst })),
    [redoInstructions]
  );

  // ── Undo mode ──────────────────────────────────────────────────────────────
  // Build tier2 candidates from snapshotOnlyFiles
  const tier2Rows: FileRow[] = useMemo(
    () =>
      (input?.snapshotOnlyFiles ?? []).map((snap) => ({
        path: snap.path,
        changeType: snap.changeType,
        tier: "tier2",
        instruction: resolveSnapshotInstruction(snap),
        contentCaptureSkipped: snap.contentCaptureSkipped,
        structuredPatch: snap.structuredPatch,
      })),
    [input?.snapshotOnlyFiles]
  );

  const tier1Rows: FileRow[] = useMemo(
    () =>
      (input?.eventAttributedFiles ?? []).map((c: UndoFileCandidate) => ({
        path: c.path,
        changeType: c.changeType,
        tier: "tier1",
        instruction: c.instruction,
        contentCaptureSkipped: c.contentCaptureSkipped,
        oldContent: c.oldContent,
        newContent: c.newContent,
        structuredPatch: c.structuredPatch,
      })),
    [input?.eventAttributedFiles]
  );

  const allUndoRows: FileRow[] = useMemo(() => [...tier1Rows, ...tier2Rows], [tier1Rows, tier2Rows]);

  // ── Shared checked state ───────────────────────────────────────────────────
  // Pre-check all undoable tier1 files (undo mode); all redo files (redo mode)
  const initialChecked = useMemo(() => {
    if (mode === DIALOG_MODE.REDO) {
      return new Set(redoRows.map((r) => r.path));
    }
    const s = new Set<string>();
    for (const row of tier1Rows) {
      if (row.instruction !== null) s.add(row.path);
    }
    return s;
  }, [mode, tier1Rows, redoRows]);

  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(initialChecked);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultState, setResultState] = useState<"idle" | "success" | "partial" | "error">(RESULT_STATE.IDLE);

  const undoResult = useWorkflowStore((s) => s.undoResults[requestId]);
  const clearUndoResult = useWorkflowStore((s) => s.clearUndoResult);

  // React to undo/redo result arriving from the extension
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
    // Auto-close after a brief delay so the user sees the result
    const timer = setTimeout(() => {
      clearUndoResult(requestId);
      onClose();
    }, 1800);
    return () => clearTimeout(timer);
  }, [undoResult, requestId, clearUndoResult, onClose]);

  // ── Checkable rows count ───────────────────────────────────────────────────
  const checkableCount = mode === DIALOG_MODE.REDO ? redoRows.length : allUndoRows.filter((r) => r.instruction !== null).length;
  const checkedCount = mode === DIALOG_MODE.REDO
    ? redoRows.filter((r) => checkedPaths.has(r.path)).length
    : allUndoRows.filter((r) => r.instruction !== null && checkedPaths.has(r.path)).length;
  const allCheckableChecked = checkedCount === checkableCount && checkableCount > 0;

  const hasTier2 = tier2Rows.length > 0;

  function handleToggle(path: string, checked: boolean) {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function handleSelectAll() {
    if (allCheckableChecked) {
      setCheckedPaths(new Set());
    } else if (mode === DIALOG_MODE.REDO) {
      setCheckedPaths(new Set(redoRows.map((r) => r.path)));
    } else {
      const undoableRows = allUndoRows.filter((r) => r.instruction !== null);
      setCheckedPaths(new Set(undoableRows.map((r) => r.path)));
    }
  }

  function handleConfirm() {
    if (mode === DIALOG_MODE.REDO) {
      const selectedInstructions = redoRows
        .filter((r) => checkedPaths.has(r.path))
        .map((r) => r.instruction);
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
      const instructions = allUndoRows
        .filter((r) => checkedPaths.has(r.path) && r.instruction !== null)
        .map((r) => r.instruction as UndoFileInstruction);
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

  const canConfirm = checkedCount > 0 && !isSubmitting && resultState === RESULT_STATE.IDLE;

  const dialogTitle = mode === DIALOG_MODE.REDO
    ? "Redo Changes"
    : input?.scope.mode === "singleFile"
      ? `Undo changes — ${input.scope.path}`
      : "Undo prompt changes";

  const confirmLabel = mode === DIALOG_MODE.REDO ? `Redo Selected (${checkedCount})` : `Undo Selected (${checkedCount})`;
  const submittingLabel = mode === DIALOG_MODE.REDO ? "Redoing…" : "Undoing…";

  const footer = (
    <>
      <Button variant="secondary" size="md" onClick={onClose} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button variant="primary" size="md" onClick={handleConfirm} disabled={!canConfirm}>
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

  return (
    <Modal isOpen title={dialogTitle} onClose={onClose} size="lg" footer={footer}>
      {/* Result banner */}
      {resultState !== RESULT_STATE.IDLE && (
        <ResultBanner result={resultState} undoResult={undoResult} mode={mode} />
      )}

      {/* Tier 2 warning (undo mode only) */}
      {mode === DIALOG_MODE.UNDO && hasTier2 && resultState === RESULT_STATE.IDLE && (
        <div className="mb-3 flex gap-2 rounded px-3 py-2 text-xs bg-severity-warning-bg text-warning-fg border border-warning-fg border-opacity-30">
          <span className="shrink-0">⚠️</span>
          <span>
            Additional files changed during this prompt may not be shown if they were modified by
            other processes.
          </span>
        </div>
      )}

      {/* Select all toggle */}
      {checkableCount > 0 && resultState === RESULT_STATE.IDLE && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-description-fg">
            {checkedCount} of {checkableCount} file{checkableCount !== 1 ? "s" : ""} selected
          </span>
          <button
            type="button"
            onClick={handleSelectAll}
            className="text-xs text-link-fg hover:text-link-active-fg transition-colors"
          >
            {allCheckableChecked ? "Deselect all" : "Select all"}
          </button>
        </div>
      )}

      {/* File list */}
      {mode === DIALOG_MODE.REDO ? (
        redoRows.length === 0 ? (
          <p className="text-sm text-description-fg">No redo instructions available.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {redoRows.map((row) => {
              const hasDiff = (row.instruction.structuredPatch?.length ?? 0) > 0;
              return (
                <div key={row.path} className="rounded">
                  <div className="flex items-start gap-2 py-1.5 px-2 rounded text-sm hover:bg-list-hover-bg">
                    <input
                      type="checkbox"
                      checked={checkedPaths.has(row.path)}
                      onChange={(e) => handleToggle(row.path, e.target.checked)}
                      className="mt-0.5 w-3.5 h-3.5 accent-btn-bg cursor-pointer shrink-0"
                    />
                    <span className="flex-1 font-mono text-xs break-all text-foreground">
                      {row.path}
                    </span>
                    <span className={`shrink-0 text-xs font-medium ${redoActionBadgeColor(row.instruction.action)}`}>
                      {redoActionBadgeLabel(row.instruction.action)}
                    </span>
                  </div>
                  {hasDiff && (
                    <DiffView
                      structuredPatch={row.instruction.structuredPatch}
                      language={getLanguageFromPath(row.path)}
                      globallyCollapsed={true}
                      className="ml-5"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : allUndoRows.length === 0 ? (
        <p className="text-sm text-description-fg">No file changes found for this prompt.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {/* Tier 1 section */}
          {tier1Rows.length > 0 && (
            <>
              <p className="text-xs font-semibold text-description-fg uppercase tracking-wide mb-1 mt-1">
                Event-attributed changes
              </p>
              {tier1Rows.map((row) => (
                <FileRowItem
                  key={row.path}
                  row={row}
                  checked={checkedPaths.has(row.path)}
                  onChange={handleToggle}
                />
              ))}
            </>
          )}

          {/* Tier 2 section */}
          {tier2Rows.length > 0 && (
            <>
              <p className="text-xs font-semibold text-description-fg uppercase tracking-wide mb-1 mt-3">
                Other snapshot changes
              </p>
              {tier2Rows.map((row) => (
                <FileRowItem
                  key={row.path}
                  row={row}
                  checked={checkedPaths.has(row.path)}
                  onChange={handleToggle}
                />
              ))}
            </>
          )}
        </div>
      )}
    </Modal>
  );
};

// ============================================================================
// ResultBanner
// ============================================================================

interface ResultBannerProps {
  result: "success" | "partial" | "error";
  undoResult: { restoredFiles: string[]; failedFiles: Array<{ path: string; error: string }> } | undefined;
  mode: "undo" | "redo";
}

const ResultBanner: React.FC<ResultBannerProps> = ({ result, undoResult, mode }) => {
  const successVerb = mode === DIALOG_MODE.REDO ? "re-applied" : "restored";
  const failVerb = mode === DIALOG_MODE.REDO ? "Redo" : "Undo";
  if (result === RESULT_STATE.SUCCESS) {
    return (
      <div className="mb-3 flex gap-2 rounded px-3 py-2 text-xs bg-severity-info-bg text-info-fg border border-info-fg border-opacity-30">
        <span>✅</span>
        <span>
          {undoResult?.restoredFiles.length ?? 0} file
          {(undoResult?.restoredFiles.length ?? 0) !== 1 ? "s" : ""} {successVerb} successfully.
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
          {undoResult?.failedFiles.map((f) => (
            <div key={f.path} className="mt-0.5 font-mono break-all">
              {f.path}: {f.error}
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
        {undoResult?.failedFiles.map((f) => (
          <div key={f.path} className="mt-0.5 font-mono break-all">
            {f.path}: {f.error}
          </div>
        ))}
      </div>
    </div>
  );
};
