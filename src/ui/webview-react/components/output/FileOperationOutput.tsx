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
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { openContextReference } from "@utils/contextReferenceActions";
import { getLanguageFromPath } from "@utils/syntaxHighlighting";
import { useUiStore } from "@store/uiStore";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";
import type { FileOperationStatus } from "../../types/cliEvents";
import { OPERATION_STATUS } from "../../types/cliEvents";
import { AtomicReferenceChip } from "./AtomicReferenceChip";
import {
  createAtomicReferencePresentation,
  createFileReferenceChip,
  createSelectionReferenceChip,
} from "@utils/atomicReferences";
import { buildSelectionReferenceText } from "@root/completions/ContextReferenceBuilder";
import type { RowFindDecoration } from "@utils/outputFind";
import { hasRenderableDiff } from "@utils/diffUtils";
import {
  TOOL_RESULT_STATUSES,
  UNDO_REDO_DIRECTIONS,
  type ToolResultStatus,
  type UndoRedoDirection,
} from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

// ============================================================================
// Shared primitives
// ============================================================================

type DotStatus = ToolResultStatus;

const DOT_COLORS: Record<DotStatus, string> = {
  [TOOL_RESULT_STATUSES.PENDING]: "text-editor-fg",
  [TOOL_RESULT_STATUSES.SUCCESS]: "text-indicator-success",
  [TOOL_RESULT_STATUSES.ERROR]: "text-indicator-error",
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
  /** Overrides the default "open whole file" click/title — used for a line-range read. */
  onClick?: () => void;
  title?: string;
}> = ({ path, className = "", children, onClick, title }) => (
  <button
    type="button"
    className={`text-link-fg hover:underline cursor-pointer bg-transparent border-none p-0 font-[inherit] text-[inherit] whitespace-normal [overflow-wrap:anywhere] max-w-full ${className}`}
    onClick={onClick ?? (() => openFile(path))}
    title={title ?? `Open ${path}`}
    aria-label={title ?? `Open ${path}`}
  >
    {children ?? path}
  </button>
);

interface FileOperationBlockProps {
  dotStatus: DotStatus;
  actionLabel: string;
  path: string;
  pathContent?: React.ReactNode;
  pathSuffix?: React.ReactNode;
  atomicContextReferences?: boolean;
  filePathFindMatches?: RowFindDecoration["matches"];
  /**
   * When set (a line-range read), the header reference becomes
   * `#selection:path:start-end` instead of a plain file reference — a chip
   * when atomicContextReferences is on, a plain link otherwise — and opens
   * the file scrolled to that range.
   */
  selectionReference?: { lineStart: number; lineEnd: number };
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
  pathSuffix,
  atomicContextReferences = false,
  filePathFindMatches = [],
  selectionReference,
  trailingAction,
  error,
  children,
  fullBleed,
  className,
}) => {
  const selectionSourceText = selectionReference
    ? buildSelectionReferenceText(
        path,
        selectionReference.lineStart,
        selectionReference.lineEnd
      )
    : undefined;
  const sourceText = selectionSourceText ?? path;
  const descriptor = atomicContextReferences
    ? selectionReference && selectionSourceText
      ? createSelectionReferenceChip(
          path,
          selectionReference.lineStart,
          selectionReference.lineEnd,
          selectionSourceText.length
        )
      : createFileReferenceChip(path)
    : undefined;
  const openTarget = selectionReference
    ? () =>
        openContextReference(
          {
            type: "lineRange",
            path,
            lineStart: selectionReference.lineStart,
            lineEnd: selectionReference.lineEnd,
          },
          getVsCodeApi()
        )
    : () => openFile(path);
  const plainTitle = selectionReference
    ? `Open ${path}:${selectionReference.lineStart}-${selectionReference.lineEnd}`
    : `Open ${path}`;

  return (
    <ToolCallBlock
      className={className}
      fullBleed={fullBleed}
      dot={<ToolDot status={dotStatus} />}
      header={
        <>
          <span className="shrink-0 leading-relaxed">{actionLabel}</span>
          <span className="min-w-0 flex-1 leading-relaxed">
            {descriptor ? (
              <AtomicReferenceChip
                descriptor={descriptor}
                presentation={createAtomicReferencePresentation(
                  descriptor,
                  sourceText
                )}
                findMatches={filePathFindMatches}
                onOpen={openTarget}
                className="text-left align-top"
              />
            ) : (
              <FilePath
                path={path}
                onClick={openTarget}
                title={plainTitle}
                className="inline-block whitespace-normal [overflow-wrap:anywhere] text-left align-top"
              >
                {pathContent}
              </FilePath>
            )}
          </span>
          {pathSuffix}
          {trailingAction}
        </>
      }
    >
      {error ? <div className="text-indicator-error">— {error}</div> : null}
      {children}
    </ToolCallBlock>
  );
};

function fileOpDotStatus(status?: FileOperationStatus): DotStatus {
  if (status === OPERATION_STATUS.COMPLETED)
    return TOOL_RESULT_STATUSES.SUCCESS;
  if (status === OPERATION_STATUS.FAILED) return TOOL_RESULT_STATUSES.ERROR;
  return TOOL_RESULT_STATUSES.PENDING; // INITIATED or undefined
}

function boolDotStatus(success?: boolean): DotStatus {
  if (success === true) return TOOL_RESULT_STATUSES.SUCCESS;
  if (success === false) return TOOL_RESULT_STATUSES.ERROR;
  return TOOL_RESULT_STATUSES.PENDING;
}

