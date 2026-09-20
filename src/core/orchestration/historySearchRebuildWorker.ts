import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { once } from "events";
import { isMainThread, parentPort, workerData } from "worker_threads";
import type { RunHistoryLocation } from "../../types/CtrlYokeSettings";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { HISTORY_SEARCH_REBUILD_MESSAGE_TYPES } from "../../types/DashboardConstants";
import {
  type HistorySearchDocument,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { withFileLock } from "../../utils/FileLockUtils";
import { Log } from "../../utils/Log";
import { logMemoryUsage } from "../../utils/MemoryDiagnostics";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { initializeRunHistoryLocation } from "../../utils/RunHistoryStoragePolicy";
import {
  renameWithTransientRetry,
  writeFileAtomic,
} from "../../utils/AtomicFileUtils";
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { HistoryRunDocumentBuilder } from "./HistoryRunDocumentBuilder";

export const INDEX_SCHEMA_VERSION = "4.2.0" as const;
export const MANIFEST_FILE_NAME = "manifest.json";
export const DOCUMENTS_DIR_NAME = "documents";
export const DOCUMENTS_SHARD_EXTENSION = ".jsonl";
const LEGACY_DOCUMENTS_FILE_NAME = "documents.jsonl";
export const MAX_INDEXED_TEXT_LENGTH = 2000;
/**
 * V8 old-generation heap cap for the rebuild worker's isolate, passed as
 * `resourceLimits.maxOldGenerationSizeMb` when the worker is spawned. Without
 * this, a worker hitting V8's default heap ceiling triggers V8's own fatal
 * OOM handler, which aborts the whole process (worker threads share the OS
 * process with the main thread) — not just the worker. Setting this makes
 * Node intercept the near-limit condition instead and emit a catchable
 * `'error'` on the `Worker` object, so an oversized rebuild fails just that
 * rebuild instead of crashing the extension host. Sized well above the
 * ~430MB steady-state heap observed for a full rebuild of this workspace's
 * history (see HISTORY_SEARCH_PERFORMANCE_PLAN.md), with headroom for
 * larger histories.
 */
export const REBUILD_WORKER_MAX_OLD_GENERATION_MB = 2048;
const REBUILD_LOCK_TIMEOUT_MS = 60_000;
const PROGRESS_LOG_INTERVAL = 200;
const PROGRESS_EMIT_INTERVAL_MS = 150;
const FRESHNESS_CHECK_CONCURRENCY = 16;
export const INCREMENTAL_REBUILD_MAX_CHANGED_RATIO = 0.5;
const timelineRecorder = new TimelineRecorder();
const lineageRepository = new WorkflowLineageRepository();
const runDocumentBuilder = new HistoryRunDocumentBuilder(
  MAX_INDEXED_TEXT_LENGTH
);

export interface HistorySearchIndexManifest {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  builtAt: number;
  workspaceRootHash: string;
  historyRootMtimeMs?: number;
  indexedRuns: Record<
    string,
    {
      manifestPath: string;
      eventsPath: string;
      workflowId: string;
      runId: number;
      startedAt: number;
      eventCount: number;
      lastUpdatedAt: number;
      sourceManifestMtimeMs: number;
      sourceEventsMtimeMs: number;
      overCapCandidateCount?: number;
    }
  >;
}

interface WorkflowMetadata {
  workflowName: string;
}

export interface WorkflowRunSource {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  manifestPath: string;
  eventsPath: string;
}

export interface HistorySearchIndexStaleRun {
  source: WorkflowRunSource;
  reason: string;
}

export interface HistorySearchIndexDiff {
  newRuns: WorkflowRunSource[];
  changedRuns: WorkflowRunSource[];
  removedManifestPaths: string[];
  unchangedManifestPaths: string[];
  staleRuns: HistorySearchIndexStaleRun[];
}

export interface HistorySearchRebuildProgressMessage {
  type: typeof HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.PROGRESS;
  processedRuns: number;
  totalRuns: number;
}

export interface HistorySearchRebuildSuccessMessage {
  type: typeof HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.SUCCESS;
  skipped: boolean;
  freshnessReason?: string;
  /**
   * True when every shard was regenerated (schema-version bump, no prior
   * on-disk index, or the changed-ratio fallback to a full rebuild) — the
   * host should drop its entire `HistorySearchDocumentCache` rather than try
   * to reconcile individual entries. Never set when `skipped` is true, since
   * a skipped rebuild changed nothing on disk.
   */
  fullRebuild?: boolean;
  /**
   * Exactly the shard file names an *incremental* rebuild rewrote or removed
   * (derived from `HistorySearchIndexDiff.newRuns`/`changedRuns`/
   * `removedManifestPaths`), so the host can evict exactly those runs from
   * `HistorySearchDocumentCache` instead of dropping the whole cache. Present
   * only for a non-skipped incremental rebuild.
   */
  invalidatedShardNames?: string[];
}

export interface HistorySearchRebuildErrorMessage {
  type: typeof HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.ERROR;
  message: string;
  stack?: string;
}

export type HistorySearchRebuildWorkerMessage =
  | HistorySearchRebuildProgressMessage
  | HistorySearchRebuildSuccessMessage
  | HistorySearchRebuildErrorMessage;

export interface HistorySearchFreshnessResult {
  fresh: boolean;
  reason?: string;
}

export interface HistorySearchRebuildWorkerData {
  workspaceFolderPath: string;
  runHistoryLocation: RunHistoryLocation;
  logFilePath?: string;
}

export type HistorySearchRebuildProgressCallback = (
  processedRuns: number,
  totalRuns: number
) => void;

/**
 * Compare the current run history with the runs recorded in an index manifest.
 * The result retains every run's state so later rebuild steps can act on the
 * complete delta instead of only the first stale run.
 */
export async function computeHistorySearchIndexDiff(
  workspaceFolderPath: string,
  manifest: HistorySearchIndexManifest
): Promise<HistorySearchIndexDiff> {
  const currentRuns = await listRunSources(workspaceFolderPath);
  const currentManifestPaths = new Set(
    currentRuns.map((run) => path.resolve(run.manifestPath))
  );
  const indexedManifestPaths = new Set(Object.keys(manifest.indexedRuns));
  const removedManifestPaths = [...indexedManifestPaths].filter(
    (manifestPath) => !currentManifestPaths.has(manifestPath)
  );

  const checkResults = await mapWithConcurrency(
    currentRuns,
    FRESHNESS_CHECK_CONCURRENCY,
    async (
      source
    ): Promise<
      | { kind: "new"; source: WorkflowRunSource; reason: string }
      | { kind: "changed"; source: WorkflowRunSource; reason: string }
      | { kind: "unchanged"; source: WorkflowRunSource }
    > => {
      const key = path.resolve(source.manifestPath);
      const indexedRun = manifest.indexedRuns[key];
      if (!indexedRun) {
        return {
          kind: "new",
          source,
          reason: `new run not yet indexed (${source.workflowKey}/${source.runRef})`,
        };
      }

      const sourceManifest = await readManifestSafe(source.manifestPath);
      if (!sourceManifest) {
        return {
          kind: "changed",
          source,
          reason: `could not re-read manifest for ${source.workflowKey}/${source.runRef}`,
        };
      }

      const [manifestStats, eventsStats] = await Promise.all([
        statOptional(source.manifestPath),
        statOptional(source.eventsPath),
      ]);
      if (
        sourceManifest.eventCount !== indexedRun.eventCount ||
        sourceManifest.lastUpdatedAt !== indexedRun.lastUpdatedAt ||
        manifestStats?.mtimeMs !== indexedRun.sourceManifestMtimeMs ||
        (eventsStats?.mtimeMs ?? 0) !== indexedRun.sourceEventsMtimeMs
      ) {
        return {
          kind: "changed",
          source,
          reason: `run changed since indexing (${source.workflowKey}/${source.runRef})`,
        };
      }

      return { kind: "unchanged", source };
    }
  );

  const newRuns: WorkflowRunSource[] = [];
  const changedRuns: WorkflowRunSource[] = [];
  const unchangedManifestPaths: string[] = [];
  const staleRuns: HistorySearchIndexStaleRun[] = [];

  for (const result of checkResults) {
    const key = path.resolve(result.source.manifestPath);
    if (result.kind === "new") {
      newRuns.push(result.source);
      staleRuns.push({ source: result.source, reason: result.reason });
    } else if (result.kind === "changed") {
      changedRuns.push(result.source);
      staleRuns.push({ source: result.source, reason: result.reason });
    } else {
      unchangedManifestPaths.push(key);
    }
  }

  return {
    newRuns,
    changedRuns,
    removedManifestPaths,
    unchangedManifestPaths,
    staleRuns,
  };
}

/**
 * Check whether the on-disk index still describes the current run history.
 * This is shared by the host's preflight check and the worker's lock-scoped
 * recheck, so the latter preserves Phase 1A's contention behavior.
 */
export async function checkHistorySearchIndexFreshness(
  workspaceFolderPath: string,
  manifest: HistorySearchIndexManifest
): Promise<HistorySearchFreshnessResult> {
  const compatibilityReason = getIndexCompatibilityReason(
    workspaceFolderPath,
    manifest
  );
  if (compatibilityReason) {
    return {
      fresh: false,
      reason: compatibilityReason,
    };
  }

  const diff = await computeHistorySearchIndexDiff(
    workspaceFolderPath,
    manifest
  );
  return getFreshnessFromDiff(manifest, diff);
}

function getIndexCompatibilityReason(
  workspaceFolderPath: string,
  manifest: HistorySearchIndexManifest
): string | undefined {
  return manifest.schemaVersion !== INDEX_SCHEMA_VERSION ||
    manifest.workspaceRootHash !== hashPath(workspaceFolderPath)
    ? "schema/workspace hash mismatch"
    : undefined;
}

function getFreshnessFromDiff(
  manifest: HistorySearchIndexManifest,
  diff: HistorySearchIndexDiff
): HistorySearchFreshnessResult {
  const currentRunCount =
    diff.newRuns.length +
    diff.changedRuns.length +
    diff.unchangedManifestPaths.length;
  const indexedRunCount = Object.keys(manifest.indexedRuns).length;
  if (currentRunCount !== indexedRunCount) {
    return {
      fresh: false,
      reason: `run count changed (current=${currentRunCount} indexed=${indexedRunCount})`,
    };
  }

  const stale = diff.staleRuns[0];
  return stale ? { fresh: false, reason: stale.reason } : { fresh: true };
}

/** Execute one complete, lock-protected rebuild in the worker isolate. */
export async function runHistorySearchRebuild(
  data: HistorySearchRebuildWorkerData,
  onProgress?: HistorySearchRebuildProgressCallback
): Promise<HistorySearchRebuildSuccessMessage> {
  const indexDir = getIndexDir(
    data.workspaceFolderPath,
    data.runHistoryLocation
  );
  await fs.promises.mkdir(indexDir, { recursive: true });

  const lockTargetPath = getIndexManifestPath(
    data.workspaceFolderPath,
    data.runHistoryLocation
  );
  let freshnessReason: string | undefined;
  let skipped = false;
  let fullRebuild = false;
  let invalidatedShardNames: string[] | undefined;
  await withFileLock(
    lockTargetPath,
    async () => {
      const builtAt = Date.now();
      const manifestPath = getIndexManifestPath(
        data.workspaceFolderPath,
        data.runHistoryLocation
      );
      let onDiskManifest: HistorySearchIndexManifest | undefined;
      let fullRebuildFallbackReason = "no on-disk manifest";
      try {
        const manifest = JSON.parse(
          await fs.promises.readFile(manifestPath, "utf8")
        ) as HistorySearchIndexManifest;
        if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
          fullRebuildFallbackReason = "schema version mismatch";
          Log.info(
            `[HistorySearchIndexService] on-disk index schema mismatch (found ${manifest.schemaVersion}, expected ${INDEX_SCHEMA_VERSION}); will rebuild`
          );
        } else {
          onDiskManifest = manifest;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          fullRebuildFallbackReason = "manifest load failure";
          Log.warn(
            `[HistorySearchIndexService] Failed to load search index: ${getErrorMessage(error)}`
          );
        } else {
          Log.debug(
            "[HistorySearchIndexService] no on-disk index found; will rebuild"
          );
        }
      }

      let diff: HistorySearchIndexDiff | undefined;
      if (onDiskManifest) {
        fullRebuildFallbackReason = "schema/workspace hash mismatch";
        const compatibilityReason = getIndexCompatibilityReason(
          data.workspaceFolderPath,
          onDiskManifest
        );
        const freshness = compatibilityReason
          ? { fresh: false, reason: compatibilityReason }
          : getFreshnessFromDiff(
              onDiskManifest,
              (diff = await computeHistorySearchIndexDiff(
                data.workspaceFolderPath,
                onDiskManifest
              ))
            );
        if (freshness.fresh) {
          skipped = true;
          Log.info(
            "[HistorySearchIndexService] rebuild skipped: on-disk index already fresh"
          );
          return;
        }
        freshnessReason = freshness.reason;
        fullRebuildFallbackReason =
          freshness.reason ?? fullRebuildFallbackReason;
        Log.debug(
          `[HistorySearchIndexService] freshness check stale: ${freshness.reason}`
        );
      }

      if (onDiskManifest && diff) {
        const currentRunCount =
          diff.newRuns.length +
          diff.changedRuns.length +
          diff.unchangedManifestPaths.length;
        const changedRunCount =
          diff.newRuns.length +
          diff.changedRuns.length +
          diff.removedManifestPaths.length;
        const changedRatio =
          currentRunCount === 0
            ? changedRunCount === 0
              ? 0
              : Infinity
            : changedRunCount / currentRunCount;

        if (changedRatio <= INCREMENTAL_REBUILD_MAX_CHANGED_RATIO) {
          Log.info(
            `[HistorySearchIndexService] rebuild path: incremental newRuns=${diff.newRuns.length} changedRuns=${diff.changedRuns.length} removedRuns=${diff.removedManifestPaths.length} unchangedRuns=${diff.unchangedManifestPaths.length}`
          );
          await runIncrementalHistorySearchRebuild(
            data,
            indexDir,
            manifestPath,
            onDiskManifest,
            diff,
            builtAt,
            onProgress
          );
          invalidatedShardNames = [
            ...diff.newRuns.map((source) =>
              getDocumentsShardFileName(source.manifestPath)
            ),
            ...diff.changedRuns.map((source) =>
              getDocumentsShardFileName(source.manifestPath)
            ),
            ...diff.removedManifestPaths.map((removedManifestPath) =>
              getDocumentsShardFileName(removedManifestPath)
            ),
          ];
          return;
        }

        fullRebuildFallbackReason = `changed ratio ${changedRatio} exceeds ${INCREMENTAL_REBUILD_MAX_CHANGED_RATIO}`;
      }

      fullRebuild = true;
      Log.info(
        `[HistorySearchIndexService] rebuild path: full-rebuild-fallback reason=${fullRebuildFallbackReason}`
      );

      const rebuildDir = path.join(indexDir, `rebuild-${builtAt}`);
      await fs.promises.mkdir(rebuildDir, { recursive: true });

      const indexedRuns: HistorySearchIndexManifest["indexedRuns"] = {};
      const listSourcesStart = Date.now();
      const runSources = await listRunSources(data.workspaceFolderPath);
      Log.info(
        `[HistorySearchIndexService] rebuild starting: runs=${runSources.length} listSourcesMs=${Date.now() - listSourcesStart}`
      );
      logMemoryUsage("HistorySearchIndexService rebuild starting", {
        runs: runSources.length,
      });

      const documentsDir = path.join(rebuildDir, DOCUMENTS_DIR_NAME);
      await fs.promises.mkdir(documentsDir, { recursive: true });
      const rebuildManifestPath = path.join(rebuildDir, MANIFEST_FILE_NAME);
      let documentCount = 0;
      let processedRuns = 0;
      let lastProgressEmitAt = 0;
      onProgress?.(0, runSources.length);
      const metadataCache = new Map<WorkflowKey, WorkflowMetadata>();
      for (const source of runSources) {
        const manifest = await readManifestSafe(source.manifestPath);
        if (!manifest) {
          continue;
        }
        let metadata = metadataCache.get(source.workflowKey);
        if (!metadata) {
          metadata = await readWorkflowMetadata(
            data.workspaceFolderPath,
            source.workflowKey
          );
          metadataCache.set(source.workflowKey, metadata);
        }

        const { documents, overCapCandidateCount } =
          await buildRunDocumentsForSource(
            manifest,
            source.manifestPath,
            metadata,
            source.workflowKey,
            source.runRef
          );
        await writeDocumentsShard(
          getDocumentsShardPath(rebuildDir, source.manifestPath),
          documents
        );
        documentCount += documents.length;

        indexedRuns[path.resolve(source.manifestPath)] =
          await buildIndexedRunEntry(source, manifest, overCapCandidateCount);

        processedRuns += 1;
        if (processedRuns % PROGRESS_LOG_INTERVAL === 0) {
          Log.debug(
            `[HistorySearchIndexService] rebuild progress: ${processedRuns}/${runSources.length} runs, ${documentCount} documents so far, elapsedMs=${Date.now() - listSourcesStart}`
          );
        }
        const now = Date.now();
        if (now - lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS) {
          lastProgressEmitAt = now;
          onProgress?.(processedRuns, runSources.length);
        }
      }

      const indexManifest: HistorySearchIndexManifest = {
        schemaVersion: INDEX_SCHEMA_VERSION,
        builtAt,
        workspaceRootHash: hashPath(data.workspaceFolderPath),
        historyRootMtimeMs: (
          await statOptional(WorkflowPaths.runsRoot(data.workspaceFolderPath))
        )?.mtimeMs,
        indexedRuns,
      };

      await fs.promises.writeFile(
        rebuildManifestPath,
        JSON.stringify(indexManifest, null, 2),
        "utf8"
      );

      await swapIndexFiles(indexDir, rebuildManifestPath, documentsDir);
      await cleanupRebuildDirs(indexDir, rebuildDir);
      onProgress?.(processedRuns, runSources.length);
      Log.info(
        `[HistorySearchIndexService] rebuild complete: runs=${processedRuns}/${runSources.length} documents=${documentCount} totalMs=${Date.now() - listSourcesStart}`
      );
      logMemoryUsage("HistorySearchIndexService rebuild complete", {
        runs: processedRuns,
        documents: documentCount,
      });
    },
    { timeoutMs: REBUILD_LOCK_TIMEOUT_MS }
  );

  return {
    type: HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.SUCCESS,
    skipped,
    freshnessReason,
    fullRebuild: skipped ? undefined : fullRebuild,
    invalidatedShardNames,
  };
}

