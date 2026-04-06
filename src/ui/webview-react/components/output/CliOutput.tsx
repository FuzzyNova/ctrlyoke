import React, { useCallback, useMemo, useState, memo } from "react";
import { formatTime } from "@utils/outputUtils";
import { calcContextPct } from "@utils/tokenUtils";
import { BashOutput } from "./BashOutput";
import { MarkdownText } from "./MarkdownText";
import {
  FileEditOutput,
  FileWriteOutput,
  FileReadOutput,
  FileDeleteOutput,
  McpToolCallOutput,
  WebSearchOutput,
  GenericToolCallOutput,
} from "./ToolCallOutput";
import { OUTPUT_BLOCK_BASE, TOOL_RESULT_LINE } from "./outputStyles";
import { WebviewLog } from "../../utils/logger";
import { useWorkflowStore } from "@store/workflowStore";
import {
  buildUndoDialogInputForSpecificEvent,
  buildUndoDialogInputForPrompt,
  computePromptUndoActions,
  sameFilePath,
  type UndoDialogInput,
} from "../../utils/promptUndo";
import type { UndoFileInstruction } from "../../types/messages";
import { UndoChangesDialog } from "./UndoChangesDialog";
import type {
  CliOutput as CliOutputType,
  CliEvent,
  BashCommandData,
  TextData,
  ThinkingBlock,
  FileEditData,
  FileWriteData,
  FileReadData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ToolCall,
  ToolResultData,
} from "../../types/cliEvents";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../../types/cliEvents";
import { HARNESS_INFO, FINAL_STEP_PHASES } from "../../types/messages";
import type {
  UndoExecutionTarget,
  WorkspaceSnapshot,
  UndoRecord,
} from "@root/types/OutputHistoryTypes";

// ============================================================================
// Text Output Component
// ============================================================================

interface TextOutputProps {
  text: string;
  /** When true, render as pre-formatted plain text instead of through the markdown pipeline */
  raw?: boolean;
  className?: string;
}

const TextOutput: React.FC<TextOutputProps> = ({
  text,
  raw = false,
  className = "",
}) => {
  return (
    <div className={`my-2 ${className}`}>
      {raw ? (
        <div className="whitespace-pre-wrap">{text}</div>
      ) : (
        <MarkdownText>{text}</MarkdownText>
      )}
    </div>
  );
};

// ============================================================================
// Thinking Output Component
// ============================================================================

interface ThinkingOutputProps {
  text: string;
  label?: string;
  className?: string;
}

const ThinkingOutput: React.FC<ThinkingOutputProps> = ({
  text,
  label = "Thinking",
  className = "",
}) => {
  const displayLabel = label && label !== "Thinking" ? label : "Thinking";
  return (
    <div className={`my-2 ${className}`}>
      <div className="text-xs text-description-fg mb-1">● {displayLabel}</div>
      <div className="text-description-fg pl-3 border-l border-panel-border">
        <MarkdownText>{text}</MarkdownText>
      </div>
    </div>
  );
};

// ============================================================================
// Tool Result Output Component
// ============================================================================

interface ToolResultOutputProps {
  result: { success: boolean; output?: string; error?: string };
  className?: string;
}

const ToolResultOutput: React.FC<ToolResultOutputProps> = ({
  result,
  className = "",
}) => {
  let contentText: string;

  let outputStr: string | undefined;
  if (typeof result.output === "string") {
    outputStr = result.output;
  } else if (result.output != null) {
    WebviewLog.warn(
      `[ToolResultOutput] result.output is not a string — parser may need updating. Actual type: ${typeof result.output}, Value: ${JSON.stringify(result.output)}`
    );
    outputStr = JSON.stringify(result.output);
  }

  let errorStr: string | undefined;
  if (typeof result.error === "string") {
    errorStr = result.error;
  } else if (result.error != null) {
    WebviewLog.warn(
      `[ToolResultOutput] result.error is not a string — parser may need updating. Actual type: ${typeof result.error}, Value: ${JSON.stringify(result.error)}`
    );
    errorStr = JSON.stringify(result.error);
  }

  if (!result.success && errorStr) {
    contentText = errorStr.substring(0, 200);
  } else if (outputStr) {
    contentText = outputStr.substring(0, 100);
  } else {
    contentText = result.success ? "Success" : "Failed";
  }

  return (
    <div
      className={`${result.success ? TOOL_RESULT_LINE : "text-bash-status-error pl-4 ml-2 text-[length:var(--fp-output-font-size-sm)]"} flex items-start gap-1 ${className}`}
    >
      <span className="shrink-0">⎿</span>
      <span className="whitespace-pre-wrap break-words min-w-0">
        {contentText}
      </span>
    </div>
  );
};

