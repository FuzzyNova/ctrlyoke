import React from "react";
import { useUiStore } from "@store/uiStore";

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
 * Purely presentational: it renders `uiStore.pendingRunViewSwitch`, which
 * `requestRunViewLoad` sets for cross-lineage requests and every pending-request
 * clear path resets (snapshot applied, action failed, backend-initiated switch,
 * watchdog give-up). Because this overlay swallows pointer events, it must
 * never be the thing deciding how long a request may stay outstanding —
 * `useRunViewLoadWatchdog` owns reissuing a lost request and retiring one that
 * is never answered, for same-lineage loads (no overlay) equally.
 */
export const WorkflowSwitchOverlay: React.FC = () => {
  const pendingRunViewSwitch = useUiStore((s) => s.pendingRunViewSwitch);
  const retrying = useUiStore((s) => s.runViewLoadRetrying);

  if (!pendingRunViewSwitch) return null;

  const label = retrying
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
