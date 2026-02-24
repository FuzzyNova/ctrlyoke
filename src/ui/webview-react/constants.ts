/**
 * Panel sizing constants for consistent layout management across mobile and desktop
 */

/** Collapsed panel size - fixed height/width bar when panel is minimized */
export const PANEL_COLLAPSED_SIZE_DEFAULT = "30px";

/** Alternative collapsed size for prompts/settings panels (desktop) */
export const PANEL_COLLAPSED_SIZE_SIDEBAR = "32px";

/** Expanded size when one vertical panel should take up most space (95% height) */
export const PANEL_EXPANDED_SIZE_SINGLE = "95";

/** Minimum panel size as percentage for resizable panels */
export const PANEL_MIN_SIZE_SMALL = "10";

/** Minimum panel size as percentage for vertical center panels (output/editor) */
export const PANEL_MIN_SIZE_CENTER = "15";

/** Maximum panel size as percentage for sidebar panels (prompts/settings) */
export const PANEL_MAX_SIZE_SIDEBAR = "40";

/** Default panel sizes (percentage) for desktop layout — single source of truth for initial layout */
export const DEFAULT_DESKTOP_SIZES = {
  prompts: 20,
  output: 60,
  editor: 40,
  settings: 20,
};

/** Default panel sizes (percentage) for mobile layout */
export const DEFAULT_MOBILE_SIZES = {
  prompts: 10,
  output: 50,
  editor: 30,
  settings: 10,
};

/** Panel key names derived from the size objects (single source of truth) */
export const PANEL_KEYS = Object.keys(DEFAULT_MOBILE_SIZES) as ReadonlyArray<
  keyof typeof DEFAULT_MOBILE_SIZES
>;

/** Separator styling constants for consistent appearance and interaction */
/** Horizontal separator (vertical resize handle) - thin horizontal line */
export const SEPARATOR_HORIZONTAL =
  "h-0.5 bg-panel-border hover:bg-focus-border active:bg-focus-border cursor-row-resize transition-colors";

/** Vertical separator (horizontal resize handle) - thin vertical line */
export const SEPARATOR_VERTICAL =
  "w-0.5 bg-panel-border hover:bg-focus-border active:bg-focus-border cursor-col-resize transition-colors";
