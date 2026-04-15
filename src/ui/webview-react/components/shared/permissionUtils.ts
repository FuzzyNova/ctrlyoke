import { HARNESS_IDS, type HarnessId } from "../../types/messages";
import type { ToolPermissionsOverride } from "../../types/messages";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";

/** Options for the permission mode selector (used by both WorkflowPropertiesPanel and PropertiesDrawer) */
export const PERMISSION_MODE_OPTIONS = [
  {
    value: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
    label: "Dangerously Allow All (yolo)",
  },
  { value: PERMISSION_MODES.ALLOW_ALL, label: "Allow All" },
  { value: PERMISSION_MODES.CUSTOM, label: "Custom" },
  { value: PERMISSION_MODES.NONE, label: "None" },
];

export type PermissionHarnessSupport = "full" | "mode-only" | "n/a";

export function getPermissionHarnessSupport(
  harnessId: HarnessId
): PermissionHarnessSupport {
  switch (harnessId) {
    case HARNESS_IDS.COPILOT_CLI:
    case HARNESS_IDS.CLAUDE_CLI:
    case HARNESS_IDS.QWEN_CLI:
      return "full";
    case HARNESS_IDS.CODEX_CLI:
    case HARNESS_IDS.OPENCODE_CLI:
    case HARNESS_IDS.GEMINI_CLI:
      return "mode-only";
    case HARNESS_IDS.COPILOT_CHAT:
    default:
      return "n/a";
  }
}

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
  if (
    effective === null ||
    effective === undefined ||
    effective.mode === PERMISSION_MODES.NONE
  ) {
    return "Default (none)";
  }
  if (effective.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
    return "Default (dangerouslyAllowAll)";
  if (effective.mode === PERMISSION_MODES.ALLOW_ALL)
    return "Default (allowAll)";
  const count =
    (effective.allowedTools?.length ?? 0) +
    (effective.deniedTools?.length ?? 0);
  return `Default (custom, ${count} rule${count !== 1 ? "s" : ""})`;
}
