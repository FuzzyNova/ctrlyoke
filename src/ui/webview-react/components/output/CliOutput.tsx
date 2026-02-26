import React, { useCallback, useState } from "react";
import { formatTime } from "@utils/outputUtils";
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
import type {
  CliOutputItem,
  CliEvent,
  BashCommandEventData,
  TextEventData,
  ThinkingEventData,
  FileEditEventData,
  FileWriteEventData,
  FileReadEventData,
  FileDeleteEventData,
  McpToolCallEventData,
  WebSearchEventData,
  ToolCallEventData,
  ToolResultEventData,
} from "../../types/cliEvents";
import { CLI_EVENT_TYPES } from "../../types/cliEvents";
import { HARNESS_INFO } from "../../types/messages";

// ============================================================================
// Text Output Component
// ============================================================================

interface TextOutputProps {
  text: string;
  className?: string;
}

const TextOutput: React.FC<TextOutputProps> = ({ text, className = "" }) => {
  return (
    <div className={`my-2 ${className}`}>
      <MarkdownText>{text}</MarkdownText>
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
  const prefix = "  ⎿  ";
  let content: string;

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
    content = prefix + errorStr.substring(0, 200);
  } else if (outputStr) {
    content = prefix + outputStr.substring(0, 100);
  } else {
    content = prefix + (result.success ? "Success" : "Failed");
  }

  return (
    <div
      className={`${result.success ? TOOL_RESULT_LINE : "text-vscode-error-fg pl-4 ml-2 text-[11px] whitespace-pre-wrap break-words"} ${className}`}
    >
      {content}
    </div>
  );
};

// ============================================================================
// Structured Output Renderer
// ============================================================================

interface StructuredOutputProps {
  events: CliEvent[];
  className?: string;
}

/**
 * StructuredOutput renders CLI events in chronological order
 */
const StructuredOutput: React.FC<StructuredOutputProps> = ({
  events,
  className = "",
}) => {
  if (!events || events.length === 0) return null;

  return (
    <div className={`mt-[var(--spacing-sm)] ${className}`}>
      {events.map((event, index) => {
        const key = `event-${index}`;

        switch (event.type) {
          case CLI_EVENT_TYPES.TEXT: {
            const data = event.data as TextEventData;
            if (!data.text) return null;
            return <TextOutput key={key} text={data.text} />;
          }

          case CLI_EVENT_TYPES.THINKING: {
            const data = event.data as ThinkingEventData;
            if (!data.text) return null;
            return (
              <ThinkingOutput key={key} text={data.text} label={data.label} />
            );
          }

          case CLI_EVENT_TYPES.BASH_COMMAND: {
            const data = event.data as BashCommandEventData;
            return (
              <BashOutput
                key={key}
                command={data.command}
                output={data.output}
                error={data.error}
                exitCode={data.exitCode}
                status={data.status}
              />
            );
          }

          case CLI_EVENT_TYPES.FILE_EDIT: {
            const data = event.data as FileEditEventData;
            if (!data.path) return null;
            return (
              <FileEditOutput
                key={key}
                path={data.path}
                status={data.status}
                oldContent={data.oldContent}
                newContent={data.newContent}
                structuredPatch={data.structuredPatch}
                error={data.error}
              />
            );
          }

          case CLI_EVENT_TYPES.FILE_WRITE: {
            const data = event.data as FileWriteEventData;
            if (!data.path) return null;
            return (
              <FileWriteOutput
                key={key}
                path={data.path}
                status={data.status}
                content={data.content}
                error={data.error}
              />
            );
          }

          case CLI_EVENT_TYPES.FILE_READ: {
            const data = event.data as FileReadEventData;
            if (!data.path) return null;
            return (
              <FileReadOutput
                key={key}
                path={data.path}
                status={data.status}
                error={data.error}
              />
            );
          }

          case CLI_EVENT_TYPES.FILE_DELETE: {
            const data = event.data as FileDeleteEventData;
            if (!data.path) return null;
            return <FileDeleteOutput key={key} path={data.path} />;
          }

          case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
            const data = event.data as McpToolCallEventData;
            if (!data.server || !data.tool) return null;
            return (
              <McpToolCallOutput
                key={key}
                server={data.server}
                tool={data.tool}
              />
            );
          }

          case CLI_EVENT_TYPES.WEB_SEARCH: {
            const data = event.data as WebSearchEventData;
            if (!data.query) return null;
            return <WebSearchOutput key={key} query={data.query} />;
          }

          case CLI_EVENT_TYPES.TOOL_CALL: {
            const data = event.data as ToolCallEventData;
            if (!data.name) return null;
            return (
              <GenericToolCallOutput
                key={key}
                name={data.name}
                parameters={data.parameters}
                result={data.result}
              />
            );
          }

          case CLI_EVENT_TYPES.TOOL_RESULT: {
            const data = event.data as ToolResultEventData;
            if (!data.result) return null;
            return <ToolResultOutput key={key} result={data.result} />;
          }

          default:
            return null;
        }
      })}
    </div>
  );
};

