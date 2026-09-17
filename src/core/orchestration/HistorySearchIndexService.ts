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
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { Log } from "../../utils/Log";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { getFrozenRunHistoryLocation } from "../../utils/RunHistoryStoragePolicy";
import { streamFileLines } from "../../utils/TextLines";
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
  DOCUMENTS_SHARD_EXTENSION,
  INDEX_SCHEMA_VERSION,
  MANIFEST_FILE_NAME,
  REBUILD_WORKER_MAX_OLD_GENERATION_MB,
  type HistorySearchIncrementalShardDelta,
  type HistorySearchIndexManifest,
  type HistorySearchRebuildWorkerData,
  type HistorySearchRebuildWorkerMessage,
} from "./historySearchRebuildWorker";
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
 * The full, deduped, sorted result list for one query, kept so that paging
 * through it costs O(page) instead of re-scanning every indexed document.
 */
interface HistorySearchMatchSnapshot {
  key: string;
  results: HistorySearchResult[];
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
  /**
   * Loaded documents keyed by the shard file they came from. Sharding is
   * per-run, so an incremental rebuild can replace just the runs it rewrote
   * instead of forcing a re-read of the whole index (see
   * `applyIncrementalShardDelta`).
   */
  private shardDocuments = new Map<string, HistorySearchDocument[]>();
  private documentCount = 0;
  private matchSnapshot?: HistorySearchMatchSnapshot;
  private rebuildPromise?: Promise<void>;
  private rebuildQueued = false;

