import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useUiStore } from "@store/uiStore";
import {
  ALL_HISTORY_EVENT_KINDS,
  createDefaultHistorySearchFilters,
  getHistorySearchActiveFilterCount,
  toHistorySearchFilters,
  type HistorySearchFilterState,
} from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, type HistorySearchResult } from "@/types/messages";
import { HISTORY_EVENT_KINDS } from "@root/types/DashboardConstants";
import type { HistoryEventKind } from "@root/types/WorkflowTimelineTypes";
import { formatRelativeTimeVerbose } from "@utils/time";
import {
  DateRangeFilterControls,
  ExitButton,
  MultiCheckboxDropdown,
} from "@components/shared";
import { formatMultiFilterLabel } from "@utils/filterLabels";

const RESULT_LIMIT = 50;

/**
 * Shared centered column for the search bar, result summary, and result list so
 * all three stay aligned on wide screens instead of hugging opposite edges.
 */
const CONTENT_COLUMN_CLASS = "mx-auto w-full max-w-4xl";

const EVENT_KIND_LABELS: Record<HistoryEventKind, string> = {
  [HISTORY_EVENT_KINDS.PROMPT]: "Prompt",
  [HISTORY_EVENT_KINDS.RESPONSE]: "Response",
  [HISTORY_EVENT_KINDS.THINKING]: "Thinking",
  [HISTORY_EVENT_KINDS.BASH]: "Bash",
  [HISTORY_EVENT_KINDS.FILE_READ]: "File Read",
  [HISTORY_EVENT_KINDS.FILE_WRITE]: "File Write",
  [HISTORY_EVENT_KINDS.FILE_EDIT]: "File Edit",
  [HISTORY_EVENT_KINDS.FILE_DELETE]: "File Delete",
  [HISTORY_EVENT_KINDS.TOOL]: "Tool",
  [HISTORY_EVENT_KINDS.MCP_TOOL]: "MCP Tool",
  [HISTORY_EVENT_KINDS.WEB_SEARCH]: "Web Search",
  [HISTORY_EVENT_KINDS.COMPACTION]: "Compaction",
  [HISTORY_EVENT_KINDS.CLI_COMMAND]: "CLI Command",
  [HISTORY_EVENT_KINDS.STATUS]: "Status",
  [HISTORY_EVENT_KINDS.SCRIPT]: "Script",
  [HISTORY_EVENT_KINDS.PRE_CONDITION]: "Pre-condition",
  [HISTORY_EVENT_KINDS.END_CONDITION]: "End-condition",
};

const EVENT_KIND_BADGES: Record<HistoryEventKind, string> = {
  [HISTORY_EVENT_KINDS.PROMPT]: "bg-[var(--status-success)]/20 text-foreground",
  [HISTORY_EVENT_KINDS.RESPONSE]: "bg-btn-bg/20 text-btn-fg",
  [HISTORY_EVENT_KINDS.THINKING]: "bg-btn-bg/15 text-description-fg",
  [HISTORY_EVENT_KINDS.BASH]: "bg-[var(--status-warning)]/20 text-foreground",
  [HISTORY_EVENT_KINDS.FILE_READ]:
    "bg-[var(--status-info)]/15 text-description-fg",
  [HISTORY_EVENT_KINDS.FILE_WRITE]:
    "bg-[var(--status-info)]/20 text-foreground",
  [HISTORY_EVENT_KINDS.FILE_EDIT]:
    "bg-[var(--status-error)]/15 text-foreground",
  [HISTORY_EVENT_KINDS.FILE_DELETE]:
    "bg-[var(--status-error)]/20 text-foreground",
  [HISTORY_EVENT_KINDS.TOOL]: "bg-[var(--status-warning)]/15 text-foreground",
  [HISTORY_EVENT_KINDS.MCP_TOOL]:
    "bg-[var(--status-warning)]/20 text-foreground",
  [HISTORY_EVENT_KINDS.WEB_SEARCH]:
    "bg-[var(--status-info)]/20 text-foreground",
  [HISTORY_EVENT_KINDS.COMPACTION]: "bg-btn-bg/15 text-description-fg",
  [HISTORY_EVENT_KINDS.CLI_COMMAND]:
    "bg-[var(--status-warning)]/15 text-foreground",
  [HISTORY_EVENT_KINDS.STATUS]:
    "bg-[var(--status-info)]/15 text-description-fg",
  [HISTORY_EVENT_KINDS.SCRIPT]: "bg-btn-bg/20 text-btn-fg",
  [HISTORY_EVENT_KINDS.PRE_CONDITION]:
    "bg-[var(--status-success)]/15 text-foreground",
  [HISTORY_EVENT_KINDS.END_CONDITION]:
    "bg-[var(--status-success)]/20 text-foreground",
};

