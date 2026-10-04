import { isRecord, tryParseJson, type ToolTerminalLine } from "./shared";
export interface ReleasePathsParams {
  paths?: string[];
}

export interface ReleasePathsResult {
  released: string[];
  notHeld: string[];
}

function parsePaths(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((path) => typeof path === "string")
    ? value
    : undefined;
}

export function parseReleasePathsParams(
  raw: unknown
): ReleasePathsParams | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.paths === undefined) return {};
  const paths = parsePaths(raw.paths);
  return paths ? { paths } : undefined;
}

export function parseReleasePathsResultText(
  text: string
): ReleasePathsResult | undefined {
  try {
    const parsed: unknown = tryParseJson(text);
    if (!isRecord(parsed)) return undefined;
    const released = parsePaths(parsed.released);
    const notHeld =
      parsed.notHeld === undefined ? [] : parsePaths(parsed.notHeld);
    return released && notHeld ? { released, notHeld } : undefined;
  } catch {
    return undefined;
  }
}

export function releasePathsSummary(
  _params: ReleasePathsParams | undefined,
  result: ReleasePathsResult
): string {
  return `Released ${result.released.length} ${result.released.length === 1 ? "path" : "paths"}`;
}

export function releasePathsSearchText(
  params: ReleasePathsParams | undefined,
  result: ReleasePathsResult
): string[] {
  return [
    releasePathsSummary(params, result),
    [
      ...result.released,
      ...(result.notHeld.length
        ? [`Not held: ${result.notHeld.join(", ")}`]
        : []),
    ].join("\n"),
  ];
}

export function releasePathsTerminalLines(
  _params: ReleasePathsParams | undefined,
  result: ReleasePathsResult
): ToolTerminalLine[] {
  return [
    ...result.released.map((text) => ({ text })),
    ...(result.notHeld.length
      ? [{ text: `Not held: ${result.notHeld.join(", ")}` }]
      : []),
  ];
}
