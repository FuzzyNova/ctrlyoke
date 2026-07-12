/**
 * Extracts file extensions from glob patterns like "**\/*.md" → "md".
 * Patterns that don't reduce to a plain extension (still contain a `*`
 * after stripping the `**\/*.` prefix) are dropped.
 */
export function extractExtensionsFromGlobs(globs: string[]): string[] {
  return globs
    .map((p) => p.replace(/^\*\*\/\*\./, ""))
    .filter((e) => !e.includes("*"));
}
