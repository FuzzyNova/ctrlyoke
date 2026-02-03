import React from "react";
import {
  escapeHtml,
  truncate,
  extractKeyParameters,
  parseUnifiedDiff,
  generateDiffLines,
  type DiffLine,
} from "@utils/outputUtils";
import type {
  CliEvent,
  OperationStatus,
  FileEditEventData,
  ToolCallEventData,
  ToolResult,
} from "../../types/cliEvents";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../../types/cliEvents";

// ============================================================================
// Diff Visualization Component
// ============================================================================

interface DiffViewProps {
  lines: DiffLine[];
  className?: string;
}

/**
 * DiffView renders a unified diff with line numbers and color-coded changes
 */
const DiffView: React.FC<DiffViewProps> = ({ lines, className = "" }) => {
  if (lines.length === 0) return null;

  return (
    <div className={`tool-call-diff ${className}`}>
      {lines.map((line, index) => (
        <div key={index} className={`diff-line ${line.type}`}>
          <span className="line-num old">
            {line.type !== "added" ? line.oldLineNum : ""}
          </span>
          <span className="line-num new">
            {line.type !== "removed" ? line.newLineNum : ""}
          </span>
          <span className="line-content">{escapeHtml(line.content)}</span>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// File Edit Output Component
// ============================================================================

interface FileEditOutputProps {
  path: string;
  status?: OperationStatus;
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
  // Determine action text based on status
  const getActionText = (): string => {
    if (status === OPERATION_STATUS.INITIATED) {
      return `Editing ${path}`;
    }
    if (status === OPERATION_STATUS.FAILED) {
      return `Edit failed: ${path}`;
    }
    return `Edited ${path}`;
  };

  // Generate diff lines
  const getDiffLines = (): DiffLine[] => {
    if (status === OPERATION_STATUS.INITIATED) {
      return [];
    }

    // Prefer structured patch with accurate line numbers
    if (structuredPatch && structuredPatch.length > 0) {
      return parseUnifiedDiff(structuredPatch);
    }

    // Fallback: Generate diff from content
    if (oldContent && newContent) {
      return generateDiffLines(oldContent, newContent);
    }

    return [];
  };

  const diffLines = getDiffLines();

  return (
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">
        <span>● {getActionText()}</span>
        {error && status === OPERATION_STATUS.FAILED && (
          <span className="tool-error-inline"> - {escapeHtml(error)}</span>
        )}
      </div>

      {diffLines.length > 0 && <DiffView lines={diffLines} />}
    </div>
  );
};

// ============================================================================
// File Write Output Component
// ============================================================================

interface FileWriteOutputProps {
  path: string;
  status?: OperationStatus;
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
  const getActionText = (): string => {
    if (status === OPERATION_STATUS.INITIATED) {
      return `Writing ${path} (starting...)`;
    }
    if (status === OPERATION_STATUS.FAILED) {
      return `Write failed: ${path}`;
    }
    const sizeInfo = content ? ` (${content.length} bytes)` : "";
    return `Wrote ${path}${sizeInfo}`;
  };

  return (
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">
        <span>● {getActionText()}</span>
        {error && status === OPERATION_STATUS.FAILED && (
          <span className="tool-error-inline"> - {escapeHtml(error)}</span>
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
  status?: OperationStatus;
  error?: string;
  className?: string;
}

export const FileReadOutput: React.FC<FileReadOutputProps> = ({
  path,
  status,
  error,
  className = "",
}) => {
  const getActionText = (): string => {
    if (status === OPERATION_STATUS.INITIATED) {
      return `Reading ${path} (starting...)`;
    }
    if (status === OPERATION_STATUS.FAILED) {
      return `Read failed: ${path}`;
    }
    return `Read ${path}`;
  };

  return (
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">
        <span>● {getActionText()}</span>
        {error && status === OPERATION_STATUS.FAILED && (
          <span className="tool-error-inline"> - {escapeHtml(error)}</span>
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
  className?: string;
}

export const FileDeleteOutput: React.FC<FileDeleteOutputProps> = ({
  path,
  className = "",
}) => {
  return (
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">
        <span>● Delete file: {path}</span>
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
  className?: string;
}

export const McpToolCallOutput: React.FC<McpToolCallOutputProps> = ({
  server,
  tool,
  className = "",
}) => {
  return (
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">
        <span>
          ● MCP: {server}.{tool}
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
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">
        <span>● Web search: "{escapeHtml(query)}"</span>
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
  const toolLine = `● ${name}(${params})`;

  const formatResult = (result: ToolResult): string => {
    const prefix = "  ⎿  ";
    if (!result.success && result.error) {
      return prefix + truncate(result.error, 200);
    }
    if (result.output) {
      return prefix + truncate(result.output, 100);
    }
    return prefix + (result.success ? "Success" : "Failed");
  };

  return (
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">{toolLine}</div>
      {result && (
        <div className={`tool-result-line ${result.success ? "" : "error"}`}>
          {formatResult(result)}
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
      const editData = data as FileEditEventData;
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
        status?: OperationStatus;
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
        status?: OperationStatus;
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
      const deleteData = data as { path: string };
      return <FileDeleteOutput path={deleteData.path} className={className} />;
    }

    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const mcpData = data as { server: string; tool: string };
      return (
        <McpToolCallOutput
          server={mcpData.server}
          tool={mcpData.tool}
          className={className}
        />
      );
    }

    case CLI_EVENT_TYPES.WEB_SEARCH: {
      const searchData = data as { query: string };
      return <WebSearchOutput query={searchData.query} className={className} />;
    }

    case CLI_EVENT_TYPES.TOOL_CALL: {
      const toolData = data as ToolCallEventData;
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
