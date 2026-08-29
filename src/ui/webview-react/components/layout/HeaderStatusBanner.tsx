import React from "react";
import type {
  WorkflowKey,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";
import { useActiveWorkflowExternalOwner } from "@hooks/useActiveWorkflowExternalOwner";
import { useIsSystemGeneratedWorkflow } from "@hooks/useIsSystemGeneratedWorkflow";
import { getExternalReadOnlyLabel } from "@utils/externalRunner";
import { useUiStore } from "@store/uiStore";

export interface HeaderStatusBannerProps {
  isPausing: boolean;
  handleCancelPause: () => void;
  isViewingDeletedWorkflow: boolean;
  viewingDeletedWorkflow: {
    workflowKey: WorkflowKey;
    workflowName: string;
  } | null;
  handleCloseDeletedWorkflow: () => void;
  pendingRewind: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  } | null;
  displayedViewAddress: WorkflowViewAddress | null;
  handleDiscardContinuation: () => void;
}

export const HeaderStatusBanner: React.FC<HeaderStatusBannerProps> = (
  props
) => {
  const externalOwner = useActiveWorkflowExternalOwner();
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const setGlobalSettingsTab = useUiStore((s) => s.setGlobalSettingsTab);
  const toggleGlobalSettings = useUiStore((s) => s.toggleGlobalSettings);
  const globalSettingsOpen = useUiStore((s) => s.globalSettingsOpen);
  const externalReadOnlyLabel = getExternalReadOnlyLabel(externalOwner);
  const isSystemGeneratedLocked =
    externalReadOnlyLabel === undefined && isSystemGeneratedWorkflow;
  const lockedLabel =
    externalReadOnlyLabel ??
    (isSystemGeneratedWorkflow
      ? "Read-only — managed automatically by commit message generation"
      : undefined);
  const isLocked = lockedLabel !== undefined;
  const openCommitSettings = () => {
    setGlobalSettingsTab("commit");
    if (!globalSettingsOpen) {
      toggleGlobalSettings();
    }
  };

  return (
    <>
      {props.isViewingDeletedWorkflow && props.viewingDeletedWorkflow && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--status-error)] text-white border-b border-btn-border"
          role="status"
          aria-label={`Workflow "${props.viewingDeletedWorkflow.workflowName}" has been deleted`}
        >
          <i className="codicon codicon-trash" aria-hidden="true" />
          <span>
            &quot;{props.viewingDeletedWorkflow.workflowName}&quot; has been
            deleted
          </span>
          <button
            className="ml-auto text-xs underline opacity-90 hover:opacity-100"
            onClick={props.handleCloseDeletedWorkflow}
            title="Start a new workflow and drop this cached view"
            aria-label="Close deleted workflow"
          >
            Close
          </button>
        </div>
      )}
      {!props.isViewingDeletedWorkflow && isLocked && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--status-error)] text-white border-b border-btn-border"
          role="status"
          aria-label={lockedLabel}
        >
          <i className="codicon codicon-lock" aria-hidden="true" />
          <span>
            {lockedLabel}
            {isSystemGeneratedLocked && (
              <>
                .{" "}
                <button
                  type="button"
                  className="underline opacity-90 hover:opacity-100"
                  onClick={openCommitSettings}
                >
                  Edit in settings
                </button>
              </>
            )}
          </span>
        </div>
      )}
      {!props.isViewingDeletedWorkflow && !isLocked && props.isPausing && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--status-warning)] text-black border-b border-btn-border">
          <i className="codicon codicon-debug-pause animate-pulse-cancelling" />
          <span>Workflow will pause after the current step completes</span>
          <button
            className="ml-auto text-xs underline opacity-80 hover:opacity-100"
            onClick={props.handleCancelPause}
            aria-label="Cancel pause"
          >
            Cancel
          </button>
        </div>
      )}
      {!props.isViewingDeletedWorkflow &&
        !isLocked &&
        props.pendingRewind &&
        props.displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN && (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs bg-status-warning text-btn-fg border-b border-btn-border"
            role="status"
            aria-label={`Continuing run from step ${props.pendingRewind.fromStepIndex + 1}`}
          >
            <i className="codicon codicon-debug-continue" aria-hidden="true" />
            <span>
              Continuing run from step {props.pendingRewind.fromStepIndex + 1}
            </span>
            <span
              className="inline-flex items-center gap-1 opacity-90 cursor-help"
              title="Continuing crosses an undo-stack boundary — you won't be able to undo once you continue. All output history is preserved, but the working file's captured state for any re-run prompts will be overwritten."
            >
              <i className="codicon codicon-info" aria-hidden="true" />
              Can&apos;t be undone after continuing
            </span>
            <div className="ml-auto flex items-center gap-3">
              <button
                className="text-xs underline opacity-90 hover:opacity-100 focus-visible:outline focus-visible:outline-1"
                onClick={props.handleDiscardContinuation}
              >
                Discard Continuation
              </button>
            </div>
          </div>
        )}
    </>
  );
};
