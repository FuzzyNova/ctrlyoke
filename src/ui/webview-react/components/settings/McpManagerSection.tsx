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
import {
  EMPTY_MCP_SERVER_FORM_STATE,
  McpServerForm,
  type McpServerFormState,
  isMcpServerFormValid,
  mcpServerFormStateToServer,
  serverToMcpServerFormState,
} from "@components/shared/McpServerForm";
import { MESSAGE_TYPES } from "@/types/messages";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
  type AnyTargetId,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import type { McpServerConfig } from "@root/types/FlightPathTypes";
import type {
  LocalMcpServerEntry,
  ManagedMcpServer,
  ManagedMcpServerLocation,
  RegistryMcpEntry,
} from "@root/types/WebviewMessageTypes";

type DefaultMcpServerValue = (string | McpServerConfig)[];
type PendingExportTarget = {
  id: AnyTargetId;
  scope: SettingWriteScope;
};

function formatScopeLabel(scope: SettingWriteScope): string {
  return scope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User";
}

function formatLocalSourceLabel(source: LocalMcpServerEntry["source"]): string {
  switch (source) {
    case "vscode-workspace":
      return "VS Code Workspace";
    case "vscode-user":
      return "VS Code User";
    case "claude-workspace":
      return "Claude Code Workspace";
    case "claude-user":
      return "Claude Code User";
    case "copilot-workspace":
      return "Copilot CLI Workspace";
    case "copilot-user":
      return "Copilot CLI User";
    case "codex-workspace":
      return "Codex Workspace";
    case "codex-user":
      return "Codex User";
    case "opencode-workspace":
      return "OpenCode Workspace";
    case "opencode-user":
      return "OpenCode User";
    case "qwen-workspace":
      return "Qwen Code Workspace";
    case "qwen-user":
      return "Qwen Code User";
  }

  return source;
}

function formatPathForDisplay(filePath: string): string {
  return filePath.split("\\").join("/");
}

function getServerSummary(server: McpServerConfig): string {
  return server.url
    ? server.url
    : `${server.command ?? ""}${server.args ? ` ${server.args.join(" ")}` : ""}`;
}

function isDefaultServerEntry(entry: string | McpServerConfig, id: string): boolean {
  return typeof entry === "string" ? entry === id : entry.id === id;
}

