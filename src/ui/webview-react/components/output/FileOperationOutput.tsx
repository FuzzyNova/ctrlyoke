/**
 * File operation output components.
 *
 * Renders file edit, write, read, and delete events from the CLI harness.
 * All four components share the ToolDot / FilePath primitives defined here.
 */
import React, { memo } from "react";
import { DiffView } from "./DiffView";
import { TOOL_CALL_TERMINAL, TOOL_CALL_LINE } from "./outputStyles";
import { openFile } from "@hooks/useMessageHandler";
import { getLanguageFromPath } from "@utils/syntaxHighlighting";
import { useUiStore } from "@store/uiStore";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";
import type { FileOperationStatus } from "../../types/cliEvents";
import { OPERATION_STATUS } from "../../types/cliEvents";

// ============================================================================
// Shared primitives
// ============================================================================

type DotStatus = "pending" | "success" | "error";

const DOT_COLORS: Record<DotStatus, string> = {
  pending: "text-editor-fg",
  success: "text-indicator-success",
  error: "text-indicator-error",
};

/** Coloured ● bullet that reflects the operation status */
export const ToolDot: React.FC<{ status: DotStatus }> = ({ status }) => (
  <span className={DOT_COLORS[status]}>●</span>
);

/** Clickable file path that opens the file in VS Code */
const FilePath: React.FC<{ path: string }> = ({ path }) => (
  <button
    type="button"
    className="text-link-fg hover:underline cursor-pointer bg-transparent border-none p-0 font-[inherit] text-[inherit]"
    onClick={() => openFile(path)}
    title={`Open ${path}`}
  >
    {path}
  </button>
);

function fileOpDotStatus(status?: FileOperationStatus): DotStatus {
  if (status === OPERATION_STATUS.COMPLETED) return "success";
  if (status === OPERATION_STATUS.FAILED) return "error";
  return "pending"; // INITIATED or undefined
}

function boolDotStatus(success?: boolean): DotStatus {
  if (success === true) return "success";
  if (success === false) return "error";
  return "pending";
}

// ============================================================================
// FileEditOutput
// ============================================================================

interface FileEditOutputProps {
  path: string;
  status?: FileOperationStatus;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  error?: string;
  onUndoFile?: () => void;
  fileUndoMode?: "undo" | "redo";
  /** When true, suppresses the diff display (used when a COMPLETED event for the same file follows) */
  hideDiff?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  expandedGaps?: DiffGapExpansionState;
  onExpandGap?: (gapIndex: number, nextExpandedToLine: number) => void;
  /** Forwarded to DiffView to avoid the initial wrong-viewType render. */
  viewType?: "split" | "unified";
  className?: string;
}

/**
 * FileEditOutput renders a file edit operation with diff visualization.
 *
 * The raw diff inputs are passed directly to DiffView which owns all
 * expensive computation (diff generation + syntax tokenization) lazily behind
 * an expand gate.
 * This component itself does zero diff work at render time.
 */
export const FileEditOutput = memo<FileEditOutputProps>(
  ({
    path,
    status,
    oldContent,
    newContent,
    structuredPatch,
    error,
    onUndoFile,
    fileUndoMode = "undo",
    hideDiff = false,
    collapsed,
    onCollapsedChange,
    expandedGaps,
    onExpandGap,
    viewType,
    className = "",
  }) => {
    const dotStatus = fileOpDotStatus(status);
    const diffsCollapsed = useUiStore((s) => s.diffsCollapsed);

    const getActionLabel = (): string => {
      if (status === OPERATION_STATUS.INITIATED) return "Editing";
      if (status === OPERATION_STATUS.FAILED) return "Edit failed:";
      return "Edited";
    };

    const hasDiffData =
      !hideDiff &&
      status !== OPERATION_STATUS.FAILED &&
      ((structuredPatch && structuredPatch.length > 0) ||
        (oldContent && newContent));

    const undoButton =
      onUndoFile &&
      status !== OPERATION_STATUS.INITIATED &&
      status !== OPERATION_STATUS.FAILED ? (
        <button
          type="button"
          className={`icon-btn inline-flex items-center gap-1 py-0.5 px-1.5 text-[length:var(--fp-output-font-size-xs)] ${fileUndoMode === "redo" ? "text-terminal-ansiGreen hover:opacity-80" : "text-link-fg hover:text-link-active-fg"}`}
          title={
            fileUndoMode === "redo"
              ? `Redo changes to ${path}`
              : `Undo changes to ${path}`
          }
          onClick={onUndoFile}
        >
          <i
            className={`codicon ${fileUndoMode === "redo" ? "codicon-redo" : "codicon-discard"} text-xxs`}
          />
          <span>{fileUndoMode === "redo" ? "Redo" : "Undo"}</span>
        </button>
      ) : null;

    return (
      <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
        <div className={TOOL_CALL_LINE}>
          <ToolDot status={dotStatus} />
          <span>{getActionLabel()}</span>
          <FilePath path={path} />
          {error && status === OPERATION_STATUS.FAILED && (
            <span className="text-indicator-error">— {error}</span>
          )}
        </div>
        {hasDiffData ? (
          <DiffView
            oldContent={oldContent}
            newContent={newContent}
            structuredPatch={structuredPatch}
            language={getLanguageFromPath(path)}
            globallyCollapsed={diffsCollapsed}
            actionSlot={undoButton}
            collapsed={collapsed}
            onCollapsedChange={onCollapsedChange}
            expandedGaps={expandedGaps}
            onExpandGap={onExpandGap}
            viewType={viewType}
          />
        ) : (
          undoButton && <div className="ml-6 mt-1">{undoButton}</div>
        )}
      </div>
    );
  }
);
FileEditOutput.displayName = "FileEditOutput";

