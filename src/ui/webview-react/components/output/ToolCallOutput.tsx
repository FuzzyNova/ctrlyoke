import React, { useMemo, memo, useState, useEffect, useRef } from "react";
import {
  truncate,
  extractKeyParameters,
  parseUnifiedDiff,
  generateDiffLines,
  type DiffLine,
} from "@utils/outputUtils";
import {
  TOOL_CALL_TERMINAL,
  TOOL_CALL_LINE,
  TOOL_RESULT_LINE,
} from "./outputStyles";
import { openFile } from "@hooks/useMessageHandler";
import {
  getLanguageFromPath,
  highlightLines,
  injectHljsStyles,
} from "@utils/hljsUtils";
import { useUiStore } from "@store/uiStore";

// Ensure VS Code-themed HLJS stylesheet is in <head> (idempotent)
injectHljsStyles();
import type {
  CliEvent,
  FileOperationStatus,
  FileEditData,
  ToolCall,
  ToolResult,
} from "../../types/cliEvents";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../../types/cliEvents";

// ============================================================================
// Shared Dot + FilePath primitives
// ============================================================================

type DotStatus = "pending" | "success" | "error";

const DOT_COLORS: Record<DotStatus, string> = {
  pending: "text-editor-fg",
  success: "text-bash-status-success",
  error: "text-bash-status-error",
};

