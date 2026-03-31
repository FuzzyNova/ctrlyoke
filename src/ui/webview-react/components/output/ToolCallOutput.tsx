/**
 * ToolCallOutput — event router and non-file-operation tool renderers.
 *
 * Routes CLI events to the appropriate specialized component. File operation
 * events (edit / write / read / delete) are handled by FileOperationOutput.tsx.
 * The diff renderer lives in DiffView.tsx.
 *
 * Re-exports from FileOperationOutput and DiffView are preserved for
 * backward compatibility with existing consumers.
 */
import React from "react";
import { truncate, extractKeyParameters } from "@utils/outputUtils";
import {
  TOOL_CALL_TERMINAL,
  TOOL_CALL_LINE,
  TOOL_RESULT_LINE,
} from "./outputStyles";
import {
  ToolDot,
  FileEditOutput,
  FileWriteOutput,
  FileReadOutput,
  FileDeleteOutput,
} from "./FileOperationOutput";
import type { CliEvent, ToolCall, ToolResult } from "../../types/cliEvents";
import { CLI_EVENT_TYPES } from "../../types/cliEvents";

// Re-exports so existing consumers (CliOutput, UndoChangesDialog, index.ts)
// can continue to import from this file without changes.
export {
  FileEditOutput,
  FileWriteOutput,
  FileReadOutput,
  FileDeleteOutput,
} from "./FileOperationOutput";
export { DiffView } from "./DiffView";

// ── Status helper ─────────────────────────────────────────────────────────────

function resultDotStatus(result?: ToolResult): "pending" | "success" | "error" {
  if (!result) return "pending";
  return result.success ? "success" : "error";
}

// ============================================================================
// McpToolCallOutput
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
}) => (
  <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
    <div className={TOOL_CALL_LINE}>
      <ToolDot status={resultDotStatus(result)} />
      <span>
        MCP: {server}.{tool}
      </span>
    </div>
  </div>
);

// ============================================================================
// WebSearchOutput
// ============================================================================

interface WebSearchOutputProps {
  query: string;
  className?: string;
}

export const WebSearchOutput: React.FC<WebSearchOutputProps> = ({
  query,
  className = "",
}) => (
  <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
    <div className={TOOL_CALL_LINE}>
      <ToolDot status="pending" />
      <span>Web search: &ldquo;{query}&rdquo;</span>
    </div>
  </div>
);

// ============================================================================
// GenericToolCallOutput
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
// ToolCallOutput — Event Router
// ============================================================================

interface ToolCallOutputProps {
  event: CliEvent;
  className?: string;
}

/**
 * Routes CLI events to the appropriate specialized component.
 */
export const ToolCallOutput: React.FC<ToolCallOutputProps> = ({
  event,
  className = "",
}) => {
  const { type, data } = event;

  switch (type) {
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const editData = data as {
        path: string;
        status?: import("../../types/cliEvents").FileOperationStatus;
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
      };
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
        status?: import("../../types/cliEvents").FileOperationStatus;
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
        status?: import("../../types/cliEvents").FileOperationStatus;
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
