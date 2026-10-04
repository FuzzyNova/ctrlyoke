import type { FileReadData } from "../types/CliOutputTypes";
import { buildSelectionReferenceText } from "../completions/ContextReferenceBuilder";

/** Canonical label for a file read, including a requested line range. */
export function getFileReadHeaderText(data: FileReadData): string {
  return data.lineStart !== undefined && data.lineEnd !== undefined
    ? buildSelectionReferenceText(data.path, data.lineStart, data.lineEnd)
    : data.path;
}
