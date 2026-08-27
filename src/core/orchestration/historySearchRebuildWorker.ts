import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { once } from "events";
import { isMainThread, parentPort, workerData } from "worker_threads";
import type { RunHistoryLocation } from "../../types/CtrlYokeSettings";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import {
  TIMELINE_EVENT_TYPES,
  type CliOutputRecordedEvent,
  type HistorySearchDocument,
  type StatusMessageRecordedEvent,
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
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  HistoryCandidateExtractor,
  type MatchCandidate,
} from "./HistoryCandidateExtractor";

export const INDEX_SCHEMA_VERSION = "3.0.0" as const;
export const MANIFEST_FILE_NAME = "manifest.json";
export const DOCUMENTS_FILE_NAME = "documents.jsonl";
export const MAX_INDEXED_TEXT_LENGTH = 2000;
const REBUILD_LOCK_TIMEOUT_MS = 60_000;
const PROGRESS_LOG_INTERVAL = 200;
const PROGRESS_EMIT_INTERVAL_MS = 150;
const FRESHNESS_CHECK_CONCURRENCY = 16;
const timelineRecorder = new TimelineRecorder();
const lineageRepository = new WorkflowLineageRepository();
const candidateExtractor = new HistoryCandidateExtractor({
  maxTextLength: MAX_INDEXED_TEXT_LENGTH,
});

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
    }
  >;
}

interface WorkflowMetadata {
  workflowName: string;
}

interface WorkflowRunSource {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  manifestPath: string;
  eventsPath: string;
}

export interface HistorySearchRebuildProgressMessage {
  type: "progress";
  processedRuns: number;
  totalRuns: number;
}

export interface HistorySearchRebuildSuccessMessage {
  type: "success";
  skipped: boolean;
  freshnessReason?: string;
}

export interface HistorySearchRebuildErrorMessage {
  type: "error";
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
  retainDocuments: boolean;
  logFilePath?: string;
}

export type HistorySearchRebuildProgressCallback = (
  processedRuns: number,
  totalRuns: number
) => void;

/**
 * Check whether the on-disk index still describes the current run history.
 * This is shared by the host's preflight check and the worker's lock-scoped
 * recheck, so the latter preserves Phase 1A's contention behavior.
 */
