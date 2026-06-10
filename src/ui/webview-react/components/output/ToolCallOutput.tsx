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
import React, { useId, useState } from "react";
import { extractKeyParameters } from "@utils/outputUtils";
import { formatCollapsedOutputToggleLabel } from "@utils/outputTruncation";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  buildToolCallRenderPlan,
  getGenericToolCallOutput,
  getGenericToolCallParamsText,
  getVisibleToolCallText,
  type ToolCallExpansionSection,
  type ToolCallExpansionState,
  type ToolCallRenderPlan,
  type ToolCallSectionRenderPlan,
} from "@utils/toolCallLayout";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";
import {
  TOOL_CALL_TERMINAL,
  TOOL_CALL_LINE,
  TOOL_RESULT_LINE,
  TOOL_ERROR_LINE,
} from "./outputStyles";
import { ToolDot } from "./FileOperationOutput";
import type { ToolResult } from "../../types/cliEvents";

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
  labelContent?: React.ReactNode;
  className?: string;
}

export const McpToolCallOutput: React.FC<McpToolCallOutputProps> = ({
  server,
  tool,
  result,
  labelContent,
  className = "",
}) => (
  <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
    <div className={TOOL_CALL_LINE}>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <ToolDot status={resultDotStatus(result)} />{" "}
        {labelContent ?? `MCP: ${server}.${tool}`}
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
  queryContent?: React.ReactNode;
  errorContent?: React.ReactNode;
  className?: string;
}

export const WebSearchOutput: React.FC<WebSearchOutputProps> = ({
  query,
  success,
  error,
  queryContent,
  errorContent,
  className = "",
}) => (
  <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
    <div className={TOOL_CALL_LINE}>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <ToolDot
          status={
            success === undefined ? "pending" : success ? "success" : "error"
          }
        />{" "}
        {queryContent ?? (
          <>
            Web search: &ldquo;{query}&rdquo;
          </>
        )}
      </span>
    </div>
    {error && (
      <div className={`${TOOL_ERROR_LINE} flex items-start gap-1`}>
        <span className="shrink-0">⎿</span>
        <div className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {errorContent ?? error}
        </div>
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
  nameFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
  expansion?: ToolCallExpansionState;
  renderPlan?: ToolCallRenderPlan;
  onExpansionChange?: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  className?: string;
}

export const GenericToolCallOutput: React.FC<GenericToolCallOutputProps> = ({
  name,
  parameters,
  result,
  nameFindMatches,
  outputFindMatches,
  errorFindMatches,
  expansion,
  renderPlan,
  onExpansionChange,
  className = "",
}) => {
  const [uncontrolledExpansion, setUncontrolledExpansion] =
    useState<ToolCallExpansionState>(() => ({
      ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
    }));
  const containerId = useId();
  const resolvedExpansion = expansion ?? uncontrolledExpansion;

  const params = extractKeyParameters(name, parameters);
  const fullParamsText = getGenericToolCallParamsText(parameters);
  const { output: outputStr, error: errorStr } =
    getGenericToolCallOutput(result);
  const resolvedRenderPlan =
    renderPlan ??
    buildToolCallRenderPlan({
      parameters,
      result,
      expansion: resolvedExpansion,
    });

  const updateExpansion = (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => {
    if (expansion === undefined) {
      setUncontrolledExpansion((previous) => {
        switch (section) {
          case "params":
            return { ...previous, paramsExpanded: expanded };
          case "output":
            return { ...previous, outputExpanded: expanded };
          case "error":
            return { ...previous, errorExpanded: expanded };
          default:
            return previous;
        }
      });
    }
    onExpansionChange?.(section, expanded);
  };

  const renderExpandableSection = (
    content: string,
    type: "output" | "error",
    sectionPlan: ToolCallSectionRenderPlan,
    findMatches?: RowFindDecoration["matches"]
  ) => {
    const cssClass = type === "error" ? TOOL_ERROR_LINE : TOOL_RESULT_LINE;
    const visibleText = getVisibleToolCallText(content, sectionPlan);

    // Highlight only the visible (possibly truncated) slice — find match
    // offsets are computed against the full text, but highlightText's
    // normalizeMatches clips/drops any matches outside [0, visibleText.length],
    // so matches hidden behind "[show more]" simply don't render a <mark>.
    return (
      <div className={`${cssClass} flex items-start gap-1`}>
        <span className="shrink-0">⎿</span>
        <div
          className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
          id={`${containerId}-${type}`}
        >
          {highlightText(visibleText, findMatches ?? [])}
          {sectionPlan.canToggle && (
            <button
              type="button"
              className="text-bash-expand-link no-underline text-[length:var(--fp-output-font-size-sm)] ml-1 cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
              onClick={(event) => {
                event.preventDefault();
                updateExpansion(type, !sectionPlan.isExpanded);
              }}
            >
              {sectionPlan.isExpanded
                ? "[show less]"
                : formatCollapsedOutputToggleLabel(sectionPlan, false)}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
      <div className={TOOL_CALL_LINE}>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <ToolDot status={resultDotStatus(result)} />{" "}
          {nameFindMatches?.length ? (
            <>
              {highlightText(name, nameFindMatches)}({params})
            </>
          ) : (
            `${name}(${params})`
          )}
        </span>
        {resolvedRenderPlan.params.canToggle && (
          <button
            type="button"
            className="text-bash-expand-link text-[length:var(--fp-output-font-size-sm)] cursor-pointer bg-transparent border-0 p-0 font-inherit hover:underline shrink-0"
            onClick={(event) => {
              event.preventDefault();
              updateExpansion("params", !resolvedRenderPlan.params.isExpanded);
            }}
            title={
              resolvedRenderPlan.params.isExpanded
                ? "Hide parameters"
                : "Show all parameters"
            }
          >
            {resolvedRenderPlan.params.isExpanded ? "▲" : "▼"}
          </button>
        )}
      </div>

      {resolvedRenderPlan.params.visibleLineCount > 0 && fullParamsText && (
        <div className="pl-4 ml-2 text-[length:var(--fp-output-font-size-sm)] text-description-fg whitespace-pre-wrap [overflow-wrap:anywhere]">
          {fullParamsText}
        </div>
      )}

      {outputStr &&
        renderExpandableSection(
          outputStr,
          "output",
          resolvedRenderPlan.output,
          outputFindMatches
        )}
      {errorStr &&
        renderExpandableSection(
          errorStr,
          "error",
          resolvedRenderPlan.error,
          errorFindMatches
        )}
    </div>
  );
};

// ============================================================================
// ToolCallOutput — Event Router
// ============================================================================
