import { PERMISSION_MODES } from "@root/types/DashboardConstants";

/** Tab icon override shape used by DrawerTabBar */
export interface TabIconOverride {
  /** Replace the tab's default codicon with this one */
  codicon?: string;
  /** Tailwind text-color class to apply to the icon and label */
  color?: string;
}

/**
 * Returns the tab icon override for the Permissions tab based on the resolved
 * permission mode. None returns undefined (use default styling).
 */
export function getPermissionTabOverride(
  mode: string
): TabIconOverride | undefined {
  switch (mode) {
    case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
      return { codicon: "workspace-untrusted", color: "text-error-fg" };
    case PERMISSION_MODES.ALLOW_ALL:
      return { color: "text-warning-fg" };
    case PERMISSION_MODES.CUSTOM:
      return { color: "text-terminal-ansiGreen" };
    case PERMISSION_MODES.NONE:
    default:
      return undefined;
  }
}

/** Yellow icon if any hooks are configured in the resolved value */
export function getHooksTabOverride(
  hooks: object[] | null | undefined
): TabIconOverride | undefined {
  if (Array.isArray(hooks) && hooks.length > 0) {
    return { color: "text-warning-fg" };
  }
  return undefined;
}

/** Blue (focus-border) icon if any MCP servers are configured */
export function getMcpTabOverride(
  mcpServers: (string | object)[] | null | undefined
): TabIconOverride | undefined {
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    return { color: "text-focus-border" };
  }
  return undefined;
}

/** Green icon if an end condition with a script is configured */
export function getValidationTabOverride(
  endCondition: { script?: string } | null | undefined
): TabIconOverride | undefined {
  if (endCondition?.script) {
    return { color: "text-terminal-ansiGreen" };
  }
  return undefined;
}

/**
 * Blue (focus-border) icon if resume session is active or prior context is not "none".
 * Accepts unknown priorContext to handle both string union and number[] without importing PriorContext.
 */
export function getContextTabOverride(
  resumeSession: boolean | undefined,
  priorContext: unknown
): TabIconOverride | undefined {
  const sessionActive = resumeSession === true;
  const contextActive = Array.isArray(priorContext)
    ? priorContext.length > 0
    : typeof priorContext === "string" && priorContext !== "none";
  if (sessionActive || contextActive) {
    return { color: "text-focus-border" };
  }
  return undefined;
}
