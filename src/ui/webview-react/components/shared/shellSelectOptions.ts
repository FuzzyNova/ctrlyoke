import {
  CUSTOM_SHELL_OPTION,
  INHERIT_DEFAULT_OPTION,
  UI_PLATFORMS,
  UI_PLATFORM_LABELS,
  type UiPlatform,
} from "@root/types/DashboardConstants";
import {
  findShellChoice,
  isShellAvailableOnPlatform,
  shellChoicesForPlatform,
} from "@root/utils/ShellCatalog";
import type { SelectOption } from "./CustomSelect";

/**
 * Options for a per-script `shell` picker.
 *
 * A workflow file travels between machines, so the picker has to render a value
 * this platform would never offer — a step pinned to `zsh` on macOS, opened on
 * Windows — as the selected option rather than silently dropping it. The
 * authored text is always preserved verbatim; only how it is *presented*
 * depends on the platform.
 */

/** Whether a pinned value is a shell the catalog knows, however it was written. */
export function isKnownShell(shell: string | undefined): boolean {
  return Boolean(shell && findShellChoice(shell));
}

/**
 * Whether the picker should show its free-text path input for `shell`.
 * True for anything the catalog does not recognize (a full path to a custom
 * interpreter), which the dropdown cannot meaningfully label.
 */
export function usesCustomShellPath(shell: string | undefined): boolean {
  return Boolean(shell && !isKnownShell(shell));
}

/** The dropdown value for a pinned shell, given whether custom-path mode is on. */
export function shellSelectValue(
  shell: string | undefined,
  customPathMode: boolean
): string {
  if (customPathMode) {
    return CUSTOM_SHELL_OPTION;
  }
  return shell || INHERIT_DEFAULT_OPTION;
}

/**
 * Build the shell dropdown options for `platform`, keeping `pinned` selectable
 * even when this platform does not normally have that shell.
 */
export function buildShellOptions(
  pinned: string | undefined,
  platform: UiPlatform
): SelectOption[] {
  const options: SelectOption[] = [
    {
      value: INHERIT_DEFAULT_OPTION,
      label: "Auto",
      description: "Uses terminal.shellExecutable, or the platform default",
    },
    ...shellChoicesForPlatform(platform).map((choice) => ({
      value: choice.value,
      label: choice.label,
    })),
  ];

  const shell = pinned?.trim();
  if (
    shell &&
    isKnownShell(shell) &&
    !options.some((option) => option.value === shell)
  ) {
    // A shell this platform does not list, or the same shell spelled another
    // way (`/bin/zsh`, `pwsh.exe`). Either way the authored value stays the
    // selected option so nothing is lost by merely opening the workflow here.
    const unavailable = !isShellAvailableOnPlatform(shell, platform);
    options.splice(1, 0, {
      value: shell,
      label: shell,
      description: unavailable
        ? `Not typically available on ${UI_PLATFORM_LABELS[platform]}`
        : undefined,
      descriptionClassName: unavailable ? "text-warning-fg" : undefined,
    });
  }

  options.push({ value: CUSTOM_SHELL_OPTION, label: "Custom path..." });
  return options;
}

/** An example path for the free-text input, in this platform's own shape. */
export function customShellPathPlaceholder(platform: UiPlatform): string {
  return platform === UI_PLATFORMS.WINDOWS
    ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    : "/usr/local/bin/fish";
}
