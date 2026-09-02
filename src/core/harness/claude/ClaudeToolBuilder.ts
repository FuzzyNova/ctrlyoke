import type {
  CliEvent,
  ToolResultData,
  FileEditData,
  FileWriteData,
  FileReadData,
  BashCommandData,
  AskUserQuestionData,
  AskUserQuestionEntry,
  AskUserQuestionOption,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import { Log } from "../../../utils/Log";
import { BaseToolBuilder } from "../shared/BaseToolBuilder";
import { CLAUDE_CONTENT_BLOCK_TYPES } from "./ClaudeProtocolConstants";

/**
 * Builds CliEvents from Claude CLI tool call payloads.
 *
 * Three static methods cover Claude's tool lifecycle:
 * - `buildInitiatedEvents` — tool_use in assistant content → INITIATED event(s) (array)
 * - `processToolResultBlocks` — tool_result in user content → TOOL_RESULT events
 * - `processToolUseResultMetadata` — CLI structured metadata → COMPLETED semantic events
 *
 * ClaudeLogParser uses these methods for both interactive log events and
 * headless stdout events, so the event-shaping logic is never duplicated.
 *
 * Note: Claude's lifecycle differs from Copilot's — there is no start/complete
 * pair correlated by toolCallId. Instead, tool_use and tool_result are separate
 * message-level constructs, and structured completion metadata arrives as a
 * separate CLI-injected field (toolUseResult).
 */
export class ClaudeToolBuilder {
  // ── INITIATED ──────────────────────────────────────────────────────────────

  /**
   * Build INITIATED CliEvents for a Claude tool_use block.
   *
   * Returns an array to support multi-file tools like `multiedit`, which fans
   * out to one FILE_EDIT event per edited file. All other tools return a
   * single-element array.
   *
   * @param toolName - Tool name from tool_use block
   * @param input - Tool input parameters from tool_use block
   * @param toolId - Tool call ID (used in generic TOOL_CALL fallback)
   * @param timestamp - Event timestamp in milliseconds
   * @param callerType - 'direct' for top-level calls, 'subagent' for sub-agent calls
   * @returns Array of CliEvents to spread onto the event stream
   */
  static buildInitiatedEvents(
    toolName: string,
    input: Record<string, unknown>,
    toolId: string | undefined,
    timestamp: number,
    callerType?: string
  ): CliEvent[] {
    const ct = callerType ? { callerType } : {};

    // Claude-specific: AskUserQuestion parses into the full question/option
    // set up front, so the pending question is visible while the user is
    // still answering — the answer arrives later via tryBuildAskUserQuestionEvent.
    if (toolName === "AskUserQuestion") {
      return [
        {
          type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
          timestamp,
          ...ct,
          data: {
            toolCallId: toolId,
            questions: ClaudeToolBuilder.parseAskUserQuestionEntries(
              input.questions
            ),
            status: OPERATION_STATUS.INITIATED,
          } as AskUserQuestionData,
        },
      ];
    }

    // Claude-specific: multiedit fans out to one FILE_EDIT per edited file
    if (toolName === "multiedit" && Array.isArray(input.edits)) {
      return (input.edits as Record<string, unknown>[]).map((edit) => ({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        ...ct,
        data: {
          path:
            ((edit.file_path ?? edit.path) as string | undefined) || "unknown",
          oldContent: (edit.old_string ??
            edit.oldString ??
            edit.old_content ??
            edit.oldContent) as string | undefined,
          newContent: (edit.new_string ??
            edit.newString ??
            edit.new_content ??
            edit.newContent) as string | undefined,
          status: OPERATION_STATUS.INITIATED,
        } as FileEditData,
      }));
    }

    return BaseToolBuilder.buildInitiatedEvents(
      toolName,
      input,
      toolId,
      timestamp,
      ct
    );
  }

  // ── TOOL RESULTS ───────────────────────────────────────────────────────────

  /**
   * Extract display text from a Claude tool_result content block.
   *
   * Claude tool_result content can be:
   * - A string (most common)
   * - An array of content blocks (e.g., `[{type: "text", text: "..."}]`)
   * - null/undefined (empty result)
   * - Other object (serialized as JSON)
   */
  static extractToolResultText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(
          (b: Record<string, unknown>) =>
            b.type === CLAUDE_CONTENT_BLOCK_TYPES.TEXT &&
            typeof b.text === "string"
        )
        .map((b: Record<string, unknown>) => b.text)
        .join("\n");
    }
    if (content != null) {
      return JSON.stringify(content);
    }
    return "";
  }

  /**
   * Process tool_result content blocks into events.
   *
   * Processes content array from user-type messages, creating one event per
   * `tool_result` block. Handles the `is_error` flag from Claude API.
   *
   * `context` lets a caller that also has access to the sibling `toolUseResult`
   * (Claude's per-user-event structured metadata field) and a way to resolve
   * the originating tool's name route AskUserQuestion blocks to a rich
   * ASK_USER_QUESTION event instead of the generic TOOL_RESULT fallback — see
   * `tryBuildAskUserQuestionEvent`. Omit it to get the plain TOOL_RESULT
   * behavior for every block.
   *
   * @param contentBlocks - Array of content blocks from a user message
   * @param timestamp - Timestamp to use for created events
   * @param events - Array to append events to
   */
  static processToolResultBlocks(
    contentBlocks: Record<string, any>[],
    timestamp: number,
    events: CliEvent[],
    context?: {
      toolUseResult?: unknown;
      userFeedback?: string;
      resolveToolName?: (toolUseId: string | undefined) => string | undefined;
    }
  ): void {
    for (const block of contentBlocks) {
      if (block.type !== "tool_result") continue;

      const askEvent = ClaudeToolBuilder.tryBuildAskUserQuestionEvent(
        context?.resolveToolName?.(block.tool_use_id),
        block.tool_use_id,
        context?.toolUseResult,
        block.is_error === true,
        context?.userFeedback,
        timestamp
      );
      if (askEvent) {
        events.push(askEvent);
        continue;
      }

      const outputText = ClaudeToolBuilder.extractToolResultText(block.content);
      events.push({
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        timestamp,
        data: {
          toolCallId: block.tool_use_id,
          result: {
            success: !block.is_error,
            output: outputText,
            error: block.is_error ? outputText : undefined,
          },
        } as ToolResultData,
      });
    }
  }

  // ── ASK USER QUESTION ──────────────────────────────────────────────────────

  private static parseAskUserQuestionOptions(
    rawOptions: unknown
  ): AskUserQuestionOption[] {
    if (!Array.isArray(rawOptions)) return [];
    return rawOptions.map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      return {
        label: typeof o.label === "string" ? o.label : "",
        description:
          typeof o.description === "string" ? o.description : undefined,
        preview: typeof o.preview === "string" ? o.preview : undefined,
      };
    });
  }

  private static parseAskUserQuestionEntries(
    rawQuestions: unknown
  ): AskUserQuestionEntry[] {
    if (!Array.isArray(rawQuestions)) return [];
    return rawQuestions.map((raw) => {
      const q = (raw ?? {}) as Record<string, unknown>;
      return {
        question: typeof q.question === "string" ? q.question : "",
        header: typeof q.header === "string" ? q.header : undefined,
        multiSelect:
          typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
        options: ClaudeToolBuilder.parseAskUserQuestionOptions(q.options),
      };
    });
  }

  /**
   * Structural check for Claude's answered-AskUserQuestion `toolUseResult`
   * shape: `{ questions: [...], answers: { [question]: string }, annotations?: {...} }`.
   * Unambiguous — no other tool's `toolUseResult` carries both `questions` and
   * `answers` — so this alone is enough to detect the answered case without
   * knowing the originating tool name.
   */
  private static isAskUserQuestionResult(
    toolUseResult: unknown
  ): toolUseResult is {
    questions: Array<Record<string, unknown>>;
    answers?: Record<string, string>;
    annotations?: Record<string, { notes?: string; preview?: string }>;
  } {
    if (typeof toolUseResult !== "object" || toolUseResult === null) {
      return false;
    }
    const r = toolUseResult as Record<string, unknown>;
    return (
      Array.isArray(r.questions) &&
      typeof r.answers === "object" &&
      r.answers !== null
    );
  }

  /**
   * Build a rich ASK_USER_QUESTION completion event for a `tool_result` block,
   * covering both Claude's answered and declined shapes. Returns undefined for
   * every other tool so the caller can fall back to the generic TOOL_RESULT event.
   *
   * Two independent signals are needed because a decline carries no structured
   * data of its own (`toolUseResult` is just a rejection string, identical to
   * declining any other tool): the answered shape is self-identifying via
   * `isAskUserQuestionResult`, but the decline case can only be attributed to
   * AskUserQuestion by the originating tool's name — passed in by the caller,
   * which tracks tool_use id → name as it walks the assistant/user event pairs
   * (see `pendingStreamingToolUses` / the batch-local map in ClaudeLogParser).
   *
   * A declined result carries no `questions` of its own — the shared
   * CliEventNormalizer backfills them from the matching INITIATED event when it
   * merges the two into one row.
   */
  static tryBuildAskUserQuestionEvent(
    toolName: string | undefined,
    toolCallId: string | undefined,
    toolUseResult: unknown,
    isError: boolean,
    userFeedback: string | undefined,
    timestamp: number
  ): CliEvent | undefined {
    const looksLikeAnswer =
      ClaudeToolBuilder.isAskUserQuestionResult(toolUseResult);
    if (!looksLikeAnswer && toolName !== "AskUserQuestion") {
      return undefined;
    }

    if (looksLikeAnswer) {
      const r = toolUseResult as {
        questions: Array<Record<string, unknown>>;
        answers?: Record<string, string>;
        annotations?: Record<string, { notes?: string; preview?: string }>;
      };
      const questions: AskUserQuestionEntry[] = r.questions.map((q) => {
        const questionText = typeof q.question === "string" ? q.question : "";
        const annotation = r.annotations?.[questionText];
        return {
          question: questionText,
          header: typeof q.header === "string" ? q.header : undefined,
          multiSelect:
            typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
          options: ClaudeToolBuilder.parseAskUserQuestionOptions(q.options),
          answer: r.answers?.[questionText],
          notes: annotation?.notes,
          answerPreview: annotation?.preview,
        };
      });
      return {
        type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
        timestamp,
        data: {
          toolCallId,
          questions,
          status: OPERATION_STATUS.COMPLETED,
        } as AskUserQuestionData,
      };
    }

    // Declined: Claude reports rejection as a plain string with no structured
    // question data. The "clarify" template is what AskUserQuestion's own
    // "Let's discuss this" path produces; anything else is a plain decline.
    const isClarify =
      isError &&
      typeof userFeedback === "string" &&
      userFeedback.includes("wants to clarify these questions");
    return {
      type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
      timestamp,
      data: {
        toolCallId,
        questions: [],
        status: OPERATION_STATUS.FAILED,
        declined: {
          reason: isClarify ? "clarify" : "rejected",
          feedback: userFeedback,
        },
      } as AskUserQuestionData,
    };
  }

  // ── COMPLETED (structured CLI metadata) ────────────────────────────────────

  /**
   * Process structured toolUseResult metadata into COMPLETED semantic events.
   *
   * Converts Claude CLI's tool execution metadata into typed CliEvents:
   * - File edit (Edit tool) → FILE_EDIT event with structured diff data
   * - File write (Write tool) → FILE_WRITE event
   * - File read (Read tool) → FILE_READ event
   * - Bash command → BASH_COMMAND event with exit code
   *
   * Handles both camelCase (headless mode) and snake_case (interactive terminal)
   * field names for Edit tool parameters.
   *
   * @param toolUseResult - Structured tool execution metadata from Claude CLI
   * @param timestamp - Timestamp to use for created events
   * @param events - Array to append events to
   * @param toolCallId - The originating tool_use id (from the paired
   * tool_result block's `tool_use_id`). Required to correlate a FILE_READ
   * completion back to its INITIATED event in `CliEventNormalizer` — without
   * it, the two key off different values (call id vs. path) and never merge,
   * surfacing as a duplicated read in the output pane.
   */
  static processToolUseResultMetadata(
    toolUseResult: Record<string, any>,
    timestamp: number,
    events: CliEvent[],
    toolCallId?: string
  ): void {
    // File edit result (Edit tool) - check both camelCase and snake_case
    // Headless mode uses camelCase (oldString/newString)
    // Interactive terminal uses snake_case (old_string/new_string)
    const oldString = toolUseResult.oldString || toolUseResult.old_string;
    const newString = toolUseResult.newString || toolUseResult.new_string;

    if (oldString && newString) {
      Log.debug(
        `[ClaudeToolResult] Edit operation - oldString=${oldString ? "present" : "missing"}, ` +
          `newString=${newString ? "present" : "missing"}, ` +
          `structuredPatch=${toolUseResult.structuredPatch ? `${toolUseResult.structuredPatch.length} hunks` : "missing"}`
      );

      events.push({
        type: CLI_EVENT_TYPES.FILE_EDIT,
        timestamp,
        data: {
          path: toolUseResult.filePath || "unknown",
          oldContent: oldString,
          newContent: newString,
          structuredPatch: toolUseResult.structuredPatch,
          userModified: toolUseResult.userModified,
          replaceAll: toolUseResult.replaceAll,
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        } as FileEditData,
      });
      return;
    }

    // File write result (Write tool)
    // Must have a file path to avoid matching Grep results (which also have a `content` field)
    // Check both "create" (log format) and "write" (stream format) type values
    if (
      (toolUseResult.type === "create" ||
        toolUseResult.type === "write" ||
        toolUseResult.content) &&
      (toolUseResult.filePath || toolUseResult.path)
    ) {
      events.push({
        type: CLI_EVENT_TYPES.FILE_WRITE,
        timestamp,
        data: {
          path: toolUseResult.filePath || toolUseResult.path || "unknown",
          content: toolUseResult.content || "",
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        } as FileWriteData,
      });
      return;
    }

    // File read result (Read tool)
    if (
      toolUseResult.type === CLAUDE_CONTENT_BLOCK_TYPES.TEXT &&
      toolUseResult.file
    ) {
      const file = toolUseResult.file;
      // startLine/numLines/totalLines are the CLI's authoritative account of
      // what was actually read — more reliable than echoing the tool_use
      // input's requested offset/limit. A full-file read reports
      // startLine === 1 and numLines === totalLines; only a genuine segment
      // read (a subset of the file) should surface a line range.
      const isSegmentRead =
        typeof file.startLine === "number" &&
        typeof file.numLines === "number" &&
        (file.startLine > 1 ||
          (typeof file.totalLines === "number" &&
            file.numLines < file.totalLines));
      events.push({
        type: CLI_EVENT_TYPES.FILE_READ,
        timestamp,
        data: {
          path: file.filePath || "unknown",
          content: file.content || "",
          toolCallId,
          ...(isSegmentRead
            ? {
                lineStart: file.startLine,
                lineEnd: file.startLine + file.numLines - 1,
              }
            : {}),
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        } as FileReadData,
      });
      return;
    }

    // Bash command result
    if (toolUseResult.command || toolUseResult.type === "bash") {
      const exitCode = toolUseResult.exitCode ?? (toolUseResult.error ? 1 : 0);
      events.push({
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        timestamp,
        data: {
          command: toolUseResult.command || "unknown",
          workingDir: toolUseResult.workingDir || toolUseResult.cwd,
          exitCode,
          // Prefer stdout over output — stdout has full content while output may contain <persisted-output> placeholder
          output: toolUseResult.stdout || toolUseResult.output,
          error: toolUseResult.stderr || toolUseResult.error,
          status:
            exitCode === 0
              ? OPERATION_STATUS.COMPLETED
              : OPERATION_STATUS.FAILED,
        } as BashCommandData,
      });
      return;
    }
  }
}
