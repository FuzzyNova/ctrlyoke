export interface LineRangeReference {
  startLine?: number;
  endLine?: number;
}

/** Whether a parsed reference contains both bounds of a line range. */
export function hasLineRange(
  reference: LineRangeReference
): reference is { startLine: number; endLine: number } {
  return reference.startLine !== undefined && reference.endLine !== undefined;
}

/** The shared 1-based, inclusive line-range rule used by lint and expansion. */
export function isValidLineRange(
  startLine: number,
  endLine: number,
  lineCount: number
): boolean {
  return (
    Number.isInteger(startLine) &&
    Number.isInteger(endLine) &&
    Number.isInteger(lineCount) &&
    startLine >= 1 &&
    endLine >= startLine &&
    endLine <= lineCount
  );
}
