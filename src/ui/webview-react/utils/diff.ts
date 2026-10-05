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
