import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { BaseLogParser } from "../shared/BaseLogParser";
import { ILogParser } from "../shared/interfaces/ILogParser";
import { Log } from "../../../utils/Log";
import { retryWithBackoff, PermanentFailureError } from "../../../utils/RetryUtils";

/**
 * Claude CLI Log Parser
 *
 * Parses Claude CLI log files in JSONL format from `~/.claude/projects/<workspace-path>/`.
 * Each session creates a `<session-id>.jsonl` file with streaming event entries.
 *
 * @remarks
 * **Log Format:**
 * - Location: `~/.claude/projects/<workspace-path>/`
 * - File naming: `<session-id>.jsonl` (e.g., `550e8400-e29b-41d4-a716-446655440000.jsonl`)
 * - Index file: `sessions-index.json` (metadata about all sessions)
 *
 * **Event Structure:**
 * ```json
 * {
 *   "type": "assistant" | "user" | "queue-operation",
 *   "message": {
 *     "content": [{"type": "text", "text": "Response..."}],
 *     "stop_reason": "end_turn" | null,
 *     "usage": { "input_tokens": 100, "output_tokens": 50 }
 *   },
 *   "sessionId": "uuid",
 *   "timestamp": "ISO8601"
 * }
 * ```
 *
 * **Session Discovery:**
 * - Uses `findModifiedSessionLogs()` to get recently modified files
 * - Reads first 10 events from each candidate
 * - Matches prompt text against user event content (first 100 chars)
 * - Returns first matching log file path
 *
 * @example
 * ```typescript
 * const parser = new ClaudeLogParser();
 * const logPath = await parser.discoverSessionLog("Analyze code", new Date());
 * if (logPath) {
 *   const events = await parser.readNewLines(logPath);
 *   const response = parser.extractResponse(events);
 *   const sessionId = parser.extractSessionId(events);
 * }
 * ```
 */
