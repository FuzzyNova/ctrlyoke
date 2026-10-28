/**
 * Output rendering utilities.
 *
 * Focused on tool call display helpers and file path formatting.
 * Diff computation lives in diffUtils.ts; markdown export in markdownExport.ts.
 */
import { truncate } from "./string";
import type { CliOutput as CliOutputType } from "../types/cliEvents";
import {
  OUTPUT_TOOL_BADGE_LABELS,
  SCRIPT_OUTPUT_SOURCES,
  type ScriptOutputSource,
} from "@root/types/DashboardConstants";
import { getStepOutputText } from "@root/utils/StepOutputText";
import { StepOutputTextMode } from "@root/types/DashboardConstants";

const OUTPUT_TOOL_NAMES = {
  GREP: "grep",
  SEARCH: "search",
} as const;
export { formatTime } from "./time";
export {
  type DiffLine,
  generateDiffLines,
  normalizeStructuredPatch,
  isStructuredPatchMalformed,
  countStructuredPatchDisplayLines,
} from "./diffUtils";

/**
 * Returns the first `count` whitespace-delimited words of `text`, appending
 * "..." when the source has more words than the limit.
 */
export function getFirstWords(text: string | undefined, count: number): string {
  if (!text?.trim()) return "";
  const words = text.trim().split(/\s+/);
  const snippet = words.slice(0, count).join(" ");
  return words.length > count ? `${snippet}...` : snippet;
}

/**
 * Shorten a file path for display (shows "...parent/file.ext" when too long).
 */
export function shortenPath(
  filePath: string | undefined,
  maxLen: number = 50
): string {
  if (!filePath || filePath.length <= maxLen) return filePath || "";

  const parts = filePath.split(/[/\\]/);
  if (parts.length <= 2) return filePath;

  return "..." + parts.slice(-2).join("/");
}

/**
 * Format a timestamp as HH:MM:SS.
 */
export function formatTimeHMS(timestampMs: number): string {
  const date = new Date(timestampMs);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRunLabel(runIndex: number): string {
  return runIndex > 0 ? `Re-run ${runIndex}` : "";
}

export function formatAttemptLabel(
  attemptIndex: number,
  includeInitialAttempt: boolean = false
): string {
  if (attemptIndex > 0) {
    return `Retry ${attemptIndex}`;
  }
  return includeInitialAttempt ? "Initial Attempt" : "";
}

export function formatExecutionBadge(
  runIndex: number,
  attemptIndex: number,
  includeInitialAttempt: boolean = false
): string {
  return [
    formatRunLabel(runIndex),
    formatAttemptLabel(attemptIndex, includeInitialAttempt),
  ]
    .filter((label) => label.length > 0)
    .join(" · ");
}

/**
 * What a condition or setup script's step header calls it, e.g.
 * "End condition retry 2"; undefined for a script step, which uses its step
 * label.
 */
export function formatScriptConditionLabel(
  source: ScriptOutputSource | undefined,
  attemptIndex: number
): string | undefined {
  switch (source) {
    case SCRIPT_OUTPUT_SOURCES.PRE_CONDITION:
      return "Pre-condition";
    case SCRIPT_OUTPUT_SOURCES.END_CONDITION:
      return `End condition${attemptIndex > 0 ? ` retry ${attemptIndex + 1}` : ""}`;
    case SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP:
      return "Worktree setup";
    default:
      return undefined;
  }
}

export function buildDiffAnchorPrefix(
  kindSlug: "q" | "fp",
  stepIndex: number,
  runIndex: number,
  attemptIndex: number
): string {
  return `cy-diff-${kindSlug}-${stepIndex}-r${runIndex}-a${attemptIndex}`;
}

/**
 * Normalizing a step's events to extract its text is costly for long steps,
 * and the output rows and step chips ask for the same finished output on every
 * render. A finished output is not mutated, so its text is cached by identity;
 * the event array and count are checked too so an in-place append can never
 * serve stale text.
 */
interface CachedCopyText {
  events: NonNullable<CliOutputType["structured"]>["events"] | undefined;
  eventCount: number;
  text: string | undefined;
}
const copyTextCache = new WeakMap<CliOutputType, CachedCopyText>();

/**
 * Extracts assistant-authored text from a CLI output's structured events.
 * Returns undefined when there is no text content.
 */
export function getStepAssistantTextForCopy(
  output: CliOutputType
): string | undefined {
  const events = output.structured?.events;
  const eventCount = events?.length ?? 0;
  const cached = copyTextCache.get(output);
  if (cached && cached.events === events && cached.eventCount === eventCount) {
    return cached.text;
  }
  const text =
    getStepOutputText({ output }, StepOutputTextMode.ASSISTANT) || undefined;
  if (!output.isStreaming) {
    copyTextCache.set(output, { events, eventCount, text });
  }
  return text;
}

/** @deprecated Use getStepAssistantTextForCopy. */
export const extractCliOutputText = getStepAssistantTextForCopy;

/**
 * Detects user-initiated stop/cancel messages that should render as warnings
 * rather than hard errors.
 */
export function isUserStoppedMessage(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.trim().toLowerCase();
  return (
    normalized === "stopped by user" ||
    normalized === "workflow stopped by user"
  );
}

/**
 * Extract key parameters from a tool call for compact display.
 */
export function extractKeyParameters(
  toolName: string,
  parameters?: Record<string, unknown>
): string {
  if (!parameters) return "";

  const lowerName = toolName.toLowerCase();

  if (
    lowerName === OUTPUT_TOOL_BADGE_LABELS.BASH ||
    lowerName === OUTPUT_TOOL_BADGE_LABELS.SHELL
  ) {
    return truncate((parameters.command as string) || "", 80);
  }

  if (
    lowerName === OUTPUT_TOOL_BADGE_LABELS.WRITE ||
    lowerName === OUTPUT_TOOL_BADGE_LABELS.EDIT ||
    lowerName === OUTPUT_TOOL_BADGE_LABELS.READ
  ) {
    return shortenPath(parameters.file_path as string);
  }

  if (lowerName === "multiedit") {
    const fileCount = Array.isArray(parameters.files)
      ? parameters.files.length
      : 1;
    return `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
  }

  if (lowerName === "glob") {
    return (parameters.pattern as string) || "";
  }

  if (
    lowerName === OUTPUT_TOOL_NAMES.GREP ||
    lowerName === OUTPUT_TOOL_NAMES.SEARCH
  ) {
    const pattern = parameters.pattern
      ? `"${truncate(parameters.pattern as string, 40)}"`
      : "";
    const path = parameters.path
      ? `, path: ${shortenPath(parameters.path as string)}`
      : "";
    return `${pattern}${path}`;
  }

  if (lowerName === "task") {
    return truncate(
      (parameters.description as string) || (parameters.prompt as string) || "",
      60
    );
  }

  const keys = Object.keys(parameters).slice(0, 3);
  return keys
    .map((k) => `${k}: ${truncate(String(parameters[k]), 30)}`)
    .join(", ");
}
