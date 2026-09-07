/** Terminal-style tool call container */
export const TOOL_CALL_TERMINAL =
  "font-[Consolas,Monaco,'Courier_New',monospace] my-2 leading-relaxed";

/** Tool call header line (bullet + command text) */
export const TOOL_CALL_LINE =
  "text-editor-fg text-[length:var(--fp-output-font-size)] flex flex-wrap items-center gap-1";

/**
 * Tool result line (⎿ output).
 *
 * Carries no left padding: inside a ToolCallBlock the gutter column already
 * supplies the offset, and the body is meant to sit flush with the header text.
 * A bare TOOL_RESULT event rendered outside a block adds its own indent.
 */
export const TOOL_RESULT_LINE =
  "text-description-fg text-[length:var(--fp-output-font-size-sm)] whitespace-pre-wrap [overflow-wrap:anywhere]";

/** Tool error line (⎿ error). Same no-padding contract as TOOL_RESULT_LINE. */
export const TOOL_ERROR_LINE =
  "text-error-fg text-[length:var(--fp-output-font-size-sm)] whitespace-pre-wrap [overflow-wrap:anywhere]";

/** Indent for a ⎿ line rendered standalone, outside a ToolCallBlock. */
export const TOOL_RESULT_STANDALONE_INDENT = "pl-4 ml-2";

/** Shared output block base (prompt/response/command containers) */
export const OUTPUT_BLOCK_BASE =
  "py-[var(--spacing-sm)] px-[var(--spacing-sm)] my-[var(--spacing-sm)] border-l-[3px] whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[length:var(--fp-output-font-size-sm)] bg-transparent";

/** Width of the per-row step identity bar painted by `getStepIdentityBarStyle`. */
export const STEP_IDENTITY_BAR_WIDTH_PX = 2;

/**
 * Gap between the pane's true left edge and the start of the identity bar.
 *
 * The pane's left edge is also where the Output/Steps panel resize splitter
 * hit-tests, so painting color all the way to x=0 makes the splitter's own
 * hover/drag highlight read as if the step color were bleeding into it. A
 * 1px transparent margin keeps the boundary pixel free for the splitter.
 * `OFFSET + WIDTH` (3px) is the total reserved region, matching the
 * `pl-[3px]` content offset used on most of the non-CLI-group row path
 * (`OutputRow.tsx`). The STATUS row kind uses a larger `pl-[6px]` there
 * instead, since `StatusMessage` paints its own severity border and needs
 * clearance so that border doesn't sit flush against the identity bar.
 */
export const STEP_IDENTITY_BAR_OFFSET_PX = 1;

/**
 * Background for a row's step identity bar.
 *
 * Deliberately a gradient rather than `box-shadow: inset 3px 0 0 <color>`.
 * Chromium paints an inset shadow as the difference of two rects whose top,
 * bottom and right edges coincide exactly; when the element's box lands on a
 * fractional device pixel — which virtualized output rows, positioned by
 * `translateY(<measured px>)`, do constantly — those coincident edges are
 * anti-aliased independently and leave a faint full-width hairline of the step
 * color along the row's top and bottom. That reads as a thin border wrapping
 * every event, and is visible at exactly the row boundaries where the fraction
 * is unlucky. A background gradient is transparent past the bar, so it has no
 * edge to bleed, and unlike a `border-left` it changes no box geometry — the
 * row keeps the content width its height estimate was computed against.
 */
export function getStepIdentityBarStyle(color: string): {
  backgroundImage: string;
} {
  const barEnd = STEP_IDENTITY_BAR_OFFSET_PX + STEP_IDENTITY_BAR_WIDTH_PX;
  return {
    backgroundImage: `linear-gradient(to right, transparent 0, transparent ${STEP_IDENTITY_BAR_OFFSET_PX}px, ${color} ${STEP_IDENTITY_BAR_OFFSET_PX}px, ${color} ${barEnd}px, transparent ${barEnd}px)`,
  };
}
