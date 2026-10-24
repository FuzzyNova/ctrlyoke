import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  WorkspaceSearchContentMatch,
  WorkspaceSearchFileMatch,
  WorkspaceSearchResult,
  WorkspaceSearchScope,
} from "@root/types/HostedWorkspaceViewerTypes";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceRepos, workspaceSearch } from "@utils/hostedApi";
import { formatSearchResultCount, truncateSnippet } from "@utils/string";
import { WORKSPACE_ENTRY_KINDS } from "@root/types/DashboardConstants";
import {
  VirtualizedPagedList,
  type VirtualizedListRange,
} from "@components/shared";
import { Icon } from "../shared/Icon";

export const WORKSPACE_SEARCH_DEBOUNCE_MS = 400;
export const WORKSPACE_SEARCH_PAGE_SIZE = 50;

/**
 * Placeholder rows after the loaded results while more may exist. They are
 * the loading indicator, and the list's range reaching them is what requests
 * the next page — there is no "Load more" button.
 */
const LOADING_TAIL_ROWS = 3;
/** Below this many rows the list renders densely rather than virtualized. */
const VIRTUALIZE_THRESHOLD = 100;
const FILE_ROW_ESTIMATE = 52;
const LINE_ROW_ESTIMATE = 36;
const PATH_HEADING_ESTIMATE = 22;

const SCOPE_OPTIONS: Array<{
  value: WorkspaceSearchScope;
  label: string;
}> = [
  { value: "files", label: "Files" },
  { value: "content", label: "Content" },
  { value: "both", label: "Both" },
];

/**
 * One rendered row. Results arrive in scan order with a file's content
 * matches together, so the first match of each file carries that file's path
 * as a heading instead of a separate row.
 */
type SearchRow =
  | { result: WorkspaceSearchFileMatch }
  | { result: WorkspaceSearchContentMatch; showPath: boolean };

function toSearchRows(results: WorkspaceSearchResult[]): SearchRow[] {
  let previousContentPath: string | null = null;
  return results.map((result) => {
    if (result.kind !== WORKSPACE_ENTRY_KINDS.CONTENT) {
      previousContentPath = null;
      return { result };
    }
    const showPath = result.path !== previousContentPath;
    previousContentPath = result.path;
    return { result, showPath };
  });
}

const ROW_BUTTON_CLASS =
  "min-h-[44px] w-full rounded-sm border border-transparent px-3 py-2 text-left transition-colors hover:border-focus-border hover:bg-list-hover-bg focus:border-focus-border focus:bg-list-hover-bg focus:outline-hidden sm:min-h-0";

