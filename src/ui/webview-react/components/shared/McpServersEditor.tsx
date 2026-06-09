import React, { useEffect, useMemo, useState } from "react";
import type { McpServerConfig } from "@root/types/FlightPathTypes";
import type { ManagedMcpServer } from "@root/types/WebviewMessageTypes";
import { SETTING_SCOPES, type SettingWriteScope } from "@/types/messages";
import { useMcpManagerStore } from "../../store/useMcpManagerStore";
import { useUiStore } from "@store/uiStore";

type McpServerEntry = string | McpServerConfig;

export type McpServersValue = McpServerEntry[] | null | undefined;

interface ListedServer {
  id: string;
  config: McpServerConfig;
  enabled: boolean;
  managed?: ManagedMcpServer;
  isLegacy: boolean;
}

/** User-visible FlightPath MCP tools that can be selectively disabled. */
const FLIGHTPATH_USER_TOOLS: {
  id: string;
  label: string;
  description: string;
}[] = [
  {
    id: "flightpath_queue_status",
    label: "Queue status",
    description: "Read this workflow's queue and execution state",
  },
  {
    id: "flightpath_append_queue",
    label: "Append to queue",
    description: "Add prompts after the current step or at the end",
  },
  {
    id: "flightpath_capabilities",
    label: "Capabilities",
    description: "List installed harnesses and their available models",
  },
  {
    id: "flightpath_read_output",
    label: "Read output",
    description: "Read AI response text from completed steps",
  },
  {
    id: "flightpath_global_status",
    label: "Global status",
    description: "List all workflows running in this workspace",
  },
];

function isMatchingServerEntry(entry: McpServerEntry, id: string): boolean {
  return typeof entry === "string" ? entry === id : entry.id === id;
}

function hasFlightpath(arr: McpServerEntry[]): boolean {
  return arr.some((entry) => isMatchingServerEntry(entry, "flightpath"));
}

/** Return the FlightPath entry as an McpServerConfig object, or undefined if not present. */
function getFlightpathConfig(
  arr: McpServerEntry[]
): McpServerConfig | undefined {
  return arr.find(
    (entry): entry is McpServerConfig =>
      typeof entry === "object" && entry !== null && entry.id === "flightpath"
  );
}

function getNonFlightpathEntries(arr: McpServerEntry[]): McpServerEntry[] {
  return arr.filter((entry) => !isMatchingServerEntry(entry, "flightpath"));
}

function buildArray(
  includeFlightpath: boolean,
  flightpathDeniedTools: string[],
  serverEntries: McpServerEntry[]
): McpServerEntry[] {
  const result: McpServerEntry[] = [];
  if (includeFlightpath) {
    result.push(
      flightpathDeniedTools.length > 0
        ? { id: "flightpath", deniedTools: flightpathDeniedTools }
        : "flightpath"
    );
  }
  result.push(...getNonFlightpathEntries(serverEntries));
  return result;
}

function formatScopeLabel(scope: SettingWriteScope): string {
  return scope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User";
}

function getServerSummary(server: McpServerConfig): string {
  if (server.url) return server.url;
  if (server.command) {
    return `${server.command}${server.args ? ` ${server.args.join(" ")}` : ""}`;
  }
  return "Stored by ID";
}

function buildListedServers(
  value: McpServersValue,
  managedServers: ManagedMcpServer[] | undefined
): ListedServer[] {
  const entries = Array.isArray(value) ? value : [];
  const enabledIds = new Set<string>();
  const configuredServers = new Map<string, McpServerConfig>();

  for (const entry of getNonFlightpathEntries(entries)) {
    if (typeof entry === "string") {
      enabledIds.add(entry);
      continue;
    }

    enabledIds.add(entry.id);
    configuredServers.set(entry.id, entry);
  }

  const managedList = managedServers ?? [];
  const managedIds = new Set(managedList.map((server) => server.id));

  const installedRows = managedList.map<ListedServer>((server) => ({
    id: server.id,
    config: configuredServers.get(server.id) ?? server.config,
    enabled: enabledIds.has(server.id),
    managed: server,
    isLegacy: false,
  }));

  const legacyRows = [...enabledIds]
    .filter((id) => !managedIds.has(id))
    .map<ListedServer>((id) => ({
      id,
      config: configuredServers.get(id) ?? { id },
      enabled: true,
      isLegacy: true,
    }));

  return [...installedRows, ...legacyRows];
}

