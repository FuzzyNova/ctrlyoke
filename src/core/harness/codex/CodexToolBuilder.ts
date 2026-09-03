import * as fs from "fs";
import {
  CliEvent,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  ToolResultData,
  AskUserQuestionData,
  AskUserQuestionEntry,
  AskUserQuestionOption,
  TextData,
  McpToolCallData,
  UnifiedDiffHunk,
} from "../../../types/CliOutputTypes";
import {
  APPLY_PATCH_FILE_EDIT_KINDS,
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { CliEventMapper } from "../shared/CliEventMapper";
import { ApplyPatchParser } from "../shared/ApplyPatchParser";
import { Log } from "../../../utils/Log";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";
import {
  CODEX_EXEC_OPERATION_KINDS,
  CODEX_TOOL_NAMES,
  CODEX_TODO_ITEM_STATUS,
} from "./CodexProtocolConstants";

type CodexExecOperation =
  | {
      kind: typeof CODEX_EXEC_OPERATION_KINDS.SHELL;
      command: string;
      workdir?: string;
    }
  | { kind: typeof CODEX_EXEC_OPERATION_KINDS.PATCH; patch: string }
  | {
      kind: typeof CODEX_EXEC_OPERATION_KINDS.MCP;
      toolName: string;
      argsText: string;
    }
  | {
      kind: typeof CODEX_EXEC_OPERATION_KINDS.PLAN;
      items: Array<{ step: string; status: string }>;
    }
  | {
      kind: typeof CODEX_EXEC_OPERATION_KINDS.CONTINUE;
      sessionId?: string;
      chars: string;
    };

/**
 * Event types that need toolCallMap registration (i.e. they have a matching
 * COMPLETED event format that references the same call_id).
 *
 * WEB_SEARCH is point-in-time — no separate completion event arrives for it.
 * TOOL_CALL (generic fallback) also has no tracked completion. BASH, FILE_*,
 * MCP_TOOL_CALL, and request_user_input have matching output events.
 */
const TYPES_WITH_COMPLETION = new Set<string>([
  CLI_EVENT_TYPES.BASH_COMMAND,
  CLI_EVENT_TYPES.FILE_READ,
  CLI_EVENT_TYPES.FILE_WRITE,
  CLI_EVENT_TYPES.FILE_EDIT,
  CLI_EVENT_TYPES.FILE_DELETE,
  CLI_EVENT_TYPES.ASK_USER_QUESTION,
  CLI_EVENT_TYPES.MCP_TOOL_CALL,
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
  private static readonly REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

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
    if (toolName === this.REQUEST_USER_INPUT_TOOL_NAME) {
      return [
        this.buildRequestUserInputInitiatedEvent(params, callId, timestamp),
      ];
    }

    // Codex-specific: apply_patch encodes multi-file edits in a custom patch format
    if (
      toolName === CODEX_TOOL_NAMES.APPLY_PATCH &&
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
            fileEdit.kind === APPLY_PATCH_FILE_EDIT_KINDS.ADD
              ? CLI_EVENT_TYPES.FILE_WRITE
              : fileEdit.kind === APPLY_PATCH_FILE_EDIT_KINDS.DELETE
                ? CLI_EVENT_TYPES.FILE_DELETE
                : CLI_EVENT_TYPES.FILE_EDIT,
          timestamp,
          data: {
            path: fileEdit.path,
            structuredPatch: fileEdit.structuredPatch,
            ...(fileEdit.kind === APPLY_PATCH_FILE_EDIT_KINDS.ADD && {
              content: "",
            }),
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
   * const r = await tools.exec_command({cmd:"...", workdir:"..."}); text(r.output)
   * ```
   * ```js
   * const patch = "*** Begin Patch\n...*** End Patch";
   * text(await tools.apply_patch(patch));
   * ```
   * ```js
   * const r = await tools.write_stdin({session_id: 56047, chars: ""}); text(...)
   * ```
   * ```js
   * const r = await tools.update_plan({plan: [{step: "...", status: "..."}]});
   * ```
   * ```js
   * const result = await tools.mcp__ctrlyoke__ctrlyoke_append_queue({ position: "end", steps: [...] });
   * ```
   *
   * This unwraps that snippet back into the underlying shell command,
   * apply_patch payload, plan update, backgrounded-session poll, or MCP tool
   * invocation and delegates to {@link buildLogToolInitiatedEvents} /
   * {@link buildPlanEvents} so the rest of the pipeline emits BASH_COMMAND /
   * FILE_EDIT / TEXT / MCP_TOOL_CALL events instead of an opaque
   * `exec(input: ...)` tool-call row — the opaque form is also what defeats
   * "find in output", since the row title truncates before the real tool
   * name is reached. Falls back to a generic tool call when the snippet
   * cannot be parsed.
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
        CODEX_TOOL_NAMES.EXEC,
        { input },
        callId,
        timestamp
      );
    }

    if (parsed.kind === CODEX_EXEC_OPERATION_KINDS.PATCH) {
      return this.buildLogToolInitiatedEvents(
        CODEX_TOOL_NAMES.APPLY_PATCH,
        { input: parsed.patch },
        callId,
        timestamp
      );
    }

    if (parsed.kind === CODEX_EXEC_OPERATION_KINDS.MCP) {
      return this.buildLogToolInitiatedEvents(
        parsed.toolName,
        this.parseMcpCallArguments(parsed.argsText),
        callId,
        timestamp
      );
    }

    if (parsed.kind === CODEX_EXEC_OPERATION_KINDS.PLAN) {
      return this.buildPlanEvents(parsed.items, timestamp);
    }

    if (parsed.kind === CODEX_EXEC_OPERATION_KINDS.CONTINUE) {
      const sessionLabel = parsed.sessionId ?? "?";
      const command = parsed.chars
        ? `(sending input to running command, session ${sessionLabel}): ${parsed.chars}`
        : `(waiting for output from running command, session ${sessionLabel})`;
      return this.buildLogToolInitiatedEvents(
        CODEX_TOOL_NAMES.SHELL_COMMAND,
        { command },
        callId,
        timestamp
      );
    }

    return this.buildLogToolInitiatedEvents(
      CODEX_TOOL_NAMES.SHELL_COMMAND,
      { command: parsed.command, workingDir: parsed.workdir },
      callId,
      timestamp
    );
  }

  /**
   * Matches an MCP tool invocation inside a Codex `exec` snippet, e.g.
   * `tools.mcp__ctrlyoke__ctrlyoke_append_queue(`. Checked before every other
   * branch in {@link parseExecInput}: an MCP call's JSON-ish argument object
   * (often a multi-line prompt string) can freely contain words like
   * "apply_patch" or "command:" that would otherwise false-positive on the
   * other heuristics below.
   */
  private static readonly MCP_TOOL_CALL_PATTERN =
    /\btools\.(mcp__[A-Za-z0-9_-]+)\s*\(/;

  /**
   * Unwrap a Codex `exec` JavaScript snippet into its underlying operation.
   *
   * @returns A shell command (with optional workdir), an apply_patch payload,
   *          a plan/todo-list update, a backgrounded-session poll/input
   *          (`write_stdin`), an MCP tool invocation, or null when the
   *          snippet matches no known helper.
   */
  static parseExecInput(input: string): CodexExecOperation | null {
    const mcpMatch = this.MCP_TOOL_CALL_PATTERN.exec(input);
    if (mcpMatch) {
      const toolName = mcpMatch[1];
      const argsStart = mcpMatch.index + mcpMatch[0].length;
      const argsText = this.extractBalancedCallArguments(
        input,
        argsStart
      ).trim();
      return { kind: CODEX_EXEC_OPERATION_KINDS.MCP, toolName, argsText };
    }

    if (
      input.includes(CODEX_TOOL_NAMES.APPLY_PATCH) ||
      input.includes("*** Begin Patch")
    ) {
      const patch = this.extractJsStringLiterals(input).find((literal) =>
        literal.includes("*** Begin Patch")
      );
      if (patch) {
        return { kind: CODEX_EXEC_OPERATION_KINDS.PATCH, patch };
      }
    }

    if (input.includes(CODEX_TOOL_NAMES.UPDATE_PLAN)) {
      const items = this.parsePlanItems(input);
      if (items.length > 0) {
        return { kind: CODEX_EXEC_OPERATION_KINDS.PLAN, items };
      }
    }

    if (input.includes(CODEX_TOOL_NAMES.WRITE_STDIN)) {
      const sessionIdMatch = /\bsession_id\s*:\s*(\d+)/.exec(input);
      const chars = this.readJsObjectStringValue(input, "chars") ?? "";
      return {
        kind: CODEX_EXEC_OPERATION_KINDS.CONTINUE,
        sessionId: sessionIdMatch?.[1],
        chars,
      };
    }

    if (
      input.includes(CODEX_TOOL_NAMES.SHELL_COMMAND) ||
      input.includes(CODEX_TOOL_NAMES.EXEC_COMMAND) ||
      /\bcommand\s*:/.test(input) ||
      /\bcmd\s*:/.test(input)
    ) {
      const command =
        this.readJsObjectStringValue(input, "command") ??
        this.readJsObjectStringValue(input, "cmd");
      if (command !== undefined) {
        const workdir = this.readJsObjectStringValue(input, "workdir");
        return { kind: CODEX_EXEC_OPERATION_KINDS.SHELL, command, workdir };
      }
    }

    return null;
  }

  /**
   * Parse the `plan: [{step, status}, ...]` array out of a Codex
   * `tools.update_plan({...})` exec snippet. Uses brace/bracket-balanced
   * scanning (not `JSON.parse`) because Codex serializes these with bare
   * (unquoted) JS object keys.
   */
  private static parsePlanItems(
    input: string
  ): Array<{ step: string; status: string }> {
    return this.extractJsObjectArrayElements(input, "plan")
      .map((element) => ({
        step: this.readJsObjectStringValue(element, "step") ?? "",
        status: this.readJsObjectStringValue(element, "status") ?? "",
      }))
      .filter((item) => item.step.length > 0);
  }

  /** Build the compact "Todo List" text event used to render a plan update. */
  private static buildPlanEvents(
    items: Array<{ step: string; status: string }>,
    timestamp: number
  ): CliEvent[] {
    const todoText = items
      .map(
        (item, index) =>
          `${index + 1}. [${item.status === CODEX_TODO_ITEM_STATUS.COMPLETED ? "x" : " "}] ${item.step}`
      )
      .join("\n");
    return [
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp,
        data: { text: `Todo List:\n${todoText}` } as TextData,
      },
    ];
  }

  /**
   * Extract the raw argument text of a `tools.<mcpTool>(...)` call, starting
   * just past its opening `(`. Scans char-by-char tracking combined
   * paren/brace/bracket depth (skipping over string/template literals via
   * {@link readJsStringLiteral}) so nested calls, object/array literals, and
   * multi-line prompt strings inside the arguments don't break on their own
   * `(`/`{`/`[` characters. Returns the substring up to (excluding) the
   * matching closing `)`.
   */
  private static extractBalancedCallArguments(
    src: string,
    start: number
  ): string {
    let i = start;
    let depth = 1; // already past the call's opening '('
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const literal = this.readJsStringLiteral(src, i);
        if (literal) {
          i = literal.endIdx;
          continue;
        }
      }
      if (ch === "(" || ch === "{" || ch === "[") {
        depth += 1;
      } else if (ch === ")" || ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    return src.slice(start, i);
  }

  /**
   * Best-effort conversion of an MCP call's argument text into a params
   * object for display. Codex's `exec` wrapper serializes arguments as a JS
   * object literal (bare keys, template-literal strings) rather than JSON, so
   * `JSON.parse` only succeeds for simple/empty argument objects (e.g. `{}`).
   * Anything else falls back to showing the raw call text verbatim — the
   * user explicitly doesn't want a bespoke MCP-argument parser/viewer here,
   * just a discoverable, honest view of what was actually sent.
   */
  private static parseMcpCallArguments(
    argsText: string
  ): Record<string, unknown> {
    if (!argsText) {
      return {};
    }
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON (bare keys, template literals, trailing commas, ...)
    }
    return { arguments: argsText };
  }

  /**
   * Extract each top-level `{ ... }` object substring from a `key: [ ... ]`
   * array within a JS object literal. Scans char-by-char (skipping over
   * string literals, so braces/brackets embedded in string content don't
   * confuse the depth count) rather than using `JSON.parse`, since Codex's
   * `exec` wrapper snippets use bare (unquoted) object keys.
   */
  private static extractJsObjectArrayElements(
    src: string,
    key: string
  ): string[] {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyRegex = new RegExp(
      `(?:["']${escapedKey}["']|${escapedKey})\\s*:\\s*\\[`
    );
    const match = keyRegex.exec(src);
    if (!match) {
      return [];
    }

    let i = match.index + match[0].length; // just past the array's '['
    let bracketDepth = 1;
    let braceDepth = 0;
    let objectStart = -1;
    const elements: string[] = [];

    while (i < src.length && bracketDepth > 0) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const literal = this.readJsStringLiteral(src, i);
        if (literal) {
          i = literal.endIdx;
          continue;
        }
      }
      if (ch === "[") {
        bracketDepth += 1;
      } else if (ch === "]") {
        bracketDepth -= 1;
      } else if (ch === "{") {
        if (braceDepth === 0) {
          objectStart = i;
        }
        braceDepth += 1;
      } else if (ch === "}") {
        braceDepth -= 1;
        if (braceDepth === 0 && objectStart !== -1) {
          elements.push(src.slice(objectStart, i + 1));
          objectStart = -1;
        }
      }
      i += 1;
    }

    return elements;
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
          // Mutate the shared data object in place (like
          // applyPatchApplyEndPositions) so the already-pushed INITIATED
          // event — which references this same object — picks up the fix too.
          if (data?.path) {
            data.structuredPatch = this.correctUncorrectedHunkPositions(
              data.path,
              data.structuredPatch
            );
          }
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

      case CLI_EVENT_TYPES.MCP_TOOL_CALL:
        return [
          this.buildMcpToolCallCompletedEvent(
            primaryInitiatedData as McpToolCallData | undefined,
            outputText,
            success,
            timestamp
          ),
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
   * Build a COMPLETED MCP_TOOL_CALL event, embedding the tool result onto the
   * same `server`/`tool`/`parameters` carried by the INITIATED event.
   */
  private static buildMcpToolCallCompletedEvent(
    initiatedData: McpToolCallData | undefined,
    outputText: string,
    success: boolean,
    timestamp: number
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
      timestamp,
      data: {
        server: initiatedData?.server ?? "unknown",
        tool: initiatedData?.tool ?? "unknown",
        parameters: initiatedData?.parameters,
        result: { success, output: outputText },
      } as McpToolCallData,
    };
  }

  /**
   * Build a COMPLETED/FAILED CliEvent for a `function_call_output` result.
   *
   * Parses Codex's function_call_output format:
   * `"Exit code: X\nWall time: Y\nTotal output lines: Z\nOutput:\n<content>"`
   *
   * Bash commands and request_user_input arrive via function_call_output; other
   * tools use custom_tool_call_output. Unknown calls fall back to TOOL_RESULT.
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
    if (initiatedEvent?.type === CLI_EVENT_TYPES.ASK_USER_QUESTION) {
      return this.buildRequestUserInputCompletedEvent(
        rawOutput,
        callId,
        timestamp,
        initiatedEvent
      );
    }

    if (initiatedEvent?.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
      return this.buildMcpToolCallCompletedEvent(
        initiatedEvent.data as McpToolCallData | undefined,
        rawOutput,
        true,
        timestamp
      );
    }

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

  private static buildRequestUserInputInitiatedEvent(
    params: Record<string, unknown>,
    toolCallId: string | undefined,
    timestamp: number
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp,
      data: {
        toolCallId,
        questions: this.parseRequestUserInputQuestions(params.questions),
        status: OPERATION_STATUS.INITIATED,
      } as AskUserQuestionData,
    };
  }

  private static parseRequestUserInputQuestions(
    rawQuestions: unknown
  ): AskUserQuestionEntry[] {
    if (!Array.isArray(rawQuestions)) {
      return [];
    }

    return rawQuestions.map((rawQuestion) => {
      const question = (rawQuestion ?? {}) as Record<string, unknown>;
      return {
        id: typeof question.id === "string" ? question.id : undefined,
        question:
          typeof question.question === "string" ? question.question : "",
        header:
          typeof question.header === "string" ? question.header : undefined,
        multiSelect:
          typeof question.multiSelect === "boolean"
            ? question.multiSelect
            : undefined,
        options: this.parseRequestUserInputOptions(question.options),
      };
    });
  }

  private static parseRequestUserInputOptions(
    rawOptions: unknown
  ): AskUserQuestionOption[] {
    if (!Array.isArray(rawOptions)) {
      return [];
    }

    return rawOptions.map((rawOption) => {
      const option = (rawOption ?? {}) as Record<string, unknown>;
      return {
        label: typeof option.label === "string" ? option.label : "",
        description:
          typeof option.description === "string"
            ? option.description
            : undefined,
        preview:
          typeof option.preview === "string" ? option.preview : undefined,
      };
    });
  }

  private static buildRequestUserInputCompletedEvent(
    rawOutput: string,
    toolCallId: string | undefined,
    timestamp: number,
    initiatedEvent: CliEvent
  ): CliEvent {
    const initiatedData = initiatedEvent.data as AskUserQuestionData;
    const parsedOutput = this.parseRequestUserInputOutput(rawOutput);
    const answers = parsedOutput?.answers;

    if (!answers) {
      return {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        timestamp,
        data: {
          toolCallId,
          questions: initiatedData.questions,
          status: OPERATION_STATUS.FAILED,
          declined: {
            reason: "rejected",
            feedback: rawOutput || undefined,
          },
        } as AskUserQuestionData,
      };
    }

    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp,
      data: {
        toolCallId,
        questions: initiatedData.questions.map((question) =>
          this.resolveRequestUserInputAnswer(question, answers)
        ),
        status: OPERATION_STATUS.COMPLETED,
      } as AskUserQuestionData,
    };
  }

  private static parseRequestUserInputOutput(rawOutput: string): {
    answers?: Record<string, unknown>;
  } | null {
    try {
      const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
      const answers = parsed.answers;
      return answers && typeof answers === "object" && !Array.isArray(answers)
        ? { answers: answers as Record<string, unknown> }
        : null;
    } catch {
      return null;
    }
  }

  private static resolveRequestUserInputAnswer(
    question: AskUserQuestionEntry,
    answers: Record<string, unknown>
  ): AskUserQuestionEntry {
    const rawAnswer =
      (question.id ? answers[question.id] : undefined) ??
      answers[question.question];
    const answerValues = this.extractRequestUserInputAnswerValues(rawAnswer);
    if (answerValues.length === 0) {
      return { ...question };
    }

    const resolved = answerValues.map((value) =>
      this.resolveRequestUserInputOption(value, question.options)
    );
    const selectedOptions = resolved.filter(
      (value): value is { answer: string; preview?: string } =>
        typeof value === "object"
    );
    return {
      ...question,
      answer: resolved
        .map((value) => (typeof value === "string" ? value : value.answer))
        .join(", "),
      answerPreview: selectedOptions[0]?.preview,
    };
  }

  private static extractRequestUserInputAnswerValues(
    rawAnswer: unknown
  ): string[] {
    const answerPayload =
      rawAnswer && typeof rawAnswer === "object" && !Array.isArray(rawAnswer)
        ? (rawAnswer as { answers?: unknown }).answers
        : rawAnswer;
    const values = Array.isArray(answerPayload)
      ? answerPayload
      : answerPayload === undefined
        ? []
        : [answerPayload];
    return values.filter((value): value is string => typeof value === "string");
  }

  private static resolveRequestUserInputOption(
    answer: string,
    options: AskUserQuestionOption[]
  ): string | { answer: string; preview?: string } {
    const option = options.find((candidate) => candidate.label === answer);
    return option ? { answer: option.label, preview: option.preview } : answer;
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

  /**
   * Fill in real line offsets for a FILE_EDIT hunk list that is still at its
   * bare-marker default of oldStart/newStart === 1, by locating each hunk's
   * post-image content in the file's current on-disk contents.
   *
   * Newer Codex builds (gpt-5.x) execute `apply_patch` from inside the `exec`
   * sandbox wrapper (`text(await tools.apply_patch(patch))`) instead of the
   * discrete `apply_patch` tool, and this call shape never emits a
   * `patch_apply_end` event — the only other source of corrected offsets (see
   * `applyPatchApplyEndPositions` in CodexLogParser). Without it every hunk
   * stays at line 1 forever, in both the live view and the final reparse.
   *
   * By the time the tool's COMPLETED event arrives the edit is already
   * written to disk, so each hunk's context + added lines (its "post-image")
   * can be searched for verbatim in the current file content: that block's
   * position IS the hunk's real `newStart`. `oldStart` then follows from
   * `newStart` minus the cumulative line-count delta of every earlier hunk in
   * the same file, since the untouched text between hunks is identical in the
   * old and new file.
   *
   * A hunk whose oldStart/newStart is already something other than the
   * default 1 has already been corrected (by `patch_apply_end`, when it does
   * fire) and is left untouched. A hunk search that finds no match — the file
   * no longer exists, or later edits already changed this exact region again
   * — is also left untouched rather than guessed at.
   */
  private static correctUncorrectedHunkPositions(
    path: string,
    structuredPatch: UnifiedDiffHunk[] | undefined
  ): UnifiedDiffHunk[] | undefined {
    if (
      !structuredPatch?.length ||
      structuredPatch[0].oldStart !== 1 ||
      structuredPatch[0].newStart !== 1
    ) {
      return structuredPatch;
    }

    let fileLines: string[];
    try {
      fileLines = fs.readFileSync(path, "utf8").split(/\r\n|\r|\n/);
    } catch {
      return structuredPatch;
    }

    let cumulativeLineDelta = 0;
    return structuredPatch.map((hunk) => {
      const postImageLines = hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("+"))
        .map((line) => line.slice(1));

      const matchIndex = this.findLineSequence(fileLines, postImageLines);
      const lineDelta = hunk.newLines - hunk.oldLines;
      if (matchIndex === -1) {
        cumulativeLineDelta += lineDelta;
        return hunk;
      }

      const newStart = matchIndex + 1;
      const corrected: UnifiedDiffHunk = {
        ...hunk,
        oldStart: newStart - cumulativeLineDelta,
        newStart,
      };
      cumulativeLineDelta += lineDelta;
      return corrected;
    });
  }

  /** Finds the first index in `haystack` where `needle` occurs as a contiguous run, or -1. */
  private static findLineSequence(
    haystack: string[],
    needle: string[]
  ): number {
    if (needle.length === 0 || needle.length > haystack.length) {
      return -1;
    }
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          continue outer;
        }
      }
      return i;
    }
    return -1;
  }
}
