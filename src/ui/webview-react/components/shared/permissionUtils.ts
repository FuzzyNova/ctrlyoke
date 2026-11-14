import type { ToolPermissionsOverride } from "../../types/messages";
import {
  PERMISSION_CAPABILITY_KEYS,
  PERMISSION_MODES,
  permissionModeAppliesToolList,
} from "@root/types/DashboardConstants";
import type { PermissionMode } from "@root/types/DashboardConstants";
import { PERMISSION_MODE_OPTIONS_META } from "@root/types/SchemaUiMetadata";

/** Whether the allow-list editor is active for this mode. */
export function permissionModeAllowsAllowedTools(mode: string): boolean {
  return permissionModeAppliesToolList(
    mode as PermissionMode,
    PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
  );
}

/**
 * Build the "Default (X)" label for the Permissions dropdown in PromptPropertiesDrawer.
 * Workflow-level value takes precedence; globalValue is the fallback when workflow
 * has no override (undefined), reflecting the full three-tier inheritance chain.
 */
export function buildPermissionsDefaultLabel(
  workflowValue: ToolPermissionsOverride | null | undefined,
  globalValue?: ToolPermissionsOverride | null
): string {
  const effective = workflowValue !== undefined ? workflowValue : globalValue;
  const mode =
    effective === null || effective === undefined
      ? PERMISSION_MODES.NONE
      : (effective.mode ?? PERMISSION_MODES.ALLOW_ALL);
  return `Inherit (${PERMISSION_MODE_OPTIONS_META[mode].label})`;
}