const EVENT_KIND_OPTIONS: Array<{
  value: HistoryEventKind;
  label: string;
  group: string;
}> = [
  { value: HISTORY_EVENT_KINDS.FILE_READ, label: "File Read", group: "File" },
  {
    value: HISTORY_EVENT_KINDS.FILE_WRITE,
    label: "File Write",
    group: "File",
  },
  { value: HISTORY_EVENT_KINDS.FILE_EDIT, label: "File Edit", group: "File" },
  {
    value: HISTORY_EVENT_KINDS.FILE_DELETE,
    label: "File Delete",
    group: "File",
  },
  { value: HISTORY_EVENT_KINDS.BASH, label: "Bash", group: "Execution" },
  {
    value: HISTORY_EVENT_KINDS.CLI_COMMAND,
    label: "CLI Command",
    group: "Execution",
  },
  { value: HISTORY_EVENT_KINDS.TOOL, label: "Tool", group: "Execution" },
  {
    value: HISTORY_EVENT_KINDS.MCP_TOOL,
    label: "MCP Tool",
    group: "Execution",
  },
  {
    value: HISTORY_EVENT_KINDS.WEB_SEARCH,
    label: "Web Search",
    group: "Execution",
  },
  {
    value: HISTORY_EVENT_KINDS.PROMPT,
    label: "Prompt",
    group: "Conversation",
  },
  {
    value: HISTORY_EVENT_KINDS.RESPONSE,
    label: "Response",
    group: "Conversation",
  },
  {
    value: HISTORY_EVENT_KINDS.THINKING,
    label: "Thinking",
    group: "Conversation",
  },
  {
    value: HISTORY_EVENT_KINDS.COMPACTION,
    label: "Compaction",
    group: "Conversation",
  },
  { value: HISTORY_EVENT_KINDS.SCRIPT, label: "Script", group: "Script" },
  {
    value: HISTORY_EVENT_KINDS.PRE_CONDITION,
    label: "Pre-condition",
    group: "Script",
  },
  {
    value: HISTORY_EVENT_KINDS.END_CONDITION,
    label: "End-condition",
    group: "Script",
  },
  { value: HISTORY_EVENT_KINDS.STATUS, label: "Status", group: "Run" },
];

