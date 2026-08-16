import { useEffect, useRef } from "react";
import { useUiStore } from "@store/uiStore";
import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";

/** How long to wait before reissuing a duplicate request. */
export const DUPLICATE_WORKFLOW_RETRY_INTERVAL_MS = 15000;
/** Number of reissues before the request is retired. */
export const DUPLICATE_WORKFLOW_MAX_RETRIES = 4;

const DUPLICATE_WORKFLOW_RETRY_ERROR =
  "Couldn't create workflow variant — check the connection and try again.";

/**
 * Reissues a pending duplicate request because hosted transports deliberately
 * drop outbound messages while disconnected. The requestId and full payload
 * stay unchanged so backend retries are safely idempotent.
 */
export function useDuplicateWorkflowWatchdog(): void {
  const request = useUiStore((state) => state.duplicateWorkflowRequest);
  const retriesRef = useRef(0);

  useEffect(() => {
    retriesRef.current = 0;
    if (!request) return;

    const timer = window.setInterval(() => {
      const ui = useUiStore.getState();
      if (ui.duplicateWorkflowRequest?.requestId !== request.requestId) {
        return;
      }

      if (retriesRef.current >= DUPLICATE_WORKFLOW_MAX_RETRIES) {
        WebviewLog.warn(
          `[duplicateWorkflowWatchdog] giving up on request ${request.requestId} ` +
            `after ${DUPLICATE_WORKFLOW_MAX_RETRIES} reissues`
        );
        ui.retireDuplicateWorkflowRequest(DUPLICATE_WORKFLOW_RETRY_ERROR);
        return;
      }

      retriesRef.current += 1;
      WebviewLog.warn(
        `[duplicateWorkflowWatchdog] reissue ${retriesRef.current}/` +
          `${DUPLICATE_WORKFLOW_MAX_RETRIES} for request ${request.requestId}`
      );
      getVsCodeApi().postMessage({
        type: MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT,
        ...request,
      });
    }, DUPLICATE_WORKFLOW_RETRY_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [request]);
}
