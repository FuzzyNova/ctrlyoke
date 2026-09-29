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
import { StatusBanner, STATUS_BANNER_TONES } from "../shared/StatusBanner";
import { Icon } from "../shared/Icon";

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
        <StatusBanner
          tone={STATUS_BANNER_TONES.ERROR}
          icon="trash"
          aria-label={`Workflow "${props.viewingDeletedWorkflow.workflowName}" has been deleted`}
          action={
            <button
              className="text-xs underline opacity-90 hover:opacity-100"
              onClick={props.handleCloseDeletedWorkflow}
              title="Start a new workflow and drop this cached view"
              aria-label="Close deleted workflow"
            >
              Close
            </button>
          }
        >
          &quot;{props.viewingDeletedWorkflow.workflowName}&quot; has been deleted
        </StatusBanner>
      )}
      {!props.isViewingDeletedWorkflow && isLocked && (
        <StatusBanner
          tone={STATUS_BANNER_TONES.ERROR}
          icon="lock"
          aria-label={lockedLabel}
        >
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
        </StatusBanner>
      )}
      {!props.isViewingDeletedWorkflow && !isLocked && props.isPausing && (
        <StatusBanner
          tone={STATUS_BANNER_TONES.WARNING}
          icon="debug-pause"
          iconClassName="animate-pulse-cancelling"
          aria-label="Workflow will pause after the current step completes"
          action={
            <button
              className="text-xs underline opacity-80 hover:opacity-100"
              onClick={props.handleCancelPause}
              aria-label="Cancel pause"
            >
              Cancel
            </button>
          }
        >
          Workflow will pause after the current step completes
        </StatusBanner>
      )}
      {!props.isViewingDeletedWorkflow &&
        !isLocked &&
        props.pendingRewind &&
        props.displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN && (
          <StatusBanner
            tone={STATUS_BANNER_TONES.WARNING}
            icon="debug-continue"
            className="flex-wrap gap-x-3 gap-y-1"
            aria-label={`Continuing run from step ${props.pendingRewind.fromStepIndex + 1}`}
            action={
              <button
                className="text-xs underline opacity-90 hover:opacity-100 focus-visible:outline focus-visible:outline-1"
                onClick={props.handleDiscardContinuation}
              >
                Discard Continuation
              </button>
            }
          >
            Continuing run from step {props.pendingRewind.fromStepIndex + 1}
            <span
              className="inline-flex items-center gap-1 opacity-90 cursor-help"
              title="Continuing crosses an undo-stack boundary — you won't be able to undo once you continue. All output history is preserved, but the working file's captured state for any re-run prompts will be overwritten."
            >
              <Icon name="info" />
              Can&apos;t be undone after continuing
            </span>
          </StatusBanner>
        )}
    </>
  );
};
