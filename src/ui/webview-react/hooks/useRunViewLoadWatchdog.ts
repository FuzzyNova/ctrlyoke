import { useEffect, useRef } from "react";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
} from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";

/** How long to wait for a RUN_VIEW_LOADED before reissuing the request. */
const RUN_VIEW_RETRY_INTERVAL_MS = 15000;
/** Reissues before giving up. Total patience ≈ interval × (attempts + 1). */
const RUN_VIEW_MAX_RETRIES = 4;

/**
 * Bounds the lifetime of `uiStore.pendingRunViewRequestId`.
 *
 * A pending run-view request suppresses every *requestless* RUN_VIEW_LOADED —
 * that is how an in-flight switch avoids being overwritten by a straggling push
 * about the workflow it is leaving. The cost is that a request which never gets
 * answered silently disables all server-initiated view updates: definition
 * mutations from another client, draft→run promotions, and rewind
 * invalidations all stop landing, and for a cross-lineage switch the
 * interaction-blocking `WorkflowSwitchOverlay` stays up on top of it.
 *
 * That is not hypothetical on the hosted server. `standalone-shim.js` drops any
 * outbound message posted while the socket is down (deliberately — replaying a
 * pre-outage "Re-run" click into a freshly started extension host once launched
 * a workflow with no user action), so a LOAD_RUN_VIEW tapped during one of the
 * reconnect gaps a mobile browser produces never reaches the extension at all,
 * and nothing answers it. The backend's own recovery valve — the requestless
 * ACTIVE_WORKFLOW_CHANGED that a client-ready replay announces — only fires if
 * a reconnect actually completes a preferred-address replay, so it cannot be
 * the only escape.
 *
 * Reissuing on an interval is what makes a flaky link self-heal: each tick is a
 * cheap no-op while the socket is down and lands the moment it is back. The
 * request keeps its original id, so a late answer to *either* send still
 * satisfies RUN_VIEW_LOADED's requestId check. After `RUN_VIEW_MAX_RETRIES` the
 * request is retired rather than left outstanding forever — giving up restores
 * server pushes and re-arms `navigateToWorkflowAddress` (which short-circuits
 * only when the target is both displayed *and* applied with nothing pending),
 * so clicking the workflow again is a real retry rather than an inert click.
 */
export function useRunViewLoadWatchdog(): void {
  const requestId = useUiStore((s) => s.pendingRunViewRequestId);
  const address = useUiStore((s) => s.pendingRunViewAddress);
  const retriesRef = useRef(0);

  useEffect(() => {
    retriesRef.current = 0;
    if (!requestId || !address) return;

    const timer = setInterval(() => {
      const ui = useUiStore.getState();
      // A newer request (or a snapshot that landed between ticks) already
      // retired this one; the effect re-runs with the new id.
      if (ui.pendingRunViewRequestId !== requestId) return;

      if (retriesRef.current >= RUN_VIEW_MAX_RETRIES) {
        WebviewLog.warn(
          `[runViewWatchdog] giving up on request ${requestId} after ` +
            `${RUN_VIEW_MAX_RETRIES} reissues — rolling back to the view the ` +
            `client is actually showing so server-initiated updates resume`
        );
        // Roll back rather than merely retire: the request moved the address
        // optimistically, so simply dropping it would leave the header naming
        // the workflow that failed to load while the panels still render the
        // previous one, with every addressed control aimed at the wrong
        // lineage. A failed navigation must end somewhere coherent.
        ui.rollbackRunViewLoad();
        ui.showToast(
          "Couldn't load that workflow — check the connection and try again.",
          USER_FEEDBACK_SEVERITY.ERROR
        );
        return;
      }

      retriesRef.current += 1;
      WebviewLog.warn(
        `[runViewWatchdog] RUN_VIEW_LOADED for request ${requestId} has not ` +
          `arrived — reissue ${retriesRef.current}/${RUN_VIEW_MAX_RETRIES}`
      );
      ui.markRunViewLoadRetrying();
      // Resolved at fire time: the API object can be replaced by a reconnect.
      getVsCodeApi().postMessage({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address,
        requestId,
      });
    }, RUN_VIEW_RETRY_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [requestId, address]);
}