async function runIncrementalHistorySearchRebuild(
  data: HistorySearchRebuildWorkerData,
  indexDir: string,
  manifestPath: string,
  onDiskManifest: HistorySearchIndexManifest,
  diff: HistorySearchIndexDiff,
  builtAt: number,
  onProgress?: HistorySearchRebuildProgressCallback
): Promise<void> {
  const touchedRuns = diff.newRuns.length + diff.changedRuns.length;
  const indexedRuns = { ...onDiskManifest.indexedRuns };
  const metadataCache = new Map<WorkflowKey, WorkflowMetadata>();
  const rebuildStart = Date.now();
  let processedRuns = 0;
  let documentCount = 0;

  onProgress?.(0, touchedRuns);

  for (const source of [...diff.newRuns, ...diff.changedRuns]) {
    const runManifest = await readManifestSafe(source.manifestPath);
    const manifestKey = path.resolve(source.manifestPath);
    const shardPath = getDocumentsShardPath(indexDir, source.manifestPath);
    if (!runManifest) {
      await fs.promises.rm(shardPath, { force: true });
      delete indexedRuns[manifestKey];
      processedRuns += 1;
      continue;
    }

    let metadata = metadataCache.get(source.workflowKey);
    if (!metadata) {
      metadata = await readWorkflowMetadata(
        data.workspaceFolderPath,
        source.workflowKey
      );
      metadataCache.set(source.workflowKey, metadata);
    }

    const { documents, overCapCandidateCount } =
      await buildRunDocumentsForSource(
        runManifest,
        source.manifestPath,
        metadata,
        source.workflowKey,
        source.runRef
      );
    await writeDocumentsShardAtomically(shardPath, documents);
    documentCount += documents.length;
    indexedRuns[manifestKey] = await buildIndexedRunEntry(
      source,
      runManifest,
      overCapCandidateCount
    );
    processedRuns += 1;

    if (processedRuns % PROGRESS_LOG_INTERVAL === 0) {
      Log.debug(
        `[HistorySearchIndexService] incremental rebuild progress: ${processedRuns}/${touchedRuns} runs, ${documentCount} documents so far, elapsedMs=${Date.now() - rebuildStart}`
      );
    }
    onProgress?.(processedRuns, touchedRuns);
  }

  for (const removedManifestPath of diff.removedManifestPaths) {
    const removedShardPath = getDocumentsShardPath(
      indexDir,
      removedManifestPath
    );
    await fs.promises.rm(removedShardPath, { force: true });
    delete indexedRuns[removedManifestPath];
  }

  const indexManifest: HistorySearchIndexManifest = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    builtAt,
    workspaceRootHash: hashPath(data.workspaceFolderPath),
    historyRootMtimeMs: (
      await statOptional(WorkflowPaths.runsRoot(data.workspaceFolderPath))
    )?.mtimeMs,
    indexedRuns,
  };
  await writeFileAtomic(manifestPath, JSON.stringify(indexManifest, null, 2));
  onProgress?.(processedRuns, touchedRuns);
  Log.info(
    `[HistorySearchIndexService] incremental rebuild complete: newRuns=${diff.newRuns.length} changedRuns=${diff.changedRuns.length} removedRuns=${diff.removedManifestPaths.length} unchangedRuns=${diff.unchangedManifestPaths.length} processedRuns=${processedRuns}/${touchedRuns} documents=${documentCount} totalMs=${Date.now() - rebuildStart}`
  );
}