// ============================================================================
// Single event renderer — memoized to skip re-render when event hasn't changed
// ============================================================================

interface SingleEventProps {
  event: CliEvent;
  eventKey: string;
  rawTextOutput: boolean;
  onUndoFile?: (path: string, attemptIndex: number) => void;
  attemptIndex?: number;
  fileUndoMode?: "undo" | "redo";
  hideDiff?: boolean;
}

/**
 * Renders a single CLI event. Wrapped in React.memo so that events which have
 * not changed (e.g. completed tool calls before the current streaming text
 * event) do not re-render on every streaming chunk.
 */
const SingleEvent = memo<SingleEventProps>(
  ({
    event,
    eventKey,
    rawTextOutput,
    onUndoFile,
    attemptIndex = 0,
    fileUndoMode = "undo",
    hideDiff = false,
  }) => {
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT: {
        const data = event.data as TextData;
        if (!data.text) return null;
        return (
          <TextOutput key={eventKey} text={data.text} raw={rawTextOutput} />
        );
      }

      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingBlock;
        if (!data.text) return null;
        return (
          <ThinkingOutput key={eventKey} text={data.text} label={data.label} />
        );
      }

      case CLI_EVENT_TYPES.BASH_COMMAND: {
        const data = event.data as BashCommandData;
        return (
          <BashOutput
            key={eventKey}
            command={data.command}
            output={data.output}
            error={data.error}
            exitCode={data.exitCode}
            status={data.status}
          />
        );
      }

      case CLI_EVENT_TYPES.FILE_EDIT: {
        const data = event.data as FileEditData;
        if (!data.path) return null;
        return (
          <FileEditOutput
            key={eventKey}
            path={data.path}
            status={data.status}
            oldContent={data.oldContent}
            newContent={data.newContent}
            structuredPatch={data.structuredPatch}
            error={data.error}
            onUndoFile={onUndoFile}
            attemptIndex={attemptIndex}
            fileUndoMode={fileUndoMode}
            hideDiff={hideDiff}
          />
        );
      }

      case CLI_EVENT_TYPES.FILE_WRITE: {
        const data = event.data as FileWriteData;
        if (!data.path) return null;
        return (
          <FileWriteOutput
            key={eventKey}
            path={data.path}
            status={data.status}
            content={data.content}
            error={data.error}
            onUndoFile={onUndoFile}
            attemptIndex={attemptIndex}
            fileUndoMode={fileUndoMode}
          />
        );
      }

      case CLI_EVENT_TYPES.FILE_READ: {
        const data = event.data as FileReadData;
        if (!data.path) return null;
        return (
          <FileReadOutput
            key={eventKey}
            path={data.path}
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
            key={eventKey}
            path={data.path}
            success={data.success}
            error={data.error}
            onUndoFile={onUndoFile}
            attemptIndex={attemptIndex}
            fileUndoMode={fileUndoMode}
          />
        );
      }

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as McpToolCallData;
        if (!data.server || !data.tool) return null;
        return (
          <McpToolCallOutput
            key={eventKey}
            server={data.server}
            tool={data.tool}
            result={data.result}
          />
        );
      }

      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as WebSearchData;
        if (!data.query) return null;
        return <WebSearchOutput key={eventKey} query={data.query} />;
      }

      case CLI_EVENT_TYPES.TOOL_CALL: {
        const data = event.data as ToolCall;
        if (!data.name) return null;
        return (
          <GenericToolCallOutput
            key={eventKey}
            name={data.name}
            parameters={data.parameters}
            result={data.result}
          />
        );
      }

      case CLI_EVENT_TYPES.TOOL_RESULT: {
        const data = event.data as ToolResultData;
        if (!data.result) return null;
        return <ToolResultOutput key={eventKey} result={data.result} />;
      }

      default:
        return null;
    }
  }
);
SingleEvent.displayName = "SingleEvent";

