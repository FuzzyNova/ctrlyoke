import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { calcContextPct } from "@utils/tokenUtils";
import { getHarnessModelDisplayName } from "@root/utils/ModelConstants";
import {
  formatTokenBreakdown,
  formatTokenCount,
  resolveTokenTotal,
} from "@root/utils/TokenFormatting";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
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
import { ScriptVerdict } from "./ScriptVerdict";
import type {
  BashCommandData,
  CliEvent,
  CompactionData,
  FileDeleteData,
  FileEditData,
  FileReadData,
  FileWriteData,
  FollowUpResumedData,
  McpToolCallData,
  TextData,
  ThinkingBlock,
  ToolCall,
  ToolResultData,
  UserSteerData,
  WebSearchData,
} from "../../types/cliEvents";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  HARNESS_INFO,
  SCRIPT_OUTPUT_SOURCES,
} from "../../types/messages";
import {
  formatExecutionBadge,
  formatTime,
  getFirstWords,
  isUserStoppedMessage,
} from "@utils/outputUtils";
import {
  getOutputRowSearchSegments,
  getToolResultText,
  highlightText,
  sliceDecorationMatches,
  type OutputFindMatch,
  type RowFindDecoration,
} from "@utils/outputFind";
import {
  OUTPUT_BLOCK_BASE,
  TOOL_RESULT_LINE,
  TOOL_RESULT_STANDALONE_INDENT,
} from "./outputStyles";
import { AtomicReferenceChip } from "./AtomicReferenceChip";
import {
  createAtomicReferencePresentation,
  findAtomicReferences,
  type AtomicReferenceChip as AtomicReferenceDescriptor,
  type ContextReferenceMatch,
} from "@utils/atomicReferences";
import { openContextReference } from "@utils/contextReferenceActions";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { formatCliCommandDisplay } from "@utils/outputCommandDisplay";
import type {
  CliHeaderRow,
  HistoryBannerRow,
  OutputRenderRow,
  ScriptOutputRow,
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
  type ToolCallExpansionSection,
} from "@utils/toolCallLayout";
import {
  DEFAULT_COLLAPSED_COMMAND_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedOutputPreview,
  formatScriptOutputTailToggleLabel,
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
  atomicContextReferences?: boolean;
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
  atomicContextReferences?: boolean;
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
  onScriptVerdictExpansionChange?: (rowKey: string, expanded: boolean) => void;
  onScriptOutputExpansionChange?: (
    rowKey: string,
    toggleKey: string,
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
  findDecorations?: RowFindDecoration;
  atomicContextReferences?: boolean;
}> = ({
  text,
  raw = false,
  animated = false,
  content,
  className = "",
  findQuery,
  findCaseSensitive,
  highlightActiveIndex,
  findDecorations,
  atomicContextReferences = false,
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
        findDecorations={findDecorations}
        atomicContextReferences={atomicContextReferences}
      >
        {text}
      </MarkdownText>
    )}
  </div>
);

/**
 * One slice of a script's output.
 *
 * Deliberately does not reuse `OUTPUT_BLOCK_BASE`: that class carries the
 * block's vertical padding and margin, which every slice would then repeat,
 * gapping the output every `SCRIPT_OUTPUT_LINES_PER_ROW` lines. Charging that
 * chrome only to the outer slices makes a run of them render as the single
 * uninterrupted block it represents — and matches how
 * `estimateScriptOutputHeight` splits the same allowance.
 */
const ScriptOutputSegment: React.FC<{
  row: ScriptOutputRow;
  content: React.ReactNode;
  onTailToggle?: (expanded: boolean) => void;
}> = ({ row, content, onTailToggle }) => (
  <div
    className={[
      "px-[var(--spacing-sm)] border-l-[3px] border-l-transparent",
      "whitespace-pre-wrap [overflow-wrap:anywhere] font-mono",
      "text-[length:var(--fp-output-font-size-sm)] bg-transparent",
      row.isFirstSegment ? "pt-[var(--spacing-sm)] mt-[var(--spacing-sm)]" : "",
      row.isLastSegment ? "pb-[var(--spacing-sm)] mb-[var(--spacing-sm)]" : "",
    ]
      .filter(Boolean)
      .join(" ")}
  >
    {content}
    {row.tailToggle && (
      <div>
        <button
          type="button"
          className="text-bash-expand-link no-underline text-[length:var(--fp-output-font-size-sm)] cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
          onClick={(event) => {
            event.preventDefault();
            onTailToggle?.(!row.tailToggle?.expanded);
          }}
        >
          {formatScriptOutputTailToggleLabel(
            row.tailToggle.hiddenLineCount,
            row.tailToggle.expanded
          )}
        </button>
      </div>
    )}
  </div>
);

