import React from "react";
import { WORKFLOW_ROW_TRACKS, type WorkflowRowTier } from "../../constants";
import { runNavIndicatorLabel, isDrillableRunNav } from "@utils/runNavigation";
import type { WorkflowRunNavigationSummary } from "@root/types/CtrlYokeTypes";

/**
 * Whether this tier renders the *content* of a row compactly — today the
 * state badge's icon-only form. Stacking alone doesn't imply it: a 500px
 * popup has room for two lines and full-text badges both.
 *
 * Every row kind asks this rather than comparing tiers itself, so "which tier
 * abbreviates" stays a single decision.
 */
export function isCompactRow(tier: WorkflowRowTier): boolean {
  return tier === "compact";
}

interface WorkflowRowLayoutProps {
  /**
   * How much this row compacts. `stacked`/`compact` put the label on its own
   * line with metadata beneath. Driven by the *dropdown's* width, not the
   * trigger's — see `resolveWorkflowRowTier`.
   */
  tier: WorkflowRowTier;
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
  /** Column 6 / run-total usage; joins stacked metadata. */
  usage?: React.ReactNode;
  /** Column 7 / last meta item — relative time or elapsed timer. */
  time?: React.ReactNode;
}

function hasContent(node: React.ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

interface RunIndicatorCellProps {
  runNav: WorkflowRunNavigationSummary | undefined;
  workflowName: string;
  tier: WorkflowRowTier;
  /** Omitted when the lineage can't be drilled into; the track is still reserved. */
  onDrill?: () => void;
}

/**
 * RunIndicatorCell - the `Run 12 ›` drill affordance, a sibling of the row's
 * primary button (never nested inside it).
 *
 * The track is fixed-width and reserved list-wide whenever *any* row is
 * drillable, including across the running/recent split, and at every tier:
 * everything to its right is what positions the state badge (and, when flat,
 * the time column), so a row that dropped the track sits its badge tens of
 * pixels out of line with its neighbours. Stacked rows abandon cross-row
 * alignment *within* the primary button's grid — that is not licence to
 * unalign the siblings outside it, which is what the badge's position
 * actually depends on.
 *
 * Only the reserved width follows the tier, since stacked rows render the
 * short `#1042` label rather than `Run 1042`.
 */
export const RunIndicatorCell: React.FC<RunIndicatorCellProps> = ({
  runNav,
  workflowName,
  tier,
  onDrill,
}) => {
  const isStacked = tier !== "flat";
  const drill =
    runNav && isDrillableRunNav(runNav) && onDrill
      ? { label: runNavIndicatorLabel(runNav, isStacked), onDrill }
      : null;

  return (
    <span
      className="flex flex-shrink-0 justify-end"
      style={{
        width: WORKFLOW_ROW_TRACKS.runIndicator[isStacked ? "stacked" : "flat"],
      }}
    >
      {drill && (
        <button
          type="button"
          title={`Browse runs of ${workflowName}`}
          aria-label={`${drill.label} — browse runs of ${workflowName}`}
          onClick={(event) => {
            event.stopPropagation();
            drill.onDrill();
          }}
          className="fp-dropdown-row flex h-8 items-center gap-0.5 rounded px-1 py-0 text-xs leading-none text-description-fg hover:bg-list-hover-bg hover:text-foreground"
        >
          <span className="truncate">{drill.label}</span>
          <i className="codicon codicon-chevron-right block text-xxs leading-none" />
        </button>
      )}
    </span>
  );
};

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
 * Callers pass full-length text content at every tier — abbreviating `4 steps`
 * to `4` saves ~40px on a line that has already been given its own row. The
 * one exception is the state badge, which is both the widest fixed item and
 * the only one with a colour-carrying icon form: see {@link isCompactRow}.
 */
export const WorkflowRowLayout: React.FC<WorkflowRowLayoutProps> = ({
  tier,
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
  usage,
  time,
}) => {
  const isStacked = tier !== "flat";
  const visibleUsage = tier === "compact" ? undefined : usage;
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
        // both tier breakpoints are derived from these widths, so a track that
        // could be widened in the stylesheet alone would silently invalidate
        // them and collapse the name column.
        style={
          {
            "--workflow-row-state-col": `${WORKFLOW_ROW_TRACKS.state}px`,
            "--workflow-row-usage-col": `${WORKFLOW_ROW_TRACKS.usage}px`,
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
        {/* Same truncate-not-overflow treatment as the label column: fixed
            grid tracks don't clip their content by default, so long token/cost
            text (e.g. "≥11.2M · ≥$123.45") would otherwise bleed into the
            time column instead of respecting its own track width. */}
        <span className="col-start-6 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {visibleUsage}
        </span>
        <span className="col-start-7 truncate text-right text-xs text-description-fg">
          {time}
        </span>
      </button>
    );
  }

  // Absent metadata is omitted rather than reserved, so the second line never
  // shows a dangling separator for a lineage with no steps or no timestamp.
  const metaParts: Array<{ key: string; node: React.ReactNode }> = [];
  if (hasContent(count)) metaParts.push({ key: "count", node: count });
  if (hasContent(visibleUsage))
    metaParts.push({ key: "usage", node: visibleUsage });
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
              <span aria-hidden="true" className="font-normal opacity-50">
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
