/**
 * Shared formatter for converting UniversalCliOutput to various output formats.
 * Provides consistent formatting across all CLI harnesses for display in
 * the VS Code Output panel, dashboard webview, and other consumers.
 */

import {
  UniversalCliOutput,
  OutputMetadata,
  CliEvent,
} from "../../../types/CliOutputTypes";
import { normalizeCliEvents } from "../../../utils/CliEventNormalizer";

/**
 * Dashboard-ready output format.
 * Optimized structure for rendering in the ctrlyoke dashboard webview.
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
   * Format output as structured data for dashboard webview.
   * Converts UniversalCliOutput to a format optimized for the ctrlyoke dashboard.
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
      events: normalizeCliEvents(output.events),
      metadata: output.metadata,
    };
  }

  /**
   * Format metadata statistics string.
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
}
