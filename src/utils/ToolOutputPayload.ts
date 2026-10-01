import type { CliEvent } from "../types/CliOutputTypes";
import { CLI_EVENT_TYPES, OUTPUT_HISTORY_KINDS } from "../types/DashboardConstants";
import type { WorkflowOutputHistory } from "../types/OutputHistoryTypes";

/**
 * Keep enough leading text to preserve the output pane's 100,000 character
 * collapsed-preview ceiling even when every character is four UTF-8 bytes.
 */
export const RUN_VIEW_TOOL_OUTPUT_HEAD_BYTES = 400_000;
const utf8Encoder = new TextEncoder();

export interface CappedToolOutputText {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

export function capToolOutputText(
  value: string | undefined,
  maxBytes = RUN_VIEW_TOOL_OUTPUT_HEAD_BYTES
): CappedToolOutputText | undefined {
  if (value === undefined) return undefined;
  const totalBytes = utf8Encoder.encode(value).byteLength;
  if (totalBytes <= maxBytes) {
    return { text: value, truncated: false, totalBytes };
  }

  let headEnd = 0;
  let headBytes = 0;
  while (headEnd < value.length) {
    const codePoint = value.codePointAt(headEnd)!;
    const codePointLength = codePoint > 0xffff ? 2 : 1;
    const codePointBytes =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (headBytes + codePointBytes > maxBytes) break;
    headEnd += codePointLength;
    headBytes += codePointBytes;
  }
  return { text: value.slice(0, headEnd), truncated: true, totalBytes };
}

/** Caps the large output fields carried by one normalized structured event. */
export function capToolOutputEvent(event: CliEvent): CliEvent {
  let output: string | undefined;
  let error: string | undefined;
  let outputTotalBytes = 0;
  if (event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
    const data = event.data as { output?: string; error?: string };
    output = data.output;
    error = data.error;
  } else if (event.type === CLI_EVENT_TYPES.TOOL_RESULT) {
    const result = (event.data as { result?: { output?: string; error?: string } }).result;
    output = result?.output;
    error = result?.error;
  } else {
    return event;
  }

  const cappedOutput = capToolOutputText(output);
  const cappedError = capToolOutputText(error);
  const truncated = Boolean(cappedOutput?.truncated || cappedError?.truncated);
  if (!truncated) return event;

  outputTotalBytes =
    (cappedOutput?.totalBytes ?? 0) + (cappedError?.totalBytes ?? 0);
  const copy = structuredClone(event);
  if (copy.type === CLI_EVENT_TYPES.BASH_COMMAND) {
    const data = copy.data as { output?: string; error?: string; outputTruncated?: boolean; outputTotalBytes?: number };
    data.output = cappedOutput?.text;
    data.error = cappedError?.text;
    data.outputTruncated = true;
    data.outputTotalBytes = outputTotalBytes;
  } else if (copy.type === CLI_EVENT_TYPES.TOOL_RESULT) {
    const result = (copy.data as { result?: { output?: string; error?: string; outputTruncated?: boolean; outputTotalBytes?: number } }).result;
    if (result) {
      result.output = cappedOutput?.text;
      result.error = cappedError?.text;
      result.outputTruncated = true;
      result.outputTotalBytes = outputTotalBytes;
    }
  }
  copy.outputTruncated = true;
  copy.outputTotalBytes = outputTotalBytes;
  return copy;
}

/** Run-view projection helper; history and live buffer replay remain complete. */
export function capToolOutputHistory(
  history: WorkflowOutputHistory
): WorkflowOutputHistory {
  return {
    ...history,
    orderedEntries: history.orderedEntries.map((entry) => {
      if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI || !entry.cliOutput.structured?.events) {
        return entry;
      }
      return {
        ...entry,
        cliOutput: {
          ...entry.cliOutput,
          structured: {
            ...entry.cliOutput.structured,
            events: entry.cliOutput.structured.events.map(capToolOutputEvent),
          },
        },
      };
    }),
    activityEntries: history.activityEntries?.map((entry) => ({
      ...entry,
      events: entry.events?.map(capToolOutputEvent),
    })),
  };
}
