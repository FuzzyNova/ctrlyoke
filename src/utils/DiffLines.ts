import * as Diff from "diff";
import type { UnifiedDiffHunk } from "../types/CliOutputTypes";
import {
  DIFF_LINE_TYPES,
  type DiffLineType,
} from "../types/DashboardConstants";

/** A single line in a rendered diff. */
export interface DiffLine {
  type: DiffLineType;
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

/** Whether a unified-diff line is content rather than patch metadata. */
export function isDisplayableDiffLine(line: string): boolean {
  return !(
    line === "\\ No newline at end of file" ||
    line.startsWith("@@ ") ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ")
  );
}

export function hasPatchOrderingRegression(hunks: UnifiedDiffHunk[]): boolean {
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

/** Deduplicate exact repeated hunks while preserving their original order. */
export function normalizeStructuredPatch(
  hunks: UnifiedDiffHunk[] | undefined
): UnifiedDiffHunk[] {
  if (!hunks || hunks.length === 0) return [];

  const seen = new Set<string>();
  const normalized: UnifiedDiffHunk[] = [];

  for (const hunk of hunks) {
    if (!hunk || typeof hunk !== "object" || !Array.isArray(hunk.lines)) {
      continue;
    }
    const lines = hunk.lines.filter(
      (line): line is string =>
        typeof line === "string" && /^[ +\\-]/.test(line)
    );
    if (lines.length === 0) continue;

    const oldLines = lines.reduce(
      (count, line) => count + (line[0] === " " || line[0] === "-" ? 1 : 0),
      0
    );
    const newLines = lines.reduce(
      (count, line) => count + (line[0] === " " || line[0] === "+" ? 1 : 0),
      0
    );
    const normalizedHunk = { ...hunk, oldLines, newLines, lines };
    const signature = getStructuredPatchSignature(normalizedHunk);
    if (seen.has(signature)) continue;
    seen.add(signature);
    normalized.push(normalizedHunk);
  }

  return normalized;
}

/** Convert a normalized structured patch into its visible diff lines. */
export function getStructuredPatchDiffLines(
  hunks: UnifiedDiffHunk[]
): DiffLine[] {
  const diffLines: DiffLine[] = [];

  for (const hunk of hunks) {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    for (const line of hunk.lines) {
      if (!isDisplayableDiffLine(line)) continue;

      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === "+") {
        diffLines.push({ type: DIFF_LINE_TYPES.ADDED, newLineNum, content });
        newLineNum++;
      } else if (prefix === "-") {
        diffLines.push({ type: DIFF_LINE_TYPES.REMOVED, oldLineNum, content });
        oldLineNum++;
      } else {
        diffLines.push({
          type: DIFF_LINE_TYPES.CONTEXT,
          oldLineNum,
          newLineNum,
          content,
        });
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  return diffLines;
}

/** Generate diff lines from raw content, normalizing Windows line endings. */
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
    if (partLines[partLines.length - 1] === "") partLines.pop();

    partLines.forEach((line) => {
      if (part.added) {
        lines.push({ type: DIFF_LINE_TYPES.ADDED, newLineNum, content: line });
        newLineNum++;
      } else if (part.removed) {
        lines.push({
          type: DIFF_LINE_TYPES.REMOVED,
          oldLineNum,
          content: line,
        });
        oldLineNum++;
      } else {
        lines.push({
          type: DIFF_LINE_TYPES.CONTEXT,
          oldLineNum,
          newLineNum,
          content: line,
        });
        oldLineNum++;
        newLineNum++;
      }
    });
  });

  return lines;
}
