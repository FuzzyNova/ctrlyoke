import React, { useCallback, useState } from "react";
import { isStandalone, useVsCodeApi } from "@hooks/useVsCodeApi";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useIsViewingDeletedWorkflow } from "@hooks/useIsViewingDeletedWorkflow";
import { useIsSystemGeneratedWorkflow } from "@hooks/useIsSystemGeneratedWorkflow";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";
import { HEADER_BUTTON_SIZES } from "@/constants";
import {
  SplitButton,
  type SplitButtonOption,
} from "@components/shared/SplitButton";
import { WorkflowFilePickerModal } from "@components/workflow/WorkflowFilePickerModal";
import { postWorkflowDefinitionMutation } from "../../utils/workflowMutation";

interface WorkflowControlsProps {
  /** Additional className for styling */
  className?: string;
  /** Hide the text label until lg while keeping the icon-only split button visible */
  compactUntilLg?: boolean;
}

/**
 * WorkflowControls - Split button for workflow actions
 *
 * Main button: Create new blank workflow
 * Dropdown options:
 *   - From Template
 *   - Load from File
 *   - Queue File - only when queue exists
 *
 * Ctrl+N (new blank workflow) and Ctrl+Shift+N (new workflow from template)
 * are handled by the webview-level `useNewWorkflowKeyHandler` hook — see
 * dev/reference/KEYBOARD_SHORTCUTS.md for why webview-level handlers are used
 * instead of package.json keybindings, which don't fire while the webview has
 * focus. Ctrl+Shift+L (load from file) and Ctrl+Shift+Q (queue file) remain
 * registered only as package.json keybindings.
 */
export const WorkflowControls: React.FC<WorkflowControlsProps> = ({
  className = "",
  compactUntilLg = false,
}) => {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();
  const btnSizes = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;
  const { fileName } = useWorkflowStore();
  const workflowName = useWorkflowStore((state) => state.workflowName);
  const { displayedViewAddress } = useUiStore();
  const openDuplicateWorkflowDialog = useUiStore(
    (state) => state.openDuplicateWorkflowDialog
  );
  const [filePickerMode, setFilePickerMode] = useState<"load" | "queue" | null>(
    null
  );

  const hasQueue = fileName !== null;
  const isViewingRun = displayedViewAddress?.kind === "run";
  // The lineage on screen was deleted while being viewed — appending to it or
  // duplicating it has nothing left to read from/write to. Creating fresh
  // (New / From Template / Load from File) stays available.
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  // The lineage on screen is an internal system lineage (e.g. commit message
  // generation) — appending to its queue is pointless since the next real
  // generation wipes the draft anyway. Duplicating it into an independent,
  // freely-editable lineage stays available as an escape hatch.
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();

  // Handle new workflow (clear current)
  const handleNewWorkflow = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  }, [vscode]);

  // Handle from template action
  const handleFromTemplate = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
  }, [vscode]);

  // Handle load file action
  const handleLoadFile = useCallback(() => {
    if (isStandalone) {
      setFilePickerMode("load");
      return;
    }
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  }, [vscode]);

  // Handle queue file action
  const handleQueueFile = useCallback(() => {
    if (!hasQueue) return;
    if (isStandalone) {
      setFilePickerMode("queue");
      return;
    }
    postWorkflowDefinitionMutation(vscode, { type: MESSAGE_TYPES.APPEND_FILE });
  }, [vscode, hasQueue]);

  const handleDuplicateWorkflow = useCallback(
    (invoker?: HTMLElement | null) => {
      if (!displayedViewAddress) return;
      openDuplicateWorkflowDialog(
        {
          source: displayedViewAddress,
          workflowName: workflowName || "Untitled Workflow",
        },
        invoker
      );
    },
    [displayedViewAddress, openDuplicateWorkflowDialog, workflowName]
  );

  const handlePickerSelect = useCallback(
    (filePath: string) => {
      if (filePickerMode === "load") {
        vscode.postMessage({ type: MESSAGE_TYPES.LOAD_WORKFLOW, filePath });
        return;
      }
      if (filePickerMode === "queue") {
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.APPEND_FILE,
          filePath,
        });
      }
    },
    [filePickerMode, vscode]
  );

  // Build dropdown options
  const dropdownOptions: SplitButtonOption[] = [
    {
      label: "New From Template...",
      value: "from-template",
      icon: <i className="custom-icon icon-from-template" />,
      onClick: handleFromTemplate,
    },
    {
      label: "Load from File...",
      value: "load-file",
      icon: <i className="custom-icon icon-load-from-file" />,
      onClick: handleLoadFile,
    },
    {
      label: isViewingRun
        ? "Append and Continue from File..."
        : "Queue from File...",
      value: "queue-file",
      icon: <i className="custom-icon icon-queue-from-file" />,
      onClick: handleQueueFile,
      disabled:
        !hasQueue || isViewingDeletedWorkflow || isSystemGeneratedWorkflow,
    },
    {
      label: isViewingRun
        ? "Duplicate This Run as New Workflow…"
        : "Duplicate Workflow…",
      value: "duplicate-workflow",
      icon: <i className="codicon codicon-copy" />,
      onClick: handleDuplicateWorkflow,
      disabled: !displayedViewAddress || isViewingDeletedWorkflow,
    },
  ];

  return (
    <div className={`workflow-controls ${className}`}>
      <SplitButton
        mainLabel={
          <span className="flex items-center gap-1.5">
            <i className={`codicon codicon-add py-0.5 ${btnSizes.icon}`} />
            <span
              className={
                compactUntilLg ? "hidden lg:inline" : "hidden sm:inline"
              }
            >
              New
            </span>
          </span>
        }
        mainAction={handleNewWorkflow}
        options={dropdownOptions}
        variant="primary"
        mainTitle="Create new workflow"
        dropdownTitle="More workflow actions"
        dropdownAriaLabel="Open workflow menu"
      />
      <WorkflowFilePickerModal
        isOpen={filePickerMode !== null}
        title={
          filePickerMode === "queue"
            ? "Queue Workflow File"
            : "Load Workflow File"
        }
        actionLabel={filePickerMode === "queue" ? "Queue File" : "Load File"}
        onClose={() => setFilePickerMode(null)}
        onSelect={handlePickerSelect}
      />
    </div>
  );
};
