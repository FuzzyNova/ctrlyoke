import React, { useEffect, useState } from "react";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";

const SWITCH_TIMEOUT_MS = 30000;

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
 * (snapshot applied, action failed, backend-initiated switch). Unlike
 * StartupOverlay's safety timeout, a missing RUN_VIEW_LOADED here must not
 * silently dismiss the overlay — that would leave the client addressed to a
 * workflow whose content was never applied. Instead, at the timeout the same
 * request (same requestId) is reissued once so a slow connection recovers
 * without the user having to notice and re-click; RUN_VIEW_LOADED's
 * requestId check accepts a response to either the original or retried send.
 * A later follow-up can add an explicit error/give-up state past this point.
 */
export const WorkflowSwitchOverlay: React.FC = () => {
  const pendingRunViewSwitch = useUiStore((s) => s.pendingRunViewSwitch);
  const [hasRetried, setHasRetried] = useState(false);

  useEffect(() => {
    setHasRetried(false);
    if (!pendingRunViewSwitch) return;
    const { requestId, address } = pendingRunViewSwitch;
    const id = setTimeout(() => {
      WebviewLog.warn(
        `[WorkflowSwitchOverlay] Safety timeout (${SWITCH_TIMEOUT_MS}ms) fired — ` +
          `RUN_VIEW_LOADED for request ${requestId} never arrived; retrying`
      );
      setHasRetried(true);
      getVsCodeApi().postMessage({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address,
        requestId,
      });
    }, SWITCH_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [pendingRunViewSwitch]);

  if (!pendingRunViewSwitch) return null;

  const label = hasRetried
    ? "Still loading workflow…"
    : pendingRunViewSwitch.workflowName
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
