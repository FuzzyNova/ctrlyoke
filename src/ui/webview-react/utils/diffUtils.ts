/**
 * Diff computation utilities.
 *
 * Converts structured patch hunks or raw old/new content into DiffLine arrays
 * for rendering in DiffView. The diff library (js-diff) is only imported here,
 * keeping it out of the main outputUtils bundle.
 */
import * as Diff from "diff";
import type { UnifiedDiffHunk } from "../types/cliEvents";

/**
 * A single line in a rendered diff.
 */
export interface DiffLine {
  type: "added" | "removed" | "context";
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

/**
 * A paired row for side-by-side diff rendering.
 * Each side carries the original flat-array index so HLJS highlighted
 * lines (indexed by that same flat array) can be looked up correctly.
 */
export interface SideBySideRow {
  left: { line: DiffLine; originalIndex: number } | null;
  right: { line: DiffLine; originalIndex: number } | null;
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
        (lineCount, line) =>
          lineCount + (isDisplayableDiffLine(line) ? 1 : 0),
        0
      ),
    0
  );
}

/**
 * Convert a flat DiffLine array into SideBySideRow pairs.
 *
 * Within each changed block (consecutive removed/added lines) the removed
 * lines are zipped with the added lines in order; the shorter side is padded
 * with `null`. Context lines produce a symmetric row (both sides point to the
 * same DiffLine).
 */
export function buildSideBySideRows(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  const pendingRemoved: Array<{ line: DiffLine; originalIndex: number }> = [];
  const pendingAdded: Array<{ line: DiffLine; originalIndex: number }> = [];

  const flush = () => {
    const len = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let i = 0; i < len; i++) {
      rows.push({
        left: pendingRemoved[i] ?? null,
        right: pendingAdded[i] ?? null,
      });
    }
    pendingRemoved.length = 0;
    pendingAdded.length = 0;
  };

  lines.forEach((line, index) => {
    if (line.type === "removed") {
      // If we were collecting added lines before this removed line, close the
      // current change block first (handles uncommon interleaved ordering).
      if (pendingAdded.length > 0) flush();
      pendingRemoved.push({ line, originalIndex: index });
    } else if (line.type === "added") {
      pendingAdded.push({ line, originalIndex: index });
    } else {
      // context — close any open change block then emit symmetric row
      flush();
      rows.push({
        left: { line, originalIndex: index },
        right: { line, originalIndex: index },
      });
    }
  });
  flush();

  return rows;
}

/**
 * Parse unified diff hunks (e.g. from Claude's structured patch) into DiffLine array.
 */
export function parseUnifiedDiff(hunks: UnifiedDiffHunk[]): DiffLine[] {
  const lines: DiffLine[] = [];

  normalizeStructuredPatch(hunks).forEach((hunk) => {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    hunk.lines.forEach((line) => {
      if (!isDisplayableDiffLine(line)) return;

      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === "+") {
        lines.push({ type: "added", newLineNum, content });
        newLineNum++;
      } else if (prefix === "-") {
        lines.push({ type: "removed", oldLineNum, content });
        oldLineNum++;
      } else if (prefix === " ") {
        lines.push({ type: "context", oldLineNum, newLineNum, content });
        oldLineNum++;
        newLineNum++;
      }
    });
  });

  return lines;
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
