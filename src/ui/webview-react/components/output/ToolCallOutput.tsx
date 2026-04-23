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
import React, { useState, useId } from "react";
import { extractKeyParameters } from "@utils/outputUtils";
import {
  TOOL_CALL_TERMINAL,
  TOOL_CALL_LINE,
  TOOL_RESULT_LINE,
  TOOL_ERROR_LINE,
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
  success?: boolean;
  error?: string;
  className?: string;
}

export const WebSearchOutput: React.FC<WebSearchOutputProps> = ({
  query,
  success,
  error,
  className = "",
}) => (
  <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
    <div className={TOOL_CALL_LINE}>
      <ToolDot
        status={
          success === undefined ? "pending" : success ? "success" : "error"
        }
      />
      <span>Web search: &ldquo;{query}&rdquo;</span>
    </div>
    {error && (
      <div className={TOOL_ERROR_LINE}>
        <span className="text-vscode-description-fg shrink-0">{"  ⎿  "}</span>
        <div className="inline whitespace-pre-wrap break-words">{error}</div>
      </div>
    )}
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

const MAX_RESULT_LINES = 10;

export const GenericToolCallOutput: React.FC<GenericToolCallOutputProps> = ({
  name,
  parameters,
  result,
  className = "",
}) => {
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const containerId = useId();

  const params = extractKeyParameters(name, parameters);
  const hasParams = parameters != null && Object.keys(parameters).length > 0;

  const fullParamsText = hasParams
    ? Object.entries(parameters!)
        .map(
          ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
        )
        .join("\n")
    : "";

  const outputStr =
    typeof result?.output === "string" ? result.output : undefined;
  const errorStr =
    result != null && !result.success && typeof result.error === "string"
      ? result.error
      : undefined;

  const renderExpandableSection = (
    content: string,
    type: "output" | "error",
    isExpanded: boolean,
    setExpanded: (v: boolean) => void
  ) => {
    const lines = content.split("\n");
    const isTruncated = lines.length > MAX_RESULT_LINES;
    const visible =
      isTruncated && !isExpanded
        ? lines.slice(0, MAX_RESULT_LINES).join("\n")
        : content;
    const hiddenLines = lines.length - MAX_RESULT_LINES;
    const cssClass = type === "error" ? TOOL_ERROR_LINE : TOOL_RESULT_LINE;

    return (
      <div className={cssClass}>
        <span className="text-vscode-description-fg shrink-0">{"  ⎿  "}</span>
        <div
          className="inline whitespace-pre-wrap break-words"
          id={`${containerId}-${type}`}
        >
          {visible}
          {isTruncated && (
            <button
              type="button"
              className="text-bash-expand-link no-underline text-[0.9em] ml-1 cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
              onClick={() => setExpanded(!isExpanded)}
            >
              {isExpanded
                ? "[show less]"
                : `[show ${hiddenLines} more line${hiddenLines !== 1 ? "s" : ""}]`}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <ToolDot status={resultDotStatus(result)} />
        <span>
          {name}({params})
        </span>
        {hasParams && (
          <button
            type="button"
            className="text-bash-expand-link text-[0.85em] cursor-pointer bg-transparent border-0 p-0 font-inherit hover:underline"
            onClick={() => setParamsExpanded(!paramsExpanded)}
            title={paramsExpanded ? "Hide parameters" : "Show all parameters"}
          >
            {paramsExpanded ? "▲" : "▼"}
          </button>
        )}
      </div>

      {paramsExpanded && fullParamsText && (
        <div className="pl-4 ml-2 text-[length:var(--fp-output-font-size-sm)] text-description-fg whitespace-pre-wrap break-all">
          {fullParamsText}
        </div>
      )}

      {outputStr &&
        renderExpandableSection(
          outputStr,
          "output",
          outputExpanded,
          setOutputExpanded
        )}
      {errorStr &&
        renderExpandableSection(
          errorStr,
          "error",
          errorExpanded,
          setErrorExpanded
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
      const searchData = data as {
        query: string;
        success?: boolean;
        error?: string;
      };
      return (
        <WebSearchOutput
          query={searchData.query}
          success={searchData.success}
          error={searchData.error}
          className={className}
        />
      );
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
