import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileHistoryPageResponse } from "@root/types/HostedWorkspaceViewerTypes";
import { WORKSPACE_FILE_HISTORY_DEFAULT_PAGE_SIZE } from "@root/types/HostedWorkspaceViewerTypes";
import { workspaceFileHistory } from "@utils/hostedApi";
import type { VirtualizedListRange } from "@components/shared/VirtualizedListFoundation";
import type { WorkspaceFileHistoryEntry } from "@root/types/HostedWorkspaceViewerTypes";

export interface PagedFileHistoryPageRequest {
  path: string;
  offset: number;
  pageSize: number;
  historyId?: string;
  repo?: string;
}

export type PagedFileHistoryFetcher = (
  request: PagedFileHistoryPageRequest,
  signal?: AbortSignal
) => Promise<WorkspaceFileHistoryPageResponse>;

export interface FailedFileHistoryRange {
  offset: number;
  endOffset: number;
  error: Error;
}

export interface PagedFileHistoryOptions {
  /** Workspace-relative file path. */
  path: string;
  /** Repository selector for multi-repository workspaces. */
  repo?: string;
  pageSize?: number;
  enabled?: boolean;
  /** Injectable for focused consumers/tests; defaults to the hosted API. */
  fetchPage?: PagedFileHistoryFetcher;
}

export interface PagedFileHistoryController {
  path: string;
  repo?: string;
  listingId: string | null;
  totalCount: number;
  pageSize: number;
  getEntry: (index: number) => WorkspaceFileHistoryEntry | undefined;
  uniqueLoadedCount: number;
  loadedCount: number;
  loadedOffsets: readonly number[];
  inFlightOffsets: readonly number[];
  failedRanges: readonly FailedFileHistoryRange[];
  initialLoading: boolean;
  isInitialLoading: boolean;
  pageLoading: boolean;
  isLoading: boolean;
  error: Error | null;
  initialError: Error | null;
  navigate: (path: string, repo?: string) => void;
  navigateTo: (path: string, repo?: string) => void;
  refresh: () => void;
  retry: (offset?: number) => void;
  retryPage: (offset: number) => void;
  requestRange: (offset: number) => void;
  loadRange: (offset: number) => void;
  onRangeChange: (range: VirtualizedListRange) => void;
  onViewportRangeChange: (range: VirtualizedListRange) => void;
}

interface FileHistoryConfig {
  path: string;
  repo?: string;
  pageSize: number;
}

interface FileHistoryState {
  path: string;
  repo?: string;
  listingId: string | null;
  totalCount: number;
  pageSize: number;
  pages: Map<number, readonly WorkspaceFileHistoryEntry[]>;
  inFlightOffsets: Set<number>;
  failedRanges: Map<number, FailedFileHistoryRange>;
  initialLoading: boolean;
  error: Error | null;
}

const EMPTY_STATE = (
  path: string,
  repo: string | undefined,
  pageSize: number
): FileHistoryState => ({
  path,
  ...(repo === undefined ? {} : { repo }),
  listingId: null,
  totalCount: 0,
  pageSize,
  pages: new Map(),
  inFlightOffsets: new Set(),
  failedRanges: new Map(),
  initialLoading: false,
  error: null,
});

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeRepo(repo: string | undefined): string | undefined {
  const normalized = repo?.trim();
  return normalized ? normalized : undefined;
}

function listingKey(path: string, repo: string | undefined): string {
  return `${repo ?? ""}\u0000${path}`;
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
  response: WorkspaceFileHistoryPageResponse,
  expectedOffset: number,
  expectedListingId?: string,
  expectedPageSize?: number
): boolean {
  return (
    Number.isSafeInteger(response.offset) &&
    response.offset === expectedOffset &&
    Number.isSafeInteger(response.pageSize) &&
    response.pageSize > 0 &&
    (expectedPageSize === undefined ||
      response.pageSize === expectedPageSize) &&
    Number.isSafeInteger(response.totalEntries) &&
    response.totalEntries >= 0 &&
    response.offset <= response.totalEntries &&
    response.entries.length <= response.totalEntries - response.offset &&
    (expectedListingId === undefined ||
      response.historyId === expectedListingId)
  );
}

function defaultFetcher(
  request: PagedFileHistoryPageRequest,
  _signal?: AbortSignal
): Promise<WorkspaceFileHistoryPageResponse> {
  return workspaceFileHistory(
    request.path,
    request.offset,
    request.pageSize,
    request.historyId,
    request.repo
  );
}

/**
 * Owns a frozen file-history listing as a sparse random-access sequence for
 * VirtualizedPagedList. The generation is keyed by both path and repository,
 * so a late response from either identity can never populate the new list.
 */