function truncateSnippet(snippet: string, maxLength = 80): string {
  const normalized = snippet.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

export function HistorySearchDrawer() {
  const vscode = useVsCodeApi();
  const isOpen = useUiStore((s) => s.isHistorySearchOpen);
  const query = useUiStore((s) => s.historySearchQuery);
  const results = useUiStore((s) => s.historySearchResults);
  const loading = useUiStore((s) => s.historySearchLoading);
  const loadingMore = useUiStore((s) => s.historySearchLoadingMore);
  const totalCount = useUiStore((s) => s.historySearchTotalCount);
  const nextCursor = useUiStore((s) => s.historySearchNextCursor);
  const hasMore = useUiStore((s) => s.historySearchHasMore);
  const indexState = useUiStore((s) => s.historySearchIndexState);
  const historySearchFilters = useUiStore((s) => s.historySearchFilters);
  const workflowKey = useUiStore((s) => s.displayedViewAddress?.workflowKey);
  const closeHistorySearch = useUiStore((s) => s.closeHistorySearch);
  const setHistorySearchQuery = useUiStore((s) => s.setHistorySearchQuery);
  const setHistorySearchFilters = useUiStore((s) => s.setHistorySearchFilters);
  const resetHistorySearchFilters = useUiStore(
    (s) => s.resetHistorySearchFilters
  );
  const setHistorySearchResults = useUiStore((s) => s.setHistorySearchResults);
  const setPendingHistorySearchNavigation = useUiStore(
    (s) => s.setPendingHistorySearchNavigation
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const filtersRef = useRef<HistorySearchFilterState>(historySearchFilters);
  filtersRef.current = historySearchFilters;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const trimmedQuery = query.trim();
  const activeFilterCount =
    getHistorySearchActiveFilterCount(historySearchFilters);

  const issueSearch = useCallback(
    (filters: HistorySearchFilterState) => {
      if (trimmedQuery.length < 2) {
        return;
      }

      setHistorySearchResults([], true, {
        totalCount: 0,
        hasMore: false,
        nextCursor: undefined,
      });
      vscode.postMessage({
        type: MESSAGE_TYPES.SEARCH_HISTORY,
        query: trimmedQuery,
        limit: RESULT_LIMIT,
        filters: toHistorySearchFilters(filters, workflowKey),
      });
    },
    [setHistorySearchResults, trimmedQuery, vscode, workflowKey]
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (trimmedQuery.length < 2) {
      setHistorySearchResults([], false, {
        totalCount: 0,
        hasMore: false,
        nextCursor: undefined,
        indexState: "ready",
      });
      return;
    }

    const timeoutId = window.setTimeout(() => {
      issueSearch(filtersRef.current);
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, issueSearch, query, setHistorySearchResults, trimmedQuery]);

  const navigateToResult = useCallback(
    (result: HistorySearchResult) => {
      closeHistorySearch();
      setPendingHistorySearchNavigation({
        address: {
          workflowKey: result.workflowKey,
          kind: "run",
          runRef: result.runRef,
        },
        findQuery: query.trim(),
        target: result.target,
      });
      const ui = useUiStore.getState();
      const address = {
        workflowKey: result.workflowKey,
        kind: "run" as const,
        runRef: result.runRef,
      };
      const requestId = ui.requestRunViewLoad(
        address,
        ui.runSummaries,
        ui.executionRunRef ?? undefined,
        result.workflowName
      );
      vscode.postMessage({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address,
        requestId,
      });
    },
    [closeHistorySearch, query, setPendingHistorySearchNavigation, vscode]
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHistorySearch();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [closeHistorySearch, isOpen]);

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHistorySearch();
        return;
      }

      if (event.key === "Enter" && results.length > 0) {
        event.preventDefault();
        navigateToResult(results[0]);
      }
    },
    [closeHistorySearch, navigateToResult, results]
  );

  const handleFilterChange = useCallback(
    (nextFilters: HistorySearchFilterState) => {
      setHistorySearchFilters(nextFilters);
      issueSearch(nextFilters);
    },
    [issueSearch, setHistorySearchFilters]
  );

  const handleResetFilters = useCallback(() => {
    const defaults = createDefaultHistorySearchFilters();
    resetHistorySearchFilters();
    issueSearch(defaults);
  }, [issueSearch, resetHistorySearchFilters]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore || loading || !hasMore) {
      return;
    }
    setHistorySearchResults([], false, {
      append: true,
      loadingMore: true,
      totalCount,
      nextCursor,
      hasMore,
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: trimmedQuery,
      limit: RESULT_LIMIT,
      cursor: nextCursor,
      filters: toHistorySearchFilters(historySearchFilters, workflowKey),
    });
  }, [
    hasMore,
    loading,
    loadingMore,
    historySearchFilters,
    nextCursor,
    setHistorySearchResults,
    totalCount,
    trimmedQuery,
    vscode,
    workflowKey,
  ]);

  const summaryLabel = useMemo(() => {
    if (trimmedQuery.length < 2 || loading || totalCount === 0) {
      return "";
    }
    return `Showing ${results.length} of ${totalCount}${activeFilterCount > 0 ? " (filtered)" : ""}`;
  }, [
    activeFilterCount,
    loading,
    results.length,
    totalCount,
    trimmedQuery.length,
  ]);

  return (
    <div
      className={`absolute inset-0 z-drawer flex flex-col bg-panel-bg border-t border-panel-border
        transition-transform duration-200 ease-out
        ${isOpen ? "translate-y-0" : "-translate-y-full pointer-events-none"}`}
      aria-hidden={!isOpen}
    >
      <div className="flex items-center justify-between px-2 h-[30px] border-b border-panel-border shrink-0">
        <div className="flex items-center gap-1 text-description-fg">
          <i className="codicon codicon-search text-sm" />
          <span
            id="history-search-title"
            className="text-sm font-semibold uppercase tracking-wide ml-0.5"
          >
            Search History
          </span>
        </div>

        <ExitButton
          onClick={closeHistorySearch}
          title="Close history search"
          aria-label="Close history search"
        />
      </div>

      <div className="border-b border-panel-border px-4 py-3 shrink-0">
        <div className={CONTENT_COLUMN_CLASS}>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <i className="codicon codicon-search pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-description-fg" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => setHistorySearchQuery(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Search workflow history..."
                aria-label="Search workflow history"
                className="h-9 w-full rounded border border-input-border bg-input-bg pl-9 pr-3 text-sm text-input-fg outline-none focus:border-focus-border"
              />
            </div>
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-label={`History search filters${activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ""}`}
              aria-expanded={filtersOpen}
              aria-controls="history-search-filters"
              title="History search filters"
              className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
            >
              <i className="codicon codicon-filter text-sm" />
              {activeFilterCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-btn-bg px-1 text-[10px] font-semibold text-btn-fg"
                >
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>

          {filtersOpen && (
            <div
              id="history-search-filters"
              className="mt-2 flex min-w-0 items-start gap-2"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2 overflow-x-auto pb-0.5">
                <div className="flex-shrink-0 text-xs text-description-fg">
                  <MultiCheckboxDropdown
                    id="history-event-kind-filter"
                    selectedValues={historySearchFilters.eventKinds}
                    onChange={(eventKinds) =>
                      handleFilterChange({
                        ...historySearchFilters,
                        eventKinds: eventKinds as HistoryEventKind[],
                      })
                    }
                    options={EVENT_KIND_OPTIONS}
                    placeholder="No Events"
                    buttonLabel={formatMultiFilterLabel(
                      historySearchFilters.eventKinds,
                      ALL_HISTORY_EVENT_KINDS,
                      "Events",
                      EVENT_KIND_OPTIONS
                    )}
                    className="w-fit min-w-[112px]"
                    dropdownMaxHeight="260px"
                  />
                </div>

                <DateRangeFilterControls
                  value={historySearchFilters.dateRange}
                  onChange={(dateRange) =>
                    handleFilterChange({
                      ...historySearchFilters,
                      dateRange,
                    })
                  }
                />
              </div>

              <button
                type="button"
                onClick={handleResetFilters}
                disabled={activeFilterCount === 0}
                title="Clear history search filters"
                aria-label="Clear history search filters"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-btn-secondary-bg"
              >
                <i className="codicon codicon-clear-all text-xxs" />
              </button>
            </div>
          )}

          {trimmedQuery.length >= 2 && (
            <div className="mt-2 flex h-5 items-center justify-between gap-3 text-sm text-description-fg">
              <span>{summaryLabel}</span>
              <span>{indexState === "building" ? "Index updating" : ""}</span>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {trimmedQuery.length === 1 && !loading && (
          <div className="px-3 py-6 text-center text-sm text-description-fg">
            Type at least 2 characters
          </div>
        )}

        {trimmedQuery.length >= 2 && loading && (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-description-fg">
            <i className="codicon codicon-loading animate-spin" />
            <span>Searching...</span>
          </div>
        )}

        {trimmedQuery.length >= 2 && !loading && results.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-description-fg">
            No results
          </div>
        )}

        {results.length > 0 && (
          <div className={`flex flex-col gap-1 ${CONTENT_COLUMN_CLASS}`}>
            {results.map((result, index) => {
              const relativeTime =
                formatRelativeTimeVerbose(result.startedAt) ?? "Unknown time";
              const startedAtTitle = new Date(
                result.startedAt
              ).toLocaleString();

              return (
                <button
                  key={`${result.workflowKey}:${result.runRef}:${result.target.kind}:${result.eventKind}:${result.matchField}:${index}`}
                  type="button"
                  onClick={() => navigateToResult(result)}
                  className="w-full rounded-md border border-transparent px-3 py-3 text-left transition-colors hover:border-focus-border hover:bg-list-hover-bg focus:border-focus-border focus:bg-list-hover-bg focus:outline-none"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {result.workflowName}
                      </div>
                      <div
                        className="mt-0.5 text-xs text-description-fg"
                        title={startedAtTitle}
                      >
                        Run #{result.runId} &middot; {relativeTime}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${EVENT_KIND_BADGES[result.eventKind]}`}
                    >
                      {EVENT_KIND_LABELS[result.eventKind]}
                    </span>
                    <span className="shrink-0 pt-0.5 text-[11px] text-description-fg">
                      · {result.matchField}
                    </span>
                  </div>

                  <div className="mt-2 text-xs font-medium text-description-fg">
                    {result.matchContext}
                  </div>
                  <div className="mt-1 text-sm text-foreground/90">
                    {truncateSnippet(result.matchSnippet)}
                  </div>
                </button>
              );
            })}

            {hasMore && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="mt-2 flex h-8 items-center justify-center gap-2 self-center rounded border border-btn-border bg-btn-secondary-bg px-4 text-xs font-medium text-btn-secondary-fg hover:bg-btn-secondary-hover disabled:opacity-60"
              >
                {loadingMore && (
                  <i className="codicon codicon-loading animate-spin" />
                )}
                <span>{loadingMore ? "Loading..." : "Load more"}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
