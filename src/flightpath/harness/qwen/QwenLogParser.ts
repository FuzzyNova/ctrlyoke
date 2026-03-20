import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent } from "../shared/interfaces/ILogParser";
import { Log } from "../../../utils/Log";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ToolCall,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, HARNESS_IDS, OPERATION_STATUS } from "../../../types/DashboardConstants";
import { CliEventMapper } from "../shared/CliEventMapper";
import { getQwenContextWindowSize } from "../../../utils/ModelConstants";

/**
 * Qwen Code CLI Log Parser
 *
 * Parses Qwen Code CLI log files in JSONL format from `~/.qwen/projects/<workspace-path>/chats/`.
 * Each session creates a `<session-id>.jsonl` file with streaming event entries.
 *
 * @remarks
 * **Log Format:**
 * - Location: `~/.qwen/projects/<sanitized-workspace-path>/chats/`
 * - File naming: `<session-id>.jsonl` (e.g., `uuid-123-abc.jsonl`)
 * - Sanitization: `C:\dev\FlightPath` → `c--dev-flightpath`
 *
 * **Event Types:**
 * 1. `system` - Session initialization with session_id
 * 2. `assistant` - Assistant messages with content blocks (thinking, text, tool_use)
 * 3. `user` - User messages and tool_result blocks
 * 4. `result` - Final statistics with usage, costs, permission_denials
 *
 * **Content Block Types (in assistant/user events):**
 * - `thinking` - Extended thinking (field: `thinking`)
 * - `text` - Response text (field: `text`)
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
 * const parser = new QwenLogParser();
 * const logPath = await parser.discoverSessionLog("Analyze code", new Date());
 * if (logPath) {
 *   const events = await parser.readNewLines(logPath);
 *   const response = parser.extractResponse(events);
 *   const sessionId = parser.extractSessionId(events);
 * }
 * ```
 */

/**
 * Provider-specific event type for internal loop bodies.
 *
 * Extends BaseCliEvent with typed properties for Qwen's log event structure.
 */
interface QwenProviderEvent extends BaseCliEvent {
  message?: Record<string, any>;
  sessionId?: string;
  subtype?: string;
  toolUseResult?: Record<string, any>;
  data?: Record<string, any>;
  result?: string;
  usage?: Record<string, any>;
  model?: string;
  is_error?: boolean;
  errors?: string[];
  permission_denials?: any[];
  session_id?: string;
}

export class QwenLogParser extends BaseLogParser {
  /**
   * Workspace root directory — set by CliIntegration after construction.
   * Used by getQwenProjectDirectory() to locate Qwen's session log folder.
   * Falls back to process.cwd() when not set (CLI mode).
   */
  private workspaceRoot?: string;

  /**
   * Set the workspace root directory for session log discovery.
   * Called by CliIntegration so the log parser knows where to look.
   */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  /**
   * Extract complete response from Qwen log events
   *
   * Processes Qwen JSONL events and combines:
   * - Text content from assistant messages
   * - Tool calls (tool_use events)
   * - Thinking blocks (extended thinking feature)
   * - Tool results from user events
   * - Metadata (session ID, usage stats, model info)
   *
   * @param events - Array of parsed Qwen log events
   * @returns UniversalCliOutput - Standardized response object
   */
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let model: string | undefined;

    for (const event of events as QwenProviderEvent[]) {
      // Extract session ID from any event
      if (event.sessionId && !sessionId) {
        sessionId = event.sessionId;
      }

      // Get timestamp for events
      const timestamp = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();

      // Process assistant messages
      if (event.type === "assistant" && event.message?.content) {
        // Process content blocks in order they appear
        for (const contentBlock of event.message.content) {
          // THINKING - Extract thinking text
          if (contentBlock.type === "thinking" && contentBlock.thinking) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp,
              data: {
                text: contentBlock.thinking,
                label: "Extended Thinking",
              },
            });
          }

