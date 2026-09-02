import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkspaceTreePageRequest,
  WorkspaceTreePageResponse,
  WorkspaceTreeRangeRequest,
  WorkspaceTreeEntry,
  WorkspaceEntrySort,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  DEFAULT_WORKSPACE_ENTRY_SORT,
  WORKSPACE_TREE_DEFAULT_PAGE_SIZE,
} from "@root/types/HostedWorkspaceViewerTypes";
import { HostedHttpError, workspaceTree } from "@utils/hostedApi";
import type { VirtualizedListRange } from "@components/shared/VirtualizedListFoundation";
import { ERROR_NAMES } from "@root/types/DashboardConstants";

export interface PagedWorkspaceDirectoryOptions {
  /** Workspace-relative directory path. An empty path represents the root. */
  path: string;
  includeGitIgnored: boolean;
  pageSize?: number;
  /** Server-side ordering for the immutable listing snapshot. */
  sort?: WorkspaceEntrySort;
  /** Entry to restore only when a sort change restarts the current listing. */
  sortAnchorPath?: string;
  /** Initial anchor, or an anchor supplied by a consumer before first load. */
  anchorPath?: string;
  enabled?: boolean;
  /** Injectable for focused consumers/tests; defaults to the hosted transport. */
  fetchPage?: PagedWorkspaceDirectoryFetcher;
}

export type PagedWorkspaceDirectoryRequest =
  | WorkspaceTreePageRequest
  | WorkspaceTreeRangeRequest;

export type PagedWorkspaceDirectoryFetcher = (
  request: PagedWorkspaceDirectoryRequest,
  signal?: AbortSignal
) => Promise<WorkspaceTreePageResponse>;

export interface FailedWorkspaceDirectoryRange {
  offset: number;
  endOffset: number;
  error: Error;
}

export interface WorkspaceDirectoryScrollRestoration {
  /** Absolute virtual index of the anchor in the restarted listing. */
  index: number;
  /** Page-aligned offset containing the anchor. */
  offset: number;
  /** Changes whenever a new one-shot restoration is published. */
  requestId: number;
}

export interface WorkspaceDirectoryRefreshOptions {
  anchorPath?: string;
}

export interface PagedWorkspaceDirectoryController {
  path: string;
  rootLabel: string;
  parentPath: string | null;
  isGitRepo: boolean;
  isRootsList: boolean;
  listingId: string | null;
  totalCount: number;
  /** The server-fixed page size for the current listing. */
  effectivePageSize: number;
  pageSize: number;
  getEntry: (index: number) => WorkspaceTreeEntry | undefined;
  /** Number of distinct virtual rows currently populated in sparse pages. */
  uniqueLoadedCount: number;
  loadedCount: number;
  loadedOffsets: readonly number[];
  inFlightOffsets: readonly number[];
  failedRanges: readonly FailedWorkspaceDirectoryRange[];
  initialLoading: boolean;
  isInitialLoading: boolean;
  pageLoading: boolean;
  isLoading: boolean;
  error: Error | null;
  initialError: Error | null;
  navigate: (path: string, options?: WorkspaceDirectoryRefreshOptions) => void;
  navigateTo: (
    path: string,
    options?: WorkspaceDirectoryRefreshOptions
  ) => void;
  refresh: (options?: WorkspaceDirectoryRefreshOptions | string) => void;
  retry: (offset?: number) => void;
  retryPage: (offset: number) => void;
  retryInitial: () => void;
  requestRange: (offset: number) => void;
  loadRange: (offset: number) => void;
  onRangeChange: (range: VirtualizedListRange) => void;
  onViewportRangeChange: (range: VirtualizedListRange) => void;
  scrollRestoration: WorkspaceDirectoryScrollRestoration | null;
  restoredTarget: WorkspaceDirectoryScrollRestoration | null;
  consumeScrollRestoration: () => void;
}

interface DirectoryConfig {
  path: string;
  includeGitIgnored: boolean;
  pageSize: number | undefined;
  sort: WorkspaceEntrySort;
}

interface DirectoryState {
  path: string;
  rootLabel: string;
  parentPath: string | null;
  isGitRepo: boolean;
  isRootsList: boolean;
  listingId: string | null;
  totalCount: number;
  effectivePageSize: number;
  pages: Map<number, readonly WorkspaceTreeEntry[]>;
  inFlightOffsets: Set<number>;
  failedRanges: Map<number, FailedWorkspaceDirectoryRange>;
  initialLoading: boolean;
  initialError: Error | null;
  error: Error | null;
  scrollRestoration: WorkspaceDirectoryScrollRestoration | null;
}

