import React, { useEffect } from "react";
import { useUiStore } from "@store/uiStore";

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
  const setStartupReady = useUiStore((s) => s.setStartupReady);

  // Safety timeout: dismiss overlay if STARTUP_COMPLETE never arrives.
  useEffect(() => {
    if (startupReady) return;
    const id = setTimeout(() => setStartupReady(true), STARTUP_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [startupReady, setStartupReady]);

  if (startupReady) return null;

  return (
    <div
      className="absolute inset-0 z-[9999] bg-editor-bg/80 flex items-center justify-center"
      style={{ pointerEvents: "all" }}
      aria-live="polite"
      aria-label="Loading FlightPath…"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-description-fg border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-description-fg select-none">
          Loading…
        </span>
      </div>
    </div>
  );
};
