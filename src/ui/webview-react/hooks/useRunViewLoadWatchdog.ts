import { useEffect, useRef } from "react";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
} from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { notifyUser } from "@utils/notifyUser";

declare global {
  interface Window {
    __ctrlyokeStandalone?: boolean;
    __ctrlyokeTransportConnected?: boolean;
  }
}

const RUN_VIEW_DISCONNECTED_GIVE_UP_MS = 75000;

/**
 * Run-view messages are reliable in the VS Code panel, so time cannot tell us
 * that one was dropped. Hosted transport reports a successful reconnect through
 * CLIENT_ID_ASSIGNED; only that event should reissue the pending request.
 */
export function useRunViewLoadWatchdog(): void {
  const requestId = useUiStore((s) => s.pendingRunViewRequestId);
  const address = useUiStore((s) => s.pendingRunViewAddress);
  const disconnectedSinceRef = useRef<number | null>(null);

  useEffect(() => {
    disconnectedSinceRef.current = null;
    if (!requestId || !address || !window.__ctrlyokeStandalone) return;

    const timer = setInterval(() => {
      const ui = useUiStore.getState();
      if (ui.pendingRunViewRequestId !== requestId) return;
      // A slow but healthy load is never a connection failure. Only retire the
      // optimistic navigation after the hosted socket has stayed down.
      if (window.__ctrlyokeTransportConnected !== false) {
        disconnectedSinceRef.current = null;
        return;
      }
      const now = Date.now();
      disconnectedSinceRef.current ??= now;
      if (now - disconnectedSinceRef.current < RUN_VIEW_DISCONNECTED_GIVE_UP_MS) {
        return;
      }
      WebviewLog.warn(
        `[runViewWatchdog] hosted transport stayed disconnected — retiring ${requestId}`
      );
      ui.rollbackRunViewLoad();
      notifyUser(
        "Couldn't load that workflow — check the connection and try again.",
        USER_FEEDBACK_SEVERITY.ERROR
      );
    }, 1000);

    return () => clearInterval(timer);
  }, [requestId, address]);
}

/** Reissue only when hosted READY confirms that its socket is back. */
export function reissueRunViewLoadAfterHostedReconnect(): void {
  if (!window.__ctrlyokeStandalone) return;
  const { pendingRunViewRequestId: requestId, pendingRunViewAddress: address } =
    useUiStore.getState();
  if (!requestId || !address) return;
  WebviewLog.info(
    `[runViewWatchdog] hosted transport reconnected — reissuing ${requestId}`
  );
  getVsCodeApi().postMessage({
    type: MESSAGE_TYPES.LOAD_RUN_VIEW,
    address,
    requestId,
  });
}