/** Shared undo/redo icon button for file edit, write, and delete outputs. */
const FileUndoButton: React.FC<{
  path: string;
  onUndoFile: () => void;
  fileUndoMode?: UndoRedoDirection;
  /** What was undone/redone, e.g. "changes to" or "deletion of". */
  actionNoun?: string;
}> = ({
  path,
  onUndoFile,
  fileUndoMode = UNDO_REDO_DIRECTIONS.UNDO,
  actionNoun = "changes to",
}) => (
  <button
    type="button"
    aria-label={
      fileUndoMode === UNDO_REDO_DIRECTIONS.REDO
        ? "Redo file operation"
        : "Undo file operation"
    }
    className={`icon-btn inline-flex items-center gap-1 py-0.5 px-1.5 text-[length:var(--cy-output-font-size-xs)] ${fileUndoMode === UNDO_REDO_DIRECTIONS.REDO ? "text-terminal-ansiGreen hover:opacity-80" : "text-link-fg hover:text-link-active-fg"}`}
    title={
      fileUndoMode === UNDO_REDO_DIRECTIONS.REDO
        ? `Redo ${actionNoun} ${path}`
        : `Undo ${actionNoun} ${path}`
    }
    onClick={onUndoFile}
  >
    <Icon
      name={
        fileUndoMode === UNDO_REDO_DIRECTIONS.REDO
          ? "codicon-redo"
          : "codicon-discard"
      }
      className="text-xxs"
    />
    <span>{fileUndoMode === UNDO_REDO_DIRECTIONS.REDO ? "Redo" : "Undo"}</span>
  </button>
);

// ============================================================================
// FileEditOutput
// ============================================================================

interface FileEditOutputProps {
  path: string;
  pathContent?: React.ReactNode;
  atomicContextReferences?: boolean;
  filePathFindMatches?: RowFindDecoration["matches"];
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
  fileUndoMode?: UndoRedoDirection;
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
  /** Offset range of the currently active find match within this diff's searched text. */
  activeMatchRange?: { start: number; end: number } | null;
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
    atomicContextReferences,
    filePathFindMatches,
    status,
    oldContent,
    newContent,
    structuredPatch,
    error,
    onUndoFile,
    fileUndoMode = UNDO_REDO_DIRECTIONS.UNDO,
    hideDiff = false,
    collapsed,
    onCollapsedChange,
    expandedGaps,
    onExpandGap,
    viewType,
    findQuery,
    findCaseSensitive,
    activeMatchRange,
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
      hasRenderableDiff({ oldContent, newContent, structuredPatch });

    const undoButton =
      onUndoFile &&
      status !== OPERATION_STATUS.INITIATED &&
      status !== OPERATION_STATUS.FAILED ? (
        <FileUndoButton
          path={path}
          onUndoFile={onUndoFile}
          fileUndoMode={fileUndoMode}
        />
      ) : null;

    return (
      <FileOperationBlock
        className={className}
        dotStatus={dotStatus}
        actionLabel={getActionLabel()}
        path={path}
        pathContent={pathContent}
        atomicContextReferences={atomicContextReferences}
        filePathFindMatches={filePathFindMatches}
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
              activeMatchRange={activeMatchRange}
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
  atomicContextReferences?: boolean;
  filePathFindMatches?: RowFindDecoration["matches"];
  status?: FileOperationStatus;
  content?: string;
  error?: string;
  onUndoFile?: () => void;
  fileUndoMode?: UndoRedoDirection;
  className?: string;
}

export const FileWriteOutput: React.FC<FileWriteOutputProps> = ({
  path,
  pathContent,
  atomicContextReferences,
  filePathFindMatches,
  status,
  content,
  error,
  onUndoFile,
  fileUndoMode = UNDO_REDO_DIRECTIONS.UNDO,
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
      atomicContextReferences={atomicContextReferences}
      filePathFindMatches={filePathFindMatches}
      error={status === OPERATION_STATUS.FAILED ? error : undefined}
      trailingAction={
        onUndoFile && status !== OPERATION_STATUS.INITIATED ? (
          <FileUndoButton
            path={path}
            onUndoFile={onUndoFile}
            fileUndoMode={fileUndoMode}
          />
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
  lineStart?: number;
  lineEnd?: number;
  atomicContextReferences?: boolean;
  filePathFindMatches?: RowFindDecoration["matches"];
  status?: FileOperationStatus;
  error?: string;
  className?: string;
}

export const FileReadOutput: React.FC<FileReadOutputProps> = ({
  path,
  pathContent,
  lineStart,
  lineEnd,
  atomicContextReferences,
  filePathFindMatches,
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
      selectionReference={
        lineStart !== undefined && lineEnd !== undefined
          ? { lineStart, lineEnd }
          : undefined
      }
      atomicContextReferences={atomicContextReferences}
      filePathFindMatches={filePathFindMatches}
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
  atomicContextReferences?: boolean;
  filePathFindMatches?: RowFindDecoration["matches"];
  success?: boolean;
  error?: string;
  onUndoFile?: () => void;
  fileUndoMode?: UndoRedoDirection;
  className?: string;
}

export const FileDeleteOutput: React.FC<FileDeleteOutputProps> = ({
  path,
  pathContent,
  atomicContextReferences,
  filePathFindMatches,
  success,
  error,
  onUndoFile,
  fileUndoMode = UNDO_REDO_DIRECTIONS.UNDO,
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
      atomicContextReferences={atomicContextReferences}
      filePathFindMatches={filePathFindMatches}
      error={success === false ? error : undefined}
      trailingAction={
        onUndoFile && success !== false ? (
          <FileUndoButton
            path={path}
            onUndoFile={onUndoFile}
            fileUndoMode={fileUndoMode}
            actionNoun="deletion of"
          />
        ) : null
      }
    />
  );
};
