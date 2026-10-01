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
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  buildToolCallRenderPlan,
  getGenericToolCallOutput,
  getGenericToolCallParamsText,
  getVisibleToolCallText,
  withToolCallSectionExpansion,
  type ToolCallExpansionSection,
  type ToolCallExpansionState,
  type ToolCallRenderPlan,
  type ToolCallSectionRenderPlan,
} from "@utils/toolCallLayout";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";
import { TOOL_ERROR_LINE } from "./outputStyles";
import { CollapsibleOutputSection } from "./CollapsibleOutputSection";
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

// ── Shared expansion + result sections ──────────────────────────────────────

/**
 * Expansion state for a tool call that may be controlled by the output pane
 * (`expansion` given) or self-managed (standalone renders).
 */
function useToolCallExpansion(
  expansion: ToolCallExpansionState | undefined,
  onExpansionChange:
    ((section: ToolCallExpansionSection, expanded: boolean) => void) | undefined
): [
  ToolCallExpansionState,
  (section: ToolCallExpansionSection, expanded: boolean) => void,
] {
  const [uncontrolledExpansion, setUncontrolledExpansion] =
    useState<ToolCallExpansionState>(() => ({
      ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
    }));
  const updateExpansion = (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => {
    if (expansion === undefined) {
      setUncontrolledExpansion((previous) =>
        withToolCallSectionExpansion(previous, section, expanded)
      );
    }
    onExpansionChange?.(section, expanded);
  };
  return [expansion ?? uncontrolledExpansion, updateExpansion];
}

type ToolResultSectionType =
  | typeof TOOL_CALL_EXPANSION_SECTIONS.OUTPUT
  | typeof TOOL_CALL_EXPANSION_SECTIONS.ERROR;

function renderToolResultSection(
  containerId: string,
  content: string,
  type: ToolResultSectionType,
  sectionPlan: ToolCallSectionRenderPlan,
  findMatches: RowFindDecoration["matches"] | undefined,
  updateExpansion: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void
): React.ReactNode {
  const isError = type === TOOL_CALL_EXPANSION_SECTIONS.ERROR;
  return (
    <CollapsibleOutputSection
      section={type}
      contentId={`${containerId}-${type}`}
      isError={isError}
      noun={isError ? "error" : "output"}
      visibleText={getVisibleToolCallText(content, sectionPlan)}
      findMatches={findMatches}
      canToggle={sectionPlan.canToggle}
      isExpanded={sectionPlan.isExpanded}
      isTruncated={sectionPlan.isTruncated}
      hiddenLineCount={sectionPlan.hiddenLineCount}
      onToggle={(expanded) => updateExpansion(type, expanded)}
    />
  );
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
  const [resolvedExpansion, updateExpansion] = useToolCallExpansion(
    expansion,
    onExpansionChange
  );
  const containerId = useId();
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
        renderToolResultSection(
          containerId,
          outputStr,
          TOOL_CALL_EXPANSION_SECTIONS.OUTPUT,
          resolvedRenderPlan.output,
          outputFindMatches,
          updateExpansion
        )}
      {errorStr &&
        renderToolResultSection(
          containerId,
          errorStr,
          TOOL_CALL_EXPANSION_SECTIONS.ERROR,
          resolvedRenderPlan.error,
          errorFindMatches,
          updateExpansion
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
  const [resolvedExpansion, updateExpansion] = useToolCallExpansion(
    expansion,
    onExpansionChange
  );
  const containerId = useId();

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
        renderToolResultSection(
          containerId,
          outputStr,
          TOOL_CALL_EXPANSION_SECTIONS.OUTPUT,
          resolvedRenderPlan.output,
          outputFindMatches,
          updateExpansion
        )}
      {errorStr &&
        renderToolResultSection(
          containerId,
          errorStr,
          TOOL_CALL_EXPANSION_SECTIONS.ERROR,
          resolvedRenderPlan.error,
          errorFindMatches,
          updateExpansion
        )}
    </ToolCallBlock>
  );
};

// ============================================================================
// ToolCallOutput — Event Router
// ============================================================================
