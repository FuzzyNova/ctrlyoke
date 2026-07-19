/**
 * ToolCallBlock — the shared two-column frame for every ● tool-call block.
 *
 * Bash commands, generic/MCP tool calls, web searches and file operations all
 * render a `● <label>` header followed by body content (results, errors,
 * diffs). This lays that out as a gutter column and a content column:
 *
 *   ● header text that is long enough to wrap
 *   │ and its continuation, flush with the header
 *   │ ⎿ result line, flush with the header too
 *   │      wrapped result content
 *
 * The ● caps the top of the gutter and a 1px rail fills the rest of it, so it
 * runs beside wrapped header lines and the whole body. Everything else lives in
 * the content column at one shared left edge — which is what gives the header
 * its hanging indent. Body content therefore carries **no** left padding of its
 * own; see TOOL_RESULT_LINE / TOOL_ERROR_LINE in outputStyles.ts.
 *
 * `fullBleed` content (diffs) renders *below* the two-column row and spans the
 * gutter as well, so the rail stops just above it rather than squeezing it.
 */
import React from "react";
import { TOOL_CALL_TERMINAL, TOOL_CALL_LINE } from "./outputStyles";

interface ToolCallBlockProps {
  /** The ● bullet — normally a <ToolDot />. */
  dot: React.ReactNode;
  /** Header line content, rendered to the right of the dot. */
  header: React.ReactNode;
  /** Body content (results, errors) hung under the header, inside the rail. */
  children?: React.ReactNode;
  /**
   * Content that spans the gutter too, rendered after — and therefore below —
   * the railed rows. Used for diffs, which need the full block width.
   */
  fullBleed?: React.ReactNode;
  className?: string;
}

export const ToolCallBlock: React.FC<ToolCallBlockProps> = ({
  dot,
  header,
  children,
  fullBleed,
  className = "",
}) => (
  <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
    <div className="flex gap-x-2">
      {/* items-stretch (the flex default) makes this column span the row, so
          the rail's bottom-0 always reaches the last railed line. */}
      <div className="relative flex shrink-0 flex-col items-center">
        {/* The rail starts at the vertical middle of the dot's line box rather
            than below it, so it meets the ● regardless of font size or the
            glyph's metrics; the dot paints over the overlap. Anchoring it to
            the bottom of the line box instead leaves a half-leading gap. */}
        <div className="absolute left-1/2 top-[0.8em] bottom-0 w-px -translate-x-1/2 bg-panel-border" />
        <span className="relative">{dot}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className={TOOL_CALL_LINE}>{header}</div>
        {children}
      </div>
    </div>
    {fullBleed}
  </div>
);

ToolCallBlock.displayName = "ToolCallBlock";
