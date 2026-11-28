import React, { useCallback, useState } from "react";
import { isStandalone, useVsCodeApi } from "@hooks/useVsCodeApi";
import { useIsMobile, useIsNarrowMobile } from "@hooks/useMediaQuery";
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
import {
  useQueueFilePicker,
  useSubWorkflowFilePicker,
} from "@hooks/useSubWorkflowFilePicker";
import { startNewBlankWorkflow } from "../../utils/newWorkflow";
import {
  BUTTON_VARIANTS,
  QUEUE_POSITION,
  SUB_WORKFLOW_QUEUE_LABELS,
  WORKFLOW_CONTROLS_MENU_VALUES,
  WORKFLOW_FILE_PICKER_MODES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { FilePlusCorner, ListEnd, NotepadTextDashed } from "lucide-react";
import { Icon } from "../shared/Icon";
import { LucideIcon } from "../shared/LucideIcon";

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
 *   - Queue as Sub-workflow (Append and Continue as Sub-workflow on a run)
 *     - only when queue exists
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
  const isNarrowMobile = useIsNarrowMobile();
  const btnSizes = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;
  const { fileName } = useWorkflowStore();
  const workflowName = useWorkflowStore((state) => state.workflowName);
  const { displayedViewAddress } = useUiStore();
  const openDuplicateWorkflowDialog = useUiStore(
    (state) => state.openDuplicateWorkflowDialog
  );
  // Load and Import Run pick through this component's own modal; the queue
  // actions through their hooks, which capture the target view when the
  // item is chosen.
  const [filePickerMode, setFilePickerMode] = useState<
    | typeof WORKFLOW_FILE_PICKER_MODES.LOAD
    | typeof WORKFLOW_FILE_PICKER_MODES.IMPORT_RUN
    | null
  >(null);
  const { requestSubWorkflowFile, subWorkflowPickerModal } =
    useSubWorkflowFilePicker();
  const { requestQueueFile, queueFilePickerModal } = useQueueFilePicker();

  const hasQueue = fileName !== null;
  const isViewingRun =
    displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN;
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
    startNewBlankWorkflow(vscode);
  }, [vscode]);

  // Handle from template action
  const handleFromTemplate = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
  }, [vscode]);

  const handleImportRun = useCallback(() => {
    if (isStandalone) {
      setFilePickerMode(WORKFLOW_FILE_PICKER_MODES.IMPORT_RUN);
      return;
    }
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_RUN_BUNDLE });
  }, [vscode]);

  // Handle load file action
  const handleLoadFile = useCallback(() => {
    if (isStandalone) {
      setFilePickerMode(WORKFLOW_FILE_PICKER_MODES.LOAD);
      return;
    }
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  }, [vscode]);

  // Handle queue file action
  const handleQueueFile = useCallback(() => {
    if (!hasQueue) return;
    requestQueueFile();
  }, [requestQueueFile, hasQueue]);

  // Queue a file as one sub-workflow step instead of splicing its steps in
  const handleQueueSubWorkflow = useCallback(() => {
    if (!hasQueue) return;
    requestSubWorkflowFile(QUEUE_POSITION.END);
  }, [requestSubWorkflowFile, hasQueue]);

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
      if (filePickerMode === WORKFLOW_FILE_PICKER_MODES.LOAD) {
        if (isStandalone && /\.ctrlyokerun(?:[\\/]|$)/i.test(filePath)) {
          const bundleDir = filePath.replace(
            /[\\/]workflow\.ctrlyoke\.json$/i,
            ""
          );
          if (
            window.confirm(
              "Import this run (continue where it stopped)? Choose Cancel to load its workflow only and start over."
            )
          ) {
            vscode.postMessage({
              type: MESSAGE_TYPES.REQUEST_RUN_IMPORT_PREVIEW,
              bundleDir,
              requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            });
          } else {
            vscode.postMessage({
              type: MESSAGE_TYPES.LOAD_WORKFLOW,
              filePath: `${bundleDir.replace(/[\\/]$/, "")}/workflow.ctrlyoke.json`,
            });
          }
          return;
        }
        vscode.postMessage({ type: MESSAGE_TYPES.LOAD_WORKFLOW, filePath });
        return;
      }
      if (filePickerMode === WORKFLOW_FILE_PICKER_MODES.IMPORT_RUN) {
        vscode.postMessage({
          type: MESSAGE_TYPES.REQUEST_RUN_IMPORT_PREVIEW,
          bundleDir: filePath,
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        });
      }
    },
    [filePickerMode, vscode]
  );

  const queueDisabled =
    !hasQueue || isViewingDeletedWorkflow || isSystemGeneratedWorkflow;

  // Build dropdown options
  const dropdownOptions: SplitButtonOption[] = [
    {
      label: "New From Template...",
      value: WORKFLOW_CONTROLS_MENU_VALUES.FROM_TEMPLATE,
      icon: <LucideIcon icon={NotepadTextDashed} />,
      onClick: handleFromTemplate,
    },
    {
      label: "Load from File...",
      value: WORKFLOW_CONTROLS_MENU_VALUES.LOAD_FILE,
      icon: <LucideIcon icon={FilePlusCorner} />,
      onClick: handleLoadFile,
    },
    {
      label: "Import Run...",
      value: WORKFLOW_CONTROLS_MENU_VALUES.IMPORT_RUN,
      icon: <Icon name="folder-opened" />,
      onClick: handleImportRun,
    },
    {
      label: isViewingRun
        ? "Append and Continue from File..."
        : "Queue from File...",
      value: WORKFLOW_CONTROLS_MENU_VALUES.QUEUE_FILE,
      icon: <LucideIcon icon={ListEnd} />,
      onClick: handleQueueFile,
      disabled: queueDisabled,
    },
    {
      // A run continues with the step, as it does with the inline sibling's.
      label: isViewingRun
        ? SUB_WORKFLOW_QUEUE_LABELS.appendAndContinueAsSubWorkflow
        : SUB_WORKFLOW_QUEUE_LABELS.queueAsSubWorkflow,
      value: WORKFLOW_CONTROLS_MENU_VALUES.QUEUE_SUB_WORKFLOW,
      icon: <Icon name="list-ordered" />,
      title: SUB_WORKFLOW_QUEUE_LABELS.queueAsSubWorkflowTitle,
      onClick: handleQueueSubWorkflow,
      disabled: queueDisabled,
    },
    {
      label: isViewingRun
        ? "Duplicate This Run as New Workflow…"
        : "Duplicate Workflow…",
      value: WORKFLOW_CONTROLS_MENU_VALUES.DUPLICATE_WORKFLOW,
      icon: <Icon name="copy" />,
      onClick: handleDuplicateWorkflow,
      disabled: !displayedViewAddress || isViewingDeletedWorkflow,
    },
  ];

  return (
    <div className={`workflow-controls ${className}`}>
      <SplitButton
        mainLabel={
          <span className="flex items-center gap-1.5">
            <Icon name="add" className={`py-0.5 ${btnSizes.icon}`} />
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
        variant={BUTTON_VARIANTS.PRIMARY}
        mainTitle="Create new workflow"
        dropdownTitle="More workflow actions"
        dropdownAriaLabel="Open workflow menu"
        // Only below `xs` (380px) — the same width at which the header starts
        // dropping non-actionable run slots outright. Between `xs` and `sm`
        // the label has already gone icon-only and that buys enough room, so
        // the chevron stays and keeps advertising the menu. The menu remains
        // reachable by right-click / press-and-hold at every width, which is
        // what makes the gesture learnable before it becomes the only way in.
        hideMenuButton={isNarrowMobile}
      />
      <WorkflowFilePickerModal
        isOpen={filePickerMode !== null}
        title={
          filePickerMode === WORKFLOW_FILE_PICKER_MODES.IMPORT_RUN
            ? "Import Run"
            : "Load Workflow File"
        }
        actionLabel={
          filePickerMode === WORKFLOW_FILE_PICKER_MODES.IMPORT_RUN
            ? "Preview Import"
            : "Load File"
        }
        directoryMode={filePickerMode === WORKFLOW_FILE_PICKER_MODES.IMPORT_RUN}
        onClose={() => setFilePickerMode(null)}
        onSelect={handlePickerSelect}
      />
      {queueFilePickerModal}
      {subWorkflowPickerModal}
    </div>
  );
};
