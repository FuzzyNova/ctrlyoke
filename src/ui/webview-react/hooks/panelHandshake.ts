import { MESSAGE_TYPES } from "@/types/messages";
import { getReadyPreferredViewAddress } from "@/navigation/readyRoute";
import { getVsCodeApi, panelPageLoadId } from "./useVsCodeApi";

let retryAttempt = 0;

/**
 * Re-runs the panel's READY handshake in place. This is the panel's only
 * self-recovery: `window.location.reload()` is not one in a VS Code webview,
 * because the content iframe's real URL is VS Code's empty `fake.html` (the
 * dashboard HTML is document.write()n into it), so a reload leaves the panel
 * permanently blank.
 *
 * Each retry carries its own page-load id because the extension discards a
 * second READY from the same page load as a duplicate; a distinct id makes it
 * answer with the full handshake (INIT, CLIENT_ID_ASSIGNED, replay) again.
 * The API is resolved per call because VS Code can replace it on a retained
 * webview across an extension-host restart.
 */
export function retryPanelHandshake(): void {
  retryAttempt += 1;
  getVsCodeApi().postMessage({
    type: MESSAGE_TYPES.READY,
    preferredViewAddress: getReadyPreferredViewAddress(),
    pageLoadId: `${panelPageLoadId}:handshake-retry-${retryAttempt}`,
  });
}

/** Exposes the retry to the HTML handshake watchdog (moduleLoaderScript). */
export function installPanelHandshakeRetry(): void {
  window.__ctrlyokeRetryPanelHandshake = retryPanelHandshake;
}
