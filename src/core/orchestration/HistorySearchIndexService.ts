import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
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
  type HistorySearchIndexManifest,
  type HistorySearchRebuildWorkerData,
  type HistorySearchRebuildWorkerMessage,
} from "./historySearchRebuildWorker";
export { MAX_INDEXED_TEXT_LENGTH } from "./historySearchRebuildWorker";
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 50;

interface CursorPayload {
  offset: number;
  queryHash: string;
  sortVersion: string;
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
  private documents: HistorySearchDocument[] = [];
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
    const buildInProgress = Boolean(this.rebuildPromise);
    Log.debug(
      `[HistorySearchIndexService] search start: query="${normalizedQuery}" buildInProgress=${buildInProgress}`
    );
    if (!buildInProgress) {
      await this.ensureReady(workspaceFolderPath, onRebuildProgress);
    } else {
      await this.loadIfPossible(workspaceFolderPath);
    }
    const readyDurationMs = Date.now() - searchStart;

    const offset = this.decodeCursorOffset(
      request.cursor,
      normalizedQuery,
      request.filters
    );
    const limit = Math.max(1, request.limit || DEFAULT_LIMIT);
    const lowered = normalizedQuery.toLowerCase();

    const documentMatches = this.documents
      .filter(
        (document) =>
          document.text.toLowerCase().includes(lowered) &&
          matchesFilters(document, request.filters)
      )
      .sort(this.compareDocuments);

    const seen = new Set<string>();
    const page: HistorySearchResult[] = [];
    let totalCount = 0;
    for (const document of documentMatches) {
      const result = projectHistorySearchResult(document, normalizedQuery);
      const dedupeKey = getHistorySearchDocumentDedupeKey(document, result);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      if (totalCount >= offset && page.length < limit) {
        page.push(result);
      }
      totalCount += 1;
    }

    const nextOffset = offset + page.length;
    const hasMore = nextOffset < totalCount;
    const indexState = this.rebuildPromise ? "building" : "ready";

    Log.info(
      `[HistorySearchIndexService] search complete: query="${normalizedQuery}" documentsScanned=${this.documents.length} documentMatches=${documentMatches.length} matches=${totalCount} readyMs=${readyDurationMs} totalMs=${Date.now() - searchStart} indexState=${indexState}`
    );

    return {
      query: normalizedQuery,
      results: page,
      totalCount,
      nextCursor: hasMore
        ? this.encodeCursor({
            offset: nextOffset,
            queryHash: this.hashQuery(normalizedQuery, request.filters),
            sortVersion: "startedAt-timestamp-sequence-desc",
          })
        : undefined,
      hasMore,
      indexState,
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

    const manifestPath = this.getIndexManifestPath(workspaceFolderPath);
    const documentsDir = this.getDocumentsDir(workspaceFolderPath);
    const loadStart = Date.now();
    try {
      const manifest = JSON.parse(
        await fs.promises.readFile(manifestPath, "utf8")
      ) as HistorySearchIndexManifest;
      if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
        Log.info(
          `[HistorySearchIndexService] on-disk index schema mismatch (found ${manifest.schemaVersion}, expected ${INDEX_SCHEMA_VERSION}); will rebuild`
        );
        return;
      }
      const documents = await this.readDocumentsJsonl(documentsDir);
      this.loadedWorkspacePath = workspaceFolderPath;
      this.loadedManifest = manifest;
      this.documents = documents;
      Log.debug(
        `[HistorySearchIndexService] loaded index from disk: documents=${documents.length} indexedRuns=${Object.keys(manifest.indexedRuns).length} durationMs=${Date.now() - loadStart}`
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
      this.loadedWorkspacePath = undefined;
      this.loadedManifest = undefined;
      this.documents = [];
    }
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

      if (options.retainDocuments) {
        this.loadedWorkspacePath = undefined;
        this.loadedManifest = undefined;
        this.documents = [];
        await this.loadIfPossible(workspaceFolderPath);
        if (result.skipped) {
          Log.info(
            `[HistorySearchIndexService] rebuild skipped: on-disk index already fresh (documents=${this.documents.length})`
          );
        }
      } else {
        // Write-only refresh: drop any in-memory index so refresh-only
        // instances don't retain a full copy. A later search reloads from disk.
        this.loadedWorkspacePath = undefined;
        this.loadedManifest = undefined;
        this.documents = [];
        if (result.skipped) {
          Log.info(
            "[HistorySearchIndexService] rebuild skipped: on-disk index already fresh"
          );
        }
      }
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
  ): Promise<Extract<HistorySearchRebuildWorkerMessage, { type: "success" }>> {
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
        if (message.type === "progress") {
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
        } else if (message.type === "success") {
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

  private async readDocumentsJsonl(
    documentsDir: string
  ): Promise<HistorySearchDocument[]> {
    const documents: HistorySearchDocument[] = [];
    const shardEntries = await fs.promises.readdir(documentsDir, {
      withFileTypes: true,
    });
    const shardFiles = shardEntries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(DOCUMENTS_SHARD_EXTENSION)
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    if (shardFiles.length === 0) {
      const error = new Error(`No document shards found in ${documentsDir}`);
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    }

    for (const shardFile of shardFiles) {
      const reader = readline.createInterface({
        input: fs.createReadStream(path.join(documentsDir, shardFile.name), {
          encoding: "utf8",
        }),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of reader) {
          if (line.trim().length > 0) {
            documents.push(JSON.parse(line) as HistorySearchDocument);
          }
        }
      } finally {
        reader.close();
      }
    }
    return documents;
  }

  private decodeCursorOffset(
    cursor: string | undefined,
    query: string,
    filters: HistorySearchFilters | undefined
  ): number {
    if (!cursor) {
      return 0;
    }
    try {
      const payload = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8")
      ) as CursorPayload;
      return payload.queryHash === this.hashQuery(query, filters)
        ? Math.max(0, payload.offset)
        : 0;
    } catch {
      return 0;
    }
  }

  private encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  private hashQuery(
    query: string,
    filters: HistorySearchFilters | undefined
  ): string {
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
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
      results: [],
      totalCount: 0,
      hasMore: false,
      indexState,
    };
  }
}