// ============================================================================
// Structured Output Renderer
// ============================================================================

interface StructuredOutputProps {
  events: CliEvent[];
  /** When true, text events are rendered as pre-formatted plain text (no markdown pipeline) */
  rawTextOutput?: boolean;
  onUndoFile?: (path: string, eventIndex: number) => void;
  fileUndoMode?: "undo" | "redo";
  className?: string;
  /**
   * Prefix used to generate stable DOM IDs for file-operation events so the
   * minimap can measure their position and height. When provided, each
   * FILE_EDIT (that renders its diff), FILE_WRITE, and FILE_DELETE event is
   * wrapped in a `<div id="${stepKey}-e${index}" data-diff-anchor>` so
   * OutputSection can measure scroll fractions via querySelectorAll.
   */
  stepKey?: string;
}

/**
 * StructuredOutput renders CLI events in chronological order.
 *
 * Each event is rendered by a memoized SingleEvent component so that events
 * which have not changed (e.g. completed tool calls earlier in the list) are
 * skipped during reconciliation. Only the last TEXT/THINKING event (which
 * grows with each streaming chunk) needs to re-render.
 *
 * The component itself is also memoized; it will only re-render when the
 * events array reference changes (which happens only when new events arrive or
 * the last event's text grows via mergeStreamingEvents in workflowStore).
 *
 * FILE_EDIT deduplication: harnesses like claude-cli emit both an INITIATED
 * event (the attempted diff) and a COMPLETED event (the applied diff + undo
 * button) for the same file edit. When a COMPLETED event exists for a given
 * path, the INITIATED event's diff is hidden — the COMPLETED version has
 * better diff data (structuredPatch with line numbers) and carries the undo
 * button. The INITIATED tool line ("Editing …") remains visible. When an edit
 * FAILS, the INITIATED diff is kept so the attempted change is visible.
 */
