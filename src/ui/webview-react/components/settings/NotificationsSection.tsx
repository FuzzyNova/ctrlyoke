import { useEffect, useState } from "react";
import {
  BROWSER_NOTIFICATION_MODES,
  NOTIFICATION_EVENT_MODES,
  HOOK_EVENT_METADATA,
  HOOK_EVENT_ORDER,
} from "@root/types/DashboardConstants";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import {
  disablePushNotifications,
  enableBrowserNotifications,
  getBrowserNotificationStatus,
  type BrowserNotificationStatus,
} from "@utils/browserNotifications";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
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

export function NotificationsSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const notif = settings.settings.notifications;
  const server = settings.settings.server;
  const sources = settings.sources as Record<string, SettingSource>;
  const setGlobalSettingsTab = useUiStore((s) => s.setGlobalSettingsTab);
  const [status, setStatus] = useState<BrowserNotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const rowProps = { sources, onReset, activeScope };

  const browserModeEnabled =
    notif.browser.mode !== BROWSER_NOTIFICATION_MODES.NEVER;
  const needsHttps = browserModeEnabled && !server.tls.enabled;
  const isIos = /iP(hone|ad)/.test(navigator.userAgent);
  const isIosHomeScreenApp =
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true || window.matchMedia("(display-mode: standalone)").matches;
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
          className: "text-indicator-success",
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
    (!status ||
      status.permission !== "granted" ||
      notif.browser.mode !== BROWSER_NOTIFICATION_MODES.PUSH ||
      !status.subscribed);

  return (
    <div className="space-y-6">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Notifications
      </h3>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Channels
        </h4>

        <SettingToggleRow
          label="VS Code toasts"
          description="Show notification popups in the VS Code window when workflows complete."
          checked={notif.vscode.enabled}
          onChange={(value) => onUpdate("notifications.vscode.enabled", value)}
          path="notifications.vscode.enabled"
          {...rowProps}
        />

        <SettingInputRow
          label="Browser notifications"
          id="notif-browser-mode"
          path="notifications.browser.mode"
          {...rowProps}
        >
          <CustomSelect
            id="notif-browser-mode"
            value={notif.browser.mode}
            onChange={(value) => onUpdate("notifications.browser.mode", value)}
            options={BROWSER_MODE_OPTIONS}
          />
          <div className="mt-1 space-y-1 text-xs text-description-fg">
            <p>
              Browser notifications deliver ctrlyoke alerts through the hosted
              dashboard, including on your phone. Choose a mode here, then open
              ctrlyoke on your phone and allow notifications there.
            </p>
            <p>
              Phone notifications require HTTPS.
              {!isStandalone ? (
                <>
                  {" "}
                  Enable it in the{" "}
                  <button
                    type="button"
                    onClick={() => setGlobalSettingsTab("server")}
                    className="text-link-fg hover:underline"
                  >
                    Server settings
                  </button>
                  .
                </>
              ) : (
                " Enable HTTPS on the hosted server."
              )}
            </p>
          </div>
        </SettingInputRow>

        {browserModeEnabled ? (
          <div className="space-y-2 rounded border border-panel-border p-3">
            {iosBlocksBrowserNotifications ? (
              <p className="text-xs text-description-fg">
                Browser notifications on iPhone and iPad require ctrlyoke to
                be added to the Home Screen first. After adding, open ctrlyoke
                from the Home Screen
                {notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH
                  ? " and then enable push notifications here."
                  : " to enable notifications."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-description-fg">
                    Permission:
                  </span>
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
                      className={`text-xs ${status?.subscribed ? "text-indicator-success" : "text-warning-fg"}`}
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
                Phone notifications require HTTPS. Enable server TLS or use a
                secure tunnel.
              </p>
            ) : null}

            {notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH &&
            status &&
            !status.secureContext ? (
              <p className="text-xs text-warning-fg">
                Push subscriptions require a secure context. Use HTTPS or
                localhost.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Events
        </h4>

        <SettingInputRow
          label="Workflow complete"
          id="notif-workflow-complete"
          path="notifications.events.workflowComplete"
          {...rowProps}
        >
          <CustomSelect
            id="notif-workflow-complete"
            value={notif.events.workflowComplete}
            onChange={(value) =>
              onUpdate("notifications.events.workflowComplete", value)
            }
            options={EVENT_MODE_OPTIONS}
          />
        </SettingInputRow>

        <SettingInputRow
          label="Prompt complete"
          id="notif-prompt-complete"
          path="notifications.events.promptComplete"
          {...rowProps}
        >
          <CustomSelect
            id="notif-prompt-complete"
            value={notif.events.promptComplete}
            onChange={(value) =>
              onUpdate("notifications.events.promptComplete", value)
            }
            options={EVENT_MODE_OPTIONS}
          />
        </SettingInputRow>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Hook Events
        </h4>
        <p className="text-xs text-description-fg">
          Opt in to notifications for AI CLI hook events. Requires the
          corresponding harness to support each event.
        </p>
        {HOOK_EVENT_ORDER.map((event) => {
          const meta = HOOK_EVENT_METADATA.find((m) => m.event === event);
          if (!meta) return null;
          const checked =
            (notif.events.hookEvents as Record<string, boolean>)[event] ??
            false;
          return (
            <SettingToggleRow
              key={event}
              label={meta.label}
              description={meta.description}
              checked={checked}
              onChange={(value) =>
                onUpdate(`notifications.events.hookEvents.${event}`, value)
              }
              path={`notifications.events.hookEvents.${event}`}
              {...rowProps}
            />
          );
        })}
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Content
        </h4>
        <SettingToggleRow
          label="Include workflow name"
          checked={notif.includeWorkflowName}
          onChange={(value) =>
            onUpdate("notifications.includeWorkflowName", value)
          }
          path="notifications.includeWorkflowName"
          {...rowProps}
        />
        <SettingToggleRow
          label="Include prompt name"
          checked={notif.includePromptName}
          onChange={(value) =>
            onUpdate("notifications.includePromptName", value)
          }
          path="notifications.includePromptName"
          {...rowProps}
        />
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Noise control
        </h4>
        <SettingToggleRow
          label="Only notify when ctrlyoke is not focused"
          description="Suppress notifications while the VS Code window or hosted dashboard is focused."
          checked={notif.onlyWhenWindowUnfocused}
          onChange={(value) =>
            onUpdate("notifications.onlyWhenWindowUnfocused", value)
          }
          path="notifications.onlyWhenWindowUnfocused"
          {...rowProps}
        />
      </div>
    </div>
  );
}
