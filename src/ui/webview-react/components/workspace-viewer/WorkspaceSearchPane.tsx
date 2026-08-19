import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  WorkspaceSearchContentMatch,
  WorkspaceSearchResult,
  WorkspaceSearchScope,
} from "@root/types/HostedWorkspaceViewerTypes";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceRepos, workspaceSearch } from "@utils/hostedApi";
import { truncateSnippet } from "@utils/string";

const INITIAL_RESULT_LIMIT = 50;

const SCOPE_OPTIONS: Array<{
  value: WorkspaceSearchScope;
  label: string;
}> = [
  { value: "files", label: "Files" },
  { value: "content", label: "Content" },
  { value: "both", label: "Both" },
];

interface ContentMatchGroup {
  path: string;
  matches: WorkspaceSearchContentMatch[];
}

function groupContentMatches(
  results: WorkspaceSearchResult[]
): ContentMatchGroup[] {
  const groups = new Map<string, WorkspaceSearchContentMatch[]>();
  for (const result of results) {
    if (result.kind !== "content") continue;
    const matches = groups.get(result.path);
    if (matches) {
      matches.push(result);
    } else {
      groups.set(result.path, [result]);
    }
  }

  return Array.from(groups, ([path, matches]) => ({ path, matches }));
}

export const WorkspaceSearchPane: React.FC = () => {
  const searchQuery = useWorkspaceViewerStore((s) => s.searchQuery);
  const searchScope = useWorkspaceViewerStore((s) => s.searchScope);
  const searchIncludeGitIgnored = useWorkspaceViewerStore(
    (s) => s.searchIncludeGitIgnored
  );
  const searchResults = useWorkspaceViewerStore((s) => s.searchResults);
  const searchLoading = useWorkspaceViewerStore((s) => s.searchLoading);
  const searchTruncated = useWorkspaceViewerStore((s) => s.searchTruncated);
  const repos = useWorkspaceViewerStore((s) => s.repos);
  const selectedRepoId = useWorkspaceViewerStore((s) => s.selectedRepoId);
  const setSearchQuery = useWorkspaceViewerStore((s) => s.setSearchQuery);
  const setSearchScope = useWorkspaceViewerStore((s) => s.setSearchScope);
  const setSearchIncludeGitIgnored = useWorkspaceViewerStore(
    (s) => s.setSearchIncludeGitIgnored
  );
  const setSearchResults = useWorkspaceViewerStore((s) => s.setSearchResults);
  const setSearchLoading = useWorkspaceViewerStore((s) => s.setSearchLoading);
  const setSearchTruncated = useWorkspaceViewerStore(
    (s) => s.setSearchTruncated
  );
  const setSelectedRepoId = useWorkspaceViewerStore((s) => s.setSelectedRepoId);
  const setRepos = useWorkspaceViewerStore((s) => s.setRepos);
  const openToFile = useWorkspaceViewerStore((s) => s.openToFile);
  const hideGitIgnoredFiles = useSettingsStore(
    (s) => s.globalSettings.hideGitIgnoredFiles
  );

  const requestSequenceRef = useRef(0);
  const resultLimitRef = useRef(INITIAL_RESULT_LIMIT);
  const hasSeededGitIgnoredRef = useRef(false);
  const [moreAvailable, setMoreAvailable] = useState(false);
  const trimmedQuery = searchQuery.trim();
  // Scoping only means something when there is more than one repo to choose
  // between; with none or one, search every root the viewer can browse (a
  // multi-root workspace can also hold roots that are in no repo at all).
  const scopedRepoId =
    repos.length > 1 ? (selectedRepoId ?? undefined) : undefined;

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

  const runSearch = useCallback(
    (limit: number) => {
      const requestId = ++requestSequenceRef.current;
      setSearchLoading(true);

      void workspaceSearch({
        query: trimmedQuery,
        scope: searchScope,
        includeGitIgnored: searchIncludeGitIgnored,
        repo: scopedRepoId,
        limit,
      })
        .then((response) => {
          if (requestId !== requestSequenceRef.current) return;
          setSearchResults(response.results);
          setSearchTruncated(response.truncated);
          // `truncated` only reports a scan that ran out of budget. A result
          // set that filled `limit` exactly is also incomplete, and is the
          // common case on a broad query — both need "Load more".
          setMoreAvailable(
            response.truncated || response.results.length >= limit
          );
          setSearchLoading(false);
        })
        .catch(() => {
          if (requestId !== requestSequenceRef.current) return;
          setSearchResults([]);
          setSearchTruncated(false);
          setMoreAvailable(false);
          setSearchLoading(false);
        });
    },
    [
      scopedRepoId,
      searchIncludeGitIgnored,
      searchScope,
      setSearchLoading,
      setSearchResults,
      setSearchTruncated,
      trimmedQuery,
    ]
  );

  useEffect(() => {
    const scheduledRequestId = ++requestSequenceRef.current;
    resultLimitRef.current = INITIAL_RESULT_LIMIT;
    setSearchResults([]);
    setSearchTruncated(false);
    setMoreAvailable(false);
    setSearchLoading(false);

    if (trimmedQuery.length < 2) return;

    const timeoutId = window.setTimeout(() => {
      if (scheduledRequestId !== requestSequenceRef.current) return;
      runSearch(INITIAL_RESULT_LIMIT);
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [
    runSearch,
    searchQuery,
    searchScope,
    searchIncludeGitIgnored,
    scopedRepoId,
    setSearchLoading,
    setSearchResults,
    setSearchTruncated,
    trimmedQuery,
  ]);

  const handleLoadMore = useCallback(() => {
    if (searchLoading || !moreAvailable || trimmedQuery.length < 2) return;
    const nextLimit = resultLimitRef.current * 2;
    resultLimitRef.current = nextLimit;
    runSearch(nextLimit);
  }, [moreAvailable, runSearch, searchLoading, trimmedQuery.length]);

  const contentMatchGroups = useMemo(
    () => groupContentMatches(searchResults),
    [searchResults]
  );
  const filenameMatches = useMemo(
    () => searchResults.filter((result) => result.kind === "file"),
    [searchResults]
  );

  const showInitialLoading = searchLoading && searchResults.length === 0;
  const showEmpty =
    trimmedQuery.length >= 2 && !searchLoading && searchResults.length === 0;

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-editor-bg">
      <div className="flex shrink-0 flex-col gap-2 border-b border-panel-border px-3 py-3">
        <div className="relative min-w-0">
          <i className="codicon codicon-search pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-description-fg" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search workspace..."
            aria-label="Search workspace"
            className="h-9 w-full rounded border border-input-border bg-input-bg pl-9 pr-3 text-sm text-input-fg outline-none focus:border-focus-border"
          />
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <div
            className="flex shrink-0 rounded border border-input-border bg-input-bg p-0.5"
            role="group"
            aria-label="Search scope"
          >
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={searchScope === option.value}
                onClick={() => setSearchScope(option.value)}
                className={`min-h-[44px] min-w-[44px] rounded px-2 py-1 text-xs transition-colors sm:min-h-0 sm:min-w-0 ${
                  searchScope === option.value
                    ? "bg-btn-bg text-btn-fg"
                    : "text-description-fg hover:bg-btn-secondary-hover hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded border border-input-border bg-input-bg px-2 text-xs text-input-fg sm:min-h-0">
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
                <i className="codicon codicon-repo pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-editor-fg opacity-60" />
                <select
                  value={selectedRepoId ?? ""}
                  onChange={(event) =>
                    setSelectedRepoId(event.target.value || null)
                  }
                  aria-label="Select repository"
                  className="h-8 w-full appearance-none rounded border border-input-border bg-input-bg pl-7 pr-7 text-xs text-input-fg outline-none focus:border-focus-border"
                >
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.label}
                    </option>
                  ))}
                </select>
                <i className="codicon codicon-chevron-down pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-editor-fg opacity-60" />
              </div>
            </label>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {trimmedQuery.length < 2 && (
          <div className="py-6 text-center text-sm text-description-fg">
            Type at least 2 characters
          </div>
        )}

        {showInitialLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-description-fg">
            <i className="codicon codicon-loading animate-spin" />
            <span>Searching...</span>
          </div>
        )}

        {showEmpty && (
          <div className="py-6 text-center text-sm text-description-fg">
            No results
          </div>
        )}

        {searchResults.length > 0 && (
          <div className="flex flex-col gap-3">
            {filenameMatches.length > 0 && (
              <section aria-label="Filename matches">
                <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-description-fg">
                  Files
                </h2>
                <div className="flex flex-col gap-1">
                  {filenameMatches.map((result) => (
                    <button
                      key={`file:${result.path}`}
                      type="button"
                      onClick={() => openToFile(result.path)}
                      className="min-h-[44px] w-full rounded border border-transparent px-3 py-2 text-left transition-colors hover:border-focus-border hover:bg-list-hover-bg focus:border-focus-border focus:bg-list-hover-bg focus:outline-none sm:min-h-0"
                    >
                      <div className="truncate text-sm font-semibold text-foreground">
                        {result.name}
                      </div>
                      <div className="truncate text-xs text-description-fg">
                        {result.path}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {contentMatchGroups.length > 0 && (
              <section aria-label="Content matches">
                <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-description-fg">
                  Content
                </h2>
                <div className="flex flex-col gap-2">
                  {contentMatchGroups.map((group) => (
                    <div key={`content:${group.path}`}>
                      <div className="truncate px-3 text-xs font-semibold text-foreground">
                        {group.path}
                      </div>
                      <div className="mt-1 flex flex-col gap-1">
                        {group.matches.map((result) => (
                          <button
                            key={`${result.path}:${result.line}`}
                            type="button"
                            aria-label={`Open ${result.path} at line ${result.line}`}
                            onClick={() =>
                              openToFile(result.path, result.line, result.line)
                            }
                            className="min-h-[44px] w-full rounded border border-transparent px-3 py-2 text-left transition-colors hover:border-focus-border hover:bg-list-hover-bg focus:border-focus-border focus:bg-list-hover-bg focus:outline-none sm:min-h-0"
                          >
                            <div className="flex items-start gap-2 text-xs text-description-fg">
                              <span className="shrink-0 font-mono">
                                Line {result.line}
                              </span>
                              <span className="min-w-0 truncate text-foreground">
                                {truncateSnippet(result.matchSnippet)}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {moreAvailable && (
          <div className="flex flex-col items-center gap-2 border-t border-panel-border pt-3">
            <div className="text-center text-xs text-description-fg">
              {searchTruncated
                ? "The scan stopped early. More matches may be available."
                : "Results are limited. More matches may be available."}
            </div>
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={searchLoading}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded border border-btn-border bg-btn-secondary-bg px-4 text-xs font-medium text-btn-secondary-fg hover:bg-btn-secondary-hover disabled:opacity-60 sm:min-h-0"
            >
              {searchLoading && (
                <i className="codicon codicon-loading animate-spin" />
              )}
              <span>{searchLoading ? "Loading..." : "Load more"}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
