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
 * - Uninitialized workspace: shows an "Initialize ctrlyoke" prompt instead of the spinner.
 *   The safety timeout is suppressed so the init button stays visible indefinitely.
 * - First install layout preference: after init, shows a panel placement choice (step 2).
 *   The safety timeout is also suppressed here.
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
  const showLayoutPreference = useUiStore((s) => s.showLayoutPreference);
  const setStartupReady = useUiStore((s) => s.setStartupReady);
  const setShowLayoutPreference = useUiStore((s) => s.setShowLayoutPreference);

  const suppressTimeout = workspaceInitRequired || showLayoutPreference;

  // Safety timeout: dismiss overlay if STARTUP_COMPLETE never arrives.
  // Suppressed when workspace initialization or layout preference is pending —
  // those prompts must stay visible until the user explicitly acts.
  // devRestarting must NOT bypass this — if the DEV panel triggered a reload
  // but the extension host restart left the webview stuck, the timeout is
  // the only recovery path until RECONNECT arrives and clears devRestarting.
  useEffect(() => {
    if (startupReady || suppressTimeout) return;
    const id = setTimeout(() => {
      WebviewLog.warn(
        `[startup] Safety timeout (${STARTUP_TIMEOUT_MS}ms) fired — STARTUP_COMPLETE has not arrived yet; dismissing overlay`
      );
      setStartupReady(true);
    }, STARTUP_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [startupReady, suppressTimeout, setStartupReady]);

  // Overlay stays visible if startup hasn't finished OR if either prompt is active
  if (startupReady && !workspaceInitRequired && !showLayoutPreference)
    return null;

  return (
    <div
      className="absolute inset-0 z-popover flex items-center justify-center"
      style={{
        pointerEvents: "all",
        backgroundColor:
          "color-mix(in srgb, var(--vscode-editor-background) 70%, transparent)",
      }}
      aria-live="polite"
      aria-label={
        workspaceInitRequired
          ? "Initialize ctrlyoke in this workspace"
          : showLayoutPreference
            ? "Choose where to dock the ctrlyoke panel"
            : "Loading ctrlyoke…"
      }
    >
      {workspaceInitRequired ? (
        <div className="flex flex-col items-center gap-4 max-w-xs text-center px-4">
          <i
            className="codicon codicon-new-folder text-description-fg opacity-80"
            style={{ fontSize: 32 }}
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-foreground select-none">
            Initialize ctrlyoke here?
          </span>
          <span className="text-xs text-description-fg select-none leading-relaxed">
            ctrlyoke will create a{" "}
            <code className="font-mono">.ctrlyoke/</code> directory in this
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
            Initialize ctrlyoke
          </button>
        </div>
      ) : showLayoutPreference ? (
        <LayoutPreferenceStep onChoose={setShowLayoutPreference} />
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

const LayoutPreferenceStep: React.FC<{ onChoose: (show: boolean) => void }> = ({
  onChoose,
}) => {
  const dismiss = () => {
    onChoose(false);
    getVsCodeApi().postMessage({ type: MESSAGE_TYPES.LAYOUT_TIP_DISMISSED });
  };

  return (
    <div className="flex flex-col items-center gap-4 max-w-sm text-center px-4">
      <i
        className="codicon codicon-editor-layout text-description-fg opacity-80"
        style={{ fontSize: 32 }}
        aria-hidden="true"
      />
      <span className="text-sm font-medium text-foreground select-none">
        One quick tip
      </span>
      <span className="text-xs text-description-fg select-none leading-relaxed">
        ctrlyoke lives in the bottom panel by default. On smaller screens it
        can feel cramped — drag the ctrlyoke tab to the sidebar for more
        vertical space.
      </span>
      <button
        className="mt-1 px-4 py-1.5 text-xs font-medium rounded
                   bg-btn-bg text-btn-fg border border-btn-border
                   hover:bg-btn-hover transition-colors
                   focus:outline-none focus:ring-1 focus:ring-focus-border
                   cursor-pointer select-none"
        onClick={dismiss}
      >
        Got it
      </button>
      <span className="text-xs text-description-fg opacity-70 select-none leading-relaxed">
        You can always move it back by dragging the ctrlyoke tab to whichever
        panel you prefer.
      </span>
    </div>
  );
};
