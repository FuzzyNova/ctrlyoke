/**
 * Shared formatter for converting UniversalCliOutput to various output formats.
 * Provides consistent formatting across all CLI harnesses for display in
 * the VS Code Output panel, dashboard webview, and other consumers.
 */

import {
  UniversalCliOutput,
  OutputMetadata,
  ToolCall,
  ToolResult,
  CliEvent,
  TextData,
  ThinkingBlock,
  ToolResultData,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";

/**
 * Dashboard-ready output format.
 * Optimized structure for rendering in the FlightPath dashboard webview.
 * Events are preserved in chronological order.
 */
export interface DashboardOutput {
  /** Chronologically ordered events from the CLI session */
  events: CliEvent[];
  /** Response metadata */
  metadata: OutputMetadata;
}

/**
 * Shared formatter for converting UniversalCliOutput to various output formats.
 * All methods are static for easy use without instantiation.
 */
export class CliOutputFormatter {
  /**
   * Format output as plain text for VS Code Output panel.
   * Produces a human-readable text representation of the CLI response.
   * Events are rendered in chronological order as they occurred.
   *
   * @param output - The universal CLI output to format
   * @returns Plain text representation suitable for Output panel
   *
   * @example
   * ```typescript
   * const text = CliOutputFormatter.toPlainText(output);
   * outputChannel.appendLine(text);
   * ```
   */
  static toPlainText(output: UniversalCliOutput): string {
    const parts: string[] = [];

    // Render events in chronological order
    for (const event of output.events) {
      switch (event.type) {
        case CLI_EVENT_TYPES.TEXT:
          const textData = event.data as TextData;
          if (textData.text) {
            parts.push(textData.text);
          }
          break;

        case CLI_EVENT_TYPES.TOOL_CALL:
          const toolCall = event.data as ToolCall;
          parts.push("\n--- Tool Call ---");
          parts.push(this.formatToolCall(toolCall));
          break;

        case CLI_EVENT_TYPES.THINKING:
          const thinkingBlock = event.data as ThinkingBlock;
          parts.push("\n--- Thinking ---");
          const label = thinkingBlock.label ? `[${thinkingBlock.label}] ` : "";
          parts.push(`${label}${thinkingBlock.text}`);
          break;

        case CLI_EVENT_TYPES.TOOL_RESULT:
          const resultData = event.data as ToolResultData;
          parts.push(this.formatToolResult(resultData.result));
          break;
      }
    }

    return parts.join("\n");
  }

  /**
   * Format a single tool call for plain text display.
   *
   * @param tool - The tool call to format
   * @returns Formatted tool call string
   */
  private static formatToolCall(tool: ToolCall): string {
    const lines: string[] = [];

    // Format tool name and parameters
    const paramsStr = JSON.stringify(tool.parameters, null, 2);
    lines.push(`• ${tool.name}(${paramsStr})`);

    // Add result if available
    if (tool.result) {
      lines.push(this.formatToolResult(tool.result));
    }

    return lines.join("\n");
  }

  /**
   * Format a tool result for plain text display.
   *
   * @param result - The tool result to format
   * @returns Formatted result string with success/failure indicator
   */
  private static formatToolResult(result: ToolResult): string {
    const icon = result.success ? "✓" : "✗";
    const message = result.output || result.error || "";
    return `  Result: ${icon} ${message}`;
  }

  /**
   * Format output as structured data for dashboard webview.
   * Converts UniversalCliOutput to a format optimized for the FlightPath dashboard.
   * Events are passed through in chronological order.
   *
   * @param output - The universal CLI output to format
   * @returns Dashboard-ready output structure
   *
   * @example
   * ```typescript
   * const dashboardData = CliOutputFormatter.toDashboardFormat(output);
   * webview.postMessage({ type: 'cliOutput', data: dashboardData });
   * ```
   */
  static toDashboardFormat(output: UniversalCliOutput): DashboardOutput {
    return {
      events: output.events,
      metadata: output.metadata,
    };
  }

  /**
   * Format metadata statistics string for backward compatibility.
   * Produces a compact statistics line suitable for status displays.
   *
   * @param metadata - The output metadata to format
   * @returns Pipe-separated statistics string
   *
   * @example
   * ```typescript
   * const stats = CliOutputFormatter.formatStatistics(metadata);
   * // Returns: "Session: 550e8400 | Model: claude-sonnet-4.5 | Tokens: 1234 in / 567 out"
   * ```
   */
  static formatStatistics(metadata: OutputMetadata): string {
    const parts: string[] = [];

    if (metadata.sessionId) {
      // Show first 8 chars for readability
      const displayId = metadata.sessionId.substring(0, 8);
      parts.push(`Session: ${displayId}`);
    }

    if (metadata.model) {
      parts.push(`Model: ${metadata.model}`);
    }

    if (metadata.usage) {
      parts.push(
        `Tokens: ${metadata.usage.inputTokens} in / ${metadata.usage.outputTokens} out`
      );
    }

    if (metadata.elapsed !== undefined) {
      const seconds = (metadata.elapsed / 1000).toFixed(1);
      parts.push(`Time: ${seconds}s`);
    }

    return parts.join(" | ");
  }

  /**
   * Create an empty UniversalCliOutput structure.
   * Useful for initializing output before parsing.
   *
   * @returns Empty UniversalCliOutput with default values
   */
  static createEmpty(): UniversalCliOutput {
    return {
      events: [],
      metadata: {},
    };
  }

  /**
   * Merge multiple CLI outputs into a single output.
   * Useful for streaming scenarios where chunks need to be combined.
   * Events from all outputs are concatenated in order.
   *
   * @param outputs - Array of outputs to merge
   * @returns Combined UniversalCliOutput with all events in order
   */
  static merge(outputs: UniversalCliOutput[]): UniversalCliOutput {
    if (outputs.length === 0) {
      return this.createEmpty();
    }

    if (outputs.length === 1) {
      return outputs[0];
    }

    return {
      events: outputs.flatMap((o) => o.events),
      // Use metadata from the last output (most complete)
      metadata: outputs[outputs.length - 1].metadata,
    };
  }
}
