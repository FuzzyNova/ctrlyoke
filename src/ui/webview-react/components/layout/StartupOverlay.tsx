import React, { useEffect } from "react";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";

const STARTUP_TIMEOUT_MS = 8000;

/**
 * StartupOverlay
 *
 * Full-screen semi-transparent overlay with a spinner shown immediately on
 * first render. Dismissed once STARTUP_COMPLETE (or WORKFLOW_LOADED) is
 * received from the extension, or after an 8-second safety timeout.
 *
 * The overlay intercepts all pointer events, preventing user interaction with
 * the dashboard during the startup window when the extension hasn't finished
 * loading the auto-load session. This eliminates the race condition where a
 * user edit made during startup gets overwritten by the arriving auto-load.
 */
export const StartupOverlay: React.FC = () => {
  const startupReady = useUiStore((s) => s.startupReady);
  const devRestarting = useUiStore((s) => s.devRestarting);
  const setStartupReady = useUiStore((s) => s.setStartupReady);

  // Safety timeout: dismiss overlay if STARTUP_COMPLETE never arrives.
  // devRestarting must NOT bypass this — if the DEV panel triggered a reload
  // but the extension host restart left the webview stuck, the timeout is
  // the only recovery path until RECONNECT arrives and clears devRestarting.
  useEffect(() => {
    if (startupReady) return;
    const id = setTimeout(() => {
      WebviewLog.warn(
        `[startup] Safety timeout (${STARTUP_TIMEOUT_MS}ms) fired — STARTUP_COMPLETE has not arrived yet; dismissing overlay`
      );
      setStartupReady(true);
    }, STARTUP_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [startupReady, setStartupReady]);

  if (startupReady) return null;

  return (
    <div
      className="absolute inset-0 z-[9999] flex items-center justify-center"
      style={{
        pointerEvents: "all",
        backgroundColor:
          "color-mix(in srgb, var(--vscode-editor-background) 70%, transparent)",
      }}
      aria-live="polite"
      aria-label="Loading FlightPath…"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-description-fg border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-description-fg select-none">
          {devRestarting
            ? "VS Code is reloading. Active workflows have been stopped. Reconnecting..."
            : "Loading..."}
        </span>
      </div>
    </div>
  );
};
