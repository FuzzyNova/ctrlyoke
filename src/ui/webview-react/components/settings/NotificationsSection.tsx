import { useEffect, useState } from "react";
import {
  BROWSER_NOTIFICATION_MODES,
  NOTIFICATION_EVENT_MODES,
} from "@root/types/DashboardConstants";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { isStandalone } from "@hooks/useVsCodeApi";
import { CustomSelect } from "../shared/CustomSelect";
import {
  disablePushNotifications,
  enableBrowserNotifications,
  getBrowserNotificationStatus,
  type BrowserNotificationStatus,
} from "@utils/browserNotifications";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: ToggleRowProps) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-focus-border shrink-0"
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground">{label}</span>
        {description ? (
          <span className="text-xs text-description-fg mt-0.5">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

const EVENT_MODE_OPTIONS = [
  { value: NOTIFICATION_EVENT_MODES.ALL, label: "Success and failure" },
  { value: NOTIFICATION_EVENT_MODES.FAILURES_ONLY, label: "Failures only" },
  { value: NOTIFICATION_EVENT_MODES.NEVER, label: "Off" },
];

const BROWSER_MODE_OPTIONS = [
  { value: BROWSER_NOTIFICATION_MODES.NEVER, label: "Off" },
  {
    value: BROWSER_NOTIFICATION_MODES.CONNECTED_ONLY,
    label: "While dashboard is open",
  },
  {
    value: BROWSER_NOTIFICATION_MODES.PUSH,
    label: "Push when backgrounded",
  },
];

export function NotificationsSection({ settings, onUpdate }: Props) {
  const notif = settings.settings.notifications;
  const server = settings.settings.server;
  const scope = "user" as const;
  const [status, setStatus] = useState<BrowserNotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const browserModeEnabled =
    notif.browser.mode !== BROWSER_NOTIFICATION_MODES.NEVER;
  const needsHttps = browserModeEnabled && !server.tls.enabled;
  const isIos = /iP(hone|ad)/.test(navigator.userAgent);
  const isIosHomeScreenApp =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  // On iOS, Notification.requestPermission() is only available from a Home Screen app.
  // In a regular browser tab it silently returns "denied" without showing a dialog.
  const iosBlocksBrowserNotifications = isIos && !isIosHomeScreenApp;

  useEffect(() => {
    if (!browserModeEnabled || !isStandalone) {
      setStatus(null);
      return;
    }

    void refreshStatus();
  }, [browserModeEnabled, notif.browser.mode]);

  async function refreshStatus() {
    setStatus(await getBrowserNotificationStatus());
  }

  async function handleEnableBrowserNotifications() {
    setBusy(true);
    try {
      setStatus(await enableBrowserNotifications(notif.browser.mode));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisablePush() {
    setBusy(true);
    try {
      setStatus(await disablePushNotifications());
    } finally {
      setBusy(false);
    }
  }

  function renderPermissionLabel() {
    switch (status?.permission) {
      case "unsupported":
        return {
          text: "Not supported in this browser",
          className: "text-description-fg",
        };
      case "blocked":
        return {
          text: "Blocked - allow in browser settings",
          className: "text-error-fg",
        };
      case "needs-permission":
        return {
          text: "Permission not yet granted",
          className: "text-warning-fg",
        };
      case "granted":
        return {
          text: "Allowed",
          className: "text-bash-status-success",
        };
      default:
        return {
          text: "Hosted dashboard only",
          className: "text-description-fg",
        };
    }
  }

  const permission = renderPermissionLabel();
  const canManagePush =
    isStandalone &&
    notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH &&
    status?.pushSupported &&
    status.secureContext;
  const showEnableButton =
    isStandalone &&
    browserModeEnabled &&
    (!status || status.permission !== "granted" || notif.browser.mode !== BROWSER_NOTIFICATION_MODES.PUSH || !status.subscribed);

  return (
    <div className="space-y-6">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Notifications
      </h3>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Channels
        </h4>

        <ToggleRow
          label="VS Code toasts"
          description="Show notification popups in the VS Code window when workflows complete."
          checked={notif.vscode.enabled}
          onChange={(value) => onUpdate("notifications.vscode.enabled", value, scope)}
        />

        <div>
          <label
            htmlFor="notif-browser-mode"
            className="block text-xs text-description-fg mb-1"
          >
            Browser notifications
          </label>
          <CustomSelect
            id="notif-browser-mode"
            value={notif.browser.mode}
            onChange={(value) =>
              onUpdate("notifications.browser.mode", value, scope)
            }
            options={BROWSER_MODE_OPTIONS}
          />
          {!isStandalone ? (
            <p className="text-xs text-description-fg mt-1">
              Browser notifications apply to the hosted server dashboard, not the
              VS Code sidebar.
            </p>
          ) : null}
        </div>

        {browserModeEnabled ? (
          <div className="space-y-2 rounded border border-panel-border p-3">
            {iosBlocksBrowserNotifications ? (
              <p className="text-xs text-description-fg">
                Browser notifications on iPhone and iPad require FlightPath to be
                added to the Home Screen first. After adding, open FlightPath from
                the Home Screen
                {notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH
                  ? " and then enable push notifications here."
                  : " to enable notifications."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-description-fg">Permission:</span>
                  <span className={`text-xs ${permission.className}`}>
                    {permission.text}
                  </span>
                </div>

                {notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH &&
                isStandalone ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-description-fg">
                      Push subscription:
                    </span>
                    <span
                      className={`text-xs ${status?.subscribed ? "text-bash-status-success" : "text-warning-fg"}`}
                    >
                      {status?.subscribed ? "Subscribed" : "Not subscribed"}
                    </span>
                  </div>
                ) : null}

                {typeof status?.subscriptionCount === "number" ? (
                  <p className="text-xs text-description-fg">
                    Active subscriptions: {status.subscriptionCount}
                    {typeof status.staleSubscriptionCount === "number"
                      ? `, stale: ${status.staleSubscriptionCount}`
                      : ""}
                  </p>
                ) : null}

                {showEnableButton ? (
                  <button
                    type="button"
                    onClick={handleEnableBrowserNotifications}
                    disabled={busy}
                    className="px-2 py-1 text-xs bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border rounded hover:bg-btn-secondary-hover disabled:opacity-50"
                  >
                    {busy
                      ? "Updating..."
                      : notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH
                        ? "Enable push notifications"
                        : "Enable browser notifications"}
                  </button>
                ) : null}

                {canManagePush && status?.subscribed ? (
                  <button
                    type="button"
                    onClick={handleDisablePush}
                    disabled={busy}
                    className="px-2 py-1 text-xs bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border rounded hover:bg-btn-secondary-hover disabled:opacity-50"
                  >
                    {busy ? "Updating..." : "Disable push notifications"}
                  </button>
                ) : null}
              </>
            )}

            {needsHttps ? (
              <p className="text-xs text-warning-fg">
                Phone notifications require HTTPS. Enable server TLS or use a secure
                tunnel.
              </p>
            ) : null}

            {notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH &&
            status &&
            !status.secureContext ? (
              <p className="text-xs text-warning-fg">
                Push subscriptions require a secure context. Use HTTPS or localhost.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Events
        </h4>

        <div>
          <label
            htmlFor="notif-workflow-complete"
            className="block text-xs text-description-fg mb-1"
          >
            Workflow complete
          </label>
          <CustomSelect
            id="notif-workflow-complete"
            value={notif.events.workflowComplete}
            onChange={(value) =>
              onUpdate("notifications.events.workflowComplete", value, scope)
            }
            options={EVENT_MODE_OPTIONS}
          />
        </div>

        <div>
          <label
            htmlFor="notif-prompt-complete"
            className="block text-xs text-description-fg mb-1"
          >
            Prompt complete
          </label>
          <CustomSelect
            id="notif-prompt-complete"
            value={notif.events.promptComplete}
            onChange={(value) =>
              onUpdate("notifications.events.promptComplete", value, scope)
            }
            options={EVENT_MODE_OPTIONS}
          />
        </div>
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Content
        </h4>
        <ToggleRow
          label="Include workflow name"
          checked={notif.includeWorkflowName}
          onChange={(value) =>
            onUpdate("notifications.includeWorkflowName", value, scope)
          }
        />
        <ToggleRow
          label="Include prompt name"
          checked={notif.includePromptName}
          onChange={(value) =>
            onUpdate("notifications.includePromptName", value, scope)
          }
        />
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Noise control
        </h4>
        <ToggleRow
          label="Only notify when FlightPath is not focused"
          description="Suppress notifications while the VS Code window or hosted dashboard is focused."
          checked={notif.onlyWhenWindowUnfocused}
          onChange={(value) =>
            onUpdate("notifications.onlyWhenWindowUnfocused", value, scope)
          }
        />
      </div>
    </div>
  );
}
