/**
 * File operation output components.
 *
 * Renders file edit, write, read, and delete events from the CLI harness.
 * All four components share the ToolDot / FilePath primitives defined here.
 */
import React, { memo } from "react";
import { DiffView } from "./DiffView";
import { ToolCallBlock } from "./ToolCallBlock";
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
const FilePath: React.FC<{
  path: string;
  className?: string;
  children?: React.ReactNode;
}> = ({ path, className = "", children }) => (
  <button
    type="button"
    className={`text-link-fg hover:underline cursor-pointer bg-transparent border-none p-0 font-[inherit] text-[inherit] whitespace-normal [overflow-wrap:anywhere] max-w-full ${className}`}
    onClick={() => openFile(path)}
    title={`Open ${path}`}
  >
    {children ?? path}
  </button>
);

interface FileOperationBlockProps {
  dotStatus: DotStatus;
  actionLabel: string;
  path: string;
  pathContent?: React.ReactNode;
  trailingAction?: React.ReactNode;
  /** Failure detail. Rendered in the body so it hangs under the ●, not inline. */
  error?: string;
  children?: React.ReactNode;
  /** Full-width content below the rail — the diff. */
  fullBleed?: React.ReactNode;
  className?: string;
}

/** Shared `● <action> <path>` frame for all four file operations. */
const FileOperationBlock: React.FC<FileOperationBlockProps> = ({
  dotStatus,
  actionLabel,
  path,
  pathContent,
  trailingAction,
  error,
  children,
  fullBleed,
  className,
}) => (
  <ToolCallBlock
    className={className}
    fullBleed={fullBleed}
    dot={<ToolDot status={dotStatus} />}
    header={
      <>
        <span className="shrink-0 leading-relaxed">{actionLabel}</span>
        <span className="min-w-0 flex-1 leading-relaxed">
          <FilePath
            path={path}
            className="inline-block whitespace-normal [overflow-wrap:anywhere] text-left align-top"
          >
            {pathContent}
          </FilePath>
        </span>
        {trailingAction}
      </>
    }
  >
    {error ? <div className="text-indicator-error">— {error}</div> : null}
    {children}
  </ToolCallBlock>
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
  pathContent?: React.ReactNode;
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
  /** "Find in output" query to highlight within the diff. */
  findQuery?: string;
  /** Whether `findQuery` matching is case-sensitive. */
  findCaseSensitive?: boolean;
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
    pathContent,
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
    findQuery,
    findCaseSensitive,
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
      <FileOperationBlock
        className={className}
        dotStatus={dotStatus}
        actionLabel={getActionLabel()}
        path={path}
        pathContent={pathContent}
        error={status === OPERATION_STATUS.FAILED ? error : undefined}
        // The diff spans the gutter as well so it keeps the full block width;
        // the rail therefore stops just above its "Show diff" toggle.
        fullBleed={
          hasDiffData ? (
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
              findQuery={findQuery}
              findCaseSensitive={findCaseSensitive}
            />
          ) : undefined
        }
      >
        {!hasDiffData && undoButton && <div className="mt-1">{undoButton}</div>}
      </FileOperationBlock>
    );
  }
);
FileEditOutput.displayName = "FileEditOutput";

// ============================================================================
// FileWriteOutput
// ============================================================================

interface FileWriteOutputProps {
  path: string;
  pathContent?: React.ReactNode;
  status?: FileOperationStatus;
  content?: string;
  error?: string;
  onUndoFile?: () => void;
  fileUndoMode?: "undo" | "redo";
  className?: string;
}

export const FileWriteOutput: React.FC<FileWriteOutputProps> = ({
  path,
  pathContent,
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
    <FileOperationBlock
      className={className}
      dotStatus={dotStatus}
      actionLabel={getActionLabel()}
      path={path}
      pathContent={pathContent}
      error={status === OPERATION_STATUS.FAILED ? error : undefined}
      trailingAction={
        onUndoFile && status !== OPERATION_STATUS.INITIATED ? (
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
        ) : null
      }
    />
  );
};

// ============================================================================
// FileReadOutput
// ============================================================================

interface FileReadOutputProps {
  path: string;
  pathContent?: React.ReactNode;
  status?: FileOperationStatus;
  error?: string;
  className?: string;
}

export const FileReadOutput: React.FC<FileReadOutputProps> = ({
  path,
  pathContent,
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
    <FileOperationBlock
      className={className}
      dotStatus={dotStatus}
      actionLabel={getActionLabel()}
      path={path}
      pathContent={pathContent}
      error={status === OPERATION_STATUS.FAILED ? error : undefined}
    />
  );
};

// ============================================================================
// FileDeleteOutput
// ============================================================================

interface FileDeleteOutputProps {
  path: string;
  pathContent?: React.ReactNode;
  success?: boolean;
  error?: string;
  onUndoFile?: () => void;
  fileUndoMode?: "undo" | "redo";
  className?: string;
}

export const FileDeleteOutput: React.FC<FileDeleteOutputProps> = ({
  path,
  pathContent,
  success,
  error,
  onUndoFile,
  fileUndoMode = "undo",
  className = "",
}) => {
  const dotStatus = boolDotStatus(success);

  return (
    <FileOperationBlock
      className={className}
      dotStatus={dotStatus}
      actionLabel="Delete file:"
      path={path}
      pathContent={pathContent}
      error={success === false ? error : undefined}
      trailingAction={
        onUndoFile && success !== false ? (
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
        ) : null
      }
    />
  );
};
