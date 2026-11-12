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
   * with two lines of metadata beneath; `compact` additionally drops the state badge to
   * its icon-only form. Driven by the *dropdown's* width, not the trigger's
   * — see `resolveWorkflowRowTier`.
   */
  tier: WorkflowRowTier;
  onClick: () => void;
  ariaLabel?: string;
  className?: string;
  /** First line, left — harness icon beside the name; the metadata lines indent under it. */
  harness?: React.ReactNode;
  harnessTitle?: string;
  /** First line — workflow name or run identity. Truncates. */
  label: React.ReactNode;
  labelClassName?: string;
  /** Second line, first item — step count or step progress. */
  count?: React.ReactNode;
  /** Second line, trailing glyph — 16px status icon (terminal session, live run). */
  glyph?: React.ReactNode;
  /** Resolved worktree identity, rendered beside the terminal/status glyph. */
  worktree?: Pick<WorktreeRunProjection, "branchName" | "worktreePath">;
  /** First line, right — execution state badge. */
  badge?: React.ReactNode;
  /** Third line, first item — run-total token usage and cost. */
  usage?: React.ReactNode;
  /** Third line — run time (`RunDuration`), settled or ticking. */
  duration?: React.ReactNode;
  /** Second line — relative time since the row's last activity. */
  time?: React.ReactNode;
  /**
   * Small fixed-content pill in the meta line (e.g. an external-owner badge).
   * Lives here rather than in the trailing action rail because that rail is a
   * reserved-width sibling shared by every row — content-sizing it for one
   * row kind shifts the primary button's width for that row alone, sitting
   * its state badge out of line with its neighbours (see
   * `webview-react-components.instructions.md`). The meta line has no such
   * constraint: it already truncates its own content. `shrink-0` keeps
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
 * RunIndicatorCell - the `#12 ›` drill affordance, a direct child of the row
 * container (never nested inside the primary button), placed on the first
 * line just left of the state badge it describes.
 *
 * The track is fixed-width and reserved list-wide whenever *any* row is
 * drillable, including across the running/recent split: it is what positions
 * the name's right edge, so a row that dropped the track would truncate its
 * name at a different point from its neighbours'.
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
      className="workflow-row-run-nav flex shrink-0 justify-end"
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
          className="cy-dropdown-row flex h-5 items-center gap-0.5 rounded-sm px-1 py-0 text-xs leading-none text-description-fg hover:bg-list-hover-bg hover:text-foreground"
        >
          <span className="truncate">{drill.label}</span>
          <Icon name="chevron-right" className="block text-xxs leading-none" />
        </button>
      )}
    </span>
  );
};

/**
 * RowActionRail - the fixed-width action cluster every row kind ends with
 * (favourite/remove, pause/stop, delete-run).
 *
 * Fixed rather than content-sized for the same reason as the run-indicator
 * track: it shares the metadata lines, so any difference in its width moves
 * where that row's metadata truncates relative to its neighbours.
 */
export const RowActionRail: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => (
  <span
    className="flex shrink-0 items-center justify-end gap-1"
    style={{ width: WORKFLOW_ROW_TRACKS.actions }}
  >
    {children}
  </span>
);

/**
 * Shape of every icon button in a {@link RowActionRail}. One fixed 24px box
 * for all row kinds, so a running row's pause/stop sit exactly over a recent
 * row's favourite/remove in the region beneath. The rail spans both metadata
 * lines, which is what pays for the larger hit target.
 */
export const ROW_ACTION_BUTTON_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-sm px-0 py-0 leading-none";

/**
 * Class every workflow dropdown row container carries. The container — not
 * the primary button — owns the row grid, because the trailing controls are
 * the button's siblings (see `.workflow-row` in `globals.css`).
 */
export const WORKFLOW_ROW_CONTAINER_CLASS = "workflow-row";

/**
 * Marks a compact-tier primary button. There the action rail reaches into the
 * run-nav column beside the icon-only badge, so the metadata lines must stop
 * short of it (see `.workflow-row` in `globals.css`).
 */
const WORKFLOW_ROW_PRIMARY_COMPACT_CLASS = "workflow-row-primary-compact";

