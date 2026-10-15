import { create } from "zustand";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";
import type { McpServerConfig } from "@root/types/CtrlYokeTypes";
import type {
  AnyTargetId,
  LocalMcpServerEntry,
  ManagedMcpServer,
  RegistryMcpEntry,
} from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

export const MCP_MANAGER_DISCOVERY_TABS = {
  LOCAL: "local",
  REGISTRY: "registry",
} as const;

export type McpManagerDiscoveryTab =
  (typeof MCP_MANAGER_DISCOVERY_TABS)[keyof typeof MCP_MANAGER_DISCOVERY_TABS];

export const MCP_MANAGER_REMOTE_SORTS = {
  A_TO_Z: "a-z",
  Z_TO_A: "z-a",
  RECENTLY_UPDATED: "recently-updated",
} as const;

export type McpManagerRemoteSort =
  (typeof MCP_MANAGER_REMOTE_SORTS)[keyof typeof MCP_MANAGER_REMOTE_SORTS];

export interface McpManagerState {
  managedServers: ManagedMcpServer[] | undefined;
  isLoadingRegistry: boolean;

  activeScope: SettingWriteScope;

  localServers: LocalMcpServerEntry[];
  isLoadingLocal: boolean;
  localError: string | undefined;

  remoteServers: RegistryMcpEntry[] | undefined;
  isLoadingRemote: boolean;
  remoteError: string | undefined;
  remoteNextCursor: string | undefined;
  remotePageCursors: (string | undefined)[];
  remoteQuery: string;
  latestRemoteRequestId: number;
  remoteSort: McpManagerRemoteSort;

  discoveryTab: McpManagerDiscoveryTab;

  setManagedServers: (servers: ManagedMcpServer[]) => void;
  setLocalScanResult: (servers: LocalMcpServerEntry[], error?: string) => void;
  setRemoteSearchResult: (
    requestId: number,
    servers: RegistryMcpEntry[],
    error?: string,
    nextCursor?: string
  ) => void;

  requestServers: () => void;
  addOrUpdateServer: (
    server: McpServerConfig,
    scope: SettingWriteScope,
    previousId?: string
  ) => void;
  deleteServer: (id: string, scope: SettingWriteScope) => void;
  deleteFromHarness: (
    ids: string[],
    targetId: AnyTargetId,
    scope: SettingWriteScope,
    filePath?: string
  ) => void;
  requestLocalScan: () => void;
  searchRemoteRegistry: (
    query: string,
    cursor?: string,
    updatedSince?: string,
    sortOverride?: McpManagerRemoteSort
  ) => void;
  goNextPage: () => void;
  goPrevPage: () => void;
  resetPages: () => void;
  setActiveScope: (scope: SettingWriteScope) => void;
  setDiscoveryTab: (tab: McpManagerDiscoveryTab) => void;
  setRemoteSort: (sort: McpManagerRemoteSort) => void;
  setRemoteQuery: (query: string) => void;
  exportToHarness: (
    servers: McpServerConfig[],
    targetId: AnyTargetId,
    scope: SettingWriteScope
  ) => void;
}

function oneYearAgoIso(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString();
}

function getUpdatedSinceForSort(
  sort: McpManagerRemoteSort
): string | undefined {
  return sort === MCP_MANAGER_REMOTE_SORTS.RECENTLY_UPDATED
    ? oneYearAgoIso()
    : undefined;
}

