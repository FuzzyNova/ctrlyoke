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
