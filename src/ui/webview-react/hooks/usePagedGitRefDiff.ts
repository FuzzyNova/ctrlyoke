import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VirtualizedListRange } from "@components/shared/VirtualizedListFoundation";
import { workspaceGitRefDiffPage } from "@utils/hostedApi";
import {
  type WorkspaceCommitInfo,
  type WorkspaceGitRefDiffEntry,
  type WorkspaceGitRefDiffPageResponse,
} from "@root/types/HostedWorkspaceViewerTypes";
import { WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE } from "@root/types/HostedWorkspaceViewerTypes";

export interface PagedGitRefDiffPageRequest {
  ref: string;
  offset: number;
  pageSize: number;
  diffId?: string;
  repo?: string;
}

export type PagedGitRefDiffFetcher = (
  request: PagedGitRefDiffPageRequest,
  signal?: AbortSignal
) => Promise<WorkspaceGitRefDiffPageResponse>;

export interface FailedGitRefDiffRange {
  offset: number;
  endOffset: number;
  error: Error;
}

export interface PagedGitRefDiffOptions {
  /** Git ref (`~diff`, `~staged`, `~stash:N`, or a commit hash). */
  ref: string;
  /** Repository selector for multi-repository workspaces. */
  repo?: string;
  pageSize?: number;
  enabled?: boolean;
  /** Injectable for focused consumers/tests; defaults to the hosted API. */
  fetchPage?: PagedGitRefDiffFetcher;
}

export interface PagedGitRefDiffController {
  ref: string;
  repo?: string;
  /** The server-issued id for the frozen diff snapshot. */
  listingId: string | null;
  totalCount: number;
  pageSize: number;
  getEntry: (index: number) => WorkspaceGitRefDiffEntry | undefined;
  uniqueLoadedCount: number;
  loadedCount: number;
  loadedOffsets: readonly number[];
  inFlightOffsets: readonly number[];
  failedRanges: readonly FailedGitRefDiffRange[];
  initialLoading: boolean;
  isInitialLoading: boolean;
  pageLoading: boolean;
  isLoading: boolean;
  error: Error | null;
  initialError: Error | null;
  commitInfo: WorkspaceCommitInfo | null;
  refLabel: string;
  navigate: (ref: string, repo?: string) => void;
  navigateTo: (ref: string, repo?: string) => void;
  refresh: () => void;
  retry: (offset?: number) => void;
  retryPage: (offset: number) => void;
  requestRange: (offset: number) => void;
  loadRange: (offset: number) => void;
  onRangeChange: (range: VirtualizedListRange) => void;
  onViewportRangeChange: (range: VirtualizedListRange) => void;
}

interface GitRefDiffConfig {
  ref: string;
  repo?: string;
  pageSize: number;
}

interface GitRefDiffState {
  ref: string;
  repo?: string;
  listingId: string | null;
  totalCount: number;
  pageSize: number;
  pages: Map<number, readonly WorkspaceGitRefDiffEntry[]>;
  inFlightOffsets: Set<number>;
  failedRanges: Map<number, FailedGitRefDiffRange>;
  initialLoading: boolean;
  error: Error | null;
  commitInfo: WorkspaceCommitInfo | null;
}

const EMPTY_STATE = (
  ref: string,
  repo: string | undefined,
  pageSize: number
): GitRefDiffState => ({
  ref,
  ...(repo === undefined ? {} : { repo }),
  listingId: null,
  totalCount: 0,
  pageSize,
  pages: new Map(),
  inFlightOffsets: new Set(),
  failedRanges: new Map(),
  initialLoading: false,
  error: null,
  commitInfo: null,
});

function normalizeRef(ref: string): string {
  return ref.trim();
}

function normalizeRepo(repo: string | undefined): string | undefined {
  const normalized = repo?.trim();
  return normalized ? normalized : undefined;
}

