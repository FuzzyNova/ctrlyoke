import { isStandalone } from "./useVsCodeApi";

// Holds extension → panel messages that arrive between BootstrapApp's early
// READY and useMessageHandler attaching its window listener.
//
// BootstrapApp sends READY before it lazy-imports App, so the extension can
// answer (INIT, CLIENT_ID_ASSIGNED, the startup replay) while no handler is
// listening yet. VS Code only buffers postMessage until the iframe loads, not
// until a listener exists, so those replies used to be dropped — and App's own
// READY is discarded by the extension as an in-page duplicate, so nothing ever
// re-sent them. The panel then never learned its client id and the HTML
// handshake watchdog fired. The standalone shim has its own equivalent buffer
// (it holds inbound messages until React posts READY), so this is panel-only.
let bufferedEvents: MessageEvent[] | undefined;

function bufferEvent(event: MessageEvent): void {
  bufferedEvents?.push(event);
}

/** Starts buffering inbound panel messages. Call before the early READY. */
export function startPanelInboundBuffer(): void {
  if (isStandalone || bufferedEvents) return;
  bufferedEvents = [];
  window.addEventListener("message", bufferEvent);
}

/**
 * Stops buffering and returns everything received so far, oldest first.
 * The caller must attach its own listener in the same synchronous turn so no
 * message can fall between the two. Returns [] when nothing was buffering.
 */
export function drainPanelInboundBuffer(): MessageEvent[] {
  if (!bufferedEvents) return [];
  window.removeEventListener("message", bufferEvent);
  const events = bufferedEvents;
  bufferedEvents = undefined;
  return events;
}