export async function listRunSources(
  workspaceFolderPath: string
): Promise<WorkflowRunSource[]> {
  const runsRoot = WorkflowPaths.runsRoot(workspaceFolderPath);
  let lineageEntries: fs.Dirent[];
  try {
    lineageEntries = await fs.promises.readdir(runsRoot, {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sources: WorkflowRunSource[] = [];
  for (const lineageEntry of lineageEntries.filter((entry) =>
    WorkflowPaths.isLineageDirEntry(entry)
  )) {
    const workflowKey = lineageEntry.name as WorkflowKey;
    const lineageDirPath = WorkflowPaths.lineageDir(
      workspaceFolderPath,
      workflowKey
    );
    let runEntries: fs.Dirent[];
    try {
      runEntries = await fs.promises.readdir(lineageDirPath, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    const runs = runEntries
      .filter((entry) => WorkflowPaths.isRunDirEntry(entry))
      .map((entry) => ({
        runRef: entry.name as RunRef,
        timestamp: WorkflowPaths.parseRunRefTimestamp(entry.name) ?? 0,
      }))
      .sort((left, right) => right.timestamp - left.timestamp);

    for (const run of runs) {
      sources.push({
        workflowKey,
        runRef: run.runRef,
        manifestPath: WorkflowPaths.manifestPath(
          workspaceFolderPath,
          workflowKey,
          run.runRef
        ),
        eventsPath: WorkflowPaths.eventsPath(
          workspaceFolderPath,
          workflowKey,
          run.runRef
        ),
      });
    }
  }

  return sources;
}

interface WorkerEntryData extends HistorySearchRebuildWorkerData {}

if (!isMainThread) {
  const data = workerData as WorkerEntryData;
  initializeRunHistoryLocation(data.runHistoryLocation);
  Log.initializeCli(data.workspaceFolderPath, true, data.logFilePath);

  void runHistorySearchRebuild(data, (processedRuns, totalRuns) => {
    parentPort?.postMessage({
      type: HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.PROGRESS,
      processedRuns,
      totalRuns,
    } satisfies HistorySearchRebuildProgressMessage);
  })
    .then((result) => {
      parentPort?.postMessage(result);
    })
    .catch((error: unknown) => {
      const message: HistorySearchRebuildErrorMessage = {
        type: HISTORY_SEARCH_REBUILD_MESSAGE_TYPES.ERROR,
        message: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      Log.error(
        `[HistorySearchIndexService] worker rebuild failed: ${message.message}`
      );
      parentPort?.postMessage(message);
    });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

function getIndexDir(
  workspaceFolderPath: string,
  runHistoryLocation: RunHistoryLocation
): string {
  return path.join(
    projectStateRoot(workspaceFolderPath, runHistoryLocation),
    PATH_CONSTANTS.SEARCH_INDEX_DIR
  );
}

function getIndexManifestPath(
  workspaceFolderPath: string,
  runHistoryLocation: RunHistoryLocation
): string {
  return path.join(
    getIndexDir(workspaceFolderPath, runHistoryLocation),
    MANIFEST_FILE_NAME
  );
}

function hashPath(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(filePath))
    .digest("hex");
}

/** The shard file name for a run, derived from its manifest path alone (no I/O). */
export function getDocumentsShardFileName(manifestPath: string): string {
  return `${hashPath(manifestPath)}${DOCUMENTS_SHARD_EXTENSION}`;
}

export function getDocumentsShardPath(
  indexDir: string,
  manifestPath: string
): string {
  return path.join(
    indexDir,
    DOCUMENTS_DIR_NAME,
    getDocumentsShardFileName(manifestPath)
  );
}

async function writeDocumentsShard(
  shardPath: string,
  documents: HistorySearchDocument[]
): Promise<void> {
  const stream = fs.createWriteStream(shardPath, { encoding: "utf8" });
  try {
    for (const document of documents) {
      if (!stream.write(JSON.stringify(document) + "\n")) {
        await once(stream, "drain");
      }
    }
  } finally {
    stream.end();
    await once(stream, "finish");
  }
}

async function writeDocumentsShardAtomically(
  shardPath: string,
  documents: HistorySearchDocument[]
): Promise<void> {
  const tempPath = `${shardPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  try {
    await writeDocumentsShard(tempPath, documents);
    await renameWithTransientRetry(tempPath, shardPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

async function buildIndexedRunEntry(
  source: WorkflowRunSource,
  manifest: WorkflowRunManifest,
  overCapCandidateCount: number
): Promise<HistorySearchIndexManifest["indexedRuns"][string]> {
  const [manifestStats, eventsStats] = await Promise.all([
    fs.promises.stat(source.manifestPath),
    statOptional(source.eventsPath),
  ]);
  return {
    manifestPath: source.manifestPath,
    eventsPath: source.eventsPath,
    workflowId: manifest.workflowId,
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    eventCount: manifest.eventCount,
    lastUpdatedAt: manifest.lastUpdatedAt,
    sourceManifestMtimeMs: manifestStats.mtimeMs,
    sourceEventsMtimeMs: eventsStats?.mtimeMs ?? 0,
    overCapCandidateCount,
  };
}

async function readManifestSafe(
  manifestPath: string
): Promise<WorkflowRunManifest | undefined> {
  try {
    return await timelineRecorder.readManifest(manifestPath);
  } catch (error) {
    Log.warn(
      `[HistorySearchIndexService] Failed to read manifest ${manifestPath}: ${getErrorMessage(error)}`
    );
    return undefined;
  }
}

async function* readEventsSafe(
  manifestPath: string,
  onStringTruncated?: () => void
): AsyncGenerator<WorkflowTimelineEvent, void, undefined> {
  try {
    for await (const event of timelineRecorder.streamEventsForHistorySearch(
      manifestPath,
      MAX_INDEXED_TEXT_LENGTH,
      onStringTruncated
    )) {
      yield event;
    }
  } catch (error) {
    Log.warn(
      `[HistorySearchIndexService] Failed to read events ${manifestPath}: ${getErrorMessage(error)}`
    );
    throw error;
  }
}

async function readWorkflowMetadata(
  workspaceFolderPath: string,
  workflowKey: WorkflowKey
): Promise<WorkflowMetadata> {
  return {
    workflowName: await lineageRepository.readWorkflowDisplayName(
      workspaceFolderPath,
      workflowKey
    ),
  };
}

async function buildRunDocuments(
  manifest: WorkflowRunManifest,
  events: AsyncIterable<WorkflowTimelineEvent>,
  metadata: WorkflowMetadata,
  workflowKey: WorkflowKey,
  runRef: RunRef
): Promise<HistorySearchDocument[]> {
  return runDocumentBuilder.buildRunDocuments(events, {
    manifest,
    workflowKey,
    runRef,
    workflowName: metadata.workflowName,
  });
}

async function buildRunDocumentsForSource(
  manifest: WorkflowRunManifest,
  manifestPath: string,
  metadata: WorkflowMetadata,
  workflowKey: WorkflowKey,
  runRef: RunRef
): Promise<{
  documents: HistorySearchDocument[];
  overCapCandidateCount: number;
}> {
  let overCapCandidateCount = 0;
  const documents = await buildRunDocuments(
    manifest,
    readEventsSafe(manifestPath, () => {
      overCapCandidateCount += 1;
    }),
    metadata,
    workflowKey,
    runRef
  );
  return { documents, overCapCandidateCount };
}

async function swapIndexFiles(
  indexDir: string,
  manifestPath: string,
  documentsDir: string
): Promise<void> {
  await fs.promises.rm(path.join(indexDir, MANIFEST_FILE_NAME), {
    force: true,
  });
  await fs.promises.rm(path.join(indexDir, DOCUMENTS_DIR_NAME), {
    recursive: true,
    force: true,
  });
  await fs.promises.rm(path.join(indexDir, LEGACY_DOCUMENTS_FILE_NAME), {
    force: true,
  });
  await fs.promises.rename(
    documentsDir,
    path.join(indexDir, DOCUMENTS_DIR_NAME)
  );
  await fs.promises.rename(
    manifestPath,
    path.join(indexDir, MANIFEST_FILE_NAME)
  );
}

async function cleanupRebuildDirs(
  indexDir: string,
  activeRebuildDir: string
): Promise<void> {
  try {
    const entries = await fs.promises.readdir(indexDir, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith("rebuild-") &&
            path.join(indexDir, entry.name) !== activeRebuildDir
        )
        .map((entry) =>
          fs.promises.rm(path.join(indexDir, entry.name), {
            recursive: true,
            force: true,
          })
        )
    );
    await fs.promises.rm(activeRebuildDir, { recursive: true, force: true });
  } catch {
    // Opportunistic cleanup only.
  }
}

async function statOptional(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return undefined;
  }
}
