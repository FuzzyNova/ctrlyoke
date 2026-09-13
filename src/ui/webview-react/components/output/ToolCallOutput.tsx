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
import { TOOL_RESULT_LINE, TOOL_ERROR_LINE } from "./outputStyles";
import { ToolDot } from "./FileOperationOutput";
import { ToolCallBlock } from "./ToolCallBlock";
import { ToolCallExpandToggle } from "./ToolCallExpandToggle";
import type { ToolResult } from "../../types/cliEvents";
import {
  TOOL_CALL_EXPANSION_SECTIONS,
  TOOL_RESULT_STATUSES,
  type ToolResultStatus,
} from "@root/types/DashboardConstants";

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

function resultDotStatus(result?: ToolResult): ToolResultStatus {
  if (!result) return TOOL_RESULT_STATUSES.PENDING;
  return result.success
    ? TOOL_RESULT_STATUSES.SUCCESS
    : TOOL_RESULT_STATUSES.ERROR;
}

// ============================================================================
// McpToolCallOutput
// ============================================================================

interface McpToolCallOutputProps {
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;
  paramsFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
  showLabel?: boolean;
  expansion?: ToolCallExpansionState;
  renderPlan?: ToolCallRenderPlan;
  onExpansionChange?: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  labelContent?: React.ReactNode;
  className?: string;
}

export const McpToolCallOutput: React.FC<McpToolCallOutputProps> = ({
  server,
  tool,
  parameters,
  result,
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
  showLabel = false,
  expansion,
  renderPlan,
  onExpansionChange,
  labelContent,
  className = "",
}) => {
  const [uncontrolledExpansion, setUncontrolledExpansion] =
    useState<ToolCallExpansionState>(() => ({
      ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
    }));
  const containerId = useId();
  const resolvedExpansion = expansion ?? uncontrolledExpansion;
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
          case TOOL_CALL_EXPANSION_SECTIONS.PARAMS:
            return { ...previous, paramsExpanded: expanded };
          case TOOL_CALL_EXPANSION_SECTIONS.OUTPUT:
            return { ...previous, outputExpanded: expanded };
          case TOOL_CALL_EXPANSION_SECTIONS.ERROR:
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
    type: Exclude<
      ToolCallExpansionSection,
      typeof TOOL_CALL_EXPANSION_SECTIONS.PARAMS
    >,
    sectionPlan: ToolCallSectionRenderPlan,
    findMatches?: RowFindDecoration["matches"]
  ) => {
    const cssClass =
      type === TOOL_CALL_EXPANSION_SECTIONS.ERROR
        ? TOOL_ERROR_LINE
        : TOOL_RESULT_LINE;
    const visibleText = getVisibleToolCallText(content, sectionPlan);

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
              className="text-bash-expand-link no-underline text-[length:var(--cy-output-font-size-sm)] ml-1 cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
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
    <ToolCallBlock
      className={className}
      dot={<ToolDot status={resultDotStatus(result)} />}
      header={
        <>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {labelContent ?? `MCP: ${server}.${tool}`}
          </span>
          {resolvedRenderPlan.params.canToggle && (
            <ToolCallExpandToggle
              expanded={resolvedRenderPlan.params.isExpanded}
              onToggle={() =>
                updateExpansion(
                  TOOL_CALL_EXPANSION_SECTIONS.PARAMS,
                  !resolvedRenderPlan.params.isExpanded
                )
              }
              label="Show parameters"
              showLabel={showLabel}
              title={
                resolvedRenderPlan.params.isExpanded
                  ? "Hide parameters"
                  : "Show all parameters"
              }
            />
          )}
        </>
      }
    >
      {resolvedRenderPlan.params.visibleLineCount > 0 && fullParamsText && (
        <div className="text-[length:var(--cy-output-font-size-sm)] text-description-fg whitespace-pre-wrap [overflow-wrap:anywhere]">
          {highlightText(fullParamsText, paramsFindMatches ?? [])}
        </div>
      )}

      {outputStr &&
        renderExpandableSection(
          outputStr,
          TOOL_CALL_EXPANSION_SECTIONS.OUTPUT,
          resolvedRenderPlan.output,
          outputFindMatches
        )}
      {errorStr &&
        renderExpandableSection(
          errorStr,
          TOOL_CALL_EXPANSION_SECTIONS.ERROR,
          resolvedRenderPlan.error,
          errorFindMatches
        )}
    </ToolCallBlock>
  );
};

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
  <ToolCallBlock
    className={className}
    dot={
      <ToolDot
        status={
          success === undefined
            ? TOOL_RESULT_STATUSES.PENDING
            : success
              ? TOOL_RESULT_STATUSES.SUCCESS
              : TOOL_RESULT_STATUSES.ERROR
        }
      />
    }
    header={
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {queryContent ?? <>Web search: &ldquo;{query}&rdquo;</>}
      </span>
    }
  >
    {error && (
      <div className={`${TOOL_ERROR_LINE} flex items-start gap-1`}>
        <span className="shrink-0">⎿</span>
        <div className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {errorContent ?? error}
        </div>
      </div>
    )}
  </ToolCallBlock>
);