function listingKey(ref: string, repo: string | undefined): string {
  return `${repo ?? ""}\u0000${ref}`;
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
  response: WorkspaceGitRefDiffPageResponse,
  expectedOffset: number,
  expectedListingId?: string,
  expectedPageSize?: number
): boolean {
  return (
    typeof response.diffId === "string" &&
    response.diffId.length > 0 &&
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
    (expectedListingId === undefined || response.diffId === expectedListingId)
  );
}

function defaultFetcher(
  request: PagedGitRefDiffPageRequest,
  _signal?: AbortSignal
): Promise<WorkspaceGitRefDiffPageResponse> {
  return workspaceGitRefDiffPage(
    request.ref,
    request.offset,
    request.pageSize,
    request.diffId,
    request.repo
  );
}

/** Derive the stable label used by the diff header from the navigated ref. */
export function gitRefDiffLabel(ref: string): string {
  const normalizedRef = normalizeRef(ref);
  const shortRef = normalizedRef.startsWith("~")
    ? normalizedRef.slice(1)
    : normalizedRef;
  return normalizedRef === "~diff"
    ? "Working Tree Changes"
    : normalizedRef === "~staged"
      ? "Staged Changes"
      : normalizedRef.startsWith("~stash:")
        ? `Stash #${normalizedRef.slice("~stash:".length)}`
        : `Commit ${shortRef.slice(0, 7)}`;
}

/**
 * Owns a frozen git-ref diff as a sparse random-access sequence for
 * VirtualizedPagedList. The generation is keyed by both ref and repository,
 * so a late response from either identity can never populate the new list.
 */