const StructuredOutput = memo<StructuredOutputProps>(
  ({
    events,
    rawTextOutput = false,
    onUndoFile,
    fileUndoMode = "undo",
    className = "",
    stepKey,
  }) => {
    // For FILE_EDIT INITIATED events that have a matching COMPLETED event later
    // in the list for the same path, hide the diff (but keep the tool line
    // visible so the "Editing …" indicator still appears). We use a forward-scan
    // so that multiple sequential edits to the same file are handled correctly:
    // each INITIATED is only affected by the *next* edit of the same file.
    // When an edit FAILS the diff remains visible alongside the error.
    const visibleEvents = useMemo(() => {
      const indicesToHideDiff = new Set<number>();
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event.type !== CLI_EVENT_TYPES.FILE_EDIT) continue;
        const data = event.data as FileEditData;
        if (data.status !== OPERATION_STATUS.INITIATED) continue;
        // Find the next FILE_EDIT event for the same path.
        for (let j = i + 1; j < events.length; j++) {
          const next = events[j];
          if (next.type !== CLI_EVENT_TYPES.FILE_EDIT) continue;
          const nextData = next.data as FileEditData;
          if (nextData.path !== data.path) continue;
          // Hide the diff on the INITIATED event only when a COMPLETED follows —
          // the COMPLETED version has a structuredPatch and carries the undo
          // button. When the edit FAILED we keep the diff so the attempted
          // change remains visible alongside the error.
          if (nextData.status === OPERATION_STATUS.COMPLETED) {
            indicesToHideDiff.add(i);
          }
          break;
        }
      }
      return events.map((event, i) => ({
        event,
        originalIndex: i,
        hideDiff: indicesToHideDiff.has(i),
      }));
    }, [events]);

    if (!events || events.length === 0) return null;

    return (
      <div className={`mt-[var(--spacing-sm)] ${className}`}>
        {visibleEvents.map(({ event, originalIndex, hideDiff }) => {
          // Use original index for stable keys — events are append-only during
          // streaming, so the original position never changes for existing items.
          const eventKey = `event-${originalIndex}`;

          // Wrap file-operation events in a measurement div so the minimap can
          // query their position and height via data-diff-anchor. Skip FILE_EDIT
          // events that have hideDiff=true — those render only the tool call
          // line (no diff content), so their height doesn't represent the diff.
          const isFileOp =
            event.type === CLI_EVENT_TYPES.FILE_EDIT ||
            event.type === CLI_EVENT_TYPES.FILE_WRITE ||
            event.type === CLI_EVENT_TYPES.FILE_DELETE;
          const shouldAnchor =
            isFileOp &&
            !!stepKey &&
            !(event.type === CLI_EVENT_TYPES.FILE_EDIT && hideDiff);

          const singleEvent = (
            <SingleEvent
              event={event}
              eventKey={eventKey}
              rawTextOutput={rawTextOutput}
              onUndoFile={onUndoFile}
              attemptIndex={originalIndex}
              fileUndoMode={fileUndoMode}
              hideDiff={hideDiff}
            />
          );

          if (shouldAnchor) {
            return (
              <div
                key={eventKey}
                id={`${stepKey}-e${originalIndex}`}
                data-diff-anchor="true"
              >
                {singleEvent}
              </div>
            );
          }

          return <React.Fragment key={eventKey}>{singleEvent}</React.Fragment>;
        })}
      </div>
    );
  }
);
StructuredOutput.displayName = "StructuredOutput";

// ============================================================================
// Main CliOutput Component
// ============================================================================

interface CliOutputProps {
  output: CliOutputType;
  stepIndex: number;
  stepLabel?: string;
  attemptIndex: number;
  streamingChunk?: string;
  /** When false, suppresses the streaming indicator even if output.isStreaming is true.
   *  The partial streamed text is still shown so the user can see output captured before stop/error. */
  isExecutionActive?: boolean;
  /** When true, shows per-file undo buttons on file edit/write/delete operations */
  allowUndoActions?: boolean;
  className?: string;
  /** Workspace snapshot override — used in history mode so we don't read from the live store */
  workspaceSnapshot?: WorkspaceSnapshot;
  /** UndoRecord override — used in history mode so we don't read from the live store */
  undoRecord?: UndoRecord;
  /**
   * All CLI outputs for this step (initial attempt + retries).
   * When provided for the last attempt, a prompt-level undo button is shown.
   */
  allStepOutputs?: CliOutputType[];
}

/**
 * CliOutput Component
 *
 * Main output container for a single CLI execution step.
 * Features:
 * - Header with prompt number and attempt label
 * - Streaming indicator when in progress
 * - Prompt text display
 * - CLI command display (terminal-style)
 * - Structured event rendering or plain response fallback
 * - Token statistics (input/output/total)
 * - Elapsed time
 *
 * Performance: wrapped in React.memo so completed steps (whose output prop
 * and streamingChunk are both stable) are skipped during reconciliation when
 * other steps are still streaming.
 */
