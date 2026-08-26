import React, { useState } from "react";
import { HarnessIcon } from "../shared/HarnessIcon";
import { ExecutionStateBadge } from "../shared/ExecutionStateBadge";
import {
  WorkflowRowLayout,
  RowActionRail,
  composeRowAccessibleName,
  isCompactRow,
} from "./WorkflowRowLayout";
import {
  WorkflowTokenUsage,
  hasWorkflowTokenUsage,
  workflowTokenTotalsAccessibleLabel,
} from "./WorkflowTokenUsage";
import type { WorkflowRowTier } from "../../constants";
import { HARNESS_INFO, type HarnessId } from "../../types/messages";
import { formatRelativeTimeVerbose } from "../../utils/time";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import type { WorkflowContextMenuTarget } from "@hooks/useWorkflowContextMenu";
import { getContextMenuOpener, useLongPress } from "@hooks/useLongPress";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

/** One row of the run panel's flat draft+run list. */
export type RunPanelRow =
  | { kind: "draft" }
  | { kind: "run"; summary: RunSummary };

interface RunSummaryRowProps {
  row: RunPanelRow;
  /** Stable key for `data-scroll-key` — matches VirtualizedDropdownList's `scrollToKey`. */
  rowKey: string;
  /** This row is the address the client currently has loaded/displayed. */
  isViewed: boolean;
  /** A LOAD_RUN_VIEW targeting this row is in flight but hasn't landed yet. */
  isPending: boolean;
  /** This run is the lineage's currently executing run. */
  isLive: boolean;
  tier?: WorkflowRowTier;
  canDelete: boolean;
  /** Address resolved by RunPanel's shared addressForRow helper. */
  contextMenuAddress?: WorkflowViewAddress;
  workflowName?: string;
  isFavorite?: boolean;
  draftDirectory?: string;
  onOpenContextMenu?: (
    x: number,
    y: number,
    target: WorkflowContextMenuTarget,
    opener?: HTMLElement | null
  ) => void;
  onSelect: () => void;
  onDelete?: () => void;
}

/**
 * RunSummaryRow - one draft or run entry in RunPanel's virtualized list.
 *
 * Shares `WorkflowRowLayout` with the workflow list's rows — harness icon,
 * label, step count, status glyph, state badge, time — so drilling in doesn't
 * reshuffle where each piece of metadata lives, and both surfaces stack onto
 * two lines at the same width. The lineage name's slot carries the run
 * identity, and the live/pending glyph takes the terminal icon's track.
 *
 * Manifest values render directly — the run number is always `summary.runId`,
 * never a display index, so deletion gaps stay visible
 * (RUN_NAVIGATION_UX_PLAN.md's identity invariant).
 */
export const RunSummaryRow: React.FC<RunSummaryRowProps> = ({
  row,
  rowKey,
  isViewed,
  isPending,
  isLive,
  tier = "stacked",
  canDelete,
  contextMenuAddress,
  workflowName,
  isFavorite,
  draftDirectory,
  onOpenContextMenu,
  onSelect,
  onDelete,
}) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isDraft = row.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT;
  const summary =
    row.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN ? row.summary : null;
  const executionState = summary?.executionState;
  const timeAgo = summary
    ? formatRelativeTimeVerbose(summary.completedAt ?? summary.startedAt)
    : undefined;
  const harness = summary?.primaryHarness as HarnessId | undefined;
  const harnessLabel = harness
    ? (HARNESS_INFO[harness]?.name ?? harness)
    : undefined;
  const harnessTitle = summary?.hasMixedHarnesses
    ? `Mixed harnesses (primary: ${harnessLabel ?? "unknown"})`
    : harnessLabel;

  const label = isDraft ? "Draft" : `Run ${summary!.runId}`;
  const stepCount = summary?.stepCount ?? 0;
  const stepLabel =
    stepCount > 0
      ? `${stepCount} step${stepCount === 1 ? "" : "s"}`
      : undefined;
  const accessibleName = composeRowAccessibleName([
    label,
    isLive && "live",
    executionState,
    harnessTitle,
    stepLabel,
    workflowTokenTotalsAccessibleLabel(summary?.tokenTotals),
    timeAgo,
  ]);
  const openContextMenu = (
    x: number,
    y: number,
    opener: HTMLElement | null = null
  ) => {
    if (!contextMenuAddress) return;
    onOpenContextMenu?.(
      x,
      y,
      {
        address: contextMenuAddress,
        workflowName: workflowName ?? label,
        scope: "run",
        isFavorite,
        runDirectory:
          row.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
            ? summary?.runDirectory
            : draftDirectory,
        isExecuting: isLive,
      },
      opener
    );
  };
  const longPressHandlers = useLongPress(
    onOpenContextMenu && contextMenuAddress ? openContextMenu : undefined
  );

  return (
    /* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the row container owns right-click/long-press gestures; its nested WorkflowRowLayout button remains the focusable action */
    <div
      {...longPressHandlers}
      onContextMenu={(event) => {
        event.preventDefault();
        openContextMenu(
          event.clientX,
          event.clientY,
          getContextMenuOpener(event.currentTarget, event.target)
        );
      }}
      data-scroll-key={rowKey}
      role="option"
      aria-selected={isViewed}
      title={accessibleName}
      className={`run-panel-row group flex items-center gap-2 px-2 py-2 text-sm transition-colors ${
        isViewed
          ? "bg-list-active-bg text-list-active-fg font-semibold fp-dropdown-row-selected"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg fp-dropdown-row"
      } ${isPending && !isViewed ? "opacity-70" : ""}`}
    >
      <WorkflowRowLayout
        tier={tier}
        onClick={onSelect}
        ariaLabel={accessibleName}
        harness={harness && <HarnessIcon harnessId={harness} size={14} />}
        harnessTitle={harnessTitle}
        label={label}
        labelClassName="font-mono"
        count={stepCount > 0 ? stepLabel : undefined}
        worktree={summary?.worktree}
        glyph={
          isLive ? (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-indicator-success animate-pulse"
              title="Executing now"
              aria-label="Executing now"
            />
          ) : isPending && !isViewed ? (
            <i className="codicon codicon-loading codicon-modifier-spin text-xxs text-description-fg" />
          ) : undefined
        }
        badge={
          executionState && (
            <ExecutionStateBadge
              state={executionState}
              isNarrow={isCompactRow(tier)}
            />
          )
        }
        usage={
          hasWorkflowTokenUsage(summary?.tokenTotals) ? (
            <WorkflowTokenUsage totals={summary?.tokenTotals} />
          ) : undefined
        }
        time={timeAgo}
      />

      {/* Delete track is reserved on every row (draft and executing runs can't
          be deleted) so the time column stays aligned down the list. */}
      <RowActionRail>
        {canDelete &&
          (confirmingDelete ? (
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                title="Confirm delete run"
                aria-label={`Confirm delete ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingDelete(false);
                  onDelete?.();
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-terminal-ansiRed hover:bg-list-hover-bg"
              >
                <i className="codicon codicon-check text-xs" />
              </button>
              <button
                type="button"
                title="Cancel"
                aria-label="Cancel delete run"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingDelete(false);
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-description-fg hover:bg-list-hover-bg"
              >
                <i className="codicon codicon-close text-xs" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              title="Delete run"
              aria-label={`Delete ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(true);
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-description-fg opacity-0 transition-opacity group-hover:opacity-100 hover:bg-list-hover-bg hover:text-terminal-ansiRed focus-visible:opacity-100"
            >
              <i className="codicon codicon-trash text-xs" />
            </button>
          ))}
      </RowActionRail>
    </div>
  );
};
