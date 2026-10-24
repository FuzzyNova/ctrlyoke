import React from "react";
import type {
  WorkflowKey,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import {
  MESSAGE_TYPES,
  RUN_DEFINITION_DECISIONS,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type RunDefinitionChange,
  type RunDefinitionDecision,
} from "@root/types/DashboardConstants";
import { describeRunDefinitionChanges } from "@root/utils/RunDefinitionChanges";
import { sameViewAddress } from "@root/utils/WorkflowViewAddress";
import { useActiveWorkflowExternalOwner } from "@hooks/useActiveWorkflowExternalOwner";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
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
  const definitionChangedOutside = useUiStore(
    (s) => s.definitionChangedOutside
  );
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
        definitionChangedOutside &&
        props.displayedViewAddress &&
        sameViewAddress(
          definitionChangedOutside.address,
          props.displayedViewAddress
        ) && (
          <DefinitionChangedOutsideBanner
            address={props.displayedViewAddress}
            changes={definitionChangedOutside.changes}
            unrecorded={definitionChangedOutside.unrecorded === true}
          />
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

/**
 * The addressed definition was changed by something other than ctrlyoke (an
 * agent editing the run file, for example). Every write to it is refused until
 * the user restores the last definition ctrlyoke wrote or accepts the change.
 * An unrecorded run (ctrlyoke never wrote it) has nothing to restore, so it
 * can only be accepted.
 */
const DefinitionChangedOutsideBanner: React.FC<{
  address: WorkflowViewAddress;
  changes: RunDefinitionChange[];
  unrecorded: boolean;
}> = ({ address, changes, unrecorded }) => {
  const vscode = useVsCodeApi();
  const resolve = (decision: RunDefinitionDecision) =>
    vscode.postMessage({
      type: MESSAGE_TYPES.RESOLVE_RUN_DEFINITION_CHANGE,
      address,
      decision,
    });
  const description = describeRunDefinitionChanges(changes);
  const acceptLink = (
    <button
      type="button"
      className={STATUS_BANNER_LINK_CLASS}
      onClick={() => resolve(RUN_DEFINITION_DECISIONS.ACCEPT)}
      title="Trust the definition as it is now and allow running and editing it"
    >
      {unrecorded ? "Accept run" : "Accept change"}
    </button>
  );

  if (unrecorded) {
    return (
      <StatusBanner
        tone={STATUS_BANNER_TONES.ERROR}
        icon="shield"
        aria-label="ctrlyoke has no record of writing this run"
        narrowChildren={<>Not written by ctrlyoke. {acceptLink}</>}
      >
        <span className="mr-2">
          ctrlyoke has no record of writing this run. It can&apos;t run or be
          edited until you review it.
        </span>
        {acceptLink}
      </StatusBanner>
    );
  }

  return (
    <StatusBanner
      tone={STATUS_BANNER_TONES.ERROR}
      icon="shield"
      aria-label={`Definition changed outside ctrlyoke: ${description}`}
      narrowChildren={<>Changed outside ctrlyoke. {acceptLink}</>}
      action={{
        label: "Restore",
        onClick: () => resolve(RUN_DEFINITION_DECISIONS.RESTORE),
        title: "Put back the definition ctrlyoke last wrote",
        "aria-label": "Restore the definition ctrlyoke last wrote",
      }}
    >
      <span className="mr-2">
        Definition changed outside ctrlyoke ({description}). It can&apos;t run
        or be edited until you review it.
      </span>
      {acceptLink}
    </StatusBanner>
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
