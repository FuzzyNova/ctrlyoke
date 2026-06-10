import React, { memo, useCallback, useEffect, useState } from "react";
import { calcContextPct } from "@utils/tokenUtils";
import { getHarnessModelDisplayName } from "@root/utils/ModelConstants";
import {
  BashOutput,
  FileDeleteOutput,
  FileEditOutput,
  FileReadOutput,
  FileWriteOutput,
  GenericToolCallOutput,
  MarkdownText,
  McpToolCallOutput,
  StatusMessage,
  WebSearchOutput,
} from ".";
import {
  DEFAULT_BASH_OUTPUT_EXPANSION_STATE,
  type BashOutputExpansionSection,
  type BashOutputExpansionState,
} from "./BashOutput";
import type {
  BashCommandData,
  CliEvent,
  CompactionData,
  FileDeleteData,
  FileEditData,
  FileReadData,
  FileWriteData,
  McpToolCallData,
  TextData,
  ThinkingBlock,
  ToolCall,
  ToolResultData,
  WebSearchData,
} from "../../types/cliEvents";
import { CLI_EVENT_TYPES, HARNESS_INFO } from "../../types/messages";
import {
  formatExecutionBadge,
  formatTime,
  getFirstWords,
} from "@utils/outputUtils";
import {
  getOutputRowSearchSegments,
  getToolResultText,
  highlightText,
  sliceDecorationMatches,
  type OutputFindMatch,
  type RowFindDecoration,
} from "@utils/outputFind";
import { OUTPUT_BLOCK_BASE, TOOL_RESULT_LINE } from "./outputStyles";
import type {
  CliHeaderRow,
  HistoryBannerRow,
  OutputRenderRow,
  StructuredEventRow,
} from "@utils/outputRows";
import {
  getDisplayStructuredPatch,
  getSnapshotBeforeContent,
  isScriptOutput,
} from "@utils/outputRenderUtils";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  GENERIC_TOOL_CALL_MAX_RESULT_CHARS,
  GENERIC_TOOL_CALL_MAX_RESULT_LINES,
  type ToolCallExpansionSection,
} from "@utils/toolCallLayout";
import {
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedOutputPreview,
} from "@utils/outputTruncation";

export interface OutputRowFileUndoRequest {
  path: string;
  eventIndex: number;
  event: CliEvent;
  oldContent?: string;
  newContent?: string;
  structuredPatch?: FileEditData["structuredPatch"];
}

