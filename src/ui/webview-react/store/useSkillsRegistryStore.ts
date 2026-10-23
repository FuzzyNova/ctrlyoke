import { create } from "zustand";
import { MESSAGE_TYPES, type SettingWriteScope } from "@/types/messages";
import type {
  RegistrySkillAuditResult,
  RegistrySkillEntry,
  RegistrySkillLocation,
} from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

/** Results shown per page; skills.sh returns up to 50 per search. */
export const SKILLS_REGISTRY_PAGE_SIZE = 10;
/** skills.sh rejects shorter queries. */
export const SKILLS_REGISTRY_MIN_QUERY_LENGTH = 2;

/** The key every per-skill map uses: `<owner>/<repo>/<slug>`, as `RegistrySkillEntry.id`. */
export function getRegistrySkillKey(source: string, slug: string): string {
  return `${source}/${slug}`;
}

export type RegistrySkillAuditState =
  { loading: true } | (RegistrySkillAuditResult & { loading?: false });

export type RegistrySkillLocationState =
  | { loading: true }
  | { loading?: false; location?: RegistrySkillLocation; error?: string };

export interface RegistrySkillInstallState {
  installing?: boolean;
  error?: string;
}

export interface SkillsRegistryState {
  /** Whether the skills.sh tab is open; nothing is fetched until it is. */
  isOpen: boolean;
  query: string;
  /** `undefined` until a search has answered. */
  results: RegistrySkillEntry[] | undefined;
  isSearching: boolean;
  searchError: string | undefined;
  latestRequestId: number;
  /** Zero-based page into `results`. */
  page: number;

  audits: Record<string, RegistrySkillAuditState>;
  locations: Record<string, RegistrySkillLocationState>;
  installs: Record<string, RegistrySkillInstallState>;
  /** The skill whose install confirmation is open. */
  reviewingKey: string | undefined;

  setOpen: (isOpen: boolean) => void;
  setQuery: (query: string) => void;
  search: (query: string) => void;
  setSearchResult: (
    requestId: number,
    skills: RegistrySkillEntry[],
    error?: string
  ) => void;
  setPage: (page: number) => void;
  requestAudits: (entries: readonly RegistrySkillEntry[]) => void;
  setAuditResults: (results: readonly RegistrySkillAuditResult[]) => void;
  openReview: (entry: RegistrySkillEntry) => void;
  closeReview: () => void;
  setLocationResult: (
    source: string,
    slug: string,
    location?: RegistrySkillLocation,
    error?: string
  ) => void;
  install: (location: RegistrySkillLocation, scope: SettingWriteScope) => void;
  setInstallResult: (source: string, slug: string, error?: string) => void;
}

export const useSkillsRegistryStore = create<SkillsRegistryState>(
  (set, get) => ({
    isOpen: false,
    query: "",
    results: undefined,
    isSearching: false,
    searchError: undefined,
    latestRequestId: 0,
    page: 0,
    audits: {},
    locations: {},
    installs: {},
    reviewingKey: undefined,

    setOpen: (isOpen) => set({ isOpen }),

    setQuery: (query) => set({ query }),

    search: (query) => {
      const trimmed = query.trim();
      if (trimmed.length < SKILLS_REGISTRY_MIN_QUERY_LENGTH) {
        set({
          query,
          results: undefined,
          isSearching: false,
          searchError: undefined,
          page: 0,
        });
        return;
      }
      const requestId = get().latestRequestId + 1;
      set({
        query,
        latestRequestId: requestId,
        isSearching: true,
        searchError: undefined,
        page: 0,
      });
      sendMessage(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH, {
        requestId,
        query: trimmed,
      });
    },

    setSearchResult: (requestId, skills, error) => {
      // A slower, older search must not replace a newer one's results.
      if (requestId !== get().latestRequestId) return;
      set({
        results: error ? undefined : skills,
        searchError: error,
        isSearching: false,
        page: 0,
      });
    },

    setPage: (page) => set({ page }),

    requestAudits: (entries) => {
      const { audits } = get();
      const missing = entries.filter((entry) => !audits[entry.id]);
      if (missing.length === 0) return;
      set((state) => ({
        audits: {
          ...state.audits,
          ...Object.fromEntries(
            missing.map((entry) => [entry.id, { loading: true } as const])
          ),
        },
      }));
      sendMessage(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_AUDITS, {
        skills: missing.map(({ source, slug }) => ({ source, slug })),
      });
    },

    setAuditResults: (results) =>
      set((state) => ({
        audits: {
          ...state.audits,
          ...Object.fromEntries(
            results.map((result) => [
              getRegistrySkillKey(result.source, result.slug),
              result,
            ])
          ),
        },
      })),

    openReview: (entry) => {
      set({ reviewingKey: entry.id });
      get().requestAudits([entry]);
      const location = get().locations[entry.id];
      // Re-resolve after a failure; a resolved commit is reused.
      if (location && (location.loading || location.location)) return;
      set((state) => ({
        locations: { ...state.locations, [entry.id]: { loading: true } },
      }));
      sendMessage(MESSAGE_TYPES.REQUEST_REGISTRY_SKILL_LOCATION, {
        source: entry.source,
        slug: entry.slug,
      });
    },

    closeReview: () => set({ reviewingKey: undefined }),

    setLocationResult: (source, slug, location, error) =>
      set((state) => ({
        locations: {
          ...state.locations,
          [getRegistrySkillKey(source, slug)]: location
            ? { location }
            : { error: error ?? "Could not locate the skill on GitHub" },
        },
      })),

    install: (location, scope) => {
      const key = getRegistrySkillKey(location.source, location.slug);
      set((state) => ({
        installs: { ...state.installs, [key]: { installing: true } },
      }));
      sendMessage(MESSAGE_TYPES.INSTALL_REGISTRY_SKILL, { location, scope });
    },

    setInstallResult: (source, slug, error) => {
      const key = getRegistrySkillKey(source, slug);
      set((state) => ({
        installs: { ...state.installs, [key]: error ? { error } : {} },
        reviewingKey:
          !error && state.reviewingKey === key ? undefined : state.reviewingKey,
      }));
    },
  })
);
