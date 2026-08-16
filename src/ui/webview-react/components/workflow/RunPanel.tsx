import React, { useEffect, useMemo, useRef, useState } from "react";
import { ExitButton } from "@components/shared";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import { VirtualizedDropdownList } from "../shared";
import { RunSummaryRow, type RunPanelRow } from "./RunSummaryRow";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import {
  WORKFLOW_DROPDOWN_ROW_HEIGHT_ESTIMATE,
  type WorkflowRowTier,
} from "../../constants";
import type {
  WorkflowKey,
  RunRef,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import type { WorkflowContextMenuTarget } from "@hooks/useWorkflowContextMenu";

/** Builds the stable list key for a run-panel row — draft or run:{workflowKey}:{runRef}. */
function runPanelRowKey(workflowKey: WorkflowKey, row: RunPanelRow): string {
  return row.kind === "draft"
    ? `draft:${workflowKey}`
    : `run:${workflowKey}:${row.summary.runRef}`;
}

function addressForRow(
  workflowKey: WorkflowKey,
  row: RunPanelRow
): WorkflowViewAddress {
  return row.kind === "draft"
    ? { workflowKey, kind: "draft" }
    : { workflowKey, kind: "run", runRef: row.summary.runRef };
}

interface RunPanelProps {
  workflowKey: WorkflowKey;
  workflowName: string;
  /** Draft (if any) first, then runs newest-first — already the manifest order. */
  rows: RunPanelRow[];
  isLoading: boolean;
  loadError?: string;
  tier?: WorkflowRowTier;
  /** The client's own currently displayed address, for the viewed-row highlight and newer/older. */
  displayedAddress: WorkflowViewAddress | null;
  /**
   * True while the client is showing a historical snapshot rather than live
   * output. Back-to-live (selecting the executing run's row) clears this and
   * resets `viewingRunIndex` but never touches `displayedAddress` itself, so
   * without this flag the live row's highlight would lag behind a manifest
   * address that's still the last-viewed historical run.
   */
  isViewingHistory: boolean;
  /** This lineage's executing run, if any — drives the live indicator and delete protection. */
  executionRunRef?: string | null;
  /** Favorite state from the drilled lineage's recent entry. */
  isFavorite?: boolean;
  /** Always the draft directory, even when the lineage's primary address is a run. */
  draftDirectory?: string;
  confirmDeleteOperations: boolean;
  onBack: () => void;
  onClose?: () => void;
  onSelectRow: (address: WorkflowViewAddress) => void;
  onOpenContextMenu?: (
    x: number,
    y: number,
    target: WorkflowContextMenuTarget
  ) => void;
  onDeleteRun: (runRef: RunRef) => void;
  onDeleteAllRuns: () => void;
  /** Row to scroll into view once (the viewed run, when opened via the badge). */
  scrollToKey?: string | null;
}

/**
 * RunPanel - drill-in view of one lineage's draft + run history, replacing
 * the workflow list inside the same dropdown (RUN_NAVIGATION_UX_PLAN.md).
 *
 * A flat, homogeneous, virtualized list with a pinned header (back, lineage
 * name, newer/older, close) — no accordion, no mixed-kind row model.
 */
export const RunPanel: React.FC<RunPanelProps> = ({
  workflowKey,
  workflowName,
  rows,
  isLoading,
  loadError,
  tier = "stacked",
  displayedAddress,
  isViewingHistory,
  executionRunRef,
  isFavorite,
  draftDirectory,
  confirmDeleteOperations,
  onBack,
  onClose,
  onSelectRow,
  onOpenContextMenu,
  onDeleteRun,
  onDeleteAllRuns,
  scrollToKey = null,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [pendingRowKey, setPendingRowKey] = useState<string | null>(null);

  const isDisplayedLineage = displayedAddress?.workflowKey === workflowKey;
  const isLiveRow = (row: RunPanelRow) =>
    row.kind === "run" &&
    executionRunRef != null &&
    row.summary.runRef === executionRunRef;
  // The live run counts as "viewed" once back-to-live clears isViewingHistory,
  // even though displayedAddress itself never changes on that path — see the
  // isViewingHistory prop doc above.
  const isRowViewed = (row: RunPanelRow) =>
    isDisplayedLineage &&
    (!isViewingHistory && executionRunRef != null
      ? isLiveRow(row)
      : areWorkflowAddressesEqual(
          addressForRow(workflowKey, row),
          displayedAddress
        ));

  const viewedIndex = useMemo(() => {
    if (!isDisplayedLineage) return -1;
    return rows.findIndex(isRowViewed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rows,
    workflowKey,
    displayedAddress,
    isDisplayedLineage,
    isViewingHistory,
    executionRunRef,
  ]);

  // A row selection clears once the request it started settles (success or
  // failure) — tracked by requestId identity rather than a timer so a slow
  // network doesn't clear the pending state early.
  useEffect(() => {
    setPendingRowKey(null);
  }, [displayedAddress]);

  useEffect(() => {
    setShowDeleteAllModal(false);
  }, [workflowKey]);

  const handleSelect = (row: RunPanelRow) => {
    if (isRowViewed(row)) {
      (onClose ?? onBack)();
      return;
    }
    setPendingRowKey(runPanelRowKey(workflowKey, row));
    onSelectRow(addressForRow(workflowKey, row));
  };

  const handleNavigateAdjacent = (direction: "newer" | "older") => {
    if (viewedIndex === -1) return;
    const targetIndex =
      direction === "newer" ? viewedIndex - 1 : viewedIndex + 1;
    const target = rows[targetIndex];
    if (!target) return;
    handleSelect(target);
  };

  const handleDeleteAllRuns = () => {
    if (confirmDeleteOperations) {
      setShowDeleteAllModal(true);
      return;
    }
    onDeleteAllRuns();
  };

  const handleConfirmDeleteAllRuns = () => {
    setShowDeleteAllModal(false);
    onDeleteAllRuns();
  };

  const canGoNewer = viewedIndex > 0;
  const canGoOlder = viewedIndex !== -1 && viewedIndex < rows.length - 1;
  const hasRuns = rows.some((row) => row.kind === "run");

  return (
    <div className="run-panel flex h-full flex-col">
      {/* Pinned header — outside the scroll container, like the workflow list's search header */}
      <div className="run-panel-header flex flex-shrink-0 items-center gap-1 border-b border-dropdown-border bg-editor-bg px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          title="Back to workflow list"
          aria-label="Back to workflow list"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-description-fg hover:bg-list-hover-bg hover:text-foreground"
        >
          <i className="codicon codicon-chevron-left text-sm" />
        </button>
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
          title={workflowName}
        >
          {workflowName}
        </span>
        <button
          type="button"
          onClick={() => handleNavigateAdjacent("newer")}
          disabled={!canGoNewer}
          title="Newer run"
          aria-label="Newer run"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-description-fg hover:bg-list-hover-bg hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <i className="codicon codicon-arrow-up text-sm" />
        </button>
        <button
          type="button"
          onClick={() => handleNavigateAdjacent("older")}
          disabled={!canGoOlder}
          title="Older run"
          aria-label="Older run"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-description-fg hover:bg-list-hover-bg hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <i className="codicon codicon-arrow-down text-sm" />
        </button>
        {onClose && (
          <ExitButton
            onClick={onClose}
            title="Close workflow menu"
            aria-label="Close workflow menu"
          />
        )}
      </div>

      {/* Run/draft list */}
      <div
        ref={scrollContainerRef}
        role="listbox"
        aria-label={`Runs for ${workflowName}`}
        className="run-panel-items min-h-0 flex-1 overflow-y-auto overflow-x-clip py-1"
      >
        {isLoading && rows.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-description-fg">
            <i className="codicon codicon-loading codicon-modifier-spin text-xs" />
            Loading runs…
          </div>
        ) : loadError ? (
          <div className="px-3 py-3 text-sm text-error-fg">{loadError}</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-3 text-sm text-description-fg">
            No runs yet.
          </div>
        ) : (
          <VirtualizedDropdownList
            items={rows}
            getItemKey={(row) => runPanelRowKey(workflowKey, row)}
            scrollContainerRef={scrollContainerRef}
            scrollToKey={scrollToKey}
            estimatedRowHeight={WORKFLOW_DROPDOWN_ROW_HEIGHT_ESTIMATE}
            renderItem={(row) => {
              const rowKey = runPanelRowKey(workflowKey, row);
              const isViewed = isRowViewed(row);
              const isLive = isLiveRow(row);
              return (
                <RunSummaryRow
                  row={row}
                  rowKey={rowKey}
                  isViewed={isViewed}
                  isPending={pendingRowKey === rowKey}
                  isLive={isLive}
                  tier={tier}
                  canDelete={row.kind === "run" && !isLive}
                  contextMenuAddress={addressForRow(workflowKey, row)}
                  workflowName={workflowName}
                  isFavorite={isFavorite}
                  draftDirectory={draftDirectory}
                  onOpenContextMenu={onOpenContextMenu}
                  onSelect={() => handleSelect(row)}
                  onDelete={
                    row.kind === "run"
                      ? () => onDeleteRun(row.summary.runRef)
                      : undefined
                  }
                />
              );
            }}
          />
        )}
      </div>

      {hasRuns && (
        <div className="run-panel-footer flex-shrink-0 border-t border-dropdown-border bg-editor-bg p-1">
          <button
            type="button"
            onClick={handleDeleteAllRuns}
            className="fp-dropdown-row w-full cursor-pointer rounded border-none bg-transparent px-3 py-1.5 text-center text-xs text-link-fg transition-colors hover:bg-list-hover-bg"
          >
            Delete all runs
          </button>
        </div>
      )}

      <DeleteConfirmModal
        isOpen={showDeleteAllModal}
        onCancel={() => setShowDeleteAllModal(false)}
        onConfirm={handleConfirmDeleteAllRuns}
        title="Delete All Runs"
        message={`Delete all runs for "${workflowName}"?`}
        detail="This will permanently delete all run history for this workflow. This action cannot be undone."
      />
    </div>
  );
};
