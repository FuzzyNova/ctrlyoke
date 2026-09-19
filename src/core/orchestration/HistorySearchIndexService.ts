import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import {
  type HistorySearchDocument,
  type HistorySearchFilters,
  type HistorySearchQuery,
  type HistorySearchResponse,
  type HistorySearchResult,
} from "../../types/WorkflowTimelineTypes";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { Log } from "../../utils/Log";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { getFrozenRunHistoryLocation } from "../../utils/RunHistoryStoragePolicy";
import {
  HISTORY_SEARCH_COUNT_STATES,
  HISTORY_SEARCH_REBUILD_MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import { HistorySearchDocumentCache } from "./HistorySearchDocumentCache";
import {
  matchesFilters,
  normalizeHistorySearchFilters,
} from "./HistorySearchFilters";
import {
  getHistorySearchDocumentDedupeKey,
  projectHistorySearchResult,
} from "./HistorySearchResultUtils";
import {
  checkHistorySearchIndexFreshness,
  DOCUMENTS_DIR_NAME,
  INDEX_SCHEMA_VERSION,
  MANIFEST_FILE_NAME,
  REBUILD_WORKER_MAX_OLD_GENERATION_MB,
  type HistorySearchIndexManifest,
  type HistorySearchRebuildWorkerData,
  type HistorySearchRebuildWorkerMessage,
} from "./historySearchRebuildWorker";
import {
  listDocumentShardEntries,
  readShardDocuments,
  streamHistorySearchDocuments,
  type HistorySearchShardEntry,
} from "./HistorySearchShardScanner";
import {
  scanHistoryRunDeep,
  type HistoryWorkflowNameResolver,
} from "./HistoryRunDeepScanner";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";
export { MAX_INDEXED_TEXT_LENGTH } from "./historySearchRebuildWorker";
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 50;

/**
 * Upper bound on the projected results retained for random-access paging.
 * A result is far smaller than the document it came from (a bounded snippet
 * instead of up to `MAX_INDEXED_TEXT_LENGTH` of text), but a degenerate query
 * can still match most of a large index, so the snapshot is capped rather than
 * left to grow with the match count.
 */
const MAX_SNAPSHOT_RESULTS = 50000;

/**
 * Upper bound on results retained across *every* cached query snapshot
 * combined, not a per-query count. A single snapshot can already hold up to
 * MAX_SNAPSHOT_RESULTS (50,000) results, so capping by entry count would not
 * be a memory bound — a handful of large snapshots could still blow past any
 * reasonable footprint. 150,000 is 3x the per-query cap: enough for a few
 * alternating queries (a query, a refinement, a query typed again) to stay
 * cached at once without unbounding memory. Oldest entries are evicted first
 * once a new snapshot would push the total over this budget.
 */
const MAX_SNAPSHOT_CACHE_TOTAL_RESULTS = 150000;

/**
 * The deduped, sorted result list accumulated for one query so far, kept so
 * that paging through it costs O(page) instead of re-scanning every indexed
 * document. `complete` is false while the scan stopped early (a page was
 * satisfied before the index was exhausted) — `results` is then a correctly
 * ordered *prefix* of the full match list, not the whole thing, and `cursor`
 * carries the state needed to resume scanning past it.
 */
interface HistorySearchMatchSnapshot {
  results: HistorySearchResult[];
  complete: boolean;
  cursor?: HistorySearchScanCursor;
}

/**
 * Resumption state for an early-terminated scan. `shardOrder` is the full,
 * already-resolved shard visit order for this query's index snapshot,
 * retained so resuming never re-reads the documents directory or re-derives
 * a shard's `startedAt`. `nextShardIndex` is a shard boundary, never a
 * mid-shard offset: a shard is one run, and a `startedAt` tie group (which
 * may span more than one shard) must be scanned in full before any of it is
 * finalized anyway (see `scanForMatches`), so a shard boundary is always the
 * next safe place to resume from — a mid-shard line cursor would add
 * complexity a single run's size never justifies. `seenDedupeKeys` and
 * `documentsScanned` are running totals carried forward so resuming can
 * neither re-admit a duplicate nor lose scan-progress accounting.
 */
interface HistorySearchScanCursor {
  shardOrder: HistorySearchShardEntry[];
  nextShardIndex: number;
  seenDedupeKeys: Set<string>;
  documentsScanned: number;
}

/**
 * Thrown when a search is abandoned because a newer search for the same
 * client superseded it (see `WebviewMessageRouter`'s SEARCH_HISTORY handler).
 * Callers must not treat this as a search failure — in particular,
 * `HistorySearchService.search` must not fall back to a disk scan for it.
 */
export class HistorySearchCancelledError extends Error {
  constructor() {
    super("History search cancelled: superseded by a newer search");
    this.name = "HistorySearchCancelledError";
  }
}

interface ProjectedHistorySearchMatch {
  result: HistorySearchResult;
  dedupeKey: string;
  timestampMs: number;
  sequence: number;
}

/**
 * Reports progress while `search()` is blocked on a synchronous, full index
 * rebuild (no usable cached index) so a caller can surface something better
 * than an indefinite spinner. Not invoked for the background refresh path
 * (`enqueueWorkspaceRefresh`) — nothing is waiting on that one.
 */
export type IndexRebuildProgressCallback = (
  processedRuns: number,
  totalRuns: number
) => void;

/**
 * Reports interim matches while a scan is still running, so a caller can
 * surface results before the requested page is fully satisfied. Only fired
 * for a scan that has to keep going past what early termination alone can
 * shortcut — a rare term (or one with matches only in old runs) still reads
 * most or all of the index before `search()` would otherwise return anything.
 * Each call carries every match found so far for the request's page window,
 * not a delta, mirroring how the final response is built
 * (`buildPageResponse`) so a caller can treat every call — partial or final —
 * the same way.
 */
export type PartialSearchResultsCallback = (
  partialResponse: HistorySearchResponse
) => void;

export class HistorySearchIndexService {
  private loadedWorkspacePath?: string;
  private loadedManifest?: HistorySearchIndexManifest;
  // Insertion order doubles as recency order (oldest first): a hit is
  // deleted and re-set to bump it to the newest position, so the map can be
  // evicted from the front. See `getSnapshot`/`rememberSnapshot`.
  private readonly matchSnapshots = new Map<
    string,
    HistorySearchMatchSnapshot
  >();
  private matchSnapshotResultTotal = 0;
  private rebuildPromise?: Promise<void>;
  private rebuildQueued = false;
  private readonly lineageRepository = new WorkflowLineageRepository();
  private readonly documentCache = new HistorySearchDocumentCache(
    ConfigurationUtils.getHistorySearchCacheBudgetBytes()
  );

  async search(
    request: HistorySearchQuery,
    workspaceFolderPath: string,
    onRebuildProgress?: IndexRebuildProgressCallback,
    signal?: AbortSignal,
    onPartialResults?: PartialSearchResultsCallback
  ): Promise<HistorySearchResponse> {
    if (signal?.aborted) {
      throw new HistorySearchCancelledError();
    }
    this.documentCache.setBudgetBytes(
      ConfigurationUtils.getHistorySearchCacheBudgetBytes()
    );
    const normalizedQuery = request.query.trim();
    if (normalizedQuery.length < MIN_QUERY_LENGTH) {
      return this.emptyResponse(normalizedQuery, "ready");
    }

    const searchStart = Date.now();
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const limit = Math.max(1, request.limit || DEFAULT_LIMIT);
    const targetCount = offset + limit;
    const snapshotKey = this.getSnapshotKey(
      workspaceFolderPath,
      normalizedQuery,
      request.filters,
      Boolean(request.deep)
    );

    const cachedSnapshot = this.getSnapshot(snapshotKey);
    if (cachedSnapshot) {
      // Paging inside a result set the client is already scrolling is
      // answered from the snapshot its first page came from, with no
      // readiness check and no rescan — provided the snapshot already covers
      // the requested window. Both halves of "no readiness check" matter: the
      // freshness check alone costs a stat per indexed run, and re-deriving
      // matches against a meanwhile-rebuilt index would renumber every offset
      // underneath the client's scroll position.
      if (offset > 0) {
        if (
          cachedSnapshot.complete ||
          cachedSnapshot.results.length >= targetCount
        ) {
          Log.debug(
            `[HistorySearchIndexService] search page from snapshot: query="${normalizedQuery}" offset=${offset} matches=${cachedSnapshot.results.length} totalMs=${Date.now() - searchStart}`
          );
          return this.buildPageResponse(
            normalizedQuery,
            cachedSnapshot.results,
            offset,
            limit,
            cachedSnapshot.complete
          );
        }
        // The requested window falls beyond the retained prefix and the scan
        // never reached the end of the index. Resume it from the retained
        // cursor instead of restarting from shard zero.
        return this.extendSnapshotAndRespond(
          snapshotKey,
          cachedSnapshot,
          workspaceFolderPath,
          normalizedQuery,
          request.filters,
          Boolean(request.deep),
          offset,
          limit,
          targetCount,
          searchStart,
          signal,
          onPartialResults
        );
      }

      // A re-issued query (offset 0) reuses the snapshot only when the index
      // has not changed since it was built — checked via the same freshness
      // signal `ensureReady` uses below, not skipped outright. An immediate
      // repeat of the same query is the common case this serves; a query
      // re-issued after the index changed (e.g. a workflow just completed)
      // must still see the new data, so it falls through to a full rescan.
      await this.loadIfPossible(workspaceFolderPath);
      if (signal?.aborted) {
        throw new HistorySearchCancelledError();
      }
      const freshForReuse =
        this.loadedWorkspacePath === workspaceFolderPath &&
        this.loadedManifest !== undefined &&
        (await this.isManifestFresh(workspaceFolderPath, this.loadedManifest));
      if (freshForReuse) {
        if (
          cachedSnapshot.complete ||
          cachedSnapshot.results.length >= targetCount
        ) {
          Log.debug(
            `[HistorySearchIndexService] search page-0 from snapshot (index unchanged): query="${normalizedQuery}" matches=${cachedSnapshot.results.length} totalMs=${Date.now() - searchStart}`
          );
          return this.buildPageResponse(
            normalizedQuery,
            cachedSnapshot.results,
            offset,
            limit,
            cachedSnapshot.complete
          );
        }
        // The index is unchanged, but the retained prefix doesn't yet cover
        // this request's limit (e.g. a larger page than the one that built
        // the snapshot) — extend it instead of rescanning from the start.
        return this.extendSnapshotAndRespond(
          snapshotKey,
          cachedSnapshot,
          workspaceFolderPath,
          normalizedQuery,
          request.filters,
          Boolean(request.deep),
          offset,
          limit,
          targetCount,
          searchStart,
          signal,
          onPartialResults
        );
      }
      // The index changed since the snapshot was built — fall through to a
      // full rescan below.
    }

    const buildInProgress = Boolean(this.rebuildPromise);
    Log.debug(
      `[HistorySearchIndexService] search start: query="${normalizedQuery}" offset=${offset} buildInProgress=${buildInProgress}`
    );
    if (!buildInProgress) {
      await this.ensureReady(workspaceFolderPath, onRebuildProgress);
    } else {
      await this.loadIfPossible(workspaceFolderPath);
    }
    if (signal?.aborted) {
      throw new HistorySearchCancelledError();
    }
    const readyDurationMs = Date.now() - searchStart;

    const matchStart = Date.now();
    const { newResults, complete, cursor, cancelled, deepScannedRuns } =
      await this.scanForMatches(
        workspaceFolderPath,
        normalizedQuery,
        request.filters,
        targetCount,
        0,
        undefined,
        Boolean(request.deep),
        signal,
        onPartialResults
          ? (resultsSoFar) =>
              onPartialResults(
                this.buildPageResponse(
                  normalizedQuery,
                  resultsSoFar,
                  offset,
                  limit,
                  false
                )
              )
          : undefined
      );
    if (cancelled) {
      Log.debug(
        `[HistorySearchIndexService] search cancelled: query="${normalizedQuery}" deep=${Boolean(request.deep)} deepScannedRuns=${deepScannedRuns} documentsScanned=${cursor.documentsScanned} elapsedMs=${Date.now() - searchStart}`
      );
      throw new HistorySearchCancelledError();
    }
    this.storeSnapshot(snapshotKey, newResults, complete, cursor);

    Log.info(
      `[HistorySearchIndexService] search complete: query="${normalizedQuery}" deep=${Boolean(request.deep)} deepScannedRuns=${deepScannedRuns} documentsScanned=${cursor.documentsScanned} matches=${newResults.length} countState=${complete ? HISTORY_SEARCH_COUNT_STATES.EXACT : HISTORY_SEARCH_COUNT_STATES.AT_LEAST} readyMs=${readyDurationMs} matchMs=${Date.now() - matchStart} totalMs=${Date.now() - searchStart} indexState=${this.rebuildPromise ? "building" : "ready"}`
    );

    return this.buildPageResponse(
      normalizedQuery,
      newResults,
      offset,
      limit,
      complete
    );
  }

  /**
   * Extends a snapshot that doesn't yet cover the requested window by
   * resuming the scan from its retained cursor, then answers the request from
   * the combined results. Shared by the offset>0 deep-paging path and the
   * offset===0 "index unchanged but a bigger page was asked for" path.
   */
  private async extendSnapshotAndRespond(
    snapshotKey: string,
    snapshot: HistorySearchMatchSnapshot,
    workspaceFolderPath: string,
    normalizedQuery: string,
    filters: HistorySearchFilters | undefined,
    deep: boolean,
    offset: number,
    limit: number,
    targetCount: number,
    searchStart: number,
    signal?: AbortSignal,
    onPartialResults?: PartialSearchResultsCallback
  ): Promise<HistorySearchResponse> {
    const matchStart = Date.now();
    const { newResults, complete, cursor, cancelled, deepScannedRuns } =
      await this.scanForMatches(
        workspaceFolderPath,
        normalizedQuery,
        filters,
        targetCount,
        snapshot.results.length,
        snapshot.cursor,
        deep,
        signal,
        onPartialResults
          ? (resultsSoFar) =>
              onPartialResults(
                this.buildPageResponse(
                  normalizedQuery,
                  snapshot.results.concat(resultsSoFar),
                  offset,
                  limit,
                  false
                )
              )
          : undefined
      );
    if (cancelled) {
      Log.debug(
        `[HistorySearchIndexService] search cancelled while extending snapshot: query="${normalizedQuery}" deep=${deep} deepScannedRuns=${deepScannedRuns} documentsScanned=${cursor.documentsScanned}`
      );
      throw new HistorySearchCancelledError();
    }
    const combined = snapshot.results.concat(newResults);
    this.storeSnapshot(snapshotKey, combined, complete, cursor);

    Log.info(
      `[HistorySearchIndexService] search extended snapshot: query="${normalizedQuery}" deep=${deep} deepScannedRuns=${deepScannedRuns} resumedAtShard=${snapshot.cursor?.nextShardIndex ?? 0} newDocumentsScanned=${cursor.documentsScanned - (snapshot.cursor?.documentsScanned ?? 0)} totalDocumentsScanned=${cursor.documentsScanned} newMatches=${newResults.length} totalMatches=${combined.length} countState=${complete ? HISTORY_SEARCH_COUNT_STATES.EXACT : HISTORY_SEARCH_COUNT_STATES.AT_LEAST} matchMs=${Date.now() - matchStart} totalMs=${Date.now() - searchStart}`
    );

    return this.buildPageResponse(
      normalizedQuery,
      combined,
      offset,
      limit,
      complete
    );
  }

  /**
   * Looks up a cached query snapshot and bumps it to most-recently-used.
   */
  private getSnapshot(key: string): HistorySearchMatchSnapshot | undefined {
    const snapshot = this.matchSnapshots.get(key);
    if (!snapshot) {
      return undefined;
    }
    this.matchSnapshots.delete(key);
    this.matchSnapshots.set(key, snapshot);
    return snapshot;
  }

  /**
   * Caches (or replaces) a query's accumulated result list, evicting the
   * oldest entries first if the new total would exceed
   * `MAX_SNAPSHOT_CACHE_TOTAL_RESULTS`. A result list over
   * `MAX_SNAPSHOT_RESULTS` is not retained at all — the previous, smaller
   * entry (if any) is left in place rather than replaced with something that
   * would immediately blow the per-query cap, since it remains valid, if
   * still incomplete, data a later request can extend further.
   */
  private storeSnapshot(
    key: string,
    results: HistorySearchResult[],
    complete: boolean,
    cursor: HistorySearchScanCursor | undefined
  ): void {
    if (results.length > MAX_SNAPSHOT_RESULTS) {
      Log.info(
        `[HistorySearchIndexService] match snapshot not retained: matches=${results.length} exceeds ${MAX_SNAPSHOT_RESULTS}`
      );
      return;
    }
    const existing = this.matchSnapshots.get(key);
    if (existing) {
      this.matchSnapshotResultTotal -= existing.results.length;
      this.matchSnapshots.delete(key);
    }
    this.matchSnapshots.set(key, {
      results,
      complete,
      cursor: complete ? undefined : cursor,
    });
    this.matchSnapshotResultTotal += results.length;

    while (
      this.matchSnapshotResultTotal > MAX_SNAPSHOT_CACHE_TOTAL_RESULTS &&
      this.matchSnapshots.size > 1
    ) {
      const oldestKey = this.matchSnapshots.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.matchSnapshots.get(oldestKey);
      this.matchSnapshots.delete(oldestKey);
      this.matchSnapshotResultTotal -= oldest?.results.length ?? 0;
    }
  }

  private dropSnapshots(): void {
    this.matchSnapshots.clear();
    this.matchSnapshotResultTotal = 0;
  }

  /**
   * Scans shards in descending `startedAt` order (see
   * `HistorySearchShardScanner`), filtering, projecting, and deduping
   * documents into new results, and stops as soon as `alreadyCollectedCount +
   * newResults.length` reaches `targetCount` — *provided* the `startedAt`
   * group currently being scanned has been finished first.
   *
   * That last part is not an optimization detail: shards are visited a whole
   * run at a time, and dedupe removes rows, so a row's deduped position can
   * only be trusted once everything sorted ahead of it — including every
   * other shard sharing its run's `startedAt` — has been accounted for.
   * Terminating the instant the raw match count reaches `targetCount` would
   * both cut a tied `startedAt` group in half (wrong order) and could still
   * under-fill the page once dedupe drops some of what was "found" (wrong
   * count). Buffering a group, sorting it, deduping it against everything
   * scanned so far, and checking the target only at the *next* group's
   * boundary satisfies both at once — with no arbitrary lookahead margin
   * needed, because the group itself is the margin.
   *
   * `resume`, when provided, continues an earlier call's scan from its
   * retained shard index and dedupe set instead of starting over — see
   * `HistorySearchScanCursor`. Returns *new* results only (not the caller's
   * already-collected prefix); the caller concatenates.
   *
   * `onPartialResultsFound`, when provided, is called with the (copied) *new*
   * results found so far every time a finished group adds at least one — i.e.
   * at the same group boundaries the early-termination check above uses, so
   * a partial push is exactly as safe to trust (ordering/dedupe-wise) as a
   * final one. It is never called for a group that matched nothing, which is
   * what keeps this from firing once per shard on a large index.
   */
  private async scanForMatches(
    workspaceFolderPath: string,
    normalizedQuery: string,
    filters: HistorySearchFilters | undefined,
    targetCount: number | undefined,
    alreadyCollectedCount: number,
    resume: HistorySearchScanCursor | undefined,
    deep: boolean,
    signal?: AbortSignal,
    onPartialResultsFound?: (newResultsSoFar: HistorySearchResult[]) => void
  ): Promise<{
    newResults: HistorySearchResult[];
    complete: boolean;
    cursor: HistorySearchScanCursor;
    cancelled: boolean;
    deepScannedRuns: number;
  }> {
    const lowered = normalizedQuery.toLowerCase();
    const hasPersistedLowercaseKey =
      this.hasCurrentSchemaIndex(workspaceFolderPath);
    const documentsDir = this.getDocumentsDir(workspaceFolderPath);

    const shardOrder =
      resume?.shardOrder ??
      (await listDocumentShardEntries(
        documentsDir,
        hasPersistedLowercaseKey ? this.loadedManifest?.indexedRuns : undefined
      ));
    // Resuming reuses the retained cursor's dedupe set *by reference* rather
    // than copying it (a copy would cost O(matches so far) on every page of a
    // large result set). That makes every key added here a mutation of the
    // caller's retained snapshot, which is only correct while this call's
    // results are actually kept — a cancelled scan discards its results, so
    // anything it admitted has to come back out of the set (see the rollback
    // below). Leaving them in would suppress those documents as "already
    // seen" when the scan is later resumed, silently dropping real matches
    // from the result set for the rest of the listing's life.
    const seen = resume?.seenDedupeKeys ?? new Set<string>();
    const addedDedupeKeys: string[] = [];
    const priorDocumentsScanned = resume?.documentsScanned ?? 0;
    let documentsScannedThisCall = 0;
    let deepScannedRuns = 0;
    const resolveWorkflowName =
      this.createWorkflowNameResolver(workspaceFolderPath);

    const newResults: HistorySearchResult[] = [];
    let groupBuffer: ProjectedHistorySearchMatch[] = [];

    const finalizeGroup = (): void => {
      groupBuffer.sort(
        (left, right) =>
          right.timestampMs - left.timestampMs || right.sequence - left.sequence
      );
      for (const match of groupBuffer) {
        if (seen.has(match.dedupeKey)) {
          continue;
        }
        seen.add(match.dedupeKey);
        addedDedupeKeys.push(match.dedupeKey);
        newResults.push(match.result);
      }
      groupBuffer = [];
    };

    let index = resume?.nextShardIndex ?? 0;
    let currentGroupStartedAt: number | undefined;
    let cancelled = false;
    let stoppedEarly = false;

    for (; index < shardOrder.length; index++) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }

      // The deep pass is deliberately inside this run's existing group buffer:
      // its results must share the indexed pass's ordering, dedupe, early-stop,
      // paging, partial-result, and cancellation semantics.
      const shard = shardOrder[index];
      if (
        currentGroupStartedAt !== undefined &&
        shard.startedAt !== currentGroupStartedAt
      ) {
        const countBeforeGroup = newResults.length;
        finalizeGroup();
        if (onPartialResultsFound && newResults.length > countBeforeGroup) {
          onPartialResultsFound([...newResults]);
        }
        if (
          targetCount !== undefined &&
          alreadyCollectedCount + newResults.length >= targetCount
        ) {
          stoppedEarly = true;
          break;
        }
      }
      currentGroupStartedAt = shard.startedAt;

      const consider = (document: HistorySearchDocument): void => {
        if (
          !document.text.toLowerCase().includes(lowered) ||
          !matchesFilters(document, filters)
        ) {
          return;
        }
        const result = projectHistorySearchResult(document, normalizedQuery);
        groupBuffer.push({
          result,
          dedupeKey: getHistorySearchDocumentDedupeKey(document, result),
          timestampMs: document.timestampMs,
          sequence: document.sequence,
        });
      };

      const cachedDocuments = this.documentCache.get(shard.shardName);
      if (cachedDocuments) {
        documentsScannedThisCall += cachedDocuments.length;
        for (const document of cachedDocuments) {
          consider(document);
        }
      } else if (this.documentCache.wouldRetain(shard.startedAt)) {
        // Worth a full, unfiltered parse so every document in this run can be
        // retained for future queries, not just today's candidates.
        const shardRead = await readShardDocuments(
          documentsDir,
          shard.shardName,
          signal
        );
        documentsScannedThisCall += shardRead.documents.length;
        for (const document of shardRead.documents) {
          consider(document);
        }
        if (shardRead.complete) {
          this.documentCache.set(
            shard.shardName,
            shard.startedAt,
            shardRead.documents
          );
        }
      } else {
        for await (const document of streamHistorySearchDocuments(
          documentsDir,
          normalizedQuery,
          {
            hasPersistedLowercaseKey,
            resolvedShardOrder: [shard.shardName],
          },
          () => {
            documentsScannedThisCall += 1;
          },
          signal
        )) {
          consider(document);
        }
      }

      if (
        deep &&
        shard.manifestPath !== undefined &&
        shard.overCapCandidateCount !== 0
      ) {
        deepScannedRuns += 1;
        for await (const document of scanHistoryRunDeep(
          workspaceFolderPath,
          shard.manifestPath,
          normalizedQuery,
          resolveWorkflowName,
          signal
        )) {
          consider(document);
        }
      }
      // The generator returns early (without throwing) on cancellation, so a
      // partial shard scan looks like a legitimate — if incomplete — result
      // unless checked for here.
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
    }

    const cursor: HistorySearchScanCursor = {
      shardOrder,
      nextShardIndex: index,
      seenDedupeKeys: seen,
      documentsScanned: priorDocumentsScanned + documentsScannedThisCall,
    };
    if (cancelled) {
      // Undo this call's admissions to the (possibly shared) dedupe set so
      // the retained cursor is exactly as it was before this scan started.
      for (const key of addedDedupeKeys) {
        seen.delete(key);
      }
      return {
        newResults: [],
        complete: false,
        cursor,
        cancelled: true,
        deepScannedRuns,
      };
    }
    if (!stoppedEarly) {
      // Reached the true end of the index: the trailing group (the only one
      // never followed by a "next shard" transition to finalize it) still
      // needs to be folded in.
      finalizeGroup();
    }
    return {
      newResults,
      complete: !stoppedEarly,
      cursor,
      cancelled: false,
      deepScannedRuns,
    };
  }

  /**
   * A workflow-name resolver for one scan, memoized across the runs it visits.
   * Runs of the same lineage cluster heavily in a recency-ordered scan, and a
   * deep query can visit every run in the history, so resolving per run would
   * re-read the same handful of descriptors hundreds of times. Scoped to the
   * scan rather than the service so a renamed lineage shows its new name on
   * the next query instead of being pinned for the process's life.
   */
  private createWorkflowNameResolver(
    workspaceFolderPath: string
  ): HistoryWorkflowNameResolver {
    const cache = new Map<WorkflowKey, string>();
    return async (workflowKey) => {
      const cached = cache.get(workflowKey);
      if (cached !== undefined) {
        return cached;
      }
      const workflowName = await this.lineageRepository.readWorkflowDisplayName(
        workspaceFolderPath,
        workflowKey
      );
      cache.set(workflowKey, workflowName);
      return workflowName;
    };
  }

  /**
   * Whether the on-disk index this workspace is about to be scanned from is
   * known to be at the current schema. Only then do its shards carry the
   * serialized lowercase key; a search running beside a schema-upgrading
   * rebuild streams the pre-swap shards, which do not.
   */
  private hasCurrentSchemaIndex(workspaceFolderPath: string): boolean {
    return (
      this.loadedWorkspacePath === workspaceFolderPath &&
      this.loadedManifest !== undefined
    );
  }

  private buildPageResponse(
    normalizedQuery: string,
    results: HistorySearchResult[],
    offset: number,
    limit: number,
    complete: boolean
  ): HistorySearchResponse {
    const page = results.slice(offset, offset + limit);
    return {
      query: normalizedQuery,
      offset,
      results: page,
      totalCount: results.length,
      countState: complete
        ? HISTORY_SEARCH_COUNT_STATES.EXACT
        : HISTORY_SEARCH_COUNT_STATES.AT_LEAST,
      // An incomplete scan always stopped because it filled the page, so
      // there is more to find whether or not it's in the retained prefix yet
      // — optimistic, the same convention `HistorySearchService`'s disk-scan
      // fallback already uses for an unknown total.
      hasMore: complete ? offset + page.length < results.length : true,
      indexState: this.rebuildPromise ? "building" : "ready",
    };
  }

  enqueueWorkspaceRefresh(workspaceFolderPath: string): Promise<void> {
    // A workflow completing appends many history events in quick succession.
    // Without coalescing, each append would kick off (and we would previously
    // even await) a full index rebuild. Instead, if a rebuild is already
    // running, just flag that one more pass is needed once it finishes.
    if (this.rebuildPromise) {
      this.rebuildQueued = true;
      Log.debug(
        "[HistorySearchIndexService] refresh already in progress; coalescing into current pass"
      );
      return this.rebuildPromise;
    }

    const refreshStart = Date.now();
    let passCount = 0;
    this.rebuildPromise = (async () => {
      try {
        do {
          this.rebuildQueued = false;
          passCount += 1;
          const passStart = Date.now();
          await this.rebuild(workspaceFolderPath, {});
          Log.debug(
            `[HistorySearchIndexService] refresh pass ${passCount} complete: durationMs=${Date.now() - passStart} requeued=${this.rebuildQueued}`
          );
        } while (this.rebuildQueued);
        Log.info(
          `[HistorySearchIndexService] refresh finished: passes=${passCount} totalMs=${Date.now() - refreshStart}`
        );
      } catch (error) {
        Log.warn(
          `[HistorySearchIndexService] Failed to refresh index after ${passCount} pass(es), ${Date.now() - refreshStart}ms: ${getErrorMessage(error)}`
        );
      } finally {
        this.rebuildPromise = undefined;
      }
    })();
    return this.rebuildPromise;
  }

  private async ensureReady(
    workspaceFolderPath: string,
    onRebuildProgress?: IndexRebuildProgressCallback
  ): Promise<void> {
    await this.loadIfPossible(workspaceFolderPath);
    if (
      this.loadedWorkspacePath === workspaceFolderPath &&
      this.loadedManifest
    ) {
      const freshnessStart = Date.now();
      const fresh = await this.isManifestFresh(
        workspaceFolderPath,
        this.loadedManifest
      );
      Log.debug(
        `[HistorySearchIndexService] freshness check: fresh=${fresh} durationMs=${Date.now() - freshnessStart}`
      );
      if (fresh) {
        return;
      }
    }

    Log.info(
      "[HistorySearchIndexService] index missing or stale; triggering synchronous rebuild before search"
    );
    const rebuildStart = Date.now();
    await this.rebuild(workspaceFolderPath, { onProgress: onRebuildProgress });
    Log.info(
      `[HistorySearchIndexService] synchronous rebuild for search complete: durationMs=${Date.now() - rebuildStart}`
    );
  }

  private async loadIfPossible(workspaceFolderPath: string): Promise<void> {
    if (
      this.loadedWorkspacePath === workspaceFolderPath &&
      this.loadedManifest
    ) {
      return;
    }

    const loadStart = Date.now();
    try {
      const manifest = await this.readIndexManifest(workspaceFolderPath);
      if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
        Log.info(
          `[HistorySearchIndexService] on-disk index schema mismatch (found ${manifest.schemaVersion}, expected ${INDEX_SCHEMA_VERSION}); will rebuild`
        );
        this.dropLoadedIndex();
        return;
      }
      this.loadedWorkspacePath = workspaceFolderPath;
      this.loadedManifest = manifest;
      Log.debug(
        `[HistorySearchIndexService] loaded index manifest from disk: indexedRuns=${Object.keys(manifest.indexedRuns).length} durationMs=${Date.now() - loadStart}`
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.warn(
          `[HistorySearchIndexService] Failed to load search index: ${getErrorMessage(error)}`
        );
      } else {
        Log.debug(
          "[HistorySearchIndexService] no on-disk index found; will rebuild"
        );
      }
      this.dropLoadedIndex();
    }
  }

  private dropLoadedIndex(): void {
    this.loadedWorkspacePath = undefined;
    this.loadedManifest = undefined;
    this.dropSnapshots();
  }

  private async rebuild(
    workspaceFolderPath: string,
    options: {
      onProgress?: IndexRebuildProgressCallback;
    }
  ): Promise<void> {
    const indexDir = this.getIndexDir(workspaceFolderPath);
    await fs.promises.mkdir(indexDir, { recursive: true });

    const data: HistorySearchRebuildWorkerData = {
      workspaceFolderPath,
      runHistoryLocation: getFrozenRunHistoryLocation(),
      logFilePath: Log.getLogFilePath(),
    };
    const worker = new Worker(this.getWorkerScriptPath(), {
      workerData: data,
      resourceLimits: {
        maxOldGenerationSizeMb: REBUILD_WORKER_MAX_OLD_GENERATION_MB,
      },
    });
    try {
      const result = await this.waitForWorker(worker, options.onProgress);
      if (result.freshnessReason) {
        Log.debug(
          `[HistorySearchIndexService] freshness check stale: ${result.freshnessReason}`
        );
      }

      if (result.skipped) {
        // Nothing on disk changed, so every cached shard is still correct.
        this.dropLoadedIndex();
        await this.loadIfPossible(workspaceFolderPath);
        Log.info(
          "[HistorySearchIndexService] rebuild skipped: on-disk index already fresh"
        );
        return;
      }
      if (result.fullRebuild) {
        this.documentCache.clear();
      } else if (result.invalidatedShardNames) {
        for (const shardName of result.invalidatedShardNames) {
          this.documentCache.invalidate(shardName);
        }
      }
      this.dropLoadedIndex();
      await this.loadIfPossible(workspaceFolderPath);
    } finally {
      await worker.terminate();
    }
  }

  private async isManifestFresh(
    workspaceFolderPath: string,
    manifest: HistorySearchIndexManifest
  ): Promise<boolean> {
    const freshness = await checkHistorySearchIndexFreshness(
      workspaceFolderPath,
      manifest
    );
    if (!freshness.fresh) {
      Log.debug(
        `[HistorySearchIndexService] freshness check stale: ${freshness.reason}`
      );
      return false;
    }
    return true;
  }

  private getWorkerScriptPath(): string {
    const candidates = [
      path.join(__dirname, "..", "..", "historySearchRebuildWorker.js"),
      path.join(__dirname, "historySearchRebuildWorker.js"),
    ];
    const workerPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!workerPath) {
      throw new Error(
        `Unable to locate compiled history search rebuild worker; checked ${candidates.join(", ")}`
      );
    }
    return workerPath;
  }

  private async waitForWorker(
    worker: Worker,
    onProgress?: IndexRebuildProgressCallback
  ): Promise<
    Extract<
      HistorySearchRebuildWorkerMessage,
      { type: typeof HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.SUCCESS }
    >
  > {
    return new Promise((resolve, reject) => {
      let settled = false;
      let startLogged = false;
      const fail = (error: unknown): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      worker.on("message", (message: HistorySearchRebuildWorkerMessage) => {
        if (settled) {
          return;
        }
        if (message.type === HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.PROGRESS) {
          if (!startLogged) {
            startLogged = true;
            Log.info(
              `[HistorySearchIndexService] rebuild starting: runs=${message.totalRuns} worker=true`
            );
          }
          try {
            onProgress?.(message.processedRuns, message.totalRuns);
          } catch (error) {
            fail(error);
          }
        } else if (
          message.type === HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.SUCCESS
        ) {
          settled = true;
          resolve(message);
        } else {
          const error = new Error(message.message);
          if (message.stack) {
            error.stack = message.stack;
          }
          fail(error);
        }
      });
      worker.once("error", fail);
      worker.once("exit", (code) => {
        if (!settled && code !== 0) {
          fail(
            new Error(`History search rebuild worker exited with code ${code}`)
          );
        } else if (!settled) {
          fail(
            new Error("History search rebuild worker exited without a result")
          );
        }
      });
    });
  }

  private async readIndexManifest(
    workspaceFolderPath: string
  ): Promise<HistorySearchIndexManifest> {
    return JSON.parse(
      await fs.promises.readFile(
        this.getIndexManifestPath(workspaceFolderPath),
        "utf8"
      )
    ) as HistorySearchIndexManifest;
  }

  private getSnapshotKey(
    workspaceFolderPath: string,
    query: string,
    filters: HistorySearchFilters | undefined,
    deep: boolean
  ): string {
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          workspaceFolderPath,
          query: query.trim().toLowerCase(),
          filters: normalizeHistorySearchFilters(filters),
          deep,
        })
      )
      .digest("hex");
  }

  private getIndexDir(workspaceFolderPath: string): string {
    return path.join(
      projectStateRoot(workspaceFolderPath, getFrozenRunHistoryLocation()),
      PATH_CONSTANTS.SEARCH_INDEX_DIR
    );
  }

  private getIndexManifestPath(workspaceFolderPath: string): string {
    return path.join(this.getIndexDir(workspaceFolderPath), MANIFEST_FILE_NAME);
  }

  private getDocumentsDir(workspaceFolderPath: string): string {
    return path.join(this.getIndexDir(workspaceFolderPath), DOCUMENTS_DIR_NAME);
  }

  private emptyResponse(
    query: string,
    indexState: HistorySearchResponse["indexState"]
  ): HistorySearchResponse {
    return {
      query,
      offset: 0,
      results: [],
      totalCount: 0,
      countState: HISTORY_SEARCH_COUNT_STATES.EXACT,
      hasMore: false,
      indexState,
    };
  }
}
