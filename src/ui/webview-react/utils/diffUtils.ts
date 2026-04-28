/**
 * Diff computation utilities.
 *
 * Structured-patch normalisation and line-counting shared by DiffView (via
 * rdvAdapter) and other consumers (OutputSection, markdownExport, CliOutput).
 * Raw old/new → DiffLine generation stays here for OutputSection and markdown export.
 */
import * as Diff from "diff";
import type { UnifiedDiffHunk } from "../types/cliEvents";

/**
 * A single line in a rendered diff — used by OutputSection and markdownExport.
 */
export interface DiffLine {
  type: "added" | "removed" | "context";
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

function getStructuredPatchSignature(hunk: UnifiedDiffHunk): string {
  return [
    hunk.oldStart,
    hunk.oldLines,
    hunk.newStart,
    hunk.newLines,
    hunk.lines.join("\u0000"),
  ].join("|");
}

function isDisplayableDiffLine(line: string): boolean {
  return !(
    line === "\\ No newline at end of file" ||
    line.startsWith("@@ ") ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ")
  );
}

function hasPatchOrderingRegression(hunks: UnifiedDiffHunk[]): boolean {
  let prevOldStart: number | null = null;
  let prevNewStart: number | null = null;

  for (const hunk of hunks) {
    if (
      prevOldStart !== null &&
      prevNewStart !== null &&
      (hunk.oldStart < prevOldStart || hunk.newStart < prevNewStart)
    ) {
      return true;
    }
    prevOldStart = hunk.oldStart;
    prevNewStart = hunk.newStart;
  }

  return false;
}

/**
 * Deduplicate exact repeated hunks while preserving their original order.
 */
export function normalizeStructuredPatch(
  hunks: UnifiedDiffHunk[] | undefined
): UnifiedDiffHunk[] {
  if (!hunks || hunks.length === 0) return [];

  const seen = new Set<string>();
  const normalized: UnifiedDiffHunk[] = [];

  for (const hunk of hunks) {
    if (!Array.isArray(hunk.lines) || hunk.lines.length === 0) continue;
    const signature = getStructuredPatchSignature(hunk);
    if (seen.has(signature)) continue;
    seen.add(signature);
    normalized.push(hunk);
  }

  return normalized;
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

/**
 * Generate diff lines from raw old/new content using the diff library.
 * Normalises Windows line endings before diffing.
 */
export function generateDiffLines(
  oldContent: string,
  newContent: string
): DiffLine[] {
  const diffResult = Diff.diffLines(
    oldContent.replace(/\r\n/g, "\n"),
    newContent.replace(/\r\n/g, "\n")
  );
  const lines: DiffLine[] = [];

  let oldLineNum = 1;
  let newLineNum = 1;

  diffResult.forEach((part) => {
    const partLines = part.value.split("\n");
    if (partLines[partLines.length - 1] === "") {
      partLines.pop();
    }

    partLines.forEach((line) => {
      if (part.added) {
        lines.push({ type: "added", newLineNum, content: line });
        newLineNum++;
      } else if (part.removed) {
        lines.push({ type: "removed", oldLineNum, content: line });
        oldLineNum++;
      } else {
        lines.push({ type: "context", oldLineNum, newLineNum, content: line });
        oldLineNum++;
        newLineNum++;
      }
    });
  });

  return lines;
}
