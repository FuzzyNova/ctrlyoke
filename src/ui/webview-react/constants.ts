/**
 * Panel sizing constants for consistent layout management across mobile and desktop
 */

/** Collapsed panel size - fixed height/width bar when panel is minimized */
export const PANEL_COLLAPSED_SIZE_DEFAULT = "30px";
export const PANEL_COLLAPSED_SIZE_DEFAULT_PX = 30;

/** Alternative collapsed size for prompts/settings panels (desktop) */
export const PANEL_COLLAPSED_SIZE_SIDEBAR = "32px";

/** Minimum panel size as percentage for resizable panels */
export const PANEL_MIN_SIZE_SMALL = "100px";

/** Minimum panel size in pixels for desktop sidebar panels (prompts/settings) */
export const PANEL_MIN_SIZE_SIDEBAR = "192px";

/** Minimum panel size as percentage for vertical center panels (output/editor) */
export const PANEL_MIN_SIZE_CENTER = "15";

/** Minimum height in pixels for the prompt editor before it can collapse */
export const PANEL_MIN_SIZE_EDITOR = "100px";
export const PANEL_MIN_SIZE_EDITOR_PX = 100;

/** Minimum width in pixels for the desktop center column (output/editor) */
export const PANEL_MIN_SIZE_CENTER_COLUMN = "360px";

/** Maximum panel size in pixels for sidebar panels (prompts/settings) */
export const PANEL_MAX_SIZE_SIDEBAR = "480px";

/** Default panel sizes for desktop layout — single source of truth for initial layout.
 *  steps/settings/editor are in pixels; output is a percentage. */
export const DEFAULT_DESKTOP_SIZES = {
  steps: 240,
  output: 60,
  editor: 180,
  settings: 240,
};

/** Default panel sizes for mobile layout — output is a percentage; editor is in pixels. */
export const DEFAULT_MOBILE_SIZES = {
  output: 50,
  editor: 200,
};

/** Separator styling constants for consistent appearance and interaction */
/** Horizontal separator (vertical resize handle) - thin horizontal line */
export const SEPARATOR_HORIZONTAL =
  "h-0.5 bg-panel-border hover:bg-focus-border active:bg-focus-border cursor-row-resize transition-colors";

/** Vertical separator (horizontal resize handle) - thin vertical line */
export const SEPARATOR_VERTICAL =
  "w-0.5 bg-panel-border hover:bg-focus-border active:bg-focus-border cursor-col-resize transition-colors";

/**
 * Header button sizing — single source of truth for button/icon size in the Header.
 * To tune the touch target HEIGHT, change --fp-touch-target in globals.css (one place).
 * To tune the icon size, change the `icon` value in the `touch` block below.
 */
export const HEADER_BUTTON_SIZES = {
  /** Desktop / VS Code: compact, matches VS Code native button density */
  default: {
    /** Padding + min-width for icon-only header buttons */
    iconButton: "min-w-[28px] px-2 py-1.5 text-sm",
    /** Height applied to grouped controls with a shared outer border */
    groupContainer: "",
    /** Main action button in split-button groups */
    splitButtonMain: "px-2 sm:px-3 py-1 text-sm",
    /** Dropdown trigger button in split-button groups */
    splitButtonDropdown: "px-2 py-1 text-sm",
    /** Font-size class applied to the codicon <i> element */
    icon: "codicon-sm",
    /** Height/padding applied to the mobile half-pill toggle buttons */
    mobileToggleButton: "py-1.5",
    /** Vertical padding for separator dividers inside button groups */
    separatorPy: "py-1",
  },
  /** Mobile / touch: height controlled by --fp-touch-target in globals.css */
  touch: {
    iconButton:
      "h-[var(--fp-touch-target)] min-w-[var(--fp-touch-target)] px-2 text-sm",
    groupContainer: "h-[var(--fp-touch-target)]",
    splitButtonMain: "h-full px-2 sm:px-3 text-sm",
    splitButtonDropdown:
      "h-full min-w-[calc(var(--fp-touch-target)-2px)] px-2 text-sm",
    icon: "codicon-lg",
    mobileToggleButton: "h-[var(--fp-touch-target)]",
    separatorPy: "h-full py-0",
  },
} as const;

/**
 * WorkflowStatus header button sizing — the workflow name field and dropdown arrow.
 * Does not affect the expanded dropdown list items.
 * Touch target height controlled by --fp-touch-target in globals.css.
 */
export const WORKFLOW_STATUS_BUTTON_SIZES = {
  /** Desktop / VS Code: compact */
  default: {
    container: "",
    mainButton: "px-3 py-1",
    triggerButton: "px-2 py-1",
    separatorPy: "py-1",
  },
  /** Mobile / touch: height controlled by --fp-touch-target in globals.css */
  touch: {
    container: "h-[var(--fp-touch-target)]",
    mainButton: "h-full px-3",
    triggerButton: "h-full px-3",
    separatorPy: "h-full py-0",
  },
} as const;
