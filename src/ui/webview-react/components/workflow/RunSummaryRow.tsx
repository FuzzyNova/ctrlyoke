import React, { useState } from "react";
import { HarnessIcon } from "../shared/HarnessIcon";
import { HARNESS_INFO, type HarnessId } from "../../types/messages";
import {
  getExecutionStateBadgeClass,
  getExecutionStateBadgeIcon,
} from "../../utils/status";
import { formatRelativeTimeVerbose } from "../../utils/time";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";

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
  isNarrow?: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}

/**
 * RunSummaryRow - one draft or run entry in RunPanel's virtualized list.
 *
 * Manifest values render directly — the run number is always
 * `summary.runId`, never a display index, so deletion gaps stay visible
 * (RUN_NAVIGATION_UX_PLAN.md's identity invariant).
 */
export const RunSummaryRow: React.FC<RunSummaryRowProps> = ({
  row,
  rowKey,
  isViewed,
  isPending,
  isLive,
  isNarrow = false,
  canDelete,
  onSelect,
  onDelete,
}) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isDraft = row.kind === "draft";
  const summary = row.kind === "run" ? row.summary : null;
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
  const narrowLabel = isDraft ? "Draft" : `#${summary!.runId}`;
  const accessibleName = [
    label,
    isLive ? "live" : undefined,
    executionState,
    harnessTitle,
    summary && summary.stepCount > 0
      ? `${summary.stepCount} step${summary.stepCount === 1 ? "" : "s"}`
      : undefined,
    timeAgo,
  ]
    .filter(Boolean)
    .join(" — ");

  return (
    <div
      data-scroll-key={rowKey}
      role="option"
      aria-selected={isViewed}
      title={accessibleName}
      className={`run-panel-row group flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
        isViewed
          ? "bg-list-active-bg text-list-active-fg font-semibold fp-dropdown-row-selected"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg fp-dropdown-row"
      } ${isPending && !isViewed ? "opacity-70" : ""}`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={accessibleName}
        className="run-panel-row-primary flex min-w-0 flex-1 items-center gap-2 appearance-none border-none bg-transparent p-0 text-left text-inherit cursor-pointer"
      >
        {/* Live/pending indicator */}
        <span className="flex w-2.5 flex-shrink-0 items-center justify-center">
          {isLive && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-indicator-success animate-pulse" />
          )}
          {!isLive && isPending && !isViewed && (
            <i className="codicon codicon-loading codicon-modifier-spin text-xxs text-description-fg" />
          )}
        </span>

        {/* Run number / Draft label */}
        <span className="w-14 flex-shrink-0 font-mono text-xs">
          {isNarrow ? narrowLabel : label}
        </span>

        {!isDraft && (
          <>
            {/* Harness icon */}
            {harness && (
              <span
                className="flex w-[14px] flex-shrink-0 items-center justify-center"
                title={harnessTitle}
              >
                <HarnessIcon harnessId={harness} size={14} />
              </span>
            )}

            {!isNarrow && (
              <>
                {/* State badge */}
                {executionState && (
                  <span
                    className={`flex-shrink-0 rounded px-1.5 py-px text-xs font-semibold uppercase ${getExecutionStateBadgeClass(executionState)}`}
                  >
                    {executionState}
                  </span>
                )}

                {/* Step count */}
                {summary && summary.stepCount > 0 && (
                  <span className="flex-shrink-0 font-mono text-xs text-description-fg">
                    {summary.stepCount} step
                    {summary.stepCount === 1 ? "" : "s"}
                  </span>
                )}
              </>
            )}

            {isNarrow && executionState && (
              <i
                className={`codicon ${getExecutionStateBadgeIcon(executionState)} flex-shrink-0 text-xs`}
              />
            )}

            {/* Spacer pushes time to the right */}
            <span className="min-w-[8px] flex-1" />

            {!isNarrow && timeAgo && (
              <span className="flex-shrink-0 text-xs text-description-fg">
                {timeAgo}
              </span>
            )}
          </>
        )}

        {isDraft && <span className="min-w-[8px] flex-1" />}
      </button>

      {canDelete && (
        <span className="flex flex-shrink-0 items-center">
          {confirmingDelete ? (
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
          )}
        </span>
      )}
    </div>
  );
};