export const CliOutput = memo<CliOutputProps>(
  ({
    output,
    stepIndex,
    stepLabel,
    attemptIndex,
    streamingChunk = "",
    isExecutionActive = true,
    allowUndoActions = false,
    className = "",
    workspaceSnapshot,
    undoRecord,
    allStepOutputs,
  }) => {
    const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);

    interface CliDialogState {
      mode: "undo" | "redo";
      input?: UndoDialogInput;
      redoInstructions?: UndoFileInstruction[];
      requestId: string;
    }
    const [dialogState, setDialogState] = useState<CliDialogState | null>(null);

    const workspaceSnapshotsFromStore = useWorkflowStore(
      (s) => s.workspaceSnapshots
    );
    const finalPromptWorkspaceSnapshotsFromStore = useWorkflowStore(
      (s) => s.finalPromptWorkspaceSnapshots
    );
    const undoRecordsFromStore = useWorkflowStore((s) => s.undoRecords);

    const isFinalPrompt = stepLabel !== undefined;
    const target: UndoExecutionTarget = useMemo(
      () =>
        isFinalPrompt
          ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
          : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
      [isFinalPrompt, stepIndex]
    );
    const targetKey = isFinalPrompt
      ? `finalPrompt-${stepIndex}`
      : `queue-${stepIndex}`;

    // Prefix for diff measurement anchor IDs in StructuredOutput.
    // Format: fp-diff-{kind}-{stepIndex}-a{attemptIndex}
    // Matches the lookup key used in OutputSection minimapSteps computation.
    const diffAnchorPrefix = `fp-diff-${isFinalPrompt ? "fp" : "q"}-${stepIndex}-a${attemptIndex}`;

    const effectiveUndoRecord = undoRecord ?? undoRecordsFromStore[targetKey];
    const effectiveSnapshot =
      workspaceSnapshot ??
      (isFinalPrompt
        ? finalPromptWorkspaceSnapshotsFromStore[stepIndex]
        : workspaceSnapshotsFromStore[stepIndex]);

    const fileUndoMode: "undo" | "redo" =
      effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
        ? "redo"
        : "undo";

    const onUndoFile = useCallback(
      (path: string, eventIndex: number) => {
        const newRequestId = crypto.randomUUID();
        const showRedo =
          effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true;

        if (showRedo) {
          const fileRedoInstruction = effectiveUndoRecord.redoInstructions.find(
            (i) => sameFilePath(i.path, path)
          );
          if (fileRedoInstruction) {
            setDialogState({
              mode: "redo",
              redoInstructions: [fileRedoInstruction],
              requestId: newRequestId,
            });
          }
        } else {
          const workspacePath = output.workingDirectory ?? "";
          // Use the specific event index so each individual diff undo targets only
          // the clicked edit — not last-write-wins across all edits to the same file.
          const events = output.structured?.events ?? [];
          const input = buildUndoDialogInputForSpecificEvent(
            target,
            eventIndex,
            path,
            events,
            effectiveSnapshot,
            workspacePath
          );
          setDialogState({ mode: "undo", input, requestId: newRequestId });
        }
      },
      [target, output, effectiveUndoRecord, effectiveSnapshot]
    );

    const attemptLabel =
      attemptIndex === 0 ? "Initial Attempt" : `Retry ${attemptIndex}`;

    const structuredMetadata = output.structured?.metadata;
    const sessionId = structuredMetadata?.sessionId;
    const harnessId = structuredMetadata?.harness;
    const harnessName = harnessId
      ? (HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO]?.name ??
        harnessId)
      : undefined;

    const handleCopySessionId = useCallback(async () => {
      if (!sessionId) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(sessionId);
        } else {
          const textArea = document.createElement("textarea");
          textArea.value = sessionId;
          textArea.style.position = "fixed";
          textArea.style.left = "-9999px";
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand("copy");
          document.body.removeChild(textArea);
        }
        setCopiedSessionId(sessionId);
        window.setTimeout(() => {
          setCopiedSessionId((current) =>
            current === sessionId ? null : current
          );
        }, 1200);
      } catch {
        setCopiedSessionId(null);
      }
    }, [sessionId]);

    // Show the streaming indicator only while execution is actively running.
    // When stopped or errored, isStreaming may still be true on the stored output
    // (no final CLI_OUTPUT is sent in those cases), so we gate on isExecutionActive.
    const streamingIndicator =
      output.isStreaming && isExecutionActive ? (
        <span className="text-output-streaming font-normal animate-pulse-streaming">
          ⬤ Streaming...
        </span>
      ) : null;

    // When the harness pre-formats its output, skip the markdown pipeline entirely.
    // Check output.rawTextOutput first (set on streaming CliOutput before parse completes),
    // then fall back to the final parsed metadata (set by the response parser).
    const rawTextOutput =
      !!output.rawTextOutput || !!output.structured?.metadata?.rawTextOutput;

    // Render response: show both streaming text and structured events when available.
    // Memoized to avoid re-running the branch logic on every render.
    const responseNode = useMemo(() => {
      const hasStructuredEvents =
        output.structured?.events && output.structured.events.length > 0;
      const hasStreamingText =
        output.isStreaming && streamingChunk && streamingChunk.length > 0;
      const hasFinalResponse = !output.isStreaming && output.response;

      // Case 1: Streaming with BOTH text chunks and structured events
      // Show text first (initial response), then structured events (tool calls/results)
      if (hasStructuredEvents && hasStreamingText) {
        return (
          <>
            <div className={`${OUTPUT_BLOCK_BASE} border-l-transparent`}>
              {rawTextOutput ? (
                <div className="whitespace-pre-wrap">{streamingChunk}</div>
              ) : (
                <MarkdownText animated={true}>{streamingChunk}</MarkdownText>
              )}
            </div>
            <StructuredOutput
              events={output.structured?.events as CliEvent[]}
              rawTextOutput={rawTextOutput}
              onUndoFile={allowUndoActions ? onUndoFile : undefined}
              fileUndoMode={fileUndoMode}
              stepKey={diffAnchorPrefix}
            />
          </>
        );
      }

      // Case 2: Streaming with ONLY structured events (no text yet)
      if (hasStructuredEvents) {
        return (
          <StructuredOutput
            events={output.structured?.events as CliEvent[]}
            rawTextOutput={rawTextOutput}
            onUndoFile={allowUndoActions ? onUndoFile : undefined}
            fileUndoMode={fileUndoMode}
            stepKey={diffAnchorPrefix}
          />
        );
      }

      // Case 3: Streaming with ONLY text chunks (no structured events)
      if (hasStreamingText) {
        return (
          <div className={`${OUTPUT_BLOCK_BASE} border-l-transparent`}>
            {rawTextOutput ? (
              <div className="whitespace-pre-wrap">{streamingChunk}</div>
            ) : (
              <MarkdownText animated={true}>{streamingChunk}</MarkdownText>
            )}
          </div>
        );
      }

      // Case 4: Streaming but no content yet - show nothing (indicator shows we're streaming)
      if (output.isStreaming) {
        return null;
      }

      // Case 5: Final output with plain response text (no structured data)
      if (hasFinalResponse) {
        return (
          <div className={`${OUTPUT_BLOCK_BASE} border-l-transparent`}>
            {rawTextOutput ? (
              <div className="whitespace-pre-wrap">
                {output.response as string}
              </div>
            ) : (
              <MarkdownText>{output.response as string}</MarkdownText>
            )}
          </div>
        );
      }

      return null;
    }, [
      output.structured,
      output.isStreaming,
      output.response,
      streamingChunk,
      rawTextOutput,
      allowUndoActions,
      onUndoFile,
      fileUndoMode,
      diffAnchorPrefix,
    ]);

    // Token stats — memoized separately; only changes when the run completes
    // or copiedSessionId changes (copy button feedback).
    const statsNode = useMemo(() => {
      if (!output.tokens && output.elapsed === undefined && !sessionId) {
        return null;
      }

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
        if (cached) {
          tokenDetails.push(`${cached} cached`);
        }
        if (cacheCreated) {
          tokenDetails.push(`${cacheCreated} cache-created`);
        }

        // Context window usage (shown inline) with token details in hover tooltip
        const pct = calcContextPct(contextWindowUsed, contextWindowSize);
        if (pct !== undefined) {
          const fmt = (n: number) =>
            n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          parts.push(
            <span key="context" title={tokenDetails.join(" | ")}>
              Context: {fmt(contextWindowUsed!)}/{fmt(contextWindowSize!)} (
              {pct}
              %)
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

      return (
        <>
          {parts.map((part, index) => (
            <React.Fragment key={`stats-${index}`}>
              {index > 0 && <span aria-hidden="true"> | </span>}
              {part}
            </React.Fragment>
          ))}
        </>
      );
    }, [
      output.tokens,
      output.elapsed,
      output.isStreaming,
      sessionId,
      harnessName,
      copiedSessionId,
      handleCopySessionId,
    ]);

    // Compute available undo/redo actions via shared utility.
    // Both can be non-null simultaneously in mixed state (some files undone,
    // others not). Guard on allStepOutputs presence and streaming/active state.
    const promptUndoActions = useMemo(() => {
      if (!allStepOutputs || output.isStreaming || !allowUndoActions) {
        return { undo: null, redo: null };
      }
      return computePromptUndoActions(
        allStepOutputs,
        effectiveUndoRecord,
        effectiveSnapshot
      );
    }, [
      allStepOutputs,
      output.isStreaming,
      allowUndoActions,
      effectiveUndoRecord,
      effectiveSnapshot,
    ]);

    const handlePromptUndo = useCallback(() => {
      if (!allStepOutputs) return;
      // Exclude files already undone (in redoInstructions) from the dialog.
      const alreadyUndone =
        effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
          ? effectiveUndoRecord.redoInstructions
          : undefined;
      const input = buildUndoDialogInputForPrompt(
        target,
        allStepOutputs,
        effectiveSnapshot,
        output.workingDirectory ?? "",
        alreadyUndone
      );
      setDialogState({ mode: "undo", input, requestId: crypto.randomUUID() });
    }, [
      allStepOutputs,
      effectiveSnapshot,
      effectiveUndoRecord,
      target,
      output.workingDirectory,
    ]);

    const handlePromptRedo = useCallback(() => {
      if (!effectiveUndoRecord?.redoInstructions?.length) return;
      setDialogState({
        mode: "redo",
        redoInstructions: effectiveUndoRecord.redoInstructions,
        requestId: crypto.randomUUID(),
      });
    }, [effectiveUndoRecord]);

    // Format timestamp for header
    const timestamp = output.timestampMs ? formatTime(output.timestampMs) : "";

    // Script step output — simplified rendering: header + stdout/stderr + exit code
    if (output.source === "script") {
      return (
        <div
          className={`bg-[var(--bg-primary)] py-[var(--spacing-sm)] px-[var(--spacing-md)] border-b border-[var(--border-color)] ${className}`}
        >
          {/* Header */}
          <div className="font-semibold mb-[var(--spacing-sm)] text-[var(--fg-secondary)] pb-[var(--spacing-xs)] border-b border-[var(--border-color)] text-[length:var(--fp-output-font-size-sm)] flex items-center gap-[var(--spacing-sm)]">
            {timestamp && (
              <span className="output-timestamp">[{timestamp}] </span>
            )}
            <i className="codicon codicon-terminal" />[
            {stepLabel ?? `Script ${stepIndex + 1}`}]{streamingIndicator}
          </div>

          {/* CLI command */}
          {output.cliCommand && (
            <div
              className={`${OUTPUT_BLOCK_BASE} border-l-output-command-border text-[var(--fg-primary)]`}
            >
              {output.workingDirectory || "workspace"}
              {">"} {output.cliCommand}
            </div>
          )}

          {/* Error message */}
          {output.errorMessage && (
            <div
              className={`${OUTPUT_BLOCK_BASE} border-l-severity-error text-error-fg`}
            >
              Error: {output.errorMessage}
            </div>
          )}

          {/* Script stdout/stderr — plain text */}
          {output.response && (
            <div className={`${OUTPUT_BLOCK_BASE} border-l-transparent`}>
              <div className="whitespace-pre-wrap text-[var(--fg-primary)]">
                {output.response}
              </div>
            </div>
          )}

          {/* Exit code summary */}
          {!output.isStreaming && output.exitCode !== undefined && (
            <div
              className={`mt-[var(--spacing-xs)] text-[length:var(--fp-output-font-size-xs)] flex items-center gap-1 ${
                output.exitCode === 0
                  ? "text-bash-status-success"
                  : "text-bash-status-error"
              }`}
            >
              <i
                className={`codicon ${output.exitCode === 0 ? "codicon-pass" : "codicon-error"}`}
              />
              <span>
                Exit code: {output.exitCode}
                {output.exitCode === 0 ? " — Success" : " — Failed"}
              </span>
              {output.elapsed !== undefined && (
                <span className="ml-2 text-[var(--fg-secondary)]">
                  {output.elapsed}s
                </span>
              )}
            </div>
          )}

          {/* Elapsed (when no exit code) */}
          {!output.isStreaming &&
            output.exitCode === undefined &&
            output.elapsed !== undefined && (
              <div className="mt-[var(--spacing-xs)] text-[length:var(--fp-output-font-size-xs)] text-[var(--fg-secondary)]">
                {output.elapsed}s
              </div>
            )}
        </div>
      );
    }

    return (
      <div
        className={`bg-[var(--bg-primary)] py-[var(--spacing-sm)] px-[var(--spacing-md)] border-b border-[var(--border-color)] ${className}`}
      >
        {/* Header */}
        <div className="font-semibold mb-[var(--spacing-sm)] text-[var(--fg-secondary)] pb-[var(--spacing-xs)] border-b border-[var(--border-color)] text-[length:var(--fp-output-font-size-sm)] flex items-center gap-[var(--spacing-sm)]">
          {timestamp && (
            <span className="output-timestamp">[{timestamp}] </span>
          )}
          [{stepLabel ?? `Prompt ${stepIndex + 1}`}] {attemptLabel}
          {streamingIndicator}
          {(promptUndoActions.undo || promptUndoActions.redo) && (
            <div className="ml-auto flex items-center gap-2 flex-shrink-0 font-normal">
              {promptUndoActions.undo && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePromptUndo();
                  }}
                  className="text-link-fg hover:text-link-active-fg transition-colors"
                >
                  <i className="codicon codicon-discard mr-1" />
                  {promptUndoActions.undo.label}
                </button>
              )}
              {promptUndoActions.redo && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePromptRedo();
                  }}
                  className="text-terminal-ansiGreen hover:opacity-80 transition-opacity"
                >
                  <i className="codicon codicon-redo mr-1" />
                  {promptUndoActions.redo.label}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Prompt text */}
        {output.prompt && (
          <div
            className={`${OUTPUT_BLOCK_BASE} border-l-output-prompt-border text-[var(--fg-primary)]`}
          >
            {output.prompt}
          </div>
        )}

        {/* CLI command */}
        {output.cliCommand && (
          <div
            className={`${OUTPUT_BLOCK_BASE} border-l-output-command-border text-[var(--fg-primary)]`}
          >
            {output.workingDirectory || "workspace"}
            {">"} {output.cliCommand}
          </div>
        )}

        {/* Error message */}
        {output.errorMessage && (
          <div
            className={`${OUTPUT_BLOCK_BASE} border-l-severity-error text-error-fg`}
          >
            {timestamp && <span className="opacity-70">[{timestamp}] </span>}
            Error: {output.errorMessage}
          </div>
        )}

        {/* Response (structured or plain) */}
        {responseNode}

        {/* Statistics row */}
        {statsNode && (
          <div className="mt-[var(--spacing-xs)] text-[length:var(--fp-output-font-size-xs)] text-[var(--fg-secondary)]">
            {statsNode}
          </div>
        )}

        {/* Undo/Redo dialog — rendered inline so it can use this component's state */}
        {dialogState && (
          <UndoChangesDialog
            mode={dialogState.mode}
            target={target}
            workspacePath={output.workingDirectory ?? ""}
            input={dialogState.input}
            redoInstructions={dialogState.redoInstructions}
            requestId={dialogState.requestId}
            onClose={() => setDialogState(null)}
          />
        )}
      </div>
    );
  }
);
CliOutput.displayName = "CliOutput";
