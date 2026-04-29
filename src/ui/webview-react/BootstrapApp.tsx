import { useEffect, useRef, useState, type ComponentType } from "react";
import { MESSAGE_TYPES } from "@/types/messages";
import { isStandalone, useVsCodeApi } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";

type DashboardAppComponent = ComponentType;

function captureAndSendThemeVars(
  vscode: ReturnType<typeof useVsCodeApi>
): void {
  const computedStyle = window.getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  const inlineStyle = document.documentElement.style;

  for (let i = 0; i < inlineStyle.length; i++) {
    const prop = inlineStyle.item(i);
    if (prop.startsWith("--vscode-")) {
      vars[prop] = computedStyle.getPropertyValue(prop).trim();
    }
  }

  vscode.postMessage({ type: MESSAGE_TYPES.THEME_VARS_CAPTURED, vars });
}

export default function BootstrapApp() {
  const vscode = useVsCodeApi();
  const preferredWorkingFilePath = useUiStore(
    (s) => s.activeWorkflowWorkingFilePath
  );
  const initialPreferredWorkingFilePathRef = useRef(preferredWorkingFilePath);
  const [DashboardApp, setDashboardApp] =
    useState<DashboardAppComponent | null>(null);

  useEffect(() => {
    const initialPreferredWorkingFilePath =
      initialPreferredWorkingFilePathRef.current;
    // In standalone (browser) mode the shim sends READY at WebSocket open for
    // server registration, and App.tsx sends it again after useMessageHandler
    // mounts its window listener (to flush buffered inbound messages).
    // Sending READY here would call flushInbound() via queueMicrotask() before
    // App.tsx finishes its async import — dispatching SESSION_RESTORED and other
    // startup messages to the window before any handler is registered, so they
    // are silently lost. New tabs with no persisted state rely on that
    // SESSION_RESTORED to load the most-recent workflow; losing it leaves the UI
    // stuck in "new workflow" state.
    // In standalone mode the server is also the authoritative source of theme
    // vars. Sending THEME_VARS_CAPTURED from the browser strips --fp-color-theme-kind
    // (only --vscode-* props are captured here), corrupting cachedThemeVars on the
    // server and breaking body-class-based icon inversion for subsequent connections.
    if (!isStandalone) {
      vscode.postMessage({
        type: MESSAGE_TYPES.READY,
        preferredWorkingFilePath: initialPreferredWorkingFilePath,
      });
      captureAndSendThemeVars(vscode);
    }

    let cancelled = false;
    const loadDashboardApp = async () => {
      try {
        const module = await import("./App");
        if (!cancelled) {
          setDashboardApp(() => module.default);
        }
      } catch (error) {
        WebviewLog.error(
          `[BootstrapApp] Dashboard App import failed: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }
    };

    void loadDashboardApp();
    return () => {
      cancelled = true;
    };
  }, [vscode]);

  if (!DashboardApp) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-editor-bg text-foreground">
        <div className="text-sm opacity-80">Connecting to FlightPath…</div>
      </div>
    );
  }

  return <DashboardApp />;
}
