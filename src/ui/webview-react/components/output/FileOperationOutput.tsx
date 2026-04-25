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
import { getLanguageFromPath } from "@utils/hljsUtils";
import { useUiStore } from "@store/uiStore";
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
export const FilePath: React.FC<{ path: string }> = ({ path }) => (
  <button
    type="button"
    className="text-link-fg hover:underline cursor-pointer bg-transparent border-none p-0 font-[inherit] text-[inherit]"
    onClick={() => openFile(path)}
    title={`Open ${path}`}
  >
    {path}
  </button>
);

export function fileOpDotStatus(status?: FileOperationStatus): DotStatus {
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
  onUndoFile?: (path: string, attemptIndex: number) => void;
  attemptIndex?: number;
  fileUndoMode?: "undo" | "redo";
  /** When true, suppresses the diff display (used when a COMPLETED event for the same file follows) */
  hideDiff?: boolean;
  className?: string;
}

/**
 * FileEditOutput renders a file edit operation with diff visualization.
 *
 * The raw diff inputs are passed directly to DiffView which owns all
 * expensive computation (diff generation + HLJS) lazily behind an expand gate.
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
    attemptIndex = 0,
    fileUndoMode = "undo",
    hideDiff = false,
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
          className="text-[length:var(--fp-output-font-size-xs)] font-bold uppercase text-description-fg hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0 font-[inherit]"
          title={
            fileUndoMode === "redo"
              ? `Redo changes to ${path}`
              : `Undo changes to ${path}`
          }
          onClick={() => onUndoFile(path, attemptIndex)}
        >
          {fileUndoMode === "redo" ? "↻ Redo" : "↩ Undo"}
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
  onUndoFile?: (path: string, attemptIndex: number) => void;
  attemptIndex?: number;
  fileUndoMode?: "undo" | "redo";
  className?: string;
}

export const FileWriteOutput: React.FC<FileWriteOutputProps> = ({
  path,
  status,
  content,
  error,
  onUndoFile,
  attemptIndex = 0,
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
            onClick={() => onUndoFile(path, attemptIndex)}
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
  onUndoFile?: (path: string, attemptIndex: number) => void;
  attemptIndex?: number;
  fileUndoMode?: "undo" | "redo";
  className?: string;
}

export const FileDeleteOutput: React.FC<FileDeleteOutputProps> = ({
  path,
  success,
  error,
  onUndoFile,
  attemptIndex = 0,
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
            onClick={() => onUndoFile(path, attemptIndex)}
          >
            {fileUndoMode === "redo" ? "↻ Redo" : "↩ Undo"}
          </button>
        )}
      </div>
    </div>
  );
};
