import * as fs from "fs";
import {
  UniversalCliOutput,
  CliEvent,
  ToolCall,
  FileWriteData,
  FileEditData,
  FileReadData,
  BashCommandData,
  FileDeleteData,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";

/**
 * Chat session file structure (top-level)
 */
export interface ChatSessionFile {
  version: number;
  sessionId: string;
  requests: ChatRequest[];
  creationDate: number;
  lastMessageDate: number;
}

/**
 * Individual request/response in a chat session
 */
export interface ChatRequest {
  requestId: string;
  message: { text: string };
  response: ChatResponseItem[];
  modelId: string;
  result: {
    timings: { totalElapsed: number; firstProgress?: number };
    metadata?: {
      toolCallRounds?: Array<{
        response: string;
        toolCalls: Array<{
          name: string;
          arguments: string;
          id: string;
        }>;
        thinking?: { text: string | string[]; tokens?: number };
      }>;
      sessionId?: string;
      modelMessageId?: string;
    };
    errorDetails?: { message: string; code: string };
  };
}

/**
 * Response item types in chat session
 */
export interface ChatResponseItem {
  // Item type (omitted for text responses)
  kind?:
    | "thinking"
    | "toolInvocationSerialized"
    | "prepareToolInvocation"
    | "mcpServersStarting"
    | "inlineReference"
    | "textEditGroup"
    | "codeblockUri"
    | "undoStop";

  // Text response or thinking content
  value?: string | string[];

  // Thinking block metadata
  id?: string;
  metadata?: {
    vscodeReasoningDone?: boolean;
    stopReason?: string;
  };

  // Tool call metadata
  toolName?: string;
  toolId?: string;
  toolCallId?: string;
  invocationMessage?: { value: string };
  pastTenseMessage?: { value: string };
  isComplete?: boolean;

  // inlineReference: file/symbol chip embedded in text stream
  inlineReference?: { fsPath?: string; path?: string; external?: string };

  // Other fields
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: any;
}

/**
 * Chat session file parser
 *
 * Extracts structured output from Copilot Chat session JSON files.
 * Converts Chat session format to UniversalCliOutput for consistent
 * processing across CLI and Chat harnesses.
 *
 * Session files are the single source of truth for Chat responses,
 * replacing the unreliable clipboard-based approach.
 */
export class ChatSessionParser {
  /**
   * Parse a session file in either JSON (.json) or JSONL (.jsonl) format.
   *
   * JSONL format (VS Code switched ~Feb 2026) is a delta/patch log:
   *   kind 0  — base snapshot: {"kind":0,"v":{...session without result/response...}}
   *   kind 1  — set:    {"kind":1,"k":["requests",0,"result"],"v":{...}}
   *   kind 2  — append: {"kind":2,"k":["requests",0,"response"],"v":[...items...],"i":N}
   *
   * All lines are replayed in order to reconstruct the full session state.
   */
  /**
   * Parse a session file in either JSON (.json) or JSONL (.jsonl) format.
   * Static so ChatSessionMonitor can reuse without duplicating JSONL logic.
   */
  static parseSessionFile(filePath: string): ChatSessionFile | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (filePath.endsWith(".jsonl")) {
        return ChatSessionParser.replayJsonl(content);
      }
      return JSON.parse(content) as ChatSessionFile;
    } catch {
      return null;
    }
  }

  private static replayJsonl(content: string): ChatSessionFile | null {
    const lines = content.split("\n").filter((l) => l.trim());
    if (!lines.length) {
      return null;
    }
    const first = JSON.parse(lines[0]) as { kind: number; v: any };
    if (first.kind !== 0 || !first.v) {
      return null;
    }
    const state: any = first.v;
    if (!state.requests) {
      state.requests = [];
    }
    for (const req of state.requests) {
      if (!req.response) {
        req.response = [];
      }
    }
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) {
        continue;
      }
      const patch = JSON.parse(lines[i]) as {
        kind: number;
        k: (string | number)[];
        v: any;
      };
      if (patch.kind === 1) {
        ChatSessionParser.jsonlSetAtPath(state, patch.k, patch.v);
      } else if (patch.kind === 2) {
        ChatSessionParser.jsonlAppendAtPath(state, patch.k, patch.v);
      }
    }

    // Defensive: ensure requests is still an array after replay
    // (malformed patches could overwrite it with a non-array value)
    if (!Array.isArray(state.requests)) {
      Log.warn("JSONL replay produced non-array requests, resetting to empty");
      state.requests = [];
    }

    return state as ChatSessionFile;
  }

  private static jsonlSetAtPath(
    obj: any,
    keyPath: (string | number)[],
    value: unknown
  ): void {
    if (!keyPath?.length) {
      return;
    }
    let current: any = obj;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      if (current[key] == null) {
        current[key] = typeof keyPath[i + 1] === "number" ? [] : {};
      }
      current = current[key];
    }
    current[keyPath[keyPath.length - 1]] = value;
  }

  private static jsonlAppendAtPath(
    obj: any,
    keyPath: (string | number)[],
    items: unknown[]
  ): void {
    if (!keyPath?.length || !Array.isArray(items)) {
      return;
    }
    let current: any = obj;
    for (let i = 0; i < keyPath.length; i++) {
      const key = keyPath[i];
      if (i === keyPath.length - 1) {
        if (!Array.isArray(current[key])) {
          current[key] = [];
        }
        current[key].push(...items);
      } else {
        if (current[key] == null) {
          current[key] = typeof keyPath[i + 1] === "number" ? [] : {};
        }
        current = current[key];
      }
    }
  }

  /**
   * Extract response from session file
   * @param sessionFilePath Path to session JSON file or JSONL file
   * @param requestIndex Index of request (-1 = last request)
   * @returns UniversalCliOutput with events and metadata
   */
  extractResponse(
    sessionFilePath: string,
    requestIndex: number = -1
  ): UniversalCliOutput {
    try {
      // Read and parse session file (supports .json and .jsonl)
      const session = ChatSessionParser.parseSessionFile(sessionFilePath);

      if (!session) {
        // File doesn't exist or couldn't be parsed — surface as error event
        throw new Error(`session file could not be read or parsed`);
      }

      if (!session.requests || session.requests.length === 0) {
        Log.warn("Session file has no requests");
        return this.createEmptyOutput(session.sessionId ?? "unknown");
      }

      // Get target request
      const actualIndex =
        requestIndex === -1 ? session.requests.length - 1 : requestIndex;
      const request = session.requests[actualIndex];

      if (!request) {
        throw new Error(`Request index ${actualIndex} not found`);
      }

      // Convert to UniversalCliOutput
      return this.convertToUniversalOutput(request, session.sessionId);
    } catch (error) {
      Log.error(`Failed to parse session file: ${sessionFilePath}`, error);
      return {
        events: [
          {
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: Date.now(),
            data: { text: `Failed to parse session file: ${error}` },
          },
        ],
        metadata: {
          sessionId: this.extractSessionId(sessionFilePath),
          model: "unknown",
          harness: "copilot-chat",
        },
      };
    }
  }

  /**
   * Convert ChatRequest to UniversalCliOutput
   */
  private convertToUniversalOutput(
    request: ChatRequest,
    sessionId: string
  ): UniversalCliOutput {
    const events: CliEvent[] = [];
    const timestamp = Date.now();

    // Process response items in order
    for (const item of request.response) {
      if (item.kind === "thinking") {
        // Thinking block - skip encrypted content
        const thinkingText = this.extractThinkingText(item.value);
        if (thinkingText) {
          events.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: { text: thinkingText },
          });
        }
      } else if (item.kind === "toolInvocationSerialized") {
        // Tool call - initial event (arguments added later from metadata)
        const toolName = item.toolId || item.toolName || "unknown_tool";
        events.push({
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: toolName,
            parameters: {}, // Populated from metadata below
            id: item.toolCallId || "",
          },
        });
      } else if (item.kind === "inlineReference") {
        // File/symbol chip embedded inline in text — emit the filename as backtick text
        const ref = item.inlineReference;
        const fsPath = ref?.fsPath || ref?.path || "";
        const fileName = fsPath.replace(/.*[/\\]/, ""); // basename
        if (fileName) {
          events.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text: `\`${fileName}\`` },
          });
        }
      } else if (
        item.kind === "prepareToolInvocation" ||
        item.kind === "mcpServersStarting" ||
        item.kind === "textEditGroup" ||
        item.kind === "codeblockUri" ||
        item.kind === "undoStop"
      ) {
        // VS Code UI structural items — informational only, not included as events
        Log.debug(
          `Skipping structural item: ${item.kind}`,
          "ChatSessionParser"
        );
      } else if (!item.kind && item.value) {
        // Text response (no "kind" field means it's a text response)
        const textContent =
          typeof item.value === "string" ? item.value : item.value.join("\n");
        // Filter VS Code code-fence artifacts: text items that are only ``` markers
        // These bracket the interactive diff view in the chat UI and are meaningless in FlightPath output
        if (textContent.trim() && !/^[`\s]+$/.test(textContent.trim())) {
          events.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text: textContent },
          });
        }
      }
    }

    // Extract tool call arguments from metadata.
    // Matching strategy:
    //   - By name: response item toolId "copilot_createFile" vs round name "create_file" → use normalization map
    //   - By ID: response item toolCallId "call_abc" vs round id "call_abc__vscode-NNN" → use startsWith
    // Name overwrite: only when matched by normalization (needed for upgrade pass).
    // When matched by ID for an unknown tool, preserve the original toolId for display.
    if (request.result.metadata?.toolCallRounds) {
      for (const round of request.result.metadata.toolCallRounds) {
        for (const toolCall of round.toolCalls) {
          const canonicalName = toolCall.name;

          // Try name-normalized match first
          let toolEvent = events.find(
            (e) =>
              e.type === CLI_EVENT_TYPES.TOOL_CALL &&
              e.data &&
              "name" in e.data &&
              ChatSessionParser.normalizeCopilotToolName(
                e.data.name as string
              ) === canonicalName
          );
          const matchedByNormalization = !!toolEvent;

          // Fall back to ID match
          if (!toolEvent) {
            toolEvent = events.find(
              (e) =>
                e.type === CLI_EVENT_TYPES.TOOL_CALL &&
                e.data &&
                "id" in e.data &&
                !!e.data.id &&
                toolCall.id.startsWith(e.data.id as string)
            );
          }

          if (toolEvent && "parameters" in toolEvent.data) {
            try {
              // Only overwrite name when matched by normalization so the upgrade
              // pass can resolve the canonical snake_case name (e.g. "create_file").
              // For ID-only matches, preserve the original toolId (e.g. "copilot_getChangedFiles").
              if (matchedByNormalization) {
                (toolEvent.data as ToolCall).name = canonicalName;
              }
              (toolEvent.data as ToolCall).parameters = JSON.parse(
                toolCall.arguments || "{}"
              );
            } catch {
              Log.warn(
                `Failed to parse tool arguments for ${canonicalName}`,
                "ChatSessionParser"
              );
            }
          }
        }
      }
    }

    // Upgrade generic TOOL_CALL events to specific typed events (FILE_EDIT, FILE_WRITE, etc.)
    const upgradedEvents = events.flatMap((e) => this.upgradeToolCallEvent(e));

    // Add error message as text event if present
    if (request.result.errorDetails) {
      upgradedEvents.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp,
        data: {
          text: `Error: ${request.result.errorDetails.message || "Unknown error"}`,
        },
      });
    }

    return {
      events: upgradedEvents,
      metadata: {
        sessionId,
        model: this.normalizeModelId(request.modelId),
        elapsed: request.result.timings.totalElapsed,
        harness: "copilot-chat",
      },
    };
  }

  /**
   * Map Copilot Chat display tool IDs (e.g. "copilot_createFile") to canonical
   * snake_case names used in toolCallRounds (e.g. "create_file").
   * Falls back to the original name if no mapping found.
   */
  private static readonly COPILOT_TOOL_ID_MAP: Record<string, string> = {
    copilot_createFile: "create_file",
    copilot_replaceString: "replace_string_in_file",
    copilot_multiReplaceString: "multi_replace_string_in_file",
    copilot_readFile: "read_file",
    copilot_deleteFile: "delete_file",
    copilot_renameFile: "rename_file",
    copilot_moveFile: "move_file",
  };

  private static normalizeCopilotToolName(name: string): string {
    return ChatSessionParser.COPILOT_TOOL_ID_MAP[name] ?? name;
  }

  /**
   * Upgrade a generic TOOL_CALL event to a specific typed event based on canonical tool name.
   * Multi-file tools (multi_replace_string_in_file) expand into multiple FILE_EDIT events.
   * Returns array of replacement events (usually length 1, may be 0 or >1).
   */
  private upgradeToolCallEvent(event: CliEvent): CliEvent[] {
    if (event.type !== CLI_EVENT_TYPES.TOOL_CALL) {
      return [event];
    }
    const tc = event.data as ToolCall;
    const name = tc.name;
    const params = tc.parameters;
    const ts = event.timestamp;

    if (name === "create_file") {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp: ts,
          data: {
            path: (params.filePath as string) || "",
            content: (params.content as string) || "",
            status: "completed",
          } satisfies FileWriteData,
        },
      ];
    }

    if (name === "replace_string_in_file") {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp: ts,
          data: {
            path: (params.filePath as string) || "",
            oldContent: params.oldString as string | undefined,
            newContent: params.newString as string | undefined,
            status: "completed",
          } satisfies FileEditData,
        },
      ];
    }

    if (name === "multi_replace_string_in_file") {
      const replacements = params.replacements as
        | Array<{
            filePath: string;
            oldString?: string;
            newString?: string;
          }>
        | undefined;
      if (!replacements?.length) {
        return [event];
      }
      return replacements.map((r) => ({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp: ts,
        data: {
          path: r.filePath || "",
          oldContent: r.oldString,
          newContent: r.newString,
          status: "completed",
        } satisfies FileEditData,
      }));
    }

    if (name === "run_in_terminal") {
      return [
        {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp: ts,
          data: {
            command: (params.command as string) || "",
            status: "completed",
          } satisfies BashCommandData,
        },
      ];
    }

    if (name === "read_file") {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp: ts,
          data: {
            path: (params.filePath as string) || "",
            status: "completed",
          } satisfies FileReadData,
        },
      ];
    }

    if (name === "delete_file") {
      return [
        {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp: ts,
          data: {
            path: (params.filePath as string) || "",
            success: true,
          } satisfies FileDeleteData,
        },
      ];
    }

    // Unknown tool — keep as generic TOOL_CALL
    return [event];
  }

  /**
   * Extract thinking text, filtering out encrypted content.
   *
   * Encrypted thinking heuristic: VS Code encrypts thinking blocks from some
   * models (e.g. Claude extended thinking). The encrypted output appears as a
   * single long base64-encoded string with no spaces or punctuation typical of
   * natural language. We detect this by checking for 100+ consecutive base64
   * characters at the start of the text. This avoids displaying meaningless
   * cipher text in the output panel.
   */
  private extractThinkingText(
    value: string | string[] | undefined
  ): string | null {
    if (!value) {
      return null;
    }

    const text = Array.isArray(value) ? value.join("\n") : value;

    // Skip encrypted thinking blocks (they start with base64-like strings)
    // Example: "fApshhj0S4BvSMtflmU7qThS0cjdOA10..."
    if (text.match(/^[A-Za-z0-9+/]{100,}/)) {
      return null;
    }

    return text.trim() || null;
  }

  /**
   * Normalize model ID (remove "copilot/" prefix)
   */
  private normalizeModelId(modelId: string): string {
    return modelId?.replace(/^copilot\//, "") || "unknown";
  }

  /**
   * Extract session ID from session file path
   * @param sessionFilePath Path like ".../abc-123-def.json" or ".../abc-123-def.jsonl"
   * @returns Session ID (filename without extension)
   */
  extractSessionId(sessionFilePath: string): string {
    // Split on both POSIX (/) and Windows (\) separators for cross-platform support
    const base = sessionFilePath.split(/[/\\]/).pop() ?? sessionFilePath;
    return base.replace(/\.jsonl?$/, "");
  }

  /**
   * Check if session file exists and is readable
   */
  isValidSessionFile(sessionFilePath: string): boolean {
    try {
      return (
        fs.existsSync(sessionFilePath) && fs.statSync(sessionFilePath).isFile()
      );
    } catch {
      return false;
    }
  }

  /**
   * Check if session file is complete (has totalElapsed > 0)
   * @param sessionFilePath Path to session JSON file
   * @param requestIndex Index of request (-1 = last request)
   * @returns True if request is complete
   */
  static isSessionComplete(
    sessionFilePath: string,
    requestIndex: number = -1
  ): boolean {
    try {
      const session = ChatSessionParser.parseSessionFile(sessionFilePath);

      if (!session?.requests || session.requests.length === 0) {
        return false;
      }

      const actualIndex =
        requestIndex === -1 ? session.requests.length - 1 : requestIndex;
      const request = session.requests[actualIndex];

      return request?.result?.timings?.totalElapsed > 0;
    } catch (error) {
      Log.warn(
        `Failed to check session completion: ${sessionFilePath}`,
        "ChatSessionParser"
      );
      return false;
    }
  }

  /**
   * Get request count from session file
   */
  static getRequestCount(sessionFilePath: string): number {
    try {
      const session = ChatSessionParser.parseSessionFile(sessionFilePath);
      return session?.requests?.length ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Create empty output for error cases
   */
  private createEmptyOutput(sessionId: string): UniversalCliOutput {
    return {
      events: [],
      metadata: {
        sessionId,
        model: "unknown",
        harness: "copilot-chat",
      },
    };
  }
}
