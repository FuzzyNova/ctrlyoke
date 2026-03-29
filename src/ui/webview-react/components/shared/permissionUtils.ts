import { HARNESS_IDS, type HarnessId } from "../../types/messages";
import type { ToolPermissionsOverride } from "../../types/messages";

/** Options for the permission mode selector (used by both SettingsDrawer and PropertiesDrawer) */
export const PERMISSION_MODE_OPTIONS = [
  { value: "dangerouslyAllowAll", label: "Dangerously Allow All" },
  { value: "allowAll", label: "Allow All" },
  { value: "custom", label: "Custom" },
  { value: "passthrough", label: "Passthrough" },
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
    workflowValue.mode === "passthrough"
  ) {
    return "Default (none / passthrough)";
  }
  if (workflowValue.mode === "dangerouslyAllowAll")
    return "Default (dangerouslyAllowAll)";
  if (workflowValue.mode === "allowAll") return "Default (allowAll)";
  const count =
    (workflowValue.allowedTools?.length ?? 0) +
    (workflowValue.deniedTools?.length ?? 0);
  return `Default (custom, ${count} rule${count !== 1 ? "s" : ""})`;
}
