import { createTwoFilesPatch } from "diff";
import type {
  FileEditData,
  FileWriteData,
  UnifiedDiffHunk,
} from "../types/CliOutputTypes";

export function formatStructuredPatch(
  filePath: string,
  hunks: UnifiedDiffHunk[]
): string {
  const body = hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`
    )
    .join("\n");
  return `--- a/${filePath}\n+++ b/${filePath}\n${body}`;
}

export function formatEditDiff(editData: FileEditData): string | undefined {
  if (editData.structuredPatch?.length) {
    return formatStructuredPatch(editData.path, editData.structuredPatch);
  }
  if (editData.oldContent !== undefined && editData.newContent !== undefined) {
    return createTwoFilesPatch(
      `a/${editData.path}`,
      `b/${editData.path}`,
      editData.oldContent,
      editData.newContent,
      "",
      ""
    ).trimEnd();
  }
  return undefined;
}

export function formatCreatedFileDiff(writeData: FileWriteData): string {
  return createTwoFilesPatch(
    "/dev/null",
    `b/${writeData.path}`,
    "",
    writeData.content,
    "",
    ""
  ).trimEnd();
}

export function countStructuredPatchChanges(
  hunks: readonly UnifiedDiffHunk[]
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        added++;
      } else if (line.startsWith("-")) {
        removed++;
      }
    }
  }
  return { added, removed };
}

/**
 * Counts added and removed lines in a single-file unified diff. Only lines
 * after the first `@@` hunk header count, so the `---`/`+++` file headers are
 * skipped while a removed `-- comment` or an added `++i` line is not.
 */
export function countUnifiedDiffChanges(diff: string): {
  added: number;
  removed: number;
} {
  const lines = diff.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk < 0) return { added: 0, removed: 0 };
  return countStructuredPatchChanges([
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 0,
      newLines: 0,
      lines: lines.slice(firstHunk).filter((line) => !line.startsWith("@@")),
    },
  ]);
}
