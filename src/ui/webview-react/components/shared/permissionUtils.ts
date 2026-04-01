import { HARNESS_IDS, type HarnessId } from "../../types/messages";
import type { ToolPermissionsOverride } from "../../types/messages";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";

/** Options for the permission mode selector (used by both SettingsDrawer and PropertiesDrawer) */
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
 * Input is workflow-level toolPermissions only — no global fallback.
 */
export function buildPermissionsDefaultLabel(
  workflowValue: ToolPermissionsOverride | null | undefined
): string {
  if (
    workflowValue === null ||
    workflowValue === undefined ||
    workflowValue.mode === PERMISSION_MODES.NONE
  ) {
    return "Default (none)";
  }
  if (workflowValue.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
    return "Default (dangerouslyAllowAll)";
  if (workflowValue.mode === PERMISSION_MODES.ALLOW_ALL)
    return "Default (allowAll)";
  const count =
    (workflowValue.allowedTools?.length ?? 0) +
    (workflowValue.deniedTools?.length ?? 0);
  return `Default (custom, ${count} rule${count !== 1 ? "s" : ""})`;
}
