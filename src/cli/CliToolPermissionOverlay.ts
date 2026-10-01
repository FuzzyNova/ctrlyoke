import type { PartialCtrlYokeSettings } from "../types/CtrlYokeSettings";
import type { RunCommandOptions } from "./CliRunCommandDefinitions";

/** Apply explicitly provided CLI permission flags to the settings overlay. */
export function applyCliToolPermissionOptions(
  overlay: PartialCtrlYokeSettings,
  options: Pick<RunCommandOptions, "permissionMode" | "allowTool" | "denyTool">
): void {
  if (options.permissionMode) {
    overlay.defaults = {
      ...overlay.defaults,
      toolPermissions: {
        mode: options.permissionMode,
      },
    };
  }
  if (options.allowTool?.length) {
    overlay.defaults = {
      ...overlay.defaults,
      toolPermissions: {
        ...(overlay.defaults?.toolPermissions ?? {}),
        allowedTools: options.allowTool,
      },
    };
  }
  if (options.denyTool?.length) {
    overlay.defaults = {
      ...overlay.defaults,
      toolPermissions: {
        ...(overlay.defaults?.toolPermissions ?? {}),
        deniedTools: options.denyTool,
      },
    };
  }
}
