import { useRef, useState, useEffect, useMemo } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type {
  FullGlobalSettings,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
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
    if (!server.tls?.enabled || !displayUrl) return null;
    try {
      const u = new URL(displayUrl);
      u.pathname = "/cert";
      u.search = "";
      return u.toString();
    } catch {
      return null;
    }
  }, [server.tls?.enabled, displayUrl]);

  const [showQr, setShowQr] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

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
        {/* Enable/disable toggle — runtime action, not a persisted setting path */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={serverRunning}
            onChange={(e) => toggleServer(e.target.checked)}
            className="accent-btn-bg"
          />
          <span className="text-sm text-foreground">Enable server</span>
          {serverRunning && (
            <span className="ml-auto text-xs text-description-fg italic">
              running
            </span>
          )}
        </label>

        {/* Clickable URL + copy + QR buttons — visible while server is running */}
        {serverRunning && displayUrl && (
          <div>
            {showIpSelector && (
              <SettingInputRow label="Connect via" id="server-display-ip">
                <select
                  id="server-display-ip"
                  value={selectedDisplayIp ?? ""}
                  onChange={(e) => setSelectedDisplayIp(e.target.value)}
                  className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
                >
                  {availableIps.map((ip) => (
                    <option key={ip} value={ip}>
                      {ip}
                    </option>
                  ))}
                </select>
              </SettingInputRow>
            )}
            <div className="flex items-center gap-2 p-2 bg-input-bg border border-input-border rounded">
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

        <SettingInputRow
          label="Server port"
          id="server-port"
          path="server.port"
          {...rowProps}
        >
          <input
            id="server-port"
            type="number"
            value={server.port}
            onChange={(e) => onUpdate("server.port", Number(e.target.value))}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>

        <SettingInputRow
          label="Standalone port"
          description="Port used by the flightpath server CLI command (headless mode, no VS Code required)."
          id="server-standalone-port"
          path="server.standalonePort"
          {...rowProps}
        >
          <input
            id="server-standalone-port"
            type="number"
            value={server.standalonePort}
            onChange={(e) =>
              onUpdate("server.standalonePort", Number(e.target.value))
            }
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>

        <SettingInputRow
          label="Bind address"
          id="server-bind"
          path="server.bindAddress"
          {...rowProps}
        >
          <select
            id="server-bind"
            value={server.bindAddress ?? "127.0.0.1"}
            onChange={(e) => onUpdate("server.bindAddress", e.target.value)}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
          >
            <option value="127.0.0.1">Localhost only (127.0.0.1)</option>
            <option value="0.0.0.0">
              All interfaces (0.0.0.0) — LAN access
            </option>
          </select>
        </SettingInputRow>
      </div>

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

        {server.tls?.enabled && (
          <div className="space-y-3 mt-3">
            <SettingInputRow
              label="Certificate file (.pem)"
              id="tls-cert-path"
              path="server.tls.certPath"
              {...rowProps}
            >
              <input
                id="tls-cert-path"
                type="text"
                value={server.tls?.certPath ?? ""}
                placeholder="/path/to/cert.pem"
                onChange={(e) =>
                  onUpdate("server.tls.certPath", e.target.value)
                }
                className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground font-mono focus:outline-none focus:border-focus-border"
              />
            </SettingInputRow>
            <SettingInputRow
              label="Private key file (.pem)"
              id="tls-key-path"
              path="server.tls.keyPath"
              {...rowProps}
            >
              <input
                id="tls-key-path"
                type="text"
                value={server.tls?.keyPath ?? ""}
                placeholder="/path/to/key.pem"
                onChange={(e) => onUpdate("server.tls.keyPath", e.target.value)}
                className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground font-mono focus:outline-none focus:border-focus-border"
              />
            </SettingInputRow>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() =>
                  vscode.postMessage({
                    type: MESSAGE_TYPES.GENERATE_SERVER_CERT,
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
              The generated cert is saved to <code>.flightpath/certs/</code> and
              gitignored. Browsers will show a warning on first visit — click
              proceed to continue. Changes take effect on server restart.
              <br />
              <strong>iOS Safari:</strong> download the cert and install it via{" "}
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
    </div>
  );
}
