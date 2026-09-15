import {
  SHELL_KINDS,
  SHELL_TYPES,
  UI_PLATFORMS,
  type ShellKind,
  type UiPlatform,
} from "../types/DashboardConstants";

/**
 * Shell *identity* facts: which executable is which shell, where that shell
 * exists, and which script/shell combinations cannot work at all.
 *
 * Deliberately pure — no `vscode`, no `node:child_process`, no settings access
 * — because the dashboard imports it through the webview's `@root/utils` alias
 * to build shell pickers and authoring-time warnings from the same vocabulary
 * execution uses. Shell *invocation* (argv wrapping, verbatim-args quirks,
 * platform auto-detection, PTY spawning) stays in `PtyProcessManager`, which
 * needs the Node runtime this module must not.
 */

/**
 * Extract a human-readable shell name from a full executable path.
 * e.g. "C:\Program Files\PowerShell\7\pwsh.exe" → "pwsh"
 *      "/bin/bash" → "bash"
 */
export function shellDisplayName(shellPath: string): string {
  const base = shellPath.split(/[/\\]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, "");
}

/**
 * Map a shell executable path to a ShellKind discriminant used by the UI
 * to pick the appropriate terminal icon.
 */
export function resolveShellKind(shellPath: string): ShellKind {
  const name = shellDisplayName(shellPath).toLowerCase();
  if (/^pwsh([.-]|$)/.test(name)) return SHELL_KINDS.PWSH;
  if (name.startsWith("powershell")) return SHELL_KINDS.POWERSHELL;
  if (name === SHELL_TYPES.ZSH) return SHELL_KINDS.ZSH;
  if (name === SHELL_TYPES.BASH) return SHELL_KINDS.BASH;
  if (name === SHELL_TYPES.FISH) return SHELL_KINDS.FISH;
  if (name === SHELL_TYPES.CMD) return SHELL_KINDS.CMD;
  if (name === SHELL_TYPES.WSL) return SHELL_KINDS.WSL;
  if (name === SHELL_TYPES.NU || name === SHELL_TYPES.NUSHELL) {
    return SHELL_KINDS.NUSHELL;
  }
  if (
    name === SHELL_TYPES.SH ||
    name === SHELL_TYPES.DASH ||
    name === SHELL_TYPES.KSH
  ) {
    return SHELL_KINDS.SH;
  }
  if (name.endsWith("sh")) return SHELL_KINDS.SH;
  return SHELL_KINDS.BASH;
}

const ALL_UI_PLATFORMS: readonly UiPlatform[] = [
  UI_PLATFORMS.WINDOWS,
  UI_PLATFORMS.MAC,
  UI_PLATFORMS.LINUX,
];

/**
 * Where each shell kind is normally found. This is the "typically installed"
 * answer a picker can give without probing the machine, not a guarantee — an
 * absent shell still fails at spawn time with a plain error, exactly the way an
 * unresolvable `terminal.shellExecutable` does (see
 * `dev/implemented/SCRIPT_STEP_SHELL_OVERRIDE_PLAN.md`).
 *
 * `bash` counts as available on Windows because Git Bash ships with Git for
 * Windows, which every ctrlyoke user already has.
 */
export const SHELL_KIND_PLATFORMS: Record<ShellKind, readonly UiPlatform[]> = {
  [SHELL_KINDS.PWSH]: ALL_UI_PLATFORMS,
  [SHELL_KINDS.POWERSHELL]: [UI_PLATFORMS.WINDOWS],
  [SHELL_KINDS.CMD]: [UI_PLATFORMS.WINDOWS],
  [SHELL_KINDS.WSL]: [UI_PLATFORMS.WINDOWS],
  [SHELL_KINDS.BASH]: ALL_UI_PLATFORMS,
  [SHELL_KINDS.NUSHELL]: ALL_UI_PLATFORMS,
  [SHELL_KINDS.ZSH]: [UI_PLATFORMS.MAC, UI_PLATFORMS.LINUX],
  [SHELL_KINDS.FISH]: [UI_PLATFORMS.MAC, UI_PLATFORMS.LINUX],
  [SHELL_KINDS.SH]: [UI_PLATFORMS.MAC, UI_PLATFORMS.LINUX],
};

