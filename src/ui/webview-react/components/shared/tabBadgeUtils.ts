import {
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
} from "@root/types/DashboardConstants";
import {
  isPreviousStepsPriorContext,
  isPriorContextRunSource,
  type PriorContext,
  type UserHookConfig,
} from "@root/types/CtrlYokeTypes";
import {
  PERMISSION_MODE_OPTIONS_META,
  PRIOR_CONTEXT_KEYWORD_OPTIONS_META,
} from "@root/types/SchemaUiMetadata";
import { schemaTitle } from "@utils/schemaPropertyLabels";

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
  /**
   * Tailwind text-color class kept in every tab state, taking precedence over
   * `color`/`hoverColor`/`activeColor`. Like the Harness tab's icon, the icon is
   * dimmed while the tab is inactive and restored to full opacity on hover or
   * selection, so a status color (e.g. yolo red) never drops out when selected.
   */
  statusColor?: string;
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

type PermissionModeVisual = { codicon: string; color: string };

/**
 * Resolves the icon/color visual for a permission mode — the single source of
 * truth for how permission state is drawn, shared by the Permissions tab
 * (DrawerTabBar/SegmentedTabBar) and PermissionsQuickPicker. Always falls back
 * to the "none" look for an unrecognized mode, so unlike
 * `getPermissionTabOverride` this never returns undefined — callers that need
 * their own dimmed/inherited treatment (e.g. PermissionsQuickPicker) get a
 * real color back for every mode, including "none".
 */
export function getPermissionModeVisual(mode: string): PermissionModeVisual {
  const visual =
    PERMISSION_MODE_OPTIONS_META[
      mode as keyof typeof PERMISSION_MODE_OPTIONS_META
    ]?.visual ?? PERMISSION_MODE_OPTIONS_META[PERMISSION_MODES.NONE].visual!;
  return { codicon: visual.codicon, color: visual.color };
}

/** Per-mode visual for the Permissions tab. None returns undefined. */
function permissionModeVisualOrNone(
  mode: string
): PermissionModeVisual | undefined {
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
  const visual = permissionModeVisualOrNone(mode);
  const modeOverride: TabIconOverride | undefined = visual && {
    codicon: visual.codicon,
    statusColor: visual.color,
  };
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
  const visual = permissionModeVisualOrNone(mode);
  if (!visual) {
    return undefined;
  }

  return {
    badgeCodicon: "shield",
    badgeColor: visual.color,
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
 * Accepts unknown priorContext to handle the string, number[], and object forms without importing PriorContext.
 */
export function getContextTabOverride(
  resumeSession: boolean | undefined,
  priorContext: unknown
): TabIconOverride | undefined {
  const sessionActive = resumeSession === true;
  // Any object form ({ previous: N }, a run address) always injects context.
  const contextActive = Array.isArray(priorContext)
    ? priorContext.length > 0
    : (typeof priorContext === "string" &&
        priorContext !== PRIOR_CONTEXT_KEYWORDS.NONE) ||
      (typeof priorContext === "object" && priorContext !== null);
  if (sessionActive || contextActive) {
    return FOCUS_TAB_OVERRIDE;
  }
  return undefined;
}

/** Compact step-row chip for an explicitly set priorContext. */
export function priorContextBadge(priorContext: PriorContext): {
  label: string;
  title: string;
} {
  let label: string;
  if (Array.isArray(priorContext)) {
    label = `ctx: [${priorContext.join(",")}]`;
  } else if (isPreviousStepsPriorContext(priorContext)) {
    label = `ctx: ${PRIOR_CONTEXT_KEYWORD_OPTIONS_META.previous.short} ${priorContext.previous}`;
  } else if (isPriorContextRunSource(priorContext)) {
    // The full address is in the title; it is too long for a chip.
    label = "ctx: run";
  } else {
    label = `ctx: ${PRIOR_CONTEXT_KEYWORD_OPTIONS_META[priorContext]?.short ?? priorContext}`;
  }
  return {
    label,
    title: schemaTitle(
      "priorContext",
      typeof priorContext === "object"
        ? JSON.stringify(priorContext)
        : priorContext
    ),
  };
}
