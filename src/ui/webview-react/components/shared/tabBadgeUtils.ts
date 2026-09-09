import {
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
} from "@root/types/DashboardConstants";
import type { UserHookConfig } from "@root/types/CtrlYokeTypes";

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

/** Default codicon for the Permissions tab/quick-picker (workspace-trust shield shape). */
export const PERMISSIONS_DEFAULT_CODICON = "workspace-trusted";

type PermissionModeVisual = Required<
  Pick<TabIconOverride, "codicon" | "color" | "hoverColor" | "activeColor">
>;

/**
 * Full icon/color visual for every permission mode, including "none" — the
 * single source of truth for how permission state is drawn, shared by the
 * Permissions tab (DrawerTabBar/SegmentedTabBar) and PermissionsQuickPicker.
 */
const PERMISSION_MODE_VISUALS: Record<string, PermissionModeVisual> = {
  [PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL]: {
    codicon: "workspace-untrusted",
    color: "text-error-fg",
    hoverColor: "hover:text-terminal-ansiBrightRed",
    activeColor: "text-terminal-ansiBrightRed",
  },
  [PERMISSION_MODES.ALLOW_ALL]: {
    codicon: PERMISSIONS_DEFAULT_CODICON,
    color: "text-warning-fg",
    hoverColor: "hover:text-terminal-ansiBrightYellow",
    activeColor: "text-terminal-ansiBrightYellow",
  },
  [PERMISSION_MODES.CUSTOM]: {
    codicon: PERMISSIONS_DEFAULT_CODICON,
    color: "text-terminal-ansiGreen",
    hoverColor: "hover:text-terminal-ansiBrightGreen",
    activeColor: "text-terminal-ansiBrightGreen",
  },
  [PERMISSION_MODES.NONE]: {
    codicon: PERMISSIONS_DEFAULT_CODICON,
    color: "text-description-fg",
    hoverColor: "hover:text-foreground",
    activeColor: "text-foreground",
  },
};

/**
 * Resolves the icon/color visual for a permission mode, always falling back
 * to the "none" look for an unrecognized mode. Unlike `getPermissionTabOverride`,
 * this never returns undefined — callers that need their own dimmed/inherited
 * treatment (e.g. PermissionsQuickPicker) can rely on getting a real color back
 * for every mode, including "none".
 */
export function getPermissionModeVisual(mode: string): PermissionModeVisual {
  return (
    PERMISSION_MODE_VISUALS[mode] ?? PERMISSION_MODE_VISUALS[PERMISSION_MODES.NONE]
  );
}

/** Per-mode icon shape/color for the Permissions tab. None returns undefined. */
function permissionModeIconOverride(mode: string): TabIconOverride | undefined {
  if (mode === PERMISSION_MODES.NONE) {
    return undefined;
  }
  return getPermissionModeVisual(mode);
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
  hooks: readonly Pick<UserHookConfig, "event">[] | null | undefined,
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
  mcpServers: (string | object)[] | null | undefined,
  hasCompatibilityWarning = false
): TabIconOverride | undefined {
  const configured = Array.isArray(mcpServers) && mcpServers.length > 0;
  if (configured && hasCompatibilityWarning) {
    return {
      ...FOCUS_TAB_OVERRIDE,
      badgeCodicon: "warning",
      badgeColor: "text-warning-fg",
    };
  }
  if (configured) {
    return FOCUS_TAB_OVERRIDE;
  }
  if (hasCompatibilityWarning) {
    return { badgeCodicon: "warning", badgeColor: "text-warning-fg" };
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
    : typeof priorContext === "string" &&
      priorContext !== PRIOR_CONTEXT_KEYWORDS.NONE;
  if (sessionActive || contextActive) {
    return FOCUS_TAB_OVERRIDE;
  }
  return undefined;
}