// ============================================================================
// FileWriteOutput
// ============================================================================

interface FileWriteOutputProps {
  path: string;
  status?: FileOperationStatus;
  content?: string;
  error?: string;
  onUndoFile?: () => void;
  fileUndoMode?: "undo" | "redo";
  className?: string;
}

export const FileWriteOutput: React.FC<FileWriteOutputProps> = ({
  path,
  status,
  content,
  error,
  onUndoFile,
  fileUndoMode = "undo",
  className = "",
}) => {
  const dotStatus = fileOpDotStatus(status);

  const getActionLabel = (): string => {
    if (status === OPERATION_STATUS.INITIATED) return "Writing";
    if (status === OPERATION_STATUS.FAILED) return "Write failed:";
    const sizeInfo = content ? ` (${content.length} bytes)` : "";
    return `Wrote${sizeInfo}`;
  };

  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <ToolDot status={dotStatus} />
        <span>{getActionLabel()}</span>
        <FilePath path={path} />
        {error && status === OPERATION_STATUS.FAILED && (
          <span className="text-indicator-error">— {error}</span>
        )}
        {onUndoFile && status !== OPERATION_STATUS.INITIATED && (
          <button
            type="button"
            className="icon-btn py-0 px-1 ml-1 text-[length:var(--fp-output-font-size-xs)]"
            title={
              fileUndoMode === "redo"
                ? `Redo changes to ${path}`
                : `Undo changes to ${path}`
            }
            onClick={onUndoFile}
          >
            {fileUndoMode === "redo" ? "↻ Redo" : "↩ Undo"}
          </button>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// FileReadOutput
// ============================================================================

interface FileReadOutputProps {
  path: string;
  status?: FileOperationStatus;
  error?: string;
  className?: string;
}

export const FileReadOutput: React.FC<FileReadOutputProps> = ({
  path,
  status,
  error,
  className = "",
}) => {
  const dotStatus = fileOpDotStatus(status);

  const getActionLabel = (): string => {
    if (status === OPERATION_STATUS.INITIATED) return "Reading";
    if (status === OPERATION_STATUS.FAILED) return "Read failed:";
    return "Read";
  };

  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <ToolDot status={dotStatus} />
        <span>{getActionLabel()}</span>
        <FilePath path={path} />
        {error && status === OPERATION_STATUS.FAILED && (
          <span className="text-indicator-error">— {error}</span>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// FileDeleteOutput
// ============================================================================

interface FileDeleteOutputProps {
  path: string;
  success?: boolean;
  error?: string;
  onUndoFile?: () => void;
  fileUndoMode?: "undo" | "redo";
  className?: string;
}

export const FileDeleteOutput: React.FC<FileDeleteOutputProps> = ({
  path,
  success,
  error,
  onUndoFile,
  fileUndoMode = "undo",
  className = "",
}) => {
  const dotStatus = boolDotStatus(success);

  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <ToolDot status={dotStatus} />
        <span>Delete file:</span>
        <FilePath path={path} />
        {error && success === false && (
          <span className="text-indicator-error">— {error}</span>
        )}
        {onUndoFile && success !== false && (
          <button
            type="button"
            className="icon-btn py-0 px-1 ml-1 text-[length:var(--fp-output-font-size-xs)]"
            title={
              fileUndoMode === "redo"
                ? `Redo deletion of ${path}`
                : `Undo deletion of ${path}`
            }
            onClick={onUndoFile}
          >
            {fileUndoMode === "redo" ? "↻ Redo" : "↩ Undo"}
          </button>
        )}
      </div>
    </div>
  );
};
