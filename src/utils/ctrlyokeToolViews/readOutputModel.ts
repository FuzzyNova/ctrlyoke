import {
  isRecord,
  toolViewPromptPreview,
  tryParseJson,
  type ToolTerminalLine,
} from "./shared";
import { STEP_TYPES } from "../../types/DashboardConstants";
export interface ReadOutputParams {
  indices?: number[];
  cursor?: string;
  limit?: number;
  tail?: number;
}
export interface ReadOutputItem {
  index: number;
  type?: (typeof STEP_TYPES)[keyof typeof STEP_TYPES];
  prompt?: string;
  script?: string;
  status: string;
  responseText: string | null;
  nextCursor?: string;
}
export interface ReadOutputResult {
  workflowKey: string;
  runRef: string;
  outputs: ReadOutputItem[];
}
export function parseReadOutputParams(
  raw: unknown
): ReadOutputParams | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    raw.indices !== undefined &&
    (!Array.isArray(raw.indices) || !raw.indices.every(Number.isInteger))
  )
    return undefined;
  if (raw.cursor !== undefined && typeof raw.cursor !== "string")
    return undefined;
  if (raw.limit !== undefined && typeof raw.limit !== "number")
    return undefined;
  if (raw.tail !== undefined && typeof raw.tail !== "number") return undefined;
  return {
    ...(Array.isArray(raw.indices) ? { indices: raw.indices as number[] } : {}),
    ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
    ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
    ...(typeof raw.tail === "number" ? { tail: raw.tail } : {}),
  };
}

export function parseReadOutputResultText(
  text: string
): ReadOutputResult | undefined {
  try {
    const value: unknown = tryParseJson(text);
    if (
      !isRecord(value) ||
      typeof value.workflowKey !== "string" ||
      typeof value.runRef !== "string" ||
      !Array.isArray(value.outputs)
    )
      return undefined;
    if (
      !value.outputs.every(
        (o) =>
          isRecord(o) &&
          Number.isInteger(o.index) &&
          (o.type === undefined ||
            o.type === STEP_TYPES.PROMPT ||
            o.type === STEP_TYPES.SCRIPT) &&
          (o.type === STEP_TYPES.SCRIPT
            ? typeof o.script === "string"
            : typeof o.prompt === "string") &&
          typeof o.status === "string" &&
          (typeof o.responseText === "string" || o.responseText === null) &&
          (o.nextCursor === undefined || typeof o.nextCursor === "string")
      )
    )
      return undefined;
    return value as unknown as ReadOutputResult;
  } catch {
    return undefined;
  }
}

function formatIndex(i: number): string {
  return `#${i + 1}`;
}
export function readOutputSummary(
  params: ReadOutputParams | undefined,
  result: ReadOutputResult
): string {
  const indices = params?.indices?.length
    ? params.indices
    : result.outputs.map(({ index }) => index);
  return `Read output of steps ${indices.map(formatIndex).join(", ") || "none"}`;
}
export function readOutputSearchText(
  params: ReadOutputParams | undefined,
  result: ReadOutputResult
): string[] {
  return [
    readOutputSummary(params, result),
    result.outputs
      .map((output) => readOutputItemSearchText(output, params))
      .join("\n"),
  ];
}

export function readOutputHeading(output: ReadOutputItem): string {
  return `${formatIndex(output.index)} · ${toolViewPromptPreview(readOutputItemText(output))} · ${output.status}`;
}

export function readOutputItemText(output: ReadOutputItem): string {
  return output.type === STEP_TYPES.SCRIPT
    ? (output.script ?? "")
    : (output.prompt ?? "");
}

export function readOutputItemSearchText(
  output: ReadOutputItem,
  params: ReadOutputParams | undefined
): string {
  const footer = [
    params?.cursor ? `Cursor ${params.cursor}` : "",
    params?.tail !== undefined ? `Tail ${params.tail}` : "",
    output.nextCursor ? `Next cursor ${output.nextCursor}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `${readOutputHeading(output)}${output.responseText ? `\n${output.responseText}` : ""}${footer ? `\n${footer}` : ""}`;
}

export function readOutputTerminalLines(
  _params: ReadOutputParams | undefined,
  result: ReadOutputResult
): ToolTerminalLine[] {
  return result.outputs.flatMap((output) => [
    { text: readOutputHeading(output) },
    ...(output.responseText ? [{ text: output.responseText }] : []),
    ...(output.nextCursor
      ? [{ text: `Next cursor ${output.nextCursor}` }]
      : []),
  ]);
}
