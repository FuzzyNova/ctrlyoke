/**
 * Convert a zero-based editor selection endpoint to a 1-based inclusive line.
 * Whole-line selections commonly end at column zero of the following line;
 * that line is outside the selected range.
 */
export function getInclusiveEndLine(
  startLine: number,
  endLine: number,
  endCharacter: number
): number {
  return endCharacter === 0 && endLine > startLine ? endLine : endLine + 1;
}
