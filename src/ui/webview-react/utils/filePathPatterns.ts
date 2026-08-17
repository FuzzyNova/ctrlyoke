/**
 * Shared low-level building blocks for detecting file-path references inside
 * plain/AI-generated text on Windows. Single source for `MarkdownText.tsx`'s
 * auto-linking of workspace paths in AI prose and `cliCommandFileLinks.ts`'s
 * linkification of file references inside rendered CLI/script command text —
 * both need the same extension allowlist, separator tolerance, and Codex
 * pseudo-absolute-path normalization.
 */

/**
 * Recognized file extensions for auto-linking workspace paths.
 * Conservative list to avoid false positives in prose.
 *
 * `svg` lives here (a link extension) rather than in an inline-thumbnail
 * image list: an SVG can carry script, so it's opened as a file in VS Code
 * rather than rendered inline, but it's still a real workspace file that
 * should be a clickable link.
 */
export const FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|py|sh|css|scss|html|svg|toml|txt|rs|go|swift|java|c|cpp|h|vue|svelte|rb|php|dart|kt|cs";

/**
 * Separators allow 1–2 consecutive slashes/backslashes so that harnesses
 * that escape their output (e.g. writing C:\\dev\\) are also matched.
 */
export const SEP = "[/\\\\]{1,2}"; // matches /  \  //  \\  (1–2 of either)

/**
 * Converts web-safe absolute file-link target forms back to native Windows
 * absolute paths:
 *   /abs/path/c:/dev/repo/file.ts -> C:/dev/repo/file.ts
 *   /c:/dev/repo/file.ts          -> C:/dev/repo/file.ts
 */
export function normalizeCodexAbsPath(raw: string): string {
  const pathWithDrive = raw.match(/^\/abs\/path\/([A-Za-z]:)(\/.*)$/);
  if (pathWithDrive) {
    return `${pathWithDrive[1].toUpperCase()}${pathWithDrive[2]}`;
  }

  const slashDrivePath = raw.match(/^\/([A-Za-z]:)(\/.*)$/);
  if (slashDrivePath) {
    return `${slashDrivePath[1].toUpperCase()}${slashDrivePath[2]}`;
  }

  return raw;
}
