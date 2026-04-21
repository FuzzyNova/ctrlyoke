import {
  CliEvent,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ToolCall,
  ToolResultData,
  UnifiedDiffHunk,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CliEventMapper } from "../shared/CliEventMapper";
import { Log } from "../../../utils/Log";

/**
 * Event types that need toolCallMap registration (i.e. they have a matching
 * COMPLETED event format that references the same call_id).
 *
 * MCP_TOOL_CALL and WEB_SEARCH are point-in-time — no separate completion
 * event arrives for them. TOOL_CALL (generic fallback) also has no tracked
 * completion. Everything else (BASH, FILE_*) has a matching _output event.
 */
const TYPES_WITH_COMPLETION = new Set<string>([
  CLI_EVENT_TYPES.BASH_COMMAND,
  CLI_EVENT_TYPES.FILE_READ,
  CLI_EVENT_TYPES.FILE_WRITE,
  CLI_EVENT_TYPES.FILE_EDIT,
  CLI_EVENT_TYPES.FILE_DELETE,
]);

/**
 * Builds CliEvents from Codex CLI tool call payloads.
 *
 * Covers the full Codex tool lifecycle across two execution paths:
 *
 * **Log format** (CodexLogParser — reading session log files):
 * - `buildLogToolInitiatedEvent` — handles `tool_use`, `function_call`, and
 *   `custom_tool_call` response_item payloads (three formerly separate inline
 *   switches, now unified here).
 * - `buildCustomToolCallCompletedEvent` — for `custom_tool_call_output` results.
 * - `buildFunctionCallOutputCompletedEvent` — for `function_call_output` results
 *   (bash-specific output parsing included).
 *
 * **Item format** (CodexResponseParser — streaming/headless CLI output):
 * - `buildCommandExecutionInitiatedEvent` — for `item.started` command_execution.
 *   Eliminates duplication between parseItemStartedToEvents and processStreamingChunk.
 *
 * **Shared utility:**
 * - `parseApplyPatch` — converts Codex `apply_patch` patch text to UnifiedDiffHunk[].
 *   Previously a private method of CodexLogParser.
 *
 * Both CodexLogParser and CodexResponseParser use these methods so the
 * event-shaping logic is never duplicated.
 */
export class CodexToolBuilder {
  // ── LOG FORMAT: INITIATED ─────────────────────────────────────────────────

  /**
   * Build an INITIATED CliEvent for any Codex log response_item tool event.
   *
   * Unifies the three formerly inline switches for `tool_use`, `function_call`,
   * and `custom_tool_call` response_item payloads. All three formats have the
   * same semantic tool types and differ only in minor param-field naming.
   *
   * The caller is responsible for toolCallMap registration — check
   * `CodexToolBuilder.needsCompletionTracking(event.type)` to decide whether
   * to register the returned event's call_id.
   *
   * For FILE_EDIT with `apply_patch` tool name, extracts the file path from the
   * patch header and computes `structuredPatch` via `parseApplyPatch`.
   *
   * @param toolName - Tool name (already lowercased by caller)
   * @param params   - Parsed tool input/arguments (Record<string, unknown>)
   * @param callId   - Call ID for correlation with COMPLETED event (may be undefined)
   * @param timestamp - Event timestamp in milliseconds
   */
  static buildLogToolInitiatedEvent(
    toolName: string,
    params: Record<string, unknown>,
    callId: string | undefined,
    timestamp: number
  ): CliEvent {
    const classification = CliEventMapper.classifyTool(toolName);
    const filePath = ((params.path ?? params.file) as string | undefined) ?? "";

    switch (classification.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp,
          data: {
            command:
              ((params.command ?? params.cmd) as string | undefined) || "",
            workingDir: (params.workingDir ?? params.cwd) as string | undefined,
            status: OPERATION_STATUS.INITIATED,
          } as BashCommandData,
        };

      case CLI_EVENT_TYPES.FILE_READ:
        return {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path: filePath,
            status: OPERATION_STATUS.INITIATED,
          } as FileReadData,
        };

      case CLI_EVENT_TYPES.FILE_WRITE:
        return {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp,
          data: {
            path: filePath,
            content: (params.content as string | undefined) || "",
            status: OPERATION_STATUS.INITIATED,
          } as FileWriteData,
        };

      case CLI_EVENT_TYPES.FILE_EDIT: {
        if (toolName === "apply_patch") {
          const patchInput = (params.input as string | undefined) ?? "";
          let extractedPath = "unknown";
          const fileMatch = patchInput.match(
            /\*\*\* (?:Add|Update) File: (.+)/
          );
          if (fileMatch) {
            extractedPath = fileMatch[1].trim();
          }
          const structuredPatch = CodexToolBuilder.parseApplyPatch(patchInput);
          Log.debug(
            `[CodexToolBuilder] apply_patch initiated - file=${extractedPath}, structuredPatch=${structuredPatch ? `${structuredPatch.length} hunks` : "none"}`
          );
          return {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            timestamp,
            data: {
              path: extractedPath,
              structuredPatch,
              status: OPERATION_STATUS.INITIATED,
            } as FileEditData,
          };
        }
        return {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: filePath,
            oldContent: (params.oldContent ?? params.old_content) as
              | string
              | undefined,
            newContent: (params.newContent ??
              params.new_content ??
              params.content) as string | undefined,
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData,
        };
      }

