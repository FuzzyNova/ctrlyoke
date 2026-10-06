import React, { useCallback } from "react";
import { PARALLEL_GROUP_HEADER_LABELS } from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { workflowViewAddressKey } from "@utils/viewAddress";
import {
  parallelGroupActionTooltip,
  parallelGroupHeaderSummaryText,
  parallelGroupHeaderTitle,
  type ParallelGroupHeaderRow,
} from "@utils/outputRows";
import { Icon } from "../shared/Icon";

const SHELL_WORKFLOW_ID = "_shell";

const ACTION_CLASS =
  "inline-flex min-w-0 max-w-full items-center gap-1 transition-colors";

const CHIP_CLASS = "rounded-sm border px-1.5 py-0.5";
const CHIP_PRESSED_CLASS = "border-focus-border text-foreground";
const CHIP_IDLE_CLASS = "border-panel-border text-description-fg";

function chipClass(pressed: boolean): string {
  return `${CHIP_CLASS} ${pressed ? CHIP_PRESSED_CLASS : CHIP_IDLE_CLASS}`;
}

export interface ParallelGroupHeaderRowViewProps {
  row: ParallelGroupHeaderRow;
  onView?: (row: ParallelGroupHeaderRow) => void;
}

/**
 * Opens a parallel group's section of the output stream: member counts plus the
 * All/per-member filter chips.
 *
 * Presentational apart from the filter writes, which go straight to `uiStore`
 * exactly as `StepHiddenRowView`'s "show" button does — that keeps `OutputPane`
 * a generic row renderer. Counts, chip pressed-states, and the group's change
 * summary are all resolved by `buildOutputRows`, so the header's
 * height can be estimated from the same row object the virtualizer sizes.
 *
 * The group owns that viewer entry outright — its members share one workspace
 * snapshot, so no member's own CLI header offers a second copy of the same
 * action. Only its tooltip names the group.
 */
export const ParallelGroupHeaderRowView: React.FC<
  ParallelGroupHeaderRowViewProps
> = ({ row, onView }) => {
  const promptUndoSummary = row.promptUndo?.summary;
  const displayedViewAddress = useUiStore(
    (state) => state.displayedViewAddress
  );
  const soloOutputTargets = useUiStore((state) => state.soloOutputTargets);
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
      soloOutputTargets(
        workflowKey,
        [targetKey],
        row.members.map((member) => member.targetKey)
      ),
    [row.members, soloOutputTargets, workflowKey]
  );

  return (
    <div className="mx-2 mb-1 rounded-sm border border-panel-border bg-sidebar-bg px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-foreground">
          {parallelGroupHeaderTitle(row)}
        </span>
        <span className="text-description-fg">
          {parallelGroupHeaderSummaryText(row)}
        </span>
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {promptUndoSummary && promptUndoSummary.total > 0 && onView && (
            <button
              type="button"
              className={`${ACTION_CLASS} text-link-fg hover:text-link-active-fg`}
              style={{ touchAction: "manipulation" }}
              title={parallelGroupActionTooltip(
                promptUndoSummary.title,
                row.members.length
              )}
              aria-label={promptUndoSummary.label}
              onClick={() => onView(row)}
            >
              <Icon name="diff" className="shrink-0" />
              <span className="min-w-0 truncate">
                {promptUndoSummary.label}
              </span>
            </button>
          )}
        </div>
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
