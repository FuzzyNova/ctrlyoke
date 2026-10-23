import { create } from "zustand";
import { MESSAGE_TYPES, type SettingWriteScope } from "@/types/messages";
import type {
  RegistrySkillAuditResult,
  RegistrySkillEntry,
  RegistrySkillLocation,
  SkillUpdateCheckResult,
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
  /** The scope the running install writes to. */
  scope?: SettingWriteScope;
  error?: string;
}

/** The skill a review dialog is open for. */
export type RegistrySkillReviewEntry = Pick<
  RegistrySkillEntry,
  "id" | "source" | "slug" | "name"
>;

/** An update of an installed copy, reviewed in the same dialog as an install. */
export interface RegistrySkillUpdateReview {
  scope: SettingWriteScope;
  installedCommitSha: string;
  /** Files edited locally since install, which the update replaces. */
  localChanges: string[];
}

export interface RegistrySkillReview {
  entry: RegistrySkillReviewEntry;
  /** Set when the dialog replaces an installed copy instead of installing. */
  update?: RegistrySkillUpdateReview;
}

export interface SkillsRegistryUpdateCheckState {
  checking: boolean;
  /** `Date.now()` when the last check answered. */
  checkedAt?: number;
  /** Results keyed by installed skill folder (`ManagedFileLocation.path`). */
  results: Record<string, SkillUpdateCheckResult>;
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
  /** The skill whose install or update dialog is open. */
  review: RegistrySkillReview | undefined;
  updateCheck: SkillsRegistryUpdateCheckState;

  setOpen: (isOpen: boolean) => void;
  setQuery: (query: string) => void;
  search: (query: string) => void;
  setSearchResult: (
    requestId: number,
    skills: RegistrySkillEntry[],
    error?: string
  ) => void;
  setPage: (page: number) => void;
  requestAudits: (entries: readonly RegistrySkillReviewEntry[]) => void;
  setAuditResults: (results: readonly RegistrySkillAuditResult[]) => void;
  openReview: (
    entry: RegistrySkillReviewEntry,
    update?: RegistrySkillUpdateReview
  ) => void;
  closeReview: () => void;
  setLocationResult: (
    source: string,
    slug: string,
    location?: RegistrySkillLocation,
    error?: string
  ) => void;
  install: (
    location: RegistrySkillLocation,
    scope: SettingWriteScope,
    replace?: boolean
  ) => void;
  setInstallResult: (source: string, slug: string, error?: string) => void;
  checkForUpdates: () => void;
  setUpdateCheckResults: (results: readonly SkillUpdateCheckResult[]) => void;
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
    review: undefined,
    updateCheck: { checking: false, results: {} },

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

    openReview: (entry, update) => {
      set((state) => ({
        review: { entry, ...(update ? { update } : {}) },
        installs: { ...state.installs, [entry.id]: {} },
      }));
      get().requestAudits([entry]);
      const location = get().locations[entry.id];
      // Reuse a commit resolved for this review session; re-resolve after a
      // failure, and always for an update, which must see the newest commit.
      if (!update && location && (location.loading || location.location)) {
        return;
      }
      set((state) => ({
        locations: { ...state.locations, [entry.id]: { loading: true } },
      }));
      sendMessage(MESSAGE_TYPES.REQUEST_REGISTRY_SKILL_LOCATION, {
        source: entry.source,
        slug: entry.slug,
      });
    },

    closeReview: () => set({ review: undefined }),

    setLocationResult: (source, slug, location, error) =>
      set((state) => ({
        locations: {
          ...state.locations,
          [getRegistrySkillKey(source, slug)]: location
            ? { location }
            : { error: error ?? "Could not locate the skill on GitHub" },
        },
      })),

    install: (location, scope, replace = false) => {
      const key = getRegistrySkillKey(location.source, location.slug);
      set((state) => ({
        installs: { ...state.installs, [key]: { installing: true, scope } },
      }));
      sendMessage(MESSAGE_TYPES.INSTALL_REGISTRY_SKILL, {
        location,
        scope,
        ...(replace ? { replace: true } : {}),
      });
    },

    setInstallResult: (source, slug, error) => {
      const key = getRegistrySkillKey(source, slug);
      set((state) => {
        if (error) {
          return {
            installs: {
              ...state.installs,
              [key]: { ...state.installs[key], installing: false, error },
            },
          };
        }
        const scope = state.installs[key]?.scope;
        // The installed copy is now the newest commit, so its update result
        // is stale; the resolved location is dropped so the next review
        // looks up the repository again.
        const { [key]: _resolved, ...locations } = state.locations;
        return {
          installs: { ...state.installs, [key]: {} },
          locations,
          updateCheck: {
            ...state.updateCheck,
            results: Object.fromEntries(
              Object.entries(state.updateCheck.results).filter(
                ([, result]) =>
                  !(
                    result.source === source &&
                    result.slug === slug &&
                    result.scope === scope
                  )
              )
            ),
          },
          review: state.review?.entry.id === key ? undefined : state.review,
        };
      });
    },

    checkForUpdates: () => {
      if (get().updateCheck.checking) return;
      set((state) => ({
        updateCheck: { ...state.updateCheck, checking: true },
      }));
      sendMessage(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_UPDATE_CHECK, {});
    },

    setUpdateCheckResults: (results) =>
      set({
        updateCheck: {
          checking: false,
          checkedAt: Date.now(),
          results: Object.fromEntries(
            results.map((result) => [result.path, result])
          ),
        },
      }),
  })
);
