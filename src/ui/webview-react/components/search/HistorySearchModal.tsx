import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useClickOutside } from "@hooks/useClickOutside";
import {
  MESSAGE_TYPES,
  type HistorySearchResult,
} from "@/types/messages";
import { formatRelativeTimeVerbose } from "@utils/time";

const RESULT_LIMIT = 50;

const MATCH_TYPE_LABELS: Record<HistorySearchResult["matchType"], string> = {
  response: "Response",
  file: "File",
  bash: "Bash",
  status: "Status",
  prompt: "Prompt",
  tool: "Tool",
  diff: "Diff",
};

const MATCH_TYPE_BADGES: Record<HistorySearchResult["matchType"], string> = {
  response: "bg-btn-bg/20 text-btn-fg",
  file: "bg-[var(--status-info)]/20 text-foreground",
  bash: "bg-[var(--status-warning)]/20 text-foreground",
  status: "bg-[var(--status-info)]/15 text-description-fg",
  prompt: "bg-[var(--status-success)]/20 text-foreground",
  tool: "bg-[var(--status-warning)]/15 text-foreground",
  diff: "bg-[var(--status-error)]/15 text-foreground",
};

function truncateSnippet(snippet: string, maxLength = 80): string {
  const normalized = snippet.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function HistorySearchModal() {
  const vscode = useVsCodeApi();
  const isOpen = useUiStore((s) => s.isHistorySearchOpen);
  const query = useUiStore((s) => s.historySearchQuery);
  const results = useUiStore((s) => s.historySearchResults);
  const loading = useUiStore((s) => s.historySearchLoading);
  const closeHistorySearch = useUiStore((s) => s.closeHistorySearch);
  const setHistorySearchQuery = useUiStore((s) => s.setHistorySearchQuery);
  const setHistorySearchResults = useUiStore((s) => s.setHistorySearchResults);
  const setPendingHistorySearchNavigation = useUiStore(
    (s) => s.setPendingHistorySearchNavigation
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useClickOutside([panelRef], isOpen, closeHistorySearch);

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

    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      setHistorySearchResults([], false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHistorySearchResults([], true);
      vscode.postMessage({
        type: MESSAGE_TYPES.SEARCH_HISTORY,
        query: trimmedQuery,
      });
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, query, setHistorySearchResults, vscode]);

  const navigateToResult = useCallback(
    (result: HistorySearchResult) => {
      closeHistorySearch();
      setPendingHistorySearchNavigation({
        workflowId: result.workflowId,
        workflowFilePath: result.workflowFilePath,
        runIndex: result.runIndex,
        findQuery: query.trim(),
      });
      vscode.postMessage({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        filePath: result.workflowFilePath ?? "",
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

  const trimmedQuery = query.trim();
  const footerLabel = useMemo(() => {
    if (results.length < RESULT_LIMIT) {
      return null;
    }
    return `Showing ${results.length} of ${RESULT_LIMIT}`;
  }, [results.length]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 px-4 py-6">
      <div
        ref={panelRef}
        className="flex w-full max-w-[640px] max-h-[80vh] flex-col overflow-hidden rounded-lg border border-panel-border bg-editor-bg shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-search-title"
      >
        <div className="flex items-center justify-between gap-3 border-b border-panel-border px-4 py-3">
          <h2
            id="history-search-title"
            className="text-base font-semibold text-foreground"
          >
            Search History
          </h2>
          <button
            type="button"
            className="control-button flex h-7 w-7 items-center justify-center rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover"
            onClick={closeHistorySearch}
            title="Close history search"
            aria-label="Close history search"
          >
            <i className="codicon codicon-close text-sm" />
          </button>
        </div>

        <div className="border-b border-panel-border px-4 py-3">
          <div className="relative">
            <i className="codicon codicon-search pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-description-fg" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setHistorySearchQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Search workflow history…"
              aria-label="Search workflow history"
              className="h-9 w-full rounded border border-input-border bg-input-bg pl-9 pr-3 text-sm text-input-fg outline-none focus:border-focus-border"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {trimmedQuery.length === 1 && !loading && (
            <div className="px-3 py-6 text-center text-sm text-description-fg">
              Type at least 2 characters
            </div>
          )}

          {trimmedQuery.length >= 2 && loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-description-fg">
              <i className="codicon codicon-loading animate-spin" />
              <span>Searching…</span>
            </div>
          )}

          {trimmedQuery.length >= 2 && !loading && results.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-description-fg">
              No results
            </div>
          )}

          {results.length > 0 && (
            <div className="flex flex-col gap-1">
              {results.map((result, index) => {
                const relativeTime =
                  formatRelativeTimeVerbose(result.startedAt) ?? "Unknown time";
                const startedAtTitle = new Date(result.startedAt).toLocaleString();

                return (
                  <button
                    key={`${result.workflowId}:${result.runId}:${result.target.kind}:${result.matchType}:${index}`}
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
                          Run #{result.runId} · {relativeTime}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${MATCH_TYPE_BADGES[result.matchType]}`}
                      >
                        {MATCH_TYPE_LABELS[result.matchType]}
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
            </div>
          )}
        </div>

        {footerLabel && (
          <div className="border-t border-panel-border px-4 py-2 text-right text-xs text-description-fg">
            {footerLabel}
          </div>
        )}
      </div>
    </div>
  );
}
