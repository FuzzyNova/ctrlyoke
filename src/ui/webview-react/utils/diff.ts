import * as Diff from "diff";

/**
 * Generate unified diff between old and new text
 * Wrapper around diff npm package for type safety
 */
export function generateDiff(oldText: string, newText: string): string {
  const patch = Diff.createPatch("file", oldText, newText, "before", "after");
  return patch;
}

/**
 * Apply diff patch to text
 */
export function applyDiff(text: string, patch: string): string {
  const result = Diff.applyPatch(text, patch);
  return typeof result === "string" ? result : text;
}

/**
 * Trigger a browser file download for arbitrary text content.
 * Shared by ContentPreviewModal and the WorkspaceDiffPane download button.
 */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
