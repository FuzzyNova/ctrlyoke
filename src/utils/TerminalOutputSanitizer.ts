const ANSI_ESCAPE_SEQUENCE_PATTERN =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1B\\)|[@-Z\\-_])/g;
const NON_PRINTABLE_CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Remove ANSI escape sequences from terminal output.
 */
export function stripAnsiCodes(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  return text.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "");
}

/**
 * Normalize terminal output for logs and UI rendering.
 * Keeps line feeds and tabs, but removes ANSI/control bytes that render as
 * unreadable glyphs in the dashboard.
 */
export function sanitizeTerminalOutput(text: string): string {
  return stripAnsiCodes(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(NON_PRINTABLE_CONTROL_PATTERN, "");
}
