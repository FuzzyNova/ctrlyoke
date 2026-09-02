import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VirtualizedListRange } from "@components/shared/VirtualizedListFoundation";
import { workspaceCommitLog } from "@utils/hostedApi";
import type {
  WorkspaceCommitLogEntry,
  WorkspaceCommitLogResponse,
} from "@root/types/HostedWorkspaceViewerTypes";

const DEFAULT_COMMIT_HISTORY_PAGE_SIZE = 30;

export interface PagedCommitHistoryPageRequest {
  repo?: string;
  branchHint?: string;
  detached: boolean;
  offset: number;
  pageSize: number;
  historyId?: string;
}

export type PagedCommitHistoryFetcher = (
  request: PagedCommitHistoryPageRequest,
  signal?: AbortSignal
) => Promise<WorkspaceCommitLogResponse>;

export interface FailedCommitHistoryRange {
  offset: number;
  endOffset: number;
  error: Error;
}

export interface PagedCommitHistoryContext {
  repo?: string;
  branchHint?: string;
  detached: boolean;
}

export interface PagedCommitHistoryOptions extends PagedCommitHistoryContext {
  pageSize?: number;
  enabled?: boolean;
  /** Injectable for focused consumers/tests; defaults to the hosted API. */
  fetchPage?: PagedCommitHistoryFetcher;
}

export interface PagedCommitHistoryController {
  repo?: string;
  branchHint?: string;
  currentBranch: string | null;
  detached: boolean;
  listingId: string | null;
  totalCount: number;
  pageSize: number;
  getCommit: (index: number) => WorkspaceCommitLogEntry | undefined;
  uniqueLoadedCount: number;
  loadedCount: number;
  loadedOffsets: readonly number[];
  inFlightOffsets: readonly number[];
  failedRanges: readonly FailedCommitHistoryRange[];
  initialLoading: boolean;
  isInitialLoading: boolean;
  pageLoading: boolean;
  isLoading: boolean;
  error: Error | null;
  initialError: Error | null;
  navigateToContext: (context: PagedCommitHistoryContext) => void;
  refresh: () => void;
  retry: (offset?: number) => void;
  retryPage: (offset: number) => void;
  requestRange: (offset: number) => void;
  loadRange: (offset: number) => void;
  onRangeChange: (range: VirtualizedListRange) => void;
  onViewportRangeChange: (range: VirtualizedListRange) => void;
}

interface CommitHistoryConfig extends PagedCommitHistoryContext {
  pageSize: number;
}

interface CommitHistoryState extends PagedCommitHistoryContext {
  currentBranch: string | null;
  listingId: string | null;
  totalCount: number;
  pageSize: number;
  pages: Map<number, readonly WorkspaceCommitLogEntry[]>;
  inFlightOffsets: Set<number>;
  failedRanges: Map<number, FailedCommitHistoryRange>;
  initialLoading: boolean;
  error: Error | null;
}

const EMPTY_STATE = (
  context: PagedCommitHistoryContext,
  pageSize: number
): CommitHistoryState => ({
  ...(context.repo === undefined ? {} : { repo: context.repo }),
  ...(context.branchHint === undefined
    ? {}
    : { branchHint: context.branchHint }),
  detached: context.detached,
  currentBranch: null,
  listingId: null,
  totalCount: 0,
  pageSize,
  pages: new Map(),
  inFlightOffsets: new Set(),
  failedRanges: new Map(),
  initialLoading: false,
  error: null,
});

function normalizeRepo(repo: string | undefined): string | undefined {
  const normalized = repo?.trim();
  return normalized ? normalized : undefined;
}

function normalizeBranchHint(
  branchHint: string | undefined
): string | undefined {
  const normalized = branchHint?.trim();
  return normalized ? normalized : undefined;
}

function normalizeContext(
  context: PagedCommitHistoryContext
): PagedCommitHistoryContext {
  const repo = normalizeRepo(context.repo);
  const branchHint = normalizeBranchHint(context.branchHint);
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(branchHint === undefined ? {} : { branchHint }),
    detached: context.detached,
  };
}

function contextKey(context: PagedCommitHistoryContext): string {
  return `${context.repo ?? ""}\u0000${context.branchHint ?? ""}\u0000${context.detached ? "1" : "0"}`;
}

