/**
 * Output rendering utilities.
 *
 * Focused on tool call display helpers and file path formatting.
 * Diff computation lives in diffUtils.ts; markdown export in markdownExport.ts.
 */
import { truncate } from "./string";
import type { CliOutput as CliOutputType, TextData } from "../types/cliEvents";
import { CLI_EVENT_TYPES } from "../types/cliEvents";
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

export function buildDiffAnchorPrefix(
  kindSlug: "q" | "fp",
  stepIndex: number,
  runIndex: number,
  attemptIndex: number
): string {
  return `fp-diff-${kindSlug}-${stepIndex}-r${runIndex}-a${attemptIndex}`;
}

/**
 * Extracts the plain-text response from a CLI output — checks `response`
 * first, then falls back to concatenating TEXT events from structured output.
 * Returns undefined when there is no text content.
 *
 * Post-completion follow-up activity (a harness auto-resuming a backgrounded
 * task — see `mergeResumedActivityIntoOutput` / `handleSessionActivityResumed`)
 * only ever lands in `structured.events`, appended after a `FOLLOW_UP_RESUMED`
 * divider; the persisted `response` field is never updated. So when a divider is
 * present, fold the follow-up TEXT back onto `response` — otherwise copy would
 * silently drop everything the AI produced after resuming.
 */
export function extractCliOutputText(
  output: CliOutputType
): string | undefined {
  const events = output.structured?.events;
  const dividerIndex = events
    ? events.findIndex((e) => e.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED)
    : -1;
  const followUpText =
    dividerIndex >= 0
      ? events!
          .slice(dividerIndex + 1)
          .filter((e) => e.type === CLI_EVENT_TYPES.TEXT)
          .map((e) => (e.data as TextData).text)
          .filter(Boolean)
          .join("")
      : "";

  if (typeof output.response === "string" && output.response.trim()) {
    return output.response + followUpText;
  }
  // Fallback path already includes follow-up TEXT (all TEXT events, both before
  // and after the divider), so no separate follow-up append is needed here.
  if (events?.length) {
    const parts = events
      .filter((e) => e.type === CLI_EVENT_TYPES.TEXT)
      .map((e) => (e.data as TextData).text)
      .filter(Boolean);
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
}

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

  if (lowerName === "bash" || lowerName === "shell") {
    return truncate((parameters.command as string) || "", 80);
  }

  if (lowerName === "write" || lowerName === "edit" || lowerName === "read") {
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

  if (lowerName === "grep" || lowerName === "search") {
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
