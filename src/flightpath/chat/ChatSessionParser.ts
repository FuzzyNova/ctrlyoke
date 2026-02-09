import * as fs from "fs";
import * as path from "path";
import {
  UniversalCliOutput,
  CliEvent,
  CLI_EVENT_TYPES,
} from "../../types/CliOutputTypes";
import { Log } from "../../utils/Log";

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
    | "mcpServersStarting";

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
   * Extract response from session file
   * @param sessionFilePath Path to session JSON file
   * @param requestIndex Index of request (-1 = last request)
   * @returns UniversalCliOutput with events and metadata
   */
  extractResponse(
    sessionFilePath: string,
    requestIndex: number = -1
  ): UniversalCliOutput {
    try {
      // Read and parse session file
      const content = fs.readFileSync(sessionFilePath, "utf-8");
      const session: ChatSessionFile = JSON.parse(content);

      if (!session.requests || session.requests.length === 0) {
        Log.warn("Session file has no requests");
        return this.createEmptyOutput(session.sessionId);
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
      } else if (item.kind === "prepareToolInvocation") {
        // Tool preparation - informational only, not included as event
        Log.debug(`Tool preparation: ${item.toolName}`, "ChatSessionParser");
      } else if (item.kind === "mcpServersStarting") {
        // MCP server startup - informational only
        Log.debug("MCP servers starting", "ChatSessionParser");
      } else if (!item.kind && item.value) {
        // Text response (no "kind" field means it's a text response)
        const textContent =
          typeof item.value === "string" ? item.value : item.value.join("\n");
        if (textContent.trim()) {
          events.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text: textContent },
          });
        }
      }
    }

    // Extract tool call arguments from metadata
    if (request.result.metadata?.toolCallRounds) {
      for (const round of request.result.metadata.toolCallRounds) {
        for (const toolCall of round.toolCalls) {
          // Find corresponding tool call event and populate arguments
          const toolEvent = events.find(
            (e) =>
              e.type === CLI_EVENT_TYPES.TOOL_CALL &&
              e.data &&
              "name" in e.data &&
              (e.data.name === toolCall.name ||
                ("id" in e.data && e.data.id === toolCall.id))
          );

          if (toolEvent && "parameters" in toolEvent.data) {
            try {
              toolEvent.data.parameters = JSON.parse(
                toolCall.arguments || "{}"
              );
            } catch {
              Log.warn(
                `Failed to parse tool arguments for ${toolCall.name}`,
                "ChatSessionParser"
              );
            }
          }
        }
      }
    }

    // Add error message as text event if present
    if (request.result.errorDetails) {
      events.push({
        type: CLI_EVENT_TYPES.TEXT,
        timestamp,
        data: {
          text: `Error: ${request.result.errorDetails.message || "Unknown error"}`,
        },
      });
    }

    return {
      events,
      metadata: {
        sessionId,
        model: this.normalizeModelId(request.modelId),
        elapsed: request.result.timings.totalElapsed,
        harness: "copilot-chat",
      },
    };
  }

  /**
   * Extract thinking text, filtering out encrypted content
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
   * @param sessionFilePath Path like ".../abc-123-def.json"
   * @returns Session ID (filename without extension)
   */
  extractSessionId(sessionFilePath: string): string {
    return path.basename(sessionFilePath, ".json");
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
  isSessionComplete(
    sessionFilePath: string,
    requestIndex: number = -1
  ): boolean {
    try {
      const content = fs.readFileSync(sessionFilePath, "utf-8");
      const session: ChatSessionFile = JSON.parse(content);

      if (!session.requests || session.requests.length === 0) {
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
  getRequestCount(sessionFilePath: string): number {
    try {
      const content = fs.readFileSync(sessionFilePath, "utf-8");
      const session: ChatSessionFile = JSON.parse(content);
      return session.requests?.length || 0;
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
