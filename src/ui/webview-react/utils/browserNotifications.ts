import { EXECUTION_STATES, NOTIFICATION_EVENT_MODES } from "@root/types/DashboardConstants";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

const notifiedKeys = new Set<string>();

/**
 * Show a browser system notification for a workflow terminal state, if the
 * user's notification settings permit it.
 *
 * Must be called from within a message event handler (not a user gesture), so
 * it relies on a prior `Notification.requestPermission()` having been accepted.
 */
export function showBrowserWorkflowNotification(
  state: string,
  workflowId: string,
  fullSettings: FullGlobalSettings | null,
  workflowName?: string | null
): void {
  const notif = fullSettings?.settings.notifications;
  if (!notif) return;
  if (notif.browser.mode === "never") return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

  const mode = notif.events.workflowComplete;
  if (mode === NOTIFICATION_EVENT_MODES.NEVER) return;
  if (
    mode === NOTIFICATION_EVENT_MODES.FAILURES_ONLY &&
    state !== EXECUTION_STATES.ERROR
  ) {
    return;
  }

  const key = `${workflowId}:workflowComplete`;
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);

  const displayName =
    notif.includeWorkflowName && workflowName ? workflowName : undefined;

  if (state === EXECUTION_STATES.COMPLETED) {
    const title = "FlightPath — Workflow Complete";
    const body = displayName ?? "Workflow completed successfully.";
    new Notification(title, { body, icon: "/flightpath-icon.svg" });
  } else {
    const title = "FlightPath — Workflow Failed";
    const body = displayName ?? "Workflow failed.";
    new Notification(title, { body, icon: "/flightpath-icon.svg" });
  }
}
