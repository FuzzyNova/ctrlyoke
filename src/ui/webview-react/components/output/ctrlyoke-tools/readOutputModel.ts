export interface ReadOutputParams {
  indices?: number[];
  cursor?: string;
  limit?: number;
  tail?: number;
}
export interface ReadOutputItem {
  index: number;
  prompt: string;
  status: string;
  responseText: string | null;
  nextCursor?: string;
}
export interface ReadOutputResult {
  workflowKey: string;
  runRef: string;
  outputs: ReadOutputItem[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const value: unknown = JSON.parse(text);
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
          typeof o.prompt === "string" &&
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
  return `${formatIndex(output.index)} · ${output.prompt.split(/\r?\n/, 1)[0]} · ${output.status}${output.responseText ? `\n${output.responseText}` : ""}${footer ? `\n${footer}` : ""}`;
}
function wrapped(text: string, width: number, fontSize: number): number {
  const chars = Math.max(20, Math.floor(width / (fontSize * 0.58)));
  return text
    .split("\n")
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / chars)),
      0
    );
}
export function estimateReadOutputHeight(
  _params: ReadOutputParams | undefined,
  result: ReadOutputResult,
  width: number | undefined,
  fontSize: number,
  expanded: Readonly<Record<string, boolean>> = {},
  rawHeight = 0
): number {
  const available = Math.max(160, width ?? 640);
  const body = result.outputs.reduce(
    (sum, output) =>
      sum +
      wrapped(
        `${formatIndex(output.index)} · ${output.prompt.split(/\r?\n/, 1)[0]} · ${output.status}`,
        available,
        fontSize
      ) *
        fontSize *
        1.45 +
      (expanded[String(output.index)] && output.responseText
        ? wrapped(output.responseText, available, fontSize) * fontSize * 1.45
        : 24),
    0
  );
  return (
    38 +
    body +
    (result.outputs.some((o) => !!o.nextCursor) ? fontSize * 1.5 : 0) +
    rawHeight
  );
}
