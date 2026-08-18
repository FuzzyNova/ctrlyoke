import { PERMISSION_MODES } from "@root/types/DashboardConstants";

/** Tab icon override shape used by DrawerTabBar */
export interface TabIconOverride {
  /** Replace the tab's default codicon with this one */
  codicon?: string;
  /** Tailwind text-color class to apply to the icon when inactive */
  color?: string;
  /** Tailwind hover:text-* class to apply on hover when inactive; defaults to hover:text-foreground */
  hoverColor?: string;
  /** Tailwind text-color class to apply when the tab is active; defaults to text-foreground */
  activeColor?: string;
  /** Small secondary icon rendered in the lower-right corner of the tab's main icon. */
  badgeCodicon?: string;
  /** Tailwind text-color class for the badge icon. */
  badgeColor?: string;
}

export const FOCUS_TAB_OVERRIDE: TabIconOverride = {
  color: "text-focus-border",
  hoverColor: "hover:text-focus-highlight",
  activeColor: "text-focus-highlight",
};

/** Per-mode icon shape/color for the Permissions tab. None returns undefined. */
function permissionModeIconOverride(mode: string): TabIconOverride | undefined {
  switch (mode) {
    case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
      return {
        codicon: "workspace-untrusted",
        color: "text-error-fg",
        hoverColor: "hover:text-terminal-ansiBrightRed",
        activeColor: "text-terminal-ansiBrightRed",
      };
    case PERMISSION_MODES.ALLOW_ALL:
      return {
        color: "text-warning-fg",
        hoverColor: "hover:text-terminal-ansiBrightYellow",
        activeColor: "text-terminal-ansiBrightYellow",
      };
    case PERMISSION_MODES.CUSTOM:
      return {
        color: "text-terminal-ansiGreen",
        hoverColor: "hover:text-terminal-ansiBrightGreen",
        activeColor: "text-terminal-ansiBrightGreen",
      };
    case PERMISSION_MODES.NONE:
    default:
      return undefined;
  }
}

/**
 * Returns the tab icon override for the Permissions tab based on the resolved
 * permission mode. A compatibility warning never replaces the mode's icon or
 * color — the permission state must stay legible — it only adds a warning
 * badge on top, the same overlay treatment used elsewhere for diagnostics.
 */
export function getPermissionTabOverride(
  mode: string,
  hasCompatibilityWarning = false
): TabIconOverride | undefined {
  const modeOverride = permissionModeIconOverride(mode);
  if (!hasCompatibilityWarning) {
    return modeOverride;
  }
  return {
    ...modeOverride,
    badgeCodicon: "warning",
    badgeColor: "text-warning-fg",
  };
}

/**
 * Returns a shield badge for a tab that keeps its own primary icon shape
 * (e.g. Command's terminal icon) instead of swapping to the mode's icon.
 * Only the badge carries the mode's color — the primary icon stays at its
 * default color so the badge isn't a redundant same-color copy of it.
 * None returns undefined (no badge).
 */
export function getPermissionModeBadge(
  mode: string
): Pick<TabIconOverride, "badgeCodicon" | "badgeColor"> | undefined {
  const modeOverride = permissionModeIconOverride(mode);
  if (!modeOverride?.color) {
    return undefined;
  }

  return {
    badgeCodicon: "shield",
    badgeColor: modeOverride.color,
  };
}

/** Focus-border (blue) icon if any hooks are configured in the resolved value */
export function getHooksTabOverride(
  hooks: object[] | null | undefined,
  hasCompatibilityWarning = false
): TabIconOverride | undefined {
  if (Array.isArray(hooks) && hooks.length > 0) {
    return hasCompatibilityWarning
      ? {
          ...FOCUS_TAB_OVERRIDE,
          badgeCodicon: "warning",
          badgeColor: "text-warning-fg",
        }
      : FOCUS_TAB_OVERRIDE;
  }
  return hasCompatibilityWarning
    ? { badgeCodicon: "warning", badgeColor: "text-warning-fg" }
    : undefined;
}

/** Focus-border (blue) icon if any MCP servers are configured */
export function getMcpTabOverride(
  mcpServers: (string | object)[] | null | undefined
): TabIconOverride | undefined {
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    return FOCUS_TAB_OVERRIDE;
  }
  return undefined;
}

/** Focus-border (blue) icon if an end condition with a script is configured */
export function getValidationTabOverride(
  endCondition: { script?: string } | null | undefined
): TabIconOverride | undefined {
  if (endCondition?.script) {
    return FOCUS_TAB_OVERRIDE;
  }
  return undefined;
}

/**
 * Focus-border (blue) icon if resume session is active or prior context is not "none".
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
    return FOCUS_TAB_OVERRIDE;
  }
  return undefined;
}