function ScopeBadge({ scope }: { scope: SettingWriteScope }) {
  return (
    <span className="inline-flex items-center rounded border border-panel-border bg-list-hover-bg px-1.5 py-0.5 text-xxs font-medium leading-none text-foreground">
      {formatScopeLabel(scope)}
    </span>
  );
}

function ServerDetails({ server }: { server: ListedServer }) {
  const detailRows: Array<{ label: string; value: string | null }> = [
    { label: "id", value: server.config.id },
    { label: "command", value: server.config.command ?? null },
    { label: "args", value: server.config.args?.join(" ") ?? null },
    { label: "url", value: server.config.url ?? null },
    {
      label: "transport",
      value:
        server.config.transport && server.config.transport !== "streamable-http"
          ? server.config.transport
          : null,
    },
    {
      label: "env",
      value: server.config.env
        ? Object.keys(server.config.env).join(", ")
        : null,
    },
    {
      label: "headers",
      value: server.config.headers
        ? Object.keys(server.config.headers).join(", ")
        : null,
    },
    {
      label: "autoApprove",
      value:
        typeof server.config.autoApprove === "boolean"
          ? String(server.config.autoApprove)
          : (server.config.autoApprove?.join(", ") ?? null),
    },
  ];

  const uniqueScopes = [
    ...new Set(
      server.managed?.locations.map((location) => location.scope) ?? []
    ),
  ];

  return (
    <div className="space-y-2 border-t border-panel-border px-3 pb-3 pt-2">
      <div className="grid gap-1 sm:grid-cols-2">
        {detailRows
          .filter((row) => row.value)
          .map((row) => (
            <div key={row.label} className="text-xs text-description-fg">
              <span className="font-mono text-foreground">{row.label}:</span>{" "}
              {row.value}
            </div>
          ))}
      </div>

      {server.managed ? (
        <div className="space-y-1">
          <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
            Installed In
          </div>
          <div className="flex flex-wrap gap-1">
            {uniqueScopes.map((scope) => (
              <ScopeBadge key={scope} scope={scope} />
            ))}
          </div>
        </div>
      ) : (
        <div className="text-xs text-description-fg">
          This server is currently configured but is not installed in MCP
          Manager.
        </div>
      )}
    </div>
  );
}

