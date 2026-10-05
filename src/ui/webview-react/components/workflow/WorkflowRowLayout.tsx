import React from "react";
import { WORKFLOW_ROW_TIERS } from "@root/types/DashboardConstants";
import { WORKFLOW_ROW_TRACKS, type WorkflowRowTier } from "../../constants";
import { runNavIndicatorLabel, isDrillableRunNav } from "@utils/runNavigation";
import type { WorkflowRunNavigationSummary } from "@root/types/CtrlYokeTypes";
import type { WorktreeRunProjection } from "@root/types/CtrlYokeTypes";
import { Icon } from "../shared/Icon";

/**
 * Whether this tier renders the *content* of a row compactly — today the
 * state badge's icon-only form.
 *
 * Every row kind asks this rather than comparing tiers itself, so "which tier
 * abbreviates" stays a single decision.
 */
export function isCompactRow(tier: WorkflowRowTier): boolean {
  return tier === WORKFLOW_ROW_TIERS.COMPACT;
}

interface WorkflowRowLayoutProps {
  /**
   * How much this row compacts. Every tier puts the label on its own line
   * with metadata beneath; `compact` additionally drops the state badge to
   * its icon-only form. Driven by the *dropdown's* width, not the trigger's
   * — see `resolveWorkflowRowTier`.
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
  /** Resolved worktree identity, rendered beside the terminal/status glyph. */
  worktree?: Pick<WorktreeRunProjection, "branchName" | "worktreePath">;
  /** Column 5 / first line, right — execution state badge. */
  badge?: React.ReactNode;
  /** Column 6 / run-total usage; joins stacked metadata. */
  usage?: React.ReactNode;
  /** Column 7 / last meta item — relative time or elapsed timer. */
  time?: React.ReactNode;
  /**
   * Small fixed-content pill in the meta line (e.g. an external-owner badge).
   * Lives here rather than in the trailing action rail because that rail is a
   * reserved-width sibling shared by every row — content-sizing it for one
   * row kind shifts the primary button's width for that row alone, sitting
   * its state badge out of line with its neighbours (see
   * `webview-react-components.instructions.md`). The meta line has no such
   * constraint: it already truncates its own content. `flex-shrink-0` keeps
   * the badge itself intact while the truncatable meta parts give way first.
   */
  metaBadge?: React.ReactNode;
}

function hasContent(node: React.ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

interface RunIndicatorCellProps {
  runNav: WorkflowRunNavigationSummary | undefined;
  workflowName: string;
  /** Omitted when the lineage can't be drilled into; the track is still reserved. */
  onDrill?: () => void;
}

/**
 * RunIndicatorCell - the `#12 ›` drill affordance, a sibling of the row's
 * primary button (never nested inside it).
 *
 * The track is fixed-width and reserved list-wide whenever *any* row is
 * drillable, including across the running/recent split: everything to its
 * right is what positions the state badge, so a row that dropped the track
 * sits its badge tens of pixels out of line with its neighbours.
 */
export const RunIndicatorCell: React.FC<RunIndicatorCellProps> = ({
  runNav,
  workflowName,
  onDrill,
}) => {
  const drill =
    runNav && isDrillableRunNav(runNav) && onDrill
      ? { label: runNavIndicatorLabel(runNav, true), onDrill }
      : null;

  return (
    <span
      className="flex flex-shrink-0 justify-end"
      style={{ width: WORKFLOW_ROW_TRACKS.runIndicator }}
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
          className="cy-dropdown-row flex h-8 items-center gap-0.5 rounded px-1 py-0 text-xs leading-none text-description-fg hover:bg-list-hover-bg hover:text-foreground"
        >
          <span className="truncate">{drill.label}</span>
          <Icon name="chevron-right" className="block text-xxs leading-none" />
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
 * Every row kind passes an explicit label rather than letting the name fall
 * out of concatenated cell text: the stacked and compact tiers render the
 * same information in a different DOM order, and an accessible name that
 * changes with the dropdown's width is a bug even when both readings are
 * sensible. Omit values that tick (an elapsed timer re-announces on every
 * update).
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
 * Owning it here is what keeps the three row kinds from drifting: each caller
 * supplies the same set of content pieces and this lays them out identically,
 * name on its own line with metadata beneath.
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
  worktree,
  badge,
  usage,
  time,
  metaBadge,
}) => {
  const visibleUsage = tier === WORKFLOW_ROW_TIERS.COMPACT ? undefined : usage;
  const buttonClassName = `workflow-row-primary workflow-row-primary-stacked min-w-0 flex-1 appearance-none overflow-hidden border-none bg-transparent p-0 text-left text-inherit cursor-pointer ${className}`;

  // Absent metadata is omitted rather than reserved, so the second line never
  // shows a dangling separator for a lineage with no steps or no timestamp.
  const metaParts: Array<{ key: string; node: React.ReactNode }> = [];
  if (hasContent(count)) metaParts.push({ key: "count", node: count });
  if (hasContent(visibleUsage))
    metaParts.push({ key: "usage", node: visibleUsage });
  if (hasContent(time)) metaParts.push({ key: "time", node: time });
  const worktreeTitle = worktree
    ? `Branch: ${worktree.branchName}\nWorktree: ${worktree.worktreePath}`
    : undefined;
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
        {hasContent(metaBadge) && (
          <span className="flex-shrink-0">{metaBadge}</span>
        )}
        {hasContent(glyph) && (
          <span className="flex w-4 flex-shrink-0 items-center justify-center">
            {glyph}
          </span>
        )}
        {worktree && (
          <span className="flex w-4 flex-shrink-0 items-center justify-center">
            <Icon
              name="worktree-compact"
              title={worktreeTitle}
              aria-label={worktreeTitle}
            />
          </span>
        )}
      </span>
    </button>
  );
};
