import type { UnifiedDiffHunk } from "../types/cliEvents";
import {
  hasPatchOrderingRegression,
  isDisplayableDiffLine,
  normalizeStructuredPatch,
} from "@root/utils/DiffLines";

export interface RenderableDiffSource {
  oldContent?: string;
  newContent?: string;
  structuredPatch?: UnifiedDiffHunk[];
}

export function hasRenderableDiff(s: RenderableDiffSource): boolean {
  if (s.structuredPatch && s.structuredPatch.length > 0) return true;
  return s.oldContent !== undefined && s.newContent !== undefined;
}

/**
 * Detect patch sequences that are unlikely to belong to a single file diff.
 */
export function isStructuredPatchMalformed(
  hunks: UnifiedDiffHunk[] | undefined
): boolean {
  if (!hunks || hunks.length === 0) return false;

  const normalized = normalizeStructuredPatch(hunks);
  return (
    normalized.length !== hunks.length || hasPatchOrderingRegression(normalized)
  );
}

export function countStructuredPatchDisplayLines(
  hunks: UnifiedDiffHunk[] | undefined
): number {
  return normalizeStructuredPatch(hunks).reduce(
    (count, hunk) =>
      count +
      hunk.lines.reduce(
        (lineCount, line) => lineCount + (isDisplayableDiffLine(line) ? 1 : 0),
        0
      ),
    0
  );
}
