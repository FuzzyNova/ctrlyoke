import { useState, useEffect } from "react";
import {
  NOTIFICATION_EVENT_MODES,
  BROWSER_NOTIFICATION_MODES,
} from "@root/types/DashboardConstants";
import { CustomSelect } from "../shared/CustomSelect";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { isStandalone } from "@hooks/useVsCodeApi";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

function ToggleRow({ label, description, checked, onChange, disabled }: ToggleRowProps) {
  return (
    <label
      className={`flex items-start gap-3 py-2 group ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className={`mt-0.5 w-4 h-4 accent-focus-border shrink-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground">{label}</span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">{description}</span>
        )}
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
  { value: BROWSER_NOTIFICATION_MODES.CONNECTED_ONLY, label: "While dashboard is open" },
  { value: BROWSER_NOTIFICATION_MODES.PUSH, label: "Push when backgrounded" },
];

type BrowserPermission = "unsupported" | "blocked" | "needs-permission" | "granted" | "unknown";

function getBrowserPermission(): BrowserPermission {
  if (!("Notification" in window)) return "unsupported";
  switch (Notification.permission) {
    case "granted": return "granted";
    case "denied": return "blocked";
    default: return "needs-permission";
  }
}

export function NotificationsSection({ settings, onUpdate }: Props) {
  const notif = settings.settings.notifications;
  const server = settings.settings.server;
  const s = "user" as const;

  const [browserPermission, setBrowserPermission] = useState<BrowserPermission>("unknown");
  const [requestingPermission, setRequestingPermission] = useState(false);

  useEffect(() => {
    setBrowserPermission(getBrowserPermission());
  }, []);

  async function handleRequestPermission() {
    if (!("Notification" in window)) return;
    setRequestingPermission(true);
    try {
      const result = await Notification.requestPermission();
      setBrowserPermission(result === "granted" ? "granted" : result === "denied" ? "blocked" : "needs-permission");
    } finally {
      setRequestingPermission(false);
    }
  }

  const browserModeNotNever = notif.browser.mode !== BROWSER_NOTIFICATION_MODES.NEVER;
  const needsHttps = browserModeNotNever && !server.tls.enabled;
  const isIos = /iP(hone|ad)/.test(navigator.userAgent);
  const isStandaloneMode = isStandalone || (window.navigator as any).standalone === true;

  function permissionLabel(): { text: string; cls: string } {
    switch (browserPermission) {
      case "unsupported": return { text: "Not supported in this browser", cls: "text-description-fg" };
      case "blocked": return { text: "Blocked — allow in browser settings", cls: "text-error-fg" };
      case "needs-permission": return { text: "Permission not yet granted", cls: "text-warning-fg" };
      case "granted": return { text: "Allowed", cls: "text-bash-status-success" };
      default: return { text: "Unknown", cls: "text-description-fg" };
    }
  }

  const perm = permissionLabel();

  return (
    <div className="space-y-6">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Notifications
      </h3>

      {/* ── Channels ──────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Channels
        </h4>

        <ToggleRow
          label="VS Code toasts"
          description="Show notification popups in the VS Code window when workflows complete."
          checked={notif.vscode.enabled}
          onChange={(v) => onUpdate("notifications.vscode.enabled", v, s)}
        />

        <div>
          <label htmlFor="notif-browser-mode" className="block text-xs text-description-fg mb-1">
            Browser notifications
          </label>
          <CustomSelect
            id="notif-browser-mode"
            value={notif.browser.mode}
            onChange={(v) => onUpdate("notifications.browser.mode", v, s)}
            options={BROWSER_MODE_OPTIONS}
          />
          {isStandalone && (
            <p className="text-xs text-description-fg mt-1">
              Browser notifications apply to the hosted server dashboard, not the VS Code sidebar.
            </p>
          )}
        </div>

        {/* Browser permission status */}
        {browserModeNotNever && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-description-fg">Permission:</span>
              <span className={`text-xs ${perm.cls}`}>{perm.text}</span>
            </div>

            {browserPermission === "needs-permission" && (
              <button
                className="px-2 py-1 text-xs bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border rounded hover:bg-btn-secondary-hover disabled:opacity-50"
                onClick={handleRequestPermission}
                disabled={requestingPermission}
              >
                {requestingPermission ? "Requesting…" : "Enable browser notifications"}
              </button>
            )}

            {needsHttps && (
              <p className="text-xs text-warning-fg">
                Phone notifications require HTTPS. Enable server TLS or use a secure tunnel.
              </p>
            )}

            {isIos && !isStandaloneMode && (
              <p className="text-xs text-description-fg">
                For iPhone/iPad push while backgrounded, add FlightPath to the Home Screen first.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Events ────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Events
        </h4>

        <div>
          <label htmlFor="notif-workflow-complete" className="block text-xs text-description-fg mb-1">
            Workflow complete
          </label>
          <CustomSelect
            id="notif-workflow-complete"
            value={notif.events.workflowComplete}
            onChange={(v) => onUpdate("notifications.events.workflowComplete", v, s)}
            options={EVENT_MODE_OPTIONS}
          />
        </div>

        <div>
          <label htmlFor="notif-prompt-complete" className="block text-xs text-description-fg mb-1">
            Prompt complete
          </label>
          <CustomSelect
            id="notif-prompt-complete"
            value={notif.events.promptComplete}
            onChange={(v) => onUpdate("notifications.events.promptComplete", v, s)}
            options={EVENT_MODE_OPTIONS}
          />
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide mb-1">
          Content
        </h4>
        <ToggleRow
          label="Include workflow name"
          checked={notif.includeWorkflowName}
          onChange={(v) => onUpdate("notifications.includeWorkflowName", v, s)}
        />
        <ToggleRow
          label="Include prompt name"
          checked={notif.includePromptName}
          onChange={(v) => onUpdate("notifications.includePromptName", v, s)}
        />
      </div>

      {/* ── Noise control ─────────────────────────────────────────────────── */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-description-fg tracking-wide mb-1">
          Noise control
        </h4>
        <ToggleRow
          label="Only notify when FlightPath is not focused"
          description="Suppress notifications while the VS Code window or dashboard is in focus."
          checked={notif.onlyWhenWindowUnfocused}
          onChange={(v) => onUpdate("notifications.onlyWhenWindowUnfocused", v, s)}
        />
      </div>
    </div>
  );
}
