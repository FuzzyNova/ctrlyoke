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
  HISTORY_SEARCH_COUNT_STATES,
  OUTPUT_TABS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type { HistoryEventKind } from "@root/types/WorkflowTimelineTypes";
import type { WorkflowKey } from "@root/types/CtrlYokeTypes";
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
import { Icon } from "../shared/Icon";

const RESULT_LIMIT = 50;
const HISTORY_RESULT_ESTIMATE = 108;

/**
 * Raised from 400ms when a single query scan still cost ~20s against a large
 * real-world history. The recency-ordered early-termination scan (option A in
 * dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md) has since landed
 * and put a typical query at 4-15ms, so the original reason is largely gone —
 * but not entirely: a query with no matches still reads the whole index
 * (~12s on that workspace), and a typing burst produces exactly those
 * not-yet-a-word prefixes. Lowering this is safe to try once the trigram
 * postings sidecar (option E) removes the no-match cost, or sooner with
 * measurement; it is not a free win today.
 */
export const HISTORY_SEARCH_DEBOUNCE_MS = 600;

function getHistorySearchListingId(
  query: string,
  filters: HistorySearchFilterState,
  workflowKey: WorkflowKey | undefined,
  deep: boolean,
  regex: boolean
): string {
  return `history-search:${query}:${JSON.stringify(
    toHistorySearchFilters(filters, workflowKey)
  )}:${deep ? "deep" : "shallow"}:${regex ? "regex" : "substring"}`;
}

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
  const deepSearch = useUiStore((s) => s.historySearchDeep);
  const regexSearch = useUiStore((s) => s.historySearchRegex);
  const historySearchError = useUiStore((s) => s.historySearchError);
  const totalCount = useUiStore((s) => s.historySearchTotalCount);
  const countState = useUiStore((s) => s.historySearchCountState);
  const indexState = useUiStore((s) => s.historySearchIndexState);
  const rebuildProgress = useUiStore((s) => s.historySearchRebuildProgress);
  const historySearchFilters = useUiStore((s) => s.historySearchFilters);
  const workflowKey = useUiStore((s) => s.displayedViewAddress?.workflowKey);
  const displayedViewAddress = useUiStore((s) => s.displayedViewAddress);
  const workflowName = useWorkflowStore((s) => s.workflowName);
  const closeHistorySearch = useUiStore((s) => s.closeHistorySearch);
  const setHistorySearchQuery = useUiStore((s) => s.setHistorySearchQuery);
  const setHistorySearchDeep = useUiStore((s) => s.setHistorySearchDeep);
  const setHistorySearchRegex = useUiStore((s) => s.setHistorySearchRegex);
  const setHistorySearchFilters = useUiStore((s) => s.setHistorySearchFilters);
  const resetHistorySearchFilters = useUiStore(
    (s) => s.resetHistorySearchFilters
  );
  const setHistorySearchResults = useUiStore((s) => s.setHistorySearchResults);
  const setHistorySearchListingId = useUiStore(
    (s) => s.setHistorySearchListingId
  );
  const setPendingHistorySearchNavigation = useUiStore(
    (s) => s.setPendingHistorySearchNavigation
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const filtersRef = useRef<HistorySearchFilterState>(historySearchFilters);
  filtersRef.current = historySearchFilters;
  const deepSearchRef = useRef(deepSearch);
  deepSearchRef.current = deepSearch;
  const regexSearchRef = useRef(regexSearch);
  regexSearchRef.current = regexSearch;
  // `issueSearch` reads the workflow scope through this ref rather than
  // depending on `workflowKey` directly. `displayedViewAddress` (and thus
  // `workflowKey`) changes freely in the background as other workflows run
  // while the drawer is open; if `issueSearch` depended on it directly, its
  // identity would change on every such background navigation, retriggering
  // the query-change effect below and silently re-issuing a full page-0
  // search — wiping already-loaded pages out from under the user with no
  // query or filter change to justify it.
  const workflowKeyRef = useRef(workflowKey);
  workflowKeyRef.current = workflowKey;
  // Keep the scope of the displayed page set tied to page 0, even if the
  // currently displayed workflow changes while the drawer remains open.
  const [listingWorkflowKey, setListingWorkflowKey] = useState(workflowKey);
  // Offsets already asked for in this listing. Declared here (rather than
  // beside `listingId` below) so `issueSearch` can reset it whenever it
  // (re)issues a page-0 search — otherwise a page fetched before that reset
  // stays marked "already requested" even after the results array it
  // belonged to has been replaced, and the paged list permanently skips
  // re-fetching it.
  const requestedOffsetsRef = useRef(new Set<number>());
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

      requestedOffsetsRef.current = new Set<number>();
      const requestedWorkflowKey = workflowKeyRef.current;
      setListingWorkflowKey(requestedWorkflowKey);
      const listingId = getHistorySearchListingId(
        trimmedQuery,
        filters,
        requestedWorkflowKey,
        deepSearchRef.current,
        regexSearchRef.current
      );
      setHistorySearchListingId(listingId);
      setHistorySearchResults([], true, { totalCount: 0 });
      vscode.postMessage({
        type: MESSAGE_TYPES.SEARCH_HISTORY,
        query: trimmedQuery,
        listingId,
        limit: RESULT_LIMIT,
        filters: toHistorySearchFilters(filters, requestedWorkflowKey),
        ...(deepSearchRef.current ? { deep: true } : {}),
        ...(regexSearchRef.current ? { regex: true } : {}),
      });
    },
    [setHistorySearchListingId, setHistorySearchResults, trimmedQuery, vscode]
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
      setHistorySearchListingId(null);
      setHistorySearchResults([], false, {
        totalCount: 0,
        indexState: "ready",
      });
      return;
    }

    const timeoutId = window.setTimeout(() => {
      issueSearch(filtersRef.current);
    }, HISTORY_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [issueSearch, query, setHistorySearchListingId, setHistorySearchResults, trimmedQuery]);

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
      ui.forceOutputTabForWorkflow(result.workflowKey, OUTPUT_TABS.OUTPUT);
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

  const handleDeepSearchChange = useCallback(
    (nextDeep: boolean) => {
      deepSearchRef.current = nextDeep;
      setHistorySearchDeep(nextDeep);
      issueSearch(filtersRef.current);
    },
    [issueSearch, setHistorySearchDeep]
  );

  const handleRegexSearchChange = useCallback(
    (nextRegex: boolean) => {
      regexSearchRef.current = nextRegex;
      setHistorySearchRegex(nextRegex);
      issueSearch(filtersRef.current);
    },
    [issueSearch, setHistorySearchRegex]
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
    deepSearchRef.current = false;
    regexSearchRef.current = false;
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
    }, HISTORY_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [
    historySearchFilters.pathContains,
    isOpen,
    issueSearch,
    trimmedQuery.length,
  ]);

  const listingId = useMemo(
    () =>
      getHistorySearchListingId(
        trimmedQuery,
        historySearchFilters,
        listingWorkflowKey,
        deepSearch,
        regexSearch
      ),
    [deepSearch, historySearchFilters, listingWorkflowKey, regexSearch, trimmedQuery]
  );
  const resultsScrollContainerRef = useRef<HTMLDivElement>(null);

  // Pages are addressed by absolute offset rather than chained through a
  // cursor, so scrolling to the end of a large result set fetches only the
  // window under the viewport instead of every page leading up to it.
  // `requestedOffsetsRef` itself is declared above, alongside `issueSearch`.
  useEffect(() => {
    requestedOffsetsRef.current = new Set<number>();
  }, [listingId]);

  const requestPage = useCallback(
    (offset: number) => {
      if (offset <= 0) {
        return;
      }
      // `totalCount` is only a hard ceiling once it's exact. While it's a
      // lower bound (an early-terminated scan), a page at or past it may
      // still exist — requesting it is what extends the bound.
      if (
        offset >= totalCount &&
        countState === HISTORY_SEARCH_COUNT_STATES.EXACT
      ) {
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
        listingId,
        limit: RESULT_LIMIT,
        offset,
        filters: toHistorySearchFilters(historySearchFilters, listingWorkflowKey),
        ...(deepSearch ? { deep: true } : {}),
        ...(regexSearch ? { regex: true } : {}),
      });
    },
    [
      countState,
      historySearchFilters,
      deepSearch,
      regexSearch,
      totalCount,
      trimmedQuery,
      vscode,
      listingWorkflowKey,
      listingId,
    ]
  );
  // While the total is a lower bound, the virtualized list is sized one page
  // past it so there's always a row to scroll into that triggers requesting
  // more — without this, a `totalCount` capped at the first early-terminated
  // page would make it physically impossible to scroll further.
  const virtualizedCount =
    countState === HISTORY_SEARCH_COUNT_STATES.EXACT
      ? totalCount
      : totalCount + RESULT_LIMIT;
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
      const lastIndex = Math.min(
        range.overscanEndIndex,
        Math.max(0, virtualizedCount - 1)
      );
      const firstPage = Math.floor(range.overscanStartIndex / RESULT_LIMIT);
      const lastPage = Math.floor(lastIndex / RESULT_LIMIT);
      for (let page = firstPage; page <= lastPage; page += 1) {
        const offset = page * RESULT_LIMIT;
        // Every row in the window is checked, not just the page's first:
        // a still-running scan pushes partial results (see
        // SEARCH_HISTORY_PARTIAL_RESULTS), which can fill the head of a page
        // while its tail is still outstanding. Testing only `results[offset]`
        // reads that half-filled page as loaded and leaves the rest of it
        // showing placeholders.
        const pageEnd = Math.min(offset + RESULT_LIMIT - 1, lastIndex);
        for (let index = offset; index <= pageEnd; index += 1) {
          if (results[index] === undefined) {
            requestPage(offset);
            break;
          }
        }
      }
    },
    [requestPage, results, virtualizedCount]
  );

  // Deliberately the match count alone, with no "loaded so far" component:
  // pages now arrive fast enough that a loaded tally tracked scroll speed
  // rather than anything the reader cares about. Position lives on the rows
  // (see `formatResultOrdinal`), which stay correct mid-scroll because a
  // placeholder knows its own absolute index.
  //
  // Shown as soon as `totalCount` is nonzero rather than waiting for
  // `loading` to clear: a still-running scan now pushes partial results (see
  // SEARCH_HISTORY_PARTIAL_RESULTS), so a query with a handful of matches can
  // sit at `loading === true` for the rest of a long scan while already
  // having a real, if growing, count to show.
  const summaryLabel = useMemo(() => {
    if (trimmedQuery.length < 2 || totalCount === 0) {
      return "";
    }
    // "+" marks totalCount as a lower bound rather than the true count — an
    // early-terminated (or still in-progress) scan hasn't read far enough to
    // know the real total yet.
    const isExact = countState === HISTORY_SEARCH_COUNT_STATES.EXACT;
    const countLabel = `${totalCount.toLocaleString()}${isExact ? "" : "+"}`;
    return `${countLabel} result${totalCount === 1 && isExact ? "" : "s"}${
      activeFilterCount > 0 ? " (filtered)" : ""
    }`;
  }, [activeFilterCount, countState, totalCount, trimmedQuery.length]);

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
          <Icon name="search" className="text-sm" />
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
              <Icon
                name="search"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-description-fg"
              />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => setHistorySearchQuery(event.target.value)}
                onKeyDown={handleInputKeyDown}
                aria-describedby={
                  historySearchError ? "history-search-error" : undefined
                }
                aria-invalid={historySearchError ? true : undefined}
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
              <Icon name="filter" className="text-sm" />
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

          {historySearchError && (
            <p
              id="history-search-error"
              role="alert"
              className="mt-1 text-xs text-error-fg"
            >
              {historySearchError}
            </p>
          )}

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
                  <Icon
                    name="search"
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xxs text-description-fg"
                  />
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
                <Icon name="clear-all" className="text-xxs" />
              </button>
            </div>
          )}

          {trimmedQuery.length >= 2 && (
            <div className="mt-2 flex h-5 items-center justify-between gap-3 text-sm text-description-fg">
              <span className="flex items-center gap-1.5">
                {summaryLabel}
                {/* Once rows have started arriving, the full-page spinner
                    below stands aside for the list — this inline indicator
                    is what still says the scan behind it hasn't finished. */}
                {loading && totalCount > 0 && (
                  <Icon
                    name="loading"
                    className="animate-spin text-xs"
                    aria-label="Still searching"
                  />
                )}
              </span>
              <span>
                {indexState === "building"
                  ? "Index updating"
                  : indexState === "fallback"
                    ? "Using fallback search"
                    : ""}
              </span>
            </div>
          )}

          {/* Kept in the sticky header rather than under the list: the list is
              virtualized and thousands of rows long, so a footer would never
              be read. It exists because history search counts one result per
              matching event/field while the output find bar counts one per
              literal occurrence, and a user comparing the two numbers
              otherwise concludes results are missing (see
              dev/implemented/HISTORY_SEARCH_TRUNCATED_TEXT_MATCH_PLAN.md, where
              that comparison is what surfaced a real bug alongside this
              non-bug). The remedy named here is automatic: opening a result
              arms the output find bar with this same query. */}
          {trimmedQuery.length >= 2 && (
            <div className="mt-1 flex items-start justify-between gap-3">
              <p className="text-xs text-description-fg/80">
                {regexSearch
                  ? "Each result is one matching event, not one occurrence — open a result to inspect the matching output."
                  : "Each result is one matching event, not one occurrence — open a result to highlight every occurrence in that run’s output."}
              </p>
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-description-fg"
                title="Deep search re-reads run history from disk and is slower than the indexed query"
              >
                <input
                  type="checkbox"
                  checked={deepSearch}
                  onChange={(event) =>
                    handleDeepSearchChange(event.target.checked)
                  }
                  aria-label="Deep search (slower; re-reads run history from disk)"
                  className="h-3 w-3 accent-focus-border"
                />
                <span>Deep search (slower)</span>
              </label>
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-description-fg"
                title="Interpret the query as a case-insensitive regular expression; it may be slower than substring search"
              >
                <input
                  type="checkbox"
                  checked={regexSearch}
                  onChange={(event) =>
                    handleRegexSearchChange(event.target.checked)
                  }
                  aria-label="Regex search (potentially slower; case-insensitive regular expression)"
                  className="h-3 w-3 accent-focus-border"
                />
                <span>Regex search (potentially slower)</span>
              </label>
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
          // Once partial rows have started arriving, they replace this
          // full-page indicator; the inline spinner beside the summary
          // label above keeps showing the scan is still in progress.
          totalCount === 0 &&
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
              <Icon name="loading" className="animate-spin" />
              <span>Searching...</span>
            </div>
          ))}

        {trimmedQuery.length >= 2 &&
          !loading &&
          !historySearchError &&
          totalCount === 0 && (
            <div className="px-3 py-6 text-center text-sm text-description-fg">
              No results
            </div>
          )}

        {totalCount > 0 && (
          <div
            className={`flex flex-col gap-1 ${CONTENT_COLUMN_CLASS}`}
            data-history-search-listing-id={listingId}
          >
            <VirtualizedPagedList
              totalCount={virtualizedCount}
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
