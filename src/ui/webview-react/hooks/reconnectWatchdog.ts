import { useUiStore } from "@store/uiStore";
import { isStandalone } from "./useVsCodeApi";
import { retryPanelHandshake } from "./panelHandshake";
import { WebviewLog } from "@utils/logger";

const PANEL_RECONNECT_RETRY_DELAY_MS = 1500;
const PANEL_RECONNECT_RETRY_COOLDOWN_MS = 10000;
const PANEL_RECONNECT_RETRY_SESSION_KEY = "ctrlyoke-panel-reconnect-retry-at";

let panelReconnectRetryTimer: number | undefined;

// True after BootstrapApp sends READY on a fresh page load. This flag
// distinguishes a fresh-page RECONNECT (extension queue is busy processing
// another client) from a retained-context RECONNECT (extension host restarted
// without a page reload). Reset to false when CLIENT_ID_ASSIGNED arrives.
//
// Why this matters: the 1500 ms watchdog is only meant for retained contexts.
// On a fresh page the extension may take >1500 ms to reach the panel's READY
// in its serialized routeQueue (e.g. browser client READY is processed first),
// and a retry there would only queue a redundant full handshake behind it.
let freshPageReadySent = false;

export function markFreshPageReadySent(): void {
  freshPageReadySent = true;
}

export function clearFreshPageReadySent(): void {
  freshPageReadySent = false;
}

function clearPanelReconnectRetryTimer(): void {
  if (panelReconnectRetryTimer === undefined) return;
  window.clearTimeout(panelReconnectRetryTimer);
  panelReconnectRetryTimer = undefined;
}

export function clearPanelReconnectWatchdog(): void {
  clearPanelReconnectRetryTimer();
  try {
    sessionStorage.removeItem(PANEL_RECONNECT_RETRY_SESSION_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

export const reconnectWatchdogHooks = {
  retryHandshake(): void {
    retryPanelHandshake();
  },
};

/**
 * After an extension-host restart VS Code can keep this page alive, so the new
 * host learns about it only from the READY the RECONNECT handler sends. If no
 * CLIENT_ID_ASSIGNED follows, re-run the handshake in place (see
 * retryPanelHandshake for why this is never a page reload).
 */
export function schedulePanelReconnectWatchdog(): void {
  if (isStandalone) return;

  // Fresh page: BootstrapApp already sent READY before the message listener
  // was registered. The extension will process it when its routeQueue is free
  // (possibly after finishing another client's READY). Skip the watchdog.
  if (freshPageReadySent) {
    return;
  }

  clearPanelReconnectRetryTimer();
  panelReconnectRetryTimer = window.setTimeout(() => {
    panelReconnectRetryTimer = undefined;

    // The new extension host has already assigned this panel an identity, so
    // the reconnect succeeded and no retry is needed.
    if (useUiStore.getState().myClientId) {
      clearPanelReconnectWatchdog();
      return;
    }

    let lastRetryAt = 0;
    try {
      lastRetryAt = Number(
        sessionStorage.getItem(PANEL_RECONNECT_RETRY_SESSION_KEY) ?? "0"
      );
    } catch {
      // Ignore storage failures and fall through to the retry.
    }

    const now = Date.now();
    if (
      Number.isFinite(lastRetryAt) &&
      now - lastRetryAt < PANEL_RECONNECT_RETRY_COOLDOWN_MS
    ) {
      return;
    }

    WebviewLog.warn(
      "[reconnectWatchdog] retained-context reconnect timed out — re-sending READY"
    );
    try {
      sessionStorage.setItem(PANEL_RECONNECT_RETRY_SESSION_KEY, String(now));
    } catch {
      // Best-effort persistence only.
    }

    reconnectWatchdogHooks.retryHandshake();
  }, PANEL_RECONNECT_RETRY_DELAY_MS);
}