  async search(
    request: HistorySearchQuery,
    workspaceFolderPath: string,
    onRebuildProgress?: IndexRebuildProgressCallback
  ): Promise<HistorySearchResponse> {
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

    // Paging inside a result set the client is already scrolling is answered
    // from the snapshot its first page came from, with no readiness check and
    // no rescan. Both halves matter: the freshness check alone costs a stat
    // per indexed run, and re-deriving matches against a meanwhile-rebuilt
    // index would renumber every offset underneath the client's scroll
    // position. A new query (offset 0) always re-derives.
    const snapshot =
      offset > 0 && this.matchSnapshot?.key === snapshotKey
        ? this.matchSnapshot
        : undefined;
    if (snapshot) {
      Log.debug(
        `[HistorySearchIndexService] search page from snapshot: query="${normalizedQuery}" offset=${offset} matches=${snapshot.results.length} totalMs=${Date.now() - searchStart}`
      );
      return this.buildPageResponse(
        normalizedQuery,
        snapshot.results,
        offset,
        limit
      );
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
    const readyDurationMs = Date.now() - searchStart;

    const matchStart = Date.now();
    const results = this.collectMatches(normalizedQuery, request.filters);
    this.matchSnapshot =
      results.length <= MAX_SNAPSHOT_RESULTS
        ? { key: snapshotKey, results }
        : undefined;
    if (!this.matchSnapshot) {
      Log.info(
        `[HistorySearchIndexService] match snapshot not retained: query="${normalizedQuery}" matches=${results.length} exceeds ${MAX_SNAPSHOT_RESULTS}`
      );
    }

    Log.info(
      `[HistorySearchIndexService] search complete: query="${normalizedQuery}" documentsScanned=${this.documentCount} matches=${results.length} readyMs=${readyDurationMs} matchMs=${Date.now() - matchStart} totalMs=${Date.now() - searchStart} indexState=${this.rebuildPromise ? "building" : "ready"}`
    );

    return this.buildPageResponse(normalizedQuery, results, offset, limit);
  }

  /**
   * Filters, sorts, projects, and dedupes every indexed document into the
   * complete result list for one query. Deliberately not paged: the dedupe key
   * is derived from the projected result, so the deduped ordinal of a row can
   * only be known by walking the whole match set — doing that per page is what
   * made a scroll to the end of a large result set O(pages x index size).
   */
  private collectMatches(
    normalizedQuery: string,
    filters: HistorySearchFilters | undefined
  ): HistorySearchResult[] {
    const lowered = normalizedQuery.toLowerCase();
    const documentMatches: HistorySearchDocument[] = [];
    for (const documents of this.shardDocuments.values()) {
      for (const document of documents) {
        if (
          document.text.toLowerCase().includes(lowered) &&
          matchesFilters(document, filters)
        ) {
          documentMatches.push(document);
        }
      }
    }
    documentMatches.sort(this.compareDocuments);

    const seen = new Set<string>();
    const results: HistorySearchResult[] = [];
    for (const document of documentMatches) {
      const result = projectHistorySearchResult(document, normalizedQuery);
      const dedupeKey = getHistorySearchDocumentDedupeKey(document, result);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      results.push(result);
    }
    return results;
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
          await this.rebuild(workspaceFolderPath, { retainDocuments: false });
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
    await this.rebuild(workspaceFolderPath, {
      retainDocuments: true,
      onProgress: onRebuildProgress,
    });
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

    const documentsDir = this.getDocumentsDir(workspaceFolderPath);
    const loadStart = Date.now();
    try {
      const manifest = await this.readIndexManifest(workspaceFolderPath);
      if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
        Log.info(
          `[HistorySearchIndexService] on-disk index schema mismatch (found ${manifest.schemaVersion}, expected ${INDEX_SCHEMA_VERSION}); will rebuild`
        );
        return;
      }
      const shardDocuments = await this.readDocumentShards(documentsDir);
      this.loadedWorkspacePath = workspaceFolderPath;
      this.loadedManifest = manifest;
      this.setShardDocuments(shardDocuments);
      Log.debug(
        `[HistorySearchIndexService] loaded index from disk: documents=${this.documentCount} shards=${shardDocuments.size} indexedRuns=${Object.keys(manifest.indexedRuns).length} durationMs=${Date.now() - loadStart}`
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

  /**
   * Replaces only the runs an incremental rebuild rewrote or deleted. The
   * alternative — dropping everything and calling `loadIfPossible()` — re-reads
   * and re-parses every shard in the index, which on a large history costs
   * seconds and is what made a single appended run turn a millisecond rebuild
   * into a multi-second search.
   */
  private async applyIncrementalShardDelta(
    workspaceFolderPath: string,
    delta: HistorySearchIncrementalShardDelta
  ): Promise<boolean> {
    const documentsDir = this.getDocumentsDir(workspaceFolderPath);
    const spliceStart = Date.now();
    try {
      const manifest = await this.readIndexManifest(workspaceFolderPath);
      if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
        return false;
      }
      for (const shardName of delta.removedShardNames) {
        this.removeShard(shardName);
      }
      for (const shardName of delta.rewrittenShardNames) {
        this.removeShard(shardName);
        const documents = await this.readDocumentShard(
          path.join(documentsDir, shardName)
        );
        if (documents.length > 0) {
          this.shardDocuments.set(shardName, documents);
          this.documentCount += documents.length;
        }
      }
      this.loadedWorkspacePath = workspaceFolderPath;
      this.loadedManifest = manifest;
      this.matchSnapshot = undefined;
      Log.debug(
        `[HistorySearchIndexService] spliced incremental index update: rewrittenShards=${delta.rewrittenShardNames.length} removedShards=${delta.removedShardNames.length} documents=${this.documentCount} durationMs=${Date.now() - spliceStart}`
      );
      return true;
    } catch (error) {
      Log.warn(
        `[HistorySearchIndexService] Failed to splice incremental index update; falling back to a full reload: ${getErrorMessage(error)}`
      );
      return false;
    }
  }

  private removeShard(shardName: string): void {
    const existing = this.shardDocuments.get(shardName);
    if (!existing) {
      return;
    }
    this.documentCount -= existing.length;
    this.shardDocuments.delete(shardName);
  }

  private setShardDocuments(
    shardDocuments: Map<string, HistorySearchDocument[]>
  ): void {
    this.shardDocuments = shardDocuments;
    this.documentCount = 0;
    for (const documents of shardDocuments.values()) {
      this.documentCount += documents.length;
    }
    this.matchSnapshot = undefined;
  }

  private dropLoadedIndex(): void {
    this.loadedWorkspacePath = undefined;
    this.loadedManifest = undefined;
    this.shardDocuments = new Map();
    this.documentCount = 0;
    this.matchSnapshot = undefined;
  }

  /**
   * Rebuilds the on-disk index from history.
   *
   * `retainDocuments` controls steady-state memory: the search path keeps the
   * built documents resident for fast querying, while the refresh path (used by
   * every `OutputHistoryManager`, one per live workflow) streams straight to
   * disk and retains nothing — otherwise each write-only instance would hold a
   * full copy of the index in the extension-host heap. Documents are also
   * streamed per-run rather than accumulated, so a refresh never materializes
   * the whole index in memory at once.
   */
  private async rebuild(
    workspaceFolderPath: string,
    options: {
      retainDocuments: boolean;
      onProgress?: IndexRebuildProgressCallback;
    }
  ): Promise<void> {
    const indexDir = this.getIndexDir(workspaceFolderPath);
    await fs.promises.mkdir(indexDir, { recursive: true });

    const data: HistorySearchRebuildWorkerData = {
      workspaceFolderPath,
      runHistoryLocation: getFrozenRunHistoryLocation(),
      retainDocuments: options.retainDocuments,
      logFilePath: Log.getLogFilePath(),
    };
    const worker = new Worker(this.getWorkerScriptPath(), {
      workerData: data,
      resourceLimits: {
        maxOldGenerationSizeMb: REBUILD_WORKER_MAX_OLD_GENERATION_MB,
      },
    });
    try {
      const result = await this.waitForWorker(worker, data, options.onProgress);
      if (result.freshnessReason) {
        Log.debug(
          `[HistorySearchIndexService] freshness check stale: ${result.freshnessReason}`
        );
      }

      if (!options.retainDocuments) {
        // Write-only refresh: drop any in-memory index so refresh-only
        // instances don't retain a full copy. A later search reloads from disk.
        this.dropLoadedIndex();
        if (result.skipped) {
          Log.info(
            "[HistorySearchIndexService] rebuild skipped: on-disk index already fresh"
          );
        }
        return;
      }

      const loadedForWorkspace =
        this.loadedWorkspacePath === workspaceFolderPath && this.loadedManifest;

      if (result.skipped) {
        // Nothing on disk changed, so whatever is already resident is still
        // correct. Only a reader holding nothing needs to read.
        await this.loadIfPossible(workspaceFolderPath);
        Log.info(
          `[HistorySearchIndexService] rebuild skipped: on-disk index already fresh (documents=${this.documentCount})`
        );
        return;
      }

      if (
        result.incrementalDelta &&
        loadedForWorkspace &&
        (await this.applyIncrementalShardDelta(
          workspaceFolderPath,
          result.incrementalDelta
        ))
      ) {
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
    data: HistorySearchRebuildWorkerData,
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
              `[HistorySearchIndexService] rebuild starting: runs=${message.totalRuns} retainDocuments=${data.retainDocuments} worker=true`
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

  private compareDocuments(
    left: HistorySearchDocument,
    right: HistorySearchDocument
  ): number {
    return (
      right.startedAt - left.startedAt ||
      right.timestampMs - left.timestampMs ||
      right.sequence - left.sequence
    );
  }

  private async readDocumentShards(
    documentsDir: string
  ): Promise<Map<string, HistorySearchDocument[]>> {
    const shardEntries = await fs.promises.readdir(documentsDir, {
      withFileTypes: true,
    });
    const shardFiles = shardEntries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(DOCUMENTS_SHARD_EXTENSION)
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    const shardDocuments = new Map<string, HistorySearchDocument[]>();
    for (const shardFile of shardFiles) {
      const documents = await this.readDocumentShard(
        path.join(documentsDir, shardFile.name)
      );
      if (documents.length > 0) {
        shardDocuments.set(shardFile.name, documents);
      }
    }
    return shardDocuments;
  }

  private async readDocumentShard(
    shardPath: string
  ): Promise<HistorySearchDocument[]> {
    const documents: HistorySearchDocument[] = [];
    try {
      for await (const line of streamFileLines(shardPath)) {
        if (line.trim().length > 0) {
          documents.push(JSON.parse(line) as HistorySearchDocument);
        }
      }
    } catch (error) {
      // A shard that vanished or was replaced mid-read leaves the rest of the
      // index usable; the next freshness check reindexes that run.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return documents;
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