export class ClaudeLogParser extends BaseLogParser implements ILogParser {
  /**
   * Extract complete response from Claude log events
   *
   * Processes Claude JSONL events and combines:
   * - Text content from assistant messages
   * - Tool calls (tool_use events)
   * - Thinking blocks (if present)
   * - Metadata (session ID, usage stats, model info)
   *
   * @param events - Array of parsed Claude log events
   * @returns Structured response object
   *
   * @remarks
   * **Response Assembly:**
   * - Concatenates text from all assistant.message.content[{type: "text"}]
   * - Collects tool calls from content[{type: "tool_use"}]
   * - Extracts thinking blocks from content[{type: "thinking"}]
   * - Aggregates usage stats from all events
   *
   * **Metadata Extraction:**
   * - Session ID from any event.sessionId field
   * - Model info from assistant events
   * - Token usage aggregated across events
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "assistant", message: { content: [{type: "text", text: "Hello"}] }, sessionId: "abc" },
   *   { type: "assistant", message: { stop_reason: "end_turn", usage: {...} } }
   * ];
   * const response = parser.extractResponse(events);
   * // { text: "Hello", toolCalls: [], thinkingBlocks: [], metadata: {...} }
   * ```
   */
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    thinkingBlocks?: any[];
    metadata: any;
  } {
    let text = "";
    const toolCalls: any[] = [];
    const thinkingBlocks: any[] = [];
    let sessionId: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let model: string | undefined;

    for (const event of events) {
      // Extract session ID from any event
      if (event.sessionId && !sessionId) {
        sessionId = event.sessionId;
      }

      // Process assistant messages
      if (event.type === "assistant" && event.message?.content) {
        for (const contentBlock of event.message.content) {
          // Extract text content
          if (contentBlock.type === "text" && contentBlock.text) {
            text += contentBlock.text;
          }

          // Extract tool calls
          if (contentBlock.type === "tool_use") {
            toolCalls.push({
              name: contentBlock.name,
              input: contentBlock.input,
              id: contentBlock.id,
            });
          }

          // Extract thinking blocks
          if (contentBlock.type === "thinking" && contentBlock.text) {
            thinkingBlocks.push({
              text: contentBlock.text,
            });
          }
        }

        // Extract usage stats
        if (event.message.usage) {
          totalInputTokens += event.message.usage.input_tokens || 0;
          totalOutputTokens += event.message.usage.output_tokens || 0;
        }

        // Extract model info
        if (event.message.model && !model) {
          model = event.message.model;
        }
      }
    }

    return {
      text: text.trim(),
      toolCalls,
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      metadata: {
        sessionId,
        model,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          total_tokens: totalInputTokens + totalOutputTokens,
        },
      },
    };
  }

  /**
   * Check if event indicates completion
   *
   * Claude events are complete when:
   * - Event type is "assistant"
   * - message.stop_reason is not null (e.g., "end_turn", "max_tokens", "stop_sequence")
   *
   * @param event - Single parsed Claude log event
   * @returns True if event signals completion
   *
   * @remarks
   * **Completion Indicators:**
   * - `stop_reason: "end_turn"` - Normal completion
   * - `stop_reason: "max_tokens"` - Token limit reached
   * - `stop_reason: "stop_sequence"` - Stop sequence encountered
   * - `stop_reason: null` - Still streaming (NOT complete)
   *
   * @example
   * ```typescript
   * const event = { type: "assistant", message: { stop_reason: "end_turn" } };
   * if (parser.isComplete(event)) {
   *   // Response is complete
   * }
   * ```
   */
  isComplete(event: any): boolean {
    return (
      event.type === "assistant" &&
      event.message?.stop_reason !== null &&
      event.message?.stop_reason !== undefined
    );
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches Claude project directory for log file matching session ID or prompt text.
   *
   * @param promptText - The prompt text sent to Claude CLI (used for matching if no sessionId)
   * @param startTime - Execution start timestamp (used to filter candidates)
   * @param sessionId - Optional session ID from SessionStart hook (faster, more reliable)
   * @returns Absolute path to session log file, or null if not found
   *
   * @remarks
   * **Fast Path (Session ID provided):**
   * 1. Find Claude project directory for current workspace
   * 2. Construct log file path: `<projectDir>/<sessionId>.jsonl`
   * 3. Verify file exists and was modified after startTime
   * 4. Return file path if valid
   *
   * **Fallback (No Session ID):**
   * 1. Find Claude project directory for current workspace
   * 2. Get candidate log files modified after startTime (via findModifiedSessionLogs)
   * 3. Read first 10 events from each candidate
   * 4. Look for user event containing prompt text (first 100 chars)
   * 5. Return first matching file path
   *
   * **Project Directory Resolution:**
   * - Base: `~/.claude/projects/`
   * - Path: Normalized workspace path (e.g., `dev_FlightPath`)
   * - Full: `~/.claude/projects/dev_FlightPath/`
   *
   * **Matching Strategy:**
   * - Session ID: Direct file lookup (much faster)
   * - Prompt text: Compares first 100 chars, case-sensitive exact match
   *
   * @example
   * ```typescript
   * // Fast path (with session ID from hook)
   * const logPath = await parser.discoverSessionLog(
   *   "Analyze code",
   *   new Date(),
   *   "abc-123-session-id"
   * );
   *
   * // Fallback (no session ID)
   * const logPath = await parser.discoverSessionLog("Analyze code", new Date());
   * ```
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    try {
      // Get Claude project directory for current workspace
      const projectDir = this.getClaudeProjectDirectory();
      if (!projectDir) {
        Log.debug("[ClaudeLogParser] No Claude project directory found");
        return null;
      }

      Log.debug(
        `[ClaudeLogParser] Searching for session logs in: ${projectDir}`
      );

      // FAST PATH: If session ID provided, construct direct file path
      if (sessionId) {
        const logPath = path.join(projectDir, `${sessionId}.jsonl`);

        // Retry with backoff: Claude writes log file within ~50-100ms of SessionStart hook
        // NOTE: When resuming a session, the log file may have an old mtime initially,
        // but the CLI will update it as it writes new content. This can take several seconds
        // if Claude is processing the resume request. We retry with longer delays to handle this.
        const result = await retryWithBackoff(
          async () => {
            // Verify file exists
            if (fs.existsSync(logPath)) {
              const stats = fs.statSync(logPath);
              if (stats.mtime >= startTime) {
                return logPath; // Success - file exists and is recent
              } else {
                // File exists but hasn't been updated yet - might be resuming an old session
                // The CLI will update it soon, so retry instead of failing
                Log.debug(
                  `[ClaudeLogParser] Session log exists but not yet updated (mtime: ${stats.mtime.toISOString()}, startTime: ${startTime.toISOString()}), will retry...`
                );
                return null; // Retry - file will be updated soon
              }
            }
            return null; // File doesn't exist yet, will retry
          },
          {
            maxAttempts: 10,
            delays: [0, 100, 200, 300, 500, 500, 500, 1000, 1000, 1000], // Total max wait: ~5s
            onRetry: (attempt, max, delay) => {
              if (attempt > 1) {
                Log.debug(
                  `[ClaudeLogParser] Session log not ready (attempt ${attempt}/${max}), retrying in ${delay}ms...`
                );
              }
            },
          }
        );

        if (result) {
          Log.debug(
            `[ClaudeLogParser] Found session log via session ID: ${result}`
          );
          return result;
        } else {
          Log.debug(
            `[ClaudeLogParser] Session log file not found after retries: ${logPath}`
          );
        }
      }

      // FALLBACK: Get candidate log files modified after startTime
      const candidates = this.findModifiedSessionLogs(projectDir, startTime);
      if (candidates.length === 0) {
        Log.debug("[ClaudeLogParser] No candidate log files found");
        return null;
      }

      Log.debug(
        `[ClaudeLogParser] Found ${candidates.length} candidate log files`
      );

      // Prepare prompt text for matching (first 100 chars)
      const promptPrefix = promptText.substring(0, 100);

      // Check each candidate for matching prompt text
      for (const candidatePath of candidates) {
        try {
          // Read first 10 events from log file
          const events = await this.readFirstNEvents(candidatePath, 10);

          // Look for user event with matching prompt text
          for (const event of events) {
            if (event.type === "user" && event.message?.content) {
              for (const contentBlock of event.message.content) {
                if (contentBlock.type === "text" && contentBlock.text) {
                  const logPromptPrefix = contentBlock.text.substring(0, 100);
                  if (logPromptPrefix === promptPrefix) {
                    Log.debug(
                      `[ClaudeLogParser] Found matching session log: ${candidatePath}`
                    );
                    return candidatePath;
                  }
                }
              }
            }
          }
        } catch (error) {
          // Skip files that can't be read or parsed
          Log.debug(
            `[ClaudeLogParser] Error reading candidate ${candidatePath}:`,
            error
          );
          continue;
        }
      }

      Log.debug("[ClaudeLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.warn("[ClaudeLogParser] Error discovering session log:", error);
      return null;
    }
  }

  /**
   * Extract session ID from log events
   *
   * Searches events for first entry with sessionId field.
   * Claude events include sessionId in most event types.
   *
   * @param events - Array of parsed Claude log events
   * @returns Session ID (UUID format), or null if not found
   *
   * @remarks
   * **Session ID Format:**
   * - UUID v4 (e.g., `550e8400-e29b-41d4-a716-446655440000`)
   * - Present in all event types (assistant, user, queue-operation)
   *
   * **Search Strategy:**
   * - Returns first non-empty sessionId field found
   * - No preference for event type
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "user", sessionId: "abc-123" },
   *   { type: "assistant", sessionId: "abc-123" }
   * ];
   * const sessionId = parser.extractSessionId(events);
   * // Returns: "abc-123"
   * ```
   */
  extractSessionId(events: any[]): string | null {
    for (const event of events) {
      if (event.sessionId) {
        return event.sessionId;
      }
    }
    return null;
  }

  /**
   * Extract text content from a single Claude log event for streaming
   *
   * @param event - Single parsed Claude log event
   * @returns Text content to display, or undefined if no displayable content
   *
   * @remarks
   * **Claude Event Format:**
   * - `{ type: "assistant", message: { content: [{ type: "text", text: "..." }] } }`
   */
  extractContentFromEvent(event: any): string | undefined {
    // Claude: Extract text from content array
    if (event.type === "assistant" && event.message?.content) {
      const textContent = event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      return textContent || undefined;
    }

    return undefined;
  }

  /**
   * Format Claude metadata into statistics string
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage)
   * @returns Formatted statistics string
   *
   * @example
   * ```typescript
   * const metadata = {
   *   sessionId: "abc-123",
   *   model: "claude-sonnet-4.5",
   *   usage: { input_tokens: 100, output_tokens: 50 }
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: abc-123 | Model: claude-sonnet-4.5 | Tokens: 100 in / 50 out"
   * ```
   */
  formatStatistics(metadata: any): string {
    const parts: string[] = [];

    // Session ID (truncated for readability)
    if (metadata.sessionId) {
      parts.push(`Session: ${metadata.sessionId.substring(0, 8)}`);
    }

    // Model name
    if (metadata.model) {
      parts.push(`Model: ${metadata.model}`);
    }

    // Token usage
    if (metadata.usage) {
      const usage = metadata.usage;
      if (
        usage.input_tokens !== undefined &&
        usage.output_tokens !== undefined
      ) {
        parts.push(
          `Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`
        );
      }
    }

    return parts.join(" | ");
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Get Claude project directory for current workspace
   *
   * Resolves to `~/.claude/projects/<workspace-path>/`
   *
   * @returns Absolute path to Claude project directory, or null if no workspace
   *
   * @remarks
   * **Path Normalization:**
   * - Replaces path separators with underscores
   * - Example: `/Users/name/dev/FlightPath` → `dev_FlightPath`
   * - Windows: `C:\dev\FlightPath` → `dev_FlightPath`
   *
   * **Directory Structure:**
   * - Base: `~/.claude/projects/`
   * - Project: `<normalized-workspace-path>/`
   * - Session logs: `<session-id>.jsonl`
   */
  private getClaudeProjectDirectory(): string | null {
    // Get first workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    // Get workspace path and normalize it
    const workspacePath = workspaceFolder.uri.fsPath;
    const normalizedPath = this.normalizeWorkspacePath(workspacePath);

    // Build Claude project directory path
    const homeDir = os.homedir();
    const projectDir = path.join(
      homeDir,
      ".claude",
      "projects",
      normalizedPath
    );

    return projectDir;
  }

  /**
   * Normalize workspace path for Claude project directory
   *
   * Converts filesystem path to Claude's normalized format.
   *
   * @param workspacePath - Absolute workspace path
   * @returns Normalized path (e.g., "C--dev-FlightPath")
   *
   * @remarks
   * **Normalization Rules:**
   * - Convert drive colon to double dash (Windows: `C:\` → `C--`)
   * - Remove leading slashes (Unix: `/Users/` → `Users-`)
   * - Replace path separators with dashes
   * - Example Windows: `C:\dev\FlightPath` → `C--dev-FlightPath`
   * - Example Unix: `/Users/name/dev/FlightPath` → `Users-name-dev-FlightPath`
   *
   * **Note:** This is based on observed Claude CLI behavior.
   * The actual normalization may vary depending on Claude CLI version.
   */
  private normalizeWorkspacePath(workspacePath: string): string {
    // Replace drive letter colon with double dash on Windows (e.g., "C:\dev\FlightPath" → "C--dev-FlightPath")
    let normalized = workspacePath.replace(/^([A-Z]):[\\\/]/i, "$1--");

    // Remove leading slash on Unix (e.g., "/Users/name/dev" → "Users/name/dev")
    normalized = normalized.replace(/^[\\\/]/, "");

    // Replace path separators with dashes
    normalized = normalized.replace(/[\\\/]/g, "-");

    return normalized;
  }

  /**
   * Read first N events from JSONL log file
   *
   * Helper for session discovery. Reads only the first N lines to avoid
   * parsing entire log file (efficiency optimization).
   *
   * @param filePath - Absolute path to log file
   * @param count - Maximum number of events to read
   * @returns Array of parsed events (up to count)
   *
   * @remarks
   * **Efficiency:**
   * - Only reads first N lines (not entire file)
   * - Stops reading after N valid JSON objects
   * - Skips empty lines
   *
   * **Error Handling:**
   * - Returns empty array if file doesn't exist
   * - Logs parse errors but continues processing
   * - Stops on file read errors
   */
  private async readFirstNEvents(
    filePath: string,
    count: number
  ): Promise<any[]> {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const events: any[] = [];

      for (const line of lines) {
        if (events.length >= count) {
          break;
        }

        const trimmed = line.trim();
        if (!trimmed) {
          continue; // Skip empty lines
        }

        try {
          const event = JSON.parse(trimmed);
          events.push(event);
        } catch (error) {
          // Log parse errors but continue
          Log.debug(
            `[ClaudeLogParser] Failed to parse JSON line: ${trimmed.substring(0, 100)}...`
          );
        }
      }

      return events;
    } catch (error) {
      Log.debug(`[ClaudeLogParser] Error reading file ${filePath}:`, error);
      return [];
    }
  }
}
