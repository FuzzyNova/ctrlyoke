import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent, ILogParser } from "../shared/interfaces/ILogParser";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
  FileEditData,
  FileWriteData,
  ThinkingBlock,
  TextData,
  UnifiedDiffHunk,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { getGeminiContextWindowSize } from "../../../utils/ModelConstants";
import { GeminiToolBuilder } from "./GeminiToolBuilder";

/**
 * A tool call within a Gemini message in the session log file.
 */
interface GeminiLogToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: Array<{
    functionResponse?: {
      id: string;
      name: string;
      response: {
        output?: string;
        error?: string;
      };
    };
  }>;
  status?: "success" | "error";
  timestamp?: string;
  /** String (display text) or object (fileDiff for edits, filePath, newContent for writes) */
  resultDisplay?: string | Record<string, any>;
  displayName?: string;
}

/**
 * A thought block in a Gemini message.
 */
interface GeminiLogThought {
  subject: string;
  description: string;
  timestamp?: string;
}

/**
 * Token usage for a single Gemini turn.
 */
interface GeminiLogTokens {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  total: number;
}

/**
 * A single message in the Gemini session log file.
 *
 * Extends BaseCliEvent with Gemini-specific properties. We don't redeclare
 * `timestamp` so BaseCliEvent's `timestamp?: number` is inherited; the raw
 * ISO string from the JSON is accessed via `_isoTimestamp` to avoid the
 * type conflict while still letting the index signature carry it through.
 */
interface GeminiLogMessage extends BaseCliEvent {
  id?: string;
  type: "user" | "gemini";
  /** For user messages: array of text blocks. For gemini messages: response text string. */
  content?: string | Array<{ text: string }>;
  thoughts?: GeminiLogThought[];
  tokens?: GeminiLogTokens;
  model?: string;
  toolCalls?: GeminiLogToolCall[];
  /** Injected by readNewLines() so extractSessionId() can find it. */
  _sessionId?: string;
}

/**
 * Top-level structure of a Gemini CLI session log file.
 *
 * Located at: `~/.gemini/tmp/<basename(workspaceRoot)>/chats/session-<datetime>-<shortId>.json`
 *
 * Each session creates a single JSON file that is rewritten as new messages arrive.
 * Files are NOT JSONL — they are complete JSON objects.
 */
interface GeminiSessionFile {
  sessionId: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages: GeminiLogMessage[];
  kind?: string;
}

/**
 * Gemini CLI Log Parser
 *
 * Parses Gemini CLI session log files from `~/.gemini/tmp/<project>/chats/`.
 *
 * @remarks
 * **Log Format:**
 * - Location: `~/.gemini/tmp/<basename(workspaceRoot)>/chats/`
 * - File naming: `session-<datetime>-<shortId>.json` (e.g., `session-2026-03-21T00-13-6af853d3.json`)
 * - Format: A SINGLE JSON object (NOT JSONL) rewritten on each new message
 *
 * **Message Types:**
 * - `user`: User input; `content` is `Array<{text}>`.
 * - `gemini`: AI response; `content` is a string, plus optional `thoughts[]`,
 *   `toolCalls[]`, and `tokens{}`.
 *
 * **Tool Call Structure (within gemini messages):**
 * - `id`, `name`, `args` — the call parameters
 * - `result[]` — `functionResponse` objects with `response.output` or `response.error`
 * - `resultDisplay` — string (display text) or `{fileDiff, fileName, filePath}` for edits
 *
 * **Token Accounting:**
 * - Per-turn `tokens.input` / `tokens.output` / `tokens.cached` / `tokens.thoughts`
 * - Accumulated across all turns for total usage
 *
 * **Completion Detection:**
 * - A `gemini` message with no `toolCalls` (or empty array) is the final response
 * - `toolCalls` present → more turns follow
 *
 * **Session Discovery:**
 * - Fast path: match last 8 chars of sessionId against filename suffix before `.json`
 * - Fallback: scan recently modified files, match user message text prefix
 */
export class GeminiLogParser extends BaseLogParser implements ILogParser {
  private workspaceRoot?: string;
  /**
   * Tracks how many messages from the session file have already been returned by
   * readNewLines(). Gemini rewrites the whole JSON file on each turn, so we use
   * a message-count cursor rather than the byte-offset cursor in BaseLogParser.
   */
  private lastProcessedMessageCount = 0;
  /** Cached sessionId read from the last file parse, for extractSessionId(). */
  private cachedSessionId?: string;

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  /**
   * Override BaseLogParser.readNewLines() to handle the Gemini single-JSON-file format.
   *
   * Reads the whole file as JSON on each call, slices only the messages that are
   * newer than those already returned, injects `_sessionId` for tracking, and
   * returns the new messages as BaseCliEvent objects.
   *
   * @param filePath - Absolute path to Gemini session JSON file
   * @returns New GeminiLogMessage objects since last call
   */
  async readNewLines(filePath: string): Promise<BaseCliEvent[]> {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.trim()) {
        return [];
      }

