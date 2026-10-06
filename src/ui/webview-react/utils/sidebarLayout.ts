/**
 * Geometry for the desktop horizontal Group: prompts sidebar | center column |
 * settings sidebar. Pure functions so the allocation rules are unit-testable
 * without mounting react-resizable-panels.
 */
import {
  PANEL_COLLAPSED_SIZE_SIDEBAR,
  PANEL_MAX_SIZE_SIDEBAR,
  PANEL_MIN_SIZE_CENTER_COLUMN,
  PANEL_MIN_SIZE_SIDEBAR,
} from "../constants";

const SIDEBAR_COLLAPSED_PX = Number.parseInt(PANEL_COLLAPSED_SIZE_SIDEBAR, 10);
const SIDEBAR_MIN_PX = Number.parseInt(PANEL_MIN_SIZE_SIDEBAR, 10);
const SIDEBAR_MAX_PX = Number.parseInt(PANEL_MAX_SIZE_SIDEBAR, 10);
const CENTER_MIN_PX = Number.parseInt(PANEL_MIN_SIZE_CENTER_COLUMN, 10);

/** Panel ids of the desktop horizontal Group, in DOM order. */
export const SIDEBAR_LAYOUT_PANEL_IDS = {
  steps: "prompts-panel",
  center: "center-content",
  settings: "settings-panel",
} as const;

/**
 * Pixel width needed to show both sidebars and the center column at their
 * minimum sizes. Below it the two sidebars are mutually exclusive.
 */
export const BOTH_SIDEBARS_MIN_WIDTH_PX = 2 * SIDEBAR_MIN_PX + CENTER_MIN_PX;

export interface SidebarLayoutInput {
  totalPx: number;
  stepsCollapsed: boolean;
  settingsCollapsed: boolean;
  /** The user's last chosen (persisted) expanded widths. */
  stepsStoredPx: number;
  settingsStoredPx: number;
}

const toPct = (px: number, totalPx: number) =>
  Number(((px / totalPx) * 100).toFixed(3));

/**
 * Builds the percentage layout for the horizontal Group.
 *
 * An expanded sidebar is never handed less than its minimum width: a size
 * below `minSize` on a collapsible panel is snapped by react-resizable-panels
 * to `collapsedSize`, and because the panel was already at that size its
 * `onResize` never fires — leaving the store "expanded" while the panel stays
 * a 32px strip with the expanded content crammed into it. So when the stored
 * widths don't fit beside the center column, each expanded sidebar gives up
 * its slack above the minimum in proportion to how much it has.
 */
export function buildSidebarLayout({
  totalPx,
  stepsCollapsed,
  settingsCollapsed,
  stepsStoredPx,
  settingsStoredPx,
}: SidebarLayoutInput): Record<string, number> {
  const clampExpanded = (px: number) =>
    Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, px));
  let stepsPx = stepsCollapsed
    ? SIDEBAR_COLLAPSED_PX
    : clampExpanded(stepsStoredPx);
  let settingsPx = settingsCollapsed
    ? SIDEBAR_COLLAPSED_PX
    : clampExpanded(settingsStoredPx);

  const overflowPx = stepsPx + settingsPx + CENTER_MIN_PX - totalPx;
  if (overflowPx > 0) {
    const stepsSlack = stepsCollapsed ? 0 : stepsPx - SIDEBAR_MIN_PX;
    const settingsSlack = settingsCollapsed ? 0 : settingsPx - SIDEBAR_MIN_PX;
    const totalSlack = stepsSlack + settingsSlack;
    if (totalSlack > 0) {
      const shrinkFraction = Math.min(1, overflowPx / totalSlack);
      stepsPx -= stepsSlack * shrinkFraction;
      settingsPx -= settingsSlack * shrinkFraction;
    }
  }

  const stepsPct = toPct(stepsPx, totalPx);
  const settingsPct = toPct(settingsPx, totalPx);
  return {
    [SIDEBAR_LAYOUT_PANEL_IDS.steps]: stepsPct,
    [SIDEBAR_LAYOUT_PANEL_IDS.center]: Number(
      (100 - stepsPct - settingsPct).toFixed(3)
    ),
    [SIDEBAR_LAYOUT_PANEL_IDS.settings]: settingsPct,
  };
}
