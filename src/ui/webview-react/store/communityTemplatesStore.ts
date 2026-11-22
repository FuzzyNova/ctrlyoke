import { create } from "zustand";
import { MESSAGE_TYPES, type SettingWriteScope } from "@/types/messages";
import type {
  CommunityTemplateEntry,
  CommunityTemplateInstallResultMessage,
} from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@messaging/sendMessage";

/** The key the per-install map uses: one template installs once per scope. */
export function getCommunityInstallKey(
  scope: SettingWriteScope,
  id: string
): string {
  return `${scope}:${id}`;
}

export interface CommunityTemplateInstallState {
  installing?: boolean;
  error?: string;
  /** The installed template's id, once the install succeeded. */
  localTemplateId?: string;
}

export interface CommunityTemplatesState {
  /** `undefined` until the index has been requested and answered. */
  templates: CommunityTemplateEntry[] | undefined;
  isLoading: boolean;
  error: string | undefined;
  query: string;
  /** Keyed by {@link getCommunityInstallKey}. */
  installs: Record<string, CommunityTemplateInstallState>;

  /** Ask for the index; a no-op while loading or once loaded, unless `refresh`. */
  requestIndex: (refresh?: boolean) => void;
  setIndexResult: (templates: CommunityTemplateEntry[], error?: string) => void;
  setQuery: (query: string) => void;
  installTemplate: (id: string, scope: SettingWriteScope) => void;
  setInstallResult: (result: CommunityTemplateInstallResultMessage) => void;
}

export const useCommunityTemplatesStore = create<CommunityTemplatesState>()(
  (set, get) => ({
    templates: undefined,
    isLoading: false,
    error: undefined,
    query: "",
    installs: {},

    requestIndex: (refresh = false) => {
      const { isLoading, templates, error } = get();
      if (isLoading) return;
      if (!refresh && templates !== undefined && !error) return;
      set({ isLoading: true, error: undefined });
      sendMessage(
        MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX,
        refresh ? { refresh: true } : {}
      );
    },

    setIndexResult: (templates, error) =>
      set({ templates, error, isLoading: false }),

    setQuery: (query) => set({ query }),

    installTemplate: (id, scope) => {
      const key = getCommunityInstallKey(scope, id);
      if (get().installs[key]?.installing) return;
      set((state) => ({
        installs: { ...state.installs, [key]: { installing: true } },
      }));
      sendMessage(MESSAGE_TYPES.INSTALL_COMMUNITY_TEMPLATE, { id, scope });
    },

    setInstallResult: (result) =>
      set((state) => ({
        installs: {
          ...state.installs,
          [getCommunityInstallKey(result.scope, result.id)]: result.success
            ? { localTemplateId: result.localTemplateId }
            : { error: result.error ?? "Install failed" },
        },
      })),
  })
);
