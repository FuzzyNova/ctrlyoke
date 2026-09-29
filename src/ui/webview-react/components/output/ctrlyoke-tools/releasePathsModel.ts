export interface ReleasePathsParams {
  paths?: string[];
}

export interface ReleasePathsResult {
  released: string[];
  notHeld: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const parsed: unknown = JSON.parse(text);
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

export function estimateReleasePathsHeight(
  _params: ReleasePathsParams | undefined,
  result: ReleasePathsResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const charsPerLine = Math.max(
    24,
    Math.floor((width ?? 640) / (fontSize * 0.58))
  );
  const lines = releasePathsSearchText(undefined, result).reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)),
    0
  );
  return 34 + lines * fontSize * 1.55 + rawHeight;
}
