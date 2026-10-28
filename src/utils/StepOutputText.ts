import type { ScriptRuntimeOutput } from "../types/CtrlYokeTypes";
import {
  CLI_EVENT_TYPES,
  StepOutputTextMode,
} from "../types/DashboardConstants";
import type { CliEvent, FileEditData } from "../types/CliOutputTypes";
import type { CliOutput } from "../types/WebviewMessageTypes";
import type { LegacyCliOutputV1 } from "../types/WorkflowTimelineTypes";
import { normalizeCliEvents } from "./CliEventNormalizer";
import { countStructuredPatchChanges } from "./CliEventDiff";
import { joinResponseText } from "./ResponseTextJoin";
import { sanitizeTerminalOutput } from "./TerminalOutputSanitizer";

/** Input projection shared by the resolver and webview without importing core. */
export interface StepOutputSource {
  output?: CliOutput | LegacyCliOutputV1 | null;
  scriptOutput?: ScriptRuntimeOutput;
}

/** Plain assistant-authored text from TEXT events only. */
export function getAssistantText(events: readonly CliEvent[]): string {
  const parts = normalizeCliEvents([...events])
    .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
    .map((event) => ("text" in event.data ? event.data.text : ""));
  return joinResponseText(parts);
}

/**
 * Event types that end a stretch of assistant prose: anything the agent did
 * between two messages. Thinking, compaction and invisible markers do not.
 */
const RESPONSE_BOUNDARY_EVENT_TYPES: ReadonlySet<string> = new Set([
  CLI_EVENT_TYPES.TERMINAL_OUTPUT,
  CLI_EVENT_TYPES.BASH_COMMAND,
  CLI_EVENT_TYPES.FILE_READ,
  CLI_EVENT_TYPES.FILE_WRITE,
  CLI_EVENT_TYPES.FILE_EDIT,
  CLI_EVENT_TYPES.FILE_DELETE,
  CLI_EVENT_TYPES.MCP_TOOL_CALL,
  CLI_EVENT_TYPES.WEB_SEARCH,
  CLI_EVENT_TYPES.ASK_USER_QUESTION,
  CLI_EVENT_TYPES.TOOL_CALL,
  CLI_EVENT_TYPES.TOOL_RESULT,
  CLI_EVENT_TYPES.USER_STEER,
  CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
]);

/**
 * The step's own last message: the TEXT written after its last tool call or
 * other action, which is what an agent's turn ends with. Text from subagents
 * is skipped. Falls back to the last earlier message when the turn ended on
 * an action instead of text.
 */
export function getFinalAssistantText(events: readonly CliEvent[]): string {
  const parts: string[] = [];
  const normalized = normalizeCliEvents([...events]);
  for (let index = normalized.length - 1; index >= 0; index--) {
    const event = normalized[index];
    if (event.subagent) continue;
    if (event.type === CLI_EVENT_TYPES.TEXT && "text" in event.data) {
      parts.unshift(event.data.text);
    } else if (
      parts.length > 0 &&
      RESPONSE_BOUNDARY_EVENT_TYPES.has(event.type)
    ) {
      break;
    }
  }
  return joinResponseText(parts);
}

/** TEXT, thinking summaries, and compact file annotations used by the legacy false mode. */
export function getTranscriptText(events: readonly CliEvent[]): string {
  const parts: string[] = [];
  for (const event of normalizeCliEvents([...events])) {
    if (event.type === CLI_EVENT_TYPES.TEXT && "text" in event.data) {
      parts.push(event.data.text);
    } else if (
      event.type === CLI_EVENT_TYPES.THINKING &&
      "text" in event.data
    ) {
      const text = event.data.text.trim();
      if (text) parts.push(`\n[Thinking]\n${text}\n[/Thinking]`);
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_WRITE &&
      "path" in event.data
    ) {
      parts.push(`\n[Created: ${event.data.path}]`);
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_EDIT &&
      "path" in event.data
    ) {
      const edit = event.data as FileEditData;
      const changes = edit.structuredPatch?.length
        ? countStructuredPatchChanges(edit.structuredPatch)
        : undefined;
      parts.push(
        changes
          ? `\n[Edited: ${edit.path} (+${changes.added}, -${changes.removed})]`
          : `\n[Edited: ${edit.path}]`
      );
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_DELETE &&
      "path" in event.data
    ) {
      parts.push(`\n[Deleted: ${event.data.path}]`);
    } else if (
      event.type === CLI_EVENT_TYPES.TERMINAL_OUTPUT &&
      "text" in event.data
    ) {
      parts.push(sanitizeTerminalOutput(event.data.text));
    }
  }
  return joinResponseText(parts);
}

/** Match the historical script response projection exactly. */
export function getScriptOutputText(scriptOutput: ScriptRuntimeOutput): string {
  return sanitizeTerminalOutput(
    [scriptOutput.stdout, scriptOutput.stderr].filter(Boolean).join("\n").trim()
  );
}

/** Resolve step text from the durable source, with a read fallback for old records. */
export function getStepOutputText(
  source: StepOutputSource,
  mode: (typeof StepOutputTextMode)[keyof typeof StepOutputTextMode]
): string {
  if (source.scriptOutput) return getScriptOutputText(source.scriptOutput);
  const events = source.output?.structured?.events;
  if (events?.length) {
    return mode === StepOutputTextMode.ASSISTANT
      ? getAssistantText(events)
      : getTranscriptText(events);
  }
  if (source.output && "response" in source.output) {
    return source.output.response ?? "";
  }
  return "";
}
