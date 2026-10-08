import { create } from "zustand";
import {
  LANGUAGE_SERVER_STATUSES,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";
import type { LanguageServerDefinition } from "@root/types/CtrlYokeSettings";
import type { LspExportTargetId } from "@root/types/DashboardConstants";
import type {
  LanguageServerProbeResult,
  LocalLanguageServerEntry,
  ManagedLanguageServerDefinition,
} from "@root/types/WebviewMessageTypes";
import type { LanguageServerCatalogEntry } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

export const LANGUAGE_SERVER_TABS = {
  CATALOG: "catalog",
  LOCAL: "local",
} as const;
export type LanguageServerTab =
  (typeof LANGUAGE_SERVER_TABS)[keyof typeof LANGUAGE_SERVER_TABS];
export type LanguageServerStatus =
  (typeof LANGUAGE_SERVER_STATUSES)[keyof typeof LANGUAGE_SERVER_STATUSES];
export interface LanguageServerStatusEntry {
  id: string;
  rootPath: string;
  status: LanguageServerStatus;
  detail?: string;
}

interface State {
  hostPlatform?: "win32" | "darwin" | "linux";
  definitions: ManagedLanguageServerDefinition[];
  catalog: readonly LanguageServerCatalogEntry[];
  probes: LanguageServerProbeResult[];
  statuses: LanguageServerStatusEntry[];
  localServers: LocalLanguageServerEntry[];
  localError?: string;
  loading: boolean;
  scanning: boolean;
  query: string;
  tab: LanguageServerTab;
  installing: Record<string, string | undefined>;
  exportedTargets: Record<string, string[]>;
  exportResult?: { id: string; targetId: LspExportTargetId; scope: SettingWriteScope; success: boolean; error?: string };
  setServers: (
    payload: Pick<
      State,
      "hostPlatform" | "definitions" | "catalog" | "probes" | "statuses"
    >
  ) => void;
  setLocalScan: (servers: LocalLanguageServerEntry[], error?: string) => void;
  setInstallProgress: (
    id: string,
    output?: string,
    error?: string,
    complete?: boolean
  ) => void;
  setExportResult: (result: NonNullable<State["exportResult"]>) => void;
  setQuery: (query: string) => void;
  setTab: (tab: LanguageServerTab) => void;
  requestServers: () => void;
  requestLocalScan: () => void;
  saveDefinition: (
    id: string,
    definition: LanguageServerDefinition,
    scope: SettingWriteScope
  ) => void;
  deleteDefinition: (id: string, scope: SettingWriteScope) => void;
  install: (id: string) => void;
  restart: (id: string) => void;
  requestApproval: () => void;
  stop: (id: string) => void;
}

export const useLanguageServerStore = create<State>((set) => ({
  definitions: [],
  hostPlatform: undefined,
  catalog: [],
  probes: [],
  statuses: [],
  localServers: [],
  loading: false,
  scanning: false,
  query: "",
  tab: LANGUAGE_SERVER_TABS.CATALOG,
  installing: {},
  exportedTargets: {},
  setExportResult: (result) => set((state) => ({
    exportResult: result,
    exportedTargets: result.success
      ? { ...state.exportedTargets, [result.id]: [...new Set([...(state.exportedTargets[result.id] ?? []), `${result.targetId}:${result.scope}`])] }
      : state.exportedTargets,
  })),
  setServers: (payload) => set({ ...payload, loading: false }),
  setLocalScan: (localServers, localError) =>
    set({ localServers, localError, scanning: false }),
  setInstallProgress: (id, output, error, complete) =>
    set((state) => ({
      installing: {
        ...state.installing,
        [id]: complete ? undefined : (error ?? output ?? "Installing…"),
      },
    })),
  setQuery: (query) => set({ query }),
  setTab: (tab) => set({ tab }),
  requestServers: () => {
    set({ loading: true });
    sendMessage(MESSAGE_TYPES.REQUEST_LSP_SERVERS);
  },
  requestLocalScan: () => {
    set({ scanning: true, localError: undefined });
    sendMessage(MESSAGE_TYPES.REQUEST_LSP_LOCAL_SCAN);
  },
  saveDefinition: (id, definition, scope) =>
    sendMessage(MESSAGE_TYPES.SAVE_LSP_DEFINITION, { id, definition, scope }),
  deleteDefinition: (id, scope) =>
    sendMessage(MESSAGE_TYPES.DELETE_LSP_DEFINITION, { id, scope }),
  install: (id) => sendMessage(MESSAGE_TYPES.INSTALL_LSP_SERVER, { id }),
  restart: (id) => sendMessage(MESSAGE_TYPES.RESTART_LSP_SERVER, { id }),
  requestApproval: () => sendMessage(MESSAGE_TYPES.REQUEST_LSP_APPROVAL),
  stop: (id) => sendMessage(MESSAGE_TYPES.STOP_LSP_SERVER, { id }),
}));

export const LANGUAGE_SERVER_DEFAULT_SCOPE = SETTING_SCOPES.WORKSPACE;
