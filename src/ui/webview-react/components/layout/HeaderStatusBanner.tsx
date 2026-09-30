import React from "react";
import type {
  WorkflowKey,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";
import { useActiveWorkflowExternalOwner } from "@hooks/useActiveWorkflowExternalOwner";
import { useIsSystemGeneratedWorkflow } from "@hooks/useIsSystemGeneratedWorkflow";
import {
  getExternalReadOnlyLabel,
  getExternalRunnerLabel,
} from "@utils/externalRunner";
import { useUiStore } from "@store/uiStore";
import {
  StatusBanner,
  STATUS_BANNER_LINK_CLASS,
  STATUS_BANNER_TONES,
} from "../shared/StatusBanner";
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
  const externalRunnerLabel = getExternalRunnerLabel(externalOwner);
  const isSystemGeneratedLocked =
    externalReadOnlyLabel === undefined && isSystemGeneratedWorkflow;
  const lockedLabel =
    externalReadOnlyLabel ??
    (isSystemGeneratedWorkflow
      ? "Read-only — managed automatically by commit message generation"
      : undefined);
  const narrowLockedLabel = externalRunnerLabel
    ? `Read-only — running via ${externalRunnerLabel}`
    : "Read-only — commit message workflow";
  const isLocked = lockedLabel !== undefined;
  const openCommitSettings = () => {
    setGlobalSettingsTab("commit");
    if (!globalSettingsOpen) {
      toggleGlobalSettings();
    }
  };

  const settingsLink = isSystemGeneratedLocked && (
    <>
      .{" "}
      <button
        type="button"
        className={STATUS_BANNER_LINK_CLASS}
        onClick={openCommitSettings}
      >
        Edit in settings
      </button>
    </>
  );

  return (
    <>
      {props.isViewingDeletedWorkflow && props.viewingDeletedWorkflow && (
        <StatusBanner
          tone={STATUS_BANNER_TONES.ERROR}
          icon="trash"
          aria-label={`Workflow "${props.viewingDeletedWorkflow.workflowName}" has been deleted`}
          action={{
            label: "Close",
            onClick: props.handleCloseDeletedWorkflow,
            title: "Start a new workflow and drop this cached view",
            "aria-label": "Close deleted workflow",
          }}
        >
          &quot;{props.viewingDeletedWorkflow.workflowName}&quot; has been
          deleted
        </StatusBanner>
      )}
      {!props.isViewingDeletedWorkflow && isLocked && (
        <StatusBanner
          tone={STATUS_BANNER_TONES.ERROR}
          icon="lock"
          aria-label={lockedLabel}
          narrowChildren={
            <>
              {narrowLockedLabel}
              {settingsLink}
            </>
          }
        >
          {lockedLabel}
          {settingsLink}
        </StatusBanner>
      )}
      {!props.isViewingDeletedWorkflow && !isLocked && props.isPausing && (
        <StatusBanner
          tone={STATUS_BANNER_TONES.WARNING}
          icon="debug-pause"
          iconClassName="animate-pulse-cancelling"
          aria-label="Workflow will pause after the current step completes"
          narrowChildren="Pausing after this step"
          action={{
            label: "Cancel",
            onClick: props.handleCancelPause,
            "aria-label": "Cancel pause",
          }}
        >
          Workflow will pause after the current step completes
        </StatusBanner>
      )}
      {!props.isViewingDeletedWorkflow &&
        !isLocked &&
        props.pendingRewind &&
        props.displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN && (
          <ContinuationBanner
            stepNumber={props.pendingRewind.fromStepIndex + 1}
            onDiscard={props.handleDiscardContinuation}
          />
        )}
    </>
  );
};

const CONTINUATION_UNDO_WARNING =
  "Continuing crosses an undo-stack boundary — you won't be able to undo once you continue. All output history is preserved, but the working file's captured state for any re-run prompts will be overwritten.";

const ContinuationBanner: React.FC<{
  stepNumber: number;
  onDiscard: () => void;
}> = ({ stepNumber, onDiscard }) => {
  const undoWarning = (label?: string) => (
    <span
      className="inline-flex items-center gap-1 opacity-90 cursor-help align-middle"
      title={CONTINUATION_UNDO_WARNING}
      role={label ? undefined : "img"}
      aria-label={label ? undefined : "Can't be undone after continuing"}
    >
      <Icon name="info" />
      {label}
    </span>
  );

  return (
    <StatusBanner
      tone={STATUS_BANNER_TONES.WARNING}
      icon="debug-continue"
      aria-label={`Continuing run from step ${stepNumber}`}
      narrowChildren={
        <>
          Continuing from step {stepNumber} {undoWarning()}
        </>
      }
      action={{
        label: "Discard Continuation",
        narrowLabel: "Discard",
        onClick: onDiscard,
      }}
    >
      <span className="mr-4">Continuing run from step {stepNumber}</span>
      {undoWarning("Can't be undone after continuing")}
    </StatusBanner>
  );
};