export const WorkspaceSearchPane: React.FC = () => {
  const searchQuery = useWorkspaceViewerStore((s) => s.searchQuery);
  const searchScope = useWorkspaceViewerStore((s) => s.searchScope);
  const searchIncludeGitIgnored = useWorkspaceViewerStore(
    (s) => s.searchIncludeGitIgnored
  );
  const searchResults = useWorkspaceViewerStore((s) => s.searchResults);
  const searchLoading = useWorkspaceViewerStore((s) => s.searchLoading);
  const searchStatus = useWorkspaceViewerStore((s) => s.searchStatus);
  const repos = useWorkspaceViewerStore((s) => s.repos);
  const selectedRepoId = useWorkspaceViewerStore((s) => s.selectedRepoId);
  const setSearchQuery = useWorkspaceViewerStore((s) => s.setSearchQuery);
  const setSearchScope = useWorkspaceViewerStore((s) => s.setSearchScope);
  const setSearchIncludeGitIgnored = useWorkspaceViewerStore(
    (s) => s.setSearchIncludeGitIgnored
  );
  const setSearchLoading = useWorkspaceViewerStore((s) => s.setSearchLoading);
  const appendSearchPage = useWorkspaceViewerStore((s) => s.appendSearchPage);
  const resetSearchResults = useWorkspaceViewerStore(
    (s) => s.resetSearchResults
  );
  const setSelectedRepoId = useWorkspaceViewerStore((s) => s.setSelectedRepoId);
  const setRepos = useWorkspaceViewerStore((s) => s.setRepos);
  const openToFile = useWorkspaceViewerStore((s) => s.openToFile);
  const hideGitIgnoredFiles = useSettingsStore(
    (s) => s.globalSettings.hideGitIgnoredFiles
  );

  /** Identifies the current search; a response for an older one is dropped. */
  const searchSequenceRef = useRef(0);
  const hasSeededGitIgnoredRef = useRef(false);
  const resultsScrollContainerRef = useRef<HTMLDivElement>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const trimmedQuery = searchQuery.trim();
  // Scoping only means something when there is more than one repo to choose
  // between; with none or one, search every root the viewer can browse (a
  // multi-root workspace can also hold roots that are in no repo at all).
  const scopedRepoId =
    repos.length > 1 ? (selectedRepoId ?? undefined) : undefined;
  const listingId = `workspace-search:${trimmedQuery}:${searchScope}:${
    searchIncludeGitIgnored ? "ignored" : "tracked"
  }:${scopedRepoId ?? ""}`;

  useEffect(() => {
    if (hasSeededGitIgnoredRef.current) return;
    hasSeededGitIgnoredRef.current = true;
    setSearchIncludeGitIgnored(!hideGitIgnoredFiles);
  }, [hideGitIgnoredFiles, setSearchIncludeGitIgnored]);

  // Discover repos on mount like the SCM pane does. Panes unmount on tab
  // switch, so the search pane cannot assume the SCM tab was ever opened —
  // without this the repo picker would never appear for a user who goes
  // straight to Search.
  useEffect(() => {
    workspaceRepos()
      .then((result) => setRepos(result.repos, result.prefixRepoIds))
      .catch(() => {
        // ignore — the picker simply won't appear and search stays unscoped
      });
  }, [setRepos]);

  /**
   * Requests the page after the results already loaded. Reads the store
   * directly so a call from a stale render still continues from the latest
   * page rather than re-requesting one it already has.
   */
  const loadNextPage = useCallback(() => {
    const sequence = searchSequenceRef.current;
    const { searchResults: loaded, searchStatus: status } =
      useWorkspaceViewerStore.getState();
    setSearchLoading(true);
    setSearchFailed(false);

    void workspaceSearch({
      query: trimmedQuery,
      scope: searchScope,
      includeGitIgnored: searchIncludeGitIgnored,
      repo: scopedRepoId,
      searchId: status?.searchId,
      offset: loaded.length,
      limit: WORKSPACE_SEARCH_PAGE_SIZE,
    })
      .then((page) => {
        if (sequence !== searchSequenceRef.current) return;
        appendSearchPage(page);
        // A page that found nothing new before its scan budget ran out adds
        // no rows, so the list's range never changes to ask again — keep the
        // scan going from here instead.
        if (page.results.length === 0 && !page.complete) {
          loadNextPageRef.current();
        }
      })
      .catch(() => {
        if (sequence !== searchSequenceRef.current) return;
        setSearchFailed(true);
        setSearchLoading(false);
      });
  }, [
    appendSearchPage,
    scopedRepoId,
    searchIncludeGitIgnored,
    searchScope,
    setSearchLoading,
    trimmedQuery,
  ]);
  const loadNextPageRef = useRef(loadNextPage);
  loadNextPageRef.current = loadNextPage;

  useEffect(() => {
    const sequence = ++searchSequenceRef.current;
    resetSearchResults();
    setSearchFailed(false);
    if (resultsScrollContainerRef.current) {
      resultsScrollContainerRef.current.scrollTop = 0;
    }

    if (trimmedQuery.length < 2) return;

    const timeoutId = window.setTimeout(() => {
      if (sequence !== searchSequenceRef.current) return;
      loadNextPageRef.current();
    }, WORKSPACE_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [
    resetSearchResults,
    scopedRepoId,
    searchIncludeGitIgnored,
    searchScope,
    trimmedQuery,
  ]);

  const rows = useMemo(() => toSearchRows(searchResults), [searchResults]);
  const hasMore =
    !searchFailed &&
    searchStatus !== null &&
    (!searchStatus.complete || searchResults.length < searchStatus.totalCount);
  const rowCount = rows.length + (hasMore ? LOADING_TAIL_ROWS : 0);

  const handleRangeChange = useCallback(
    (range: VirtualizedListRange): void => {
      if (!hasMore || range.overscanEndIndex < rows.length) return;
      if (useWorkspaceViewerStore.getState().searchLoading) return;
      loadNextPage();
    },
    [hasMore, loadNextPage, rows.length]
  );

  const getItem = useCallback(
    (index: number): SearchRow | undefined => rows[index],
    [rows]
  );
  const getItemKey = useCallback(
    (row: SearchRow): string =>
      row.result.kind === WORKSPACE_ENTRY_KINDS.CONTENT
        ? `line:${row.result.path}:${row.result.line}`
        : `file:${row.result.path}`,
    []
  );
  const estimateItemSize = useCallback(
    (index: number): number => {
      const row = rows[index];
      if (!row) return LINE_ROW_ESTIMATE;
      if (!("showPath" in row)) return FILE_ROW_ESTIMATE;
      return LINE_ROW_ESTIMATE + (row.showPath ? PATH_HEADING_ESTIMATE : 0);
    },
    [rows]
  );
  const renderItem = useCallback(
    (row: SearchRow): ReactNode => {
      if (!("showPath" in row)) {
        const { result } = row;
        return (
          <button
            type="button"
            onClick={() => openToFile(result.path)}
            className={ROW_BUTTON_CLASS}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <Icon
                name="file"
                className="shrink-0 text-xs text-description-fg"
              />
              <span className="truncate text-sm font-semibold text-foreground">
                {result.name}
              </span>
            </div>
            <div className="truncate text-xs text-description-fg">
              {result.path}
            </div>
          </button>
        );
      }
      const { result, showPath } = row;
      return (
        <div className={showPath ? "pt-2" : undefined}>
          {showPath && (
            <div className="truncate px-3 text-xs font-semibold text-foreground">
              {result.path}
            </div>
          )}
          <button
            type="button"
            aria-label={`Open ${result.path} at line ${result.line}`}
            onClick={() => openToFile(result.path, result.line, result.line)}
            className={ROW_BUTTON_CLASS}
          >
            <div className="flex items-start gap-2 text-xs text-description-fg">
              <span className="shrink-0 font-mono">Line {result.line}</span>
              <span className="min-w-0 truncate text-foreground">
                {truncateSnippet(result.matchSnippet)}
              </span>
            </div>
          </button>
        </div>
      );
    },
    [openToFile]
  );
  const renderPlaceholder = useCallback(
    (index: number): ReactNode => (
      <div
        className="px-3 py-2"
        data-workspace-search-placeholder="true"
        data-placeholder-index={index}
        aria-hidden="true"
      >
        <div className="h-3 w-2/5 animate-pulse rounded-sm bg-description-fg/20" />
        <div className="mt-2 h-3 w-4/5 animate-pulse rounded-sm bg-description-fg/15" />
      </div>
    ),
    []
  );

  const totalCount = searchStatus?.totalCount ?? 0;
  const summaryLabel =
    trimmedQuery.length >= 2 && totalCount > 0 && searchStatus
      ? formatSearchResultCount(
          totalCount,
          searchStatus.complete && !searchStatus.capped
        )
      : "";
  const scanning =
    searchLoading || (searchStatus !== null && !searchStatus.complete);
  const showInitialLoading =
    trimmedQuery.length >= 2 &&
    searchResults.length === 0 &&
    !searchFailed &&
    scanning;
  const showEmpty =
    trimmedQuery.length >= 2 &&
    searchResults.length === 0 &&
    !searchFailed &&
    searchStatus?.complete === true;

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-editor-bg">
      <div className="flex shrink-0 flex-col gap-2 border-b border-panel-border px-3 py-3">
        <div className="relative min-w-0">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-description-fg"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search workspace..."
            aria-label="Search workspace"
            className="h-9 w-full rounded-sm border border-input-border bg-input-bg pl-9 pr-3 text-sm text-input-fg outline-hidden focus:border-focus-border"
          />
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <div
            className="flex shrink-0 rounded-sm border border-input-border bg-input-bg p-0.5"
            role="group"
            aria-label="Search scope"
          >
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={searchScope === option.value}
                onClick={() => setSearchScope(option.value)}
                className={`min-h-[44px] min-w-[44px] rounded-sm px-2 py-1 text-xs transition-colors sm:min-h-0 sm:min-w-0 ${
                  searchScope === option.value
                    ? "bg-btn-bg text-btn-fg"
                    : "text-description-fg hover:bg-btn-secondary-hover hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-sm border border-input-border bg-input-bg px-2 text-xs text-input-fg sm:min-h-0">
            <input
              type="checkbox"
              checked={searchIncludeGitIgnored}
              onChange={(event) =>
                setSearchIncludeGitIgnored(event.target.checked)
              }
              aria-label="Include git-ignored files"
              className="h-3 w-3 accent-focus-border"
            />
            <span>Include git-ignored files</span>
          </label>

          {repos.length > 1 && (
            <label className="flex min-w-[160px] flex-1 items-center gap-2 sm:flex-initial">
              <span className="sr-only">Repository</span>
              <div className="relative w-full">
                <Icon
                  name="repo"
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-editor-fg opacity-60"
                />
                <select
                  value={selectedRepoId ?? ""}
                  onChange={(event) =>
                    setSelectedRepoId(event.target.value || null)
                  }
                  aria-label="Select repository"
                  className="h-8 w-full appearance-none rounded-sm border border-input-border bg-input-bg pl-7 pr-7 text-xs text-input-fg outline-hidden focus:border-focus-border"
                >
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.label}
                    </option>
                  ))}
                </select>
                <Icon
                  name="chevron-down"
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-editor-fg opacity-60"
                />
              </div>
            </label>
          )}
        </div>

        {summaryLabel && (
          <div className="flex h-4 items-center gap-1.5 text-xs text-description-fg">
            <span>{summaryLabel}</span>
            {/* Once rows are showing, this is what still says the scan behind
                them has not finished. */}
            {scanning && (
              <Icon
                name="loading"
                className="animate-spin text-xs"
                aria-label="Still searching"
              />
            )}
          </div>
        )}
      </div>

      <div
        ref={resultsScrollContainerRef}
        className="flex-1 overflow-y-auto px-3 py-3"
      >
        {trimmedQuery.length < 2 && (
          <div className="py-6 text-center text-sm text-description-fg">
            Type at least 2 characters
          </div>
        )}

        {showInitialLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-description-fg">
            <Icon name="loading" className="animate-spin" />
            <span>Searching...</span>
          </div>
        )}

        {showEmpty && (
          <div className="py-6 text-center text-sm text-description-fg">
            No results
          </div>
        )}

        {searchFailed && (
          <div className="flex flex-col items-center gap-2 py-6 text-sm text-description-fg">
            <span>Search failed.</span>
            <button
              type="button"
              onClick={loadNextPage}
              className="flex min-h-[44px] items-center justify-center rounded-sm border border-btn-border bg-btn-secondary-bg px-4 text-xs font-medium text-btn-secondary-fg hover:bg-btn-secondary-hover sm:min-h-0 sm:py-1"
            >
              Retry
            </button>
          </div>
        )}

        {rows.length > 0 && (
          <div
            className="flex flex-col"
            data-workspace-search-listing-id={listingId}
          >
            <VirtualizedPagedList
              totalCount={rowCount}
              listingId={listingId}
              getItem={getItem}
              getItemKey={getItemKey}
              renderItem={renderItem}
              renderPlaceholder={renderPlaceholder}
              scrollContainerRef={resultsScrollContainerRef}
              estimateItemSize={estimateItemSize}
              threshold={VIRTUALIZE_THRESHOLD}
              onRangeChange={handleRangeChange}
            />
          </div>
        )}
      </div>
    </div>
  );
};