const EMPTY_STATE = (path: string, pageSize: number): DirectoryState => ({
  path,
  rootLabel: "",
  parentPath: null,
  isGitRepo: false,
  isRootsList: false,
  listingId: null,
  totalCount: 0,
  effectivePageSize: pageSize,
  pages: new Map(),
  inFlightOffsets: new Set(),
  failedRanges: new Map(),
  initialLoading: false,
  initialError: null,
  error: null,
  scrollRestoration: null,
});

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeSort(
  sort: WorkspaceEntrySort | undefined
): WorkspaceEntrySort {
  return sort === undefined
    ? DEFAULT_WORKSPACE_ENTRY_SORT
    : { key: sort.key, direction: sort.direction };
}

function sameSort(
  left: WorkspaceEntrySort,
  right: WorkspaceEntrySort
): boolean {
  return left.key === right.key && left.direction === right.direction;
}

function pageOffset(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / pageSize) * pageSize;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === ERROR_NAMES.ABORT;
}

function isExpiredError(value: unknown): boolean {
  return value instanceof HostedHttpError && value.status === 410;
}

function normalizeResponse(
  response: WorkspaceTreePageResponse
): WorkspaceTreePageResponse {
  return {
    ...response,
    path: normalizePath(response.path),
    parentPath:
      response.parentPath === null ? null : normalizePath(response.parentPath),
    entries: response.entries.map((entry) => ({
      ...entry,
      path: normalizePath(entry.path),
    })),
  };
}

function responseIsUsable(
  response: WorkspaceTreePageResponse,
  expectedPath: string,
  expectedOffset?: number,
  expectedListingId?: string,
  expectedPageSize?: number
): boolean {
  return (
    response.path === expectedPath &&
    (expectedOffset === undefined || response.offset === expectedOffset) &&
    (expectedListingId === undefined ||
      response.listingId === expectedListingId) &&
    Number.isSafeInteger(response.pageSize) &&
    response.pageSize > 0 &&
    (expectedPageSize === undefined ||
      response.pageSize === expectedPageSize) &&
    Number.isSafeInteger(response.offset) &&
    response.offset >= 0 &&
    Number.isSafeInteger(response.totalEntries) &&
    response.totalEntries >= 0 &&
    response.offset <= response.totalEntries &&
    response.entries.length <= response.totalEntries - response.offset
  );
}

function readRefreshAnchor(
  options?: WorkspaceDirectoryRefreshOptions | string
): string | undefined {
  return typeof options === "string" ? options : options?.anchorPath;
}

/**
 * Owns an immutable workspace directory listing while exposing it as a sparse
 * random-access sequence for VirtualizedPagedList. Pages are never flattened;
 * every lookup touches only the page containing its requested index.
 */
