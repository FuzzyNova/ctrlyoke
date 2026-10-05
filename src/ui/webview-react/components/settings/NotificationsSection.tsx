import { useEffect, useState } from "react";
import {
  BROWSER_NOTIFICATION_MODES,
  BROWSER_NOTIFICATION_PERMISSION_STATES,
  LICENSE_UI,
  HOOK_EVENT_METADATA,
  HOOK_EVENT_ORDER,
} from "@root/types/DashboardConstants";
import {
  BROWSER_NOTIFICATION_MODE_OPTIONS_META,
  NOTIFICATION_EVENT_MODE_OPTIONS_META,
  TOAST_LEVEL_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { isStandalone } from "@hooks/useVsCodeApi";
import { isIosDevice } from "@utils/platform";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
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
  const hasRemoteAccess = useSettingsStore(
    (s) => s.licenseAccess.hasRemoteAccess
  );
  const [status, setStatus] = useState<BrowserNotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const rowProps = { sources, onReset, activeScope };

  const browserModeEnabled =
    notif.browser.mode !== BROWSER_NOTIFICATION_MODES.NEVER;
  const needsHttps = browserModeEnabled && !server.tls.enabled;
  const isIosHomeScreenApp =
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true || window.matchMedia("(display-mode: standalone)").matches;
  const iosBlocksBrowserNotifications = isIosDevice() && !isIosHomeScreenApp;

  useEffect(() => {
    if (!browserModeEnabled || !isStandalone) {
      setStatus(null);
      return;
    }

    void refreshStatus();
  }, [browserModeEnabled, notif.browser.mode, hasRemoteAccess]);

  async function refreshStatus() {
    setStatus(await getBrowserNotificationStatus());
  }

  async function handleEnableBrowserNotifications() {
    if (
      notif.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH &&
      !hasRemoteAccess
    ) {
      return;
    }
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
      case BROWSER_NOTIFICATION_PERMISSION_STATES.UNSUPPORTED:
        return {
          text: "Not supported in this browser",
          className: "text-description-fg",
        };
      case BROWSER_NOTIFICATION_PERMISSION_STATES.BLOCKED:
        return {
          text: "Blocked - allow in browser settings",
          className: "text-error-fg",
        };
      case BROWSER_NOTIFICATION_PERMISSION_STATES.NEEDS_PERMISSION:
        return {
          text: "Permission not yet granted",
          className: "text-warning-fg",
        };
      case BROWSER_NOTIFICATION_PERMISSION_STATES.GRANTED:
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
    hasRemoteAccess &&
    status?.pushSupported &&
    status.secureContext;
  const showEnableButton =
    isStandalone &&
    browserModeEnabled &&
    (notif.browser.mode !== BROWSER_NOTIFICATION_MODES.PUSH ||
      hasRemoteAccess) &&
    (!status ||
      status.permission !== BROWSER_NOTIFICATION_PERMISSION_STATES.GRANTED ||
      notif.browser.mode !== BROWSER_NOTIFICATION_MODES.PUSH ||
      !status.subscribed);
  const browserModeOptions = toSelectOptions(
    BROWSER_NOTIFICATION_MODE_OPTIONS_META,
    "notifications.browser.mode"
  ).map((option) =>
    option.value === BROWSER_NOTIFICATION_MODES.PUSH
      ? { ...option, disabled: !hasRemoteAccess }
      : option
  );

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
          settingKey="notifications.vscode.enabled"
          checked={notif.vscode.enabled}
          onChange={(value) => onUpdate("notifications.vscode.enabled", value)}
          {...rowProps}
        />

        <SettingInputRow
          settingKey="notifications.browser.mode"
          id="notif-browser-mode"
          {...rowProps}
        >
          <CustomSelect
            id="notif-browser-mode"
            value={notif.browser.mode}
            onChange={(value) => onUpdate("notifications.browser.mode", value)}
            schemaPath="notifications.browser.mode"
            options={browserModeOptions}
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
            {!hasRemoteAccess && (
              <p>
                Push-to-phone notifications are available during the
                remote-access trial and with Pro.{" "}
                <a
                  href={LICENSE_UI.PRICING_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link-fg hover:underline"
                >
                  View Pro pricing
                </a>
              </p>
            )}
          </div>
        </SettingInputRow>

        {browserModeEnabled ? (
          <div className="space-y-2 rounded border border-panel-border p-3">
            {iosBlocksBrowserNotifications ? (
              <p className="text-xs text-description-fg">
                Browser notifications on iPhone and iPad require ctrlyoke to be
                added to the Home Screen first. After adding, open ctrlyoke from
                the Home Screen
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
          settingKey="notifications.events.workflowComplete"
          id="notif-workflow-complete"
          {...rowProps}
        >
          <CustomSelect
            id="notif-workflow-complete"
            value={notif.events.workflowComplete}
            onChange={(value) =>
              onUpdate("notifications.events.workflowComplete", value)
            }
            schemaPath="notifications.events.workflowComplete"
            options={toSelectOptions(
              NOTIFICATION_EVENT_MODE_OPTIONS_META,
              "notifications.events.workflowComplete"
            )}
          />
        </SettingInputRow>

        <SettingInputRow
          settingKey="notifications.events.promptComplete"
          id="notif-prompt-complete"
          {...rowProps}
        >
          <CustomSelect
            id="notif-prompt-complete"
            value={notif.events.promptComplete}
            onChange={(value) =>
              onUpdate("notifications.events.promptComplete", value)
            }
            schemaPath="notifications.events.promptComplete"
            options={toSelectOptions(
              NOTIFICATION_EVENT_MODE_OPTIONS_META,
              "notifications.events.promptComplete"
            )}
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
              settingKey={`notifications.events.hookEvents.${event}`}
              key={event}
              checked={checked}
              onChange={(value) =>
                onUpdate(`notifications.events.hookEvents.${event}`, value)
              }
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
          settingKey="notifications.includeWorkflowName"
          checked={notif.includeWorkflowName}
          onChange={(value) =>
            onUpdate("notifications.includeWorkflowName", value)
          }
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="notifications.includePromptName"
          checked={notif.includePromptName}
          onChange={(value) =>
            onUpdate("notifications.includePromptName", value)
          }
          {...rowProps}
        />
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Noise control
        </h4>
        <SettingInputRow
          settingKey="notifications.toastLevel"
          id="notif-toast-level"
          {...rowProps}
        >
          <CustomSelect
            id="notif-toast-level"
            value={notif.toastLevel}
            onChange={(value) => onUpdate("notifications.toastLevel", value)}
            schemaPath="notifications.toastLevel"
            options={toSelectOptions(
              TOAST_LEVEL_OPTIONS_META,
              "notifications.toastLevel"
            )}
          />
          <p className="mt-1 text-xs text-description-fg">
            Controls in-app and native popups for action results (save failed,
            validation errors, and similar) — separate from the completion
            notifications configured above.
          </p>
        </SettingInputRow>
        <SettingToggleRow
          settingKey="notifications.onlyWhenWindowUnfocused"
          checked={notif.onlyWhenWindowUnfocused}
          onChange={(value) =>
            onUpdate("notifications.onlyWhenWindowUnfocused", value)
          }
          {...rowProps}
        />
      </div>
    </div>
  );
}
