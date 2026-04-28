import { useUiStore } from "@store/uiStore";
import { isStandalone } from "./useVsCodeApi";

const PANEL_RECONNECT_RELOAD_DELAY_MS = 1500;
const PANEL_RECONNECT_RELOAD_COOLDOWN_MS = 10000;
const PANEL_RECONNECT_RELOAD_SESSION_KEY =
  "flightpath-panel-reconnect-reload-at";

let panelReconnectReloadTimer: number | undefined;

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

  clearPanelReconnectReloadTimer();
  panelReconnectReloadTimer = window.setTimeout(() => {
    panelReconnectReloadTimer = undefined;

    // The new extension host has already assigned this panel an identity, so
    // the reconnect succeeded and a hard reload is no longer needed.
    if (useUiStore.getState().myClientId) {
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
      return;
    }

    try {
      sessionStorage.setItem(PANEL_RECONNECT_RELOAD_SESSION_KEY, String(now));
    } catch {
      // Best-effort persistence only.
    }

    reconnectWatchdogHooks.reloadPanelForReconnect();
  }, PANEL_RECONNECT_RELOAD_DELAY_MS);
}
