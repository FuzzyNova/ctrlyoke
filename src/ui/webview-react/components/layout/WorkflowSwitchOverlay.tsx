import React, { useEffect } from "react";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";

const SWITCH_TIMEOUT_MS = 10000;

/**
 * WorkflowSwitchOverlay
 *
 * Semi-transparent loading overlay covering the main panel area (not the
 * header) while a cross-lineage workflow switch is in flight. The header
 * already shows the target workflow's name optimistically; this overlay gives
 * instant feedback that the click registered and blocks interaction with the
 * previous workflow's still-rendered panels — an edit made mid-switch would
 * otherwise target the workflow the user just left.
 *
 * Driven by `uiStore.pendingRunViewSwitch`, which `requestRunViewLoad` sets
 * for cross-lineage requests and every pending-request clear path resets
 * (snapshot applied, action failed, backend-initiated switch). The safety
 * timeout mirrors StartupOverlay: if the snapshot never arrives, clear the
 * whole pending request so the overlay cannot wedge and stale revisions
 * cannot suppress later requestless snapshots.
 */
export const WorkflowSwitchOverlay: React.FC = () => {
  const pendingRunViewSwitch = useUiStore((s) => s.pendingRunViewSwitch);
  const clearPendingRunViewLoad = useUiStore(
    (s) => s.clearPendingRunViewLoad
  );

  useEffect(() => {
    if (!pendingRunViewSwitch) return;
    const id = setTimeout(() => {
      WebviewLog.warn(
        `[WorkflowSwitchOverlay] Safety timeout (${SWITCH_TIMEOUT_MS}ms) fired — ` +
          `RUN_VIEW_LOADED for request ${pendingRunViewSwitch.requestId} never arrived; clearing pending switch`
      );
      clearPendingRunViewLoad();
    }, SWITCH_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [pendingRunViewSwitch, clearPendingRunViewLoad]);

  if (!pendingRunViewSwitch) return null;

  const label = pendingRunViewSwitch.workflowName
    ? `Loading "${pendingRunViewSwitch.workflowName}"…`
    : "Loading workflow…";

  return (
    <div
      className="absolute inset-0 z-popover flex items-center justify-center"
      style={{
        pointerEvents: "all",
        backgroundColor:
          "color-mix(in srgb, var(--vscode-editor-background) 70%, transparent)",
      }}
      aria-live="polite"
      aria-label={label}
    >
      <div className="flex flex-col items-center gap-3 max-w-full px-4">
        <div className="w-6 h-6 border-2 border-description-fg border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-description-fg select-none truncate max-w-full">
          {label}
        </span>
      </div>
    </div>
  );
};
