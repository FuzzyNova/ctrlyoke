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
import { HISTORY_SEARCH_REBUILD_MESSAGE_TYPES } from "../../types/DashboardConstants";
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
import { streamHistorySearchDocuments } from "./HistorySearchShardScanner";
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
 * The full, deduped, sorted result list for one query, kept so that paging
 * through it costs O(page) instead of re-scanning every indexed document.
 */
interface HistorySearchMatchSnapshot {
  results: HistorySearchResult[];
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
    const snapshotKey = this.getSnapshotKey(
      workspaceFolderPath,
      normalizedQuery,
      request.filters
    );

    const cachedSnapshot = this.getSnapshot(snapshotKey);
    if (cachedSnapshot) {
      // Paging inside a result set the client is already scrolling is
      // answered from the snapshot its first page came from, with no
      // readiness check and no rescan. Both halves matter: the freshness
      // check alone costs a stat per indexed run, and re-deriving matches
      // against a meanwhile-rebuilt index would renumber every offset
      // underneath the client's scroll position.
      if (offset > 0) {
        Log.debug(
          `[HistorySearchIndexService] search page from snapshot: query="${normalizedQuery}" offset=${offset} matches=${cachedSnapshot.results.length} totalMs=${Date.now() - searchStart}`
        );
        return this.buildPageResponse(
          normalizedQuery,
          cachedSnapshot.results,
          offset,
          limit
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
        Log.debug(
          `[HistorySearchIndexService] search page-0 from snapshot (index unchanged): query="${normalizedQuery}" matches=${cachedSnapshot.results.length} totalMs=${Date.now() - searchStart}`
        );
        return this.buildPageResponse(
          normalizedQuery,
          cachedSnapshot.results,
          offset,
          limit
        );
      }
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
    const { results, documentsScanned, cancelled } = await this.collectMatches(
      workspaceFolderPath,
      normalizedQuery,
      request.filters,
      signal
    );
    if (cancelled) {
      Log.debug(
        `[HistorySearchIndexService] search cancelled: query="${normalizedQuery}" documentsScanned=${documentsScanned} elapsedMs=${Date.now() - searchStart}`
      );
      throw new HistorySearchCancelledError();
    }
    if (results.length <= MAX_SNAPSHOT_RESULTS) {
      this.rememberSnapshot(snapshotKey, results);
    } else {
      Log.info(
        `[HistorySearchIndexService] match snapshot not retained: query="${normalizedQuery}" matches=${results.length} exceeds ${MAX_SNAPSHOT_RESULTS}`
      );
    }

    Log.info(
      `[HistorySearchIndexService] search complete: query="${normalizedQuery}" documentsScanned=${documentsScanned} matches=${results.length} readyMs=${readyDurationMs} matchMs=${Date.now() - matchStart} totalMs=${Date.now() - searchStart} indexState=${this.rebuildPromise ? "building" : "ready"}`
    );

    return this.buildPageResponse(normalizedQuery, results, offset, limit);
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
   * Caches a query's full result list, evicting the oldest entries first if
   * the new total would exceed `MAX_SNAPSHOT_CACHE_TOTAL_RESULTS`. Always
   * keeps at least the entry just inserted, even if it alone is over budget.
   */
  private rememberSnapshot(key: string, results: HistorySearchResult[]): void {
    const existing = this.matchSnapshots.get(key);
    if (existing) {
      this.matchSnapshotResultTotal -= existing.results.length;
      this.matchSnapshots.delete(key);
    }
    this.matchSnapshots.set(key, { results });
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
   * Filters, sorts, projects, and dedupes every indexed document into the
   * complete result list for one query. Deliberately not paged: the dedupe key
   * is derived from the projected result, so the deduped ordinal of a row can
   * only be known by walking the whole match set — doing that per page is what
   * made a scroll to the end of a large result set O(pages x index size).
   */
  private async collectMatches(
    workspaceFolderPath: string,
    normalizedQuery: string,
    filters: HistorySearchFilters | undefined,
    signal?: AbortSignal
  ): Promise<{
    results: HistorySearchResult[];
    documentsScanned: number;
    cancelled: boolean;
  }> {
    const lowered = normalizedQuery.toLowerCase();
    const documentMatches: ProjectedHistorySearchMatch[] = [];
    let documentsScanned = 0;
    for await (const document of streamHistorySearchDocuments(
      this.getDocumentsDir(workspaceFolderPath),
      normalizedQuery,
      // `loadedManifest` is set only after a manifest at the current schema
      // was read, so an absent one means the shards on disk may predate the
      // serialized lowercase key the fast prefilter matches against.
      {
        hasPersistedLowercaseKey:
          this.hasCurrentSchemaIndex(workspaceFolderPath),
      },
      () => {
        documentsScanned += 1;
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
      documentMatches.push({
        result,
        dedupeKey: getHistorySearchDocumentDedupeKey(document, result),
        timestampMs: document.timestampMs,
        sequence: document.sequence,
      });
    }
    // The generator returns early (without throwing) on cancellation, so a
    // partial scan looks like a legitimate — if incomplete — result unless
    // checked for here. Report it rather than sorting/dedupe-ing a partial
    // match set into something that looks like a real answer.
    if (signal?.aborted) {
      return { results: [], documentsScanned, cancelled: true };
    }
    documentMatches.sort(this.compareMatches);

    const seen = new Set<string>();
    const results: HistorySearchResult[] = [];
    for (const match of documentMatches) {
      if (seen.has(match.dedupeKey)) {
        continue;
      }
      seen.add(match.dedupeKey);
      results.push(match.result);
    }
    return { results, documentsScanned, cancelled: false };
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
    limit: number
  ): HistorySearchResponse {
    const page = results.slice(offset, offset + limit);
    return {
      query: normalizedQuery,
      offset,
      results: page,
      totalCount: results.length,
      hasMore: offset + page.length < results.length,
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

  private compareMatches(
    left: ProjectedHistorySearchMatch,
    right: ProjectedHistorySearchMatch
  ): number {
    return (
      right.result.startedAt - left.result.startedAt ||
      right.timestampMs - left.timestampMs ||
      right.sequence - left.sequence
    );
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
      hasMore: false,
      indexState,
    };
  }
}
