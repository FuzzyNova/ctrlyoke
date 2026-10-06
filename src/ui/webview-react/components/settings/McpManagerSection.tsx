import { useEffect, useMemo, useRef, useState } from "react";
import {
  MCP_MANAGER_DISCOVERY_TABS,
  MCP_MANAGER_REMOTE_SORTS,
  useMcpManagerStore,
} from "@store/useMcpManagerStore";
import { useSettingsStore } from "@store/settingsStore";
import { sendMessage } from "@hooks/useMessageHandler";
import {
  ActionDropdown,
  type ActionDropdownItem,
} from "@components/shared/ActionDropdown";
import {
  FlyoutActionDropdown,
  type FlyoutGroup,
} from "@components/shared/FlyoutActionDropdown";
import { BulkSelectionActionsBar } from "@components/shared/BulkSelectionActionsBar";
import {
  EMPTY_MCP_SERVER_FORM_STATE,
  McpServerForm,
  type McpServerFormState,
  isMcpServerFormValid,
  mcpServerFormStateToServer,
  serverToMcpServerFormState,
} from "@components/shared/McpServerForm";
import { MESSAGE_TYPES } from "@/types/messages";
import { isStandalone } from "@hooks/useVsCodeApi";
import {
  KEYBOARD_KEYS,
  HARNESS_IDS,
  HARNESS_INFO,
  SETTING_SCOPES,
  MCP_TRANSPORTS,
  SPECIAL_TARGET_IDS,
  getMcpLocalSource,
  type AnyTargetId,
  type HarnessId,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import type { McpServerConfig } from "@root/types/CtrlYokeTypes";
import type {
  LocalMcpServerEntry,
  ManagedMcpServer,
  RegistryMcpEntry,
} from "@root/types/WebviewMessageTypes";
import { Icon } from "../shared/Icon";

type DefaultMcpServerValue = (string | McpServerConfig)[];

type McpManagerSectionProps = {
  activeScope: SettingWriteScope;
};

type ResolvedServerLocation = {
  kind: "registry" | "harness";
  targetId: AnyTargetId;
  scope: SettingWriteScope;
  path: string;
  sourceLabel: string;
};

type DeleteLocationState = {
  serverId: string;
  displayName: string;
  location: ResolvedServerLocation;
};

type DeleteTargetState = {
  ids: string[];
  targetId: AnyTargetId;
  scope: SettingWriteScope;
};

const EXPORT_TARGET_IDS = [
  SPECIAL_TARGET_IDS.VSCODE,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.ANTIGRAVITY_CLI,
] as const;

const LOCAL_MCP_TARGET_IDS = EXPORT_TARGET_IDS;

const LOCAL_MCP_SOURCE_LOCATIONS = LOCAL_MCP_TARGET_IDS.flatMap((targetId) =>
  [SETTING_SCOPES.WORKSPACE, SETTING_SCOPES.USER].map((scope) => ({
    source: getMcpLocalSource(targetId, scope),
    targetId,
    scope,
  }))
);

const LOCAL_MCP_SOURCE_LOCATION_BY_SOURCE = new Map(
  LOCAL_MCP_SOURCE_LOCATIONS.map((location) => [location.source, location])
);

function formatScopeLabel(scope: SettingWriteScope): string {
  return scope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User";
}

function formatLocalSourceLabel(source: LocalMcpServerEntry["source"]): string {
  const location = LOCAL_MCP_SOURCE_LOCATION_BY_SOURCE.get(source);
  if (!location) {
    return source;
  }

  const targetLabel =
    location.targetId === SPECIAL_TARGET_IDS.VSCODE
      ? "VS Code"
      : HARNESS_INFO[location.targetId].shortName;
  return `${targetLabel} ${formatScopeLabel(location.scope)}`;
}

function formatPathForDisplay(filePath: string): string {
  return filePath.split("\\").join("/");
}

function getServerSummary(server: McpServerConfig): string {
  return server.url
    ? server.url
    : `${server.command ?? ""}${server.args ? ` ${server.args.join(" ")}` : ""}`;
}

function isDefaultServerEntry(
  entry: string | McpServerConfig,
  id: string
): boolean {
  return typeof entry === "string" ? entry === id : entry.id === id;
}

function upsertDefaultServer(
  current: DefaultMcpServerValue,
  server: McpServerConfig
): DefaultMcpServerValue {
  const remaining = current.filter(
    (entry) => !isDefaultServerEntry(entry, server.id)
  );
  return [...remaining, server];
}

function removeDefaultServer(
  current: DefaultMcpServerValue,
  id: string
): DefaultMcpServerValue {
  return current.filter((entry) => !isDefaultServerEntry(entry, id));
}

function localEntryToServer(entry: LocalMcpServerEntry): McpServerConfig {
  const server: McpServerConfig = { id: entry.id };
  if (entry.command) {
    server.command = entry.command;
  }
  if (entry.args?.length) {
    server.args = entry.args;
  }
  if (entry.env && Object.keys(entry.env).length > 0) {
    server.env = entry.env;
  }
  if (entry.url) {
    server.url = entry.url;
    server.transport = entry.transport ?? MCP_TRANSPORTS.STREAMABLE_HTTP;
  }
  if (entry.headers && Object.keys(entry.headers).length > 0) {
    server.headers = entry.headers;
  }
  return server;
}

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

function getRegistryEntryDisplayName(entry: RegistryMcpEntry): string {
  return entry.name?.trim() || entry.id;
}

function registryEntryToServer(entry: RegistryMcpEntry): McpServerConfig {
  const id = registryEntryToSlug(entry);
  const description = entry.description?.trim() || undefined;

  if (entry.remoteUrl) {
    const server: McpServerConfig = {
      id,
      ...(description ? { description } : {}),
      url: entry.remoteUrl,
      transport: entry.remoteTransport ?? MCP_TRANSPORTS.STREAMABLE_HTTP,
    };
    const requiredHeaders = entry.remoteHeaders?.filter(
      (header) => header.isRequired
    );
    if (requiredHeaders?.length) {
      server.headers = Object.fromEntries(
        requiredHeaders.map((header) => [header.name, ""])
      );
    }
    return server;
  }

  if (entry.installCommand) {
    const parts = entry.installCommand.trim().split(/\s+/).filter(Boolean);
    const server: McpServerConfig = {
      id,
      ...(description ? { description } : {}),
      command: parts[0] ?? "npx",
    };
    if (parts.length > 1) {
      server.args = parts.slice(1);
    }
    if (entry.envVars?.length) {
      server.env = Object.fromEntries(
        entry.envVars.map((envVar) => [envVar.name, ""])
      );
    }
    return server;
  }

  const server: McpServerConfig = entry.packageName
    ? {
        id,
        ...(description ? { description } : {}),
        command: "npx",
        args: ["-y", entry.packageName],
      }
    : { id, ...(description ? { description } : {}), command: "npx" };

  if (entry.envVars?.length) {
    server.env = Object.fromEntries(
      entry.envVars.map((envVar) => [envVar.name, ""])
    );
  }

  return server;
}

function sortRegistryServers(
  servers: RegistryMcpEntry[] | undefined,
  sort: string
): RegistryMcpEntry[] | undefined {
  if (!servers) return undefined;

  if (sort === MCP_MANAGER_REMOTE_SORTS.Z_TO_A) {
    return [...servers].sort((a, b) =>
      getRegistryEntryDisplayName(b).localeCompare(
        getRegistryEntryDisplayName(a)
      )
    );
  }

  if (sort === MCP_MANAGER_REMOTE_SORTS.RECENTLY_UPDATED) {
    return [...servers].sort(
      (a, b) =>
        new Date(b.updatedAt ?? 0).getTime() -
        new Date(a.updatedAt ?? 0).getTime()
    );
  }

  return [...servers].sort((a, b) =>
    getRegistryEntryDisplayName(a).localeCompare(getRegistryEntryDisplayName(b))
  );
}

function encodeTarget(id: AnyTargetId, scope: SettingWriteScope): string {
  return `${id}:${scope}`;
}

function decodeTarget(encoded: string): {
  id: AnyTargetId;
  scope: SettingWriteScope;
} {
  const colonIndex = encoded.lastIndexOf(":");
  return {
    id: encoded.slice(0, colonIndex) as AnyTargetId,
    scope: encoded.slice(colonIndex + 1) as SettingWriteScope,
  };
}

function getExportTargetLabel(id: AnyTargetId): string {
  if (id === SPECIAL_TARGET_IDS.CTRLYOKE) return "ctrlyoke";
  if (id === SPECIAL_TARGET_IDS.VSCODE) return "VS Code";
  if (id in HARNESS_INFO) {
    return HARNESS_INFO[id as keyof typeof HARNESS_INFO].shortName;
  }
  return id;
}

function getExportTargetDescription(
  id: AnyTargetId,
  scope: SettingWriteScope
): string {
  if (id === SPECIAL_TARGET_IDS.CTRLYOKE) {
    return scope === SETTING_SCOPES.WORKSPACE
      ? ".ctrlyoke/mcp/servers.json"
      : "~/.ctrlyoke/mcp/servers.json";
  }
  if (id === SPECIAL_TARGET_IDS.VSCODE) {
    return scope === SETTING_SCOPES.WORKSPACE
      ? ".vscode/mcp.json"
      : "Code/User/mcp.json";
  }
  if (id === HARNESS_IDS.CLAUDE_CLI) {
    return scope === SETTING_SCOPES.WORKSPACE ? ".mcp.json" : "~/.claude.json";
  }
  if (id === HARNESS_IDS.COPILOT_CLI) {
    return scope === SETTING_SCOPES.WORKSPACE
      ? ".github/mcp.json"
      : "~/.copilot/mcp-config.json";
  }
  if (id === HARNESS_IDS.CODEX_CLI) {
    return scope === SETTING_SCOPES.WORKSPACE
      ? ".codex/config.toml"
      : "~/.codex/config.toml";
  }
  if (id === HARNESS_IDS.OPENCODE_CLI) {
    return scope === SETTING_SCOPES.WORKSPACE
      ? "opencode.json"
      : "~/.config/opencode/opencode.json";
  }
  if (id === HARNESS_IDS.QWEN_CLI) {
    return scope === SETTING_SCOPES.WORKSPACE
      ? ".qwen/settings.json"
      : "~/.qwen/settings.json";
  }
  if (id === HARNESS_IDS.ANTIGRAVITY_CLI) {
    return scope === SETTING_SCOPES.WORKSPACE
      ? ".agents/mcp_config.json"
      : "~/.gemini/config/mcp_config.json";
  }
  return scope;
}

function buildExportGroups(
  hasWorkspaceRoot: boolean,
  presentKeys?: Set<string>
): FlyoutGroup[] {
  const workspaceItems: ActionDropdownItem[] = hasWorkspaceRoot
    ? EXPORT_TARGET_IDS.map((id) => {
        const encoded = encodeTarget(id, SETTING_SCOPES.WORKSPACE);
        const alreadyPresent = presentKeys?.has(encoded) ?? false;
        return {
          label: getExportTargetLabel(id),
          value: encoded,
          description: getExportTargetDescription(id, SETTING_SCOPES.WORKSPACE),
          disabled: alreadyPresent,
          title: alreadyPresent ? "Already exported" : undefined,
        };
      })
    : [];

  const userItems: ActionDropdownItem[] = EXPORT_TARGET_IDS.map((id) => {
    const encoded = encodeTarget(id, SETTING_SCOPES.USER);
    const alreadyPresent = presentKeys?.has(encoded) ?? false;
    return {
      label: getExportTargetLabel(id),
      value: encoded,
      description: getExportTargetDescription(id, SETTING_SCOPES.USER),
      disabled: alreadyPresent,
      title: alreadyPresent ? "Already exported" : undefined,
    };
  });

  return [
    ...(workspaceItems.length > 0
      ? [{ id: "workspace", label: "Workspace", items: workspaceItems }]
      : []),
    { id: "user", label: "User", items: userItems },
  ];
}

function getTargetForLocalSource(
  source: LocalMcpServerEntry["source"]
): { targetId: AnyTargetId; scope: SettingWriteScope } | null {
  return LOCAL_MCP_SOURCE_LOCATION_BY_SOURCE.get(source) ?? null;
}

function encodeLocationValue(location: ResolvedServerLocation): string {
  return JSON.stringify(location);
}

function decodeLocationValue(value: string): ResolvedServerLocation {
  return JSON.parse(value) as ResolvedServerLocation;
}

function sortResolvedLocations(
  locations: ResolvedServerLocation[]
): ResolvedServerLocation[] {
  return [...locations].sort((a, b) => {
    if (a.targetId === SPECIAL_TARGET_IDS.CTRLYOKE) {
      return b.targetId === SPECIAL_TARGET_IDS.CTRLYOKE
        ? a.scope.localeCompare(b.scope)
        : -1;
    }
    if (b.targetId === SPECIAL_TARGET_IDS.CTRLYOKE) {
      return 1;
    }
    const labelCompare = getExportTargetLabel(a.targetId).localeCompare(
      getExportTargetLabel(b.targetId),
      undefined,
      { sensitivity: "base" }
    );
    if (labelCompare !== 0) {
      return labelCompare;
    }
    if (a.scope !== b.scope) {
      return a.scope === SETTING_SCOPES.WORKSPACE ? -1 : 1;
    }
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

function ScopeBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-panel-border bg-list-hover-bg px-1.5 py-0.5 text-xxs font-medium leading-none text-foreground">
      {label}
    </span>
  );
}

function ServerDetails({
  server,
  defaultsEnabled,
  locations,
}: {
  server: ManagedMcpServer;
  defaultsEnabled: boolean;
  locations: ResolvedServerLocation[];
}) {
  const config = server.config;
  const detailRows: Array<{ label: string; value: string | null }> = [
    { label: "id", value: config.id },
    { label: "command", value: config.command ?? null },
    { label: "args", value: config.args?.join(" ") ?? null },
    { label: "url", value: config.url ?? null },
    {
      label: "transport",
      value:
        config.transport && config.transport !== MCP_TRANSPORTS.STREAMABLE_HTTP
          ? config.transport
          : null,
    },
    {
      label: "env",
      value: config.env ? Object.keys(config.env).join(", ") : null,
    },
    {
      label: "headers",
      value: config.headers ? Object.keys(config.headers).join(", ") : null,
    },
    {
      label: "autoApprove",
      value:
        typeof config.autoApprove === "boolean"
          ? String(config.autoApprove)
          : (config.autoApprove?.join(", ") ?? null),
    },
    {
      label: "defaults",
      value: defaultsEnabled ? "enabled" : null,
    },
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
      <div className="space-y-1">
        <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
          Locations
        </div>
        {locations.map((location) => (
          <div
            key={`${location.kind}:${location.targetId}:${location.scope}:${location.path}`}
            className="flex items-center gap-2 text-xs text-description-fg"
          >
            <ScopeBadge
              label={`${getExportTargetLabel(location.targetId)} · ${formatScopeLabel(
                location.scope
              )}`}
            />
            <span className="truncate font-mono">
              {formatPathForDisplay(location.path)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function McpManagerSection({ activeScope }: McpManagerSectionProps) {
  const managedServers = useMcpManagerStore((state) => state.managedServers);
  const isLoadingManagedServers = useMcpManagerStore(
    (state) => state.isLoadingRegistry
  );
  const requestServers = useMcpManagerStore((state) => state.requestServers);
  const addOrUpdateServer = useMcpManagerStore(
    (state) => state.addOrUpdateServer
  );
  const deleteServer = useMcpManagerStore((state) => state.deleteServer);
  const deleteFromHarness = useMcpManagerStore(
    (state) => state.deleteFromHarness
  );
  const requestLocalScan = useMcpManagerStore(
    (state) => state.requestLocalScan
  );
  const localServers = useMcpManagerStore((state) => state.localServers);
  const isLoadingLocal = useMcpManagerStore((state) => state.isLoadingLocal);
  const localError = useMcpManagerStore((state) => state.localError);
  const discoveryTab = useMcpManagerStore((state) => state.discoveryTab);
  const setDiscoveryTab = useMcpManagerStore((state) => state.setDiscoveryTab);
  const remoteServers = useMcpManagerStore((state) => state.remoteServers);
  const isLoadingRemote = useMcpManagerStore((state) => state.isLoadingRemote);
  const remoteError = useMcpManagerStore((state) => state.remoteError);
  const remoteNextCursor = useMcpManagerStore(
    (state) => state.remoteNextCursor
  );
  const remotePageCursors = useMcpManagerStore(
    (state) => state.remotePageCursors
  );
  const remoteQuery = useMcpManagerStore((state) => state.remoteQuery);
  const remoteSort = useMcpManagerStore((state) => state.remoteSort);
  const setRemoteSort = useMcpManagerStore((state) => state.setRemoteSort);
  const setRemoteQuery = useMcpManagerStore((state) => state.setRemoteQuery);
  const searchRemoteRegistry = useMcpManagerStore(
    (state) => state.searchRemoteRegistry
  );
  const goNextPage = useMcpManagerStore((state) => state.goNextPage);
  const goPrevPage = useMcpManagerStore((state) => state.goPrevPage);
  const resetPages = useMcpManagerStore((state) => state.resetPages);
  const exportToHarness = useMcpManagerStore((state) => state.exportToHarness);

  const globalSettings = useSettingsStore((state) => state.globalSettings);
  const fullGlobalSettings = useSettingsStore(
    (state) => state.fullGlobalSettings
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<McpServerFormState>(
    EMPTY_MCP_SERVER_FORM_STATE
  );
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<McpServerFormState>(
    EMPTY_MCP_SERVER_FORM_STATE
  );
  const [deleteLocationState, setDeleteLocationState] =
    useState<DeleteLocationState | null>(null);
  const [deleteTargetState, setDeleteTargetState] =
    useState<DeleteTargetState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const hasLoadedRemoteRegistry = useRef(false);

  const defaultsServers = useMemo<DefaultMcpServerValue>(() => {
    const fullDefaults = fullGlobalSettings?.settings?.defaults?.mcpServers;
    if (Array.isArray(fullDefaults)) {
      return fullDefaults;
    }
    if (Array.isArray(globalSettings.mcpServers)) {
      return globalSettings.mcpServers as DefaultMcpServerValue;
    }
    return [];
  }, [fullGlobalSettings, globalSettings.mcpServers]);

  const hasWorkspaceRoot = Boolean(globalSettings.workspaceRoot?.trim());

  const managedServersById = useMemo(
    () => new Map((managedServers ?? []).map((server) => [server.id, server])),
    [managedServers]
  );

  const localLocationsById = useMemo(() => {
    const byId = new Map<string, ResolvedServerLocation[]>();
    for (const entry of localServers) {
      const target = getTargetForLocalSource(entry.source);
      if (!target) {
        continue;
      }
      const location: ResolvedServerLocation = {
        kind: "harness",
        targetId: target.targetId,
        scope: target.scope,
        path: entry.path,
        sourceLabel: formatLocalSourceLabel(entry.source),
      };
      const current = byId.get(entry.id) ?? [];
      current.push(location);
      byId.set(entry.id, current);
    }
    return byId;
  }, [localServers]);

  const sortedRemoteServers = useMemo(
    () => sortRegistryServers(remoteServers, remoteSort),
    [remoteServers, remoteSort]
  );

  const groupedLocalServers = useMemo(() => {
    const groups = new Map<
      LocalMcpServerEntry["source"],
      LocalMcpServerEntry[]
    >();
    for (const entry of localServers) {
      const current = groups.get(entry.source) ?? [];
      current.push(entry);
      groups.set(entry.source, current);
    }
    const orderedSources = [
      ...LOCAL_MCP_TARGET_IDS.map((targetId) =>
        getMcpLocalSource(targetId, SETTING_SCOPES.WORKSPACE)
      ),
      ...LOCAL_MCP_TARGET_IDS.map((targetId) =>
        getMcpLocalSource(targetId, SETTING_SCOPES.USER)
      ),
    ];
    const orderedGroups = orderedSources.flatMap((source) => {
      const entries = groups.get(source);
      return entries ? [{ source, entries }] : [];
    });
    const extraGroups = [...groups.entries()]
      .filter(([source]) => !orderedSources.includes(source))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, entries]) => ({ source, entries }));
    return [...orderedGroups, ...extraGroups];
  }, [localServers]);

  useEffect(() => {
    // Skip fetches a previous mount of this component already satisfied
    // (e.g. before a mobile/desktop layout remount) — avoids needless
    // refetches and a "Loading…" flash over content that's still valid.
    if (managedServers === undefined) {
      requestServers();
    }
    if (localServers.length === 0) {
      requestLocalScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestServers, requestLocalScan]);

  useEffect(() => {
    if (discoveryTab !== MCP_MANAGER_DISCOVERY_TABS.REGISTRY) {
      return;
    }

    const delayMs = hasLoadedRemoteRegistry.current ? 500 : 0;
    const handle = window.setTimeout(() => {
      hasLoadedRemoteRegistry.current = true;
      resetPages();
      searchRemoteRegistry(remoteQuery, undefined, undefined, remoteSort);
    }, delayMs);

    return () => window.clearTimeout(handle);
  }, [discoveryTab, remoteQuery, remoteSort, resetPages, searchRemoteRegistry]);

  useEffect(() => {
    if (editingId && !managedServersById.has(editingId)) {
      setEditingId(null);
      setEditForm(EMPTY_MCP_SERVER_FORM_STATE);
    }
    if (expandedId && !managedServersById.has(expandedId)) {
      setExpandedId(null);
    }
  }, [editingId, expandedId, managedServersById]);

  useEffect(() => {
    const serverIds = (managedServers ?? []).map((server) => server.id);
    setSelectedIds((current) => {
      const next = new Set(serverIds.filter((id) => current.has(id)));
      for (const id of serverIds) {
        next.add(id);
      }
      if (
        next.size === current.size &&
        [...next].every((id) => current.has(id))
      ) {
        return current;
      }
      return next;
    });
  }, [managedServers]);

  const isServerDefault = (id: string): boolean =>
    defaultsServers.some((entry) => isDefaultServerEntry(entry, id));

  const selectedServers = useMemo(
    () => (managedServers ?? []).filter((server) => selectedIds.has(server.id)),
    [managedServers, selectedIds]
  );

  const selectAllState =
    !managedServers || managedServers.length === 0
      ? "none"
      : selectedIds.size === 0
        ? "none"
        : selectedIds.size === managedServers.length
          ? "all"
          : "some";

  const hasServerInRegistryScope = (
    id: string,
    scope: SettingWriteScope
  ): boolean =>
    managedServersById
      .get(id)
      ?.locations.some(
        (location) =>
          location.targetId === SPECIAL_TARGET_IDS.CTRLYOKE &&
          location.scope === scope
      ) ?? false;

  const handleDefaultToggle = (server: ManagedMcpServer) => {
    const nextDefaults = isServerDefault(server.id)
      ? removeDefaultServer(defaultsServers, server.id)
      : upsertDefaultServer(defaultsServers, server.config);

    sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
      path: "defaults.mcpServers",
      value: nextDefaults,
      scope: activeScope,
    });
  };

  const handleStartEdit = (server: ManagedMcpServer) => {
    setEditingId(server.id);
    setEditForm(serverToMcpServerFormState(server.config));
    setExpandedId(server.id);
    setShowAddForm(false);
  };

  const handleSaveEdit = () => {
    if (!editingId || !isMcpServerFormValid(editForm)) return;
    const updatedServer = mcpServerFormStateToServer(editForm);
    addOrUpdateServer(updatedServer, activeScope, editingId);
    setEditingId(null);
    setEditForm(EMPTY_MCP_SERVER_FORM_STATE);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditForm(EMPTY_MCP_SERVER_FORM_STATE);
  };

  const handleAddServer = () => {
    if (!isMcpServerFormValid(addForm)) return;
    addOrUpdateServer(mcpServerFormStateToServer(addForm), activeScope);
    setShowAddForm(false);
    setAddForm(EMPTY_MCP_SERVER_FORM_STATE);
  };

  const handleSearchRegistry = () => {
    hasLoadedRemoteRegistry.current = true;
    resetPages();
    searchRemoteRegistry(remoteQuery, undefined, undefined, remoteSort);
  };

  const handleChangeSort = (sort: string) => {
    if (sort === remoteSort) return;
    resetPages();
    setRemoteSort(sort as typeof remoteSort);
  };

  const handleImportLocal = (entry: LocalMcpServerEntry) => {
    addOrUpdateServer(localEntryToServer(entry), activeScope);
  };

  const handleImportRegistry = (entry: RegistryMcpEntry) => {
    addOrUpdateServer(registryEntryToServer(entry), activeScope);
  };

  const handleConfirmDeleteLocation = () => {
    if (!deleteLocationState) return;
    const { serverId, location } = deleteLocationState;
    if (location.kind === "registry") {
      deleteServer(serverId, location.scope);
    } else {
      deleteFromHarness(
        [serverId],
        location.targetId,
        location.scope,
        location.path
      );
    }
    setDeleteLocationState(null);
  };

  const handleConfirmDeleteTarget = () => {
    if (!deleteTargetState || deleteTargetState.ids.length === 0) return;
    if (deleteTargetState.targetId === SPECIAL_TARGET_IDS.CTRLYOKE) {
      for (const id of deleteTargetState.ids) {
        deleteServer(id, deleteTargetState.scope);
      }
    } else {
      deleteFromHarness(
        deleteTargetState.ids,
        deleteTargetState.targetId,
        deleteTargetState.scope
      );
    }
    setDeleteTargetState(null);
  };

  const handleSaveAll = (id: AnyTargetId, scope: SettingWriteScope) => {
    if (id === SPECIAL_TARGET_IDS.CTRLYOKE) {
      for (const server of selectedServers) {
        addOrUpdateServer(server.config, scope);
      }
      return;
    }
    exportToHarness(
      selectedServers.map((server) => server.config),
      id,
      scope
    );
  };

  const handleDeleteAllRequest = (
    id: AnyTargetId,
    scope: SettingWriteScope
  ) => {
    if (id === SPECIAL_TARGET_IDS.CTRLYOKE) {
      const ids = selectedServers
        .filter((server) =>
          server.locations.some(
            (location) =>
              location.targetId === SPECIAL_TARGET_IDS.CTRLYOKE &&
              location.scope === scope
          )
        )
        .map((server) => server.id);
      setDeleteTargetState({ ids, targetId: id, scope });
      return;
    }
    const ids = localServers
      .filter((entry) => {
        const target = getTargetForLocalSource(entry.source);
        return (
          selectedIds.has(entry.id) &&
          target?.targetId === id &&
          target.scope === scope
        );
      })
      .map((entry) => entry.id);
    setDeleteTargetState({ ids, targetId: id, scope });
  };

  const handleToggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleSelectAll = () => {
    const serverIds = (managedServers ?? []).map((server) => server.id);
    setSelectedIds((current) =>
      current.size === serverIds.length ? new Set() : new Set(serverIds)
    );
  };

  const handleSetDefault = () => {
    const visibleIds = new Set(
      (managedServers ?? []).map((server) => server.id)
    );
    const preservedDefaults = defaultsServers.filter((entry) => {
      const id = typeof entry === "string" ? entry : entry.id;
      return !visibleIds.has(id);
    });
    sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
      path: "defaults.mcpServers",
      value: [
        ...preservedDefaults,
        ...selectedServers.map((server) => server.config),
      ],
      scope: activeScope,
    });
  };

  const getMcpTargetsForScope = (scope: SettingWriteScope): AnyTargetId[] =>
    scope === SETTING_SCOPES.WORKSPACE
      ? hasWorkspaceRoot
        ? [...EXPORT_TARGET_IDS, SPECIAL_TARGET_IDS.CTRLYOKE]
        : []
      : [...EXPORT_TARGET_IDS, SPECIAL_TARGET_IDS.CTRLYOKE];

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <div className="space-y-2 lg:col-span-2">
        <h3
          data-settings-search-id="landmark:mcp-manager:servers"
          className="text-xs font-semibold uppercase tracking-wide text-description-fg"
        >
          MCP Manager
        </h3>
        <p className="text-xs text-description-fg">
          Manage the ctrlyoke MCP registry in the active {activeScope} scope,
          import servers from local configs or the MCP registry, and push or
          remove individual exported copies in external harness configs.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
        <span className="text-xxs text-description-fg">
          Using top-level scope: {formatScopeLabel(activeScope)}
        </span>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
            Managed servers
          </div>
          <span className="text-xxs text-description-fg">
            {managedServers?.length ?? 0} total
          </span>
        </div>

        <div className="rounded-sm border border-panel-border bg-editor-bg px-3 py-2">
          <BulkSelectionActionsBar
            totalCount={managedServers?.length ?? 0}
            selectedCount={selectedServers.length}
            selectAllState={selectAllState}
            onToggleSelectAll={handleToggleSelectAll}
            availableActions={["save", "delete", "setDefault"]}
            getTargetsForScope={getMcpTargetsForScope}
            getTargetLabel={getExportTargetLabel}
            getTargetDescription={getExportTargetDescription}
            defaultTargetId={HARNESS_IDS.CLAUDE_CLI as HarnessId}
            defaultScope={activeScope}
            activeScope={activeScope}
            onSave={handleSaveAll}
            onDelete={handleDeleteAllRequest}
            onSetDefault={handleSetDefault}
            alwaysWrap
          />
        </div>

        <div className="overflow-hidden rounded-sm border border-panel-border">
          {isLoadingManagedServers && managedServers === undefined && (
            <div className="px-3 py-4 text-center text-xs text-description-fg">
              Loading managed servers…
            </div>
          )}

          {!isLoadingManagedServers &&
            managedServers !== undefined &&
            managedServers.length === 0 &&
            !showAddForm && (
              <div className="px-3 py-4 text-center text-xs text-description-fg">
                No managed MCP servers yet.
              </div>
            )}

          {managedServers?.map((server) => {
            const isEditing = editingId === server.id;
            const defaultsEnabled = isServerDefault(server.id);
            const registryLocations: ResolvedServerLocation[] =
              server.locations.map((location) => ({
                kind: "registry",
                targetId: location.targetId,
                scope: location.scope,
                path: location.path,
                sourceLabel: "ctrlyoke Registry",
              }));
            const harnessLocations = localLocationsById.get(server.id) ?? [];
            const allLocations = sortResolvedLocations([
              ...registryLocations,
              ...harnessLocations,
            ]);

            const exportPresentKeys = new Set(
              harnessLocations.map((location) =>
                encodeTarget(location.targetId, location.scope)
              )
            );
            const exportGroups = buildExportGroups(
              hasWorkspaceRoot,
              exportPresentKeys
            );
            const deleteItems: ActionDropdownItem[] = allLocations.map(
              (location) => ({
                label: `${getExportTargetLabel(location.targetId)} (${formatScopeLabel(
                  location.scope
                )})`,
                value: encodeLocationValue(location),
                description: formatPathForDisplay(location.path),
              })
            );

            return (
              <div
                key={server.id}
                className="border-b border-panel-border bg-editor-bg last:border-b-0"
              >
                {isEditing ? (
                  <div className="p-3">
                    <McpServerForm
                      value={editForm}
                      onChange={setEditForm}
                      onSubmit={handleSaveEdit}
                      onCancel={handleCancelEdit}
                      submitLabel={`Save to ${formatScopeLabel(activeScope)}`}
                      title={`Edit ${server.displayName}`}
                      subtitle={`Saving to the ${activeScope} ctrlyoke registry`}
                      autoFocus
                    />
                  </div>
                ) : (
                  <>
                    <div className="px-3 py-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(server.id)}
                          onChange={() => handleToggleSelected(server.id)}
                          aria-label={`Select ${server.displayName}`}
                          className="h-4 w-4 shrink-0 accent-focus-border cursor-pointer"
                        />

                        <button
                          type="button"
                          onClick={() =>
                            setExpandedId(
                              expandedId === server.id ? null : server.id
                            )
                          }
                          className="flex h-4 w-4 shrink-0 items-center justify-center text-description-fg hover:text-foreground"
                          aria-label={
                            expandedId === server.id
                              ? `Collapse ${server.id}`
                              : `Expand ${server.id}`
                          }
                        >
                          <Icon
                            name="chevron"
                            className={`-${
                              expandedId === server.id ? "down" : "right"
                            } text-xxs`}
                          />
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setExpandedId(
                              expandedId === server.id ? null : server.id
                            )
                          }
                          className="flex min-w-28 flex-1 items-center gap-1.5 text-left"
                        >
                          <span className="truncate text-xs font-medium text-foreground">
                            {server.displayName}
                          </span>
                          {server.displayName !== server.id && (
                            <span className="shrink-0 rounded-sm bg-list-hover-bg px-1 py-0.5 font-mono text-xxs text-description-fg">
                              {server.id}
                            </span>
                          )}
                        </button>

                        <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleStartEdit(server)}
                            className="flex h-6 items-center justify-center rounded-sm border border-panel-border px-1.5 text-xxs text-description-fg transition-colors hover:border-focus-border hover:text-foreground"
                            title={`Edit ${server.id} in ${activeScope}`}
                            aria-label={`Edit ${server.id}`}
                          >
                            <Icon name="edit" className="text-xxs" />
                          </button>

                          <FlyoutActionDropdown
                            label="Save"
                            icon="save"
                            iconOnly
                            groups={exportGroups}
                            onSelect={(encoded) => {
                              const { id, scope } = decodeTarget(encoded);
                              exportToHarness([server.config], id, scope);
                            }}
                          />

                          <ActionDropdown
                            label="Delete"
                            icon="trash"
                            iconOnly
                            items={deleteItems}
                            onSelect={(value) =>
                              setDeleteLocationState({
                                serverId: server.id,
                                displayName: server.displayName,
                                location: decodeLocationValue(value),
                              })
                            }
                            className="text-error-fg"
                          />

                          <button
                            type="button"
                            onClick={() => handleDefaultToggle(server)}
                            className={`flex h-6 items-center justify-center gap-1 rounded-sm border px-1.5 text-xxs transition-colors ${
                              defaultsEnabled
                                ? "border-btn-bg bg-btn-bg text-btn-fg hover:bg-btn-hover"
                                : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
                            }`}
                            title={
                              defaultsEnabled
                                ? `Remove from default MCP servers (${activeScope})`
                                : `Add to default MCP servers (${activeScope})`
                            }
                            aria-label={
                              defaultsEnabled
                                ? `Remove from default MCP servers (${activeScope})`
                                : `Add to default MCP servers (${activeScope})`
                            }
                          >
                            <Icon name="globe" className="text-xxs" />
                            {defaultsEnabled && <span>Default</span>}
                          </button>
                        </div>
                      </div>

                      {server.config.description && (
                        <p
                          className="mt-1 truncate text-xs text-description-fg"
                          title={server.config.description}
                        >
                          {server.config.description}
                        </p>
                      )}

                      <div className="mt-1 truncate font-mono text-xxs text-description-fg">
                        {getServerSummary(server.config)}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {allLocations.map((location) => (
                          <ScopeBadge
                            key={`${server.id}:${location.kind}:${location.targetId}:${location.scope}:${location.path}`}
                            label={`${getExportTargetLabel(
                              location.targetId
                            )}${location.scope === SETTING_SCOPES.USER ? " ·user" : ""}`}
                          />
                        ))}
                      </div>
                    </div>

                    {expandedId === server.id && (
                      <ServerDetails
                        server={server}
                        defaultsEnabled={defaultsEnabled}
                        locations={allLocations}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}

          <div className="p-3">
            {showAddForm ? (
              <McpServerForm
                value={addForm}
                onChange={setAddForm}
                onSubmit={handleAddServer}
                onCancel={() => {
                  setShowAddForm(false);
                  setAddForm(EMPTY_MCP_SERVER_FORM_STATE);
                }}
                submitLabel={`Add to ${formatScopeLabel(activeScope)}`}
                title="Add MCP server"
                subtitle={`Save to the ${activeScope} ctrlyoke registry`}
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(true);
                  setEditingId(null);
                }}
                className="flex items-center gap-1 rounded-sm border border-dashed border-panel-border px-2 py-1 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground"
              >
                <Icon name="add" className="text-xxs" />
                Add server
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
          Discover &amp; import
        </div>

        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setDiscoveryTab(MCP_MANAGER_DISCOVERY_TABS.LOCAL)}
            className={`flex items-center gap-1 rounded-sm border px-2 py-1 text-xs transition-colors ${
              discoveryTab === MCP_MANAGER_DISCOVERY_TABS.LOCAL
                ? "border-btn-bg bg-btn-bg text-btn-fg"
                : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
            }`}
          >
            <Icon name="folder-opened" className="text-xxs" />
            Local configs
          </button>
          <button
            type="button"
            onClick={() => setDiscoveryTab(MCP_MANAGER_DISCOVERY_TABS.REGISTRY)}
            className={`flex items-center gap-1 rounded-sm border px-2 py-1 text-xs transition-colors ${
              discoveryTab === MCP_MANAGER_DISCOVERY_TABS.REGISTRY
                ? "border-btn-bg bg-btn-bg text-btn-fg"
                : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
            }`}
          >
            <Icon name="globe" className="text-xxs" />
            Registry
          </button>
          {!isStandalone && (
            <button
              type="button"
              onClick={() => sendMessage(MESSAGE_TYPES.OPEN_VSCODE_MCP_BROWSER)}
              title="Open VS Code's MCP Servers Panel. Browse and install MCPs from Microsoft's curated list of MCP servers, then return here and click 'Scan again' to import them"
              className="flex items-center gap-1 rounded-sm border border-panel-border px-2 py-1 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground"
            >
              <Icon name="extensions" className="text-xxs" />
              VS Code MCP
            </button>
          )}
        </div>

        {discoveryTab === MCP_MANAGER_DISCOVERY_TABS.LOCAL && (
          <div className="space-y-2 rounded-sm border border-panel-border bg-editor-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs text-description-fg">
                Import local MCP entries into the {activeScope} ctrlyoke
                registry. After installing a server via VS Code or another tool,
                click{" "}
                <span className="font-medium text-foreground">Scan again</span>{" "}
                to pick up the changes.
              </div>
              <button
                type="button"
                onClick={requestLocalScan}
                disabled={isLoadingLocal}
                className="ml-auto rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isLoadingLocal ? "Scanning…" : "Scan again"}
              </button>
            </div>

            {isLoadingLocal ? (
              <div className="flex items-center gap-1.5 text-xs text-description-fg">
                <Icon
                  name="loading"
                  className="codicon-modifier-spin text-xxs"
                />
                Scanning local configs…
              </div>
            ) : localError ? (
              <div className="text-xs text-error-fg">{localError}</div>
            ) : groupedLocalServers.length === 0 ? (
              <div className="text-xs text-description-fg italic">
                No MCP servers found in local config files.
              </div>
            ) : (
              <div className="space-y-2">
                {groupedLocalServers.map((group) => (
                  <div key={group.source} className="space-y-1.5">
                    <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
                      {formatLocalSourceLabel(group.source)}
                    </div>
                    {group.entries.map((entry) => {
                      const alreadyAdded = hasServerInRegistryScope(
                        entry.id,
                        activeScope
                      );
                      return (
                        <div
                          key={`${entry.source}:${entry.path}:${entry.id}`}
                          className="flex items-center justify-between gap-2 rounded-sm border border-panel-border px-2 py-1.5"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-foreground">
                              {entry.id}
                            </div>
                            <div className="truncate font-mono text-xxs text-description-fg">
                              {entry.url
                                ? entry.transport === MCP_TRANSPORTS.SSE
                                  ? `${MCP_TRANSPORTS.SSE}: ${entry.url}`
                                  : entry.url
                                : `${entry.command ?? ""}${
                                    entry.args?.length
                                      ? ` ${entry.args.join(" ")}`
                                      : ""
                                  }`}
                            </div>
                            <div className="truncate font-mono text-xxs text-description-fg">
                              {formatPathForDisplay(entry.path)}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={alreadyAdded}
                            onClick={() => handleImportLocal(entry)}
                            className="rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                            title={
                              alreadyAdded
                                ? `Already in ${activeScope} registry`
                                : `Import ${entry.id} into ${activeScope}`
                            }
                          >
                            {alreadyAdded ? "Imported" : "Import"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {discoveryTab === MCP_MANAGER_DISCOVERY_TABS.REGISTRY && (
          <div className="space-y-2 rounded-sm border border-panel-border bg-editor-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={remoteQuery}
                onChange={(event) => setRemoteQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === KEYBOARD_KEYS.ENTER) {
                    event.preventDefault();
                    handleSearchRegistry();
                  }
                }}
                placeholder="Search the MCP registry…"
                aria-label="Search MCP registry"
                className="min-w-[220px] flex-1 rounded-sm border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg focus:border-focus-border focus:outline-hidden"
              />
              <button
                type="button"
                onClick={handleSearchRegistry}
                disabled={isLoadingRemote}
                className="rounded-sm border border-panel-border px-2 py-1 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Search
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xxs text-description-fg">Sort:</span>
              {[
                MCP_MANAGER_REMOTE_SORTS.A_TO_Z,
                MCP_MANAGER_REMOTE_SORTS.Z_TO_A,
                MCP_MANAGER_REMOTE_SORTS.RECENTLY_UPDATED,
              ].map((sort) => (
                <button
                  key={sort}
                  type="button"
                  onClick={() => handleChangeSort(sort)}
                  className={`rounded-sm border px-1.5 py-0 text-xxs transition-colors ${
                    remoteSort === sort
                      ? "border-btn-bg bg-btn-bg text-btn-fg"
                      : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
                  }`}
                >
                  {sort === MCP_MANAGER_REMOTE_SORTS.A_TO_Z
                    ? "A–Z"
                    : sort === MCP_MANAGER_REMOTE_SORTS.Z_TO_A
                      ? "Z–A"
                      : "Recently Updated"}
                </button>
              ))}
            </div>

            {isLoadingRemote ? (
              <div className="flex items-center gap-1.5 text-xs text-description-fg">
                <Icon
                  name="loading"
                  className="codicon-modifier-spin text-xxs"
                />
                Fetching from MCP Registry…
              </div>
            ) : remoteError ? (
              <div className="text-xs text-error-fg">{remoteError}</div>
            ) : sortedRemoteServers && sortedRemoteServers.length > 0 ? (
              <>
                <div className="space-y-2">
                  {sortedRemoteServers.map((entry) => {
                    const importId = registryEntryToSlug(entry);
                    const alreadyAdded = hasServerInRegistryScope(
                      importId,
                      activeScope
                    );
                    return (
                      <div
                        key={entry.id}
                        className="flex items-start justify-between gap-2 rounded-sm border border-panel-border px-2 py-1.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <span className="truncate text-xs font-medium text-foreground">
                              {getRegistryEntryDisplayName(entry)}
                            </span>
                            {entry.verified && (
                              <Icon
                                name="verified-filled"
                                className="shrink-0 text-xxs text-verified"
                                title="MCP Registry verified"
                              />
                            )}
                          </div>
                          <div className="truncate font-mono text-xxs text-description-fg">
                            {entry.installCommand
                              ? entry.installCommand
                              : entry.remoteUrl
                                ? `${entry.remoteTransport ?? MCP_TRANSPORTS.STREAMABLE_HTTP}: ${entry.remoteUrl}`
                                : (entry.packageName ?? entry.id)}
                          </div>
                          {entry.description && (
                            <div className="line-clamp-2 text-xxs text-description-fg">
                              {entry.description}
                            </div>
                          )}
                          {entry.envVars?.length ? (
                            <div className="text-xxs text-description-fg">
                              Requires env:{" "}
                              {entry.envVars
                                .map((envVar) => envVar.name)
                                .join(", ")}
                            </div>
                          ) : null}
                          {entry.remoteHeaders?.filter(
                            (header) => header.isRequired
                          ).length ? (
                            <div className="text-xxs text-description-fg">
                              Requires header:{" "}
                              {entry.remoteHeaders
                                .filter((header) => header.isRequired)
                                .map((header) => header.name)
                                .join(", ")}
                            </div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          disabled={alreadyAdded}
                          onClick={() => handleImportRegistry(entry)}
                          className="mt-0.5 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          title={
                            alreadyAdded
                              ? `Already in ${activeScope} registry`
                              : `Import ${getRegistryEntryDisplayName(entry)} into ${activeScope}`
                          }
                        >
                          {alreadyAdded ? "Imported" : "Import"}
                        </button>
                      </div>
                    );
                  })}
                </div>

                {(remotePageCursors.length > 1 ||
                  Boolean(remoteNextCursor)) && (
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={goPrevPage}
                      disabled={
                        remotePageCursors.length <= 1 || isLoadingRemote
                      }
                      className="flex items-center gap-1 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <Icon name="chevron-left" className="text-xxs" />
                      Prev
                    </button>
                    <span className="text-xxs text-description-fg">
                      Page {remotePageCursors.length}
                    </span>
                    <button
                      type="button"
                      onClick={goNextPage}
                      disabled={!remoteNextCursor || isLoadingRemote}
                      className="flex items-center gap-1 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      Next
                      <Icon name="chevron-right" className="text-xxs" />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-description-fg italic">
                No registry results yet.
              </div>
            )}
          </div>
        )}
      </div>

      {deleteLocationState && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
          role="button"
          tabIndex={0}
          aria-label="Close delete MCP location dialog"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setDeleteLocationState(null);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === KEYBOARD_KEYS.ENTER ||
                event.key === " " ||
                event.key === KEYBOARD_KEYS.ESCAPE)
            ) {
              event.preventDefault();
              setDeleteLocationState(null);
            }
          }}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-sm border border-panel-border bg-editor-bg p-4 shadow-lg"
            role="dialog"
            aria-modal="true"
          >
            <p className="mb-1 text-sm font-semibold text-foreground">
              Delete MCP location?
            </p>
            <p className="mb-4 text-xs text-description-fg">
              Remove <strong>{deleteLocationState.displayName}</strong> from{" "}
              <strong>
                {getExportTargetLabel(deleteLocationState.location.targetId)}
              </strong>{" "}
              ({deleteLocationState.location.scope})?
            </p>
            <div className="mb-4 truncate font-mono text-xxs text-description-fg">
              {formatPathForDisplay(deleteLocationState.location.path)}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteLocationState(null)}
                className="rounded-sm border border-btn-border bg-btn-secondary-bg px-3 py-1 text-xs text-btn-secondary-fg hover:bg-btn-secondary-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteLocation}
                className="rounded-sm bg-btn-bg px-3 py-1 text-xs text-btn-fg hover:bg-btn-hover"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTargetState && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
          role="button"
          tabIndex={0}
          aria-label="Close delete selected MCP servers dialog"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setDeleteTargetState(null);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === KEYBOARD_KEYS.ENTER ||
                event.key === " " ||
                event.key === KEYBOARD_KEYS.ESCAPE)
            ) {
              event.preventDefault();
              setDeleteTargetState(null);
            }
          }}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-sm border border-panel-border bg-editor-bg p-4 shadow-lg"
            role="dialog"
            aria-modal="true"
          >
            <p className="mb-1 text-sm font-semibold text-foreground">
              Delete selected MCP servers?
            </p>
            <p className="mb-4 text-xs text-description-fg">
              Remove {deleteTargetState.ids.length} selected MCP server
              {deleteTargetState.ids.length === 1 ? "" : "s"} configured in{" "}
              <strong>
                {getExportTargetLabel(deleteTargetState.targetId)}
              </strong>{" "}
              ({deleteTargetState.scope})? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTargetState(null)}
                className="rounded-sm border border-btn-border bg-btn-secondary-bg px-3 py-1 text-xs text-btn-secondary-fg hover:bg-btn-secondary-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteTarget}
                className="rounded-sm bg-btn-bg px-3 py-1 text-xs text-btn-fg hover:bg-btn-hover"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