      const sessionData = JSON.parse(content) as GeminiSessionFile;
      const allMessages = sessionData.messages ?? [];

      this.cachedSessionId = sessionData.sessionId;

      // Slice only the messages newer than what we've already seen
      const newMessages = allMessages.slice(this.lastProcessedMessageCount);
      this.lastProcessedMessageCount = allMessages.length;

      // Inject sessionId so extractSessionId() can find it without needing the file path
      if (sessionData.sessionId) {
        for (const msg of newMessages) {
          msg._sessionId = sessionData.sessionId;
        }
      }

      return newMessages as BaseCliEvent[];
    } catch (error) {
      Log.debug(`[GeminiLogParser] Failed to read/parse log file: ${error}`);
      return [];
    }
  }

  /**
   * Extract a complete response from accumulated Gemini log message events.
   *
   * Each event is a GeminiLogMessage (individual message from the messages[] array).
   * Processes all gemini-type messages to build TEXT, THINKING, TOOL_CALL,
   * and TOOL_RESULT events, accumulating token usage across turns.
   */
  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined = this.cachedSessionId;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let totalThoughtTokens = 0;
    let lastTurnTokens: GeminiLogTokens | undefined;
    let model: string | undefined;

    for (const event of events as unknown as GeminiLogMessage[]) {
      // Capture session ID from any event that has it
      if (event._sessionId && !sessionId) {
        sessionId = event._sessionId;
      }

      // Gemini stores timestamps as ISO strings (BaseCliEvent expects number, but index
      // signature carries the actual string value through at runtime)
      const isoTimestamp = event.timestamp as unknown as string | undefined;
      const timestamp = isoTimestamp ? new Date(isoTimestamp).getTime() : Date.now();

      if (event.type === "gemini") {
        // THINKING — thoughts[] blocks before the response text
        if (event.thoughts) {
          for (const thought of event.thoughts) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp,
              data: {
                text: `**${thought.subject}**\n\n${thought.description}`,
                label: thought.subject,
              } as ThinkingBlock,
            });
          }
        }

        // TEXT — the main response content (string, not array)
        if (event.content && typeof event.content === "string" && event.content.trim()) {
          outputEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text: event.content } as TextData,
          });
        }

        // TOOL_CALL + TOOL_RESULT — process each tool call in order
        if (event.toolCalls) {
          for (const tc of event.toolCalls) {
            // Emit INITIATED tool call event
            outputEvents.push(
              GeminiToolBuilder.buildInitiatedEvent(
                tc.name,
                tc.args || {},
                tc.id,
                timestamp
              )
            );

            // Emit TOOL_RESULT event from embedded result
            const funcResponse = tc.result?.[0]?.functionResponse;
            if (funcResponse) {
              const isError = !!funcResponse.response?.error || tc.status === "error";
              outputEvents.push({
                type: CLI_EVENT_TYPES.TOOL_RESULT,
                timestamp,
                data: {
                  toolCallId: tc.id,
                  result: {
                    success: !isError,
                    output: funcResponse.response?.output,
                    error: isError ? (funcResponse.response?.error ?? funcResponse.response?.output) : undefined,
                  },
                },
              });
            }

            // Emit structured FILE_EDIT or FILE_WRITE from resultDisplay when available
            this.emitStructuredResultEvent(tc, timestamp, outputEvents);
          }
        }

        // Accumulate token usage from per-turn tokens{}
        if (event.tokens) {
          const t = event.tokens;
          totalInputTokens += t.input || 0;
          // Output = text tokens + thought tokens (both are billable output)
          totalOutputTokens += (t.output || 0) + (t.thoughts || 0);
          totalCachedTokens += t.cached || 0;
          totalThoughtTokens += t.thoughts || 0;
          lastTurnTokens = t;
        }

        // Model from most recent gemini turn
        if (event.model) {
          model = event.model;
        }
      }
    }

    // Context window state = last turn's input token count (current occupancy)
    const contextWindowUsedTokens = lastTurnTokens
      ? lastTurnTokens.input
      : undefined;

    const tokenUsage: TokenUsage | undefined =
      totalInputTokens > 0 || totalOutputTokens > 0
        ? {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            cachedInputTokens: totalCachedTokens > 0 ? totalCachedTokens : undefined,
            contextWindowUsedTokens,
            contextWindowSize: getGeminiContextWindowSize(model ?? ""),
          }
        : undefined;

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: HARNESS_IDS.GEMINI_CLI,
        usage: tokenUsage,
        ...(totalCachedTokens > 0
          ? { cacheTokens: { read: totalCachedTokens } }
          : {}),
      },
    };
  }

  /**
   * Check if a Gemini log event signals session completion.
   *
   * Completion is detected when a `gemini` message has no `toolCalls`
   * (or an empty array) — if it had tool calls, another turn would follow.
   * `user` messages never signal completion.
   */
  isComplete(event: BaseCliEvent): boolean {
    const msg = event as unknown as GeminiLogMessage;
    if (msg.type !== "gemini") {
      return false;
    }
    // A gemini message with no tool calls is the final response turn
    return !msg.toolCalls || msg.toolCalls.length === 0;
  }

  /**
   * Discover the session log file for a given prompt.
   *
   * **Fast path:** If sessionId is provided, match against the filename suffix
   * (last 8 chars of sessionId before `.json`).
   *
   * **Fallback:** List recently modified JSON files, read the first user message
   * from each, and match against the prompt text prefix.
   *
   * @param promptText - The prompt sent to Gemini CLI (first 100 chars used for matching)
   * @param startTime - Execution start time (filters old files)
   * @param sessionId - Optional session ID from the AfterAgent hook
   * @returns Absolute path to session log file, or null if not found
   */
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    try {
      const chatsDir = this.getGeminiChatsDirectory();
      if (!chatsDir || !fs.existsSync(chatsDir)) {
        Log.debug("[GeminiLogParser] No chats directory found");
        return null;
      }

      Log.debug(`[GeminiLogParser] Searching for session logs in: ${chatsDir}`);

      // FAST PATH: sessionId → match against filename suffix (last 8 chars of UUID)
      if (sessionId) {
        const shortId = sessionId.replace(/-/g, "").slice(0, 8);

        const result = await retryWithBackoff(
          async () => {
            const files = fs.readdirSync(chatsDir);
            // Filename format: session-<datetime>-<shortId>.json
            const match = files.find(
              (f) =>
                f.endsWith(`${shortId}.json`) ||
                f.includes(sessionId.substring(0, 8))
            );
            if (match) {
              const fullPath = path.join(chatsDir, match);
              const stats = fs.statSync(fullPath);
              if (stats.mtime >= startTime) {
                return fullPath;
              }
              // File exists but not yet updated — will retry
            }
            return null;
          },
          {
            onRetry: (attempt, max, delay) => {
              if (attempt > 1) {
                Log.debug(
                  `[GeminiLogParser] Session log not ready (attempt ${attempt}/${max}), retrying in ${delay}ms...`
                );
              }
            },
          }
        );

        if (result) {
          Log.debug(`[GeminiLogParser] Found session log via session ID: ${result}`);
          return result;
        }
      }

      // FALLBACK: scan recently modified files and match by prompt text prefix
      const candidates = this.findModifiedSessionLogs(chatsDir, startTime).filter(
        (p) => p.endsWith(".json")
      );

      if (candidates.length === 0) {
        Log.debug("[GeminiLogParser] No candidate log files found");
        return null;
      }

      Log.debug(`[GeminiLogParser] Found ${candidates.length} candidate log files`);

      const promptPrefix = this.normalizePromptForMatching(
        promptText.substring(0, 100)
      );

      for (const candidatePath of candidates) {
        try {
          const content = fs.readFileSync(candidatePath, "utf-8");
          const sessionData = JSON.parse(content) as GeminiSessionFile;

          // Check the first user message content
          for (const msg of sessionData.messages ?? []) {
            if (msg.type === "user" && Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.text) {
                  const logPrefix = this.normalizePromptForMatching(
                    block.text.substring(0, 100)
                  );
                  if (logPrefix === promptPrefix) {
                    Log.debug(
                      `[GeminiLogParser] Found matching session log: ${candidatePath}`
                    );
                    return candidatePath;
                  }
                }
              }
            }
          }
        } catch (error) {
          Log.debug(
            `[GeminiLogParser] Error reading candidate ${candidatePath}: ${error}`
          );
          continue;
        }
      }

      Log.debug("[GeminiLogParser] No matching session log found");
      return null;
    } catch (error) {
      Log.warn("[GeminiLogParser] Error discovering session log:", error);
      return null;
    }
  }

  /**
   * Extract the session ID from accumulated log events.
   *
   * The session ID is injected into each message event as `_sessionId` by
   * readNewLines(). Falls back to the cached value from the last file read.
   */
  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events) {
      const msg = event as unknown as GeminiLogMessage;
      if (msg._sessionId) {
        return msg._sessionId;
      }
    }
    return this.cachedSessionId ?? null;
  }

  /**
   * Extract displayable text content from a single Gemini log event.
   *
   * Used by CliLogMonitor for streaming text to the output panel as events arrive.
   * Returns the `content` string from `gemini` type messages. Skips user messages
   * and gemini messages that are pure tool-call turns (content likely empty or brief).
   */
  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    const msg = event as unknown as GeminiLogMessage;

    if (msg.type === "gemini" && typeof msg.content === "string") {
      return msg.content || undefined;
    }

    return undefined;
  }

  /**
   * Format Gemini session metadata into a human-readable statistics string.
   *
   * Extends common parts (Session, Model, Tokens) with Gemini-specific fields:
   * - Cache read tokens (from `cacheTokens.read`)
   */
  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata, 8, "...");
    const meta = metadata as Record<string, any>;

    if (meta.cacheTokens?.read > 0) {
      parts.push(`Cache: ${meta.cacheTokens.read} read`);
    }

    return parts.join(" | ");
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Emit a structured FILE_EDIT or FILE_WRITE event from a tool call's resultDisplay.
   *
   * Gemini includes rich result metadata in `resultDisplay` for file operations:
   * - `replace` tool: `{fileDiff, fileName, filePath, originalContent?, newContent?}`
   * - `write_file` tool: `{newContent, fileName, filePath}`
   *
   * When this data is available, we emit semantic events so the dashboard can render
   * line-numbered diffs just as it does for Claude and Qwen.
   */
  private emitStructuredResultEvent(
    tc: GeminiLogToolCall,
    timestamp: number,
    outputEvents: CliEvent[]
  ): void {
    if (!tc.resultDisplay || typeof tc.resultDisplay !== "object") {
      return;
    }

    const rd = tc.resultDisplay as Record<string, any>;
    const succeeded = tc.status === "success";
    const fullPath = (rd.filePath ?? rd.fileName ?? tc.args?.file_path ?? "unknown") as string;

    if (rd.fileDiff) {
      outputEvents.push({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        data: {
          path: fullPath,
          oldContent: rd.originalContent || undefined,
          newContent: rd.newContent || undefined,
          structuredPatch: this.parseUnifiedDiff(rd.fileDiff as string),
          status: OPERATION_STATUS.COMPLETED,
          success: succeeded,
        } as FileEditData,
      });
    } else if (rd.newContent !== undefined) {
      outputEvents.push({
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp,
        data: {
          path: fullPath,
          content: rd.newContent as string,
          status: OPERATION_STATUS.COMPLETED,
          success: succeeded,
        } as FileWriteData,
      });
    }
  }

  /**
   * Parse a unified diff string into structured UnifiedDiffHunk[] for UI rendering.
   *
   * @param diffStr - Unified diff string from `resultDisplay.fileDiff`
   * @returns Array of parsed hunks, empty if no valid hunk headers found
   */
  private parseUnifiedDiff(diffStr: string): UnifiedDiffHunk[] {
    const hunks: UnifiedDiffHunk[] = [];
    const lines = diffStr.split("\n");
    let current: UnifiedDiffHunk | null = null;
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

    for (const line of lines) {
      const match = hunkHeader.exec(line);
      if (match) {
        if (current) {
          hunks.push(current);
        }
        current = {
          oldStart: parseInt(match[1], 10),
          oldLines: match[2] !== undefined ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newLines: match[4] !== undefined ? parseInt(match[4], 10) : 1,
          lines: [],
        };
        continue;
      }

      if (
        current &&
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
      ) {
        current.lines.push(line);
      }
    }

    if (current) {
      hunks.push(current);
    }

    return hunks;
  }

  /**
   * Override BaseLogParser.extractTimestamp() to handle Gemini's ISO string timestamps.
   *
   * Gemini log messages store `timestamp` as an ISO 8601 string (e.g. "2026-03-21T00:13:10.186Z").
   * BaseCliEvent declares `timestamp?: number`, so at the TypeScript level the field appears numeric,
   * but the actual runtime value from JSON.parse is a string. We access it through the index
   * signature to parse it correctly.
   */
  protected override extractTimestamp(entry: BaseCliEvent): Date | null {
    const raw = entry["timestamp"];
    if (raw) {
      const d = new Date(raw as unknown as string);
      if (!isNaN(d.getTime())) {
        return d;
      }
    }
    return null;
  }

  /**
   * Get the Gemini chats directory for the current workspace.
   *
   * Gemini uses the workspace directory's **basename** (not full path) as the
   * project folder name under `~/.gemini/tmp/`.
   *
   * @returns Absolute path to `~/.gemini/tmp/<projectName>/chats/`, or null
   */
  private getGeminiChatsDirectory(): string | null {
    const workspacePath = this.workspaceRoot ?? process.cwd();
    const projectName = path.basename(workspacePath);
    const chatsDir = path.join(os.homedir(), ".gemini", "tmp", projectName, "chats");
    return fs.existsSync(chatsDir) ? chatsDir : null;
  }
}
