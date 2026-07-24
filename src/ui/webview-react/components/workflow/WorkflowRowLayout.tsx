import React from "react";
import { WORKFLOW_ROW_TRACKS } from "../../constants";
import { runNavIndicatorLabel, isDrillableRunNav } from "@utils/runNavigation";
import type { WorkflowRunNavigationSummary } from "@root/types/CtrlYokeTypes";

interface WorkflowRowLayoutProps {
  /**
   * Two-line layout: label on its own line, metadata on a muted second line.
   * Driven by the *dropdown's* width, not the trigger's — see
   * `WORKFLOW_DROPDOWN_NARROW_WIDTH`.
   */
  isStacked: boolean;
  onClick: () => void;
  ariaLabel?: string;
  className?: string;
  /** Column 1 / left rail — harness icon, vertically centred across both lines when stacked. */
  harness?: React.ReactNode;
  harnessTitle?: string;
  /** Column 2 / first line — workflow name or run identity. Truncates. */
  label: React.ReactNode;
  labelClassName?: string;
  /** Column 3 / first meta item — step count or step progress. */
  count?: React.ReactNode;
  /** Column 4 / trailing meta glyph — 16px status icon (terminal session, live run). */
  glyph?: React.ReactNode;
  /** Column 5 / first line, right — execution state badge. */
  badge?: React.ReactNode;
  /** Column 6 / last meta item — relative time or elapsed timer. */
  time?: React.ReactNode;
}

function hasContent(node: React.ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

interface RunIndicatorCellProps {
  runNav: WorkflowRunNavigationSummary | undefined;
  workflowName: string;
  isNarrow: boolean;
  /** Omitted when the lineage can't be drilled into; the track is still reserved. */
  onDrill?: () => void;
}

/**
 * RunIndicatorCell - the `Run 12 ›` drill affordance, a sibling of the row's
 * primary button (never nested inside it).
 *
 * The track is fixed-width and reserved list-wide whenever *any* row is
 * drillable, including across the running/recent split: everything to its
 * right is what positions the state and time columns, so a row that dropped
 * the track would sit its badge 64px out of line with its neighbours.
 */
export const RunIndicatorCell: React.FC<RunIndicatorCellProps> = ({
  runNav,
  workflowName,
  isNarrow,
  onDrill,
}) => (
  <span
    className="flex flex-shrink-0 justify-end"
    style={{ width: WORKFLOW_ROW_TRACKS.runIndicator }}
  >
    {runNav && isDrillableRunNav(runNav) && onDrill ? (
      <button
        type="button"
        title={`Browse runs of ${workflowName}`}
        aria-label={`${runNavIndicatorLabel(runNav, isNarrow)} — browse runs of ${workflowName}`}
        onClick={(event) => {
          event.stopPropagation();
          onDrill();
        }}
        className="fp-dropdown-row flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-description-fg hover:bg-list-hover-bg hover:text-foreground"
      >
        <span className="truncate">
          {runNavIndicatorLabel(runNav, isNarrow)}
        </span>
        <i className="codicon codicon-chevron-right text-xxs" />
      </button>
    ) : null}
  </span>
);

/**
 * RowActionRail - the fixed-width trailing cluster every row kind ends with
 * (favourite/remove, pause/stop, delete-run).
 *
 * Fixed rather than content-sized for the same reason as the run-indicator
 * track: these siblings sit outside the primary button's grid, so any
 * difference in their total width shifts that row's whole metadata block
 * relative to its neighbours.
 */
export const RowActionRail: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => (
  <span
    className="flex flex-shrink-0 items-center justify-end gap-1"
    style={{ width: WORKFLOW_ROW_TRACKS.actions }}
  >
    {children}
  </span>
);

/**
 * Builds a row's accessible name from its identity and metadata.
 *
 * Every row kind passes an explicit label rather than letting the name fall out
 * of concatenated cell text: the stacked and flat layouts render the same
 * information in a different DOM order, and an accessible name that changes
 * with the dropdown's width is a bug even when both readings are sensible.
 * Omit values that tick (an elapsed timer re-announces on every update).
 */
export function composeRowAccessibleName(
  parts: Array<string | number | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" — ");
}

