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