function pageOffset(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / pageSize) * pageSize;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function responseIsUsable(
  response: WorkspaceCommitLogResponse,
  expectedOffset: number,
  expectedContext?: PagedCommitHistoryContext,
  expectedListingId?: string,
  expectedPageSize?: number
): boolean {
  return (
    typeof response.historyId === "string" &&
    response.historyId.length > 0 &&
    Number.isSafeInteger(response.offset) &&
    response.offset === expectedOffset &&
    Number.isSafeInteger(response.pageSize) &&
    response.pageSize > 0 &&
    (expectedPageSize === undefined ||
      response.pageSize === expectedPageSize) &&
    Number.isSafeInteger(response.totalEntries) &&
    response.totalEntries >= 0 &&
    response.offset <= response.totalEntries &&
    response.commits.length <= response.totalEntries - response.offset &&
    typeof response.detached === "boolean" &&
    (response.currentBranch === null ||
      typeof response.currentBranch === "string") &&
    (expectedContext === undefined ||
      response.detached === expectedContext.detached) &&
    (expectedListingId === undefined ||
      response.historyId === expectedListingId)
  );
}

function defaultFetcher(
  request: PagedCommitHistoryPageRequest,
  _signal?: AbortSignal
): Promise<WorkspaceCommitLogResponse> {
  return workspaceCommitLog(
    request.offset,
    request.pageSize,
    request.branchHint,
    request.repo,
    request.historyId
  );
}

/**
 * Owns a frozen commit-history listing as a sparse random-access sequence for
 * VirtualizedPagedList. The generation is keyed by repository, branch hint,
 * and detached-HEAD state, so a late response from an old context cannot
 * populate the current listing.
 */
