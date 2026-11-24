import { useCallback, useEffect, useRef, useState } from "react";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useUiStore, type HarnessDetectionRetryResult } from "@store/uiStore";
import { notifyUser } from "@utils/notifyUser";
import { HARNESS_DISPLAY_NAMES } from "@utils/harnessDisplayNames";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  type HarnessId,
  type UserFeedbackSeverity,
} from "@root/types/DashboardConstants";

/**
 * Longer than one `--version` probe's own timeout (every harness is probed in
 * parallel), so only a request that never reached the extension — or whose
 * reply was lost while the hosted socket was down — retires this way.
 */
export const HARNESS_DETECTION_RETRY_TIMEOUT_MS = 45_000;

let retryRequestCounter = 0;

function nextRetryRequestId(): string {
  retryRequestCounter += 1;
  return `harness-detection-retry-${Date.now()}-${retryRequestCounter}`;
}

function joinHarnessNames(harnesses: readonly HarnessId[]): string {
  return harnesses.map((id) => HARNESS_DISPLAY_NAMES[id] ?? id).join(", ");
}

/**
 * The toast for a finished retry. It names what was found rather than only
 * reporting that the check ran: "completed" reads as success even when the
 * CLI is still missing.
 */
export function describeHarnessDetectionRetry(
  result: HarnessDetectionRetryResult,
  focusHarness?: HarnessId
): { message: string; severity: UserFeedbackSeverity } {
  if (!result.success) {
    return {
      message: result.error || "Harness detection retry failed",
      severity: USER_FEEDBACK_SEVERITY.ERROR,
    };
  }

  const available = result.availableHarnesses ?? [];
  if (available.length === 0) {
    return {
      message:
        "No CLI coding agent was found. Install one, make sure it is on your PATH, then check again.",
      severity: USER_FEEDBACK_SEVERITY.WARNING,
    };
  }

  if (focusHarness && !available.includes(focusHarness)) {
    const focusName = HARNESS_DISPLAY_NAMES[focusHarness] ?? focusHarness;
    return {
      message: `${focusName} is still not available. Detected: ${joinHarnessNames(available)}.`,
      severity: USER_FEEDBACK_SEVERITY.WARNING,
    };
  }

  return {
    message: focusHarness
      ? `${HARNESS_DISPLAY_NAMES[focusHarness] ?? focusHarness} is available.`
      : `Detected: ${joinHarnessNames(available)}.`,
    severity: USER_FEEDBACK_SEVERITY.SUCCESS,
  };
}

/**
 * Asks the extension to re-detect every harness CLI and toasts the outcome.
 * Fresh availability reaches `settingsStore.harnessStatus` through the normal
 * status broadcast, so surfaces keyed on it (the "No CLI coding agent"
 * guidance, status dots) update on their own; this hook only owns the
 * pending state and the toast. `focusHarness` tailors the toast to the
 * harness the caller is showing.
 */
export function useHarnessDetectionRetry(focusHarness?: HarnessId): {
  retrying: boolean;
  retry: () => void;
} {
  const [retrying, setRetrying] = useState(false);
  const pendingRequestId = useRef<string | null>(null);
  const retryResult = useUiStore((state) => state.harnessDetectionRetryResult);
  const focusHarnessRef = useRef(focusHarness);
  focusHarnessRef.current = focusHarness;

  useEffect(() => {
    if (!retryResult || retryResult.requestId !== pendingRequestId.current) {
      return;
    }
    pendingRequestId.current = null;
    setRetrying(false);
    useUiStore.getState().setHarnessDetectionRetryResult(null);
    const { message, severity } = describeHarnessDetectionRetry(
      retryResult,
      focusHarnessRef.current
    );
    notifyUser(message, severity);
  }, [retryResult]);

  useEffect(() => {
    if (!retrying) {
      return;
    }
    const timer = setTimeout(() => {
      pendingRequestId.current = null;
      setRetrying(false);
      notifyUser(
        "Harness detection did not respond. Try again.",
        USER_FEEDBACK_SEVERITY.ERROR
      );
    }, HARNESS_DETECTION_RETRY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [retrying]);

  const retry = useCallback(() => {
    if (pendingRequestId.current) {
      return;
    }
    const requestId = nextRetryRequestId();
    pendingRequestId.current = requestId;
    setRetrying(true);
    getVsCodeApi().postMessage({
      type: MESSAGE_TYPES.RETRY_HARNESS_DETECTION,
      requestId,
    });
  }, []);

  return { retrying, retry };
}