export function usePagedGitRefDiff(
  options: PagedGitRefDiffOptions
): PagedGitRefDiffController {
  const normalizedOptionRef = normalizeRef(options.ref);
  const normalizedOptionRepo = normalizeRepo(options.repo);
  const requestedPageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE)
  );

  const fetcherRef = useRef<PagedGitRefDiffFetcher>(
    options.fetchPage ?? defaultFetcher
  );
  fetcherRef.current = options.fetchPage ?? defaultFetcher;

  const configRef = useRef<GitRefDiffConfig>({
    ref: normalizedOptionRef,
    ...(normalizedOptionRepo === undefined
      ? {}
      : { repo: normalizedOptionRepo }),
    pageSize: requestedPageSize,
  });
  configRef.current = {
    ref: normalizedOptionRef,
    ...(normalizedOptionRepo === undefined
      ? {}
      : { repo: normalizedOptionRepo }),
    pageSize: requestedPageSize,
  };

  const currentKeyRef = useRef(
    listingKey(normalizedOptionRef, normalizedOptionRepo)
  );
  const currentRefRef = useRef(normalizedOptionRef);
  const currentRepoRef = useRef(normalizedOptionRepo);
  const generationRef = useRef(0);
  const stateRef = useRef<GitRefDiffState | null>(null);
  const controllersRef = useRef(new Map<number, AbortController>());
  const initialControllerRef = useRef<AbortController | null>(null);
  const pendingOffsetsRef = useRef(new Set<number>());
  const lastVisibleStartRef = useRef<number | null>(null);
  const skipOptionStartRef = useRef<string | null>(null);

  const [state, setState] = useState<GitRefDiffState>(() =>
    EMPTY_STATE(normalizedOptionRef, normalizedOptionRepo, requestedPageSize)
  );
  stateRef.current = state;

  const updateState = useCallback(
    (update: (current: GitRefDiffState) => GitRefDiffState): void => {
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
      ref: string,
      repo: string | undefined,
      listingId?: string
    ): boolean => {
      const current = stateRef.current;
      return (
        generationRef.current === generation &&
        currentKeyRef.current === listingKey(ref, repo) &&
        (listingId === undefined || current?.listingId === listingId)
      );
    },
    []
  );

  const startListing = useCallback(
    (ref: string, repo?: string): void => {
      const normalizedRef = normalizeRef(ref);
      const normalizedRepo = normalizeRepo(repo);
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      if (generation > 1) pendingOffsetsRef.current.clear();
      abortRequests();
      currentKeyRef.current = listingKey(normalizedRef, normalizedRepo);
      currentRefRef.current = normalizedRef;
      currentRepoRef.current = normalizedRepo;
      lastVisibleStartRef.current = null;

      const pageSize = configRef.current.pageSize;
      updateState(() => ({
        ...EMPTY_STATE(normalizedRef, normalizedRepo, pageSize),
        initialLoading: true,
      }));

      const controller = new AbortController();
      initialControllerRef.current = controller;
      const request: PagedGitRefDiffPageRequest = {
        ref: normalizedRef,
        offset: 0,
        pageSize,
        ...(normalizedRepo === undefined ? {} : { repo: normalizedRepo }),
      };

      void fetcherRef
        .current(request, controller.signal)
        .then((response) => {
          if (
            !isCurrent(generation, normalizedRef, normalizedRepo) ||
            !responseIsUsable(response, 0)
          ) {
            return;
          }
          updateState((current) => ({
            ...current,
            listingId: response.diffId,
            totalCount: response.totalEntries,
            pageSize: response.pageSize,
            pages: new Map([[0, response.entries]]),
            inFlightOffsets: new Set(),
            failedRanges: new Map(),
            initialLoading: false,
            error: null,
            commitInfo: response.commitInfo ?? null,
          }));
        })
        .catch((value: unknown) => {
          if (
            isAbortError(value) ||
            !isCurrent(generation, normalizedRef, normalizedRepo)
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
      const ref = current.ref;
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
            ref,
            offset,
            pageSize: current.pageSize,
            diffId: listingId,
            ...(repo === undefined ? {} : { repo }),
          },
          controller.signal
        )
        .then((response) => {
          if (
            !isCurrent(generation, ref, repo, listingId) ||
            !responseIsUsable(response, offset, listingId, current.pageSize)
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
              commitInfo: response.commitInfo ?? previous.commitInfo,
            };
          });
        })
        .catch((value: unknown) => {
          if (
            isAbortError(value) ||
            !isCurrent(generation, ref, repo, listingId)
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
    (ref: string, repo?: string): void => {
      const normalizedRef = normalizeRef(ref);
      const normalizedRepo = normalizeRepo(repo ?? configRef.current.repo);
      skipOptionStartRef.current = listingKey(normalizedRef, normalizedRepo);
      configRef.current = {
        ref: normalizedRef,
        ...(normalizedRepo === undefined ? {} : { repo: normalizedRepo }),
        pageSize: configRef.current.pageSize,
      };
      startListing(normalizedRef, normalizedRepo);
    },
    [startListing]
  );

  const refresh = useCallback((): void => {
    startListing(currentRefRef.current, currentRepoRef.current);
  }, [startListing]);

  const retryPage = useCallback(
    (offset: number): void => requestRange(offset),
    [requestRange]
  );

  const retryInitial = useCallback((): void => {
    startListing(currentRefRef.current, currentRepoRef.current);
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
    const key = listingKey(normalizedOptionRef, normalizedOptionRepo);
    if (skipOptionStartRef.current === key) {
      skipOptionStartRef.current = null;
      return;
    }
    skipOptionStartRef.current = null;
    configRef.current = {
      ref: normalizedOptionRef,
      ...(normalizedOptionRepo === undefined
        ? {}
        : { repo: normalizedOptionRepo }),
      pageSize: requestedPageSize,
    };
    startListing(normalizedOptionRef, normalizedOptionRepo);
    const effectGeneration = generationRef.current;
    return () => {
      if (generationRef.current === effectGeneration) abortRequests();
    };
  }, [
    abortRequests,
    normalizedOptionRef,
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
    ref: state.ref,
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
    commitInfo: state.commitInfo,
    refLabel: gitRefDiffLabel(state.ref),
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
