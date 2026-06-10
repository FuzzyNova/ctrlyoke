import {
  CliEvent,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  ToolResultData,
  UnifiedDiffHunk,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CliEventMapper } from "../shared/CliEventMapper";
import { ApplyPatchParser } from "../shared/ApplyPatchParser";
import { Log } from "../../../utils/Log";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";

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
  static buildLogToolInitiatedEvents(
    toolName: string,
    params: Record<string, unknown>,
    callId: string | undefined,
    timestamp: number
  ): CliEvent[] {
    // Codex-specific: apply_patch encodes multi-file edits in a custom patch format
    if (
      toolName === "apply_patch" &&
      CliEventMapper.classifyTool(toolName).type === CLI_EVENT_TYPES.FILE_EDIT
    ) {
      const patchInput = (params.input as string | undefined) ?? "";
      const fileEdits = ApplyPatchParser.parseFileEdits(patchInput);
      if (fileEdits.length > 0) {
        Log.debug(
          `[CodexToolBuilder] apply_patch initiated - files=${fileEdits.length}`
        );
        return fileEdits.map((fileEdit) => ({
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: fileEdit.path,
            structuredPatch: fileEdit.structuredPatch,
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData,
        }));
      }

      let extractedPath = "unknown";
      extractedPath = ApplyPatchParser.extractFirstPath(patchInput) ?? "unknown";
      const structuredPatch = ApplyPatchParser.parse(patchInput);
      Log.debug(
        `[CodexToolBuilder] apply_patch initiated - file=${extractedPath}, structuredPatch=${structuredPatch ? `${structuredPatch.length} hunks` : "none"}`
      );
      return [
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: extractedPath,
            structuredPatch,
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData,
        },
      ];
    }

    return BaseToolBuilder.buildInitiatedEvents(
      toolName,
      params,
      callId,
      timestamp
    );
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
  static buildCustomToolCallCompletedEvents(
    toolInfo: { type: string; toolName: string },
    exitCode: number | undefined,
    success: boolean,
    outputText: string,
    callId: string | undefined,
    timestamp: number,
    initiatedEvents?: CliEvent[]
  ): CliEvent[] {
    const status = success
      ? OPERATION_STATUS.COMPLETED
      : OPERATION_STATUS.FAILED;
    const primaryInitiatedData = initiatedEvents?.[0]?.data;

    if (toolInfo.type === CLI_EVENT_TYPES.FILE_EDIT && initiatedEvents) {
      return initiatedEvents.map((initiatedEvent) => {
        const initiatedData = initiatedEvent.data as FileEditData | undefined;
        return {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: initiatedData?.path ?? "",
            oldContent: initiatedData?.oldContent,
            newContent: initiatedData?.newContent,
            structuredPatch: initiatedData?.structuredPatch,
            status,
            success,
          } as FileEditData,
        };
      });
    }

    switch (toolInfo.type) {
      case CLI_EVENT_TYPES.BASH_COMMAND:
        return [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            timestamp,
            data: {
              command:
                (primaryInitiatedData as BashCommandData | undefined)
                  ?.command ?? "",
              exitCode: exitCode ?? 0,
              output: outputText,
              error: success ? undefined : outputText,
              status,
            } as BashCommandData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_READ:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_READ,
            timestamp,
            data: {
              path:
                (primaryInitiatedData as FileReadData | undefined)?.path ?? "",
              content: outputText,
              status,
              success,
            } as FileReadData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_WRITE:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_WRITE,
            timestamp,
            data: {
              path:
                (primaryInitiatedData as FileWriteData | undefined)?.path ?? "",
              content:
                (primaryInitiatedData as FileWriteData | undefined)?.content ??
                "",
              status,
              success,
            } as FileWriteData,
          },
        ];

      case CLI_EVENT_TYPES.FILE_DELETE:
        return [
          {
            type: CLI_EVENT_TYPES.FILE_DELETE,
            timestamp,
            data: {
              path:
                (primaryInitiatedData as FileDeleteData | undefined)?.path ??
                "",
              status,
              success,
            } as FileDeleteData,
          },
        ];

      default:
        return [
          {
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            timestamp,
            data: {
              toolCallId: callId,
              result: { success, output: outputText },
            } as ToolResultData,
          },
        ];
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
    return ApplyPatchParser.parse(patchInput);
  }

  static parseApplyPatchFileEdits(
    patchInput: string
  ): Array<{ path: string; structuredPatch?: UnifiedDiffHunk[] }> {
    return ApplyPatchParser.parseFileEdits(patchInput);
  }
}
