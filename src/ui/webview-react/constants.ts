/**
 * Panel sizing constants for consistent layout management across mobile and desktop
 */

/** Collapsed panel size - fixed height/width bar when panel is minimized */
export const PANEL_COLLAPSED_SIZE_DEFAULT = "30px";
export const PANEL_COLLAPSED_SIZE_DEFAULT_PX = 30;

/** Alternative collapsed size for prompts/settings panels (desktop) */
export const PANEL_COLLAPSED_SIZE_SIDEBAR = "32px";

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
 * Fixed track widths (px) for the flat workflow row layout.
 *
 * These are the source of truth: `WorkflowRowLayout` publishes them as CSS
 * custom properties on the row, and both breakpoints below are derived from
 * them. globals.css only carries matching fallbacks. Sizing lives here because
 * the breakpoints have to be computed from it — a track widened in CSS alone
 * would quietly collapse the name column instead.
 */
export const WORKFLOW_ROW_TRACKS = {
  /** Mirrors the fixed `14px` first track; here so the budget below is complete. */
  harness: 14,
  /** Mirrors the fixed `16px` terminal-icon / live-dot track. */
  glyph: 16,
  /** Fits the longest execution state label, "CANCELLING". */
  state: 88,
  /**
   * Fits the longest verbose stamp, "59 minutes ago". Deliberately one width
   * for every row kind — running rows show a short elapsed timer and would fit
   * in half of it, but a narrower track there shifts their state badge out of
   * line with the recent rows directly below.
   */
  time: 96,
  /**
   * `Run 12 ›` drill affordance, reserved list-wide once any row is drillable
   * — at *every* tier. Everything to a row's right is what positions its state
   * badge, so a row that dropped the track (or sized it to its own content)
   * sits its badge tens of pixels out of line with its neighbours; that is
   * true whether or not the rest of the row is stacked.
   *
   * Only the width varies: stacked rows render the short `#1042` label, so
   * they reserve less than the flat layout's `Run 1042`.
   */
  runIndicator: {
    flat: 64,
    stacked: 52,
  },
  /** Trailing action rail: two icon buttons and the gap between them. */
  actions: 44,
} as const;

/**
 * Width (px) the workflow dropdown opens to on desktop, before being clamped to
 * the viewport and re-centred on its trigger. The popup is a fixed-position
 * overlay, so it may exceed its trigger and overlap neighbouring panels — the
 * limit is legibility of the row content, not the header's own width.
 */
export const WORKFLOW_DROPDOWN_TARGET_WIDTH = 640;

/**
 * Width (px) below which the workflow dropdown's rows stack onto two lines.
 *
 * Derived from what the flat layout costs, not picked for feel. Its fixed
 * tracks and sibling actions — harness 14, terminal 16, badge 88, time 96,
 * run indicator 64, favourite/remove 40, row padding and gaps ~60 — total
 * ~378px before the flexible name column gets a single pixel, plus a
 * `max-content` step count on top. So the name is left roughly:
 *
 *     440px → ~20px   500px → ~80px   560px → ~140px   640px → ~220px
 *
 * Below this threshold the name collapses toward zero and the `max-content`
 * tracks start wrapping instead ("3 steps" onto two lines, "39 minutes ago"
 * onto three) — which also silently doubles the row height the virtualizer
 * estimated. Stacking instead gives the name ~250px at the same width.
 *
 * Measured on the dropdown popup itself, never on the WorkflowStatus split
 * button that opens it — see the two `useElementNarrow` calls in
 * `WorkflowStatus`.
 */
export const WORKFLOW_DROPDOWN_NARROW_WIDTH = 560;

/**
 * Width (px) below which stacked rows also drop their state badge to its
 * icon-only form (and their run indicator to `#12`).
 *
 * Stacking alone only buys the name a line of its own — it does not shrink
 * anything sharing that line. A stacked first line still spends ~238px on the
 * harness icon, a full-text badge ("CANCELLING" ≈ 88px), the run indicator and
 * the action rail, so at a phone- or sidebar-width popup the name is back to a
 * few characters. Dropping the badge to its icon returns ~60px of that.
 *
 * Set so the name keeps ~140px on the stacked first line while the badge still
 * carries text; below it the icon buys that width back instead. See
 * `workflowRowWidths.test.ts`.
 */
export const WORKFLOW_DROPDOWN_COMPACT_WIDTH = 380;

/**
 * How much a workflow dropdown row compacts at the width it is rendered at.
 *
 * - `flat` — one line, fixed metadata tracks aligned down the whole list.
 * - `stacked` — name on its own line, metadata on a muted second line.
 * - `compact` — stacked, plus icon-only badges and `#12` run indicators.
 *
 * One value rather than a pair of booleans: the tiers are ordered, and two
 * independent flags would let `compact && !stacked` exist.
 */
export type WorkflowRowTier = "flat" | "stacked" | "compact";

/** Resolves the row tier for a measured dropdown width. */
export function resolveWorkflowRowTier(width: number): WorkflowRowTier {
  if (width < WORKFLOW_DROPDOWN_COMPACT_WIDTH) return "compact";
  if (width < WORKFLOW_DROPDOWN_NARROW_WIDTH) return "stacked";
  return "flat";
}

/**
 * Virtualizer size estimates for the workflow dropdown's two row layouts.
 *
 * `flat` is one line of metadata; `stacked` adds the second (meta) line used
 * below {@link WORKFLOW_DROPDOWN_NARROW_WIDTH}. The virtualizer corrects to the
 * real measured height once a row is realized, but the estimate drives total
 * scroll height and `scrollToIndex` before that — a 36px estimate against 54px
 * rows makes the scrollbar lie and drops seeks well short of their target on a
 * long list.
 */
export const WORKFLOW_DROPDOWN_ROW_HEIGHT = {
  flat: 36,
  stacked: 54,
} as const;

/** The virtualizer estimate for a tier — `compact` is stacked, just narrower. */
export function workflowRowHeightEstimate(tier: WorkflowRowTier): number {
  return tier === "flat"
    ? WORKFLOW_DROPDOWN_ROW_HEIGHT.flat
    : WORKFLOW_DROPDOWN_ROW_HEIGHT.stacked;
}

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