/**
 * WorkflowRowLayout - the primary button shared by every row in the workflow
 * dropdown: recent lineages, running lineages, and run-panel runs.
 *
 * Owning both layouts here is what keeps the three row kinds from drifting:
 * each caller supplies the same six pieces of content and this decides whether
 * they render as one aligned line or two stacked ones.
 *
 * Callers always pass full-length content. The compact forms the flat layout
 * once needed (`4` for `4 steps`, an icon for `COMPLETED`) exist to survive a
 * cramped single line; the stacked layout has room, so squeezing there would
 * cost legibility for nothing.
 */
export const WorkflowRowLayout: React.FC<WorkflowRowLayoutProps> = ({
  isStacked,
  onClick,
  ariaLabel,
  className = "",
  harness,
  harnessTitle,
  label,
  labelClassName = "",
  count,
  glyph,
  badge,
  time,
}) => {
  const buttonClassName = `workflow-row-primary ${
    isStacked ? "workflow-row-primary-stacked" : "workflow-row-primary-flat"
  } min-w-0 flex-1 appearance-none overflow-hidden border-none bg-transparent p-0 text-left text-inherit cursor-pointer ${className}`;

  if (!isStacked) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={buttonClassName}
        // Published from WORKFLOW_ROW_TRACKS rather than hard-coded in CSS:
        // WORKFLOW_DROPDOWN_NARROW_WIDTH is derived from these widths, so a
        // track that could be widened in the stylesheet alone would silently
        // invalidate the breakpoint and collapse the name column.
        style={
          {
            "--workflow-row-state-col": `${WORKFLOW_ROW_TRACKS.state}px`,
            "--workflow-row-time-col": `${WORKFLOW_ROW_TRACKS.time}px`,
          } as React.CSSProperties
        }
      >
        <span
          className="col-start-1 flex w-[14px] items-center justify-center"
          title={harnessTitle}
        >
          {harness}
        </span>
        <span
          className={`col-start-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${labelClassName}`}
        >
          {label}
        </span>
        <span className="col-start-3 whitespace-nowrap font-mono text-xs text-description-fg">
          {count}
        </span>
        <span className="col-start-4 flex w-4 items-center justify-center text-description-fg">
          {glyph}
        </span>
        {/* Left-aligned, not centred: badge labels vary from IDLE to
            CANCELLING, and centring them in a fixed track leaves the status
            column visibly ragged down the list. A shared left edge is what
            makes the column scannable. */}
        <span className="col-start-5 flex justify-start">{badge}</span>
        <span className="col-start-6 truncate text-right text-xs text-description-fg">
          {time}
        </span>
      </button>
    );
  }

  // Absent metadata is omitted rather than reserved, so the second line never
  // shows a dangling separator for a lineage with no steps or no timestamp.
  const metaParts: Array<{ key: string; node: React.ReactNode }> = [];
  if (hasContent(count)) metaParts.push({ key: "count", node: count });
  if (hasContent(time)) metaParts.push({ key: "time", node: time });

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={buttonClassName}
    >
      <span
        className="workflow-row-cell-icon flex w-[14px] items-center justify-center"
        title={harnessTitle}
      >
        {harness}
      </span>
      <span
        className={`workflow-row-cell-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${labelClassName}`}
      >
        {label}
      </span>
      <span className="workflow-row-cell-badge flex justify-end">{badge}</span>
      <span className="workflow-row-cell-meta flex min-w-0 items-center gap-1 overflow-hidden text-xs text-description-fg">
        {metaParts.map((part, index) => (
          <React.Fragment key={part.key}>
            {index > 0 && (
              <span aria-hidden="true" className="opacity-50">
                ·
              </span>
            )}
            <span className="truncate">{part.node}</span>
          </React.Fragment>
        ))}
        {hasContent(glyph) && (
          <span className="flex w-4 flex-shrink-0 items-center justify-center">
            {glyph}
          </span>
        )}
      </span>
    </button>
  );
};
