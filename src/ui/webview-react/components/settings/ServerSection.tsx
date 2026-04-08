import { useSettingsStore } from "@store/settingsStore";
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

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Server
      </h3>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-description-fg mb-1">Server port</label>
          <input
            type="number"
            value={server.port}
            onChange={(e) => onUpdate("server.port", Number(e.target.value), s)}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
          />
        </div>

        <div>
          <label className="block text-xs text-description-fg mb-1">Standalone port</label>
          <input
            type="number"
            value={server.standalonePort}
            onChange={(e) => onUpdate("server.standalonePort", Number(e.target.value), s)}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
          />
        </div>

        <div>
          <label className="block text-xs text-description-fg mb-1">Theme</label>
          <select
            value={server.theme}
            onChange={(e) => onUpdate("server.theme", e.target.value, s)}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
          >
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </div>

      {serverRunning && serverUrl && (
        <div className="flex items-center gap-2 mt-2 p-2 bg-input-bg border border-input-border rounded">
          <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Server running" />
          <a
            href={serverUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-link truncate flex-1 hover:underline"
          >
            {serverUrl}
          </a>
          <button
            onClick={() => navigator.clipboard.writeText(serverUrl)}
            title="Copy URL"
            className="shrink-0 text-description-fg hover:text-foreground"
          >
            <i className="codicon codicon-copy" />
          </button>
        </div>
      )}

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
