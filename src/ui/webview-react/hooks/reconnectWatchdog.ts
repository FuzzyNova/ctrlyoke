import { useUiStore } from "@store/uiStore";
import { isStandalone } from "./useVsCodeApi";
import { WebviewLog } from "@utils/logger";

const PANEL_RECONNECT_RELOAD_DELAY_MS = 1500;
const PANEL_RECONNECT_RELOAD_COOLDOWN_MS = 10000;
const PANEL_RECONNECT_RELOAD_SESSION_KEY =
  "flightpath-panel-reconnect-reload-at";

let panelReconnectReloadTimer: number | undefined;

// True after BootstrapApp sends READY on a fresh page load. This flag
// distinguishes a fresh-page RECONNECT (extension queue is busy processing
// another client) from a retained-context RECONNECT (extension host restarted
// without a page reload). Reset to false when CLIENT_ID_ASSIGNED arrives.
//
// Why this matters: the 1500 ms watchdog is only safe for retained contexts.
// On a fresh page the extension may take >1500 ms to reach the panel's READY
// in its serialized routeQueue (e.g. browser client READY is processed first).
// Firing window.location.reload() during that window causes acquireVsCodeApi()
// to throw on the second load, leaving the panel showing raw HTML.
let freshPageReadySent = false;

export function markFreshPageReadySent(): void {
  freshPageReadySent = true;
}

export function clearFreshPageReadySent(): void {
  freshPageReadySent = false;
}

function clearPanelReconnectReloadTimer(): void {
  if (panelReconnectReloadTimer === undefined) return;
  window.clearTimeout(panelReconnectReloadTimer);
  panelReconnectReloadTimer = undefined;
}

export function clearPanelReconnectReloadWatchdog(): void {
  clearPanelReconnectReloadTimer();
  try {
    sessionStorage.removeItem(PANEL_RECONNECT_RELOAD_SESSION_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

export const reconnectWatchdogHooks = {
  reloadPanelForReconnect(): void {
    window.location.reload();
  },
};

export function schedulePanelReconnectReloadWatchdog(): void {
  if (isStandalone) return;

  // Fresh page: BootstrapApp already sent READY before the message listener
  // was registered. The extension will process it when its routeQueue is free
  // (possibly after finishing another client's READY). Skip the watchdog —
  // firing window.location.reload() here would corrupt the acquireVsCodeApi()
  // lifecycle and cause the raw-HTML regression.
  if (freshPageReadySent) {
    WebviewLog.debug(
      "[reconnectWatchdog] skipping watchdog: fresh-page READY already sent, waiting for CLIENT_ID_ASSIGNED"
    );
    return;
  }

  clearPanelReconnectReloadTimer();
  WebviewLog.debug(
    `[reconnectWatchdog] scheduling ${PANEL_RECONNECT_RELOAD_DELAY_MS}ms reload watchdog (retained context)`
  );
  panelReconnectReloadTimer = window.setTimeout(() => {
    panelReconnectReloadTimer = undefined;

    // The new extension host has already assigned this panel an identity, so
    // the reconnect succeeded and a hard reload is no longer needed.
    if (useUiStore.getState().myClientId) {
      WebviewLog.debug(
        "[reconnectWatchdog] watchdog fired but CLIENT_ID_ASSIGNED already received — aborting"
      );
      clearPanelReconnectReloadWatchdog();
      return;
    }

    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(
        sessionStorage.getItem(PANEL_RECONNECT_RELOAD_SESSION_KEY) ?? "0"
      );
    } catch {
      // Ignore storage failures and fall through to the reload.
    }

    const now = Date.now();
    if (
      Number.isFinite(lastReloadAt) &&
      now - lastReloadAt < PANEL_RECONNECT_RELOAD_COOLDOWN_MS
    ) {
      WebviewLog.debug(
        `[reconnectWatchdog] watchdog fired but within cooldown (last reload ${now - lastReloadAt}ms ago) — aborting`
      );
      return;
    }

    WebviewLog.warn(
      "[reconnectWatchdog] retained-context reconnect timed out — reloading panel"
    );
    try {
      sessionStorage.setItem(PANEL_RECONNECT_RELOAD_SESSION_KEY, String(now));
    } catch {
      // Best-effort persistence only.
    }

    reconnectWatchdogHooks.reloadPanelForReconnect();
  }, PANEL_RECONNECT_RELOAD_DELAY_MS);
}
