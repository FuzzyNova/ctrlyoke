import type {
  FileEditData,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";

export function extractTextFromEvents(output: UniversalCliOutput): string {
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
      textParts.push(
        `\n[Thinking]\n${(event.data as { text: string }).text}\n[/Thinking]`
      );
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_WRITE &&
      "path" in event.data
    ) {
      textParts.push(`\n[Created: ${(event.data as { path: string }).path}]`);
    } else if (
      event.type === CLI_EVENT_TYPES.FILE_EDIT &&
      "path" in event.data
    ) {
      const editData = event.data as FileEditData;
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
