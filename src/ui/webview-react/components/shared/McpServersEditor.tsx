import React, { useState, useRef } from "react";
import type { McpServerConfig } from "@root/types/FlightPathTypes";
import type {
  LocalMcpServerEntry,
  RegistryMcpEntry,
} from "@root/types/WebviewMessageTypes";

export type McpServersValue = (string | McpServerConfig)[] | null | undefined;

interface AddServerForm {
  id: string;
  command: string;
  args: string;
  autoApprove: boolean;
}

const EMPTY_FORM: AddServerForm = {
  id: "",
  command: "",
  args: "",
  autoApprove: false,
};

function hasFlightpath(arr: (string | McpServerConfig)[]): boolean {
  return arr.includes("flightpath");
}

function getUserServers(arr: (string | McpServerConfig)[]): McpServerConfig[] {
  return arr.filter(
    (s): s is McpServerConfig => typeof s === "object" && s !== null
  );
}

function buildArray(
  includeFlightpath: boolean,
  userServers: McpServerConfig[]
): (string | McpServerConfig)[] {
  const result: (string | McpServerConfig)[] = [];
  if (includeFlightpath) result.push("flightpath");
  result.push(...userServers);
  return result;
}

/** Read-only rendering of an McpServersValue for the grayed-out Default view. */
const McpServersReadOnly: React.FC<{ value: McpServersValue }> = ({
  value,
}) => {
  const arr = Array.isArray(value) ? value : [];
  const fpEnabled = hasFlightpath(arr);
  const servers = getUserServers(arr);
  const isEmpty = arr.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {/* FlightPath built-in */}
      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-semibold uppercase text-description-fg tracking-wide">
          Built-in
        </div>
        <div
          className={`flex items-start gap-2 px-2 py-1.5 rounded border text-left ${
            fpEnabled
              ? "border-focus-border bg-editor-bg"
              : "border-panel-border"
          }`}
        >
          <input
            type="checkbox"
            checked={fpEnabled}
            readOnly
            className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border pointer-events-none"
            tabIndex={-1}
          />
          <span className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-foreground">
              FlightPath
            </span>
            <span className="text-[10px] text-description-fg">
              Dynamic queue extension (flightpath_append_queue,
              flightpath_queue_status)
            </span>
          </span>
        </div>
      </div>

      {/* Custom servers */}
      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-semibold uppercase text-description-fg tracking-wide">
          Custom Servers
        </div>
        {isEmpty || servers.length === 0 ? (
          <div className="text-[11px] text-description-fg italic px-1">
            None added
          </div>
        ) : (
          servers.map((server) => (
            <div
              key={server.id}
              className="rounded border border-panel-border bg-editor-bg px-2 py-1.5"
            >
              <span className="text-xs font-medium text-foreground truncate">
                {server.id}
              </span>
              <span className="text-[10px] text-description-fg font-mono truncate ml-1">
                {server.command}
                {server.args ? " " + server.args.join(" ") : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/**
 * McpServersEditor — Inline editor for the mcpServers property.
 *
 * When `showDefault` is true (prompt level, default):
 * - Two modes: Default (undefined) | Custom (array or empty)
 * - Default mode shows the inherited config grayed out (read-only)
 * - Empty Custom is equivalent to "none" — no servers will be attached
 *
 * When `showDefault` is false (workflow level):
 * - No mode buttons — always shows the editable config
 * - null/undefined both treated as empty array for display
 *
 * The "flightpath" string entry is always shown as a named checkbox in the
 * built-in section. Custom McpServerConfig objects are listed below with
 * an inline add form.
 *
 * Note: env variables are not editable here — set them in the YAML file
 * directly under the server's env: key.
 */
type DiscoveryPanel = "local" | "registry" | null;

export const McpServersEditor: React.FC<{
  value: McpServersValue;
  onChange: (value: McpServersValue) => void;
  /** Text shown in the Default mode button (e.g. "Default (FlightPath)"). Only relevant when showDefault is true. */
  defaultLabel?: string;
  /**
   * When true (default): shows Default/Custom mode selector buttons.
   *   - Default mode: shows grayed-out read-only config from inheritedValue
   *   - Custom mode: shows editable config
   * When false (workflow level): no mode buttons, always editable.
   */
  showDefault?: boolean;
  /**
   * The resolved/inherited value to display (read-only) when Default mode is active.
   * Only used when showDefault is true.
   */
  inheritedValue?: McpServersValue;
  // ── Discovery props (optional) ─────────────────────────────────────────────
  /** Called when user requests a local config file scan */
  onRequestLocalServers?: () => void;
  /** Called when user submits a registry search */
  onSearchRegistry?: (query: string) => void;
  /** Results from the most recent local scan */
  localServers?: LocalMcpServerEntry[];
  /** Whether a local scan is in progress */
  isLoadingLocal?: boolean;
  /** Error from the most recent local scan */
  localServersError?: string;
  /** Results from the most recent registry search */
  registryServers?: RegistryMcpEntry[];
  /** Whether a registry fetch is in progress */
  isLoadingRegistry?: boolean;
  /** Error from the most recent registry fetch */
  registryError?: string;
}> = ({
  value,
  onChange,
  defaultLabel = "Default",
  showDefault = true,
  inheritedValue,
  onRequestLocalServers,
  onSearchRegistry,
  localServers,
  isLoadingLocal,
  localServersError,
  registryServers,
  isLoadingRegistry,
  registryError,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<AddServerForm>(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [discoveryPanel, setDiscoveryPanel] = useState<DiscoveryPanel>(null);
  const [registryQuery, setRegistryQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Client-side filter: Anthropic registry has no server-side search
  const filteredRegistryServers = registryServers
    ? registryQuery.trim()
      ? registryServers.filter((s) => {
          const q = registryQuery.toLowerCase();
          return (
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            (s.packageName ?? "").toLowerCase().includes(q)
          );
        })
      : registryServers
    : undefined;

  // mode: "default" only when showDefault=true and value is undefined
  const mode: "default" | "custom" =
    showDefault && value === undefined ? "default" : "custom";

  // The editable array — null/undefined both treated as empty
  const currentArray = Array.isArray(value) ? value : [];
  const flightpathEnabled = hasFlightpath(currentArray);
  const userServers = getUserServers(currentArray);

  const handleModeChange = (newMode: "default" | "custom") => {
    if (newMode === "default") {
      onChange(undefined);
    } else {
      // Start with flightpath enabled — the most common use case
      onChange(["flightpath"]);
    }
  };

  const showDiscovery = !!(onRequestLocalServers || onSearchRegistry);

  const handleFlightpathToggle = () => {
    onChange(buildArray(!flightpathEnabled, userServers));
  };

  const handleRemoveServer = (id: string) => {
    onChange(buildArray(flightpathEnabled, userServers.filter((s) => s.id !== id)));
    if (expandedId === id) setExpandedId(null);
  };

  /** Import a local entry — skip if already present */
  const handleImportLocal = (entry: LocalMcpServerEntry) => {
    if (userServers.some((s) => s.id === entry.id)) return;
    const server: McpServerConfig = { id: entry.id, command: entry.command };
    if (entry.args && entry.args.length > 0) server.args = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) server.env = entry.env;
    onChange(buildArray(flightpathEnabled, [...userServers, server]));
  };

  /** Import a registry entry */
  const handleImportRegistry = (entry: RegistryMcpEntry) => {
    const id = entry.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || entry.id;
    if (userServers.some((s) => s.id === id)) return;
    let server: McpServerConfig;
    if (entry.packageName) {
      server = { id, command: "npx", args: ["-y", entry.packageName] };
    } else {
      server = { id, command: entry.installCommand ?? "npx" };
    }
    onChange(buildArray(flightpathEnabled, [...userServers, server]));
  };

  const handleDiscoveryPanelToggle = (panel: DiscoveryPanel) => {
    if (discoveryPanel === panel) {
      setDiscoveryPanel(null);
    } else {
      setDiscoveryPanel(panel);
      if (panel === "local") {
        onRequestLocalServers?.();
      } else if (panel === "registry" && !registryServers && !isLoadingRegistry) {
        // Load registry on first open; subsequent opens use cached results
        onSearchRegistry?.("");
      }
    }
  };

  const handleAddServer = () => {
    const trimmedId = form.id.trim();
    const trimmedCmd = form.command.trim();
    if (!trimmedId || !trimmedCmd) return;

    const newServer: McpServerConfig = { id: trimmedId, command: trimmedCmd };
    if (form.args.trim()) {
      newServer.args = form.args.trim().split(/\s+/);
    }
    if (form.autoApprove) {
      newServer.autoApprove = true;
    }

    onChange(buildArray(flightpathEnabled, [...userServers, newServer]));
    setForm(EMPTY_FORM);
    setShowAddForm(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Mode selector (prompt level only) */}
      {showDefault && (
        <div className="flex gap-1">
          {(["default", "custom"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleModeChange(m)}
              className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                mode === m
                  ? "bg-btn-bg text-btn-fg border-btn-bg"
                  : "bg-transparent text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
              }`}
            >
              {m === "default" ? defaultLabel : "Custom"}
            </button>
          ))}
        </div>
      )}

      {/* Default mode — grayed-out inherited config */}
      {mode === "default" && (
        <div
          className="opacity-50 pointer-events-none select-none"
          title="Inherited from workflow / global settings. Switch to Custom to override."
        >
          <McpServersReadOnly value={inheritedValue} />
        </div>
      )}

      {/* Custom / always-editable mode */}
      {mode === "custom" && (
        <div className="flex flex-col gap-2">
          {/* FlightPath built-in */}
          <div className="flex flex-col gap-1">
            <div className="text-[10px] font-semibold uppercase text-description-fg tracking-wide">
              Built-in
            </div>
            <button
              type="button"
              onClick={handleFlightpathToggle}
              className={`flex items-start gap-2 px-2 py-1.5 rounded border text-left transition-colors ${
                flightpathEnabled
                  ? "border-focus-border bg-editor-bg"
                  : "border-panel-border hover:border-focus-border"
              }`}
            >
              <input
                type="checkbox"
                checked={flightpathEnabled}
                onChange={() => {}}
                className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border pointer-events-none"
                tabIndex={-1}
              />
              <span className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-foreground">
                  FlightPath
                </span>
                <span className="text-[10px] text-description-fg">
                  Dynamic queue extension (flightpath_append_queue,
                  flightpath_queue_status)
                </span>
              </span>
            </button>
          </div>

          {/* Custom servers */}
          <div className="flex flex-col gap-1">
            <div className="text-[10px] font-semibold uppercase text-description-fg tracking-wide">
              Custom Servers
            </div>

            {userServers.length === 0 && !showAddForm && (
              <div className="text-[11px] text-description-fg italic px-1">
                None added
              </div>
            )}

            {userServers.map((server) => (
              <div
                key={server.id}
                className="rounded border border-panel-border bg-editor-bg"
              >
                <div className="flex items-center justify-between px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId(
                        expandedId === server.id ? null : server.id
                      )
                    }
                    className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                  >
                    <i
                      className={`codicon codicon-chevron-${
                        expandedId === server.id ? "down" : "right"
                      } text-[10px] flex-shrink-0 text-description-fg`}
                    />
                    <span className="text-xs font-medium text-foreground truncate">
                      {server.id}
                    </span>
                    <span className="text-[10px] text-description-fg font-mono truncate ml-1">
                      {server.command}
                      {server.args ? " " + server.args.join(" ") : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveServer(server.id)}
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-toolbar-hover-bg text-description-fg hover:text-error-fg ml-1"
                    title={`Remove ${server.id}`}
                  >
                    <i className="codicon codicon-close text-[10px]" />
                  </button>
                </div>
                {expandedId === server.id && (
                  <div className="px-3 pb-2 space-y-0.5 border-t border-panel-border">
                    <div className="text-[11px] text-description-fg">
                      <span className="font-mono text-foreground">
                        command:
                      </span>{" "}
                      {server.command}
                    </div>
                    {server.args && (
                      <div className="text-[11px] text-description-fg">
                        <span className="font-mono text-foreground">args:</span>{" "}
                        {server.args.join(" ")}
                      </div>
                    )}
                    {server.env && Object.keys(server.env).length > 0 && (
                      <div className="text-[11px] text-description-fg">
                        <span className="font-mono text-foreground">env:</span>{" "}
                        {Object.keys(server.env).join(", ")}
                      </div>
                    )}
                    {server.autoApprove !== undefined && (
                      <div className="text-[11px] text-description-fg">
                        <span className="font-mono text-foreground">
                          autoApprove:
                        </span>{" "}
                        {typeof server.autoApprove === "boolean"
                          ? String(server.autoApprove)
                          : server.autoApprove.join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {showAddForm ? (
              <div className="flex flex-col gap-1.5 p-2 rounded border border-focus-border bg-editor-bg">
                <input
                  type="text"
                  placeholder="id (required)"
                  value={form.id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, id: e.target.value }))
                  }
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="command (required, e.g. node)"
                  value={form.command}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, command: e.target.value }))
                  }
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                />
                <input
                  type="text"
                  placeholder="args (space-separated, e.g. /path/to/server.js)"
                  value={form.args}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, args: e.target.value }))
                  }
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                />
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.autoApprove}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        autoApprove: e.target.checked,
                      }))
                    }
                    className="w-3 h-3 accent-focus-border"
                  />
                  <span className="text-[11px] text-description-fg">
                    Auto-approve all tools (CLI harnesses only)
                  </span>
                </label>
                <div className="flex gap-1 mt-0.5">
                  <button
                    type="button"
                    onClick={handleAddServer}
                    disabled={!form.id.trim() || !form.command.trim()}
                    className="px-2 py-0.5 text-[11px] bg-btn-bg text-btn-fg rounded hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setForm(EMPTY_FORM);
                    }}
                    className="px-2 py-0.5 text-[11px] text-description-fg border border-panel-border rounded hover:border-focus-border hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-description-fg hover:text-foreground border border-dashed border-panel-border rounded hover:border-focus-border transition-colors"
              >
                <i className="codicon codicon-add text-[10px]" />
                Add Server
              </button>
            )}

            {/* Discovery shortcuts */}
            {showDiscovery && (
              <div className="flex flex-col gap-1 mt-1">
                <div className="flex gap-1">
                  {onRequestLocalServers && (
                    <button
                      type="button"
                      onClick={() => handleDiscoveryPanelToggle("local")}
                      className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded border transition-colors ${
                        discoveryPanel === "local"
                          ? "bg-btn-bg text-btn-fg border-btn-bg"
                          : "text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
                      }`}
                    >
                      <i className="codicon codicon-folder-opened text-[10px]" />
                      Local configs
                    </button>
                  )}
                  {onSearchRegistry && (
                    <button
                      type="button"
                      onClick={() => handleDiscoveryPanelToggle("registry")}
                      className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded border transition-colors ${
                        discoveryPanel === "registry"
                          ? "bg-btn-bg text-btn-fg border-btn-bg"
                          : "text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
                      }`}
                    >
                      <i className="codicon codicon-globe text-[10px]" />
                      Browse registry
                    </button>
                  )}
                </div>

                {/* Local configs panel */}
                {discoveryPanel === "local" && (
                  <div className="flex flex-col gap-1 p-2 rounded border border-panel-border bg-editor-bg">
                    {isLoadingLocal ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-description-fg">
                        <i className="codicon codicon-loading codicon-modifier-spin text-[10px]" />
                        Scanning local configs…
                      </div>
                    ) : localServersError ? (
                      <div className="text-[11px] text-error-fg">{localServersError}</div>
                    ) : !localServers || localServers.length === 0 ? (
                      <div className="text-[11px] text-description-fg italic">
                        No servers found in local config files
                        <span className="block text-[10px] mt-0.5">
                          (.vscode/mcp.json, .mcp.json, VS Code user config)
                        </span>
                      </div>
                    ) : (
                      <>
                        <div className="text-[10px] text-description-fg mb-0.5">
                          Found {localServers.length} server{localServers.length !== 1 ? "s" : ""}
                        </div>
                        {localServers.map((entry) => {
                          const alreadyAdded = userServers.some((s) => s.id === entry.id);
                          return (
                            <div
                              key={`${entry.source}:${entry.id}`}
                              className="flex items-center justify-between gap-2 px-2 py-1 rounded border border-panel-border"
                            >
                              <div className="flex flex-col min-w-0">
                                <span className="text-xs font-medium text-foreground truncate">{entry.id}</span>
                                <span className="text-[10px] text-description-fg font-mono truncate">
                                  {entry.command}{entry.args ? " " + entry.args.join(" ") : ""}
                                </span>
                                <span className="text-[10px] text-description-fg capitalize">{entry.source.replace(/-/g, " ")}</span>
                              </div>
                              <button
                                type="button"
                                disabled={alreadyAdded}
                                onClick={() => handleImportLocal(entry)}
                                className="flex-shrink-0 px-2 py-0.5 text-[11px] rounded border border-panel-border hover:border-focus-border hover:text-foreground text-description-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                title={alreadyAdded ? "Already added" : `Import ${entry.id}`}
                              >
                                {alreadyAdded ? "Added" : "Import"}
                              </button>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}

                {/* Registry panel */}
                {discoveryPanel === "registry" && (
                  <div className="flex flex-col gap-1.5 p-2 rounded border border-panel-border bg-editor-bg">
                    {/* Filter input — client-side search (Anthropic registry has no server-side search) */}
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Filter servers…"
                      value={registryQuery}
                      onChange={(e) => setRegistryQuery(e.target.value)}
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                    />

                    {isLoadingRegistry ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-description-fg">
                        <i className="codicon codicon-loading codicon-modifier-spin text-[10px]" />
                        Fetching from Anthropic registry…
                      </div>
                    ) : registryError ? (
                      <div className="text-[11px] text-error-fg">{registryError}</div>
                    ) : filteredRegistryServers && filteredRegistryServers.length > 0 ? (
                      <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                        {filteredRegistryServers.map((entry) => {
                          const id = entry.id
                            .toLowerCase()
                            .replace(/[^a-z0-9-]/g, "-")
                            .replace(/-+/g, "-")
                            .replace(/^-|-$/g, "") || entry.id;
                          const alreadyAdded = userServers.some((s) => s.id === id);
                          return (
                            <div
                              key={entry.id}
                              className="flex items-start justify-between gap-2 px-2 py-1.5 rounded border border-panel-border"
                            >
                              <div className="flex flex-col min-w-0 flex-1">
                                <div className="flex items-center gap-1">
                                  <span className="text-xs font-medium text-foreground truncate">{entry.name}</span>
                                  {entry.verified && (
                                    <i className="codicon codicon-verified-filled text-[10px] text-blue-400 flex-shrink-0" title="Anthropic verified" />
                                  )}
                                </div>
                                {entry.description && (
                                  <span className="text-[10px] text-description-fg line-clamp-2">{entry.description}</span>
                                )}
                                {entry.installCommand && (
                                  <span className="text-[10px] text-description-fg font-mono mt-0.5 truncate">{entry.installCommand}</span>
                                )}
                                {entry.envVars && entry.envVars.length > 0 && (
                                  <span className="text-[10px] text-description-fg mt-0.5">
                                    Requires: {entry.envVars.map((e) => e.name).join(", ")}
                                  </span>
                                )}
                              </div>
                              <button
                                type="button"
                                disabled={alreadyAdded}
                                onClick={() => handleImportRegistry(entry)}
                                className="flex-shrink-0 px-2 py-0.5 text-[11px] rounded border border-panel-border hover:border-focus-border hover:text-foreground text-description-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors mt-0.5"
                                title={alreadyAdded ? "Already added" : `Add ${entry.name}`}
                              >
                                {alreadyAdded ? "Added" : "Add"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : filteredRegistryServers !== undefined ? (
                      <div className="text-[11px] text-description-fg italic">No matches</div>
                    ) : (
                      <div className="text-[10px] text-description-fg italic">
                        Loading Anthropic MCP registry…
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/** Build a human-readable default label for an mcpServers array from global settings */
export function buildMcpDefaultLabel(
  servers: (string | McpServerConfig)[] | undefined | null
): string {
  if (!Array.isArray(servers) || servers.length === 0) return "Default (None)";
  const hasFlightpathEntry = servers.some((s) => s === "flightpath");
  const customCount = servers.filter(
    (s) => typeof s === "object" && s !== null
  ).length;
  if (hasFlightpathEntry && customCount === 0) return "Default (FlightPath)";
  if (hasFlightpathEntry) return `Default (FlightPath +${customCount})`;
  return `Default (${customCount} server${customCount !== 1 ? "s" : ""})`;
}