// ============================================================================
// GenericToolCallOutput
// ============================================================================

interface GenericToolCallOutputProps {
  name: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;
  nameFindMatches?: RowFindDecoration["matches"];
  paramsFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
  showLabel?: boolean;
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
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
  showLabel = false,
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
  const showCollapsedParamsIndicator =
    !resolvedRenderPlan.params.isExpanded &&
    resolvedRenderPlan.params.canToggle;
  const summaryAlreadySignalsTruncation = params.includes("...");
  const showSummaryEllipsis =
    showCollapsedParamsIndicator && !summaryAlreadySignalsTruncation;

  const updateExpansion = (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => {
    if (expansion === undefined) {
      setUncontrolledExpansion((previous) => {
        switch (section) {
          case TOOL_CALL_EXPANSION_SECTIONS.PARAMS:
            return { ...previous, paramsExpanded: expanded };
          case TOOL_CALL_EXPANSION_SECTIONS.OUTPUT:
            return { ...previous, outputExpanded: expanded };
          case TOOL_CALL_EXPANSION_SECTIONS.ERROR:
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
    type: Exclude<
      ToolCallExpansionSection,
      typeof TOOL_CALL_EXPANSION_SECTIONS.PARAMS
    >,
    sectionPlan: ToolCallSectionRenderPlan,
    findMatches?: RowFindDecoration["matches"]
  ) => {
    const cssClass =
      type === TOOL_CALL_EXPANSION_SECTIONS.ERROR
        ? TOOL_ERROR_LINE
        : TOOL_RESULT_LINE;
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
              className="text-bash-expand-link no-underline text-[length:var(--cy-output-font-size-sm)] ml-1 cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
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
    <ToolCallBlock
      className={className}
      dot={<ToolDot status={resultDotStatus(result)} />}
      header={
        <>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {nameFindMatches?.length ? (
              <>
                {highlightText(name, nameFindMatches)}({params})
                {showSummaryEllipsis && "..."}
              </>
            ) : (
              `${name}(${params})${showSummaryEllipsis ? "..." : ""}`
            )}
          </span>
          {resolvedRenderPlan.params.canToggle && (
            <ToolCallExpandToggle
              expanded={resolvedRenderPlan.params.isExpanded}
              onToggle={() =>
                updateExpansion(
                  TOOL_CALL_EXPANSION_SECTIONS.PARAMS,
                  !resolvedRenderPlan.params.isExpanded
                )
              }
              label="Show parameters"
              showLabel={showLabel}
              title={
                resolvedRenderPlan.params.isExpanded
                  ? "Hide parameters"
                  : "Show all parameters"
              }
            />
          )}
        </>
      }
    >
      {resolvedRenderPlan.params.visibleLineCount > 0 && fullParamsText && (
        <div className="text-[length:var(--cy-output-font-size-sm)] text-description-fg whitespace-pre-wrap [overflow-wrap:anywhere]">
          {highlightText(fullParamsText, paramsFindMatches ?? [])}
        </div>
      )}

      {outputStr &&
        renderExpandableSection(
          outputStr,
          TOOL_CALL_EXPANSION_SECTIONS.OUTPUT,
          resolvedRenderPlan.output,
          outputFindMatches
        )}
      {errorStr &&
        renderExpandableSection(
          errorStr,
          TOOL_CALL_EXPANSION_SECTIONS.ERROR,
          resolvedRenderPlan.error,
          errorFindMatches
        )}
    </ToolCallBlock>
  );
};

// ============================================================================
// ToolCallOutput — Event Router
// ============================================================================