function upsertDefaultServer(
  current: DefaultMcpServerValue,
  server: McpServerConfig
): DefaultMcpServerValue {
  const remaining = current.filter((entry) => !isDefaultServerEntry(entry, server.id));
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
    server.transport = entry.transport ?? "streamable-http";
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

  if (entry.remoteUrl) {
    const server: McpServerConfig = {
      id,
      url: entry.remoteUrl,
      transport: entry.remoteTransport ?? "streamable-http",
    };
    const requiredHeaders = entry.remoteHeaders?.filter((header) => header.isRequired);
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
      command: parts[0] ?? "npx",
    };
    if (parts.length > 1) {
      server.args = parts.slice(1);
    }
    if (entry.envVars?.length) {
      server.env = Object.fromEntries(entry.envVars.map((envVar) => [envVar.name, ""]));
    }
    return server;
  }

  const server: McpServerConfig = entry.packageName
    ? { id, command: "npx", args: ["-y", entry.packageName] }
    : { id, command: "npx" };

  if (entry.envVars?.length) {
    server.env = Object.fromEntries(entry.envVars.map((envVar) => [envVar.name, ""]));
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
      getRegistryEntryDisplayName(b).localeCompare(getRegistryEntryDisplayName(a))
    );
  }

  if (sort === MCP_MANAGER_REMOTE_SORTS.RECENTLY_UPDATED) {
    return [...servers].sort(
      (a, b) =>
        new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
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
      ? ".mcp.json or .github/mcp.json"
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
  return scope;
}

function buildExportGroups(hasWorkspaceRoot: boolean): FlyoutGroup[] {
  const exportTargets = [
    SPECIAL_TARGET_IDS.VSCODE,
    HARNESS_IDS.CLAUDE_CLI,
    HARNESS_IDS.COPILOT_CLI,
    HARNESS_IDS.CODEX_CLI,
    HARNESS_IDS.OPENCODE_CLI,
    HARNESS_IDS.QWEN_CLI,
  ] as const;

  const workspaceItems: ActionDropdownItem[] = hasWorkspaceRoot
    ? exportTargets.map((id) => ({
        label: getExportTargetLabel(id),
        value: encodeTarget(id, SETTING_SCOPES.WORKSPACE),
        description: getExportTargetDescription(id, SETTING_SCOPES.WORKSPACE),
      }))
    : [];

  const userItems: ActionDropdownItem[] = exportTargets.map((id) => ({
    label: getExportTargetLabel(id),
    value: encodeTarget(id, SETTING_SCOPES.USER),
    description: getExportTargetDescription(id, SETTING_SCOPES.USER),
  }));

  return [
    ...(workspaceItems.length > 0
      ? [{ id: "workspace", label: "Workspace", items: workspaceItems }]
      : []),
    { id: "user", label: "User", items: userItems },
  ];
}

function ScopeBadge({ scope }: { scope: SettingWriteScope }) {
  return (
    <span className="inline-flex items-center rounded border border-panel-border bg-list-hover-bg px-1.5 py-0.5 text-xxs font-medium leading-none text-foreground">
      {formatScopeLabel(scope)}
    </span>
  );
}

function ServerDetails({
  server,
  defaultsEnabled,
}: {
  server: ManagedMcpServer;
  defaultsEnabled: boolean;
}) {
  const config = server.config;
  const detailRows: Array<{ label: string; value: string | null }> = [
    { label: "id", value: config.id },
    { label: "command", value: config.command ?? null },
    { label: "args", value: config.args?.join(" ") ?? null },
    { label: "url", value: config.url ?? null },
    {
      label: "transport",
      value: config.transport && config.transport !== "streamable-http"
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
          : config.autoApprove?.join(", ") ?? null,
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
          Registry locations
        </div>
        {server.locations.map((location) => (
          <div
            key={`${location.scope}:${location.path}`}
            className="flex items-center gap-2 text-xs text-description-fg"
          >
            <ScopeBadge scope={location.scope} />
            <span className="truncate font-mono">
              {formatPathForDisplay(location.path)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function McpManagerSection() {
  const managedServers = useMcpManagerStore((state) => state.managedServers);
  const isLoadingManagedServers = useMcpManagerStore(
    (state) => state.isLoadingRegistry
  );
  const activeScope = useMcpManagerStore((state) => state.activeScope);
  const setActiveScope = useMcpManagerStore((state) => state.setActiveScope);
  const requestServers = useMcpManagerStore((state) => state.requestServers);
  const addOrUpdateServer = useMcpManagerStore((state) => state.addOrUpdateServer);
  const deleteServer = useMcpManagerStore((state) => state.deleteServer);
  const requestLocalScan = useMcpManagerStore((state) => state.requestLocalScan);
  const localServers = useMcpManagerStore((state) => state.localServers);
  const isLoadingLocal = useMcpManagerStore((state) => state.isLoadingLocal);
  const localError = useMcpManagerStore((state) => state.localError);
  const discoveryTab = useMcpManagerStore((state) => state.discoveryTab);
  const setDiscoveryTab = useMcpManagerStore((state) => state.setDiscoveryTab);
  const remoteServers = useMcpManagerStore((state) => state.remoteServers);
  const isLoadingRemote = useMcpManagerStore((state) => state.isLoadingRemote);
  const remoteError = useMcpManagerStore((state) => state.remoteError);
  const remoteNextCursor = useMcpManagerStore((state) => state.remoteNextCursor);
  const remotePageCursors = useMcpManagerStore((state) => state.remotePageCursors);
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
  const fullGlobalSettings = useSettingsStore((state) => state.fullGlobalSettings);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<McpServerFormState>(
    EMPTY_MCP_SERVER_FORM_STATE
  );
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<McpServerFormState>(
    EMPTY_MCP_SERVER_FORM_STATE
  );
  const [pendingExportTarget, setPendingExportTarget] =
    useState<PendingExportTarget | null>(null);

  const didAutoScanLocal = useRef(false);
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

  const sortedRemoteServers = useMemo(
    () => sortRegistryServers(remoteServers, remoteSort),
    [remoteServers, remoteSort]
  );

  const groupedLocalServers = useMemo(() => {
    const groups = new Map<LocalMcpServerEntry["source"], LocalMcpServerEntry[]>();
    for (const entry of localServers) {
      const current = groups.get(entry.source) ?? [];
      current.push(entry);
      groups.set(entry.source, current);
    }
    const orderedSources = [
      "vscode-workspace",
      "claude-workspace",
      "copilot-workspace",
      "codex-workspace",
      "opencode-workspace",
      "qwen-workspace",
      "vscode-user",
      "claude-user",
      "copilot-user",
      "codex-user",
      "opencode-user",
      "qwen-user",
    ] as LocalMcpServerEntry["source"][];
    const orderedGroups = orderedSources.flatMap((source) => {
      const entries = groups.get(source as LocalMcpServerEntry["source"]);
      return entries ? [{ source, entries }] : [];
    });
    const extraGroups = [...groups.entries()]
      .filter(([source]) => !orderedSources.includes(source))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, entries]) => ({ source, entries }));
    return [...orderedGroups, ...extraGroups];
  }, [localServers]);

  const exportGroups = useMemo(
    () => buildExportGroups(hasWorkspaceRoot),
    [hasWorkspaceRoot]
  );

  const exportableServers = useMemo(
    () => (managedServers ?? []).map((server) => server.config),
    [managedServers]
  );

  useEffect(() => {
    requestServers();
  }, [requestServers]);

  useEffect(() => {
    if (
      discoveryTab !== MCP_MANAGER_DISCOVERY_TABS.LOCAL ||
      didAutoScanLocal.current ||
      isLoadingLocal ||
      localError ||
      localServers.length > 0
    ) {
      return;
    }

    didAutoScanLocal.current = true;
    requestLocalScan();
  }, [discoveryTab, isLoadingLocal, localError, localServers.length, requestLocalScan]);

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

  const isServerDefault = (id: string): boolean =>
    defaultsServers.some((entry) => isDefaultServerEntry(entry, id));

  const hasServerInScope = (id: string, scope: SettingWriteScope): boolean =>
    managedServersById
      .get(id)
      ?.locations.some((location) => location.scope === scope) ?? false;

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
    const preferredScope =
      server.locations.find((location) => location.scope === activeScope)?.scope ??
      server.locations[0]?.scope ??
      activeScope;

    if (preferredScope !== activeScope) {
      setActiveScope(preferredScope);
    }

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

  const handleConfirmExport = () => {
    if (!pendingExportTarget) return;
    exportToHarness(
      exportableServers,
      pendingExportTarget.id,
      pendingExportTarget.scope
    );
    setPendingExportTarget(null);
  };

  const exportSubtitle =
    `Export ${exportableServers.length} managed server${exportableServers.length === 1 ? "" : "s"} to another harness config`;
  const pendingExportPath = pendingExportTarget
    ? getExportTargetDescription(
        pendingExportTarget.id,
        pendingExportTarget.scope
      )
    : "";
  const pendingExportLabel = pendingExportTarget
    ? `${formatScopeLabel(pendingExportTarget.scope)} ${getExportTargetLabel(
        pendingExportTarget.id
      )}`
    : "";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-description-fg">
          MCP Manager
        </h3>
        <p className="text-xs text-description-fg">
          Manage the FlightPath MCP registry, import servers from local configs or
          the MCP registry, and export managed servers to external harness configs.
          The selected scope controls add, edit, import, and default-toggle writes.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="fp-mode-switch" role="group" aria-label="MCP manager scope">
          <button
            type="button"
            onClick={() => setActiveScope(SETTING_SCOPES.WORKSPACE)}
            className={`fp-mode-switch-btn ${activeScope === SETTING_SCOPES.WORKSPACE ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
            title="Save, import, and write defaults to workspace scope"
          >
            <i className="codicon codicon-project" />
            Workspace
          </button>
          <div className="fp-mode-switch-divider">
            <div className="h-full w-px bg-current opacity-40" />
          </div>
          <button
            type="button"
            onClick={() => setActiveScope(SETTING_SCOPES.USER)}
            className={`fp-mode-switch-btn ${activeScope === SETTING_SCOPES.USER ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
            title="Save, import, and write defaults to user scope"
          >
            <i className="codicon codicon-person" />
            User
          </button>
        </div>

        <span className="text-xxs text-description-fg">
          Active scope: {formatScopeLabel(activeScope)}
        </span>

        <div className="ml-auto">
          {exportableServers.length > 0 ? (
            <FlyoutActionDropdown
              label="Export to Harness"
              groups={exportGroups}
              onSelect={(encoded) => setPendingExportTarget(decodeTarget(encoded))}
            />
          ) : (
            <button
              type="button"
              disabled
              title="No managed servers available to export"
              className="rounded border border-btn-border bg-btn-secondary-bg px-2 py-0.5 text-xs text-disabled-fg"
            >
              Export to Harness
            </button>
          )}
        </div>
      </div>

      {pendingExportTarget && (
        <div className="rounded border border-focus-border bg-editor-bg px-3 py-2">
          <div className="text-xs font-medium text-foreground">
            Export {exportableServers.length} managed server
            {exportableServers.length === 1 ? "" : "s"} to {pendingExportLabel}
          </div>
          <div className="mt-0.5 text-xxs text-description-fg">
            Destination:{" "}
            <span className="font-mono">{pendingExportPath}</span>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleConfirmExport}
              className="rounded border border-btn-bg bg-btn-bg px-2 py-0.5 text-xs text-btn-fg transition-colors hover:bg-btn-hover"
            >
              Confirm export
            </button>
            <button
              type="button"
              onClick={() => setPendingExportTarget(null)}
              className="rounded border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
            Installed servers
          </div>
          <span className="text-xxs text-description-fg">
            {managedServers?.length ?? 0} total
          </span>
          <span className="ml-auto text-xxs text-description-fg">
            {exportSubtitle}
          </span>
        </div>

        <div className="overflow-hidden rounded border border-panel-border">
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
            const removeItems: ActionDropdownItem[] = [
              ...server.locations.map((location: ManagedMcpServerLocation) => ({
                label: `Remove ${formatScopeLabel(location.scope)} copy`,
                value: location.scope,
                description: formatPathForDisplay(location.path),
              })),
              ...(server.locations.length > 1
                ? [
                    {
                      label: "Remove both copies",
                      value: "both",
                      description: "Delete the workspace and user registry entries",
                    },
                  ]
                : []),
            ];

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
                      subtitle={`Saving to the ${activeScope} MCP registry`}
                      autoFocus
                    />
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(expandedId === server.id ? null : server.id)
                        }
                        className="mt-0.5 flex h-4 w-4 items-center justify-center text-description-fg hover:text-foreground"
                        aria-label={
                          expandedId === server.id
                            ? `Collapse ${server.id}`
                            : `Expand ${server.id}`
                        }
                      >
                        <i
                          className={`codicon codicon-chevron-${expandedId === server.id ? "down" : "right"} text-xxs`}
                        />
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(expandedId === server.id ? null : server.id)
                        }
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-foreground">
                            {server.displayName}
                          </span>
                          {server.displayName !== server.id && (
                            <span className="rounded bg-list-hover-bg px-1 py-0.5 font-mono text-xxs text-description-fg">
                              {server.id}
                            </span>
                          )}
                          {server.locations.map((location) => (
                            <ScopeBadge
                              key={`${server.id}:${location.scope}:${location.path}`}
                              scope={location.scope}
                            />
                          ))}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-xxs text-description-fg">
                          {getServerSummary(server.config)}
                        </div>
                      </button>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleDefaultToggle(server)}
                          className={`rounded border px-1.5 py-0.5 text-xxs transition-colors ${
                            defaultsEnabled
                              ? "border-btn-bg bg-btn-bg text-btn-fg hover:bg-btn-hover"
                              : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
                          }`}
                          title={
                            defaultsEnabled
                              ? `Remove from default MCP servers (${activeScope})`
                              : `Add to default MCP servers (${activeScope})`
                          }
                        >
                          {defaultsEnabled ? "Default" : "Set default"}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleStartEdit(server)}
                          className="flex h-5 w-5 items-center justify-center rounded text-description-fg hover:bg-toolbar-hover-bg hover:text-foreground"
                          aria-label={`Edit ${server.id}`}
                          title={`Edit ${server.id}`}
                        >
                          <i className="codicon codicon-edit text-xxs" />
                        </button>

                        {removeItems.length === 1 ? (
                          <button
                            type="button"
                            onClick={() =>
                              deleteServer(server.id, server.locations[0].scope)
                            }
                            className="flex h-5 w-5 items-center justify-center rounded text-description-fg hover:bg-toolbar-hover-bg hover:text-error-fg"
                            aria-label={`Remove ${server.id}`}
                            title={`Remove ${server.id} from ${formatScopeLabel(
                              server.locations[0].scope
                            )}`}
                          >
                            <i className="codicon codicon-close text-xxs" />
                          </button>
                        ) : (
                          <ActionDropdown
                            label="Remove…"
                            items={removeItems}
                            onSelect={(scope) => {
                              if (scope === "both") {
                                server.locations.forEach((location) =>
                                  deleteServer(server.id, location.scope)
                                );
                                return;
                              }
                              deleteServer(server.id, scope as SettingWriteScope);
                            }}
                            className="shrink-0"
                          />
                        )}
                      </div>
                    </div>

                    {expandedId === server.id && (
                      <ServerDetails
                        server={server}
                        defaultsEnabled={defaultsEnabled}
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
                subtitle={`Save to the ${activeScope} MCP registry`}
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(true);
                  setEditingId(null);
                }}
                className="flex items-center gap-1 rounded border border-dashed border-panel-border px-2 py-1 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground"
              >
                <i className="codicon codicon-add text-xxs" />
                Add server
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
          Discover &amp; import
        </div>

        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setDiscoveryTab(MCP_MANAGER_DISCOVERY_TABS.LOCAL)}
            className={`flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors ${
              discoveryTab === MCP_MANAGER_DISCOVERY_TABS.LOCAL
                ? "border-btn-bg bg-btn-bg text-btn-fg"
                : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
            }`}
          >
            <i className="codicon codicon-folder-opened text-xxs" />
            Local configs
          </button>
          <button
            type="button"
            onClick={() => setDiscoveryTab(MCP_MANAGER_DISCOVERY_TABS.REGISTRY)}
            className={`flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors ${
              discoveryTab === MCP_MANAGER_DISCOVERY_TABS.REGISTRY
                ? "border-btn-bg bg-btn-bg text-btn-fg"
                : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
            }`}
          >
            <i className="codicon codicon-globe text-xxs" />
            Registry
          </button>
        </div>

        {discoveryTab === MCP_MANAGER_DISCOVERY_TABS.LOCAL && (
          <div className="space-y-2 rounded border border-panel-border bg-editor-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs text-description-fg">
                Import local MCP entries into the {activeScope} registry.
              </div>
              <button
                type="button"
                onClick={requestLocalScan}
                disabled={isLoadingLocal}
                className="ml-auto rounded border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isLoadingLocal ? "Scanning…" : "Scan again"}
              </button>
            </div>

            {isLoadingLocal ? (
              <div className="flex items-center gap-1.5 text-xs text-description-fg">
                <i className="codicon codicon-loading codicon-modifier-spin text-xxs" />
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
                      {formatLocalSourceLabel(
                        group.source as LocalMcpServerEntry["source"]
                      )}
                    </div>
                    {group.entries.map((entry) => {
                      const alreadyAdded = hasServerInScope(entry.id, activeScope);
                      return (
                        <div
                          key={`${entry.source}:${entry.id}`}
                          className="flex items-center justify-between gap-2 rounded border border-panel-border px-2 py-1.5"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-foreground">
                              {entry.id}
                            </div>
                            <div className="truncate font-mono text-xxs text-description-fg">
                              {entry.url
                                ? entry.transport === "sse"
                                  ? `sse: ${entry.url}`
                                  : entry.url
                                : `${entry.command ?? ""}${entry.args?.length ? ` ${entry.args.join(" ")}` : ""}`}
                            </div>
                            <div className="truncate font-mono text-xxs text-description-fg">
                              {formatPathForDisplay(entry.path)}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={alreadyAdded}
                            onClick={() => handleImportLocal(entry)}
                            className="rounded border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
          <div className="space-y-2 rounded border border-panel-border bg-editor-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={remoteQuery}
                onChange={(event) => setRemoteQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSearchRegistry();
                  }
                }}
                placeholder="Search the MCP registry…"
                aria-label="Search MCP registry"
                className="min-w-[220px] flex-1 rounded border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg focus:border-focus-border focus:outline-none"
              />
              <button
                type="button"
                onClick={handleSearchRegistry}
                disabled={isLoadingRemote}
                className="rounded border border-panel-border px-2 py-1 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
                  className={`rounded border px-1.5 py-0 text-xxs transition-colors ${
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
                <i className="codicon codicon-loading codicon-modifier-spin text-xxs" />
                Fetching from MCP Registry…
              </div>
            ) : remoteError ? (
              <div className="text-xs text-error-fg">{remoteError}</div>
            ) : sortedRemoteServers && sortedRemoteServers.length > 0 ? (
              <>
                <div className="space-y-2">
                  {sortedRemoteServers.map((entry) => {
                    const importId = registryEntryToSlug(entry);
                    const alreadyAdded = hasServerInScope(importId, activeScope);
                    return (
                      <div
                        key={entry.id}
                        className="flex items-start justify-between gap-2 rounded border border-panel-border px-2 py-1.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <span className="truncate text-xs font-medium text-foreground">
                              {getRegistryEntryDisplayName(entry)}
                            </span>
                            {entry.verified && (
                              <i
                                className="codicon codicon-verified-filled flex-shrink-0 text-xxs text-verified"
                                title="MCP Registry verified"
                              />
                            )}
                          </div>
                          <div className="truncate font-mono text-xxs text-description-fg">
                            {entry.installCommand
                              ? entry.installCommand
                              : entry.remoteUrl
                                ? `${entry.remoteTransport ?? "streamable-http"}: ${entry.remoteUrl}`
                                : entry.packageName ?? entry.id}
                          </div>
                          {entry.description && (
                            <div className="line-clamp-2 text-xxs text-description-fg">
                              {entry.description}
                            </div>
                          )}
                          {entry.envVars?.length ? (
                            <div className="text-xxs text-description-fg">
                              Requires env:{" "}
                              {entry.envVars.map((envVar) => envVar.name).join(", ")}
                            </div>
                          ) : null}
                          {entry.remoteHeaders?.filter((header) => header.isRequired)
                            .length ? (
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
                          className="mt-0.5 rounded border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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

                {(remotePageCursors.length > 1 || Boolean(remoteNextCursor)) && (
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={goPrevPage}
                      disabled={remotePageCursors.length <= 1 || isLoadingRemote}
                      className="flex items-center gap-1 rounded border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <i className="codicon codicon-chevron-left text-xxs" />
                      Prev
                    </button>
                    <span className="text-xxs text-description-fg">
                      Page {remotePageCursors.length}
                    </span>
                    <button
                      type="button"
                      onClick={goNextPage}
                      disabled={!remoteNextCursor || isLoadingRemote}
                      className="flex items-center gap-1 rounded border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      Next
                      <i className="codicon codicon-chevron-right text-xxs" />
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
    </div>
  );
}
