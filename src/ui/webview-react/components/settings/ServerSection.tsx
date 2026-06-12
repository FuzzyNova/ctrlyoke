import { useRef, useState, useEffect, useMemo } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@root/types/DashboardConstants";
import {
  ICON_BG_COLOR_DEFAULT,
  ICON_FG_COLOR_DEFAULT,
} from "@root/types/IconColorDefaults";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";
import { LocalNumberInput, LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import appIconSvg from "../../../../../images/flightpath-app-icon.svg?raw";

function buildIconPreviewDataUrl(bgColor: string, fgColor: string): string {
  const svg = appIconSvg
    .replace(new RegExp(ICON_BG_COLOR_DEFAULT, "gi"), bgColor)
    .replace(new RegExp(ICON_FG_COLOR_DEFAULT, "gi"), fgColor);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function ServerSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const server = settings.settings.server;
  const sources = settings.sources as Record<string, SettingSource>;

  const serverRunning = useSettingsStore((state) => state.serverRunning);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const availableIps = useSettingsStore((state) => state.availableIps);
  const selectedDisplayIp = useSettingsStore(
    (state) => state.selectedDisplayIp
  );
  const setSelectedDisplayIp = useSettingsStore(
    (state) => state.setSelectedDisplayIp
  );
  const vscode = useVsCodeApi();

  const rowProps = { sources, onReset, activeScope };

  const showIpSelector =
    server.bindAddress === "0.0.0.0" && availableIps.length > 1;

  const displayUrl = useMemo(() => {
    if (!serverUrl || !selectedDisplayIp) return serverUrl;
    try {
      const u = new URL(serverUrl);
      u.hostname = selectedDisplayIp;
      return u.toString();
    } catch {
      return serverUrl;
    }
  }, [serverUrl, selectedDisplayIp]);

  const certDownloadUrl = useMemo(() => {
    if (!server.tls?.enabled) return null;
    if (isStandalone) {
      return `${window.location.origin}/cert`;
    }
    if (!displayUrl) return null;
    try {
      const u = new URL(displayUrl);
      u.pathname = "/cert";
      u.search = "";
      return u.toString();
    } catch {
      return null;
    }
  }, [server.tls?.enabled, displayUrl]);

  const generatedCertLocation =
    activeScope === SETTING_SCOPES.USER
      ? "~/.flightpath/certs/"
      : ".flightpath/certs/";

  const [showQr, setShowQr] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const displayIpOptions = availableIps.map((ip) => ({ label: ip, value: ip }));
  const bindAddressOptions = [
    { label: "Localhost only (127.0.0.1)", value: "127.0.0.1" },
    { label: "All interfaces (0.0.0.0) — LAN access", value: "0.0.0.0" },
  ];

  // Local color state: onChange updates preview instantly without persisting.
  // onBlur commits via onUpdate, which persists to settings and triggers server-side PNG regeneration.
  const [localBg, setLocalBg] = useState(
    server.iconBgColor ?? ICON_BG_COLOR_DEFAULT
  );
  const [localFg, setLocalFg] = useState(
    server.iconFgColor ?? ICON_FG_COLOR_DEFAULT
  );
  // Sync local state if the persisted value changes externally (e.g., reset or another tab).
  useEffect(() => {
    setLocalBg(server.iconBgColor ?? ICON_BG_COLOR_DEFAULT);
  }, [server.iconBgColor]);
  useEffect(() => {
    setLocalFg(server.iconFgColor ?? ICON_FG_COLOR_DEFAULT);
  }, [server.iconFgColor]);

  useEffect(() => {
    if (showQr && qrCanvasRef.current && displayUrl) {
      import("qrcode").then((QRCode) =>
        QRCode.toCanvas(qrCanvasRef.current!, displayUrl, { width: 200 })
      );
    }
  }, [showQr, displayUrl]);

  function toggleServer(enable: boolean) {
    vscode.postMessage({
      type: enable ? MESSAGE_TYPES.ENABLE_SERVER : MESSAGE_TYPES.DISABLE_SERVER,
    });
  }

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Server
      </h3>

      <div className="space-y-3">
        {/* Enable on launch — server-side only; browser clients cannot change server startup */}
        {!isStandalone && (
          <SettingToggleRow
            label="Enable on launch"
            description="Automatically start the hosted server when FlightPath activates."
            checked={server.enabled}
            onChange={(value) => onUpdate("server.enabled", value)}
            path="server.enabled"
            {...rowProps}
          />
        )}

        {/* Start/stop — server-side only */}
        {!isStandalone && (
          <div className="rounded border border-panel-border p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-foreground">Current session</div>
                <div className="text-xs text-description-fg">
                  {serverRunning
                    ? "Server is running for this VS Code session."
                    : "Server is stopped for this VS Code session."}
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggleServer(!serverRunning)}
                className="px-2 py-1 text-xs bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border rounded hover:bg-btn-secondary-hover"
              >
                {serverRunning ? "Stop server" : "Start server"}
              </button>
            </div>
          </div>
        )}

        {/* URL display, copy, QR, regenerate token — server-side only */}
        {!isStandalone && serverRunning && displayUrl && (
          <div>
            {showIpSelector && (
              <SettingInputRow label="Connect via" id="server-display-ip">
                <CustomSelect
                  id="server-display-ip"
                  value={selectedDisplayIp ?? ""}
                  onChange={setSelectedDisplayIp}
                  options={displayIpOptions}
                  triggerAriaLabel="Choose server connection address"
                  triggerTitle="Choose which detected IP address to display"
                />
              </SettingInputRow>
            )}
            <div className="flex items-center gap-2 p-2 bg-input-bg border border-input-border rounded mt-2">
              <span
                className="w-2 h-2 rounded-full bg-indicator-success shrink-0"
                title="Server running"
              />
              <a
                href={displayUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-link-fg truncate flex-1 hover:underline"
              >
                {displayUrl}
              </a>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(displayUrl)}
                title="Copy URL"
                aria-label="Copy URL"
                className="shrink-0 text-description-fg hover:text-foreground"
              >
                <i className="codicon codicon-copy" />
              </button>
              <button
                type="button"
                onClick={() => setShowQr((v) => !v)}
                title="Show QR code"
                aria-label="Show QR code"
                className="shrink-0 text-description-fg hover:text-foreground"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M0 0h7v7H0V0zm1 1v5h5V1H1zm1 1h3v3H2V2zM9 0h7v7H9V0zm1 1v5h5V1h-5zm1 1h3v3h-3V2zM0 9h7v7H0V9zm1 1v5h5v-5H1zm1 1h3v3H2v-3zm10-1h1v1h-1v-1zm0 2h1v1h-1v-1zm-2 0h1v1h-1v-1zm2 2h1v1h-1v-1zm-2 0h1v1h-1v-1zm4-4h1v1h-1v-1zm0 2h1v1h-1v-1zm0 2h1v1h-1v-1zm-2-4h1v1h-1v-1z" />
                </svg>
              </button>
            </div>

            {showQr && (
              <div className="mt-2 flex flex-col items-center gap-1 p-3 bg-white rounded">
                <canvas ref={qrCanvasRef} />
                <p className="text-xs text-description-fg">
                  Scan to open on your phone
                </p>
              </div>
            )}

            <div className="mt-1">
              <button
                type="button"
                onClick={() =>
                  vscode.postMessage({
                    type: MESSAGE_TYPES.REGENERATE_SERVER_TOKEN,
                  })
                }
                className="text-xs text-description-fg hover:text-foreground underline"
              >
                Regenerate token
              </button>
            </div>
          </div>
        )}

        {/* Port, standalone port, bind address — server-side only; changing these could lock out browser clients */}
        {!isStandalone && (
          <SettingInputRow
            label="Server port"
            id="server-port"
            path="server.port"
            {...rowProps}
          >
            <LocalNumberInput
              id="server-port"
              value={server.port}
              onCommit={(v) => onUpdate("server.port", v)}
              className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
            />
          </SettingInputRow>
        )}

        {!isStandalone && (
          <SettingInputRow
            label="Standalone port"
            description="Port used by the flightpath server CLI command (headless mode, no VS Code required)."
            id="server-standalone-port"
            path="server.standalonePort"
            {...rowProps}
          >
            <LocalNumberInput
              id="server-standalone-port"
              value={server.standalonePort}
              onCommit={(v) => onUpdate("server.standalonePort", v)}
              className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
            />
          </SettingInputRow>
        )}

        {!isStandalone && (
          <SettingInputRow
            label="Bind address"
            id="server-bind"
            path="server.bindAddress"
            {...rowProps}
          >
            <CustomSelect
              id="server-bind"
              value={server.bindAddress ?? "127.0.0.1"}
              onChange={(value) => onUpdate("server.bindAddress", value)}
              options={bindAddressOptions}
              triggerAriaLabel="Choose server bind address"
              triggerTitle="Choose whether the server listens only on localhost or all interfaces"
            />
          </SettingInputRow>
        )}
      </div>

      {/* Icon Colors — visible to all clients; live SVG preview, colors persist on blur */}
      <div className="pt-3 border-t border-panel-border mt-3">
        <div className="text-xs font-semibold uppercase text-description-fg mb-2 tracking-wide">
          Icon Colors
        </div>
        <div className="flex items-end gap-4 mb-2">
          <div className="flex-1">
            <SettingInputRow
              label="Background"
              id="icon-bg-color"
              path="server.iconBgColor"
              {...rowProps}
            >
              <input
                id="icon-bg-color"
                type="color"
                value={localBg}
                onChange={(e) => setLocalBg(e.target.value)}
                onBlur={(e) => onUpdate("server.iconBgColor", e.target.value)}
                className="w-full h-8 cursor-pointer rounded border border-input-border p-0.5 bg-input-bg"
                title="Icon background color"
              />
            </SettingInputRow>
          </div>
          <div className="flex-1">
            <SettingInputRow
              label="Foreground"
              id="icon-fg-color"
              path="server.iconFgColor"
              {...rowProps}
            >
              <input
                id="icon-fg-color"
                type="color"
                value={localFg}
                onChange={(e) => setLocalFg(e.target.value)}
                onBlur={(e) => onUpdate("server.iconFgColor", e.target.value)}
                className="w-full h-8 cursor-pointer rounded border border-input-border p-0.5 bg-input-bg"
                title="Icon foreground color"
              />
            </SettingInputRow>
          </div>
          <img
            src={buildIconPreviewDataUrl(localBg, localFg)}
            alt="Icon preview"
            width={32}
            height={32}
            className="rounded shrink-0 mb-0.5"
          />
        </div>
        <p className="text-xs text-description-fg italic">
          SVG favicon and PWA icon update immediately. PNG icon clients (iOS
          &lt; 26 homescreen) use the colors saved at the last settings update.
        </p>
      </div>

      {/* HTTPS / TLS — full config shown to VS Code panel only */}
      {!isStandalone && (
        <div className="pt-3 border-t border-panel-border mt-3">
          <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
            HTTPS / TLS
          </h3>

          <SettingToggleRow
            label="Enable HTTPS"
            checked={server.tls?.enabled ?? false}
            onChange={(v) => onUpdate("server.tls.enabled", v)}
            path="server.tls.enabled"
            {...rowProps}
          />
          <div className="text-xs text-description-fg italic">
            HTTPS is required for push notifications on mobile browsers, and is
            generally recommended for secure communication. You can provide your
            own TLS certificate and private key, or generate a self-signed
            certificate directly from the dashboard. Changes take effect on
            server restart.
          </div>

          {server.tls?.enabled && (
            <div className="space-y-3 mt-3">
              <SettingInputRow
                label="Certificate file (.pem)"
                id="tls-cert-path"
                path="server.tls.certPath"
                {...rowProps}
              >
                <LocalTextInput
                  id="tls-cert-path"
                  value={server.tls?.certPath ?? ""}
                  placeholder="/path/to/cert.pem"
                  onCommit={(v) => onUpdate("server.tls.certPath", v)}
                  className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground font-mono focus:outline-none focus:border-focus-border"
                />
              </SettingInputRow>
              <SettingInputRow
                label="Private key file (.pem)"
                id="tls-key-path"
                path="server.tls.keyPath"
                {...rowProps}
              >
                <LocalTextInput
                  id="tls-key-path"
                  value={server.tls?.keyPath ?? ""}
                  placeholder="/path/to/key.pem"
                  onCommit={(v) => onUpdate("server.tls.keyPath", v)}
                  className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground font-mono focus:outline-none focus:border-focus-border"
                />
              </SettingInputRow>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() =>
                    vscode.postMessage({
                      type: MESSAGE_TYPES.GENERATE_SERVER_CERT,
                      scope: activeScope,
                    })
                  }
                  className="text-xs text-description-fg hover:text-foreground underline"
                >
                  Generate self-signed certificate
                </button>
                {certDownloadUrl && (
                  <a
                    href={certDownloadUrl}
                    download="flightpath.cer"
                    className="text-xs text-description-fg hover:text-foreground underline"
                    title="Download the server certificate for manual installation on iOS"
                  >
                    Download certificate
                  </a>
                )}
              </div>
              <p className="text-xs text-description-fg italic">
                The generated cert is saved to{" "}
                <code>{generatedCertLocation}</code>
                {activeScope === SETTING_SCOPES.WORKSPACE
                  ? " in the current workspace and gitignored."
                  : " in your user FlightPath folder."}{" "}
                Browsers will show a warning on first visit — click proceed to
                continue. Changes take effect on server restart.
                <br />
                <strong>iOS Safari:</strong> depending on iOS version, it may be
                necessary to download the cert and install it via{" "}
                <em>Settings → General → VPN &amp; Device Management</em>, then
                enable full trust under{" "}
                <em>
                  Settings → General → About → Certificate Trust Settings →
                  Enable Full Trust For Root Certificates
                </em>
                . Requires iOS 18.2+ (iOS 18.0–18.1 had a bug where this toggle
                didn&apos;t appear).
              </p>
            </div>
          )}
        </div>
      )}

      {/* Certificate download — browser clients only; VS Code panel shows this inside the TLS section above */}
      {isStandalone && certDownloadUrl && (
        <div className="pt-3 border-t border-panel-border mt-3">
          <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
            HTTPS / TLS
          </h3>
          <a
            href={certDownloadUrl}
            download="flightpath.cer"
            className="text-xs text-description-fg hover:text-foreground underline"
            title="Download the server certificate for manual installation on iOS"
          >
            Download certificate
          </a>
          <p className="text-xs text-description-fg italic mt-2">
            <strong>iOS Safari:</strong> depending on iOS version, it may be
            necessary to download the cert and install it via{" "}
            <em>Settings → General → VPN &amp; Device Management</em>, then
            enable full trust under{" "}
            <em>
              Settings → General → About → Certificate Trust Settings → Enable
              Full Trust For Root Certificates
            </em>
            . Requires iOS 18.2+ (iOS 18.0–18.1 had a bug where this toggle
            didn&apos;t appear).
          </p>
        </div>
      )}
    </div>
  );
}