/**
 * WorkflowRowTrailing - the action rail's slot at the right of a row's two
 * metadata lines, vertically centred across both.
 *
 * Kept off the first line on purpose: there, the controls ate into the name's
 * width on a narrow dropdown. The run indicator is the one control that does
 * sit on the first line ({@link RunIndicatorCell}) — it is navigation that
 * reads with the state badge beside it, and keeping it there leaves the
 * delete button well away from it.
 */
export const WorkflowRowTrailing: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => (
  <span className="workflow-row-trailing flex items-center">{children}</span>
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
 * supplies the same set of content pieces and this lays them out identically
 * on three lines — name and state badge; step count, time ago and status
 * glyphs; then usage and run time. The caller's row container carries
 * {@link WORKFLOW_ROW_CONTAINER_CLASS}, may hold a {@link RunIndicatorCell}
 * (first line, before the badge), and ends with a {@link WorkflowRowTrailing},
 * which sits at the right of the two metadata lines.
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
  duration,
  time,
  metaBadge,
}) => {
  const buttonClassName = `workflow-row-primary ${isCompactRow(tier) ? WORKFLOW_ROW_PRIMARY_COMPACT_CLASS : ""} min-w-0 appearance-none overflow-hidden border-none bg-transparent p-0 text-left text-inherit cursor-pointer ${className}`;

  // Second line: what and when. Third line: what it cost and how long it ran.
  // Splitting them gives each part room to show in full on a narrow dropdown,
  // where one shared line ellipsized every part at once.
  const activityParts = metaPartsOf([
    ["count", count],
    ["time", time],
  ]);
  const usageParts = metaPartsOf([
    ["usage", usage],
    ["duration", duration],
  ]);
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
      {/* A full-text badge reserves the widest state's width, so the badge
          column — and the run indicator left of it — line up down the list
          whatever each row's state. */}
      <span
        className="workflow-row-cell-badge flex justify-end justify-self-end"
        style={
          isCompactRow(tier)
            ? undefined
            : { minWidth: WORKFLOW_ROW_TRACKS.state }
        }
      >
        {badge}
      </span>
      <MetaLine
        className="workflow-row-cell-meta-activity"
        parts={activityParts}
      >
        {hasContent(metaBadge) && <span className="shrink-0">{metaBadge}</span>}
        {hasContent(glyph) && (
          <span className="flex w-4 shrink-0 items-center justify-center">
            {glyph}
          </span>
        )}
        {worktree && (
          <span className="flex w-4 shrink-0 items-center justify-center">
            <Icon
              name="worktree-compact"
              title={worktreeTitle}
              aria-label={worktreeTitle}
            />
          </span>
        )}
      </MetaLine>
      <MetaLine className="workflow-row-cell-meta-usage" parts={usageParts} />
    </button>
  );
};

interface MetaPart {
  key: string;
  node: React.ReactNode;
}

/**
 * Drops absent metadata rather than reserving it, so a line never shows a
 * dangling separator for a lineage with no steps or no timestamp.
 */
function metaPartsOf(
  entries: ReadonlyArray<readonly [string, React.ReactNode]>
): MetaPart[] {
  return entries
    .filter(([, node]) => hasContent(node))
    .map(([key, node]) => ({ key, node }));
}

/**
 * One muted metadata line: its parts joined by `·`, then any fixed-width
 * trailing pieces. The line is always rendered, even empty, so every row has
 * the same height and the action rail centres on the same two lines.
 */
const MetaLine: React.FC<{
  className: string;
  parts: MetaPart[];
  children?: React.ReactNode;
}> = ({ className, parts, children }) => (
  <span
    className={`workflow-row-cell-meta ${className} flex min-w-0 items-center gap-1 overflow-hidden text-xs text-description-fg`}
  >
    {parts.map((part, index) => (
      <React.Fragment key={part.key}>
        {index > 0 && (
          <span aria-hidden="true" className="font-normal opacity-50">
            ·
          </span>
        )}
        <span className="truncate">{part.node}</span>
      </React.Fragment>
    ))}
    {children}
  </span>
);