export function usePagedFileHistory(
  options: PagedFileHistoryOptions
): PagedFileHistoryController {
  const normalizedOptionPath = normalizePath(options.path);
  const normalizedOptionRepo = normalizeRepo(options.repo);
  const requestedPageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? WORKSPACE_FILE_HISTORY_DEFAULT_PAGE_SIZE)
  );

  const fetcherRef = useRef<PagedFileHistoryFetcher>(
    options.fetchPage ?? defaultFetcher
  );
  fetcherRef.current = options.fetchPage ?? defaultFetcher;

  const configRef = useRef<FileHistoryConfig>({
    path: normalizedOptionPath,
    ...(normalizedOptionRepo === undefined
      ? {}
      : { repo: normalizedOptionRepo }),
    pageSize: requestedPageSize,
  });
  configRef.current = {
    path: normalizedOptionPath,
    ...(normalizedOptionRepo === undefined
      ? {}
      : { repo: normalizedOptionRepo }),
    pageSize: requestedPageSize,
  };

  const currentKeyRef = useRef(
    listingKey(normalizedOptionPath, normalizedOptionRepo)
  );
  const currentPathRef = useRef(normalizedOptionPath);
  const currentRepoRef = useRef(normalizedOptionRepo);
  const generationRef = useRef(0);
  const stateRef = useRef<FileHistoryState | null>(null);
  const controllersRef = useRef(new Map<number, AbortController>());
  const initialControllerRef = useRef<AbortController | null>(null);
  const pendingOffsetsRef = useRef(new Set<number>());
  const lastVisibleStartRef = useRef<number | null>(null);
  const skipOptionStartRef = useRef<string | null>(null);

  const [state, setState] = useState<FileHistoryState>(() =>
    EMPTY_STATE(normalizedOptionPath, normalizedOptionRepo, requestedPageSize)
  );
  stateRef.current = state;

  const updateState = useCallback(
    (update: (current: FileHistoryState) => FileHistoryState): void => {
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
      path: string,
      repo: string | undefined,
      listingId?: string
    ): boolean => {
      const current = stateRef.current;
      return (
        generationRef.current === generation &&
        currentKeyRef.current === listingKey(path, repo) &&
        (listingId === undefined || current?.listingId === listingId)
      );
    },
    []
  );

  const startListing = useCallback(
    (path: string, repo?: string): void => {
      const normalizedPath = normalizePath(path);
      const normalizedRepo = normalizeRepo(repo);
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      if (generation > 1) pendingOffsetsRef.current.clear();
      abortRequests();
      currentKeyRef.current = listingKey(normalizedPath, normalizedRepo);
      currentPathRef.current = normalizedPath;
      currentRepoRef.current = normalizedRepo;
      lastVisibleStartRef.current = null;

      const pageSize = configRef.current.pageSize;
      updateState(() => ({
        ...EMPTY_STATE(normalizedPath, normalizedRepo, pageSize),
        initialLoading: true,
      }));

      const controller = new AbortController();
      initialControllerRef.current = controller;
      const request: PagedFileHistoryPageRequest = {
        path: normalizedPath,
        offset: 0,
        pageSize,
        ...(normalizedRepo === undefined ? {} : { repo: normalizedRepo }),
      };

      void fetcherRef
        .current(request, controller.signal)
        .then((response) => {
          if (
            !isCurrent(generation, normalizedPath, normalizedRepo) ||
            !responseIsUsable(response, 0)
          ) {
            return;
          }
          updateState((current) => ({
            ...current,
            listingId: response.historyId,
            totalCount: response.totalEntries,
            pageSize: response.pageSize,
            pages: new Map([[0, response.entries]]),
            inFlightOffsets: new Set(),
            failedRanges: new Map(),
            initialLoading: false,
            error: null,
          }));
        })
        .catch((value: unknown) => {
          if (
            isAbortError(value) ||
            !isCurrent(generation, normalizedPath, normalizedRepo)
          ) {
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
      const path = current.path;
      const repo = current.repo;
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
            path,
            offset,
            pageSize: current.pageSize,
            historyId: listingId,
            ...(repo === undefined ? {} : { repo }),
          },
          controller.signal
        )
        .then((response) => {
          if (
            !isCurrent(generation, path, repo, listingId) ||
            !responseIsUsable(response, offset, listingId, current.pageSize)
          ) {
            return;
          }
          updateState((previous) => {
            const pages = new Map(previous.pages);
            pages.set(offset, response.entries);
            return { ...previous, pages, error: null };
          });
        })
        .catch((value: unknown) => {
          if (
            isAbortError(value) ||
            !isCurrent(generation, path, repo, listingId)
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

  const navigate = useCallback(
    (path: string, repo?: string): void => {
      const normalizedPath = normalizePath(path);
      const normalizedRepo = normalizeRepo(repo ?? configRef.current.repo);
      skipOptionStartRef.current = listingKey(normalizedPath, normalizedRepo);
      configRef.current = {
        path: normalizedPath,
        ...(normalizedRepo === undefined ? {} : { repo: normalizedRepo }),
        pageSize: configRef.current.pageSize,
      };
      startListing(normalizedPath, normalizedRepo);
    },
    [startListing]
  );

  const refresh = useCallback((): void => {
    startListing(currentPathRef.current, currentRepoRef.current);
  }, [startListing]);

  const retryPage = useCallback(
    (offset: number): void => requestRange(offset),
    [requestRange]
  );

  const retryInitial = useCallback((): void => {
    startListing(currentPathRef.current, currentRepoRef.current);
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

  const getEntry = useCallback((index: number) => {
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
    const key = listingKey(normalizedOptionPath, normalizedOptionRepo);
    if (skipOptionStartRef.current === key) {
      skipOptionStartRef.current = null;
      return;
    }
    skipOptionStartRef.current = null;
    configRef.current = {
      path: normalizedOptionPath,
      ...(normalizedOptionRepo === undefined
        ? {}
        : { repo: normalizedOptionRepo }),
      pageSize: requestedPageSize,
    };
    startListing(normalizedOptionPath, normalizedOptionRepo);
    const effectGeneration = generationRef.current;
    return () => {
      if (generationRef.current === effectGeneration) abortRequests();
    };
  }, [
    abortRequests,
    normalizedOptionPath,
    normalizedOptionRepo,
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
    for (const entries of state.pages.values()) count += entries.length;
    return count;
  }, [state.pages]);

  return {
    path: state.path,
    repo: state.repo,
    listingId: state.listingId,
    totalCount: state.totalCount,
    pageSize: state.pageSize,
    getEntry,
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
    navigate,
    navigateTo: navigate,
    refresh,
    retry,
    retryPage,
    requestRange,
    loadRange: requestRange,
    onRangeChange,
    onViewportRangeChange: onRangeChange,
  };
}
