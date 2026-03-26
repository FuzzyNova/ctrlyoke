/**
 * Output rendering utilities.
 *
 * Focused on tool call display helpers and file path formatting.
 * Diff computation lives in diffUtils.ts; markdown export in markdownExport.ts.
 *
 * Re-exports from diffUtils plus the string/time helpers so existing
 * consumers don't need to update their import paths.
 */
import { truncate } from "./string";
export { escapeHtml, truncate } from "./string";
export { formatTime, getTimestamp } from "./time";
export { type DiffLine, parseUnifiedDiff, generateDiffLines } from "./diffUtils";

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
    return truncate(parameters.command as string, 80);
  }

  if (lowerName === "write" || lowerName === "edit" || lowerName === "read") {
    return shortenPath(parameters.file_path as string);
  }

  if (lowerName === "multiedit") {
    const fileCount = Array.isArray(parameters.files) ? parameters.files.length : 1;
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