export async function checkHistorySearchIndexFreshness(
  workspaceFolderPath: string,
  manifest: HistorySearchIndexManifest
): Promise<HistorySearchFreshnessResult> {
  if (
    manifest.schemaVersion !== INDEX_SCHEMA_VERSION ||
    manifest.workspaceRootHash !== hashPath(workspaceFolderPath)
  ) {
    return {
      fresh: false,
      reason: "schema/workspace hash mismatch",
    };
  }

  const currentRuns = await listRunSources(workspaceFolderPath);
  const currentManifestPaths = new Set(
    currentRuns.map((run) => path.resolve(run.manifestPath))
  );
  const indexedManifestPaths = new Set(Object.keys(manifest.indexedRuns));
  if (currentManifestPaths.size !== indexedManifestPaths.size) {
    return {
      fresh: false,
      reason: `run count changed (current=${currentManifestPaths.size} indexed=${indexedManifestPaths.size})`,
    };
  }

  const checkResults = await mapWithConcurrency(
    currentRuns,
    FRESHNESS_CHECK_CONCURRENCY,
    async (source): Promise<HistorySearchFreshnessResult> => {
      const key = path.resolve(source.manifestPath);
      const indexedRun = manifest.indexedRuns[key];
      if (!indexedRun) {
        return {
          fresh: false,
          reason: `new run not yet indexed (${source.workflowKey}/${source.runRef})`,
        };
      }
      const sourceManifest = await readManifestSafe(source.manifestPath);
      if (!sourceManifest) {
        return {
          fresh: false,
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
          fresh: false,
          reason: `run changed since indexing (${source.workflowKey}/${source.runRef})`,
        };
      }
      return { fresh: true };
    }
  );

  const stale = checkResults.find((result) => !result.fresh);
  return stale ?? { fresh: true };
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
  await withFileLock(
    lockTargetPath,
    async () => {
      const builtAt = Date.now();
      const manifestPath = getIndexManifestPath(
        data.workspaceFolderPath,
        data.runHistoryLocation
      );
      let onDiskManifest: HistorySearchIndexManifest | undefined;
      try {
        const manifest = JSON.parse(
          await fs.promises.readFile(manifestPath, "utf8")
        ) as HistorySearchIndexManifest;
        if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
          Log.info(
            `[HistorySearchIndexService] on-disk index schema mismatch (found ${manifest.schemaVersion}, expected ${INDEX_SCHEMA_VERSION}); will rebuild`
          );
        } else {
          onDiskManifest = manifest;
        }
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
      }

      if (onDiskManifest) {
        const freshness = await checkHistorySearchIndexFreshness(
          data.workspaceFolderPath,
          onDiskManifest
        );
        if (freshness.fresh) {
          skipped = true;
          Log.info(
            "[HistorySearchIndexService] rebuild skipped: on-disk index already fresh"
          );
          return;
        }
        freshnessReason = freshness.reason;
        Log.debug(
          `[HistorySearchIndexService] freshness check stale: ${freshness.reason}`
        );
      }

      const rebuildDir = path.join(indexDir, `rebuild-${builtAt}`);
      await fs.promises.mkdir(rebuildDir, { recursive: true });

      const indexedRuns: HistorySearchIndexManifest["indexedRuns"] = {};
      const listSourcesStart = Date.now();
      const runSources = await listRunSources(data.workspaceFolderPath);
      Log.info(
        `[HistorySearchIndexService] rebuild starting: runs=${runSources.length} retainDocuments=${data.retainDocuments} listSourcesMs=${Date.now() - listSourcesStart}`
      );
      logMemoryUsage("HistorySearchIndexService rebuild starting", {
        runs: runSources.length,
        retainDocuments: String(data.retainDocuments),
      });

      const documentsPath = path.join(rebuildDir, DOCUMENTS_FILE_NAME);
      const rebuildManifestPath = path.join(rebuildDir, MANIFEST_FILE_NAME);
      const stream = fs.createWriteStream(documentsPath, { encoding: "utf8" });
      let documentCount = 0;
      let processedRuns = 0;
      let lastProgressEmitAt = 0;
      onProgress?.(0, runSources.length);
      const metadataCache = new Map<WorkflowKey, WorkflowMetadata>();
      try {
        for (const source of runSources) {
          const manifest = await readManifestSafe(source.manifestPath);
          if (!manifest) {
            continue;
          }
          const events = await readEventsSafe(source.manifestPath);
          let metadata = metadataCache.get(source.workflowKey);
          if (!metadata) {
            metadata = await readWorkflowMetadata(
              data.workspaceFolderPath,
              source.workflowKey
            );
            metadataCache.set(source.workflowKey, metadata);
          }

          for (const document of buildRunDocuments(
            manifest,
            events,
            metadata,
            source.workflowKey,
            source.runRef
          )) {
            documentCount += 1;
            if (!stream.write(JSON.stringify(document) + "\n")) {
              await once(stream, "drain");
            }
          }

          const manifestStats = await fs.promises.stat(source.manifestPath);
          const eventsStats = await statOptional(source.eventsPath);
          indexedRuns[path.resolve(source.manifestPath)] = {
            manifestPath: source.manifestPath,
            eventsPath: source.eventsPath,
            workflowId: manifest.workflowId,
            runId: manifest.runId,
            startedAt: manifest.startedAt,
            eventCount: manifest.eventCount,
            lastUpdatedAt: manifest.lastUpdatedAt,
            sourceManifestMtimeMs: manifestStats.mtimeMs,
            sourceEventsMtimeMs: eventsStats?.mtimeMs ?? 0,
          };

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
      } finally {
        stream.end();
        await once(stream, "finish");
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

      await swapIndexFiles(indexDir, rebuildManifestPath, documentsPath);
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

  return { type: "success", skipped, freshnessReason };
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
      type: "progress",
      processedRuns,
      totalRuns,
    } satisfies HistorySearchRebuildProgressMessage);
  })
    .then((result) => {
      parentPort?.postMessage(result);
    })
    .catch((error: unknown) => {
      const message: HistorySearchRebuildErrorMessage = {
        type: "error",
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

async function readEventsSafe(
  manifestPath: string
): Promise<WorkflowTimelineEvent[]> {
  try {
    return await timelineRecorder.readEvents(manifestPath);
  } catch (error) {
    Log.warn(
      `[HistorySearchIndexService] Failed to read events ${manifestPath}: ${getErrorMessage(error)}`
    );
    return [];
  }
}

async function readWorkflowMetadata(
  workspaceFolderPath: string,
  workflowKey: WorkflowKey
): Promise<WorkflowMetadata> {
  try {
    const descriptor = await lineageRepository.readDescriptor(
      workspaceFolderPath,
      workflowKey
    );
    return {
      workflowName:
        descriptor.workflowName?.trim().length > 0
          ? descriptor.workflowName
          : deriveWorkflowName(workflowKey),
    };
  } catch {
    return { workflowName: deriveWorkflowName(workflowKey) };
  }
}

function buildRunDocuments(
  manifest: WorkflowRunManifest,
  events: WorkflowTimelineEvent[],
  metadata: WorkflowMetadata,
  workflowKey: WorkflowKey,
  runRef: RunRef
): HistorySearchDocument[] {
  return events.flatMap((event) => {
    const candidates = collectEventCandidates(event, candidateExtractor);
    const target = "target" in event ? event.target : undefined;
    if (!target) {
      return [];
    }
    const outputMetadata =
      event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
        ? (event as CliOutputRecordedEvent).payload.cliOutput.structured
            ?.metadata
        : undefined;
    return candidates.map((candidate, candidateIndex) => ({
      id: [
        workflowKey,
        runRef,
        manifest.runId,
        event.sequence,
        `${candidate.eventKind}:${candidate.matchField}`,
        candidateIndex,
      ].join(":"),
      workflowKey,
      runRef,
      workflowName: metadata.workflowName,
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      executionState: manifest.executionState,
      target,
      attemptIndex:
        event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
          ? (event as CliOutputRecordedEvent).attemptIndex
          : 0,
      sequence: event.sequence,
      timestampMs: event.timestampMs,
      eventKind: candidate.eventKind,
      matchField: candidate.matchField,
      text: candidate.text,
      filePath: candidate.filePath,
      harness: outputMetadata?.harness,
      model: outputMetadata?.model,
      sessionId: outputMetadata?.sessionId,
    }));
  });
}

function collectEventCandidates(
  event: WorkflowTimelineEvent,
  candidateExtractor: HistoryCandidateExtractor
): MatchCandidate[] {
  switch (event.eventType) {
    case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED:
      return candidateExtractor.collectCliOutputCandidates(
        (event as CliOutputRecordedEvent).payload.cliOutput
      );
    case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
      return candidateExtractor.collectStatusCandidates(
        (event as StatusMessageRecordedEvent).payload.statusMessage.message
      );
    default:
      return [];
  }
}

async function swapIndexFiles(
  indexDir: string,
  manifestPath: string,
  documentsPath: string
): Promise<void> {
  await fs.promises.rm(path.join(indexDir, MANIFEST_FILE_NAME), {
    force: true,
  });
  await fs.promises.rm(path.join(indexDir, DOCUMENTS_FILE_NAME), {
    force: true,
  });
  await fs.promises.rename(
    documentsPath,
    path.join(indexDir, DOCUMENTS_FILE_NAME)
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

function deriveWorkflowName(workflowId: string): string {
  return workflowId.replace(
    /-\d{4}-\d{2}-\d{2}T\d{2}(?:-\d{2}){2}(?:-\d{3})?Z?$/,
    ""
  );
}
