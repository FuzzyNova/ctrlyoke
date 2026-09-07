import React, { useCallback } from "react";
import { PARALLEL_GROUP_HEADER_LABELS } from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { workflowViewAddressKey } from "@utils/viewAddress";
import {
  parallelGroupHeaderSummaryText,
  parallelGroupHeaderTitle,
  type ParallelGroupHeaderRow,
} from "@utils/outputRows";

const SHELL_WORKFLOW_ID = "_shell";

const CHIP_CLASS = "rounded border px-1.5 py-0.5";
const CHIP_PRESSED_CLASS = "border-focus-border text-foreground";
const CHIP_IDLE_CLASS = "border-panel-border text-description-fg";

function chipClass(pressed: boolean): string {
  return `${CHIP_CLASS} ${pressed ? CHIP_PRESSED_CLASS : CHIP_IDLE_CLASS}`;
}

export interface ParallelGroupHeaderRowViewProps {
  row: ParallelGroupHeaderRow;
  onUndo?: (row: ParallelGroupHeaderRow) => void;
}

/**
 * Opens a parallel group's section of the output stream: member counts plus the
 * All/per-member filter chips.
 *
 * Presentational apart from the filter writes, which go straight to `uiStore`
 * exactly as `StepHiddenRowView`'s "show" button does — that keeps `OutputPane`
 * a generic row renderer. Counts, chip pressed-states, and the group-undo
 * affordance are all resolved by `buildOutputRows`, so the header's height can
 * be estimated from the same row object the virtualizer sizes.
 */
export const ParallelGroupHeaderRowView: React.FC<
  ParallelGroupHeaderRowViewProps
> = ({ row, onUndo }) => {
  const displayedViewAddress = useUiStore(
    (state) => state.displayedViewAddress
  );
  const soloOutputTarget = useUiStore((state) => state.soloOutputTarget);
  const clearHiddenOutputTargets = useUiStore(
    (state) => state.clearHiddenOutputTargets
  );
  const workflowKey = displayedViewAddress
    ? workflowViewAddressKey(displayedViewAddress)
    : SHELL_WORKFLOW_ID;

  const handleShowAll = useCallback(
    () => clearHiddenOutputTargets(workflowKey),
    [clearHiddenOutputTargets, workflowKey]
  );
  const handleSolo = useCallback(
    (targetKey: string) =>
      soloOutputTarget(
        workflowKey,
        targetKey,
        row.members.map((member) => member.targetKey)
      ),
    [row.members, soloOutputTarget, workflowKey]
  );

  return (
    <div className="mx-2 mb-1 rounded border border-panel-border bg-sidebar-bg px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-foreground">
          {parallelGroupHeaderTitle(row)}
        </span>
        <span className="text-description-fg">
          {parallelGroupHeaderSummaryText(row)}
        </span>
        {row.promptUndo?.undo && onUndo && (
          <button
            type="button"
            className="ml-auto text-link-fg hover:text-link-active-fg"
            onClick={() => onUndo(row)}
          >
            {PARALLEL_GROUP_HEADER_LABELS.UNDO}
          </button>
        )}
      </div>
      <div
        className="mt-1 flex flex-wrap gap-1"
        role="group"
        aria-label={PARALLEL_GROUP_HEADER_LABELS.FILTERS}
      >
        <button
          type="button"
          className={chipClass(row.isAllVisible)}
          onClick={handleShowAll}
          aria-pressed={row.isAllVisible}
        >
          {PARALLEL_GROUP_HEADER_LABELS.ALL_CHIP}
        </button>
        {row.members.map((member) => (
          <button
            key={member.targetKey}
            type="button"
            className={chipClass(member.isSoloed)}
            onClick={() => handleSolo(member.targetKey)}
            aria-pressed={member.isSoloed}
          >
            {member.stepIndex + 1} {member.label}
          </button>
        ))}
      </div>
    </div>
  );
};