interface StructuredEventContentProps {
  row: StructuredEventRow;
  findDecorations?: RowFindDecoration;
  findQuery?: string;
  findCaseSensitive?: boolean;
  activeFindMatch?: OutputFindMatch | null;
  onFileUndo?: (request: OutputRowFileUndoRequest) => void;
  onDiffCollapsedChange?: (
    rowKey: string,
    diffKey: string,
    collapsed: boolean
  ) => void;
  onDiffGapExpand?: (
    rowKey: string,
    diffKey: string,
    gapIndex: number,
    nextExpandedToLine: number
  ) => void;
  onToolCallExpansionChange?: (
    rowKey: string,
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  bashExpansion?: BashOutputExpansionState;
  onBashExpansionChange?: (
    rowKey: string,
    section: BashOutputExpansionSection,
    expanded: boolean
  ) => void;
}

interface OutputRowProps {
  row: OutputRenderRow;
  findDecorations?: RowFindDecoration;
  findQuery?: string;
  findCaseSensitive?: boolean;
  activeFindMatch?: OutputFindMatch | null;
  isExecutionActive: boolean;
  onBackToLive?: () => void;
  onPromptUndo?: (row: CliHeaderRow) => void;
  onPromptRedo?: (row: CliHeaderRow) => void;
  onFileUndo?: (
    row: StructuredEventRow,
    request: OutputRowFileUndoRequest
  ) => void;
  onDiffCollapsedChange?: (
    rowKey: string,
    diffKey: string,
    collapsed: boolean
  ) => void;
  onDiffGapExpand?: (
    rowKey: string,
    diffKey: string,
    gapIndex: number,
    nextExpandedToLine: number
  ) => void;
  onToolCallExpansionChange?: (
    rowKey: string,
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  bashExpansion?: BashOutputExpansionState;
  onBashExpansionChange?: (
    rowKey: string,
    section: BashOutputExpansionSection,
    expanded: boolean
  ) => void;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
    return true;
  } catch {
    return false;
  }
}

const TextOutput: React.FC<{
  text: string;
  raw?: boolean;
  animated?: boolean;
  content?: React.ReactNode;
  className?: string;
  findQuery?: string;
  findCaseSensitive?: boolean;
  highlightActiveIndex?: number;
}> = ({
  text,
  raw = false,
  animated = false,
  content,
  className = "",
  findQuery,
  findCaseSensitive,
  highlightActiveIndex,
}) => (
  <div className={`${OUTPUT_BLOCK_BASE} border-l-transparent ${className}`}>
    {raw ? (
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {content ?? text}
      </div>
    ) : (
      <MarkdownText
        animated={animated}
        highlightQuery={findQuery}
        highlightCaseSensitive={findCaseSensitive}
        highlightActiveIndex={highlightActiveIndex}
      >
        {text}
      </MarkdownText>
    )}
  </div>
);

const ThinkingOutput: React.FC<{
  text: string;
  label?: string;
  findQuery?: string;
  findCaseSensitive?: boolean;
  highlightActiveIndex?: number;
}> = ({
  text,
  label = "Thinking",
  findQuery,
  findCaseSensitive,
  highlightActiveIndex,
}) => {
  const displayLabel = label && label !== "Thinking" ? label : "Thinking";
  return (
    <div className="my-2">
      <div className="text-[length:var(--fp-output-font-size-xs)] text-description-fg mb-1">
        ● {displayLabel}
      </div>
      <div className="text-description-fg pl-3 border-l border-panel-border">
        <MarkdownText
          highlightQuery={findQuery}
          highlightCaseSensitive={findCaseSensitive}
          highlightActiveIndex={highlightActiveIndex}
        >
          {text}
        </MarkdownText>
      </div>
    </div>
  );
};

const ToolResultOutput: React.FC<{
  result: { success: boolean; output?: string; error?: string };
  content?: React.ReactNode;
}> = ({ result, content }) => {
  let contentText: string;

  if (!result.success && result.error) {
    contentText = result.error.substring(0, 200);
  } else if (result.output) {
    contentText = result.output.substring(0, 100);
  } else {
    contentText = result.success ? "Success" : "Failed";
  }

  return (
    <div
      className={`${result.success ? TOOL_RESULT_LINE : "text-indicator-error pl-4 ml-2 text-[length:var(--fp-output-font-size-sm)]"} flex items-start gap-1`}
    >
      <span className="shrink-0">⎿</span>
      <span className="whitespace-pre-wrap min-w-0 [overflow-wrap:anywhere]">
        {content ?? contentText}
      </span>
    </div>
  );
};

// True when the active find match for a field falls outside the visible
// (collapsed) portion of its text — i.e. it's hidden behind a "[show more]"
// toggle and needs that section auto-expanded to be revealed.
function isActiveMatchHidden(
  text: string,
  matches: RowFindDecoration["matches"],
  expanded: boolean,
  maxLines: number,
  maxChars: number
): boolean {
  if (expanded || !text) return false;
  const active = matches.find((match) => match.active);
  if (!active) return false;
  const preview = buildCollapsedOutputPreview(text, {
    expanded: false,
    maxLines,
    maxChars,
  });
  return active.end > preview.visibleText.length;
}

const StructuredEventContent = memo<StructuredEventContentProps>(
  ({
    row,
    findDecorations,
    findQuery,
    findCaseSensitive,
    activeFindMatch,
    onFileUndo,
    onDiffCollapsedChange,
    onDiffGapExpand,
    onToolCallExpansionChange,
    bashExpansion,
    onBashExpansionChange,
  }) => {
    const searchSegments = getOutputRowSearchSegments(row);
    const getFieldMatches = (field: string, occurrence = 0) => {
      const segment = searchSegments.filter((entry) => entry.field === field)[
        occurrence
      ];
      return segment
        ? sliceDecorationMatches(findDecorations, segment.start, segment.end)
        : [];
    };
    const getActiveMatchIndex = (field: string, occurrence = 0) => {
      const matches = getFieldMatches(field, occurrence);
      const activeIndex = matches.findIndex((match) => match.active);
      return activeIndex;
    };
    const {
      event,
      rawTextOutput,
      eventIndex,
      hideDiff,
      workspaceSnapshot,
      diff,
    } = row;

    const isActiveRow = activeFindMatch?.rowKey === row.key;

    let pendingBashExpand: BashOutputExpansionSection | null = null;
    if (isActiveRow && event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
      const data = event.data as BashCommandData;
      const expansion = bashExpansion ?? DEFAULT_BASH_OUTPUT_EXPANSION_STATE;
      if (
        activeFindMatch?.field === "response" &&
        isActiveMatchHidden(
          data.output ?? "",
          getFieldMatches("response"),
          expansion.outputExpanded,
          DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
          DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS
        )
      ) {
        pendingBashExpand = "output";
      } else if (
        activeFindMatch?.field === "error" &&
        isActiveMatchHidden(
          data.error ?? "",
          getFieldMatches("error"),
          expansion.errorExpanded,
          DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
          DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS
        )
      ) {
        pendingBashExpand = "error";
      }
    }

    let pendingToolCallExpand: ToolCallExpansionSection | null = null;
    if (isActiveRow && event.type === CLI_EVENT_TYPES.TOOL_CALL) {
      const data = event.data as ToolCall;
      const toolContentIsError =
        !data.result?.success && typeof data.result?.error === "string";
      const expansion =
        row.toolCall?.expansion ?? DEFAULT_TOOL_CALL_EXPANSION_STATE;
      const sectionExpanded = toolContentIsError
        ? expansion.errorExpanded
        : expansion.outputExpanded;
      if (
        activeFindMatch?.field === "toolContent" &&
        isActiveMatchHidden(
          getToolResultText(data.result),
          getFieldMatches("toolContent"),
          sectionExpanded,
          GENERIC_TOOL_CALL_MAX_RESULT_LINES,
          GENERIC_TOOL_CALL_MAX_RESULT_CHARS
        )
      ) {
        pendingToolCallExpand = toolContentIsError ? "error" : "output";
      }
    }

    useEffect(() => {
      if (pendingBashExpand) {
        onBashExpansionChange?.(row.key, pendingBashExpand, true);
      }
    }, [pendingBashExpand, row.key, onBashExpansionChange]);

    useEffect(() => {
      if (pendingToolCallExpand) {
        onToolCallExpansionChange?.(row.key, pendingToolCallExpand, true);
      }
    }, [pendingToolCallExpand, row.key, onToolCallExpansionChange]);

    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT: {
        const data = event.data as TextData;
        if (!data.text) return null;
        return (
          <TextOutput
            text={data.text}
            raw={rawTextOutput}
            content={
              rawTextOutput
                ? highlightText(data.text, getFieldMatches("response"))
                : undefined
            }
            findQuery={rawTextOutput ? undefined : findQuery}
            findCaseSensitive={findCaseSensitive}
            highlightActiveIndex={getActiveMatchIndex("response")}
          />
        );
      }
      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingBlock;
        if (!data.text) return null;
        return (
          <ThinkingOutput
            text={data.text}
            label={data.label}
            findQuery={findQuery}
            findCaseSensitive={findCaseSensitive}
            highlightActiveIndex={getActiveMatchIndex("response")}
          />
        );
      }
      case CLI_EVENT_TYPES.BASH_COMMAND: {
        const data = event.data as BashCommandData;
        return (
          <BashOutput
            command={data.command}
            output={data.output}
            error={data.error}
            commandContent={highlightText(
              data.command,
              getFieldMatches("command")
            )}
            outputFindMatches={getFieldMatches("response")}
            errorFindMatches={getFieldMatches("error")}
            exitCode={data.exitCode}
            status={data.status}
            expansion={bashExpansion}
            onExpansionChange={(section, expanded) =>
              onBashExpansionChange?.(row.key, section, expanded)
            }
          />
        );
      }
      case CLI_EVENT_TYPES.FILE_EDIT: {
        const data = event.data as FileEditData;
        if (!data.path) return null;
        const displayStructuredPatch = getDisplayStructuredPatch(
          data.path,
          data.structuredPatch,
          workspaceSnapshot
        );
        const displayOldContent = displayStructuredPatch
          ? getSnapshotBeforeContent(data.path, workspaceSnapshot)
          : (data.oldContent ??
            getSnapshotBeforeContent(data.path, workspaceSnapshot));
        const handleUndo =
          onFileUndo == null
            ? undefined
            : () =>
                onFileUndo({
                  path: data.path,
                  eventIndex,
                  event,
                  oldContent: displayOldContent,
                  newContent: data.newContent,
                  structuredPatch: displayStructuredPatch,
                });
        return (
          <FileEditOutput
            path={data.path}
            pathContent={highlightText(data.path, getFieldMatches("filePath"))}
            status={data.status}
            oldContent={displayOldContent}
            newContent={data.newContent}
            structuredPatch={displayStructuredPatch}
            error={data.error}
            onUndoFile={handleUndo}
            fileUndoMode={
              row.undoRecord != null && row.undoRecord.isRedone !== true
                ? "redo"
                : "undo"
            }
            hideDiff={hideDiff}
            collapsed={diff?.isCollapsed}
            expandedGaps={diff?.expandedGaps}
            viewType={diff?.renderPlan.viewType}
            onCollapsedChange={
              diff
                ? (collapsed) =>
                    onDiffCollapsedChange?.(row.key, diff.key, collapsed)
                : undefined
            }
            onExpandGap={
              diff
                ? (gapIndex, nextExpandedToLine) =>
                    onDiffGapExpand?.(
                      row.key,
                      diff.key,
                      gapIndex,
                      nextExpandedToLine
                    )
                : undefined
            }
          />
        );
      }
      case CLI_EVENT_TYPES.FILE_WRITE: {
        const data = event.data as FileWriteData;
        if (!data.path) return null;
        return (
          <FileWriteOutput
            path={data.path}
            pathContent={highlightText(data.path, getFieldMatches("filePath"))}
            status={data.status}
            content={data.content}
            error={data.error}
            onUndoFile={
              onFileUndo == null
                ? undefined
                : () =>
                    onFileUndo({
                      path: data.path,
                      eventIndex,
                      event,
                    })
            }
            fileUndoMode={
              row.undoRecord != null && row.undoRecord.isRedone !== true
                ? "redo"
                : "undo"
            }
          />
        );
      }
      case CLI_EVENT_TYPES.FILE_READ: {
        const data = event.data as FileReadData;
        if (!data.path) return null;
        return (
          <FileReadOutput
            path={data.path}
            pathContent={highlightText(data.path, getFieldMatches("filePath"))}
            status={data.status}
            error={data.error}
          />
        );
      }
      case CLI_EVENT_TYPES.FILE_DELETE: {
        const data = event.data as FileDeleteData;
        if (!data.path) return null;
        return (
          <FileDeleteOutput
            path={data.path}
            pathContent={highlightText(data.path, getFieldMatches("filePath"))}
            success={data.success}
            error={data.error}
            onUndoFile={
              onFileUndo == null
                ? undefined
                : () =>
                    onFileUndo({
                      path: data.path,
                      eventIndex,
                      event,
                    })
            }
            fileUndoMode={
              row.undoRecord != null && row.undoRecord.isRedone !== true
                ? "redo"
                : "undo"
            }
          />
        );
      }
      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as McpToolCallData;
        if (!data.server || !data.tool) return null;
        return (
          <McpToolCallOutput
            server={data.server}
            tool={data.tool}
            result={data.result}
            labelContent={highlightText(
              `MCP: ${data.server}.${data.tool}`,
              getFieldMatches("toolLabel")
            )}
          />
        );
      }
      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as WebSearchData;
        if (!data.query) return null;
        return (
          <WebSearchOutput
            query={data.query}
            success={data.success}
            error={data.error}
            queryContent={
              <>
                Web search: &ldquo;
                {highlightText(data.query, getFieldMatches("response"))}
                &rdquo;
              </>
            }
            errorContent={
              data.error
                ? highlightText(data.error, getFieldMatches("error"))
                : undefined
            }
          />
        );
      }
      case CLI_EVENT_TYPES.TOOL_CALL: {
        const data = event.data as ToolCall;
        if (!data.name) return null;
        // getOutputRowSearchSegments derives "toolContent" from
        // getToolResultText, which prefers result.error over result.output —
        // mirror that branching so highlights land on whichever text the
        // match offsets were actually computed against.
        const toolContentMatches = getFieldMatches("toolContent");
        const toolContentIsError =
          !data.result?.success && typeof data.result?.error === "string";
        return (
          <GenericToolCallOutput
            name={data.name}
            parameters={data.parameters}
            result={data.result}
            nameFindMatches={getFieldMatches("toolLabel")}
            outputFindMatches={
              toolContentIsError ? undefined : toolContentMatches
            }
            errorFindMatches={
              toolContentIsError ? toolContentMatches : undefined
            }
            expansion={row.toolCall?.expansion}
            renderPlan={row.toolCall?.renderPlan}
            onExpansionChange={(section, expanded) =>
              onToolCallExpansionChange?.(row.key, section, expanded)
            }
          />
        );
      }
      case CLI_EVENT_TYPES.TOOL_RESULT: {
        const data = event.data as ToolResultData;
        if (!data.result) return null;
        return (
          <ToolResultOutput
            result={data.result}
            content={highlightText(
              !data.result.success && data.result.error
                ? data.result.error
                : data.result.output || (data.result.success ? "Success" : "Failed"),
              getFieldMatches("toolContent")
            )}
          />
        );
      }
      case CLI_EVENT_TYPES.COMPACTION: {
        const data = event.data as CompactionData;
        const trigger = data.trigger;
        const tokenInfo =
          data.preTokens != null && data.postTokens != null
            ? ` — ${data.preTokens.toLocaleString()} → ${data.postTokens.toLocaleString()} tokens`
            : data.preTokens != null
              ? ` — ${data.preTokens.toLocaleString()} tokens compacted`
              : "";
        return (
          <div className="my-3 flex items-center gap-2 text-description-fg text-[length:var(--fp-output-font-size-sm)]">
            <div className="flex-1 h-px bg-panel-border" />
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-panel-border bg-editor-bg whitespace-nowrap">
              <i className="codicon codicon-fold text-xxs" />
              <span>
                Conversation compacted ({trigger}){tokenInfo}
              </span>
            </span>
            <div className="flex-1 h-px bg-panel-border" />
          </div>
        );
      }
      default:
        return null;
    }
  }
);

