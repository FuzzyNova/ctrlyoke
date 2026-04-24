import React, { useState, useRef, useEffect, useMemo } from "react";
import type { McpServerConfig } from "@root/types/FlightPathTypes";
import type {
  LocalMcpServerEntry,
  RegistryMcpEntry,
} from "@root/types/WebviewMessageTypes";
import { useUiStore } from "../../store/uiStore";

export type McpServersValue = (string | McpServerConfig)[] | null | undefined;

interface AddServerForm {
  id: string;
  /** Active tab: "stdio" for command/args/env, "remote" for url/transport */
  activeTab: "stdio" | "remote";
  /** For stdio servers: the executable command */
  command: string;
  args: string;
  /** Newline-separated KEY=VALUE pairs */
  env: string;
  autoApprove: boolean;
  /** For remote (HTTP/SSE) servers: the endpoint URL */
  url: string;
  /** Transport type for remote servers */
  transport: "streamable-http" | "sse";
}

const EMPTY_FORM: AddServerForm = {
  id: "",
  activeTab: "stdio",
  command: "",
  args: "",
  env: "",
  autoApprove: false,
  url: "",
  transport: "streamable-http",
};

// Keep the registry in "fill available space" mode only while there is enough
// room to preserve a comfortably scrollable result list plus the surrounding UI.
const REGISTRY_FILL_BREAKPOINT = 280;

