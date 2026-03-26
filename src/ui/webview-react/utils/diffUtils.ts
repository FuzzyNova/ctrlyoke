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