      case CLI_EVENT_TYPES.FILE_DELETE:
        return {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp,
          data: {
            path: filePath,
            status: OPERATION_STATUS.INITIATED,
          } as FileDeleteData,
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
            parameters: params,
          } as McpToolCallData,
        };
      }

      case CLI_EVENT_TYPES.WEB_SEARCH:
        return {
          type: CLI_EVENT_TYPES.WEB_SEARCH,
          timestamp,
          data: {
            query: (params.query as string) || "",
          } as WebSearchData,
        };

      default:
        return {
          type: CLI_EVENT_TYPES.TOOL_CALL,
          timestamp,
          data: {
            name: toolName,
            parameters: params,
            id: callId,
          } as ToolCall,
        };
    }
  }

  /**
   * Returns true when the given event type has a corresponding COMPLETED event
   * that references the call_id. Used by callers to decide whether to register
   * in the toolCallMap.
   */
  static needsCompletionTracking(eventType: string): boolean {
    return TYPES_WITH_COMPLETION.has(eventType);
  }

  // ── LOG FORMAT: COMPLETED ─────────────────────────────────────────────────

  /**
   * Build a COMPLETED/FAILED CliEvent for a `custom_tool_call_output` result.
   *
   * Returns a TOOL_RESULT fallback when the toolInfo type is unrecognized
   * (callers should fall through to TOOL_RESULT if toolInfo is undefined).
   *
   * @param toolInfo   - Tracking entry from toolCallMap ({ type, toolName })
   * @param exitCode   - Exit code from parsed output metadata (undefined = unknown)
   * @param success    - Whether the tool call succeeded
   * @param outputText - Human-readable output text for display
   * @param callId     - Original call ID (used in TOOL_RESULT fallback)
   * @param timestamp  - Event timestamp in milliseconds
   */
  static buildCustomToolCallCompletedEvent(
    toolInfo: { type: string; toolName: string },
    exitCode: number | undefined,
    success: boolean,
    outputText: string,
    callId: string | undefined,
    timestamp: number,
    initiatedEvent?: CliEvent
  ): CliEvent {
    const status = success
      ? OPERATION_STATUS.COMPLETED
      : OPERATION_STATUS.FAILED;
    const initiatedData = initiatedEvent?.data;

    switch (toolInfo.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          timestamp,
          data: {
            command:
              (initiatedData as BashCommandData | undefined)?.command ?? "",
            exitCode: exitCode ?? 0,
            output: outputText,
            error: success ? undefined : outputText,
            status,
          } as BashCommandData,
        };

      case CLI_EVENT_TYPES.FILE_READ:
        return {
          type: CLI_EVENT_TYPES.FILE_READ,
          timestamp,
          data: {
            path: (initiatedData as FileReadData | undefined)?.path ?? "",
            content: outputText,
            status,
            success,
          } as FileReadData,
        };

      case CLI_EVENT_TYPES.FILE_WRITE:
        return {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          timestamp,
          data: {
            path: (initiatedData as FileWriteData | undefined)?.path ?? "",
            content: (initiatedData as FileWriteData | undefined)?.content ?? "",
            status,
            success,
          } as FileWriteData,
        };

      case CLI_EVENT_TYPES.FILE_EDIT:
        return {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: (initiatedData as FileEditData | undefined)?.path ?? "",
            oldContent: (initiatedData as FileEditData | undefined)
              ?.oldContent,
            newContent: (initiatedData as FileEditData | undefined)
              ?.newContent,
            structuredPatch: (initiatedData as FileEditData | undefined)
              ?.structuredPatch,
            status,
            success,
          } as FileEditData,
        };

      case CLI_EVENT_TYPES.FILE_DELETE:
        return {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp,
          data: {
            path: (initiatedData as FileDeleteData | undefined)?.path ?? "",
            status,
            success,
          } as FileDeleteData,
        };

      default:
        return {
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          timestamp,
          data: {
            toolCallId: callId,
            result: { success, output: outputText },
          } as ToolResultData,
        };
    }
  }

  /**
   * Build a COMPLETED/FAILED CliEvent for a `function_call_output` result.
   *
   * Parses Codex's function_call_output format:
   * `"Exit code: X\nWall time: Y\nTotal output lines: Z\nOutput:\n<content>"`
   *
   * Only bash commands arrive via function_call_output (other tools use
   * custom_tool_call_output). When isBash is false, falls back to TOOL_RESULT.
   *
   * @param isBash         - Whether the tracked call was a BASH_COMMAND
   * @param rawOutput      - Raw output string from event.payload.output
   * @param callId         - Original call ID (used in TOOL_RESULT fallback)
   * @param timestamp      - Event timestamp in milliseconds
   * @param initiatedEvent - The matching INITIATED event (carries the command text)
   */
  static buildFunctionCallOutputCompletedEvent(
    isBash: boolean,
    rawOutput: string,
    callId: string | undefined,
    timestamp: number,
    initiatedEvent?: CliEvent
  ): CliEvent {
    if (isBash) {
      const exitCodeMatch = rawOutput.match(/Exit code: (\d+)/);
      const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;
      const success = exitCode === 0;
      const outputMatch = rawOutput.match(/Output:\n([\s\S]*)$/);
      const stdout = outputMatch ? outputMatch[1] : rawOutput;
      const initiatedData = initiatedEvent?.data as BashCommandData | undefined;
      return {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp,
        data: {
          command: initiatedData?.command ?? "",
          exitCode,
          output: stdout,
          error: success ? undefined : stdout,
          status: success
            ? OPERATION_STATUS.COMPLETED
            : OPERATION_STATUS.FAILED,
        } as BashCommandData,
      };
    }

    return {
      type: CLI_EVENT_TYPES.TOOL_RESULT,
      timestamp,
      data: {
        toolCallId: callId,
        result: { success: true, output: rawOutput },
      } as ToolResultData,
    };
  }

  // ── ITEM FORMAT: INITIATED ────────────────────────────────────────────────

  /**
   * Build a BASH_COMMAND INITIATED event for a `command_execution` item.
   *
   * Used by both `parseItemStartedToEvents` and `processStreamingChunk` in
   * CodexResponseParser — previously an identical inline push in both places.
   *
   * @param command   - Shell command string from item.command
   * @param timestamp - Event timestamp in milliseconds
   */
  static buildCommandExecutionInitiatedEvent(
    command: string,
    timestamp: number
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      timestamp,
      data: {
        command,
        status: OPERATION_STATUS.INITIATED,
      } as BashCommandData,
    };
  }

  // ── SHARED UTILITIES ──────────────────────────────────────────────────────

  /**
   * Parse Codex `apply_patch` format and convert to UnifiedDiffHunk[].
   *
   * Codex uses a custom patch format:
   * ```
   * *** Begin Patch
   * *** Update File: path/to/file.ext
   * @@
   * -removed line
   * +added line
   *  context line
   * *** End Patch
   * ```
   *
   * Since Codex patches don't include explicit line numbers, they are inferred
   * by tracking counters as the diff is parsed.
   *
   * @param patchInput - The patch input string from apply_patch tool arguments
   * @returns Array of UnifiedDiffHunk objects, or undefined if parsing fails
   */
  static parseApplyPatch(patchInput: string): UnifiedDiffHunk[] | undefined {
    try {
      const lines = patchInput.split("\n");
      const hunks: UnifiedDiffHunk[] = [];
      let currentHunk: UnifiedDiffHunk | null = null;
      let oldLineNum = 1;
      let newLineNum = 1;
      let inPatch = false;

      for (const line of lines) {
        if (line.startsWith("*** Begin Patch")) {
          inPatch = true;
          continue;
        }

        if (line.startsWith("*** End Patch")) {
          if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }
          break;
        }

        if (!inPatch) {
          continue;
        }

        if (
          line.startsWith("*** Add File:") ||
          line.startsWith("*** Update File:")
        ) {
          oldLineNum = 1;
          newLineNum = 1;
          continue;
        }

        if (line === "@@" || line.startsWith("@@")) {
          if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }
          currentHunk = {
            oldStart: oldLineNum,
            oldLines: 0,
            newStart: newLineNum,
            newLines: 0,
            lines: [],
          };
          continue;
        }

        if (currentHunk) {
          if (line.startsWith("+")) {
            currentHunk.lines.push(line);
            currentHunk.newLines++;
            newLineNum++;
          } else if (line.startsWith("-")) {
            currentHunk.lines.push(line);
            currentHunk.oldLines++;
            oldLineNum++;
          } else {
            // Context line (space prefix, empty, or unprefixed)
            currentHunk.lines.push(
              " " + line.substring(line.startsWith(" ") ? 1 : 0)
            );
            currentHunk.oldLines++;
            currentHunk.newLines++;
            oldLineNum++;
            newLineNum++;
          }
        }
      }

      if (currentHunk && currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
      }

      return hunks.length > 0 ? hunks : undefined;
    } catch (error) {
      Log.debug(
        `[CodexToolBuilder] Failed to parse apply_patch input: ${error}`
      );
      return undefined;
    }
  }
}
