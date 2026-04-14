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

  hunks.forEach((hunk) => {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    hunk.lines.forEach((line) => {
      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === "+") {
        lines.push({ type: "added", newLineNum, content });
        newLineNum++;
      } else if (prefix === "-") {
        lines.push({ type: "removed", oldLineNum, content });
        oldLineNum++;
      } else {
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