export const useMcpManagerStore = create<McpManagerState>((set, get) => ({
  managedServers: undefined,
  isLoadingRegistry: false,

  activeScope: SETTING_SCOPES.WORKSPACE,

  localServers: [],
  isLoadingLocal: false,
  localError: undefined,

  remoteServers: undefined,
  isLoadingRemote: false,
  remoteError: undefined,
  remoteNextCursor: undefined,
  remotePageCursors: [undefined],
  remoteQuery: "",
  latestRemoteRequestId: 0,
  remoteSort: MCP_MANAGER_REMOTE_SORTS.A_TO_Z,

  discoveryTab: MCP_MANAGER_DISCOVERY_TABS.LOCAL,

  setManagedServers: (servers) =>
    set({
      managedServers: servers,
      isLoadingRegistry: false,
    }),

  setLocalScanResult: (servers, error) =>
    set({
      localServers: servers,
      localError: error,
      isLoadingLocal: false,
    }),

  setRemoteSearchResult: (requestId, servers, error, nextCursor) =>
    set((state) =>
      requestId !== state.latestRemoteRequestId
        ? state
        : {
            remoteServers: servers,
            remoteError: error,
            remoteNextCursor: nextCursor,
            isLoadingRemote: false,
          }
    ),

  requestServers: () => {
    set({ isLoadingRegistry: true });
    sendMessage(MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SERVERS);
  },

  addOrUpdateServer: (server, scope, previousId) => {
    set({ isLoadingRegistry: true });
    sendMessage(MESSAGE_TYPES.SAVE_MCP_REGISTRY_SERVER, {
      server,
      scope,
      ...(previousId ? { previousId } : {}),
    });
  },

  deleteServer: (id, scope) => {
    set({ isLoadingRegistry: true });
    sendMessage(MESSAGE_TYPES.DELETE_MCP_REGISTRY_SERVER, { id, scope });
  },

  deleteFromHarness: (ids, targetId, scope, filePath) => {
    sendMessage(MESSAGE_TYPES.DELETE_MCP_FROM_HARNESS, {
      ids,
      targetId,
      scope,
      ...(filePath ? { filePath } : {}),
    });
  },

  requestLocalScan: () => {
    set({
      isLoadingLocal: true,
      localError: undefined,
    });
    sendMessage(MESSAGE_TYPES.REQUEST_MCP_LOCAL_SCAN);
  },

  searchRemoteRegistry: (query, cursor, updatedSince, sortOverride) => {
    const requestId = get().latestRemoteRequestId + 1;
    const resolvedSort = sortOverride ?? get().remoteSort;
    const resolvedUpdatedSince =
      updatedSince ?? getUpdatedSinceForSort(resolvedSort);

    set((state) => ({
      remoteQuery: query,
      latestRemoteRequestId: requestId,
      isLoadingRemote: true,
      remoteError: undefined,
      ...(cursor === undefined
        ? {
            remotePageCursors:
              state.remotePageCursors.length === 1 &&
              state.remotePageCursors[0] === undefined
                ? state.remotePageCursors
                : [undefined],
            remoteNextCursor: undefined,
          }
        : {}),
    }));

    sendMessage(MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SEARCH, {
      query,
      requestId,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(resolvedUpdatedSince ? { updatedSince: resolvedUpdatedSince } : {}),
    });
  },

  goNextPage: () => {
    const state = get();
    const cursor = state.remoteNextCursor;
    if (!cursor || state.isLoadingRemote) return;

    set({
      remotePageCursors: [...state.remotePageCursors, cursor],
    });

    get().searchRemoteRegistry(
      state.remoteQuery,
      cursor,
      undefined,
      state.remoteSort
    );
  },

  goPrevPage: () => {
    const state = get();
    if (state.isLoadingRemote || state.remotePageCursors.length <= 1) return;

    const remotePageCursors = state.remotePageCursors.slice(0, -1);
    const cursor = remotePageCursors[remotePageCursors.length - 1];

    set({ remotePageCursors });
    get().searchRemoteRegistry(
      state.remoteQuery,
      cursor,
      undefined,
      state.remoteSort
    );
  },

  resetPages: () =>
    set({
      remotePageCursors: [undefined],
      remoteNextCursor: undefined,
    }),

  setActiveScope: (scope) => set({ activeScope: scope }),
  setDiscoveryTab: (tab) => set({ discoveryTab: tab }),
  setRemoteSort: (sort) => set({ remoteSort: sort }),
  setRemoteQuery: (query) => set({ remoteQuery: query }),

  exportToHarness: (servers, targetId, scope) => {
    sendMessage(MESSAGE_TYPES.EXPORT_MCP_TO_HARNESS, {
      servers,
      targetId,
      scope,
    });
  },
}));