StructuredEventContent.displayName = "StructuredEventContent";

const CliHeaderRowView: React.FC<{
  row: CliHeaderRow;
  isExecutionActive: boolean;
  stepLabelContent?: React.ReactNode;
  stepNameContent?: React.ReactNode;
  onPromptUndo?: (row: CliHeaderRow) => void;
  onPromptRedo?: (row: CliHeaderRow) => void;
}> = ({
  row,
  isExecutionActive,
  stepLabelContent,
  stepNameContent,
  onPromptUndo,
  onPromptRedo,
}) => {
  const { output } = row;
  const timestamp = output.timestampMs ? formatTime(output.timestampMs) : "";
  const executionBadge = formatExecutionBadge(row.runIndex, row.attemptIndex);
  const stepDisplayName =
    row.stepName?.trim() ?? getFirstWords(output.prompt, 4);
  const structuredMetadata = output.structured?.metadata;
  const harnessId = structuredMetadata?.harness;
  const harnessShortName = harnessId
    ? (HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO]?.shortName ??
      harnessId)
    : undefined;
  const modelId = structuredMetadata?.model;
  const modelLabel =
    harnessId && modelId
      ? getHarnessModelDisplayName(harnessId, modelId)
      : modelId;
  const streamingIndicator =
    output.isStreaming && isExecutionActive ? (
      <span className="min-w-0 text-output-streaming font-normal animate-pulse-streaming">
        ⬤ Streaming...
      </span>
    ) : null;

  if (isScriptOutput(output)) {
    return (
      <div className="font-semibold mb-[var(--spacing-sm)] text-[var(--fg-secondary)] pb-[var(--spacing-xs)] border-b border-[var(--border-color)] text-[length:var(--fp-output-font-size-sm)] flex min-w-0 flex-wrap items-start gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]">
        <span className="inline-flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-[2px]">
          {timestamp && <span className="output-timestamp">[{timestamp}]</span>}
          <span className="inline-flex min-w-0 items-center gap-1">
            <span>[</span>
            <i className="codicon codicon-terminal-powershell text-xs" />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {stepLabelContent ?? row.stepLabel}]
            </span>
          </span>
          {(() => {
            const scriptTitle =
              row.stepName?.trim() || getFirstWords(output.cliCommand, 3);
            return scriptTitle ? (
              <span className="ml-1 min-w-0 break-words text-foreground [overflow-wrap:anywhere]">
                {stepNameContent ?? scriptTitle}
              </span>
            ) : null;
          })()}
          {executionBadge && (
            <span className="ml-1 text-description-fg">{executionBadge}</span>
          )}
        </span>
        {streamingIndicator}
      </div>
    );
  }

  return (
    <div className="font-semibold mb-[var(--spacing-sm)] text-[var(--fg-secondary)] pb-[var(--spacing-xs)] border-b border-[var(--border-color)] text-[length:var(--fp-output-font-size-sm)] flex min-w-0 flex-wrap items-start gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]">
      <span className="inline-flex min-w-0 flex-1 items-center flex-wrap gap-x-1 gap-y-[2px]">
        {timestamp && <span className="output-timestamp">[{timestamp}]</span>}
        <span className="inline-flex min-w-0 items-center gap-1">
          <span>[</span>
          <i className="codicon codicon-comment text-xs" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            {stepLabelContent ?? row.stepLabel}]
          </span>
        </span>
        {stepDisplayName && (
          <span className="ml-1 min-w-0 break-words text-foreground [overflow-wrap:anywhere]">
            {stepNameContent ?? stepDisplayName}
          </span>
        )}
        {(harnessShortName || modelLabel) && (
          <span className="min-w-0 break-words text-description-fg font-normal text-[length:var(--fp-output-font-size-xs)] [overflow-wrap:anywhere]">
            {[harnessShortName, modelLabel].filter(Boolean).join(" · ")}
          </span>
        )}
        {executionBadge && (
          <span className="ml-1 text-description-fg">{executionBadge}</span>
        )}
      </span>
      {streamingIndicator}
      {row.promptUndo && (row.promptUndo.undo || row.promptUndo.redo) && (
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1 font-normal">
          {row.promptUndo.undo && (
            <button
              type="button"
              onClick={() => onPromptUndo?.(row)}
              style={{ touchAction: "manipulation" }}
              title={row.promptUndo.undo.label}
              className="inline-flex min-w-0 max-w-full items-center gap-1 text-link-fg hover:text-link-active-fg transition-colors"
            >
              <i className="codicon codicon-discard shrink-0" />
              <span className="min-w-0 truncate">
                {row.promptUndo.undo.label}
              </span>
            </button>
          )}
          {row.promptUndo.redo && (
            <button
              type="button"
              onClick={() => onPromptRedo?.(row)}
              style={{ touchAction: "manipulation" }}
              title={row.promptUndo.redo.label}
              className="inline-flex min-w-0 max-w-full items-center gap-1 text-terminal-ansiGreen hover:opacity-80 transition-opacity"
            >
              <i className="codicon codicon-redo shrink-0" />
              <span className="min-w-0 truncate">
                {row.promptUndo.redo.label}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const StatsRowView: React.FC<{ row: OutputRenderRow }> = ({ row }) => {
  const isStatsRow = row.rowKind === "stats";
  const output = isStatsRow ? row.output : undefined;
  const outputText = isStatsRow ? row.outputText : undefined;
  const structuredMetadata = output?.structured?.metadata;
  const sessionId = structuredMetadata?.sessionId;
  const harnessId = structuredMetadata?.harness;
  const harnessName = harnessId
    ? (HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO]?.name ?? harnessId)
    : undefined;
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const handleCopySessionId = useCallback(async () => {
    if (!sessionId) return;
    const didCopy = await copyTextToClipboard(sessionId);
    if (!didCopy) return;
    setCopiedSessionId(sessionId);
    window.setTimeout(() => {
      setCopiedSessionId((current) => (current === sessionId ? null : current));
    }, 1200);
  }, [sessionId]);

  const handleCopyOutput = useCallback(async () => {
    if (!outputText) return;
    const didCopy = await copyTextToClipboard(outputText);
    if (!didCopy) return;
    setCopiedOutput(true);
    window.setTimeout(() => setCopiedOutput(false), 1200);
  }, [outputText]);

  if (!output) return null;

  const parts: React.ReactNode[] = [];
  if (output.tokens) {
    const {
      prompt,
      completion,
      cached,
      cacheCreated,
      contextWindowUsed,
      contextWindowSize,
    } = output.tokens;
    const total = prompt + completion;
    const tokenDetails: string[] = [
      `Tokens: ${prompt} in / ${completion} out / ${total} total`,
    ];
    if (cached) tokenDetails.push(`${cached} cached`);
    if (cacheCreated) tokenDetails.push(`${cacheCreated} cache-created`);

    const pct = calcContextPct(contextWindowUsed, contextWindowSize);
    if (pct !== undefined) {
      const formatCount = (count: number) =>
        count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
      parts.push(
        <span key="context" title={tokenDetails.join(" | ")}>
          Context: {formatCount(contextWindowUsed!)}/
          {formatCount(contextWindowSize!)} ({pct}%)
        </span>
      );
    } else {
      parts.push(<span key="tokens">{tokenDetails.join(" | ")}</span>);
    }
  }

  if (sessionId) {
    parts.push(
      <span key="session" className="inline-flex items-center gap-1">
        Session{harnessName ? ` (${harnessName})` : ""}: {sessionId}
        <button
          type="button"
          className="icon-btn py-0 px-1"
          onClick={handleCopySessionId}
          title="Copy session ID"
          aria-label="Copy session ID"
        >
          <i
            className={`codicon ${copiedSessionId === sessionId ? "codicon-check" : "codicon-copy"}`}
          />
        </button>
      </span>
    );
  }

  if (!output.isStreaming && output.elapsed !== undefined) {
    parts.push(<span key="elapsed">{output.elapsed}s</span>);
  }

  if (
    isScriptOutput(output) &&
    !output.isStreaming &&
    output.exitCode !== undefined
  ) {
    parts.push(
      <span
        key="exit"
        className={
          output.exitCode === 0
            ? "text-indicator-success"
            : "text-indicator-error"
        }
      >
        Exit code: {output.exitCode}
        {output.exitCode === 0 ? " — Success" : " — Failed"}
      </span>
    );
  }

  if (!output.isStreaming && outputText) {
    parts.push(
      <button
        key="copy-output"
        type="button"
        className={`inline-flex items-center align-middle gap-1 transition-colors ${
          copiedOutput
            ? "text-indicator-success"
            : "text-description-fg hover:text-foreground"
        }`}
        onClick={handleCopyOutput}
        title="Copy output to clipboard"
      >
        <i
          className={`codicon ${copiedOutput ? "codicon-check" : "codicon-copy"}`}
        />
        <span>{copiedOutput ? "Copied" : "Copy output"}</span>
      </button>
    );
  }

  if (parts.length === 0) return null;

  return (
    <div className="mt-[var(--spacing-xs)] text-[length:var(--fp-output-font-size-xs)] text-[var(--fg-secondary)]">
      {parts.map((part, index) => (
        <React.Fragment key={`stats-${index}`}>
          {index > 0 && <span aria-hidden="true"> | </span>}
          {part}
        </React.Fragment>
      ))}
    </div>
  );
};

function HistoryBannerRowView({
  row,
  onBackToLive,
}: {
  row: HistoryBannerRow;
  onBackToLive?: () => void;
}) {
  return (
    <div className="px-3 py-2 text-[length:var(--fp-output-font-size-sm)] text-description-fg bg-editor-bg border-b border-widget-border flex items-center justify-between flex-shrink-0">
      <span>
        Run {row.historyOutputs.runMetadata.runId} &middot;{" "}
        {new Date(row.historyOutputs.runMetadata.startedAt).toLocaleString()}
        {row.historyOutputs.runMetadata.completedAt ? " ✓" : " (incomplete)"}
      </span>
      {row.showBackToLive && onBackToLive && (
        <button
          type="button"
          onClick={onBackToLive}
          className="text-link-fg hover:underline focus:outline-none"
        >
          Back to Live{" "}
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-indicator-success animate-pulse align-middle" />
        </button>
      )}
    </div>
  );
}

function OutputRowComponent({
  row,
  findDecorations,
  findQuery,
  findCaseSensitive,
  activeFindMatch,
  isExecutionActive,
  onBackToLive,
  onPromptUndo,
  onPromptRedo,
  onFileUndo,
  onDiffCollapsedChange,
  onDiffGapExpand,
  onToolCallExpansionChange,
  bashExpansion,
  onBashExpansionChange,
}: OutputRowProps) {
    const rowSearchSegments = getOutputRowSearchSegments(row);
    const getFieldMatches = (field: string, occurrence = 0) => {
      const segment = rowSearchSegments.filter((entry) => entry.field === field)[
        occurrence
      ];
      return segment
        ? sliceDecorationMatches(findDecorations, segment.start, segment.end)
        : [];
    };
    const isActiveRow = activeFindMatch?.rowKey === row.key;
    let content: React.ReactNode;
    switch (row.rowKind) {
      case "history-banner":
        content = (
          <HistoryBannerRowView row={row} onBackToLive={onBackToLive} />
        );
        break;
      case "step-anchor":
        content = <div className="h-px" aria-hidden="true" />;
        break;
      case "final-step-label":
        content = (
          <div className="px-3 pt-2 text-[length:var(--fp-output-font-size-xs)] uppercase tracking-wide text-description-fg">
            {row.label}
          </div>
        );
        break;
      case "status":
        content = (
          <StatusMessage
            message={highlightText(row.status.message, getFieldMatches("status"))}
            severity={row.status.severity}
            timestamp={row.status.timestamp}
            timestampMs={row.status.timestampMs}
          />
        );
        break;
      case "cli-header":
        content = (
          <CliHeaderRowView
            row={row}
            isExecutionActive={isExecutionActive}
            stepLabelContent={highlightText(
              row.stepLabel,
              getFieldMatches("header", 0)
            )}
            stepNameContent={
              row.stepName
                ? highlightText(row.stepName, getFieldMatches("header", 1))
                : undefined
            }
            onPromptUndo={onPromptUndo}
            onPromptRedo={onPromptRedo}
          />
        );
        break;
      case "prompt":
        content = (
          <div
            className={`${OUTPUT_BLOCK_BASE} border-l-output-prompt-border text-[var(--fg-primary)]`}
          >
            {highlightText(row.text, getFieldMatches("prompt"))}
          </div>
        );
        break;
      case "cli-command":
        content = (
          <div
            className={`${OUTPUT_BLOCK_BASE} border-l-output-command-border text-[var(--fg-primary)] whitespace-pre-wrap [overflow-wrap:anywhere]`}
          >
            {highlightText(
              `${row.workingDirectory || "workspace"}> ${row.command}`,
              getFieldMatches("command")
            )}
          </div>
        );
        break;
      case "error":
        content = (
          <div
            className={`${OUTPUT_BLOCK_BASE} border-l-severity-error text-error-fg`}
          >
            {row.timestamp && (
              <span className="opacity-70">[{row.timestamp}] </span>
            )}
            Error: {highlightText(row.errorMessage, getFieldMatches("error"))}
          </div>
        );
        break;
      case "plain-response": {
        const responseMatches = getFieldMatches("response");
        content = (
          <TextOutput
            text={row.text}
            raw={row.rawTextOutput}
            animated={row.animated}
            content={
              row.rawTextOutput
                ? highlightText(row.text, responseMatches)
                : undefined
            }
            findQuery={row.rawTextOutput ? undefined : findQuery}
            findCaseSensitive={findCaseSensitive}
            highlightActiveIndex={responseMatches.findIndex(
              (match) => match.active
            )}
          />
        );
        break;
      }
      case "structured-event":
        content = (
          <StructuredEventContent
            row={row}
            findDecorations={findDecorations}
            findQuery={findQuery}
            findCaseSensitive={findCaseSensitive}
            activeFindMatch={activeFindMatch}
            onFileUndo={
              onFileUndo ? (request) => onFileUndo(row, request) : undefined
            }
            onDiffCollapsedChange={onDiffCollapsedChange}
            onDiffGapExpand={onDiffGapExpand}
            onToolCallExpansionChange={onToolCallExpansionChange}
            bashExpansion={bashExpansion}
            onBashExpansionChange={onBashExpansionChange}
          />
        );
        if (row.diff) {
          content = (
            <div id={row.diff.key} data-diff-anchor="true">
              {content}
            </div>
          );
        }
        break;
      case "stats":
        content = <StatsRowView row={row} />;
        break;
    }

    const isCliGroupRow =
      row.rowKind === "cli-header" ||
      row.rowKind === "prompt" ||
      row.rowKind === "cli-command" ||
      row.rowKind === "error" ||
      row.rowKind === "plain-response" ||
      row.rowKind === "structured-event" ||
      row.rowKind === "stats";

    if (!isCliGroupRow) {
      if (!isActiveRow) {
        return <>{content}</>;
      }
      return <div className="rounded-sm ring-1 ring-focus-border">{content}</div>;
    }

    return (
      <div
        className={[
          "bg-[var(--bg-primary)] px-[var(--spacing-md)] overflow-x-hidden",
          isActiveRow ? "rounded-sm ring-1 ring-focus-border" : "",
          row.groupStart ? "pt-[var(--spacing-sm)]" : "",
          row.groupEnd
            ? "pb-[var(--spacing-sm)] border-b border-[var(--border-color)]"
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {content}
      </div>
    );
}

export const OutputRow = memo(OutputRowComponent);

OutputRow.displayName = "OutputRow";
