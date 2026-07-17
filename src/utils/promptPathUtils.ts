/**
 * Prompt path utilities — pure functions shared between the extension backend
 * (PromptFileParser) and the React webview.
 *
 * Must remain free of `fs`, `vscode`, or any Node.js-specific APIs so it can
 * run in both environments without side effects.
 */

/**
 * Extensions that indicate a prompt value might be a file path.
 * We try to resolve these as files first, falling back to literal text if not found.
 */
export const PROMPT_FILE_EXTENSIONS = [".prompt.md", ".md", ".txt"] as const;

/**
 * Returns true when `promptValue` looks like a lone file-path reference rather
 * than inline prompt text.
 *
 * Rules:
 * - Must be the *only* thing in the string (no surrounding text)
 * - Must start with `./`, `../`, `/`, or a Windows drive letter (e.g. `C:\`)
 * - In a multi-root workspace, may instead use a folder-qualified path such
 *   as `root2/prompts/current.prompt.md`
 * - Must NOT start with `@` or `#` (those are ctrlyoke inline references like
 *   @file.ts or #selection:)
 * - Must end with a known extension (.prompt.md, .md, .txt) OR any extension-like suffix
 */
export function looksLikeFilePath(
  promptValue: string,
  options?: { allowWorkspaceFolderPrefix?: boolean }
): boolean {
  const trimmed = promptValue.trim();

  // Skip if it starts with @ or # — those are ctrlyoke references (context
  // reference / inline selection), not a standalone prompt file path. The
  // folder-qualified multi-root form below only differs from an @-reference
  // by this leading character, so it must be excluded explicitly.
  if (trimmed.startsWith("#") || trimmed.startsWith("@")) {
    return false;
  }

  // A prompt file reference must be ONLY a path — no other text before or after.
  // Check if it starts with a valid path indicator.
  const startsWithRelative =
    trimmed.startsWith("./") || trimmed.startsWith("../");
  const startsWithWorkspaceFolderPrefix =
    options?.allowWorkspaceFolderPrefix === true &&
    /^[^/\\\s]+[/\\]/.test(trimmed);
  const startsWithDriveLetter = /^[a-zA-Z]:[/\\]/.test(trimmed);
  const startsWithUnixAbsolute = trimmed.startsWith("/");

  if (
    !startsWithRelative &&
    !startsWithWorkspaceFolderPrefix &&
    !startsWithDriveLetter &&
    !startsWithUnixAbsolute
  ) {
    return false;
  }

  // Check for known file extensions at the END of the string
  const hasKnownExtension = PROMPT_FILE_EXTENSIONS.some((ext) =>
    trimmed.toLowerCase().endsWith(ext)
  );
  if (hasKnownExtension) {
    return true;
  }

  // For other extensions, require ending with an extension pattern
  return /\.\w+$/.test(trimmed);
}