/** Coloured ● bullet that reflects the operation status */
const ToolDot: React.FC<{ status: DotStatus }> = ({ status }) => (
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

// ── Status helpers ──────────────────────────────────────────────────────────

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

function resultDotStatus(result?: ToolResult): DotStatus {
  if (!result) return "pending";
  return result.success ? "success" : "error";
}

// ============================================================================
// Diff Visualization Component
// ============================================================================

const DIFF_LINE_STYLES = {
  added: {
    bg: "bg-diff-added-bg",
    contentColor: "text-diff-added-fg",
    lineNumColor: "text-diff-added-fg opacity-80",
    prefix: "+ ",
  },
  removed: {
    bg: "bg-diff-removed-bg",
    contentColor: "text-diff-removed-fg",
    lineNumColor: "text-diff-removed-fg opacity-80",
    prefix: "- ",
  },
  context: {
    bg: "bg-transparent",
    contentColor: "text-diff-context-fg",
    lineNumColor: "",
    prefix: "  ",
  },
} as const;

interface DiffViewProps {
  /** Raw old file content (full-file edit path) */
  oldContent?: string;
  /** Raw new file content (full-file edit path) */
  newContent?: string;
  /** Pre-computed unified diff hunks (patch path, e.g. from Claude) */
  structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  /** hljs language id inferred from the file path (e.g. "typescript") */
  language?: string;
  /**
   * When true the diff renders collapsed (summary header only).
   * Can be overridden per-instance by the user clicking the expand button.
   */
  globallyCollapsed: boolean;
  /** Optional content rendered inline with the expand/collapse toggle */
  actionSlot?: React.ReactNode;
  className?: string;
}

/**
 * DiffView — lazy, collapsible diff renderer.
 *
 * Performance design:
 * - **Collapsed (default)**: renders a single summary line.  Zero DOM nodes for
 *   diff lines, zero HLJS calls — the main render path is O(1).
 * - **Expanded**: diff lines are computed via useMemo (gated on expand), then
 *   HLJS highlighting runs in a useEffect so it never blocks the initial paint.
 *   The component shows plain (un-highlighted) diff lines immediately and
 *   upgrades to coloured output once HLJS finishes.
 *
 * The global `diffsCollapsed` flag from uiStore sets the initial state.
 * Each instance can be expanded/collapsed independently regardless of the
 * global toggle — the global toggle only resets instances that haven't been
 * interacted with (i.e. the user-override takes priority).
 */
export const DiffView: React.FC<DiffViewProps> = ({
  oldContent,
  newContent,
  structuredPatch,
  language,
  globallyCollapsed,
  actionSlot,
  className = "",
}) => {
  const diffResetVersion = useUiStore((s) => s.diffResetVersion);
  const [isExpanded, setIsExpanded] = useState(!globallyCollapsed);

  // When the global flag changes or the reset version is bumped (e.g. user clicks
  // "Expand all" / "Collapse all"), always snap to the global state.
  // diffResetVersion is included so the effect fires even when globallyCollapsed
  // doesn't change — e.g. diffsCollapsed is already false but the user manually
  // collapsed one diff and then clicks "Expand all" again.
  useEffect(() => {
    setIsExpanded(!globallyCollapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globallyCollapsed, diffResetVersion]);

  const handleToggle = () => {
    setIsExpanded((prev) => !prev);
  };

  // Compute diff lines lazily — only when expanded.
  // This avoids running Diff.diffLines() (O(N*D)) and parseUnifiedDiff() for
  // every file edit at mount time.
  const diffLines = useMemo((): DiffLine[] => {
    if (!isExpanded) return [];
    if (structuredPatch && structuredPatch.length > 0) {
      return parseUnifiedDiff(structuredPatch);
    }
    if (oldContent && newContent) {
      return generateDiffLines(oldContent, newContent);
    }
    return [];
  }, [isExpanded, structuredPatch, oldContent, newContent]);

  // Derive a quick line-count estimate for the summary badge without computing
  // the full diff. For structured patches we count hunk lines; for full-file
  // pairs we just count the larger file.
  const estimatedLineCount = useMemo(() => {
    if (structuredPatch && structuredPatch.length > 0) {
      return structuredPatch.reduce((acc, h) => acc + h.lines.length, 0);
    }
    if (oldContent || newContent) {
      const oldLines = oldContent ? oldContent.split("\n").length : 0;
      const newLines = newContent ? newContent.split("\n").length : 0;
      return oldLines + newLines;
    }
    return 0;
  }, [structuredPatch, oldContent, newContent]);

  const hasDiff = estimatedLineCount > 0;

  // Ref on the wrapper div so we can traverse up to the diff anchor and
  // stamp data-diff-collapsed whenever expand/collapse state changes.
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Propagate actual collapse state to the nearest [data-diff-anchor] wrapper
  // so OutputSection's measurement can read the true state rather than
  // inferring it from rendered height.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const anchor = el.closest<HTMLElement>("[data-diff-anchor]");
    if (anchor) {
      anchor.setAttribute("data-diff-collapsed", isExpanded ? "false" : "true");
    }
  }, [isExpanded]);

  // Async HLJS highlighting — runs in useEffect so it never blocks the paint.
  // When diffLines changes (expand) we kick off highlighting and set the result
  // once it's done. Until then, plain (un-highlighted) text is shown.
  const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
  const highlightVersion = useRef(0); // prevents stale async result from landing

  useEffect(() => {
    if (diffLines.length === 0) {
      setHighlightedLines([]);
      return;
    }
    const version = ++highlightVersion.current;
    // Run HLJS in a macrotask so the browser can paint the un-highlighted
    // diff lines first, keeping the expand interaction responsive.
    const id = setTimeout(() => {
      const combined = diffLines.map((l) => l.content).join("\n");
      const result = highlightLines(combined, language);
      if (highlightVersion.current === version) {
        setHighlightedLines(result);
      }
    }, 0);
    return () => clearTimeout(id);
  }, [diffLines, language]);

  if (!hasDiff) return null;

  return (
    <div ref={wrapperRef} className={`my-2 ml-6 font-mono text-[length:var(--fp-output-font-size-sm)] ${className}`}>
      {/* Summary / toggle header */}
      <div className="flex items-center gap-2 mb-1">
        <button
          type="button"
          onClick={handleToggle}
          className="flex items-center gap-1.5 text-[length:var(--fp-output-font-size-xs)] text-description-fg hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0 font-[inherit]"
          title={isExpanded ? "Collapse diff" : "Expand diff"}
        >
          <i
            className={`codicon codicon-chevron-right text-[length:var(--fp-output-font-size-xs)] transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
          />
          <span>
            {isExpanded ? "Hide" : "Show"} diff
            {!isExpanded && estimatedLineCount > 0 && (
              <span className="ml-1 opacity-60">
                (~{estimatedLineCount} lines)
              </span>
            )}
          </span>
        </button>
        {actionSlot}
      </div>

      {/* Diff lines — only mounted when expanded */}
      {isExpanded && diffLines.length > 0 && (
        <div className="rounded-[3px] overflow-x-auto overflow-y-hidden border border-vscode-border bg-vscode-bg">
          {diffLines.map((line, index) => {
            const styles =
              DIFF_LINE_STYLES[line.type] || DIFF_LINE_STYLES.context;
            const highlighted = highlightedLines[index] ?? "";

            return (
              <div
                key={index}
                className={`flex items-baseline whitespace-pre font-inherit leading-[1.4] py-px ${styles.bg}`}
              >
                <span
                  className={`inline-block w-10 text-right px-1.5 select-none text-[length:var(--fp-output-font-size-xs)] opacity-60 shrink-0 text-diff-line-num ${styles.lineNumColor}`}
                >
                  {line.type !== "added" ? line.oldLineNum : ""}
                </span>
                <span
                  className={`inline-block w-10 text-right px-1.5 select-none text-[length:var(--fp-output-font-size-xs)] opacity-60 shrink-0 text-diff-line-num border-r border-diff-line-num mr-2 ${styles.lineNumColor}`}
                >
                  {line.type !== "removed" ? line.newLineNum : ""}
                </span>
                <span
                  className={`flex-1 min-w-0 py-0.5 pr-2 overflow-visible whitespace-pre`}
                >
                  <span className={`font-bold ${styles.contentColor}`}>
                    {styles.prefix}
                  </span>
                  {highlighted ? (
                    <span dangerouslySetInnerHTML={{ __html: highlighted }} />
                  ) : (
                    <span className={styles.contentColor}>{line.content}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// File Edit Output Component
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

    const undoButton = onUndoFile &&
      status !== OPERATION_STATUS.INITIATED &&
      status !== OPERATION_STATUS.FAILED ? (
      <button
        type="button"
        className="text-[length:var(--fp-output-font-size-xs)] font-bold uppercase text-description-fg hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0 font-[inherit]"
        title={fileUndoMode === "redo" ? `Redo changes to ${path}` : `Undo changes to ${path}`}
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
            <span className="text-bash-status-error">— {error}</span>
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
        ) : undoButton && (
          <div className="ml-6 mt-1">{undoButton}</div>
        )}
      </div>
    );
  }
);
FileEditOutput.displayName = "FileEditOutput";

// ============================================================================
// File Write Output Component
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
          <span className="text-bash-status-error">— {error}</span>
        )}
        {onUndoFile && status !== OPERATION_STATUS.INITIATED && (
          <button
            type="button"
            className="icon-btn py-0 px-1 ml-1 text-[length:var(--fp-output-font-size-xs)]"
            title={fileUndoMode === "redo" ? `Redo changes to ${path}` : `Undo changes to ${path}`}
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
// File Read Output Component
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
          <span className="text-bash-status-error">— {error}</span>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// File Delete Output Component
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
          <span className="text-bash-status-error">— {error}</span>
        )}
        {onUndoFile && success !== false && (
          <button
            type="button"
            className="icon-btn py-0 px-1 ml-1 text-[length:var(--fp-output-font-size-xs)]"
            title={fileUndoMode === "redo" ? `Redo deletion of ${path}` : `Undo deletion of ${path}`}
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
// MCP Tool Call Output Component
// ============================================================================

interface McpToolCallOutputProps {
  server: string;
  tool: string;
  result?: ToolResult;
  className?: string;
}

export const McpToolCallOutput: React.FC<McpToolCallOutputProps> = ({
  server,
  tool,
  result,
  className = "",
}) => {
  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <ToolDot status={resultDotStatus(result)} />
        <span>
          MCP: {server}.{tool}
        </span>
      </div>
    </div>
  );
};

// ============================================================================
// Web Search Output Component
// ============================================================================

interface WebSearchOutputProps {
  query: string;
  className?: string;
}

export const WebSearchOutput: React.FC<WebSearchOutputProps> = ({
  query,
  className = "",
}) => {
  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <ToolDot status="pending" />
        <span>Web search: &ldquo;{query}&rdquo;</span>
      </div>
    </div>
  );
};

// ============================================================================
// Generic Tool Call Output Component
// ============================================================================

interface GenericToolCallOutputProps {
  name: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;
  className?: string;
}

export const GenericToolCallOutput: React.FC<GenericToolCallOutputProps> = ({
  name,
  parameters,
  result,
  className = "",
}) => {
  const params = extractKeyParameters(name, parameters);

  const getResultText = (r: ToolResult): string => {
    if (!r.success && r.error) return truncate(r.error, 200);
    if (r.output) return truncate(r.output, 100);
    return r.success ? "Success" : "Failed";
  };

  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <ToolDot status={resultDotStatus(result)} />
        <span>
          {name}({params})
        </span>
      </div>
      {result && (
        <div
          className={`${result.success ? TOOL_RESULT_LINE : "text-bash-status-error pl-4 ml-2 text-[length:var(--fp-output-font-size-sm)]"} flex items-start gap-1`}
        >
          <span className="shrink-0">⎿</span>
          <span className="whitespace-pre-wrap break-words min-w-0">
            {getResultText(result)}
          </span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main ToolCallOutput Component (Event Router)
// ============================================================================

interface ToolCallOutputProps {
  event: CliEvent;
  className?: string;
}

/**
 * ToolCallOutput Component
 *
 * Routes CLI events to the appropriate specialized component.
 * Handles all event types from CLI_EVENT_TYPES.
 */
export const ToolCallOutput: React.FC<ToolCallOutputProps> = ({
  event,
  className = "",
}) => {
  const { type, data } = event;

  switch (type) {
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const editData = data as FileEditData;
      return (
        <FileEditOutput
          path={editData.path}
          status={editData.status}
          oldContent={editData.oldContent}
          newContent={editData.newContent}
          structuredPatch={editData.structuredPatch}
          error={editData.error}
          className={className}
        />
      );
    }

    case CLI_EVENT_TYPES.FILE_WRITE: {
      const writeData = data as {
        path: string;
        status?: FileOperationStatus;
        content?: string;
        error?: string;
      };
      return (
        <FileWriteOutput
          path={writeData.path}
          status={writeData.status}
          content={writeData.content}
          error={writeData.error}
          className={className}
        />
      );
    }

    case CLI_EVENT_TYPES.FILE_READ: {
      const readData = data as {
        path: string;
        status?: FileOperationStatus;
        error?: string;
      };
      return (
        <FileReadOutput
          path={readData.path}
          status={readData.status}
          error={readData.error}
          className={className}
        />
      );
    }

    case CLI_EVENT_TYPES.FILE_DELETE: {
      const deleteData = data as {
        path: string;
        success?: boolean;
        error?: string;
      };
      return (
        <FileDeleteOutput
          path={deleteData.path}
          success={deleteData.success}
          error={deleteData.error}
          className={className}
        />
      );
    }

    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const mcpData = data as {
        server: string;
        tool: string;
        result?: ToolResult;
      };
      return (
        <McpToolCallOutput
          server={mcpData.server}
          tool={mcpData.tool}
          result={mcpData.result}
          className={className}
        />
      );
    }

    case CLI_EVENT_TYPES.WEB_SEARCH: {
      const searchData = data as { query: string };
      return <WebSearchOutput query={searchData.query} className={className} />;
    }

    case CLI_EVENT_TYPES.TOOL_CALL: {
      const toolData = data as ToolCall;
      return (
        <GenericToolCallOutput
          name={toolData.name}
          parameters={toolData.parameters}
          result={toolData.result}
          className={className}
        />
      );
    }

    default:
      return null;
  }
};
