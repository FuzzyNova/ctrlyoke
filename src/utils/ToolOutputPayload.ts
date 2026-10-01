import type { CliEvent } from "../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OUTPUT_HISTORY_KINDS,
} from "../types/DashboardConstants";
import type { WorkflowOutputHistory } from "../types/OutputHistoryTypes";

/**
 * Bound each output field to 8 KiB in run-view payloads. Larger collapsed
 * previews can show the available head and retain the existing expand control.
 */
export const RUN_VIEW_TOOL_OUTPUT_HEAD_BYTES = 8_192;
export interface CappedToolOutputText {
  text: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
}

function countOutputLines(value: string): number {
  const bodyEnd = value.endsWith("\n") ? value.length - 1 : value.length;
  if (bodyEnd === 0) return 0;
  let lineCount = 1;
  for (let index = 0; index < bodyEnd; index++) {
    if (value[index] === "\n") lineCount++;
  }
  return lineCount;
}

function getUtf8ByteLength(value: string): number {
  let byteLength = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    byteLength +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return byteLength;
}

export function capToolOutputText(
  value: string | undefined,
  maxBytes = RUN_VIEW_TOOL_OUTPUT_HEAD_BYTES
): CappedToolOutputText | undefined {
  if (typeof value !== "string") return undefined;
  const totalBytes = getUtf8ByteLength(value);
  if (totalBytes <= maxBytes) {
    return {
      text: value,
      truncated: false,
      totalBytes,
      totalLines: countOutputLines(value),
    };
  }

  let headEnd = 0;
  let headBytes = 0;
  while (headEnd < value.length) {
    const codePoint = value.codePointAt(headEnd)!;
    const codePointLength = codePoint > 0xffff ? 2 : 1;
    const codePointBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (headBytes + codePointBytes > maxBytes) break;
    headEnd += codePointLength;
    headBytes += codePointBytes;
  }
  return {
    text: value.slice(0, headEnd),
    truncated: true,
    totalBytes,
    totalLines: countOutputLines(value),
  };
}

/** Caps the large output fields carried by one normalized structured event. */
export function capToolOutputEvent(event: CliEvent): CliEvent {
  let output: string | undefined;
  let error: string | undefined;
  let outputTotalBytes = 0;
  let outputTotalLines = 0;
  if (event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
    const data = event.data as { output?: string; error?: string };
    output = data.output;
    error = data.error;
  } else if (event.type === CLI_EVENT_TYPES.TOOL_RESULT) {
    const result = (
      event.data as { result?: { output?: string; error?: string } }
    ).result;
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
  outputTotalLines =
    (cappedOutput?.totalLines ?? 0) + (cappedError?.totalLines ?? 0);
  const copy = structuredClone(event);
  if (copy.type === CLI_EVENT_TYPES.BASH_COMMAND) {
    const data = copy.data as {
      output?: string;
      error?: string;
      outputTruncated?: boolean;
      outputTotalBytes?: number;
      outputTotalLines?: number;
      outputLines?: number;
      errorLines?: number;
    };
    if (cappedOutput) data.output = cappedOutput.text;
    if (cappedError) data.error = cappedError.text;
    data.outputTruncated = true;
    data.outputTotalBytes = outputTotalBytes;
    data.outputTotalLines = outputTotalLines;
    data.outputLines = cappedOutput?.totalLines;
    data.errorLines = cappedError?.totalLines;
  } else if (copy.type === CLI_EVENT_TYPES.TOOL_RESULT) {
    const result = (
      copy.data as {
        result?: {
          output?: string;
          error?: string;
          outputTruncated?: boolean;
          outputTotalBytes?: number;
          outputTotalLines?: number;
          outputLines?: number;
          errorLines?: number;
        };
      }
    ).result;
    if (result) {
      if (cappedOutput) result.output = cappedOutput.text;
      if (cappedError) result.error = cappedError.text;
      result.outputTruncated = true;
      result.outputTotalBytes = outputTotalBytes;
      result.outputTotalLines = outputTotalLines;
      result.outputLines = cappedOutput?.totalLines;
      result.errorLines = cappedError?.totalLines;
    }
  }
  copy.outputTruncated = true;
  copy.outputTotalBytes = outputTotalBytes;
  copy.outputTotalLines = outputTotalLines;
  return copy;
}

/** Run-view projection helper; history and live buffer replay remain complete. */
export function capToolOutputHistory(
  history: WorkflowOutputHistory
): WorkflowOutputHistory {
  return {
    ...history,
    orderedEntries: history.orderedEntries.map((entry) => {
      if (
        entry.kind !== OUTPUT_HISTORY_KINDS.CLI ||
        !entry.cliOutput.structured?.events
      ) {
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
