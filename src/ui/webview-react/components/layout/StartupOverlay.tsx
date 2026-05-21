import React, { useEffect } from "react";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";

const STARTUP_TIMEOUT_MS = 8000;

/**
 * StartupOverlay
 *
 * Full-screen semi-transparent overlay shown immediately on first render.
 *
 * - Normal startup: shows a spinner until STARTUP_COMPLETE arrives (or 8-second safety timeout).
 * - Uninitialized workspace: shows an "Initialize FlightPath" prompt instead of the spinner.
 *   The safety timeout is suppressed so the init button stays visible indefinitely.
 *
 * The overlay intercepts all pointer events, preventing user interaction with
 * the dashboard during the startup window when the extension hasn't finished
 * loading the auto-load session. This eliminates the race condition where a
 * user edit made during startup gets overwritten by the arriving auto-load.
 */
export const StartupOverlay: React.FC = () => {
  const startupReady = useUiStore((s) => s.startupReady);
  const devRestarting = useUiStore((s) => s.devRestarting);
  const workspaceInitRequired = useUiStore((s) => s.workspaceInitRequired);
  const setStartupReady = useUiStore((s) => s.setStartupReady);

  // Safety timeout: dismiss overlay if STARTUP_COMPLETE never arrives.
  // Suppressed when workspace initialization is pending — the init button must
  // stay visible until the user explicitly approves.
  // devRestarting must NOT bypass this — if the DEV panel triggered a reload
  // but the extension host restart left the webview stuck, the timeout is
  // the only recovery path until RECONNECT arrives and clears devRestarting.
  useEffect(() => {
    if (startupReady || workspaceInitRequired) return;
    const id = setTimeout(() => {
      WebviewLog.warn(
        `[startup] Safety timeout (${STARTUP_TIMEOUT_MS}ms) fired — STARTUP_COMPLETE has not arrived yet; dismissing overlay`
      );
      setStartupReady(true);
    }, STARTUP_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [startupReady, workspaceInitRequired, setStartupReady]);

  // Overlay stays visible if startup hasn't finished OR if init is required
  if (startupReady && !workspaceInitRequired) return null;

  return (
    <div
      className="absolute inset-0 z-[9999] flex items-center justify-center"
      style={{
        pointerEvents: "all",
        backgroundColor:
          "color-mix(in srgb, var(--vscode-editor-background) 70%, transparent)",
      }}
      aria-live="polite"
      aria-label={
        workspaceInitRequired
          ? "Initialize FlightPath in this workspace"
          : "Loading FlightPath\u2026"
      }
    >
      {workspaceInitRequired ? (
        <div className="flex flex-col items-center gap-4 max-w-xs text-center px-4">
          <svg
            width="32"
            height="32"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="text-description-fg opacity-80"
            aria-hidden="true"
          >
            {/* Folder-plus icon */}
            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.764c.414 0 .81.165 1.1.457L8.44 3.5H13.5A1.5 1.5 0 0 1 15 5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12V3.5zm7.5 4a.5.5 0 0 0-1 0V9H6a.5.5 0 0 0 0 1h1.5v1.5a.5.5 0 0 0 1 0V10H10a.5.5 0 0 0 0-1H8.5V7.5z" />
          </svg>
          <span className="text-sm font-medium text-foreground select-none">
            Initialize FlightPath here?
          </span>
          <span className="text-xs text-description-fg select-none leading-relaxed">
            FlightPath will create a{" "}
            <code className="font-mono">.flightpath/</code> directory in this
            workspace to store session history and runtime working files.
          </span>
          <button
            className="mt-1 px-4 py-1.5 text-xs font-medium rounded
                       bg-btn-bg text-btn-fg border border-btn-border
                       hover:bg-btn-hover transition-colors
                       focus:outline-none focus:ring-1 focus:ring-focus-border
                       cursor-pointer select-none"
            onClick={() =>
              getVsCodeApi().postMessage({
                type: MESSAGE_TYPES.INITIALIZE_WORKSPACE,
              })
            }
          >
            Initialize FlightPath
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-description-fg border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-description-fg select-none">
            {devRestarting
              ? "VS Code is reloading. Active workflows have been stopped. Reconnecting..."
              : "Loading..."}
          </span>
        </div>
      )}
    </div>
  );
};
