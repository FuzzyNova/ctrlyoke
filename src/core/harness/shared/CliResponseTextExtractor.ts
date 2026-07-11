import type {
  FileEditData,
  FileWriteData,
  UnifiedDiffHunk,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { createTwoFilesPatch } from "diff";

const ENCRYPTED_REASONING_PLACEHOLDER = "[Encrypted reasoning]";

export interface ResponseTextExtractionOptions {
  includeFullDiffs?: boolean;
}

function formatStructuredPatch(
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

function formatEditDiff(editData: FileEditData): string | undefined {
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

function formatCreatedFileDiff(writeData: FileWriteData): string {
  return createTwoFilesPatch(
    "/dev/null",
    `b/${writeData.path}`,
    "",
    writeData.content,
    "",
    ""
  ).trimEnd();
}

function wrapDiff(label: string, diff: string): string {
  return `\n[${label}]\n\`\`\`diff\n${diff}\n\`\`\``;
}

export function extractTextFromEvents(
  output: Pick<UniversalCliOutput, "events">,
  options: ResponseTextExtractionOptions = {}
): string {
  const includeFullDiffs =
    options.includeFullDiffs ??
    ConfigurationUtils.shouldIncludeFullDiffsInPriorContext();
  const textParts: string[] = [];
  for (const event of output.events) {
    if (!event.data) {
      continue;
    }
    if (event.type === CLI_EVENT_TYPES.TEXT && "text" in event.data) {
      textParts.push(event.data.text as string);
    } else if (
      event.type === CLI_EVENT_TYPES.THINKING &&
      "text" in event.data
    ) {
      const thinkingText = (event.data as { text: string }).text.trim();
      if (thinkingText && thinkingText !== ENCRYPTED_REASONING_PLACEHOLDER) {
        textParts.push(`\n[Thinking]\n${thinkingText}\n[/Thinking]`);
      }
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_WRITE &&
      "path" in event.data
    ) {
      const writeData = event.data as FileWriteData;
      textParts.push(
        includeFullDiffs
          ? wrapDiff(
              `Created: ${writeData.path}`,
              formatCreatedFileDiff(writeData)
            )
          : `\n[Created: ${writeData.path}]`
      );
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_EDIT &&
      "path" in event.data
    ) {
      const editData = event.data as FileEditData;
      const fullDiff = includeFullDiffs ? formatEditDiff(editData) : undefined;
      if (fullDiff) {
        textParts.push(wrapDiff(`Edited: ${editData.path}`, fullDiff));
        continue;
      }
      if (editData.structuredPatch && editData.structuredPatch.length > 0) {
        let added = 0;
        let removed = 0;
        for (const hunk of editData.structuredPatch) {
          for (const line of hunk.lines) {
            if (line.startsWith("+")) {
              added++;
            } else if (line.startsWith("-")) {
              removed++;
            }
          }
        }
        textParts.push(`\n[Edited: ${editData.path} (+${added}, -${removed})]`);
      } else {
        textParts.push(`\n[Edited: ${editData.path}]`);
      }
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_DELETE &&
      "path" in event.data
    ) {
      textParts.push(`\n[Deleted: ${(event.data as { path: string }).path}]`);
    }
  }
  return textParts.join("");
}
