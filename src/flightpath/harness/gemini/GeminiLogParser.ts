import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";
import { BaseCliEvent, ILogParser } from "../shared/interfaces/ILogParser";
import {
  UniversalCliOutput,
  CliEvent,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, HARNESS_IDS } from "../../../types/DashboardConstants";
import { GeminiToolBuilder } from "./GeminiToolBuilder";

export class GeminiLogParser extends BaseLogParser implements ILogParser {
  private workspaceRoot?: string;

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const outputEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let usage: any | undefined;

    // Gemini logs are often a single JSON object, so events might just be one item
    const logData = events[0] as any;
    if (logData && logData.messages) {
      sessionId = logData.sessionId;
      
      for (const msg of logData.messages) {
        const timestamp = Date.now(); // Logs might not have per-message timestamps

        if (msg.type === "user" && msg.content) {
          // Handle user messages if needed
        }

        if (msg.type === "gemini") {
          if (msg.content) {
            outputEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp,
              data: { text: msg.content },
            });
          }

          if (msg.toolCalls) {
            for (const tc of msg.toolCalls) {
              outputEvents.push(
                GeminiToolBuilder.buildInitiatedEvent(
                  tc.name,
                  tc.parameters || {},
                  tc.id,
                  timestamp
                )
              );

              if (tc.resultDisplay || tc.status) {
                outputEvents.push({
                  type: CLI_EVENT_TYPES.TOOL_RESULT,
                  timestamp,
                  data: {
                    toolCallId: tc.id,
                    result: {
                      success: tc.status === "success",
                      output: tc.resultDisplay,
                    },
                  },
                });
              }
            }
          }
        }
      }
    }

    return {
      events: outputEvents,
      metadata: {
        sessionId,
        model,
        harness: HARNESS_IDS.GEMINI_CLI,
        usage: usage ? {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
        } : undefined,
      },
    };
  }

  isComplete(_event: BaseCliEvent): boolean {
    return true; // Gemini logs are usually written when complete
  }

  async discoverSessionLog(
    _promptText: string,
    _startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    const chatsDir = this.getGeminiChatsDirectory();
    if (!chatsDir || !fs.existsSync(chatsDir)) return null;

    if (sessionId) {
      // Look for file containing sessionId in name
      const files = fs.readdirSync(chatsDir);
      const match = files.find(f => f.includes(sessionId));
      if (match) return path.join(chatsDir, match);
    }

    // Fallback: most recent file
    const files = fs.readdirSync(chatsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => ({ name: f, time: fs.statSync(path.join(chatsDir, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 0) {
      return path.join(chatsDir, files[0].name);
    }

    return null;
  }

  private getGeminiChatsDirectory(): string | null {
    const workspacePath = this.workspaceRoot ?? process.cwd();
    const projectName = path.basename(workspacePath);
    return path.join(os.homedir(), ".gemini", "tmp", projectName, "chats");
  }

  extractSessionId(events: BaseCliEvent[]): string | null {
    const logData = events[0] as any;
    return logData?.sessionId || null;
  }

  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    const e = event as any;
    return e.content;
  }

  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata);
    return parts.join(" | ");
  }
}
