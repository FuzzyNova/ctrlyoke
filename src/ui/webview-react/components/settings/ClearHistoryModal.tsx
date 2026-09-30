import { useEffect } from "react";
import { TypedConfirmModal } from "../shared/TypedConfirmModal";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useHistoryTrashStore } from "@store/historyTrashStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { generateId } from "@utils/string";
import { formatBytes } from "@utils/number";
import {
  CLEAR_HISTORY_CONFIRMATION_PHRASE,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";

interface Props {
  isOpen: boolean;
  retentionDays: number;
  onClose: () => void;
}

const MAX_LISTED_LIVE_WORKFLOWS = 3;

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * Clear all history, behind a preview of exactly what will move and a typed
 * confirmation. Always shown: `confirmDeleteOperations` does not apply here.
 */
export function ClearHistoryModal({ isOpen, retentionDays, onClose }: Props) {
  const vscode = useVsCodeApi();
  const clearPreview = useHistoryTrashStore((state) => state.clearPreview);

  useEffect(() => {
    if (!isOpen) return;
    const requestId = generateId();
    useHistoryTrashStore.getState().requestClearPreview(requestId);
    vscode.postMessage({
      type: MESSAGE_TYPES.HISTORY_CLEAR_PREVIEW_REQUEST,
      requestId,
    });
    return () => useHistoryTrashStore.getState().clearClearPreview();
  }, [isOpen, vscode]);

  const preview = clearPreview?.preview;
  const nothingToClear = preview !== undefined && preview.lineageCount === 0;

  const handleConfirm = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY,
      confirmation: CLEAR_HISTORY_CONFIRMATION_PHRASE,
    });
    // The workflow on screen goes too unless it is one of the kept live ones.
    const displayed = useUiStore.getState().displayedViewAddress;
    if (
      displayed &&
      !preview?.liveLineages.some(
        (live) => live.workflowKey === displayed.workflowKey
      )
    ) {
      useUiStore.getState().setViewingDeletedWorkflow({
        workflowKey: displayed.workflowKey,
        workflowName: useWorkflowStore.getState().workflowName ?? "",
      });
    }
    onClose();
  };

  const liveLineages = preview?.liveLineages ?? [];
  const listedLive = liveLineages
    .slice(0, MAX_LISTED_LIVE_WORKFLOWS)
    .map((live) => live.workflowName)
    .join(", ");
  const moreLive = liveLineages.length - MAX_LISTED_LIVE_WORKFLOWS;

  return (
    <TypedConfirmModal
      isOpen={isOpen}
      title="Clear All History"
      phrase={CLEAR_HISTORY_CONFIRMATION_PHRASE}
      confirmLabel="Clear history"
      confirmDisabled={!preview || nothingToClear}
      onConfirm={handleConfirm}
      onCancel={onClose}
    >
      {clearPreview?.error ? (
        <p role="alert" className="text-error-fg">
          {clearPreview.error}
        </p>
      ) : !preview ? (
        <p className="text-description-fg" role="status">
          Counting this project's history…
        </p>
      ) : nothingToClear ? (
        <p role="status">There is no history to clear.</p>
      ) : (
        <p role="status">
          Move {plural(preview.lineageCount, "workflow", "workflows")} (
          {plural(preview.runCount, "run", "runs")},{" "}
          {formatBytes(preview.bytes)}) to Recently deleted.
        </p>
      )}
      {liveLineages.length > 0 && (
        <p>
          {plural(liveLineages.length, "running workflow", "running workflows")}{" "}
          will be kept: {listedLive}
          {moreLive > 0 ? `, and ${moreLive} more` : ""}.
        </p>
      )}
      <p className="text-description-fg">
        You can restore everything from Recently deleted for{" "}
        {plural(retentionDays, "day", "days")}. After that it is removed for
        good.
      </p>
    </TypedConfirmModal>
  );
}