// ============================================================================
// Main CliOutput Component
// ============================================================================

interface CliOutputProps {
  output: CliOutputItem;
  stepIndex: number;
  attemptIndex: number;
  streamingChunk?: string;
  className?: string;
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
 */
export const CliOutput: React.FC<CliOutputProps> = ({
  output,
  stepIndex,
  attemptIndex,
  streamingChunk = "",
  className = "",
}) => {
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const attemptLabel =
    attemptIndex === 0 ? "Initial Attempt" : `Retry ${attemptIndex}`;

  const structuredMetadata = output.structured?.metadata;
  const sessionId = structuredMetadata?.sessionId;
  const harnessId = structuredMetadata?.harness;
  const harnessName = harnessId
    ? (HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO]?.name ?? harnessId)
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

  // Check if streaming
  const streamingIndicator = output.isStreaming ? (
    <span className="text-output-streaming font-normal animate-pulse-streaming">
      ⬤ Streaming...
    </span>
  ) : null;

  // Render response: show both streaming text and structured events when available
  const renderResponse = () => {
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
          <div
            className={`${OUTPUT_BLOCK_BASE} border-l-[var(--border-color)]`}
          >
            <MarkdownText animated={true}>{streamingChunk}</MarkdownText>
          </div>
          <StructuredOutput events={output.structured?.events as CliEvent[]} />
        </>
      );
    }

    // Case 2: Streaming with ONLY structured events (no text yet)
    if (hasStructuredEvents) {
      return (
        <StructuredOutput events={output.structured?.events as CliEvent[]} />
      );
    }

    // Case 3: Streaming with ONLY text chunks (no structured events)
    if (hasStreamingText) {
      return (
        <div className={`${OUTPUT_BLOCK_BASE} border-l-[var(--border-color)]`}>
          <MarkdownText animated={true}>{streamingChunk}</MarkdownText>
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
        <div className={`${OUTPUT_BLOCK_BASE} border-l-[var(--border-color)]`}>
          <MarkdownText>{output.response as string}</MarkdownText>
        </div>
      );
    }

    return null;
  };

  // Token stats
  const renderStats = () => {
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
      if (contextWindowUsed !== undefined && contextWindowSize) {
        const fmt = (n: number) =>
          n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
        const pct = Math.round((contextWindowUsed / contextWindowSize) * 100);
        parts.push(
          <span key="context" title={tokenDetails.join(" | ")}>
            Context: {fmt(contextWindowUsed)}/{fmt(contextWindowSize)} ({pct}%)
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
      <div className="text-[10px] text-[var(--fg-secondary)] mt-[var(--spacing-xs)]">
        {parts.map((part, index) => (
          <React.Fragment key={`stats-${index}`}>
            {index > 0 && <span aria-hidden="true"> | </span>}
            {part}
          </React.Fragment>
        ))}
      </div>
    );
  };

  // Format timestamp for header
  const timestamp = output.timestampMs ? formatTime(output.timestampMs) : "";

  return (
    <div
      className={`bg-[var(--bg-primary)] py-[var(--spacing-sm)] px-[var(--spacing-md)] border-b border-[var(--border-color)] ${className}`}
    >
      {/* Header */}
      <div className="font-semibold mb-[var(--spacing-sm)] text-[var(--fg-secondary)] pb-[var(--spacing-xs)] border-b border-[var(--border-color)] text-[11px] flex items-center gap-[var(--spacing-sm)]">
        {timestamp && <span className="output-timestamp">[{timestamp}] </span>}
        [Prompt {stepIndex + 1}] {attemptLabel}
        {streamingIndicator}
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

      {/* Response (structured or plain) */}
      {renderResponse()}

      {/* Statistics */}
      {renderStats()}
    </div>
  );
};