const ThinkingOutput: React.FC<{
  text: string;
  label?: string;
  findQuery?: string;
  findCaseSensitive?: boolean;
  highlightActiveIndex?: number;
  findDecorations?: RowFindDecoration;
  atomicContextReferences?: boolean;
}> = ({
  text,
  label = "Thinking",
  findQuery,
  findCaseSensitive,
  highlightActiveIndex,
  findDecorations,
  atomicContextReferences = false,
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
          findDecorations={findDecorations}
          atomicContextReferences={atomicContextReferences}
        >
          {text}
        </MarkdownText>
      </div>
    </div>
  );
};

const UserSteerOutput: React.FC<{
  text: string;
  findQuery?: string;
  findCaseSensitive?: boolean;
  highlightActiveIndex?: number;
  findDecorations?: RowFindDecoration;
  atomicContextReferences?: boolean;
}> = ({
  text,
  findQuery,
  findCaseSensitive,
  highlightActiveIndex,
  findDecorations,
  atomicContextReferences = false,
}) => (
  <div className="my-2">
    <div className="text-[length:var(--fp-output-font-size-xs)] text-indicator-info mb-1">
      ● User message
    </div>
    <div className="text-editor-fg pl-3 border-l border-indicator-info/50 whitespace-pre-wrap [overflow-wrap:anywhere]">
      <MarkdownText
        highlightQuery={findQuery}
        highlightCaseSensitive={findCaseSensitive}
        highlightActiveIndex={highlightActiveIndex}
        findDecorations={findDecorations}
        atomicContextReferences={atomicContextReferences}
      >
        {text}
      </MarkdownText>
    </div>
  </div>
);

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
      className={`${result.success ? TOOL_RESULT_LINE : "text-indicator-error text-[length:var(--fp-output-font-size-sm)]"} ${TOOL_RESULT_STANDALONE_INDENT} flex items-start gap-1`}
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
    atomicContextReferences = false,
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
    const collapsedToolOutputLineCount =
      row.collapsedToolOutputLineCount ?? DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;

    let pendingBashExpand: BashOutputExpansionSection | null = null;
    if (isActiveRow && event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
      const data = event.data as BashCommandData;
      const expansion = bashExpansion ?? DEFAULT_BASH_OUTPUT_EXPANSION_STATE;
      const renderedCommand =
        sanitizeTerminalOutput(data.command ?? "")
          .trim()
          .replace(/\s*\n+\s*/g, " ") || "command unavailable";
      if (
        activeFindMatch?.field === "command" &&
        isActiveMatchHidden(
          renderedCommand,
          getFieldMatches("command"),
          expansion.commandExpanded,
          1,
          DEFAULT_COLLAPSED_COMMAND_MAX_CHARS
        )
      ) {
        pendingBashExpand = "command";
      } else if (
        activeFindMatch?.field === "response" &&
        isActiveMatchHidden(
          data.output ?? "",
          getFieldMatches("response"),
          expansion.outputExpanded,
          collapsedToolOutputLineCount,
          row.collapsedToolOutputMaxCharacters ??
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
          collapsedToolOutputLineCount,
          row.collapsedToolOutputMaxCharacters ??
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
          collapsedToolOutputLineCount,
          row.toolCall?.renderPlan.maxResultChars ??
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
            findDecorations={{ matches: getFieldMatches("response") }}
            atomicContextReferences={atomicContextReferences}
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
            findDecorations={{ matches: getFieldMatches("response") }}
            atomicContextReferences={atomicContextReferences}
          />
        );
      }
      case CLI_EVENT_TYPES.USER_STEER: {
        const data = event.data as UserSteerData;
        if (!data.text) return null;
        return (
          <UserSteerOutput
            text={data.text}
            findQuery={findQuery}
            findCaseSensitive={findCaseSensitive}
            highlightActiveIndex={getActiveMatchIndex("response")}
            findDecorations={{ matches: getFieldMatches("response") }}
            atomicContextReferences={atomicContextReferences}
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
            commandFindMatches={getFieldMatches("command")}
            outputFindMatches={getFieldMatches("response")}
            errorFindMatches={getFieldMatches("error")}
            exitCode={data.exitCode}
            status={data.status}
            maxLines={row.collapsedToolOutputLineCount}
            maxCharacters={row.collapsedToolOutputMaxCharacters}
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
            atomicContextReferences={atomicContextReferences}
            filePathFindMatches={getFieldMatches("filePath")}
            status={data.status}
            oldContent={displayOldContent}
            newContent={data.newContent}
            structuredPatch={displayStructuredPatch}
            error={data.error}
            findQuery={findQuery}
            findCaseSensitive={findCaseSensitive}
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
            atomicContextReferences={atomicContextReferences}
            filePathFindMatches={getFieldMatches("filePath")}
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
            atomicContextReferences={atomicContextReferences}
            filePathFindMatches={getFieldMatches("filePath")}
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
            atomicContextReferences={atomicContextReferences}
            filePathFindMatches={getFieldMatches("filePath")}
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
                : data.result.output ||
                    (data.result.success ? "Success" : "Failed"),
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
      case CLI_EVENT_TYPES.FOLLOW_UP_RESUMED: {
        const data = event.data as FollowUpResumedData;
        const resumedAtLabel = data.resumedAt ? formatTime(data.resumedAt) : "";
        return (
          <div className="my-3 flex items-center gap-2 text-description-fg text-[length:var(--fp-output-font-size-sm)]">
            <div className="flex-1 h-px bg-panel-border" />
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-panel-border bg-editor-bg whitespace-nowrap">
              <i className="codicon codicon-debug-continue text-xxs" />
              <span>
                Follow-up{resumedAtLabel ? ` — ${resumedAtLabel}` : ""}
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
    const isConditionOutput =
      output.source !== SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP;
    const conditionLabel =
      output.source === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
        ? "Pre-condition"
        : output.source === SCRIPT_OUTPUT_SOURCES.END_CONDITION
          ? `End condition${row.attemptIndex > 0 ? ` retry ${row.attemptIndex + 1}` : ""}`
          : undefined;
    const headerLabel = isConditionOutput
      ? conditionLabel
      : (stepLabelContent ?? row.stepLabel);
    const headerIcon =
      output.source === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
        ? "codicon-shield"
        : "codicon-checklist";
    return (
      <div className="font-semibold mb-[var(--spacing-sm)] text-[var(--fg-secondary)] pb-[var(--spacing-xs)] border-b border-[var(--border-color)] text-[length:var(--fp-output-font-size-sm)] flex min-w-0 flex-wrap items-start gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]">
        <span className="inline-flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-[2px]">
          {timestamp && <span className="output-timestamp">[{timestamp}]</span>}
          <span className="inline-flex min-w-0 items-center gap-1">
            <span>[</span>
            <i
              className={`codicon ${isConditionOutput ? headerIcon : "codicon-terminal-powershell"} text-xs`}
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {headerLabel}]
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
      total: reportedTotal,
      compactionCount,
    } = output.tokens;
    const total = resolveTokenTotal(reportedTotal, prompt, completion);
    const totalLabel = formatTokenCount(total);
    const tokenBreakdown = formatTokenBreakdown({
      input: prompt,
      output: completion,
      total: reportedTotal,
      cached,
      cacheCreated,
    });

    const pct = calcContextPct(contextWindowUsed, contextWindowSize);
    const contextDetails =
      pct !== undefined
        ? `${formatTokenCount(contextWindowUsed)}/${formatTokenCount(contextWindowSize)} (${pct}%)`
        : undefined;
    const contextLabel =
      contextDetails !== undefined ? `Context: ${contextDetails}` : undefined;
    const compactionLabel =
      compactionCount !== undefined && compactionCount > 0
        ? `Compacted ${compactionCount}x`
        : undefined;
    const tokenTooltip = [
      contextDetails ? `Current context window: ${contextDetails}` : null,
      totalLabel ? `Attempt total: ${totalLabel} tokens` : null,
      tokenBreakdown || null,
      compactionLabel ? `Compactions: ${compactionCount}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join("\n");

    if (pct !== undefined) {
      parts.push(
        <span key="context" title={tokenTooltip}>
          {contextLabel}
        </span>
      );
      if (totalLabel) {
        parts.push(
          <span key="total" title={tokenTooltip}>
            Total: {totalLabel}
          </span>
        );
      }
    } else {
      if (tokenBreakdown) {
        parts.push(
          <span key="tokens" title={tokenTooltip}>
            {tokenBreakdown}
          </span>
        );
      } else if (totalLabel) {
        parts.push(
          <span key="total" title={tokenTooltip}>
            Total: {totalLabel}
          </span>
        );
      }
    }
    if (compactionLabel) {
      parts.push(
        <span key="compacted" title={tokenTooltip}>
          {compactionLabel}
        </span>
      );
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

/**
 * Trailing marker on the history banner. A run that was seeded but never
 * executed is a real, reachable state — `Set start position` on the first step
 * forks a run and leaves it idle — and it has no output because it never ran,
 * not because it was cut off. Calling that "(incomplete)" reads as an
 * interrupted run, so it gets its own wording; the manifest of such a run never
 * leaves IDLE (see `WorkingFileManager.seedNewRun`).
 */
function historyRunStatusMarker(
  runMetadata: HistoryBannerRow["historyOutputs"]["runMetadata"]
): string {
  if (runMetadata.completedAt) return " ✓";
  return runMetadata.executionState === EXECUTION_STATES.IDLE
    ? " (not started)"
    : " (incomplete)";
}

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
        {historyRunStatusMarker(row.historyOutputs.runMetadata)}
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

/** Human-readable tooltip for a decorated prompt reference. */
function promptReferenceTooltip(ref: ContextReferenceMatch): string {
  switch (ref.type) {
    case "git":
      return `Open git ${ref.gitRef ?? ""}`;
    case "directory":
      return `Reveal ${ref.path ?? ""}`;
    case "lineRange":
      return `Open ${ref.path ?? ""}:${ref.lineStart}-${ref.lineEnd}`;
    case "symbol":
      return `Go to ${ref.symbolName ?? ""} in ${ref.path ?? ""}:${ref.lineStart}-${ref.lineEnd}`;
    case "priorContext":
      return `Open ${ref.ref ?? "context"}`;
    default:
      return `Open ${ref.path ?? ""}`;
  }
}

/**
 * Renders an echoed prompt as plain, selectable text (kept verbatim so it stays
 * easy to copy) while turning ctrlyoke context references into clickable links
 * that open exactly like the prompt editor's — symbol/selection reveal their
 * range, directories reveal, files open (images open in VS Code / the workspace
 * viewer), and git refs open the commit view. Reuses findContextReferenceMatches
 * + openContextReference so the behavior stays single-sourced with
 * CodeMirrorEditor. Deliberately NOT Markdown: the prompt uses ctrlyoke's own
 * reference syntax, which Markdown would mangle.
 */
const PromptReferenceText: React.FC<{
  text: string;
  matches: RowFindDecoration["matches"];
  atomicContextReferences: boolean;
}> = ({ text, matches, atomicContextReferences }) => {
  const vscode = getVsCodeApi();
  // Skip references inside ``` fenced blocks — they aren't expanded when the
  // prompt runs, so CodeMirror doesn't decorate them either; match that here.
  // One pass, one array: each entry pairs the chip descriptor with the
  // ContextReferenceMatch that drives the plain-text (setting off) path, so the
  // two presentations can never disagree about which token is at which offset.
  const refs = useMemo(
    () =>
      findAtomicReferences(text).map((descriptor) => ({
        descriptor,
        match: {
          from: descriptor.from,
          to: descriptor.to,
          type: descriptor.attrs["data-type"] as ContextReferenceMatch["type"],
          path: descriptor.attrs["data-path"],
          gitRef: descriptor.attrs["data-git-ref"],
          lineStart: descriptor.attrs["data-line-start"],
          lineEnd: descriptor.attrs["data-line-end"],
          symbolName: descriptor.attrs["data-symbol-name"],
          ref: descriptor.attrs["data-ref"],
        } satisfies ContextReferenceMatch,
      })),
    [text]
  );

  // Rebase the row-relative find matches onto a [start,end) sub-slice so find
  // highlighting still lands correctly inside both plain text and link spans.
  const sliceMatches = (start: number, end: number) =>
    matches
      .filter((match) => match.start < end && match.end > start)
      .map((match) => ({
        start: Math.max(0, match.start - start),
        end: Math.min(end, match.end) - start,
        active: match.active,
      }));

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const { descriptor, match: ref } of refs) {
    // References are sorted and non-overlapping; skip any that would run
    // backwards so a stray match can't corrupt the slicing.
    if (ref.from < cursor) continue;
    if (ref.from > cursor) {
      nodes.push(
        <React.Fragment key={`text-${cursor}`}>
          {highlightText(
            text.slice(cursor, ref.from),
            sliceMatches(cursor, ref.from)
          )}
        </React.Fragment>
      );
    }
    if (atomicContextReferences) {
      nodes.push(
        <AtomicPromptReference
          key={`ref-${ref.from}`}
          descriptor={descriptor}
          text={text.slice(ref.from, ref.to)}
          matches={matches}
          vscode={vscode}
        />
      );
    } else {
      nodes.push(
        <span
          key={`ref-${ref.from}`}
          role="link"
          tabIndex={0}
          className="cursor-pointer text-link-fg hover:text-link-active-fg hover:underline"
          title={promptReferenceTooltip(ref)}
          onClick={() => openContextReference(ref, vscode)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openContextReference(ref, vscode);
            }
          }}
        >
          {highlightText(
            text.slice(ref.from, ref.to),
            sliceMatches(ref.from, ref.to)
          )}
        </span>
      );
    }
    cursor = ref.to;
  }
  if (cursor < text.length) {
    nodes.push(
      <React.Fragment key="text-tail">
        {highlightText(text.slice(cursor), sliceMatches(cursor, text.length))}
      </React.Fragment>
    );
  }

  return (
    <div
      className={`${OUTPUT_BLOCK_BASE} border-l-output-prompt-border text-[var(--fg-primary)]`}
    >
      {nodes}
    </div>
  );
};

const AtomicPromptReference: React.FC<{
  descriptor: AtomicReferenceDescriptor;
  text: string;
  matches: RowFindDecoration["matches"];
  vscode: ReturnType<typeof getVsCodeApi>;
}> = ({ descriptor, text, matches, vscode }) => (
  <AtomicReferenceChip
    descriptor={descriptor}
    presentation={createAtomicReferencePresentation(descriptor, text)}
    findMatches={matches}
    onOpen={() =>
      openContextReference(
        {
          type: descriptor.attrs["data-type"],
          path: descriptor.attrs["data-path"],
          gitRef: descriptor.attrs["data-git-ref"],
          lineStart: descriptor.attrs["data-line-start"],
          lineEnd: descriptor.attrs["data-line-end"],
          ref: descriptor.attrs["data-ref"],
        },
        vscode
      )
    }
  />
);

function OutputRowComponent({
  row,
  findDecorations,
  findQuery,
  findCaseSensitive,
  atomicContextReferences = false,
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
  onScriptVerdictExpansionChange,
  onScriptOutputExpansionChange,
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
      content = <HistoryBannerRowView row={row} onBackToLive={onBackToLive} />;
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
        <PromptReferenceText
          text={row.text}
          matches={getFieldMatches("prompt")}
          atomicContextReferences={atomicContextReferences}
        />
      );
      break;
    case "cli-command":
      content = (
        <div
          className={`${OUTPUT_BLOCK_BASE} border-l-output-command-border text-[var(--fg-primary)] whitespace-pre-wrap [overflow-wrap:anywhere]`}
        >
          {highlightText(
            formatCliCommandDisplay(
              row.command,
              row.workingDirectory,
              row.wasInjected
            ),
            getFieldMatches("command")
          )}
        </div>
      );
      break;
    case "error": {
      const isWarning = isUserStoppedMessage(row.errorMessage);
      const borderClass = isWarning
        ? "border-l-severity-warning text-warning-fg"
        : "border-l-severity-error text-error-fg";
      const label = isWarning ? "Warning" : "Error";
      content = (
        <div className={`${OUTPUT_BLOCK_BASE} ${borderClass}`}>
          {row.timestamp && (
            <span className="opacity-70">[{row.timestamp}] </span>
          )}
          {label}: {highlightText(row.errorMessage, getFieldMatches("error"))}
        </div>
      );
      break;
    }
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
          findDecorations={{ matches: responseMatches }}
          atomicContextReferences={atomicContextReferences}
        />
      );
      break;
    }
    case "script-output": {
      const tailToggle = row.tailToggle;
      content = (
        <ScriptOutputSegment
          row={row}
          content={highlightText(row.text, getFieldMatches("response"))}
          onTailToggle={
            tailToggle
              ? (expanded) =>
                  onScriptOutputExpansionChange?.(
                    row.key,
                    tailToggle.key,
                    expanded
                  )
              : undefined
          }
        />
      );
      break;
    }
    case "structured-event":
      content = (
        <StructuredEventContent
          row={row}
          atomicContextReferences={atomicContextReferences}
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
    case "script-verdict":
      content = (
        <ScriptVerdict
          verdict={row.verdict}
          expanded={row.expanded}
          expectedFindMatches={getFieldMatches("expected")}
          actualFindMatches={getFieldMatches("actual")}
          actionFindMatches={getFieldMatches("action")}
          onExpansionChange={(expanded) =>
            onScriptVerdictExpansionChange?.(row.key, expanded)
          }
        />
      );
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
    row.rowKind === "script-output" ||
    row.rowKind === "structured-event" ||
    row.rowKind === "script-verdict" ||
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