function envObjectToString(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function envStringToObject(raw: string): Record<string, string> | undefined {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

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

function serverToForm(server: McpServerConfig): AddServerForm {
  return {
    id: server.id,
    activeTab: server.url ? "remote" : "stdio",
    command: server.command ?? "",
    args: server.args ? server.args.join(" ") : "",
    env: envObjectToString(server.env),
    autoApprove:
      typeof server.autoApprove === "boolean" ? server.autoApprove : false,
    url: server.url ?? "",
    transport: server.transport ?? "streamable-http",
  };
}

function formToServer(form: AddServerForm): McpServerConfig {
  if (form.activeTab === "remote") {
    // Remote server — always store transport to avoid future default-change footguns
    const server: McpServerConfig = {
      id: form.id.trim(),
      url: form.url.trim(),
      transport: form.transport,
    };
    if (form.autoApprove) server.autoApprove = true;
    return server;
  }
  // stdio server
  const server: McpServerConfig = {
    id: form.id.trim(),
    command: form.command.trim(),
  };
  if (form.args.trim()) {
    server.args = form.args.trim().split(/\s+/);
  }
  const envObj = envStringToObject(form.env);
  if (envObj) {
    server.env = envObj;
  }
  if (form.autoApprove) {
    server.autoApprove = true;
  }
  return server;
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
        <div className="text-xxs font-semibold uppercase text-description-fg tracking-wide">
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
            aria-label="FlightPath built-in enabled"
            className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border pointer-events-none"
            tabIndex={-1}
          />
          <span className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-foreground">
              FlightPath
            </span>
            <span className="text-xxs text-description-fg">
              Dynamic queue extension (flightpath_append_queue,
              flightpath_queue_status)
            </span>
          </span>
        </div>
      </div>

      {/* Installed Servers */}
      <div className="flex flex-col gap-1">
        <div className="text-xxs font-semibold uppercase text-description-fg tracking-wide">
          Installed Servers
        </div>
        {isEmpty || servers.length === 0 ? (
          <div className="text-xs text-description-fg italic px-1">
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
              <span className="text-xxs text-description-fg font-mono truncate ml-1">
                {server.url
                  ? server.url
                  : `${server.command ?? ""}${server.args ? " " + server.args.join(" ") : ""}`}
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
 * Workspace registry: When `workspaceServers` is provided, all workspace
 * servers are displayed with checkboxes (checked = enabled in value).
 * Adding or importing a server also saves it to the workspace registry.
 *
 * Note: env variables are not editable here — set them in the YAML file
 * directly under the server's env: key.
 */
type RegistrySort = "a-z" | "z-a" | "recently-updated";

/** Returns an ISO 8601 timestamp for one year ago — used for "recently updated" registry queries. */
function oneYearAgoISO(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

/** Derive a human-readable kebab-case id from a registry entry's display name. */
function registryEntryToSlug(entry: RegistryMcpEntry): string {
  const source = entry.name || entry.id;
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || entry.id
  );
}

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
  /** Called when user submits a registry search or changes sort mode */
  onSearchRegistry?: (
    query: string,
    cursor?: string,
    updatedSince?: string
  ) => void;
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
  // ── Workspace registry props (optional) ────────────────────────────────────
  /** All servers in the workspace MCP registry (undefined = not yet loaded) */
  workspaceServers?: McpServerConfig[];
  /** Whether the workspace registry is loading */
  isLoadingWorkspaceServers?: boolean;
  /** Called to trigger a load of workspace servers */
  onRequestWorkspaceServers?: () => void;
  /** Called when workspace server list should be persisted */
  onWorkspaceServersChange?: (servers: McpServerConfig[]) => void;
  /** When true, the registry browser expands to fill available vertical space instead of using a fixed max-height */
  fillHeight?: boolean;
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
  workspaceServers,
  isLoadingWorkspaceServers,
  onRequestWorkspaceServers,
  onWorkspaceServersChange,
  fillHeight = false,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<AddServerForm>(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<AddServerForm>(EMPTY_FORM);
  const discoveryTab = useUiStore((s) => s.mcpDiscoveryTab);
  const setDiscoveryTab = useUiStore((s) => s.setMcpDiscoveryTab);
  const mcpRegistryNextCursor = useUiStore((s) => s.mcpRegistryNextCursor);
  const mcpRegistryPageCursors = useUiStore((s) => s.mcpRegistryPageCursors);
  const mcpRegistryGoNextPage = useUiStore((s) => s.mcpRegistryGoNextPage);
  const mcpRegistryGoPrevPage = useUiStore((s) => s.mcpRegistryGoPrevPage);
  const resetMcpRegistryPages = useUiStore((s) => s.resetMcpRegistryPages);
  const [registryQuery, setRegistryQuery] = useState("");
  const [registrySort, setRegistrySort] = useState<RegistrySort>("a-z");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoveryPanelRef = useRef<HTMLDivElement | null>(null);
  const canFillDiscovery = fillHeight && discoveryTab === "registry";
  const [shouldFill, setShouldFill] = useState(canFillDiscovery);

  useEffect(() => {
    if (!canFillDiscovery) {
      setShouldFill(false);
      return;
    }

    const node = discoveryPanelRef.current;
    if (!node) {
      setShouldFill(true);
      return;
    }

    const updateShouldFill = (height: number) => {
      setShouldFill(height >= REGISTRY_FILL_BREAKPOINT);
    };

    updateShouldFill(node.getBoundingClientRect().height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      updateShouldFill(
        entry?.contentRect.height ?? node.getBoundingClientRect().height
      );
    });

    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [canFillDiscovery]);

  // Client-side sort only — filtering is server-side via the `search` query param
  const filteredRegistryServers = useMemo(() => {
    if (!registryServers) return undefined;
    if (registrySort === "recently-updated") {
      return [...registryServers].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
      );
    }
    const sorted = [...registryServers].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    return registrySort === "z-a" ? sorted.reverse() : sorted;
  }, [registryServers, registrySort]);

  // Cancel pending search on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // mode: "default" only when showDefault=true and value is undefined
  const mode: "default" | "custom" =
    showDefault && value === undefined ? "default" : "custom";

  // The editable array — null/undefined both treated as empty
  const currentArray = Array.isArray(value) ? value : [];
  const flightpathEnabled = hasFlightpath(currentArray);
  const userServers = getUserServers(currentArray);

  // Request workspace servers when entering custom mode for the first time
  useEffect(() => {
    if (
      mode === "custom" &&
      workspaceServers === undefined &&
      !isLoadingWorkspaceServers
    ) {
      onRequestWorkspaceServers?.();
    }
  }, [
    mode,
    workspaceServers,
    isLoadingWorkspaceServers,
    onRequestWorkspaceServers,
  ]);

  // Effective server list: workspace servers + any value-only servers not in workspace
  const effectiveServers = useMemo((): McpServerConfig[] => {
    if (workspaceServers === undefined) {
      // Workspace not yet loaded — show current value servers only
      return userServers;
    }
    const wsIds = new Set(workspaceServers.map((s) => s.id));
    const orphaned = userServers.filter((s) => !wsIds.has(s.id));
    return [...workspaceServers, ...orphaned];
  }, [workspaceServers, userServers]);

  const isServerEnabled = (server: McpServerConfig): boolean =>
    userServers.some((s) => s.id === server.id);

  const handleModeChange = (newMode: "default" | "custom") => {
    if (newMode === "default") {
      onChange(undefined);
    } else {
      // Start with flightpath enabled — the most common use case
      onChange(["flightpath"]);
    }
  };

  const showDiscovery = !!(onRequestLocalServers || onSearchRegistry);

  // Load data for the active discovery tab when custom mode becomes visible
  useEffect(() => {
    if (mode !== "custom" || !showDiscovery) return;
    if (discoveryTab === "local") {
      onRequestLocalServers?.();
    } else if (
      discoveryTab === "registry" &&
      registryServers === undefined &&
      !isLoadingRegistry
    ) {
      const updatedSince =
        registrySort === "recently-updated" ? oneYearAgoISO() : undefined;
      onSearchRegistry?.(registryQuery, undefined, updatedSince);
    }
  }, [mode, showDiscovery, discoveryTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFlightpathToggle = () => {
    onChange(buildArray(!flightpathEnabled, userServers));
  };

  const handleToggleServer = (server: McpServerConfig) => {
    if (isServerEnabled(server)) {
      onChange(
        buildArray(
          flightpathEnabled,
          userServers.filter((s) => s.id !== server.id)
        )
      );
    } else {
      // Use the workspace copy (may have updated config vs orphan)
      const fullServer =
        effectiveServers.find((s) => s.id === server.id) ?? server;
      onChange(buildArray(flightpathEnabled, [...userServers, fullServer]));
    }
  };

  const handleRemoveServer = (id: string) => {
    // Remove from workspace registry
    if (onWorkspaceServersChange && workspaceServers !== undefined) {
      onWorkspaceServersChange(workspaceServers.filter((s) => s.id !== id));
    }
    // Remove from value
    onChange(
      buildArray(
        flightpathEnabled,
        userServers.filter((s) => s.id !== id)
      )
    );
    if (expandedId === id) setExpandedId(null);
    if (editingId === id) setEditingId(null);
  };

  const handleStartEdit = (server: McpServerConfig) => {
    setEditingId(server.id);
    setEditForm(serverToForm(server));
    setExpandedId(null);
    setShowAddForm(false);
  };

  const handleSaveEdit = () => {
    const trimmedId = editForm.id.trim();
    const isValid =
      editForm.activeTab === "stdio"
        ? trimmedId && editForm.command.trim()
        : trimmedId && editForm.url.trim();
    if (!isValid) return;
    const updatedServer = formToServer(editForm);
    const oldId = editingId!;

    // Update workspace registry
    if (onWorkspaceServersChange && workspaceServers !== undefined) {
      onWorkspaceServersChange(
        workspaceServers.map((s) => (s.id === oldId ? updatedServer : s))
      );
    }

    // Update value if this server was enabled (rename + update)
    if (userServers.some((s) => s.id === oldId)) {
      onChange(
        buildArray(
          flightpathEnabled,
          userServers.map((s) => (s.id === oldId ? updatedServer : s))
        )
      );
    }

    setEditingId(null);
    setEditForm(EMPTY_FORM);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditForm(EMPTY_FORM);
  };

  /** Save a server to workspace registry + enable it in value */
  const addServerToWorkspaceAndValue = (server: McpServerConfig) => {
    const newWorkspace =
      workspaceServers !== undefined
        ? [...workspaceServers.filter((s) => s.id !== server.id), server]
        : undefined;
    if (newWorkspace !== undefined) {
      onWorkspaceServersChange?.(newWorkspace);
    }
    if (!userServers.some((s) => s.id === server.id)) {
      onChange(buildArray(flightpathEnabled, [...userServers, server]));
    }
  };

  /** Import a local entry — skip if already present in workspace */
  const handleImportLocal = (entry: LocalMcpServerEntry) => {
    const server: McpServerConfig = { id: entry.id, command: entry.command };
    if (entry.args && entry.args.length > 0) server.args = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) server.env = entry.env;
    addServerToWorkspaceAndValue(server);
  };

  /** Import a registry entry — handles stdio (packages[]) and remote (remotes[]) transports */
  const handleImportRegistry = (entry: RegistryMcpEntry) => {
    const id = registryEntryToSlug(entry);
    let server: McpServerConfig;

    if (entry.remoteUrl) {
      // Remote HTTP/SSE server — always store transport to avoid future default-change footguns
      server = {
        id,
        url: entry.remoteUrl,
        transport: entry.remoteTransport ?? "streamable-http",
      };
      // Add empty-string placeholders for required auth headers so the user
      // knows which keys need to be filled in before the server will work.
      const requiredHeaders = entry.remoteHeaders?.filter((h) => h.isRequired);
      if (requiredHeaders && requiredHeaders.length > 0) {
        server.headers = Object.fromEntries(
          requiredHeaders.map((h) => [h.name, ""])
        );
      }
    } else if (entry.installCommand) {
      // stdio server — installCommand encodes the correct runtime (npx vs uvx) and flags
      const parts = entry.installCommand.trim().split(/\s+/);
      server = { id, command: parts[0] ?? "npx" };
      const argsArr = parts.slice(1).filter(Boolean);
      if (argsArr.length > 0) server.args = argsArr;
    } else if (entry.packageName) {
      server = { id, command: "npx", args: ["-y", entry.packageName] };
    } else {
      server = { id, command: "npx" };
    }

    // For stdio servers: add empty-string placeholders for required env vars.
    if (!entry.remoteUrl && entry.envVars && entry.envVars.length > 0) {
      server.env = Object.fromEntries(entry.envVars.map((v) => [v.name, ""]));
    }

    addServerToWorkspaceAndValue(server);
  };

  const handleDiscoveryTabChange = (tab: "local" | "registry") => {
    setDiscoveryTab(tab);
    if (tab === "local") {
      onRequestLocalServers?.();
    } else if (
      tab === "registry" &&
      registryServers === undefined &&
      !isLoadingRegistry
    ) {
      resetMcpRegistryPages();
      const updatedSince =
        registrySort === "recently-updated" ? oneYearAgoISO() : undefined;
      onSearchRegistry?.(registryQuery, undefined, updatedSince);
    }
  };

  /**
   * Debounced handler for the search input — triggers a server-side search after
   * the user stops typing for 500 ms. Resets pagination on each new search.
   */
  const handleRegistrySearchChange = (query: string) => {
    setRegistryQuery(query);
    if (!onSearchRegistry || discoveryTab !== "registry") return;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      resetMcpRegistryPages();
      const updatedSince =
        registrySort === "recently-updated" ? oneYearAgoISO() : undefined;
      onSearchRegistry(query, undefined, updatedSince);
    }, 500);
  };

  /**
   * Sort change handler. "a-z"/"z-a" are presentation-only (re-sort current page).
   * Switching to/from "recently-updated" triggers a new server-side fetch with/without
   * the updated_since filter.
   */
  const handleSortChange = (newSort: RegistrySort) => {
    const prevSort = registrySort;
    setRegistrySort(newSort);
    if (!onSearchRegistry) return;

    if (newSort === "recently-updated" && prevSort !== "recently-updated") {
      resetMcpRegistryPages();
      onSearchRegistry(registryQuery, undefined, oneYearAgoISO());
    } else if (
      newSort !== "recently-updated" &&
      prevSort === "recently-updated"
    ) {
      resetMcpRegistryPages();
      onSearchRegistry(registryQuery);
    }
    // a-z <-> z-a: just re-sort, no new fetch
  };

  const registryPageNumber = mcpRegistryPageCursors.length;
  const hasNextPage = !!mcpRegistryNextCursor;
  const hasPrevPage = mcpRegistryPageCursors.length > 1;

  const handleRegistryNextPage = () => {
    if (!hasNextPage || isLoadingRegistry) return;
    const cursor = mcpRegistryGoNextPage();
    const updatedSince =
      registrySort === "recently-updated" ? oneYearAgoISO() : undefined;
    if (cursor) onSearchRegistry?.(registryQuery, cursor, updatedSince);
  };

  const handleRegistryPrevPage = () => {
    if (!hasPrevPage || isLoadingRegistry) return;
    const cursor = mcpRegistryGoPrevPage();
    const updatedSince =
      registrySort === "recently-updated" ? oneYearAgoISO() : undefined;
    onSearchRegistry?.(registryQuery, cursor, updatedSince);
  };

  const handleAddServer = () => {
    const trimmedId = form.id.trim();
    const isValid =
      form.activeTab === "stdio"
        ? trimmedId && form.command.trim()
        : trimmedId && form.url.trim();
    if (!isValid) return;

    const newServer = formToServer(form);
    addServerToWorkspaceAndValue(newServer);
    setForm(EMPTY_FORM);
    setShowAddForm(false);
  };

  // A local config entry is "in workspace" if it's already in the workspace registry
  const isInWorkspace = (id: string): boolean =>
    workspaceServers !== undefined
      ? workspaceServers.some((s) => s.id === id)
      : userServers.some((s) => s.id === id);

  return (
    <div
      className={`flex flex-col gap-2${canFillDiscovery ? " flex-1 min-h-0" : ""}`}
    >
      {/* Mode selector (prompt level only) */}
      {showDefault && (
        <div className="flex gap-1">
          {(["default", "custom"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleModeChange(m)}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
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
        <div
          className={`flex flex-col gap-2${canFillDiscovery ? " flex-1 min-h-0" : ""}`}
        >
          {/* FlightPath built-in */}
          <div className="flex flex-col gap-1">
            <div className="text-xxs font-semibold uppercase text-description-fg tracking-wide">
              Built-in
            </div>
            <button
              type="button"
              onClick={handleFlightpathToggle}
              aria-label={
                flightpathEnabled
                  ? "Disable FlightPath MCP server"
                  : "Enable FlightPath MCP server"
              }
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
                aria-label="FlightPath enabled"
                className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border pointer-events-none"
                tabIndex={-1}
              />
              <span className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-foreground">
                  FlightPath
                </span>
                <span className="text-xxs text-description-fg">
                  Dynamic queue extension (flightpath_append_queue,
                  flightpath_queue_status)
                </span>
              </span>
            </button>
          </div>

          {/* Installed servers */}
          <div
            className={`flex flex-col gap-1${canFillDiscovery ? " flex-1 min-h-0" : ""}`}
          >
            <div className="text-xxs font-semibold uppercase text-description-fg tracking-wide">
              Installed Servers
            </div>

            {isLoadingWorkspaceServers && (
              <div className="flex items-center gap-1.5 text-xs text-description-fg px-1">
                <i className="codicon codicon-loading codicon-modifier-spin text-xxs" />
                Loading workspace servers…
              </div>
            )}

            {!isLoadingWorkspaceServers &&
              effectiveServers.length === 0 &&
              !showAddForm && (
                <div className="text-xs text-description-fg italic px-1">
                  None added
                </div>
              )}

            {effectiveServers.map((server) => {
              const enabled = isServerEnabled(server);
              const isEditing = editingId === server.id;

              if (isEditing) {
                return (
                  <div
                    key={server.id}
                    className="flex flex-col gap-1.5 p-2 rounded border border-focus-border bg-editor-bg"
                  >
                    <input
                      type="text"
                      placeholder="id (required)"
                      aria-label="Server ID"
                      value={editForm.id}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, id: e.target.value }))
                      }
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                      autoFocus
                    />
                    {/* stdio / remote tab selector */}
                    <div className="flex gap-1">
                      {(["stdio", "remote"] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() =>
                            setEditForm((f) => ({ ...f, activeTab: tab }))
                          }
                          className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                            editForm.activeTab === tab
                              ? "bg-btn-bg text-btn-fg border-btn-bg"
                              : "text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
                          }`}
                        >
                          {tab}
                        </button>
                      ))}
                    </div>
                    {editForm.activeTab === "stdio" ? (
                      <>
                        <input
                          type="text"
                          placeholder="command (e.g. node or npx)"
                          aria-label="Command"
                          value={editForm.command}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              command: e.target.value,
                            }))
                          }
                          className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                        />
                        <input
                          type="text"
                          placeholder="args (space-separated)"
                          aria-label="Arguments"
                          value={editForm.args}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              args: e.target.value,
                            }))
                          }
                          className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                        />
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xxs text-description-fg">
                            env (KEY=VALUE, one per line)
                          </span>
                          <textarea
                            placeholder={"MY_KEY=value\nANOTHER_KEY=value"}
                            aria-label="Environment variables (KEY=VALUE, one per line)"
                            value={editForm.env}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                env: e.target.value,
                              }))
                            }
                            rows={3}
                            className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono resize-none"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <input
                          type="text"
                          placeholder="url (e.g. https://mcp.example.com)"
                          aria-label="Server URL"
                          value={editForm.url}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              url: e.target.value,
                            }))
                          }
                          className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                        />
                        <select
                          value={editForm.transport}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              transport: e.target.value as
                                | "streamable-http"
                                | "sse",
                            }))
                          }
                          className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                        >
                          <option value="streamable-http">
                            streamable-http
                          </option>
                          <option value="sse">sse</option>
                        </select>
                      </>
                    )}
                    <label
                      htmlFor="edit-auto-approve"
                      className="flex items-center gap-1.5 cursor-pointer"
                    >
                      <input
                        id="edit-auto-approve"
                        type="checkbox"
                        aria-label="Auto-approve all tools (CLI harnesses only)"
                        checked={editForm.autoApprove}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            autoApprove: e.target.checked,
                          }))
                        }
                        className="w-3 h-3 accent-focus-border"
                      />
                      <span className="text-xs text-description-fg">
                        Auto-approve all tools (CLI harnesses only)
                      </span>
                    </label>
                    <div className="flex gap-1 mt-0.5">
                      <button
                        type="button"
                        onClick={handleSaveEdit}
                        disabled={
                          !editForm.id.trim() ||
                          (editForm.activeTab === "stdio"
                            ? !editForm.command.trim()
                            : !editForm.url.trim())
                        }
                        className="px-2 py-0.5 text-xs bg-btn-bg text-btn-fg rounded hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="px-2 py-0.5 text-xs text-description-fg border border-panel-border rounded hover:border-focus-border hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={server.id}
                  className={`rounded border bg-editor-bg transition-colors ${
                    enabled ? "border-focus-border" : "border-panel-border"
                  }`}
                >
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    {/* Checkbox toggle */}
                    <button
                      type="button"
                      onClick={() => handleToggleServer(server)}
                      className="flex-shrink-0 flex items-center"
                      aria-label={
                        enabled ? `Disable ${server.id}` : `Enable ${server.id}`
                      }
                      title={
                        enabled ? `Disable ${server.id}` : `Enable ${server.id}`
                      }
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => {}}
                        aria-label={
                          enabled
                            ? `Disable ${server.id}`
                            : `Enable ${server.id}`
                        }
                        className="w-3 h-3 accent-focus-border pointer-events-none"
                        tabIndex={-1}
                      />
                    </button>

                    {/* Expand/collapse + info */}
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
                        } text-xxs flex-shrink-0 text-description-fg`}
                      />
                      <span className="text-xs font-medium text-foreground flex-shrink-0">
                        {server.id}
                      </span>
                      {expandedId !== server.id && (
                        <span className="text-xxs text-description-fg font-mono truncate ml-1">
                          {server.url
                            ? server.url
                            : `${server.command ?? ""}${server.args ? " " + server.args.join(" ") : ""}`}
                        </span>
                      )}
                    </button>

                    {/* Edit button */}
                    <button
                      type="button"
                      onClick={() => handleStartEdit(server)}
                      className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-toolbar-hover-bg text-description-fg hover:text-foreground"
                      aria-label={`Edit ${server.id}`}
                      title={`Edit ${server.id}`}
                    >
                      <i className="codicon codicon-edit text-xxs" />
                    </button>

                    {/* Remove button */}
                    <button
                      type="button"
                      onClick={() => handleRemoveServer(server.id)}
                      className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-toolbar-hover-bg text-description-fg hover:text-error-fg"
                      aria-label={`Remove ${server.id}`}
                      title={`Remove ${server.id}`}
                    >
                      <i className="codicon codicon-close text-xxs" />
                    </button>
                  </div>
                  {expandedId === server.id && (
                    <div className="px-3 pb-2 space-y-0.5 border-t border-panel-border">
                      {server.url ? (
                        <>
                          <div className="text-xs text-description-fg">
                            <span className="font-mono text-foreground">
                              url:
                            </span>{" "}
                            {server.url}
                          </div>
                          {server.transport &&
                            server.transport !== "streamable-http" && (
                              <div className="text-xs text-description-fg">
                                <span className="font-mono text-foreground">
                                  transport:
                                </span>{" "}
                                {server.transport}
                              </div>
                            )}
                          {server.headers &&
                            Object.keys(server.headers).length > 0 && (
                              <div className="text-xs text-description-fg">
                                <span className="font-mono text-foreground">
                                  headers:
                                </span>{" "}
                                {Object.keys(server.headers).join(", ")}
                              </div>
                            )}
                        </>
                      ) : (
                        <>
                          {server.command && (
                            <div className="text-xs text-description-fg">
                              <span className="font-mono text-foreground">
                                command:
                              </span>{" "}
                              {server.command}
                            </div>
                          )}
                          {server.args && (
                            <div className="text-xs text-description-fg">
                              <span className="font-mono text-foreground">
                                args:
                              </span>{" "}
                              {server.args.join(" ")}
                            </div>
                          )}
                          {server.env && Object.keys(server.env).length > 0 && (
                            <div className="text-xs text-description-fg">
                              <span className="font-mono text-foreground">
                                env:
                              </span>{" "}
                              {Object.keys(server.env).join(", ")}
                            </div>
                          )}
                        </>
                      )}
                      {server.autoApprove !== undefined && (
                        <div className="text-xs text-description-fg">
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
              );
            })}

            {showAddForm ? (
              <div className="flex flex-col gap-1.5 p-2 rounded border border-focus-border bg-editor-bg">
                <input
                  type="text"
                  placeholder="id (required)"
                  aria-label="Server ID"
                  value={form.id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, id: e.target.value }))
                  }
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                  autoFocus
                />
                {/* stdio / remote tab selector */}
                <div className="flex gap-1">
                  {(["stdio", "remote"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, activeTab: tab }))}
                      className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                        form.activeTab === tab
                          ? "bg-btn-bg text-btn-fg border-btn-bg"
                          : "text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                {form.activeTab === "stdio" ? (
                  <>
                    <input
                      type="text"
                      placeholder="command (e.g. node or npx)"
                      aria-label="Command"
                      value={form.command}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, command: e.target.value }))
                      }
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                    />
                    <input
                      type="text"
                      placeholder="args (space-separated, e.g. /path/to/server.js)"
                      aria-label="Arguments"
                      value={form.args}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, args: e.target.value }))
                      }
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xxs text-description-fg">
                        env (KEY=VALUE, one per line)
                      </span>
                      <textarea
                        placeholder={"MY_KEY=value\nANOTHER_KEY=value"}
                        aria-label="Environment variables (KEY=VALUE, one per line)"
                        value={form.env}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, env: e.target.value }))
                        }
                        rows={3}
                        className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono resize-none"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      placeholder="url (e.g. https://mcp.example.com)"
                      aria-label="Server URL"
                      value={form.url}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, url: e.target.value }))
                      }
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                    />
                    <select
                      value={form.transport}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          transport: e.target.value as
                            | "streamable-http"
                            | "sse",
                        }))
                      }
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    >
                      <option value="streamable-http">streamable-http</option>
                      <option value="sse">sse</option>
                    </select>
                  </>
                )}
                <label
                  htmlFor="add-auto-approve"
                  className="flex items-center gap-1.5 cursor-pointer"
                >
                  <input
                    id="add-auto-approve"
                    type="checkbox"
                    aria-label="Auto-approve all tools (CLI harnesses only)"
                    checked={form.autoApprove}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        autoApprove: e.target.checked,
                      }))
                    }
                    className="w-3 h-3 accent-focus-border"
                  />
                  <span className="text-xs text-description-fg">
                    Auto-approve all tools (CLI harnesses only)
                  </span>
                </label>
                <div className="flex gap-1 mt-0.5">
                  <button
                    type="button"
                    onClick={handleAddServer}
                    disabled={
                      !form.id.trim() ||
                      (form.activeTab === "stdio"
                        ? !form.command.trim()
                        : !form.url.trim())
                    }
                    className="px-2 py-0.5 text-xs bg-btn-bg text-btn-fg rounded hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setForm(EMPTY_FORM);
                    }}
                    className="px-2 py-0.5 text-xs text-description-fg border border-panel-border rounded hover:border-focus-border hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(true);
                  setEditingId(null);
                }}
                className="flex items-center gap-1 px-2 py-1 text-xs text-description-fg hover:text-foreground border border-dashed border-panel-border rounded hover:border-focus-border transition-colors"
              >
                <i className="codicon codicon-add text-xxs" />
                Add Server
              </button>
            )}

            {/* Discovery shortcuts */}
            {showDiscovery && (
              <div
                ref={discoveryPanelRef}
                className={`flex flex-col gap-1 mt-1${canFillDiscovery ? " flex-1 min-h-0" : ""}`}
              >
                <div className="flex gap-1">
                  {onRequestLocalServers && (
                    <button
                      type="button"
                      onClick={() => handleDiscoveryTabChange("local")}
                      className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                        discoveryTab === "local"
                          ? "bg-btn-bg text-btn-fg border-btn-bg"
                          : "text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
                      }`}
                    >
                      <i className="codicon codicon-folder-opened text-xxs" />
                      Local configs
                    </button>
                  )}
                  {onSearchRegistry && (
                    <button
                      type="button"
                      onClick={() => handleDiscoveryTabChange("registry")}
                      className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                        discoveryTab === "registry"
                          ? "bg-btn-bg text-btn-fg border-btn-bg"
                          : "text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
                      }`}
                    >
                      <i className="codicon codicon-globe text-xxs" />
                      Browse registry
                    </button>
                  )}
                </div>

                {/* Local configs panel */}
                {discoveryTab === "local" && (
                  <div className="flex flex-col gap-1 p-2 rounded border border-panel-border bg-editor-bg">
                    {isLoadingLocal ? (
                      <div className="flex items-center gap-1.5 text-xs text-description-fg">
                        <i className="codicon codicon-loading codicon-modifier-spin text-xxs" />
                        Scanning local configs…
                      </div>
                    ) : localServersError ? (
                      <div className="text-xs text-error-fg">
                        {localServersError}
                      </div>
                    ) : !localServers || localServers.length === 0 ? (
                      <div className="text-xs text-description-fg italic">
                        No servers found in local config files
                        <span className="block text-xxs mt-0.5">
                          (.vscode/mcp.json, .mcp.json, VS Code user config)
                        </span>
                      </div>
                    ) : (
                      <>
                        <div className="text-xxs text-description-fg mb-0.5">
                          Found {localServers.length} server
                          {localServers.length !== 1 ? "s" : ""}
                        </div>
                        {localServers.map((entry) => {
                          const alreadyAdded = isInWorkspace(entry.id);
                          return (
                            <div
                              key={`${entry.source}:${entry.id}`}
                              className="flex items-center justify-between gap-2 px-2 py-1 rounded border border-panel-border"
                            >
                              <div className="flex flex-col min-w-0">
                                <span className="text-xs font-medium text-foreground truncate">
                                  {entry.id}
                                </span>
                                <span className="text-xxs text-description-fg font-mono truncate">
                                  {entry.command}
                                  {entry.args ? " " + entry.args.join(" ") : ""}
                                </span>
                                <span className="text-xxs text-description-fg capitalize">
                                  {entry.source.replace(/-/g, " ")}
                                </span>
                              </div>
                              <button
                                type="button"
                                disabled={alreadyAdded}
                                onClick={() => handleImportLocal(entry)}
                                className="flex-shrink-0 px-2 py-0.5 text-xs rounded border border-panel-border hover:border-focus-border hover:text-foreground text-description-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                title={
                                  alreadyAdded
                                    ? "Already in workspace registry"
                                    : `Import ${entry.id}`
                                }
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
                {discoveryTab === "registry" && (
                  <div
                    className={`flex flex-col gap-1.5 p-2 rounded border border-panel-border bg-editor-bg${
                      shouldFill ? " flex-1 min-h-0" : " shrink-0"
                    }`}
                  >
                    {/* Search input — server-side substring match on server name */}
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Search servers…"
                      aria-label="Search MCP registry"
                      value={registryQuery}
                      onChange={(e) =>
                        handleRegistrySearchChange(e.target.value)
                      }
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                      autoFocus
                    />

                    {isLoadingRegistry ? (
                      <div className="flex items-center gap-1.5 text-xs text-description-fg">
                        <i className="codicon codicon-loading codicon-modifier-spin text-xxs" />
                        Fetching from MCP Registry…
                      </div>
                    ) : registryError ? (
                      <div className="text-xs text-error-fg">
                        {registryError}
                      </div>
                    ) : filteredRegistryServers &&
                      filteredRegistryServers.length > 0 ? (
                      <>
                        {/* Sort controls */}
                        <div className="flex items-center gap-1">
                          <span className="text-xxs text-description-fg">
                            Sort:
                          </span>
                          {(
                            ["a-z", "z-a", "recently-updated"] as RegistrySort[]
                          ).map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => handleSortChange(s)}
                              className={`px-1.5 py-0 text-xxs rounded border transition-colors ${
                                registrySort === s
                                  ? "bg-btn-bg text-btn-fg border-btn-bg"
                                  : "text-description-fg border-panel-border hover:border-focus-border hover:text-foreground"
                              }`}
                            >
                              {s === "a-z"
                                ? "A–Z"
                                : s === "z-a"
                                  ? "Z–A"
                                  : "Recently Updated"}
                            </button>
                          ))}
                        </div>
                        <div
                          className={`flex flex-col gap-1 overflow-y-auto${
                            shouldFill
                              ? " flex-1 min-h-[160px]"
                              : " flex-none max-h-[160px]"
                          }`}
                        >
                          {filteredRegistryServers.map((entry) => {
                            const id = registryEntryToSlug(entry);
                            const alreadyAdded = isInWorkspace(id);
                            return (
                              <div
                                key={entry.id}
                                className="flex items-start justify-between gap-2 px-2 py-1.5 rounded border border-panel-border"
                              >
                                <div className="flex flex-col min-w-0 flex-1">
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs font-medium text-foreground truncate">
                                      {entry.name}
                                    </span>
                                    {entry.verified && (
                                      <i
                                        className="codicon codicon-verified-filled text-xxs text-blue-400 flex-shrink-0"
                                        title="MCP Registry verified"
                                      />
                                    )}
                                  </div>
                                  {entry.description && (
                                    <span className="text-xxs text-description-fg line-clamp-2">
                                      {entry.description}
                                    </span>
                                  )}
                                  {entry.installCommand && (
                                    <span className="text-xxs text-description-fg font-mono mt-0.5 truncate">
                                      {entry.installCommand}
                                    </span>
                                  )}
                                  {!entry.installCommand && entry.remoteUrl && (
                                    <span className="text-xxs text-description-fg font-mono mt-0.5 truncate">
                                      {entry.remoteTransport ??
                                        "streamable-http"}
                                      : {entry.remoteUrl}
                                    </span>
                                  )}
                                  {entry.envVars &&
                                    entry.envVars.length > 0 && (
                                      <span className="text-xxs text-description-fg mt-0.5">
                                        Requires env:{" "}
                                        {entry.envVars
                                          .map((e) => e.name)
                                          .join(", ")}
                                      </span>
                                    )}
                                  {entry.remoteHeaders &&
                                    entry.remoteHeaders.filter(
                                      (h) => h.isRequired
                                    ).length > 0 && (
                                      <span className="text-xxs text-description-fg mt-0.5">
                                        Requires header:{" "}
                                        {entry.remoteHeaders
                                          .filter((h) => h.isRequired)
                                          .map((h) => h.name)
                                          .join(", ")}
                                      </span>
                                    )}
                                </div>
                                <button
                                  type="button"
                                  disabled={alreadyAdded}
                                  onClick={() => handleImportRegistry(entry)}
                                  className="flex-shrink-0 px-2 py-0.5 text-xs rounded border border-panel-border hover:border-focus-border hover:text-foreground text-description-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors mt-0.5"
                                  title={
                                    alreadyAdded
                                      ? "Already in workspace registry"
                                      : `Add ${entry.name}`
                                  }
                                >
                                  {alreadyAdded ? "Added" : "Add"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        {/* Pagination controls */}
                        {(hasPrevPage || hasNextPage) && (
                          <div className="flex items-center justify-between mt-1">
                            <button
                              type="button"
                              disabled={!hasPrevPage || isLoadingRegistry}
                              onClick={handleRegistryPrevPage}
                              className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-panel-border hover:border-focus-border hover:text-foreground text-description-fg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <i className="codicon codicon-chevron-left text-xxs" />
                              Prev
                            </button>
                            <span className="text-xxs text-description-fg">
                              Page {registryPageNumber}
                            </span>
                            <button
                              type="button"
                              disabled={!hasNextPage || isLoadingRegistry}
                              onClick={handleRegistryNextPage}
                              className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-panel-border hover:border-focus-border hover:text-foreground text-description-fg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              Next
                              <i className="codicon codicon-chevron-right text-xxs" />
                            </button>
                          </div>
                        )}
                      </>
                    ) : filteredRegistryServers !== undefined ? (
                      <div className="flex flex-col gap-1.5">
                        <div className="text-xs text-description-fg italic">
                          {hasPrevPage ? "No more results" : "No matches"}
                        </div>
                        {hasPrevPage && (
                          <button
                            type="button"
                            disabled={isLoadingRegistry}
                            onClick={handleRegistryPrevPage}
                            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-panel-border hover:border-focus-border hover:text-foreground text-description-fg disabled:opacity-30 disabled:cursor-not-allowed transition-colors self-start"
                          >
                            <i className="codicon codicon-chevron-left text-xxs" />
                            Back to browse
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="text-xxs text-description-fg italic">
                        Loading MCP Registry…
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

/** Build a human-readable inherit label for an mcpServers array from workflow/global settings */
export function buildMcpDefaultLabel(
  servers: (string | McpServerConfig)[] | undefined | null
): string {
  if (!Array.isArray(servers) || servers.length === 0) return "Inherit (None)";
  const hasFlightpathEntry = servers.some((s) => s === "flightpath");
  const customCount = servers.filter(
    (s) => typeof s === "object" && s !== null
  ).length;
  if (hasFlightpathEntry && customCount === 0) return "Inherit (FlightPath)";
  if (hasFlightpathEntry) return `Inherit (FlightPath +${customCount})`;
  return `Inherit (${customCount} server${customCount !== 1 ? "s" : ""})`;
}
