import { CLI_EVENT_TYPES } from "../types/DashboardConstants";
import type { CliEvent } from "../types/CliOutputTypes";

/**
 * Applies the history-search text projection to the large string fields in a
 * structured CLI event. Keep this list shared by search indexing and the
 * addressed run-view output projection.
 */
export function truncateCliEventTextFields(
  event: CliEvent,
  maxTextLength: number,
  onStringTruncated?: () => void
): void {
  switch (event.type) {
    case CLI_EVENT_TYPES.TEXT:
    case CLI_EVENT_TYPES.THINKING:
      truncateStringProperty(event.data, "text", maxTextLength, onStringTruncated);
      break;
    case CLI_EVENT_TYPES.BASH_COMMAND:
      truncateStringProperty(event.data, "command", maxTextLength, onStringTruncated);
      truncateStringProperty(event.data, "output", maxTextLength, onStringTruncated);
      truncateStringProperty(event.data, "error", maxTextLength, onStringTruncated);
      break;
    case CLI_EVENT_TYPES.FILE_WRITE:
      truncateStringProperty(event.data, "content", maxTextLength, onStringTruncated);
      break;
    case CLI_EVENT_TYPES.FILE_EDIT:
      truncateStructuredPatch(event.data, maxTextLength, onStringTruncated);
      break;
    case CLI_EVENT_TYPES.MCP_TOOL_CALL:
    case CLI_EVENT_TYPES.TOOL_CALL:
      truncateStringProperty(event.data, "server", maxTextLength, onStringTruncated);
      truncateStringProperty(event.data, "tool", maxTextLength, onStringTruncated);
      truncateStringProperty(event.data, "name", maxTextLength, onStringTruncated);
      truncateJsonProperty(event.data, "parameters", maxTextLength, onStringTruncated);
      break;
    case CLI_EVENT_TYPES.TOOL_RESULT: {
      const result = (event.data as { result?: Record<string, unknown> }).result;
      if (result) {
        truncateStringProperty(result, "output", maxTextLength, onStringTruncated);
        truncateStringProperty(result, "error", maxTextLength, onStringTruncated);
      }
      break;
    }
    case CLI_EVENT_TYPES.WEB_SEARCH: {
      truncateStringProperty(event.data, "query", maxTextLength, onStringTruncated);
      const results = (event.data as { results?: unknown }).results;
      if (Array.isArray(results)) {
        for (const result of results) {
          if (result && typeof result === "object") {
            truncateStringProperty(result, "title", maxTextLength, onStringTruncated);
            truncateStringProperty(result, "snippet", maxTextLength, onStringTruncated);
            truncateStringProperty(result, "url", maxTextLength, onStringTruncated);
          }
        }
      }
      break;
    }
    case CLI_EVENT_TYPES.COMPACTION:
      truncateStringProperty(event.data, "summary", maxTextLength, onStringTruncated);
      break;
    default:
      break;
  }
}

function truncateStructuredPatch(
  data: unknown,
  maxTextLength: number,
  onStringTruncated?: () => void
): void {
  if (!data || typeof data !== "object") return;
  const structuredPatch = (data as { structuredPatch?: unknown }).structuredPatch;
  if (!Array.isArray(structuredPatch)) return;
  const lines = structuredPatch.flatMap((hunk) => {
    if (!hunk || typeof hunk !== "object") return [];
    const hunkLines = (hunk as { lines?: unknown }).lines;
    return Array.isArray(hunkLines)
      ? hunkLines.filter((line): line is string => typeof line === "string")
      : [];
  });
  const flattened = lines.join("\n");
  if (flattened.length <= maxTextLength) return;
  onStringTruncated?.();
  (data as { structuredPatch: Array<{ lines: string[] }> }).structuredPatch = [
    { lines: [flattened.slice(0, maxTextLength)] },
  ];
}

function truncateStringProperty(
  value: unknown,
  property: string,
  maxTextLength: number,
  onStringTruncated?: () => void
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record[property] === "string" && record[property].length > maxTextLength) {
    onStringTruncated?.();
    record[property] = record[property].slice(0, maxTextLength);
  }
}

function truncateJsonProperty(
  value: unknown,
  property: string,
  maxTextLength: number,
  onStringTruncated?: () => void
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const propertyValue = record[property];
  if (typeof propertyValue === "string") {
    truncateStringProperty(record, property, maxTextLength, onStringTruncated);
    return;
  }
  if (propertyValue === undefined) return;
  try {
    const serialized = JSON.stringify(propertyValue);
    if (typeof serialized === "string" && serialized.length > maxTextLength) {
      onStringTruncated?.();
      record[property] = serialized.slice(0, maxTextLength);
    }
  } catch {
    // Indexing treats unserializable tool parameters as best effort.
  }
}
