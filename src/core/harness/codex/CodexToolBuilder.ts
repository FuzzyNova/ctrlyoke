import {
  CliEvent,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  ToolResultData,
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
 * Covers the full Codex tool lifecycle from Codex session-log events:
 *
 * **Log format** (CodexLogParser — reading session log files):
 * - `buildLogToolInitiatedEvent` — handles `tool_use`, `function_call`, and
 *   `custom_tool_call` response_item payloads (three formerly separate inline
 *   switches, now unified here).
 * - `buildCustomToolCallCompletedEvent` — for `custom_tool_call_output` results.
 * - `buildFunctionCallOutputCompletedEvent` — for `function_call_output` results
 *   (bash-specific output parsing included).
 *
 * The session log is the sole event-mapping source for both interactive and
 * headless Codex runs.
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
   * For `apply_patch`, extracts one event per file from the patch header and
   * preserves add/update/delete semantics for undo and diff rendering.
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
          type:
            fileEdit.kind === "add"
              ? CLI_EVENT_TYPES.FILE_WRITE
              : fileEdit.kind === "delete"
                ? CLI_EVENT_TYPES.FILE_DELETE
                : CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: fileEdit.path,
            structuredPatch: fileEdit.structuredPatch,
            ...(fileEdit.kind === "add" && { content: "" }),
            status: OPERATION_STATUS.INITIATED,
          } as FileEditData | FileWriteData | FileDeleteData,
        }));
      }

      let extractedPath = "unknown";
      extractedPath =
        ApplyPatchParser.extractFirstPath(patchInput) ?? "unknown";
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

  // ── LOG FORMAT: EXEC TOOL (Codex gpt-5.x) ─────────────────────────────────

  /**
   * Build INITIATED events for a Codex `exec` custom tool call.
   *
   * Newer Codex models (gpt-5.x) no longer expose discrete `shell` / `apply_patch`
   * tools. Instead every action arrives as a single `exec` custom tool whose
   * `input` is a JavaScript snippet driving sandbox helpers, e.g.:
   *
   * ```js
   * const r = await tools.shell_command({command:"...", workdir:"..."}); text(r)
   * ```
   * ```js
   * const patch = "*** Begin Patch\n...*** End Patch";
   * text(await tools.apply_patch(patch));
   * ```
   *
   * This unwraps that snippet back into the underlying shell command or
   * apply_patch payload and delegates to {@link buildLogToolInitiatedEvents} so
   * the rest of the pipeline emits BASH_COMMAND / FILE_EDIT events instead of an
   * opaque `exec(input: ...)` tool-call row. Falls back to a generic tool call
   * when the snippet cannot be parsed.
   *
   * @param input     - The raw JavaScript snippet from `payload.input`
   * @param callId    - Call ID for correlation with the COMPLETED event
   * @param timestamp - Event timestamp in milliseconds
   */
  static buildExecInitiatedEvents(
    input: string,
    callId: string | undefined,
    timestamp: number
  ): CliEvent[] {
    const parsed = this.parseExecInput(input);
    if (!parsed) {
      Log.debug(
        "[CodexToolBuilder] exec input not recognized, emitting generic tool call"
      );
      return BaseToolBuilder.buildInitiatedEvents(
        "exec",
        { input },
        callId,
        timestamp
      );
    }

    if (parsed.kind === "patch") {
      return this.buildLogToolInitiatedEvents(
        "apply_patch",
        { input: parsed.patch },
        callId,
        timestamp
      );
    }

    return this.buildLogToolInitiatedEvents(
      "shell_command",
      { command: parsed.command, workingDir: parsed.workdir },
      callId,
      timestamp
    );
  }

  /**
   * Unwrap a Codex `exec` JavaScript snippet into its underlying operation.
   *
   * @returns A shell command (with optional workdir), an apply_patch payload, or
   *          null when the snippet matches no known helper.
   */
  static parseExecInput(
    input: string
  ):
    | { kind: "shell"; command: string; workdir?: string }
    | { kind: "patch"; patch: string }
    | null {
    if (input.includes("apply_patch") || input.includes("*** Begin Patch")) {
      const patch = this.extractJsStringLiterals(input).find((literal) =>
        literal.includes("*** Begin Patch")
      );
      if (patch) {
        return { kind: "patch", patch };
      }
    }

    if (input.includes("shell_command") || /\bcommand\s*:/.test(input)) {
      const command = this.readJsObjectStringValue(input, "command");
      if (command !== undefined) {
        const workdir = this.readJsObjectStringValue(input, "workdir");
        return { kind: "shell", command, workdir };
      }
    }

    return null;
  }

  /**
   * Flatten a Codex `custom_tool_call_output` payload to display text.
   *
   * Newer Codex versions return an array of `{type, text}` parts; older versions
   * return a single string. Both shapes flatten to a single string here.
   */
  static flattenCustomToolOutput(output: unknown): string {
    if (typeof output === "string") {
      return output;
    }
    if (Array.isArray(output)) {
      return output
        .map((part) =>
          typeof part === "string"
            ? part
            : ((part as { text?: string })?.text ?? "")
        )
        .join("");
    }
    return "";
  }

  /**
   * Read and decode a JS/JSON string literal beginning at the opening quote
   * `src[quoteIdx]`. Handles `\n`, `\t`, `\\`, `\"`, `\'`, and backtick escapes;
   * backslashes are otherwise preserved so Windows paths survive intact.
   */
  private static readJsStringLiteral(
    src: string,
    quoteIdx: number
  ): { value: string; endIdx: number } | null {
    const quote = src[quoteIdx];
    let i = quoteIdx + 1;
    let value = "";
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") {
        const next = src[i + 1];
        switch (next) {
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case "b":
            value += "\b";
            break;
          case "f":
            value += "\f";
            break;
          case undefined:
            break;
          default:
            // \\, \", \', \`, and unknown escapes → literal next char
            value += next;
            break;
        }
        i += 2;
        continue;
      }
      if (ch === quote) {
        return { value, endIdx: i + 1 };
      }
      value += ch;
      i += 1;
    }
    return null;
  }

  /** Extract and decode every top-level string literal from a JS snippet. */
  private static extractJsStringLiterals(src: string): string[] {
    const literals: string[] = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const parsed = this.readJsStringLiteral(src, i);
        if (parsed) {
          literals.push(parsed.value);
          i = parsed.endIdx;
          continue;
        }
      }
      i += 1;
    }
    return literals;
  }

  /**
   * Read the decoded string value for `key:` within a JS object literal. Skips
   * false matches (e.g. `command` not followed by a quoted value) by scanning
   * every occurrence of the key.
   */
  private static readJsObjectStringValue(
    src: string,
    key: string
  ): string | undefined {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Codex currently serializes helper arguments with JSON-style quoted keys
    // (`{"command":"..."}`), while older/test payloads used JavaScript-style
    // bare keys (`{command:"..."}`). Accept both forms.
    const re = new RegExp(
      `(?:["']${escapedKey}["']|${escapedKey})\\s*:\\s*`,
      "g"
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      const quoteIdx = match.index + match[0].length;
      const quote = src[quoteIdx];
      if (quote === '"' || quote === "'" || quote === "`") {
        const parsed = this.readJsStringLiteral(src, quoteIdx);
        if (parsed) {
          return parsed.value;
        }
      }
    }
    return undefined;
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

    if (
      initiatedEvents &&
      initiatedEvents.length > 0 &&
      initiatedEvents.every((event) =>
        [
          CLI_EVENT_TYPES.FILE_EDIT,
          CLI_EVENT_TYPES.FILE_WRITE,
          CLI_EVENT_TYPES.FILE_DELETE,
        ].some((type) => type === event.type)
      )
    ) {
      return initiatedEvents.map((initiatedEvent) => {
        const initiatedData = initiatedEvent.data as
          | FileEditData
          | FileWriteData
          | FileDeleteData
          | undefined;
        if (initiatedEvent.type === CLI_EVENT_TYPES.FILE_EDIT) {
          const data = initiatedData as FileEditData | undefined;
          return {
            type: CLI_EVENT_TYPES.FILE_EDIT,
            timestamp,
            data: {
              path: data?.path ?? "",
              oldContent: data?.oldContent,
              newContent: data?.newContent,
              structuredPatch: data?.structuredPatch,
              status,
              success,
            } as FileEditData,
          };
        }
        if (initiatedEvent.type === CLI_EVENT_TYPES.FILE_WRITE) {
          const data = initiatedData as FileWriteData | undefined;
          return {
            type: CLI_EVENT_TYPES.FILE_WRITE,
            timestamp,
            data: {
              path: data?.path ?? "",
              content: data?.content ?? "",
              status,
              success,
            } as FileWriteData,
          };
        }
        const data = initiatedData as FileDeleteData | undefined;
        return {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          timestamp,
          data: {
            path: data?.path ?? "",
            status,
            success,
          } as FileDeleteData,
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
   * Used by both the batch and streaming log paths so command events keep one
   * mapping implementation.
   *
   * @param command   - Shell command string from item.command
   * @param timestamp - Event timestamp in milliseconds
   */
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
}
