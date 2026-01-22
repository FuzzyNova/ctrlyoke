/**
 * Shared formatter for converting UniversalCliOutput to various output formats.
 * Provides consistent formatting across all CLI providers for display in
 * the VS Code Output panel, dashboard webview, and other consumers.
 */

import {
  UniversalCliOutput,
  OutputMetadata,
  ToolCall,
  ToolResult,
} from "../../../types/CliOutputTypes";

/**
 * Dashboard-ready output format.
 * Optimized structure for rendering in the FlightPath dashboard webview.
 */
export interface DashboardOutput {
  /** The main text response */
  text: string;
  /** Tool calls with normalized structure */
  toolCalls: Array<{
    name: string;
    parameters: Record<string, unknown>;
    id?: string;
    result?: {
      success: boolean;
      output?: string;
      error?: string;
    };
  }>;
  /** Thinking blocks with required label */
  thinkingBlocks: Array<{
    text: string;
    label: string;
    timestamp?: number;
  }>;
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

    // Add main text response
    if (output.text) {
      parts.push(output.text);
    }

    // Add tool calls section
    if (output.toolCalls.length > 0) {
      parts.push("\n--- Tool Calls ---");
      for (const tool of output.toolCalls) {
        parts.push(this.formatToolCall(tool));
      }
    }

    // Add thinking blocks section
    if (output.thinkingBlocks.length > 0) {
      parts.push("\n--- Thinking ---");
      for (const block of output.thinkingBlocks) {
        const label = block.label ? `[${block.label}] ` : "";
        parts.push(`${label}${block.text}`);
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
      text: output.text,
      toolCalls: output.toolCalls.map((tool) => ({
        name: tool.name,
        parameters: tool.parameters,
        id: tool.id,
        result: tool.result
          ? {
              success: tool.result.success,
              output: tool.result.output,
              error: tool.result.error,
            }
          : undefined,
      })),
      thinkingBlocks: output.thinkingBlocks.map((block) => ({
        text: block.text,
        label: block.label || "Thinking",
        timestamp: block.timestamp,
      })),
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
      text: "",
      toolCalls: [],
      thinkingBlocks: [],
      metadata: {},
    };
  }

  /**
   * Merge multiple CLI outputs into a single output.
   * Useful for streaming scenarios where chunks need to be combined.
   *
   * @param outputs - Array of outputs to merge
   * @returns Combined UniversalCliOutput
   */
  static merge(outputs: UniversalCliOutput[]): UniversalCliOutput {
    if (outputs.length === 0) {
      return this.createEmpty();
    }

    if (outputs.length === 1) {
      return outputs[0];
    }

    return {
      text: outputs.map((o) => o.text).join(""),
      toolCalls: outputs.flatMap((o) => o.toolCalls),
      thinkingBlocks: outputs.flatMap((o) => o.thinkingBlocks),
      // Use metadata from the last output (most complete)
      metadata: outputs[outputs.length - 1].metadata,
    };
  }
}