/** A shell ctrlyoke offers by name when authoring a per-script `shell` override. */
export interface ShellChoice {
  /**
   * The value written to a workflow's `shell` field. Deliberately a bare
   * executable name rather than a full path: a workflow file is shared across
   * machines, and `terminal.shellExecutable` is the place for a machine's own
   * absolute path.
   */
  value: string;
  label: string;
  kind: ShellKind;
  /** Other executable names that mean this same choice. */
  aliases?: readonly string[];
}

/**
 * The shells offered by name in authoring pickers, in the order they are shown.
 * `schemas/workflow-schema.json`'s `scriptProperties.shell` examples are drawn
 * from the same set.
 */
export const SHELL_CHOICES: readonly ShellChoice[] = [
  {
    value: SHELL_KINDS.PWSH,
    label: "PowerShell 7 (pwsh)",
    kind: SHELL_KINDS.PWSH,
  },
  {
    value: SHELL_KINDS.POWERSHELL,
    label: "Windows PowerShell",
    kind: SHELL_KINDS.POWERSHELL,
  },
  {
    value: SHELL_TYPES.CMD,
    label: "Command Prompt (cmd)",
    kind: SHELL_KINDS.CMD,
  },
  { value: SHELL_TYPES.WSL, label: "WSL (bash)", kind: SHELL_KINDS.WSL },
  { value: SHELL_TYPES.BASH, label: "bash", kind: SHELL_KINDS.BASH },
  { value: SHELL_TYPES.ZSH, label: "zsh", kind: SHELL_KINDS.ZSH },
  { value: SHELL_TYPES.FISH, label: "fish", kind: SHELL_KINDS.FISH },
  {
    value: SHELL_TYPES.SH,
    label: "sh (POSIX)",
    kind: SHELL_KINDS.SH,
    aliases: [SHELL_TYPES.DASH, SHELL_TYPES.KSH],
  },
  {
    value: SHELL_TYPES.NU,
    label: "Nushell (nu)",
    kind: SHELL_KINDS.NUSHELL,
    aliases: [SHELL_TYPES.NUSHELL],
  },
];

/** The shells normally installed on `platform`, in catalog order. */
export function shellChoicesForPlatform(
  platform: UiPlatform
): readonly ShellChoice[] {
  return SHELL_CHOICES.filter((choice) =>
    SHELL_KIND_PLATFORMS[choice.kind].includes(platform)
  );
}

/**
 * Resolve a `shell` field value to the catalog entry it names, if any.
 *
 * Matches on the executable's own name, so "/bin/zsh", "zsh" and "zsh.exe" are
 * all the zsh choice. Unlike `resolveShellKind`, an unrecognized executable
 * returns `undefined` instead of being folded into bash by that function's
 * catch-all — a picker has to be able to tell "a shell I know, written a
 * different way" from "a custom path the user typed".
 */
export function findShellChoice(shell: string): ShellChoice | undefined {
  const name = shellDisplayName(shell).trim().toLowerCase();
  if (!name) {
    return undefined;
  }
  return SHELL_CHOICES.find(
    (choice) => choice.value === name || choice.aliases?.includes(name)
  );
}

/** Whether `shell` names an executable normally present on `platform`. */
export function isShellAvailableOnPlatform(
  shell: string,
  platform: UiPlatform
): boolean {
  return SHELL_KIND_PLATFORMS[resolveShellKind(shell)].includes(platform);
}

const MULTILINE_SCRIPT_NEWLINE = /\r\n?|\n/;

export const MULTILINE_CMD_SCRIPT_ERROR =
  "Multi-line scripts cannot run under cmd. Set this script's `shell` field to a shell that supports multi-line scripts, for example `shell: pwsh`.";

/**
 * Return the actionable preflight error for a script/shell combination, if any.
 * Keep this next to shell resolution so headless execution, PTY execution, and
 * the authoring UI enforce the same shell-specific script contract.
 */
export function getShellInvocationError(
  script: string,
  shellKind: ShellKind
): string | undefined {
  if (shellKind === SHELL_KINDS.CMD && MULTILINE_SCRIPT_NEWLINE.test(script)) {
    return MULTILINE_CMD_SCRIPT_ERROR;
  }
  return undefined;
}
