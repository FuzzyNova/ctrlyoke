import React from "react";
import { escapeHtml, formatTime } from "@utils/outputUtils";
import { BashOutput } from "./BashOutput";
import {
  FileEditOutput,
  FileWriteOutput,
  FileReadOutput,
  FileDeleteOutput,
  McpToolCallOutput,
  WebSearchOutput,
  GenericToolCallOutput,
} from "./ToolCallOutput";
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

// ============================================================================
// Text Output Component
// ============================================================================

interface TextOutputProps {
  text: string;
  className?: string;
}

const TextOutput: React.FC<TextOutputProps> = ({ text, className = "" }) => {
  return (
    <div className={`output-text-terminal ${className}`}>
      {escapeHtml(text)}
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
    <div className={`output-text-terminal ${className}`}>
      ● {displayLabel}: {escapeHtml(text)}
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

  if (!result.success && result.error) {
    content = prefix + result.error.substring(0, 200);
  } else if (result.output) {
    content = prefix + result.output.substring(0, 100);
  } else {
    content = prefix + (result.success ? "Success" : "Failed");
  }

  return (
    <div
      className={`tool-result-line ${result.success ? "" : "error"} ${className}`}
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
    <div className={`structured-output ${className}`}>
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
  const attemptLabel =
    attemptIndex === 0 ? "Initial Attempt" : `Retry ${attemptIndex}`;

  // Check if streaming
  const streamingIndicator = output.isStreaming ? (
    <span className="streaming-indicator">⬤ Streaming...</span>
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
          <div className="output-response streaming">
            {escapeHtml(streamingChunk)}
          </div>
          <StructuredOutput events={output.structured.events as CliEvent[]} />
        </>
      );
    }

    // Case 2: Streaming with ONLY structured events (no text yet)
    if (hasStructuredEvents) {
      return (
        <StructuredOutput events={output.structured.events as CliEvent[]} />
      );
    }

    // Case 3: Streaming with ONLY text chunks (no structured events)
    if (hasStreamingText) {
      return (
        <div className="output-response streaming">
          {escapeHtml(streamingChunk)}
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
        <div className="output-response">{escapeHtml(output.response)}</div>
      );
    }

    return null;
  };

  // Token stats
  const renderStats = () => {
    if (!output.tokens && output.elapsed === undefined) return null;

    const parts: string[] = [];

    if (output.tokens) {
      const total = output.tokens.prompt + output.tokens.completion;
      parts.push(
        `Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion / ${total} total`
      );
    }

    if (!output.isStreaming && output.elapsed !== undefined) {
      parts.push(`${output.elapsed}s`);
    }

    return <div className="output-stats">{parts.join(" | ")}</div>;
  };

  // Format timestamp for header
  const timestamp = output.timestampMs ? formatTime(output.timestampMs) : "";

  return (
    <div className={`cli-output-item ${className}`}>
      {/* Header */}
      <div className="output-header">
        {timestamp && <span className="output-timestamp">[{timestamp}] </span>}
        [Prompt {stepIndex + 1}] {attemptLabel}
        {streamingIndicator}
      </div>

      {/* Prompt text */}
      {output.prompt && (
        <div className="output-prompt">{escapeHtml(output.prompt)}</div>
      )}

      {/* CLI command */}
      {output.cliCommand && (
        <div className="output-cli-command">
          {output.workingDirectory || "workspace"}
          {">"} {escapeHtml(output.cliCommand)}
        </div>
      )}

      {/* Response (structured or plain) */}
      {renderResponse()}

      {/* Statistics */}
      {renderStats()}
    </div>
  );
};
