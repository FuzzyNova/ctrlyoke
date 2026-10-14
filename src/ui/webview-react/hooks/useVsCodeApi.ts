import { useEffect, useState } from "react";

interface VsCodeApi {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
}

// Declare global window extension for vscodeApi
declare global {
  interface Window {
    vscodeApi?: VsCodeApi;
    __ctrlyokeStandalone?: boolean;
    __ctrlyokeReactMounted?: boolean;
    /** Set to true when CLIENT_ID_ASSIGNED arrives; used by the HTML handshake watchdog. */
    __ctrlyokePanelHandshakeDone?: boolean;
    /** Re-sends READY as a fresh handshake; called by the HTML handshake watchdog. */
    __ctrlyokeRetryPanelHandshake?: () => void;
    __ctrlyokeBootstrapLog?: (level: string, message: string) => void;
    __ctrlyokeFlushBootstrapLogs?: () => void;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

/** True when the UI is served by CtrlYokeHostedServer (browser tab), not the VS Code panel. */
export const isStandalone =
  typeof window !== "undefined" && !!window.__ctrlyokeStandalone;

/**
 * Identifies the current page load (module evaluation), stable for the lifetime
 * of this JS context and distinct for every page the extension builds. Every
 * READY the panel sends during one page load carries this same value so the
 * extension can tell "duplicate READY within this page" (BootstrapApp → App.tsx,
 * safe to ignore) apart from a READY from a rebuilt page (must be handled, or
 * the panel never receives CLIENT_ID_ASSIGNED again). Handshake retries derive
 * their own id from it (see panelHandshake.ts).
 */
export const panelPageLoadId: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let vscodeApi: VsCodeApi | undefined;

function flushBootstrapLogs(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.__ctrlyokeFlushBootstrapLogs?.();
  } catch {
    // Best-effort flush only.
  }
}

function resolveVsCodeApi(): VsCodeApi | undefined {
  if (typeof window === "undefined") {
    return vscodeApi;
  }

  // Prefer the current global reference. On retained webviews, VS Code may
  // replace window.vscodeApi during a reconnect, so never pin the first object
  // forever if a newer one is present.
  if (window.vscodeApi && window.vscodeApi !== vscodeApi) {
    vscodeApi = window.vscodeApi;
    flushBootstrapLogs();
  }

  if (!vscodeApi && typeof window.acquireVsCodeApi === "function") {
    vscodeApi = window.acquireVsCodeApi();
    window.vscodeApi = vscodeApi;
    flushBootstrapLogs();
  }

  return vscodeApi;
}

export function useVsCodeApi(): VsCodeApi {
  const [api, setApi] = useState<VsCodeApi | undefined>(() =>
    resolveVsCodeApi()
  );

  useEffect(() => {
    const resolvedApi = resolveVsCodeApi();
    if (!resolvedApi) {
      console.error("ctrlyoke: window.vscodeApi is undefined!");
      throw new Error(
        "VS Code API not available - window.vscodeApi is undefined"
      );
    }
    if (resolvedApi !== api) {
      setApi(resolvedApi);
    }
  }, [api]);

  if (!api) {
    console.error("ctrlyoke: api is undefined in useVsCodeApi hook");
    throw new Error("VS Code API not available");
  }

  return api;
}

export function getVsCodeApi(): VsCodeApi {
  const resolvedApi = resolveVsCodeApi();
  if (!resolvedApi) {
    throw new Error(
      "VS Code API not available - window.vscodeApi is undefined"
    );
  }
  return resolvedApi;
}
