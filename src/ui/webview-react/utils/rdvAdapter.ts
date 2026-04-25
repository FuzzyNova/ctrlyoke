/**
 * Adapter from FlightPath's internal UnifiedDiffHunk format to react-diff-view's HunkData format.
 *
 * Two entry points:
 *  - toRdvHunks()       — structured patch (e.g. from Claude) → HunkData[]
 *  - toRdvFromContent() — raw old/new file content → { hunks, diffType }
 *
 * Also exports the configured refractor instance for use in DiffView's tokenize call.
 */
import * as DiffLib from "diff";
import { parseDiff } from "react-diff-view";
import type { HunkData, ChangeData, DiffType } from "react-diff-view";
import { refractor } from "refractor";
import { normalizeStructuredPatch } from "./diffUtils";
import type { UnifiedDiffHunk } from "../types/cliEvents";

export { refractor };

function isDisplayableLine(line: string): boolean {
  return !(
    line === "\\ No newline at end of file" ||
    line.startsWith("@@ ") ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ")
  );
}

export function toRdvHunks(hunks: UnifiedDiffHunk[]): HunkData[] {
  const normalized = normalizeStructuredPatch(hunks);
  return normalized.map((hunk): HunkData => {
    const changes: ChangeData[] = [];
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;

    for (const line of hunk.lines) {
      if (!isDisplayableLine(line)) continue;
      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === "+") {
        changes.push({
          type: "insert",
          isInsert: true,
          lineNumber: newLineNumber,
          content,
        });
        newLineNumber++;
      } else if (prefix === "-") {
        changes.push({
          type: "delete",
          isDelete: true,
          lineNumber: oldLineNumber,
          content,
        });
        oldLineNumber++;
      } else if (prefix === " ") {
        changes.push({
          type: "normal",
          isNormal: true,
          oldLineNumber,
          newLineNumber,
          content,
        });
        oldLineNumber++;
        newLineNumber++;
      }
    }

    return {
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      changes,
    };
  });
}

export function toRdvFromContent(
  oldContent: string,
  newContent: string
): { hunks: HunkData[]; diffType: DiffType } {
  const old = oldContent.replace(/\r\n/g, "\n");
  const next = newContent.replace(/\r\n/g, "\n");
  const rawPatch = DiffLib.createPatch("file", old, next);
  // parseDiff requires git-diff-style header; createPatch emits Index:/=== headers instead
  const patchLines = rawPatch.split("\n");
  const gitDiff = ["diff --git a/file b/file", ...patchLines.slice(2)].join(
    "\n"
  );
  const [file] = parseDiff(gitDiff);
  return {
    hunks: (file?.hunks ?? []) as HunkData[],
    diffType: (file?.type as DiffType) ?? "modify",
  };
}

/** Map the language names from getLanguageFromPath() to refractor-registered names. */
export function normalizeLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const overrides: Record<string, string> = { tsx: "typescript", jsx: "javascript" };
  return overrides[lang] ?? lang;
}
