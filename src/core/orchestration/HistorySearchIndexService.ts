import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import {
  type HistorySearchFilters,
  type HistorySearchQuery,
  type HistorySearchResponse,
  type HistorySearchResult,
} from "../../types/WorkflowTimelineTypes";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { Log } from "../../utils/Log";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { getFrozenRunHistoryLocation } from "../../utils/RunHistoryStoragePolicy";
import {
  HISTORY_SEARCH_COUNT_STATES,
  HISTORY_SEARCH_REBUILD_MESSAGE_TYPES,
} from "../../types/DashboardConstants";
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
  streamHistorySearchDocuments,
  type HistorySearchShardEntry,
} from "./HistorySearchShardScanner";
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

  async search(
    request: HistorySearchQuery,
    workspaceFolderPath: string,
    onRebuildProgress?: IndexRebuildProgressCallback,
    signal?: AbortSignal
  ): Promise<HistorySearchResponse> {
    if (signal?.aborted) {
      throw new HistorySearchCancelledError();
    }
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
      request.filters
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
          offset,
          limit,
          targetCount,
          searchStart,
          signal
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
          offset,
          limit,
          targetCount,
          searchStart,
          signal
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
    const { newResults, complete, cursor, cancelled } =
      await this.scanForMatches(
        workspaceFolderPath,
        normalizedQuery,
        request.filters,
        targetCount,
        0,
        undefined,
        signal
      );
    if (cancelled) {
      Log.debug(
        `[HistorySearchIndexService] search cancelled: query="${normalizedQuery}" documentsScanned=${cursor.documentsScanned} elapsedMs=${Date.now() - searchStart}`
      );
      throw new HistorySearchCancelledError();
    }
    this.storeSnapshot(snapshotKey, newResults, complete, cursor);

    Log.info(
      `[HistorySearchIndexService] search complete: query="${normalizedQuery}" documentsScanned=${cursor.documentsScanned} matches=${newResults.length} countState=${complete ? HISTORY_SEARCH_COUNT_STATES.EXACT : HISTORY_SEARCH_COUNT_STATES.AT_LEAST} readyMs=${readyDurationMs} matchMs=${Date.now() - matchStart} totalMs=${Date.now() - searchStart} indexState=${this.rebuildPromise ? "building" : "ready"}`
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
    offset: number,
    limit: number,
    targetCount: number,
    searchStart: number,
    signal?: AbortSignal
  ): Promise<HistorySearchResponse> {
    const matchStart = Date.now();
    const { newResults, complete, cursor, cancelled } =
      await this.scanForMatches(
        workspaceFolderPath,
        normalizedQuery,
        filters,
        targetCount,
        snapshot.results.length,
        snapshot.cursor,
        signal
      );
    if (cancelled) {
      Log.debug(
        `[HistorySearchIndexService] search cancelled while extending snapshot: query="${normalizedQuery}" documentsScanned=${cursor.documentsScanned}`
      );
      throw new HistorySearchCancelledError();
    }
    const combined = snapshot.results.concat(newResults);
    this.storeSnapshot(snapshotKey, combined, complete, cursor);

    Log.info(
      `[HistorySearchIndexService] search extended snapshot: query="${normalizedQuery}" resumedAtShard=${snapshot.cursor?.nextShardIndex ?? 0} newDocumentsScanned=${cursor.documentsScanned - (snapshot.cursor?.documentsScanned ?? 0)} totalDocumentsScanned=${cursor.documentsScanned} newMatches=${newResults.length} totalMatches=${combined.length} countState=${complete ? HISTORY_SEARCH_COUNT_STATES.EXACT : HISTORY_SEARCH_COUNT_STATES.AT_LEAST} matchMs=${Date.now() - matchStart} totalMs=${Date.now() - searchStart}`
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
   */
  private async scanForMatches(
    workspaceFolderPath: string,
    normalizedQuery: string,
    filters: HistorySearchFilters | undefined,
    targetCount: number | undefined,
    alreadyCollectedCount: number,
    resume: HistorySearchScanCursor | undefined,
    signal?: AbortSignal
  ): Promise<{
    newResults: HistorySearchResult[];
    complete: boolean;
    cursor: HistorySearchScanCursor;
    cancelled: boolean;
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
    const seen = resume?.seenDedupeKeys ?? new Set<string>();
    const priorDocumentsScanned = resume?.documentsScanned ?? 0;
    let documentsScannedThisCall = 0;

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
      const shard = shardOrder[index];
      if (
        currentGroupStartedAt !== undefined &&
        shard.startedAt !== currentGroupStartedAt
      ) {
        finalizeGroup();
        if (
          targetCount !== undefined &&
          alreadyCollectedCount + newResults.length >= targetCount
        ) {
          stoppedEarly = true;
          break;
        }
      }
      currentGroupStartedAt = shard.startedAt;

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
        if (
          !document.text.toLowerCase().includes(lowered) ||
          !matchesFilters(document, filters)
        ) {
          continue;
        }
        const result = projectHistorySearchResult(document, normalizedQuery);
        groupBuffer.push({
          result,
          dedupeKey: getHistorySearchDocumentDedupeKey(document, result),
          timestampMs: document.timestampMs,
          sequence: document.sequence,
        });
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
      return { newResults: [], complete: false, cursor, cancelled: true };
    }
    if (!stoppedEarly) {
      // Reached the true end of the index: the trailing group (the only one
      // never followed by a "next shard" transition to finalize it) still
      // needs to be folded in.
      finalizeGroup();
    }
    return { newResults, complete: !stoppedEarly, cursor, cancelled: false };
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
        this.dropLoadedIndex();
        await this.loadIfPossible(workspaceFolderPath);
        Log.info(
          "[HistorySearchIndexService] rebuild skipped: on-disk index already fresh"
        );
        return;
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
    filters: HistorySearchFilters | undefined
  ): string {
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          workspaceFolderPath,
          query: query.trim().toLowerCase(),
          filters: normalizeHistorySearchFilters(filters),
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