export function usePagedCommitHistory(
  options: PagedCommitHistoryOptions
): PagedCommitHistoryController {
  const normalizedOptionContext = useMemo(
    () => normalizeContext(options),
    [options.branchHint, options.detached, options.repo]
  );
  const requestedPageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? DEFAULT_COMMIT_HISTORY_PAGE_SIZE)
  );

  const fetcherRef = useRef<PagedCommitHistoryFetcher>(
    options.fetchPage ?? defaultFetcher
  );
  fetcherRef.current = options.fetchPage ?? defaultFetcher;

  const configRef = useRef<CommitHistoryConfig>({
    ...normalizedOptionContext,
    pageSize: requestedPageSize,
  });
  configRef.current = {
    ...normalizedOptionContext,
    pageSize: requestedPageSize,
  };

  const currentContextRef = useRef<PagedCommitHistoryContext>(
    normalizedOptionContext
  );
  const currentKeyRef = useRef(contextKey(normalizedOptionContext));
  const generationRef = useRef(0);
  const stateRef = useRef<CommitHistoryState | null>(null);
  const controllersRef = useRef(new Map<number, AbortController>());
  const initialControllerRef = useRef<AbortController | null>(null);
  const pendingOffsetsRef = useRef(new Set<number>());
  const lastVisibleStartRef = useRef<number | null>(null);
  const skipOptionStartRef = useRef<string | null>(null);

  const [state, setState] = useState<CommitHistoryState>(() =>
    EMPTY_STATE(normalizedOptionContext, requestedPageSize)
  );
  stateRef.current = state;

  const updateState = useCallback(
    (update: (current: CommitHistoryState) => CommitHistoryState): void => {
      setState((current) => update(current));
    },
    []
  );

  const abortRequests = useCallback((): void => {
    initialControllerRef.current?.abort();
    initialControllerRef.current = null;
    for (const controller of controllersRef.current.values()) {
      controller.abort();
    }
    controllersRef.current.clear();
    updateState((current) => {
      if (!current.initialLoading && current.inFlightOffsets.size === 0) {
        return current;
      }
      return {
        ...current,
        initialLoading: false,
        inFlightOffsets: new Set(),
      };
    });
  }, [updateState]);

  const isCurrent = useCallback(
    (
      generation: number,
      context: PagedCommitHistoryContext,
      listingId?: string
    ): boolean => {
      const current = stateRef.current;
      return (
        generationRef.current === generation &&
        currentKeyRef.current === contextKey(context) &&
        (listingId === undefined || current?.listingId === listingId)
      );
    },
    []
  );

  const startListing = useCallback(
    (requestedContext: PagedCommitHistoryContext): void => {
      const context = normalizeContext(requestedContext);
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      if (generation > 1) pendingOffsetsRef.current.clear();
      abortRequests();
      currentContextRef.current = context;
      currentKeyRef.current = contextKey(context);
      lastVisibleStartRef.current = null;

      const pageSize = configRef.current.pageSize;
      updateState(() => ({
        ...EMPTY_STATE(context, pageSize),
        initialLoading: true,
      }));

      const controller = new AbortController();
      initialControllerRef.current = controller;
      const request: PagedCommitHistoryPageRequest = {
        ...context,
        offset: 0,
        pageSize,
      };

      void fetcherRef
        .current(request, controller.signal)
        .then((response) => {
          // Don't gate the initial fetch on `context.detached` matching the
          // response: `detached` is a caller-supplied guess (the store's
          // last-known state, `false` by default) for this *first* request,
          // not a confirmed fact yet — the response is what tells us the
          // truth. Requiring them to match would permanently discard a
          // correct response whenever the guess was wrong (e.g. the
          // workspace opens already in detached HEAD), with nothing left to
          // ever correct it. `isCurrent` already guards against a late
          // response from a superseded context.
          if (
            !isCurrent(generation, context) ||
            !responseIsUsable(response, 0)
          ) {
            return;
          }
          updateState((current) => ({
            ...current,
            currentBranch: response.currentBranch,
            detached: response.detached,
            listingId: response.historyId,
            totalCount: response.totalEntries,
            pageSize: response.pageSize,
            pages: new Map([[0, response.commits]]),
            inFlightOffsets: new Set(),
            failedRanges: new Map(),
            initialLoading: false,
            error: null,
          }));
        })
        .catch((value: unknown) => {
          if (isAbortError(value) || !isCurrent(generation, context)) {
            return;
          }
          updateState((current) => ({
            ...current,
            initialLoading: false,
            error: errorFrom(value),
          }));
        })
        .finally(() => {
          if (initialControllerRef.current !== controller) return;
          initialControllerRef.current = null;
          updateState((current) =>
            current.initialLoading
              ? { ...current, initialLoading: false }
              : current
          );
        });
    },
    [abortRequests, isCurrent, updateState]
  );

  const requestRange = useCallback(
    (requestedOffset: number): void => {
      const current = stateRef.current;
      const offset = pageOffset(
        requestedOffset,
        current?.pageSize ?? configRef.current.pageSize
      );
      if (!current?.listingId || current.initialLoading) {
        pendingOffsetsRef.current.add(offset);
        return;
      }
      if (
        offset >= current.totalCount ||
        current.pages.has(offset) ||
        controllersRef.current.has(offset)
      ) {
        return;
      }

      const generation = generationRef.current;
      const context: PagedCommitHistoryContext = {
        ...(current.repo === undefined ? {} : { repo: current.repo }),
        ...(current.branchHint === undefined
          ? {}
          : { branchHint: current.branchHint }),
        detached: current.detached,
      };
      const listingId = current.listingId;
      const controller = new AbortController();
      controllersRef.current.set(offset, controller);
      updateState((previous) => {
        const failedRanges = new Map(previous.failedRanges);
        failedRanges.delete(offset);
        return {
          ...previous,
          inFlightOffsets: new Set(previous.inFlightOffsets).add(offset),
          failedRanges,
        };
      });

      void fetcherRef
        .current(
          {
            ...context,
            offset,
            pageSize: current.pageSize,
            historyId: listingId,
          },
          controller.signal
        )
        .then((response) => {
          if (
            !isCurrent(generation, context, listingId) ||
            !responseIsUsable(
              response,
              offset,
              context,
              listingId,
              current.pageSize
            )
          ) {
            return;
          }
          updateState((previous) => {
            const pages = new Map(previous.pages);
            pages.set(offset, response.commits);
            return { ...previous, pages, error: null };
          });
        })
        .catch((value: unknown) => {
          if (
            isAbortError(value) ||
            !isCurrent(generation, context, listingId)
          ) {
            return;
          }
          const error = errorFrom(value);
          updateState((previous) => {
            const failedRanges = new Map(previous.failedRanges);
            failedRanges.set(offset, {
              offset,
              endOffset: Math.min(
                previous.totalCount,
                offset + previous.pageSize
              ),
              error,
            });
            return { ...previous, failedRanges, error };
          });
        })
        .finally(() => {
          if (controllersRef.current.get(offset) !== controller) return;
          controllersRef.current.delete(offset);
          updateState((previous) => {
            const inFlightOffsets = new Set(previous.inFlightOffsets);
            inFlightOffsets.delete(offset);
            return { ...previous, inFlightOffsets };
          });
        });
    },
    [isCurrent, updateState]
  );

  useEffect(() => {
    if (!state.listingId || state.initialLoading) return;
    const pending = [...pendingOffsetsRef.current];
    pendingOffsetsRef.current.clear();
    for (const offset of pending) requestRange(offset);
  }, [requestRange, state.initialLoading, state.listingId]);

  const navigateToContext = useCallback(
    (requestedContext: PagedCommitHistoryContext): void => {
      const context = normalizeContext(requestedContext);
      skipOptionStartRef.current = contextKey(context);
      configRef.current = {
        ...context,
        pageSize: configRef.current.pageSize,
      };
      startListing(context);
    },
    [startListing]
  );

  const refresh = useCallback((): void => {
    startListing(currentContextRef.current);
  }, [startListing]);

  const retryPage = useCallback(
    (offset: number): void => requestRange(offset),
    [requestRange]
  );

  const retryInitial = useCallback((): void => {
    startListing(currentContextRef.current);
  }, [startListing]);

  const retry = useCallback(
    (offset?: number): void => {
      if (offset === undefined) retryInitial();
      else retryPage(offset);
    },
    [retryInitial, retryPage]
  );

  const onRangeChange = useCallback(
    (range: VirtualizedListRange): void => {
      const current = stateRef.current;
      const pageSize = current?.pageSize ?? configRef.current.pageSize;
      const previousStart = lastVisibleStartRef.current;
      const direction =
        previousStart === null || range.visibleStartIndex === previousStart
          ? 0
          : range.visibleStartIndex > previousStart
            ? 1
            : -1;
      lastVisibleStartRef.current = range.visibleStartIndex;

      const visibleFirstOffset = pageOffset(range.visibleStartIndex, pageSize);
      const visibleLastOffset = pageOffset(range.visibleEndIndex, pageSize);
      const overscanFirstOffset = pageOffset(
        range.overscanStartIndex,
        pageSize
      );
      const overscanLastOffset = pageOffset(range.overscanEndIndex, pageSize);
      const firstOffset =
        direction > 0 ? visibleFirstOffset : overscanFirstOffset;
      const lastOffset = direction < 0 ? visibleLastOffset : overscanLastOffset;
      for (let offset = firstOffset; offset <= lastOffset; offset += pageSize) {
        requestRange(offset);
      }
      if (direction > 0) requestRange(lastOffset + pageSize);
      else if (direction < 0 && firstOffset >= pageSize) {
        requestRange(firstOffset - pageSize);
      }
    },
    [requestRange]
  );

  const getCommit = useCallback((index: number) => {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    const current = stateRef.current;
    if (!current) return undefined;
    const offset = pageOffset(index, current.pageSize);
    return current.pages.get(offset)?.[index - offset];
  }, []);

  useEffect(() => {
    if (options.enabled === false) {
      abortRequests();
      return;
    }
    const key = contextKey(normalizedOptionContext);
    if (skipOptionStartRef.current === key) {
      skipOptionStartRef.current = null;
      return;
    }
    skipOptionStartRef.current = null;
    configRef.current = {
      ...normalizedOptionContext,
      pageSize: requestedPageSize,
    };
    startListing(normalizedOptionContext);
    const effectGeneration = generationRef.current;
    return () => {
      if (generationRef.current === effectGeneration) abortRequests();
    };
  }, [
    abortRequests,
    normalizedOptionContext,
    options.enabled,
    requestedPageSize,
    startListing,
  ]);

  const loadedOffsets = useMemo(
    () => [...state.pages.keys()].sort((left, right) => left - right),
    [state.pages]
  );
  const inFlightOffsets = useMemo(
    () => [...state.inFlightOffsets].sort((left, right) => left - right),
    [state.inFlightOffsets]
  );
  const failedRanges = useMemo(
    () =>
      [...state.failedRanges.values()].sort(
        (left, right) => left.offset - right.offset
      ),
    [state.failedRanges]
  );
  const uniqueLoadedCount = useMemo(() => {
    let count = 0;
    for (const commits of state.pages.values()) count += commits.length;
    return count;
  }, [state.pages]);

  return {
    repo: state.repo,
    branchHint: state.branchHint,
    currentBranch: state.currentBranch,
    detached: state.detached,
    listingId: state.listingId,
    totalCount: state.totalCount,
    pageSize: state.pageSize,
    getCommit,
    uniqueLoadedCount,
    loadedCount: uniqueLoadedCount,
    loadedOffsets,
    inFlightOffsets,
    failedRanges,
    initialLoading: state.initialLoading,
    isInitialLoading: state.initialLoading,
    pageLoading: inFlightOffsets.length > 0,
    isLoading: state.initialLoading || inFlightOffsets.length > 0,
    error: state.error,
    initialError: state.error,
    navigateToContext,
    refresh,
    retry,
    retryPage,
    requestRange,
    loadRange: requestRange,
    onRangeChange,
    onViewportRangeChange: onRangeChange,
  };
}
