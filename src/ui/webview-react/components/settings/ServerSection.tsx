import { useRef, useState, useEffect } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

export function ServerSection({ settings, onUpdate }: Props) {
  const server = settings.settings.server;
  const s = "user" as const;

  const serverRunning = useSettingsStore((state) => state.serverRunning);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const vscode = useVsCodeApi();

  const [showQr, setShowQr] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (showQr && qrCanvasRef.current && serverUrl) {
      import("qrcode").then((QRCode) =>
        QRCode.toCanvas(qrCanvasRef.current!, serverUrl, { width: 200 })
      );
    }
  }, [showQr, serverUrl]);

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
        {/* Enable/disable toggle — also controls auto-start on VS Code restart */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={serverRunning}
            onChange={(e) => toggleServer(e.target.checked)}
            className="accent-btn-primary-bg"
          />
          <span className="text-sm text-foreground">Enable server</span>
          {serverRunning && (
            <span className="ml-auto text-xs text-description-fg italic">
              running
            </span>
          )}
        </label>

        {/* Clickable URL + copy + QR buttons — visible while server is running */}
        {serverRunning && serverUrl && (
          <div>
            <div className="flex items-center gap-2 p-2 bg-input-bg border border-input-border rounded">
              <span
                className="w-2 h-2 rounded-full bg-green-500 shrink-0"
                title="Server running"
              />
              <a
                href={serverUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-link truncate flex-1 hover:underline"
              >
                {serverUrl}
              </a>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(serverUrl)}
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
                <p className="text-xs text-gray-500">
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

        <div>
          <label
            htmlFor="server-port"
            className="block text-xs text-description-fg mb-1"
          >
            Server port
          </label>
          <input
            id="server-port"
            type="number"
            value={server.port}
            onChange={(e) => onUpdate("server.port", Number(e.target.value), s)}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
          />
        </div>

        <div>
          <label
            htmlFor="server-standalone-port"
            className="block text-xs text-description-fg mb-1"
          >
            Standalone port
          </label>
          <input
            id="server-standalone-port"
            type="number"
            value={server.standalonePort}
            onChange={(e) =>
              onUpdate("server.standalonePort", Number(e.target.value), s)
            }
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
          />
        </div>

        <div>
          <label
            htmlFor="server-bind"
            className="block text-xs text-description-fg mb-1"
          >
            Bind address
          </label>
          <select
            id="server-bind"
            value={server.bindAddress ?? "127.0.0.1"}
            onChange={(e) => onUpdate("server.bindAddress", e.target.value, s)}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
          >
            <option value="127.0.0.1">Localhost only (127.0.0.1)</option>
            <option value="0.0.0.0">
              All interfaces (0.0.0.0) — LAN / VPN access
            </option>
          </select>
        </div>
      </div>

      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-2 tracking-wide">
          HTTPS / TLS
        </h3>
        <p className="text-xs text-description-fg italic">
          HTTPS/TLS configuration is reserved for a future update.
        </p>
      </div>
    </div>
  );
}