function McpServersPanel({
  value,
  rows,
  flightpathEnabled,
  flightpathDeniedTools,
  onToggleFlightpath,
  onToggleFlightpathTool,
  onToggleServer,
  expandedId,
  onExpandedIdChange,
  readOnly,
  fillHeight,
  isLoadingManagedServers,
  managedServers,
  onManageServers,
}: {
  value: McpServersValue;
  rows: ListedServer[];
  flightpathEnabled: boolean;
  flightpathDeniedTools: string[];
  onToggleFlightpath?: () => void;
  onToggleFlightpathTool?: (toolId: string) => void;
  onToggleServer?: (serverId: string) => void;
  expandedId: string | null;
  onExpandedIdChange: (id: string | null) => void;
  readOnly: boolean;
  fillHeight: boolean;
  isLoadingManagedServers: boolean;
  managedServers: ManagedMcpServer[] | undefined;
  onManageServers?: () => void;
}) {
  const arr = Array.isArray(value) ? value : [];
  const hasLegacyRows = rows.some((row) => row.isLegacy);
  const showEmptyHint =
    rows.length === 0 && (managedServers?.length ?? 0) === 0;

  return (
    <div
      className={`flex flex-col gap-2${fillHeight ? " flex-1 min-h-0" : ""}`}
    >
      <div className="flex flex-col gap-1">
        <div className="text-xxs font-semibold uppercase text-description-fg tracking-wide">
          Built-in
        </div>
        <div
          className={`flex flex-col rounded border transition-colors ${
            flightpathEnabled
              ? "border-focus-border bg-editor-bg"
              : "border-panel-border"
          }`}
        >
          <button
            type="button"
            onClick={readOnly ? undefined : onToggleFlightpath}
            aria-label={
              flightpathEnabled
                ? "Disable FlightPath MCP server"
                : "Enable FlightPath MCP server"
            }
            disabled={readOnly}
            className={`flex items-start gap-2 px-2 py-1.5 text-left rounded-t transition-colors ${
              readOnly ? "cursor-default" : "hover:bg-toolbar-hover-bg"
            }`}
          >
            <input
              type="checkbox"
              checked={flightpathEnabled}
              readOnly
              aria-label="FlightPath enabled"
              className="mt-0.5 h-3 w-3 flex-shrink-0 accent-focus-border pointer-events-none"
              tabIndex={-1}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-xs font-medium text-foreground">
                FlightPath
              </span>
              <span className="text-xxs text-description-fg">
                {flightpathEnabled && flightpathDeniedTools.length > 0
                  ? `${FLIGHTPATH_USER_TOOLS.length - flightpathDeniedTools.length} of ${FLIGHTPATH_USER_TOOLS.length} tools enabled`
                  : "Dynamic queue extension"}
              </span>
            </span>
          </button>

          {flightpathEnabled && (
            <div className="flex flex-col gap-0.5 border-t border-panel-border px-2 pb-1.5">
              {FLIGHTPATH_USER_TOOLS.map((tool) => {
                const denied = flightpathDeniedTools.includes(tool.id);
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={
                      readOnly
                        ? undefined
                        : () => onToggleFlightpathTool?.(tool.id)
                    }
                    disabled={readOnly}
                    title={tool.description}
                    className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors ${
                      readOnly ? "cursor-default" : "hover:bg-toolbar-hover-bg"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={!denied}
                      readOnly
                      className="h-3 w-3 flex-shrink-0 accent-focus-border pointer-events-none"
                      tabIndex={-1}
                    />
                    <span className="text-xxs font-medium text-foreground">
                      {tool.label}
                    </span>
                    <span className="ml-auto truncate font-mono text-xxs text-description-fg">
                      {tool.id}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div
        className={`flex flex-col gap-1${fillHeight ? " flex-1 min-h-0" : ""}`}
      >
        <div className="text-xxs font-semibold uppercase text-description-fg tracking-wide">
          Installed Servers
        </div>

        {isLoadingManagedServers && managedServers === undefined && (
          <div className="flex items-center gap-1.5 px-1 text-xs text-description-fg">
            <i className="codicon codicon-loading codicon-modifier-spin text-xxs" />
            Loading installed servers…
          </div>
        )}

        {!isLoadingManagedServers && showEmptyHint && (
          <div className="px-1 text-xs text-description-fg italic">
            No servers installed. Add servers in Settings → MCP Manager.
          </div>
        )}

        {!showEmptyHint && (
          <div
            className={`flex flex-col gap-1${fillHeight ? " flex-1 min-h-0 overflow-y-auto pr-1" : ""}`}
          >
            {rows.map((server) => {
              const isExpanded = expandedId === server.id;
              const displayName =
                server.managed?.displayName?.trim() || server.config.id;
              const uniqueScopes = [
                ...new Set(
                  server.managed?.locations.map((location) => location.scope) ??
                    []
                ),
              ];

              return (
                <div
                  key={server.id}
                  className={`rounded border bg-editor-bg transition-colors ${
                    server.enabled
                      ? "border-focus-border"
                      : "border-panel-border"
                  }`}
                >
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={
                        readOnly ? undefined : () => onToggleServer?.(server.id)
                      }
                      disabled={readOnly}
                      className="flex flex-shrink-0 items-center"
                      aria-label={
                        server.enabled
                          ? `Disable ${server.id}`
                          : `Enable ${server.id}`
                      }
                      title={
                        server.enabled
                          ? `Disable ${server.id}`
                          : `Enable ${server.id}`
                      }
                    >
                      <input
                        type="checkbox"
                        checked={server.enabled}
                        readOnly
                        className="h-3 w-3 accent-focus-border pointer-events-none"
                        tabIndex={-1}
                      />
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        onExpandedIdChange(isExpanded ? null : server.id)
                      }
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <i
                        className={`codicon codicon-chevron-${
                          isExpanded ? "down" : "right"
                        } flex-shrink-0 text-xxs text-description-fg`}
                      />
                      <span className="truncate text-xs font-medium text-foreground">
                        {displayName}
                      </span>
                      {displayName !== server.config.id && (
                        <span className="truncate font-mono text-xxs text-description-fg">
                          {server.config.id}
                        </span>
                      )}
                      {uniqueScopes.length > 0 && (
                        <div className="ml-auto flex flex-wrap gap-1">
                          {uniqueScopes.map((scope) => (
                            <ScopeBadge key={scope} scope={scope} />
                          ))}
                        </div>
                      )}
                    </button>
                  </div>

                  {!isExpanded && (
                    <div className="px-3 pb-2 text-xxs text-description-fg">
                      {server.isLegacy
                        ? "Not installed in MCP Manager"
                        : getServerSummary(server.config)}
                    </div>
                  )}

                  {isExpanded && <ServerDetails server={server} />}
                </div>
              );
            })}
          </div>
        )}

        {hasLegacyRows && (
          <div className="px-1 text-xxs text-description-fg">
            Legacy selections remain enabled until you remove them. Install them
            in MCP Manager to manage them here again.
          </div>
        )}

        {arr.length === 0 && !showEmptyHint && rows.length === 0 && (
          <div className="px-1 text-xs text-description-fg italic">
            None added
          </div>
        )}

        {onManageServers && (
          <button
            type="button"
            onClick={onManageServers}
            className="mb-1 flex items-center justify-center gap-1 rounded border border-btn-border bg-btn-secondary-bg px-3 py-1 text-xs text-btn-secondary-fg hover:bg-btn-secondary-hover transition-colors"
            title="Open MCP Manager in Settings to add, edit, or remove MCP servers"
          >
            <i className="codicon codicon-settings-gear text-xxs" />
            Manage MCP Servers
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * McpServersEditor — Inline editor for the mcpServers property.
 *
 * When `showDefault` is true (prompt level, default):
 * - Two modes: Default (undefined) | Custom (array or empty)
 * - Default mode shows the inherited config in read-only form
 *
 * When `showDefault` is false (workflow/global level):
 * - No mode buttons — always shows the editable config
 * - null/undefined both treated as empty array for display
 */
export const McpServersEditor: React.FC<{
  value: McpServersValue;
  onChange: (value: McpServersValue) => void;
  /** Text shown in the Default mode button (e.g. "Default (FlightPath)"). Only relevant when showDefault is true. */
  defaultLabel?: string;
  /**
   * When true (default): shows Default/Custom mode selector buttons.
   *   - Default mode: shows read-only config from inheritedValue
   *   - Custom mode: shows editable config
   * When false (workflow level): no mode buttons, always editable.
   */
  showDefault?: boolean;
  /**
   * The resolved/inherited value to display (read-only) when Default mode is active.
   * Only used when showDefault is true.
   */
  inheritedValue?: McpServersValue;
  /** When true, the installed server list expands to fill available vertical space. */
  fillHeight?: boolean;
}> = ({
  value,
  onChange,
  defaultLabel = "Default",
  showDefault = true,
  inheritedValue,
  fillHeight = false,
}) => {
  const managedServers = useMcpManagerStore((state) => state.managedServers);
  const isLoadingManagedServers = useMcpManagerStore(
    (state) => state.isLoadingRegistry
  );
  const requestServers = useMcpManagerStore((state) => state.requestServers);

  const globalSettingsOpen = useUiStore((state) => state.globalSettingsOpen);
  const toggleGlobalSettings = useUiStore(
    (state) => state.toggleGlobalSettings
  );
  const setGlobalSettingsTab = useUiStore(
    (state) => state.setGlobalSettingsTab
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (managedServers === undefined && !isLoadingManagedServers) {
      requestServers();
    }
  }, [isLoadingManagedServers, managedServers, requestServers]);

  const mode: "default" | "custom" =
    showDefault && value === undefined ? "default" : "custom";

  const currentArray = useMemo(
    () => (Array.isArray(value) ? value : []),
    [value]
  );
  const inheritedArray = useMemo(
    () => (Array.isArray(inheritedValue) ? inheritedValue : []),
    [inheritedValue]
  );

  const flightpathEnabled = hasFlightpath(currentArray);
  const flightpathConfig = getFlightpathConfig(currentArray);
  const flightpathDeniedTools = flightpathConfig?.deniedTools ?? [];
  const serverEntries = getNonFlightpathEntries(currentArray);

  const managedServersById = useMemo(
    () => new Map((managedServers ?? []).map((server) => [server.id, server])),
    [managedServers]
  );

  const currentRows = useMemo(
    () => buildListedServers(currentArray, managedServers),
    [currentArray, managedServers]
  );
  const inheritedRows = useMemo(
    () => buildListedServers(inheritedArray, managedServers),
    [inheritedArray, managedServers]
  );

  useEffect(() => {
    const activeRows = mode === "default" ? inheritedRows : currentRows;
    if (expandedId && !activeRows.some((row) => row.id === expandedId)) {
      setExpandedId(null);
    }
  }, [currentRows, expandedId, inheritedRows, mode]);

  const handleModeChange = (newMode: "default" | "custom") => {
    if (newMode === "default") {
      onChange(undefined);
      return;
    }

    onChange(["flightpath"]);
  };

  const handleFlightpathToggle = () => {
    onChange(
      buildArray(!flightpathEnabled, flightpathDeniedTools, serverEntries)
    );
  };

  const handleFlightpathToolToggle = (toolId: string) => {
    const isDenied = flightpathDeniedTools.includes(toolId);
    const nextDenied = isDenied
      ? flightpathDeniedTools.filter((tool) => tool !== toolId)
      : [...flightpathDeniedTools, toolId];

    onChange(buildArray(flightpathEnabled, nextDenied, serverEntries));
  };

  const handleToggleServer = (serverId: string) => {
    const isEnabled = serverEntries.some((entry) =>
      isMatchingServerEntry(entry, serverId)
    );

    if (isEnabled) {
      onChange(
        buildArray(
          flightpathEnabled,
          flightpathDeniedTools,
          serverEntries.filter(
            (entry) => !isMatchingServerEntry(entry, serverId)
          )
        )
      );
      return;
    }

    const managedServer = managedServersById.get(serverId);
    if (!managedServer) return;

    onChange(
      buildArray(flightpathEnabled, flightpathDeniedTools, [
        ...serverEntries.filter(
          (entry) => !isMatchingServerEntry(entry, serverId)
        ),
        managedServer.config,
      ])
    );
  };

  const handleManageServers = () => {
    setGlobalSettingsTab("mcpmanager");
    if (!globalSettingsOpen) {
      toggleGlobalSettings();
    }
  };

  return (
    <div
      className={`flex flex-col gap-2${fillHeight ? " flex-1 min-h-0" : ""}`}
    >
      {showDefault && (
        <div className="flex gap-1">
          {(["default", "custom"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => handleModeChange(option)}
              className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                mode === option
                  ? "border-btn-bg bg-btn-bg text-btn-fg"
                  : "border-panel-border bg-transparent text-description-fg hover:border-focus-border hover:text-foreground"
              }`}
            >
              {option === "default" ? defaultLabel : "Custom"}
            </button>
          ))}
        </div>
      )}

      {mode === "default" ? (
        <div className="opacity-80">
          <McpServersPanel
            value={inheritedValue}
            rows={inheritedRows}
            flightpathEnabled={hasFlightpath(inheritedArray)}
            flightpathDeniedTools={
              getFlightpathConfig(inheritedArray)?.deniedTools ?? []
            }
            expandedId={expandedId}
            onExpandedIdChange={setExpandedId}
            readOnly={true}
            fillHeight={fillHeight}
            isLoadingManagedServers={isLoadingManagedServers}
            managedServers={managedServers}
            onManageServers={handleManageServers}
          />
        </div>
      ) : (
        <McpServersPanel
          value={value}
          rows={currentRows}
          flightpathEnabled={flightpathEnabled}
          flightpathDeniedTools={flightpathDeniedTools}
          onToggleFlightpath={handleFlightpathToggle}
          onToggleFlightpathTool={handleFlightpathToolToggle}
          onToggleServer={handleToggleServer}
          expandedId={expandedId}
          onExpandedIdChange={setExpandedId}
          readOnly={false}
          fillHeight={fillHeight}
          isLoadingManagedServers={isLoadingManagedServers}
          managedServers={managedServers}
          onManageServers={handleManageServers}
        />
      )}
    </div>
  );
};

/** Build a human-readable inherit label for an mcpServers array from workflow/global settings */
export function buildMcpDefaultLabel(servers: McpServersValue): string {
  const entries = Array.isArray(servers) ? servers : [];
  if (entries.length === 0) return "Inherit (None)";

  const hasFlightpathEntry = hasFlightpath(entries);
  const customCount = getNonFlightpathEntries(entries).length;

  if (hasFlightpathEntry && customCount === 0) return "Inherit (FlightPath)";
  if (hasFlightpathEntry) return `Inherit (FlightPath +${customCount})`;
  return `Inherit (${customCount} server${customCount !== 1 ? "s" : ""})`;
}
