/**
 * Renders an executable + argv array as copy-pasteable text for a specific
 * shell dialect. Used by the Dry Run command preview (backend default
 * rendering and the webview's shell toggle) and by nothing else — this is
 * display-only quoting for a human to paste into a terminal, not the
 * verbatim-payload correctness logic in
 * `src/core/harness/shared/WindowsCmdEscaping.ts` (which exists to survive a
 * mandatory cmd.exe re-parse when launching `.cmd`/`.bat` shims). Kept
 * dependency-free so it can be imported from both the extension host and the
 * webview bundle.
 */

export const COMMAND_DISPLAY_SHELLS = {
  CMD: "cmd",
  POWERSHELL: "powershell",
  POSIX: "posix",
} as const;

export type CommandDisplayShell =
  (typeof COMMAND_DISPLAY_SHELLS)[keyof typeof COMMAND_DISPLAY_SHELLS];

export const COMMAND_DISPLAY_SHELL_LABELS: Record<CommandDisplayShell, string> =
  {
    [COMMAND_DISPLAY_SHELLS.CMD]: "Command Prompt",
    [COMMAND_DISPLAY_SHELLS.POWERSHELL]: "PowerShell",
    [COMMAND_DISPLAY_SHELLS.POSIX]: "POSIX shell",
  };

const CMD_META_CHARS_REGEXP = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdMetaChars(value: string): string {
  return value.replace(CMD_META_CHARS_REGEXP, "^$1");
}

/**
 * The two-layer cmd.exe argument-escaping algorithm from
 * https://qntm.org/cmd, ported from cross-spawn's `lib/util/escape.js`
 * (MIT). See `WindowsCmdEscaping.ts` for why a single quoting pass is not
 * enough once cmd.exe is in the process tree.
 */
export function escapeCmdArgument(
  value: string,
  doubleEscapeMetaChars: boolean
): string {
  let arg = `${value}`;

  // Sequence of backslashes followed by a double quote: double up all the
  // backslashes and escape the double quote.
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Sequence of backslashes at the end of the string (which will become a
  // double quote next): double up all the backslashes.
  arg = arg.replace(/(\\*)$/, "$1$1");
  // Quote the whole thing.
  arg = `"${arg}"`;
  // Escape cmd.exe metacharacters.
  arg = arg.replace(CMD_META_CHARS_REGEXP, "^$1");
  if (doubleEscapeMetaChars) {
    arg = arg.replace(CMD_META_CHARS_REGEXP, "^$1");
  }

  return arg;
}

/** PowerShell single-quoted strings are fully literal — no expansion, no
 * escape sequences — except a doubled `'` for an embedded quote. */
export function escapePowerShellArgument(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "''")}'`;
}

/** POSIX single-quoted strings are fully literal; an embedded `'` closes the
 * quote, so it is spliced out and re-opened via `'"'"'`. */
export function escapePosixArgument(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Render `[executable, ...args]` as one paste-able command line for `shell`.
 *
 * `requiresShellVerbatimArgs` covers the rare case where `args` is already a
 * fully cmd.exe-escaped payload (the `.cmd`/`.bat` launcher fallback — see
 * `CliLauncherResolver`'s `cmd-file` kind): escaping it a second time would
 * mangle it, so it is joined as-is regardless of the requested shell.
 */
export function renderCommandForDisplay(
  executable: string,
  args: readonly string[],
  shell: CommandDisplayShell,
  options?: { requiresShellVerbatimArgs?: boolean }
): string {
  if (options?.requiresShellVerbatimArgs) {
    return [executable, ...args].join(" ");
  }
  const escape =
    shell === COMMAND_DISPLAY_SHELLS.CMD
      ? (value: string) => escapeCmdArgument(value, false)
      : shell === COMMAND_DISPLAY_SHELLS.POWERSHELL
        ? escapePowerShellArgument
        : escapePosixArgument;
  return [executable, ...args].map(escape).join(" ");
}