          // TEXT - Extract text content
          if (contentBlock.type === "text" && contentBlock.text) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp,
              data: {
                text: contentBlock.text,
              },
            });
          }

          // TOOL_USE - Map to semantic event types
          if (contentBlock.type === "tool_use") {
            outputEvents.push(
              this.buildToolInitiatedEvent(
                contentBlock.name,
                contentBlock.input || {},
                contentBlock.id,
                timestamp
              )
            );
          }
        }

        // Extract usage stats
        if (event.message.usage) {
          const usage = event.message.usage;
          totalInputTokens += usage.input_tokens || 0;
          totalOutputTokens += usage.output_tokens || 0;
        }

        // Extract model info
        if (event.message.model && !model) {
          model = event.message.model;
        }
      }

      // Process user events for tool results
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const contentBlock of event.message.content) {
          if (contentBlock.type === "tool_result") {
            outputEvents.push({
              type: CLI_EVENT_TYPES.TOOL_RESULT,
              timestamp,
              data: {
                toolCallId: contentBlock.tool_call_id,
                result: {
                  success: !contentBlock.is_error,
                  output: contentBlock.content,
                  error: contentBlock.is_error ? contentBlock.content : undefined,
                },
              },
            });
          }
        }
      }

      // Process result event for final metadata
      if (event.type === "result") {
        if (event.session_id) {
          sessionId = event.session_id;
        }
        if (event.usage) {
          totalInputTokens = event.usage.input_tokens || 0;
          totalOutputTokens = event.usage.output_tokens || 0;
        }
        if (event.model && !model) {
          model = event.model;
        }
        if (event.permission_denials && event.permission_denials.length > 0) {
          Log.warn(
            `[QwenLogParser] Permission denials: ${JSON.stringify(event.permission_denials)}`
          );
        }
      }
    }

    // Build token usage
    const tokenUsage: TokenUsage | undefined =
      totalInputTokens > 0 || totalOutputTokens > 0
        ? {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            contextWindowUsedTokens: totalInputTokens + totalOutputTokens,
            contextWindowSize: getQwenContextWindowSize(model ?? ""),
          }
        : undefined;

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: HARNESS_IDS.QWEN_CLI,
        usage: tokenUsage,
      },
    };
  }

  /**
   * Build a tool initiated event with semantic type mapping
   *
   * Maps Qwen functionCall format to FlightPath semantic event types.
   *
   * @param toolName The tool name (e.g., "Bash", "Write", "Read")
   * @param toolInput The tool input parameters
   * @param toolCallId The tool call ID
   * @param timestamp Event timestamp
   * @returns Structured CLI event
   */
  private buildToolInitiatedEvent(
    toolName: string,
    toolInput: any,
    toolCallId: string,
    timestamp: number
  ): CliEvent {
    // Use CliEventMapper for consistent tool classification
    const classification = CliEventMapper.classifyTool(toolName);
    const path = (toolInput.path ?? toolInput.file_path) as string | undefined;

    switch (classification.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp,
          data: {
            command:
              ((toolInput.command ?? toolInput.cmd) as string | undefined) ||
              "unknown",
            workingDir: (toolInput.working_dir ??
              toolInput.cwd ??
              toolInput.workingDir) as string | undefined,
            status: OPERATION_STATUS.INITIATED,
          } as BashCommandData,
        };

      case CLI_EVENT_TYPES.FILE_READ:
        return {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path: path || "unknown",
            status: OPERATION_STATUS.INITIATED,
          } as FileReadData,
        };

      case CLI_EVENT_TYPES.FILE_WRITE:
        return {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp,
          data: {
            path: path || "unknown",
            content:
              ((toolInput.content ?? toolInput.file_text) as string | undefined) ||
              "",
            status: OPERATION_STATUS.INITIATED,
          } as FileWriteData,
        };

      case CLI_EVENT_TYPES.FILE_EDIT: {
        const oldContent = (
          toolInput.oldString ??
          toolInput.old_string ??
          toolInput.oldContent ??
          toolInput.old_content ??
          toolInput.old_str
        ) as string | undefined;
        const newContent = (
          toolInput.newString ??
          toolInput.new_string ??
          toolInput.newContent ??
          toolInput.new_content ??
          toolInput.new_str
        ) as string | undefined;
        return {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: path || "unknown",
            oldContent,
            newContent,
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData,
        };
      }

      case CLI_EVENT_TYPES.FILE_DELETE:
        return {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp,
          data: {
            path: path || "unknown",
          } as FileDeleteData,
        };

      case CLI_EVENT_TYPES.WEB_SEARCH:
        return {
          type: CLI_EVENT_TYPES.WEB_SEARCH,
          timestamp,
          data: {
            query: (toolInput.query as string) || "",
          } as WebSearchData,
        };

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const mcp = classification as {
          type: typeof CLI_EVENT_TYPES.MCP_TOOL_CALL;
          server: string;
          tool: string;
        };
        return {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          timestamp,
          data: {
            server: mcp.server,
            tool: mcp.tool,
            parameters: toolInput,
          } as McpToolCallData,
        };
      }

      default:
        // Generic TOOL_CALL fallback
        return {
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: toolName,
            parameters: toolInput,
            id: toolCallId,
          } as ToolCall,
        };
    }
  }

  /**
   * Check if event indicates completion
   *
   * Qwen events are complete when:
   * - Event type is "result" (final statistics)
   * - OR assistant event with stop_reason (not null/undefined)
   *
   * @param event - Single parsed Qwen log event
   * @returns True if event signals completion
   */
  isComplete(event: BaseCliEvent): boolean {
    // Result event indicates final completion
    if (event.type === "result") {
      return true;
    }

    // Assistant event with stop_reason indicates turn completion
    if (event.type === "assistant") {
      const e = event as QwenProviderEvent;
      const stopReason = e.message?.stop_reason;
      // stop_reason null/undefined means still streaming
      if (stopReason !== null && stopReason !== undefined) {
        return true;
      }
    }

    return false;
  }

  /**
   * Discover session log file for a prompt
   *
   * Searches Qwen project directory for log file matching session ID or prompt text.
   *
   * @param promptText - The prompt text sent to Qwen CLI (used for matching if no sessionId)
   * @param startTime - Execution start timestamp (used to filter candidates)
   * @param sessionId - Optional session ID (not typically available from hooks for Qwen)
   * @returns Absolute path to session log file, or null if not found
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    try {
      // Get Qwen project directory for current workspace
      const projectDir = this.getQwenProjectDirectory();
      if (!projectDir) {
        Log.debug("[QwenLogParser] No Qwen project directory found");
        return null;
      }

      const chatsDir = path.join(projectDir, "chats");

      // Check if chats directory exists
      if (!fs.existsSync(chatsDir)) {
        Log.debug("[QwenLogParser] No chats directory found");
        return null;
      }

      Log.debug(`[QwenLogParser] Searching for session logs in: ${chatsDir}`);

      // FAST PATH: If session ID provided, construct direct file path
      if (sessionId) {
        const logPath = path.join(chatsDir, `${sessionId}.jsonl`);

        if (fs.existsSync(logPath)) {
          const stats = fs.statSync(logPath);
          if (stats.mtime >= startTime) {
            Log.debug(
              `[QwenLogParser] Found session log via session ID: ${logPath}`
            );
            return logPath;
          } else {
            Log.debug(
              `[QwenLogParser] Session log exists but not recent (mtime: ${stats.mtime})`
            );
          }
        }
      }

      // FALLBACK: Get candidate log files modified after startTime
      const candidates = this.findModifiedSessionLogs(chatsDir, startTime);
      if (candidates.length === 0) {
        Log.debug("[QwenLogParser] No candidate log files found");
        return null;
      }

      Log.debug(
        `[QwenLogParser] Found ${candidates.length} candidate log files`
      );

      // Prepare prompt text for matching (first 100 chars)
      const promptPrefix = this.normalizePromptForMatching(
        promptText.substring(0, 100)
      );

      // Check each candidate for matching prompt text
      for (const candidatePath of candidates) {
        try {
          // Read first 10 events from log file
          const events = await this.readFirstNJsonlEvents(candidatePath, 10);

          // Look for user event with matching prompt text
          for (const event of events as QwenProviderEvent[]) {
            if (event.type === "user" && event.message?.content) {
              for (const contentBlock of event.message.content) {
                if (contentBlock.type === "text" && contentBlock.text) {
                  const logPromptPrefix = this.normalizePromptForMatching(
                    contentBlock.text.substring(0, 100)
                  );
                  if (logPromptPrefix === promptPrefix) {
                    Log.debug(
                      `[QwenLogParser] Found matching session log: ${candidatePath}`
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
            `[QwenLogParser] Error reading candidate ${candidatePath}:`,
            error
          );
          continue;
        }
      }

      Log.debug("[QwenLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.warn("[QwenLogParser] Error discovering session log:", error);
      return null;
    }
  }

  /**
   * Extract session ID from log events
   *
   * Searches events for first entry with sessionId field.
   *
   * @param events - Array of parsed Qwen log events
   * @returns Session ID (UUID format), or null if not found
   */
  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events) {
      if ((event as QwenProviderEvent).sessionId) {
        return (event as QwenProviderEvent).sessionId as string;
      }
    }
    return null;
  }

  /**
   * Extract text content from a single Qwen log event for streaming
   *
   * @param event - Single parsed Qwen log event
   * @returns Text content to display, or undefined if no displayable content
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    const e = event as QwenProviderEvent;

    // Qwen assistant: Extract text from content array
    if (e.type === "assistant" && e.message?.content) {
      const textContent = e.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      return textContent || undefined;
    }

    return undefined;
  }

  /**
   * Format Qwen metadata into statistics string
   *
   * @param metadata - Metadata from extractResponse() (sessionId, model, usage)
   * @returns Formatted statistics string
   */
  formatStatistics(metadata: BaseCliEvent): string {
    return this.buildCommonStatisticsParts(metadata).join(" | ");
  }

  /**
   * Get Qwen project directory for current workspace
   *
   * Resolves to `~/.qwen/projects/<sanitized-workspace-path>/`
   *
   * @returns Absolute path to Qwen project directory, or null if no workspace
   *
   * @remarks
   * **Path Sanitization:**
   * - Replaces path separators and colons with dashes
   * - Lowercases the path
   * - Example: `/Users/name/dev/FlightPath` → `--users-name-dev-flightpath`
   * - Windows: `C:\dev\FlightPath` → `c--dev-flightpath`
   */
  private getQwenProjectDirectory(): string | null {
    // Use stored workspaceRoot (set by CliIntegration) or fall back to process.cwd()
    const workspacePath = this.workspaceRoot || process.cwd();

    if (!workspacePath) {
      return null;
    }

    // Sanitize workspace path for Qwen's naming convention
    const sanitizedPath = workspacePath
      .toLowerCase()
      .replace(/[:\\]/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    const baseDir = path.join(os.homedir(), ".qwen", "projects");
    const projectDir = path.join(baseDir, sanitizedPath);

    Log.debug(
      `[QwenLogParser] Project directory: ${projectDir} (from ${workspacePath})`
    );

    return fs.existsSync(projectDir) ? projectDir : null;
  }
}
