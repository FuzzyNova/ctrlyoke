import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  ALL_HISTORY_EVENT_KINDS,
  createDefaultHistorySearchFilters,
  getHistorySearchActiveFilterCount,
  toHistorySearchFilters,
  type HistorySearchFilterState,
} from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, type HistorySearchResult } from "@/types/messages";
import {
  KEYBOARD_KEYS,
  HISTORY_EVENT_KINDS,
  OUTPUT_TABS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type { HistoryEventKind } from "@root/types/WorkflowTimelineTypes";
import { formatRelativeTimeVerbose } from "@utils/time";
import { truncateSnippet } from "@utils/string";
import {
  ALL_WORKFLOW_HARNESSES,
  ALL_WORKFLOW_STATES,
  WORKFLOW_HARNESS_OPTIONS,
  WORKFLOW_STATE_OPTIONS,
} from "@utils/dateRangeFilter";
import {
  DateRangeFilterControls,
  ExitButton,
  MultiCheckboxDropdown,
  VirtualizedPagedList,
  type VirtualizedListRange,
} from "@components/shared";
import { formatMultiFilterLabel } from "@utils/filterLabels";

const RESULT_LIMIT = 50;
const HISTORY_RESULT_ESTIMATE = 108;

/**
 * Shared centered column for the search bar, result summary, and result list so
 * all three stay aligned on wide screens instead of hugging opposite edges.
 */
const CONTENT_COLUMN_CLASS = "mx-auto w-full max-w-4xl";

/**
 * A row's 1-based position in the whole result set, not in what happens to be
 * loaded. This is the listing's only position readout, so it has to be derived
 * from the absolute virtual index every row already carries.
 */
function formatResultOrdinal(index: number): string {
  return `#${(index + 1).toLocaleString()}`;
}

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

export function HistorySearchDrawer() {
  const vscode = useVsCodeApi();
  const isOpen = useUiStore((s) => s.isHistorySearchOpen);
  const query = useUiStore((s) => s.historySearchQuery);
  const results = useUiStore((s) => s.historySearchResults);
  const loading = useUiStore((s) => s.historySearchLoading);
  const totalCount = useUiStore((s) => s.historySearchTotalCount);
  const indexState = useUiStore((s) => s.historySearchIndexState);
  const rebuildProgress = useUiStore((s) => s.historySearchRebuildProgress);
  const historySearchFilters = useUiStore((s) => s.historySearchFilters);
  const workflowKey = useUiStore((s) => s.displayedViewAddress?.workflowKey);
  const displayedViewAddress = useUiStore((s) => s.displayedViewAddress);
  const workflowName = useWorkflowStore((s) => s.workflowName);
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
  const pathSearchPendingRef = useRef(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const trimmedQuery = query.trim();
  const activeFilterCount =
    getHistorySearchActiveFilterCount(historySearchFilters);

  const issueSearch = useCallback(
    (filters: HistorySearchFilterState) => {
      if (trimmedQuery.length < 2) {
        return;
      }

      setHistorySearchResults([], true, { totalCount: 0 });
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

  // Deliberately keyed off the query alone, not `isOpen`: the drawer stays
  // mounted while closed (App.tsx renders it unconditionally, hidden via
  // CSS), so reopening with an unchanged query must not re-clear and
  // re-fetch results — that wiped the list and reset scroll position on
  // every reopen even though nothing had changed. Query can only change
  // while the drawer is interactable (open), so no `isOpen` guard is needed.
  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setHistorySearchResults([], false, {
        totalCount: 0,
        indexState: "ready",
      });
      return;
    }

    const timeoutId = window.setTimeout(() => {
      issueSearch(filtersRef.current);
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [issueSearch, query, setHistorySearchResults, trimmedQuery]);

  const navigateToResult = useCallback(
    (result: HistorySearchResult) => {
      closeHistorySearch();
      setPendingHistorySearchNavigation({
        address: {
          workflowKey: result.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: result.runRef,
        },
        findQuery: query.trim(),
        target: result.target,
      });
      const ui = useUiStore.getState();
      // Search results always live in the output pane, not the terminal —
      // switch to it (and make sure the output section isn't collapsed) so
      // the result is actually visible after navigating.
      ui.setOutputCollapsed(false);
      ui.setActiveOutputTab(result.workflowKey, OUTPUT_TABS.OUTPUT);
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
      if (event.key === KEYBOARD_KEYS.ESCAPE) {
        event.preventDefault();
        closeHistorySearch();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [closeHistorySearch, isOpen]);

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === KEYBOARD_KEYS.ESCAPE) {
        event.preventDefault();
        closeHistorySearch();
        return;
      }

      const firstResult = results[0];
      if (event.key === KEYBOARD_KEYS.ENTER && firstResult) {
        event.preventDefault();
        navigateToResult(firstResult);
      }
    },
    [closeHistorySearch, navigateToResult, results]
  );

  const handleFilterChange = useCallback(
    (nextFilters: HistorySearchFilterState) => {
      pathSearchPendingRef.current = false;
      setHistorySearchFilters(nextFilters);
      issueSearch(nextFilters);
    },
    [issueSearch, setHistorySearchFilters]
  );

  const handlePathContainsChange = useCallback(
    (pathContains: string) => {
      pathSearchPendingRef.current = true;
      setHistorySearchFilters({
        ...historySearchFilters,
        pathContains,
      });
    },
    [historySearchFilters, setHistorySearchFilters]
  );

  const handleResetFilters = useCallback(() => {
    pathSearchPendingRef.current = false;
    const defaults = createDefaultHistorySearchFilters();
    resetHistorySearchFilters();
    issueSearch(defaults);
  }, [issueSearch, resetHistorySearchFilters]);

  useEffect(() => {
    if (!pathSearchPendingRef.current) {
      return;
    }

    if (!isOpen || trimmedQuery.length < 2) {
      pathSearchPendingRef.current = false;
      return;
    }

    const timeoutId = window.setTimeout(() => {
      pathSearchPendingRef.current = false;
      issueSearch(filtersRef.current);
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [
    historySearchFilters.pathContains,
    isOpen,
    issueSearch,
    trimmedQuery.length,
  ]);

  const listingId = useMemo(
    () =>
      `history-search:${trimmedQuery}:${JSON.stringify(
        toHistorySearchFilters(historySearchFilters, workflowKey)
      )}`,
    [historySearchFilters, trimmedQuery, workflowKey]
  );
  const resultsScrollContainerRef = useRef<HTMLDivElement>(null);

  // Offsets already asked for in this listing. Pages are addressed by absolute
  // offset rather than chained through a cursor, so scrolling to the end of a
  // large result set fetches only the window under the viewport instead of
  // every page leading up to it.
  const requestedOffsetsRef = useRef(new Set<number>());
  useEffect(() => {
    requestedOffsetsRef.current = new Set<number>();
  }, [listingId]);

  const requestPage = useCallback(
    (offset: number) => {
      if (offset <= 0 || offset >= totalCount) {
        return;
      }
      if (requestedOffsetsRef.current.has(offset)) {
        return;
      }
      requestedOffsetsRef.current.add(offset);
      // No store write here: the pulsing placeholder rows this page will
      // replace are already the in-flight indicator, per row rather than for
      // the listing as a whole.
      vscode.postMessage({
        type: MESSAGE_TYPES.SEARCH_HISTORY,
        query: trimmedQuery,
        limit: RESULT_LIMIT,
        offset,
        filters: toHistorySearchFilters(historySearchFilters, workflowKey),
      });
    },
    [historySearchFilters, totalCount, trimmedQuery, vscode, workflowKey]
  );
  const getItem = useCallback(
    (index: number): HistorySearchResult | undefined => results[index],
    [results]
  );
  const getItemKey = useCallback(
    (result: HistorySearchResult, index: number): string =>
      `${result.workflowKey}:${result.runRef}:${result.target.kind}:${result.eventKind}:${result.matchField}:${index}`,
    []
  );
  const renderItem = useCallback(
    (result: HistorySearchResult, index: number): ReactNode => {
      const relativeTime =
        formatRelativeTimeVerbose(result.startedAt) ?? "Unknown time";
      const startedAtTitle = new Date(result.startedAt).toLocaleString();

      return (
        <button
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
            {/* Kept in one shrink-0 group so the metadata clusters at the
                right edge; as separate `justify-between` children they spread
                across the row and read as unrelated columns. */}
            <div className="flex shrink-0 items-start gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${EVENT_KIND_BADGES[result.eventKind]}`}
              >
                {EVENT_KIND_LABELS[result.eventKind]}
              </span>
              <span className="pt-0.5 text-[11px] text-description-fg">
                · {result.matchField}
              </span>
              <span className="pt-0.5 text-[11px] tabular-nums text-description-fg/70">
                {formatResultOrdinal(index)}
              </span>
            </div>
          </div>

          <div className="mt-2 text-xs font-medium text-description-fg">
            {result.matchContext}
          </div>
          <div className="mt-1 text-sm text-foreground/90">
            {truncateSnippet(result.matchSnippet)}
          </div>
        </button>
      );
    },
    [navigateToResult]
  );
  const renderPlaceholder = useCallback(
    (index: number): ReactNode => (
      <div
        className="h-[108px] rounded-md border border-panel-border bg-editor-bg/40 px-3 py-3"
        data-history-search-placeholder="true"
        data-placeholder-index={index}
        aria-hidden="true"
      >
        {/* A placeholder carries its own ordinal so a fast scroll through
            not-yet-fetched rows still reads as a position in the listing. */}
        <div className="flex items-start justify-between gap-3">
          <div className="h-3 w-2/5 animate-pulse rounded bg-description-fg/20" />
          <span className="shrink-0 text-[11px] tabular-nums text-description-fg/70">
            {formatResultOrdinal(index)}
          </span>
        </div>
        <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-description-fg/15" />
        <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-description-fg/15" />
      </div>
    ),
    []
  );
  const estimateItemSize = useCallback(
    (_index: number): number => HISTORY_RESULT_ESTIMATE,
    []
  );
  const handleRangeChange = useCallback(
    (range: VirtualizedListRange): void => {
      const firstPage = Math.floor(range.overscanStartIndex / RESULT_LIMIT);
      const lastPage = Math.floor(
        Math.min(range.overscanEndIndex, Math.max(0, totalCount - 1)) /
          RESULT_LIMIT
      );
      for (let page = firstPage; page <= lastPage; page += 1) {
        const offset = page * RESULT_LIMIT;
        if (results[offset] === undefined) {
          requestPage(offset);
        }
      }
    },
    [requestPage, results, totalCount]
  );

  // Deliberately the match count alone, with no "loaded so far" component:
  // pages now arrive fast enough that a loaded tally tracked scroll speed
  // rather than anything the reader cares about. Position lives on the rows
  // (see `formatResultOrdinal`), which stay correct mid-scroll because a
  // placeholder knows its own absolute index.
  const summaryLabel = useMemo(() => {
    if (trimmedQuery.length < 2 || loading || totalCount === 0) {
      return "";
    }
    return `${totalCount.toLocaleString()} result${totalCount === 1 ? "" : "s"}${
      activeFilterCount > 0 ? " (filtered)" : ""
    }`;
  }, [activeFilterCount, loading, totalCount, trimmedQuery.length]);

  const workflowScopeAvailable =
    displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
    Boolean(workflowKey && workflowName);

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
              <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
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
                    dropdownMinWidth={180}
                  />
                </div>

                <div className="flex-shrink-0 text-xs text-description-fg">
                  <MultiCheckboxDropdown
                    id="history-harness-filter"
                    selectedValues={historySearchFilters.harnesses}
                    onChange={(harnesses) =>
                      handleFilterChange({
                        ...historySearchFilters,
                        harnesses,
                      })
                    }
                    options={WORKFLOW_HARNESS_OPTIONS}
                    placeholder="No Harnesses"
                    buttonLabel={formatMultiFilterLabel(
                      historySearchFilters.harnesses,
                      ALL_WORKFLOW_HARNESSES,
                      "Harnesses",
                      WORKFLOW_HARNESS_OPTIONS
                    )}
                    className="w-fit min-w-[116px]"
                    dropdownMaxHeight="260px"
                    dropdownMinWidth={170}
                  />
                </div>

                <div className="flex-shrink-0 text-xs text-description-fg">
                  <MultiCheckboxDropdown
                    id="history-outcome-filter"
                    selectedValues={historySearchFilters.executionStates}
                    onChange={(executionStates) =>
                      handleFilterChange({
                        ...historySearchFilters,
                        executionStates,
                      })
                    }
                    options={WORKFLOW_STATE_OPTIONS}
                    placeholder="No Outcomes"
                    buttonLabel={formatMultiFilterLabel(
                      historySearchFilters.executionStates,
                      ALL_WORKFLOW_STATES,
                      "Outcomes",
                      WORKFLOW_STATE_OPTIONS
                    )}
                    className="w-fit min-w-[96px]"
                    dropdownMaxHeight="260px"
                  />
                </div>

                <div className="relative w-full flex-shrink-0 sm:w-[170px]">
                  <i className="codicon codicon-search pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xxs text-description-fg" />
                  <input
                    type="text"
                    value={historySearchFilters.pathContains}
                    onChange={(event) =>
                      handlePathContainsChange(event.target.value)
                    }
                    placeholder="File path contains..."
                    aria-label="File path contains"
                    className="h-7 w-full rounded border border-input-border bg-input-bg pl-7 pr-2 text-xs text-input-fg outline-none focus:border-focus-border"
                  />
                </div>

                {workflowScopeAvailable && workflowName && (
                  <label className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded border border-input-border bg-input-bg px-2 text-xs text-input-fg">
                    <input
                      type="checkbox"
                      checked={historySearchFilters.workflowOnly}
                      onChange={(event) =>
                        handleFilterChange({
                          ...historySearchFilters,
                          workflowOnly: event.target.checked,
                        })
                      }
                      aria-label={`This workflow only: ${workflowName}`}
                      className="h-3 w-3 accent-focus-border"
                    />
                    <span className="max-w-[110px] truncate sm:max-w-[180px]">
                      Only {workflowName}
                    </span>
                  </label>
                )}

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
              <span>
                {indexState === "building"
                  ? "Index updating"
                  : indexState === "fallback"
                    ? "Using fallback search"
                    : ""}
              </span>
            </div>
          )}
        </div>
      </div>

      <div
        ref={resultsScrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2"
      >
        {trimmedQuery.length === 1 && !loading && (
          <div className="px-3 py-6 text-center text-sm text-description-fg">
            Type at least 2 characters
          </div>
        )}

        {trimmedQuery.length >= 2 &&
          loading &&
          (rebuildProgress && rebuildProgress.totalRuns > 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-sm text-description-fg">
              <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-ctx-bar-track">
                <div
                  className="h-full rounded-full bg-info-fg opacity-80 transition-[width]"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (rebuildProgress.processedRuns /
                          rebuildProgress.totalRuns) *
                          100
                      )
                    )}%`,
                  }}
                />
              </div>
              <span>
                Rebuilding search index ({rebuildProgress.processedRuns}/
                {rebuildProgress.totalRuns} runs)
              </span>
              <span className="text-center text-xs opacity-80">
                This happens once after a large history change and can take a
                while — results will appear as soon as it finishes.
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-description-fg">
              <i className="codicon codicon-loading animate-spin" />
              <span>Searching...</span>
            </div>
          ))}

        {trimmedQuery.length >= 2 && !loading && totalCount === 0 && (
          <div className="px-3 py-6 text-center text-sm text-description-fg">
            No results
          </div>
        )}

        {totalCount > 0 && (
          <div className={`flex flex-col gap-1 ${CONTENT_COLUMN_CLASS}`}>
            <VirtualizedPagedList
              totalCount={totalCount}
              listingId={listingId}
              getItem={getItem}
              getItemKey={getItemKey}
              renderItem={renderItem}
              renderPlaceholder={renderPlaceholder}
              scrollContainerRef={resultsScrollContainerRef}
              estimateItemSize={estimateItemSize}
              onRangeChange={handleRangeChange}
            />
          </div>
        )}
      </div>
    </div>
  );
}
