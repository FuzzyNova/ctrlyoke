import type { ToolPermissionsOverride } from "../../types/messages";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import { PERMISSION_MODE_OPTIONS_META } from "@root/types/SchemaUiMetadata";

/**
 * Build the "Default (X)" label for the Permissions dropdown in PropertiesDrawer.
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
