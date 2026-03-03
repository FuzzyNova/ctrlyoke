import React, { useMemo } from "react";
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
  lines: DiffLine[];
  /** hljs language id inferred from the file path (e.g. "typescript") */
  language?: string;
  className?: string;
}

/**
 * DiffView renders a unified diff with line numbers, color-coded changes,
 * and per-line syntax highlighting via highlight.js.
 *
 * Row backgrounds (green / red) communicate add / remove.
 * The +/- prefix retains its diff colour.
 * Token colours from hljs show through on the code content.
 */
const DiffView: React.FC<DiffViewProps> = ({
  lines,
  language,
  className = "",
}) => {
  // Highlight all lines as a single block so that multi-line constructs
  // (block comments, template literals, etc.) are recognised across line
  // boundaries. splitHighlightedHtml then gives us one fragment per line.
  const highlightedLines = useMemo(() => {
    if (lines.length === 0) return [];
    const combined = lines.map((l) => l.content).join("\n");
    return highlightLines(combined, language);
  }, [lines, language]);

  if (lines.length === 0) return null;

  return (
    <div
      className={`my-2 ml-6 font-mono text-[11px] rounded-[3px] overflow-x-auto overflow-y-hidden border border-vscode-border bg-vscode-bg ${className}`}
    >
      {lines.map((line, index) => {
        const styles = DIFF_LINE_STYLES[line.type] || DIFF_LINE_STYLES.context;
        const highlighted = highlightedLines[index] ?? "";

        return (
          <div
            key={index}
            className={`flex items-baseline whitespace-pre font-inherit leading-[1.4] py-px ${styles.bg}`}
          >
            <span
              className={`inline-block w-10 text-right px-1.5 select-none text-[10px] opacity-60 shrink-0 text-diff-line-num ${styles.lineNumColor}`}
            >
              {line.type !== "added" ? line.oldLineNum : ""}
            </span>
            <span
              className={`inline-block w-10 text-right px-1.5 select-none text-[10px] opacity-60 shrink-0 text-diff-line-num border-r border-diff-line-num mr-2 ${styles.lineNumColor}`}
            >
              {line.type !== "removed" ? line.newLineNum : ""}
            </span>
            {/* prefix: keep diff colour; content: hljs token colours */}
            <span
              className={`flex-1 min-w-0 py-0.5 pr-2 overflow-visible whitespace-pre`}
            >
              <span className={`font-bold ${styles.contentColor}`}>
                {styles.prefix}
              </span>
              <span dangerouslySetInnerHTML={{ __html: highlighted }} />
            </span>
          </div>
        );
      })}
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
  className?: string;
}

/**
 * FileEditOutput renders a file edit operation with diff visualization
 */
export const FileEditOutput: React.FC<FileEditOutputProps> = ({
  path,
  status,
  oldContent,
  newContent,
  structuredPatch,
  error,
  className = "",
}) => {
  const dotStatus = fileOpDotStatus(status);

  const getActionLabel = (): string => {
    if (status === OPERATION_STATUS.INITIATED) return "Editing";
    if (status === OPERATION_STATUS.FAILED) return "Edit failed:";
    return "Edited";
  };

  // Generate diff lines
  const getDiffLines = (): DiffLine[] => {
    if (status === OPERATION_STATUS.INITIATED) return [];
    if (structuredPatch && structuredPatch.length > 0) {
      return parseUnifiedDiff(structuredPatch);
    }
    if (oldContent && newContent) {
      return generateDiffLines(oldContent, newContent);
    }
    return [];
  };

  const diffLines = getDiffLines();

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
      {diffLines.length > 0 && (
        <DiffView lines={diffLines} language={getLanguageFromPath(path)} />
      )}
    </div>
  );
};

// ============================================================================
// File Write Output Component
// ============================================================================

interface FileWriteOutputProps {
  path: string;
  status?: FileOperationStatus;
  content?: string;
  error?: string;
  className?: string;
}

export const FileWriteOutput: React.FC<FileWriteOutputProps> = ({
  path,
  status,
  content,
  error,
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
  className?: string;
}

export const FileDeleteOutput: React.FC<FileDeleteOutputProps> = ({
  path,
  success,
  error,
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
          className={`${result.success ? TOOL_RESULT_LINE : "text-bash-status-error pl-4 ml-2 text-[11px]"} flex items-start gap-1`}
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
