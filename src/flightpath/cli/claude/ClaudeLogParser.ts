import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { BaseLogParser } from "../shared/BaseLogParser";
import { ILogParser } from "../shared/interfaces/ILogParser";
import { Log } from "../../../utils/Log";
import {
  retryWithBackoff,
  PermanentFailureError,
} from "../../../utils/RetryUtils";
import {
  UniversalCliOutput,
  ToolCall,
  ThinkingBlock,
  CliEvent,
  TextData,
  ToolResultData,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  CLI_EVENT_TYPES,
} from "../../../types/CliOutputTypes";
import { OPERATION_STATUS } from "../../../types/DashboardConstants";

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
 * **Event Types (6 main types):**
 * 1. `assistant` - Claude responses with text, thinking, tool_use blocks
 * 2. `user` - User messages and tool_result blocks
 * 3. `progress` - Hook progress, bash progress, agent progress
 * 4. `system` - stop_hook_summary, turn_duration, local_command
 * 5. `file-history-snapshot` - File backup tracking
 * 6. `summary` - Session summary
 *
 * **Content Block Types (in assistant/user events):**
 * - `text` - Response text (field: `text`)
 * - `thinking` - Extended thinking (field: `thinking`, NOT `text`)
 * - `tool_use` - Tool invocation (fields: `id`, `name`, `input`)
 * - `tool_result` - Tool execution result (in user events)
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
   * - Tool calls (tool_use events) with normalized 'parameters' field
   * - Thinking blocks (extended thinking feature)
   * - Tool results from user events (both content and structured metadata)
   * - Metadata (session ID, usage stats including cache tokens, model info)
   *
   * @param events - Array of parsed Claude log events
   * @returns UniversalCliOutput - Standardized response object
   *
   * @remarks
   * **Event Types Processed:**
   * - `assistant` - Claude responses with content blocks
   * - `user` - Tool results (tool_result blocks + toolUseResult metadata)
   * - `progress` - Bash progress (extracted for streaming display)
   * - `system` - Turn duration (for metadata)
   *
   * **Content Block Types:**
   * - `text` - Response text (field: `text`)
   * - `thinking` - Extended thinking (field: `thinking`, NOT `text`)
   * - `tool_use` - Tool invocation (fields: `id`, `name`, `input`)
   * - `tool_result` - Tool execution result (in user events)
   *
   * **Tool Result Metadata (toolUseResult field):**
   * - Edit operations: Extracts `structuredPatch` for line-number-based diffs
   * - Edit operations: Extracts `originalFile` for full file context
   * - Edit operations: Supports both camelCase (oldString) and snake_case (old_string)
   * - Write operations: Extracts file creation metadata
   * - Read operations: Extracts file read results
   *
   * **Usage Statistics:**
   * - Standard: input_tokens, output_tokens
   * - Cache: cache_creation_input_tokens, cache_read_input_tokens
   * - Service tier: "standard" or other tier identifiers
   *
   * @example
   * ```typescript
   * const events = [
   *   { type: "assistant", message: { content: [{type: "text", text: "Hello"}] }, sessionId: "abc" },
   *   { type: "user", message: { content: [{type: "tool_result", tool_use_id: "123", content: "result"}] },
   *     toolUseResult: { oldString: "old", newString: "new", structuredPatch: [...] } },
   *   { type: "assistant", message: { stop_reason: "end_turn", usage: {...} } }
   * ];
   * const response = parser.extractResponse(events);
   * // { events: [...], metadata: { sessionId, usage: {...}, cacheTokens: {...} } }
   * ```
   */
  extractResponse(events: any[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let model: string | undefined;
    let turnDurationMs: number | undefined;

    for (const event of events) {
      // Extract session ID from any event
      if (event.sessionId && !sessionId) {
        sessionId = event.sessionId;
      }

      // Get timestamp for events
      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // Process assistant messages (Claude responses)
      if (event.type === "assistant" && event.message?.content) {
        // Process content blocks in order they appear
        for (const contentBlock of event.message.content) {
          // TEXT - Extract text content
          if (contentBlock.type === "text" && contentBlock.text) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp,
              data: {
                text: contentBlock.text,
              } as TextData,
            });
          }

          // THINKING - Note: field is 'thinking' NOT 'text'
          if (contentBlock.type === "thinking" && contentBlock.thinking) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp,
              data: {
                text: contentBlock.thinking,
                label: "Extended Thinking",
              } as ThinkingBlock,
            });
          }

          // TOOL_USE - Map Claude tools to semantic event types
          if (contentBlock.type === "tool_use") {
            const toolName = contentBlock.name;
            const input = contentBlock.input || {};

            // Map Claude-specific tool names to semantic event types
            if (toolName === "bash" || toolName === "shell") {
              // Bash command execution (INITIATED event)
              outputEvents.push({
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                timestamp,
                data: {
                  command: input.command || "unknown",
                  workingDir: input.working_dir || input.cwd,
                  status: OPERATION_STATUS.INITIATED,
                } as BashCommandData,
              });
            } else if (toolName === "write") {
              // File write (create new file)
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_WRITE,
                timestamp,
                data: {
                  path: input.path || "unknown",
                  content: input.content || "",
                  status: OPERATION_STATUS.INITIATED,
                } as FileWriteData,
              });
            } else if (toolName === "edit" || toolName === "apply_patch") {
              // File edit (modify existing file)
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_EDIT,
                timestamp,
                data: {
                  path: input.path || "unknown",
                  oldContent: input.old_content || input.old_str,
                  newContent: input.new_content || input.new_str,
                  status: OPERATION_STATUS.INITIATED,
                } as FileEditData,
              });
            } else if (toolName === "read" || toolName === "read_file") {
              // File read
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_READ,
                timestamp,
                data: {
                  path: input.path || "unknown",
                  status: OPERATION_STATUS.INITIATED,
                } as FileReadData,
              });
            } else if (toolName === "delete" || toolName === "delete_file") {
              // File delete
              outputEvents.push({
                type: CLI_EVENT_TYPES.FILE_DELETE,
                timestamp,
                data: {
                  path: input.path || "unknown",
                } as FileDeleteData,
              });
            } else if (
              toolName.includes("search") ||
              toolName === "web_search"
            ) {
              // Web search
              outputEvents.push({
                type: CLI_EVENT_TYPES.WEB_SEARCH,
                timestamp,
                data: {
                  query: input.query || "",
                } as WebSearchData,
              });
            } else if (toolName.includes("mcp_") || input.server) {
              // MCP tool call (has server field)
              outputEvents.push({
                type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
                timestamp,
                data: {
                  server: input.server || "unknown",
                  tool: toolName,
                  parameters: input,
                } as McpToolCallData,
              });
            } else {
              // Unknown tool - fallback to generic TOOL_CALL
              outputEvents.push({
                type: CLI_EVENT_TYPES.TOOL_CALL,
                timestamp,
                data: {
                  name: toolName,
                  parameters: input,
                  id: contentBlock.id,
                } as ToolCall,
              });
            }
          }
        }

        // Extract usage stats (including cache tokens)
        if (event.message.usage) {
          const usage = event.message.usage;
          totalInputTokens += usage.input_tokens || 0;
          totalOutputTokens += usage.output_tokens || 0;
          cacheCreationTokens += usage.cache_creation_input_tokens || 0;
          cacheReadTokens += usage.cache_read_input_tokens || 0;
        }

        // Extract model info
        if (event.message.model && !model) {
          model = event.message.model;
        }
      }

      // Process user events for TOOL_RESULT blocks
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "tool_result") {
            outputEvents.push({
              type: CLI_EVENT_TYPES.TOOL_RESULT,
              timestamp,
              data: {
                toolCallId: block.tool_use_id,
                result: {
                  success: !block.is_error,
                  output:
                    typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content),
                  error: block.is_error
                    ? typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content)
                    : undefined,
                },
              } as ToolResultData,
            });
          }
        }

        // Process structured tool_use_result metadata for rich diff data
        // This contains accurate line numbers and full file context for Edit operations
        if (event.toolUseResult) {
          const toolUseResult = event.toolUseResult;

          // File edit result (Edit tool) - check both camelCase and snake_case
          // Headless mode uses camelCase (oldString/newString)
          // Interactive terminal uses snake_case (old_string/new_string)
          const oldString = toolUseResult.oldString || toolUseResult.old_string;
          const newString = toolUseResult.newString || toolUseResult.new_string;

          if (oldString && newString) {
            Log.debug(
              `[ClaudeLogParser] Edit operation - oldString=${oldString ? "present" : "missing"}, newString=${newString ? "present" : "missing"}, structuredPatch=${toolUseResult.structuredPatch ? `${toolUseResult.structuredPatch.length} hunks` : "missing"}`
            );

            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_EDIT,
              timestamp,
              data: {
                path: toolUseResult.filePath || "unknown",
                oldContent: oldString,
                newContent: newString,
                structuredPatch: toolUseResult.structuredPatch,
                originalFile: toolUseResult.originalFile,
                userModified: toolUseResult.userModified,
                replaceAll: toolUseResult.replaceAll,
                status: OPERATION_STATUS.COMPLETED,
                success: true,
              } as FileEditData,
            });
          }
          // File write result (Write tool)
          // Must have a file path to avoid matching Grep results (which also have a `content` field)
          else if (
            (toolUseResult.type === "create" || toolUseResult.content) &&
            (toolUseResult.filePath || toolUseResult.path)
          ) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_WRITE,
              timestamp,
              data: {
                path: toolUseResult.filePath || toolUseResult.path || "unknown",
                content: toolUseResult.content || "",
                status: OPERATION_STATUS.COMPLETED,
                success: true,
              } as FileWriteData,
            });
          }
          // File read result (Read tool)
          else if (toolUseResult.type === "text" && toolUseResult.file) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.FILE_READ,
              timestamp,
              data: {
                path: toolUseResult.file.filePath || "unknown",
                content: toolUseResult.file.content || "",
                status: OPERATION_STATUS.COMPLETED,
                success: true,
              } as FileReadData,
            });
          }
          // Bash command result
          else if (toolUseResult.command || toolUseResult.type === "bash") {
            const exitCode =
              toolUseResult.exitCode ?? (toolUseResult.error ? 1 : 0);
            outputEvents.push({
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              timestamp,
              data: {
                command: toolUseResult.command || "unknown",
                workingDir: toolUseResult.workingDir || toolUseResult.cwd,
                exitCode,
                output: toolUseResult.output || toolUseResult.stdout,
                error: toolUseResult.error || toolUseResult.stderr,
                status:
                  exitCode === 0
                    ? OPERATION_STATUS.COMPLETED
                    : OPERATION_STATUS.FAILED,
              } as BashCommandData,
            });
          }
        }
      }

      // Process system events for turn duration
      if (event.type === "system" && event.subtype === "turn_duration") {
        turnDurationMs = event.durationMs;
      }
    }

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: "claude-cli",
        elapsed: turnDurationMs,
        usage:
          totalInputTokens > 0 || totalOutputTokens > 0
            ? {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
                // Extended cache token info stored in custom fields
                // These will be displayed in formatStatistics()
              }
            : undefined,
        // Store cache tokens as additional metadata for cost calculation
        ...(cacheCreationTokens > 0 || cacheReadTokens > 0
          ? {
              cacheTokens: {
                created: cacheCreationTokens,
                read: cacheReadTokens,
              },
            }
          : {}),
      },
    };
  }

  /**
   * Check if event indicates completion
   *
   * Claude events are complete when:
   * - Event type is "assistant"
   * - message.stop_reason is not null AND not "tool_use"
   *
   * @param event - Single parsed Claude log event
   * @returns True if event signals final completion
   *
   * @remarks
   * **Stop Reason Values:**
   * - `null` - Still streaming (NOT complete)
   * - `"end_turn"` - Normal completion ✓ COMPLETE
   * - `"max_tokens"` - Token limit reached ✓ COMPLETE
   * - `"stop_sequence"` - Stop sequence encountered ✓ COMPLETE
   * - `"tool_use"` - Stopped to execute tools (intermediate, NOT final)
   *
   * **Important:** `tool_use` stop reason is NOT a final completion.
   * Claude stops to let the tool execute, then continues after receiving
   * the tool_result. Only treat as complete when stop_reason indicates
   * the turn is truly finished.
   *
   * @example
   * ```typescript
   * // Final completion
   * const event = { type: "assistant", message: { stop_reason: "end_turn" } };
   * if (parser.isComplete(event)) {
   *   // Response is complete - stop watching
   * }
   *
   * // Intermediate (tool execution)
   * const toolEvent = { type: "assistant", message: { stop_reason: "tool_use" } };
   * if (!parser.isComplete(toolEvent)) {
   *   // Keep watching - Claude will continue after tool result
   * }
   * ```
   */
  isComplete(event: any): boolean {
    // Must be an assistant event with a stop_reason
    if (event.type !== "assistant") {
      return false;
    }

    const stopReason = event.message?.stop_reason;

    // Still streaming if stop_reason is null/undefined
    if (stopReason === null || stopReason === undefined) {
      return false;
    }

    // "tool_use" is NOT a final completion - Claude paused to execute tools
    // and will continue after receiving tool_result
    if (stopReason === "tool_use") {
      return false;
    }

    // All other stop reasons indicate final completion:
    // - "end_turn" - Normal completion
    // - "max_tokens" - Token limit reached
    // - "stop_sequence" - Stop sequence encountered
    return true;
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
            // Uses default: 10s
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
      // Normalize for path escaping: Claude may escape backslashes in file paths
      const promptPrefix = this.normalizePromptForMatching(
        promptText.substring(0, 100)
      );

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
                  const logPromptPrefix = this.normalizePromptForMatching(
                    contentBlock.text.substring(0, 100)
                  );
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
   * **Supported Event Types:**
   * - `assistant` - Extract text from content blocks
   * - `progress` (bash_progress) - Extract bash output for real-time display
   *
   * **Claude Event Formats:**
   * - Assistant: `{ type: "assistant", message: { content: [{ type: "text", text: "..." }] } }`
   * - Bash Progress: `{ type: "progress", data: { type: "bash_progress", output: "...", fullOutput: "..." } }`
   */
  extractContentFromEvent(event: any): string | undefined {
    // Claude assistant: Extract text from content array
    if (event.type === "assistant" && event.message?.content) {
      const textContent = event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      return textContent || undefined;
    }

    // Bash progress: Extract output for streaming display
    if (event.type === "progress" && event.data?.type === "bash_progress") {
      // Prefer incremental output over fullOutput for streaming
      return event.data.output || event.data.fullOutput || undefined;
    }

    return undefined;
  }

  /**
   * Format Claude metadata into statistics string
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage, cacheTokens)
   * @returns Formatted statistics string
   *
   * @remarks
   * **Metadata Fields:**
   * - `sessionId` - Session UUID (truncated to 8 chars for display)
   * - `model` - Model name (e.g., "claude-sonnet-4-5-20250929")
   * - `usage` - Token counts (input, output, total)
   * - `cacheTokens` - Cache token counts (created, read) for cost optimization
   * - `elapsed` - Turn duration in milliseconds
   *
   * @example
   * ```typescript
   * const metadata = {
   *   sessionId: "abc-123",
   *   model: "claude-sonnet-4.5",
   *   usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
   *   cacheTokens: { created: 1000, read: 500 },
   *   elapsed: 2500
   * };
   * const stats = parser.formatStatistics(metadata);
   * // "Session: abc-123 | Model: claude-sonnet-4.5 | Tokens: 100 in / 50 out | Cache: 1000 created, 500 read | Duration: 2.5s"
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
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        parts.push(
          `Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`
        );
      }
    }

    // Cache tokens (important for cost calculation)
    if (metadata.cacheTokens) {
      const cache = metadata.cacheTokens;
      const cacheParts: string[] = [];
      if (cache.created > 0) {
        cacheParts.push(`${cache.created} created`);
      }
      if (cache.read > 0) {
        cacheParts.push(`${cache.read} read`);
      }
      if (cacheParts.length > 0) {
        parts.push(`Cache: ${cacheParts.join(", ")}`);
      }
    }

    // Turn duration
    if (metadata.elapsed) {
      const seconds = (metadata.elapsed / 1000).toFixed(1);
      parts.push(`Duration: ${seconds}s`);
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
