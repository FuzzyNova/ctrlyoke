/** Prefix that makes an interactive harness treat prompt input as a shell escape. */
export const HARNESS_SHELL_ESCAPE_PREFIX = "!";

/**
 * Whether a prompt begins with a native harness shell escape after trimming.
 * ctrlyoke steps do not support shell escapes, so these prompts must be passed
 * through a prompt file instead of being typed into the TUI.
 */
export function isHarnessShellEscape(promptText: string): boolean {
  return promptText.trimStart().startsWith(HARNESS_SHELL_ESCAPE_PREFIX);
}
