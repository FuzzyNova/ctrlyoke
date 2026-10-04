import type { RowFindDecoration } from "../../../utils/outputFind";

/** Height-estimate text wrapping used by webview-only tool views. */
export function wrappedTextLines(
  text: string,
  width: number,
  fontSize: number,
  minimumCharsPerLine: number
): number {
  const charsPerLine = Math.max(
    minimumCharsPerLine,
    Math.floor(width / (fontSize * 0.58))
  );
  return text
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0
    );
}

/** Find-match slicing is a webview rendering affordance. */
export function sliceFindMatches(
  matches: RowFindDecoration["matches"] | undefined,
  start: number,
  length: number
): RowFindDecoration["matches"] {
  const end = start + length;
  return (matches ?? [])
    .filter((match) => match.start < end && match.end > start)
    .map((match) => ({
      ...match,
      start: Math.max(0, match.start - start),
      end: Math.min(length, match.end - start),
    }));
}