export function usePagedWorkspaceDirectory(
  options: PagedWorkspaceDirectoryOptions
): PagedWorkspaceDirectoryController {
  const normalizedOptionPath = normalizePath(options.path);
  const normalizedOptionSort = normalizeSort(options.sort);
  const requestedPageSize =
    options.pageSize ?? WORKSPACE_TREE_DEFAULT_PAGE_SIZE;
  const fetcherRef = useRef<PagedWorkspaceDirectoryFetcher>(
    options.fetchPage ?? workspaceTree
  );
  fetcherRef.current = options.fetchPage ?? workspaceTree;

  const configRef = useRef<DirectoryConfig>({
    path: normalizedOptionPath,
    includeGitIgnored: options.includeGitIgnored,
    pageSize: options.pageSize,
    sort: normalizedOptionSort,
  });
  const sortChanged = !sameSort(configRef.current.sort, normalizedOptionSort);
  configRef.current = {
    path: normalizedOptionPath,
    includeGitIgnored: options.includeGitIgnored,
    pageSize: options.pageSize,
    sort: normalizedOptionSort,
  };

  const currentPathRef = useRef(normalizedOptionPath);
  const anchorPathRef = useRef(options.anchorPath);
  anchorPathRef.current = options.anchorPath;
  const sortAnchorPathRef = useRef(options.sortAnchorPath);
  sortAnchorPathRef.current = options.sortAnchorPath;
  const skipOptionStartRef = useRef<DirectoryConfig | null>(null);
  const generationRef = useRef(0);
  const stateRef = useRef<DirectoryState | null>(null);
  const controllersRef = useRef(new Map<number, AbortController>());
  const initialControllerRef = useRef<AbortController | null>(null);
  const pendingOffsetsRef = useRef(new Set<number>());
  const lastVisibleStartRef = useRef<number | null>(null);
  const expirationRecoveryUsedRef = useRef(false);
  const restorationRequestIdRef = useRef(0);

  const [state, setState] = useState<DirectoryState>(() =>
    EMPTY_STATE(normalizedOptionPath, requestedPageSize)
  );
  stateRef.current = state;

  const updateState = useCallback(
    (update: (current: DirectoryState) => DirectoryState): void => {
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
      includeGitIgnored: boolean,
      sort: WorkspaceEntrySort,
      listingId?: string
    ): boolean => {
      const current = stateRef.current;
      return (
        generationRef.current === generation &&
        currentPathRef.current === path &&
        configRef.current.includeGitIgnored === includeGitIgnored &&
        sameSort(configRef.current.sort, sort) &&
        (listingId === undefined || current?.listingId === listingId)
      );
    },
    []
  );

  const findAnchor = useCallback(
    (index: number): WorkspaceTreeEntry | undefined => {
      const current = stateRef.current;
      if (!current) return undefined;
      const exactPage = current.pages.get(
        pageOffset(index, current.effectivePageSize)
      );
      const exact =
        exactPage?.[index - pageOffset(index, current.effectivePageSize)];
      if (exact) return exact;

      for (let distance = 1; distance <= current.totalCount; distance += 1) {
        const before = index - distance;
        if (before >= 0) {
          const beforePage = current.pages.get(
            pageOffset(before, current.effectivePageSize)
          );
          const beforeEntry =
            beforePage?.[
              before - pageOffset(before, current.effectivePageSize)
            ];
          if (beforeEntry) return beforeEntry;
        }
        const after = index + distance;
        if (after < current.totalCount) {
          const afterPage = current.pages.get(
            pageOffset(after, current.effectivePageSize)
          );
          const afterEntry =
            afterPage?.[after - pageOffset(after, current.effectivePageSize)];
          if (afterEntry) return afterEntry;
        }
      }
      return undefined;
    },
    []
  );

  const startListing = useCallback(
    (path: string, anchorPath?: string, isRecovery = false): void => {
      const normalizedPath = normalizePath(path);
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      // A virtualizer can report its first range before this hook's initial
      // effect runs. Preserve that one pre-effect request, while every later
      // generation must discard ranges belonging to the old listing.
      if (generation > 1) pendingOffsetsRef.current.clear();
      abortRequests();
      currentPathRef.current = normalizedPath;
      expirationRecoveryUsedRef.current = isRecovery;
      lastVisibleStartRef.current = null;

      const fallbackPageSize =
        configRef.current.pageSize ?? WORKSPACE_TREE_DEFAULT_PAGE_SIZE;
      updateState(() => ({
        ...EMPTY_STATE(normalizedPath, fallbackPageSize),
        initialLoading: true,
      }));

      const controller = new AbortController();
      initialControllerRef.current = controller;
      const includeGitIgnored = configRef.current.includeGitIgnored;
      const sort = configRef.current.sort;
      const request: WorkspaceTreePageRequest = {
        path: normalizedPath,
        includeGitIgnored,
        sort,
        ...(configRef.current.pageSize === undefined
          ? {}
          : { pageSize: configRef.current.pageSize }),
        ...(anchorPath === undefined
          ? {}
          : { anchorPath: normalizePath(anchorPath) }),
      };

      void fetcherRef
        .current(request, controller.signal)
        .then((rawResponse) => {
          const response = normalizeResponse(rawResponse);
          if (
            !isCurrent(generation, normalizedPath, includeGitIgnored, sort) ||
            !responseIsUsable(response, normalizedPath) ||
            response.offset % response.pageSize !== 0
          ) {
            return;
          }

          const pages = new Map<number, readonly WorkspaceTreeEntry[]>();
          pages.set(response.offset, response.entries);
          const recoveryAnchor = anchorPath
            ? normalizePath(anchorPath)
            : undefined;
          const recoveryEntryIndex = recoveryAnchor
            ? response.entries.findIndex(
                (entry) => entry.path === recoveryAnchor
              )
            : -1;
          const restoration =
            anchorPath !== undefined && recoveryEntryIndex >= 0
              ? {
                  index: response.offset + recoveryEntryIndex,
                  offset: response.offset,
                  requestId: ++restorationRequestIdRef.current,
                }
              : null;

          expirationRecoveryUsedRef.current = false;
          updateState((current) => ({
            ...current,
            path: normalizedPath,
            rootLabel: response.rootLabel,
            parentPath: response.parentPath,
            isGitRepo: response.isGitRepo,
            isRootsList: response.isRootsList,
            listingId: response.listingId,
            totalCount: response.totalEntries,
            effectivePageSize: response.pageSize,
            pages,
            inFlightOffsets: new Set(),
            failedRanges: new Map(),
            initialLoading: false,
            initialError: null,
            error: null,
            scrollRestoration: restoration,
          }));
        })
        .catch((value: unknown) => {
          if (
            isAbortError(value) ||
            !isCurrent(generation, normalizedPath, includeGitIgnored, sort)
          ) {
            return;
          }
          if (isExpiredError(value) && !expirationRecoveryUsedRef.current) {
            const anchor = findAnchor(lastVisibleStartRef.current ?? 0);
            startListing(normalizedPath, anchor?.path, true);
            return;
          }
          const error = errorFrom(value);
          updateState((current) => ({
            ...current,
            initialLoading: false,
            initialError: error,
            error,
          }));
        })
        .finally(() => {
          if (initialControllerRef.current === controller) {
            initialControllerRef.current = null;
            updateState((current) =>
              current.initialLoading
                ? { ...current, initialLoading: false }
                : current
            );
          }
        });
    },
    [abortRequests, findAnchor, isCurrent, updateState]
  );

  const requestRange = useCallback(
    (requestedOffset: number): void => {
      const current = stateRef.current;
      const pageSize =
        current?.effectivePageSize ??
        configRef.current.pageSize ??
        WORKSPACE_TREE_DEFAULT_PAGE_SIZE;
      const offset = pageOffset(requestedOffset, pageSize);
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
      const includeGitIgnored = configRef.current.includeGitIgnored;
      const sort = configRef.current.sort;
      const listingId = current.listingId;
      const controller = new AbortController();
      controllersRef.current.set(offset, controller);
      updateState((previous) => ({
        ...previous,
        inFlightOffsets: new Set(previous.inFlightOffsets).add(offset),
        failedRanges: (() => {
          const next = new Map(previous.failedRanges);
          next.delete(offset);
          return next;
        })(),
      }));

      void fetcherRef
        .current({ listingId, offset }, controller.signal)
        .then((rawResponse) => {
          const response = normalizeResponse(rawResponse);
          if (
            !isCurrent(generation, path, includeGitIgnored, sort, listingId) ||
            !responseIsUsable(
              response,
              path,
              offset,
              listingId,
              current.effectivePageSize
            )
          ) {
            return;
          }
          updateState((previous) => {
            const pages = new Map(previous.pages);
            pages.set(offset, response.entries);
            return {
              ...previous,
              pages,
              error: null,
            };
          });
        })
        .catch((value: unknown) => {
          if (
            isAbortError(value) ||
            !isCurrent(generation, path, includeGitIgnored, sort, listingId)
          ) {
            return;
          }
          if (isExpiredError(value) && !expirationRecoveryUsedRef.current) {
            const anchor = findAnchor(lastVisibleStartRef.current ?? 0);
            startListing(path, anchor?.path, true);
            return;
          }
          const error = errorFrom(value);
          updateState((previous) => {
            const failedRanges = new Map(previous.failedRanges);
            failedRanges.set(offset, {
              offset,
              endOffset: Math.min(
                previous.totalCount,
                offset + previous.effectivePageSize
              ),
              error,
            });
            return { ...previous, failedRanges };
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
    [findAnchor, isCurrent, startListing, updateState]
  );

  useEffect(() => {
    if (!state.listingId || state.initialLoading) return;
    const pending = [...pendingOffsetsRef.current];
    pendingOffsetsRef.current.clear();
    for (const offset of pending) requestRange(offset);
  }, [requestRange, state.initialLoading, state.listingId]);

  const navigate = useCallback(
    (path: string, options?: WorkspaceDirectoryRefreshOptions): void => {
      skipOptionStartRef.current = {
        path: normalizePath(path),
        includeGitIgnored: configRef.current.includeGitIgnored,
        pageSize: configRef.current.pageSize,
        sort: configRef.current.sort,
      };
      startListing(path, options?.anchorPath);
    },
    [startListing]
  );

  const refresh = useCallback(
    (options?: WorkspaceDirectoryRefreshOptions | string): void => {
      startListing(currentPathRef.current, readRefreshAnchor(options));
    },
    [startListing]
  );

  const retryPage = useCallback(
    (offset: number): void => {
      requestRange(offset);
    },
    [requestRange]
  );

  const retryInitial = useCallback((): void => {
    startListing(currentPathRef.current);
  }, [startListing]);

  const retry = useCallback(
    (offset?: number): void => {
      if (offset === undefined) {
        retryInitial();
      } else {
        retryPage(offset);
      }
    },
    [retryInitial, retryPage]
  );

  const onRangeChange = useCallback(
    (range: VirtualizedListRange): void => {
      const current = stateRef.current;
      const pageSize =
        current?.effectivePageSize ??
        configRef.current.pageSize ??
        WORKSPACE_TREE_DEFAULT_PAGE_SIZE;
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
      // A large downward jump should request the target page directly instead
      // of walking backward through the page that happens to overlap the
      // virtualizer's leading overscan. Upward scrolling gets the symmetric
      // preceding-page prefetch, while a stationary range keeps both sides.
      const firstOffset =
        direction > 0 ? visibleFirstOffset : overscanFirstOffset;
      const lastOffset = direction < 0 ? visibleLastOffset : overscanLastOffset;
      for (let offset = firstOffset; offset <= lastOffset; offset += pageSize) {
        requestRange(offset);
      }

      if (direction > 0) {
        requestRange(lastOffset + pageSize);
      } else if (direction < 0 && firstOffset >= pageSize) {
        requestRange(firstOffset - pageSize);
      }
    },
    [requestRange]
  );

  const getEntry = useCallback(
    (index: number): WorkspaceTreeEntry | undefined => {
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      const current = stateRef.current;
      if (!current) return undefined;
      const offset = pageOffset(index, current.effectivePageSize);
      return current.pages.get(offset)?.[index - offset];
    },
    []
  );

  const consumeScrollRestoration = useCallback((): void => {
    updateState((current) => ({ ...current, scrollRestoration: null }));
  }, [updateState]);

  useEffect(() => {
    if (options.enabled === false) {
      abortRequests();
      skipOptionStartRef.current = null;
      return;
    }
    const skipOptionStart = skipOptionStartRef.current;
    if (
      skipOptionStart &&
      skipOptionStart.path === normalizedOptionPath &&
      skipOptionStart.includeGitIgnored === options.includeGitIgnored &&
      skipOptionStart.pageSize === options.pageSize &&
      sameSort(skipOptionStart.sort, normalizedOptionSort)
    ) {
      skipOptionStartRef.current = null;
      return;
    }
    skipOptionStartRef.current = null;
    const anchorPath =
      sortChanged && currentPathRef.current === normalizedOptionPath
        ? (sortAnchorPathRef.current ??
          anchorPathRef.current ??
          findAnchor(lastVisibleStartRef.current ?? 0)?.path)
        : anchorPathRef.current;
    startListing(normalizedOptionPath, anchorPath);
    const effectGeneration = generationRef.current;
    return () => {
      // An imperative navigate can start a newer listing before this effect's
      // cleanup runs for the resulting path-prop update. Only abort the
      // generation owned by this effect; otherwise cleanup cancels the newer
      // request and leaves the reset state looking like an empty directory.
      if (generationRef.current === effectGeneration) {
        abortRequests();
      }
    };
  }, [
    abortRequests,
    findAnchor,
    normalizedOptionPath,
    options.enabled,
    options.includeGitIgnored,
    options.pageSize,
    normalizedOptionSort.key,
    normalizedOptionSort.direction,
    startListing,
  ]);

  const loadedOffsets = useMemo(
    () => [...state.pages.keys()].sort((left, right) => left - right),
    [state.pages]
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
  const inFlightOffsets = useMemo(
    () => [...state.inFlightOffsets].sort((left, right) => left - right),
    [state.inFlightOffsets]
  );

  return {
    path: state.path,
    rootLabel: state.rootLabel,
    parentPath: state.parentPath,
    isGitRepo: state.isGitRepo,
    isRootsList: state.isRootsList,
    listingId: state.listingId,
    totalCount: state.totalCount,
    effectivePageSize: state.effectivePageSize,
    pageSize: state.effectivePageSize,
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
    initialError: state.initialError,
    navigate,
    navigateTo: navigate,
    refresh,
    retry,
    retryPage,
    retryInitial,
    requestRange,
    loadRange: requestRange,
    onRangeChange,
    onViewportRangeChange: onRangeChange,
    scrollRestoration: state.scrollRestoration,
    restoredTarget: state.scrollRestoration,
    consumeScrollRestoration,
  };
}
