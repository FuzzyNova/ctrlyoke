import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { once } from "events";
import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import {
  TIMELINE_EVENT_TYPES,
  type CliOutputRecordedEvent,
  type HistorySearchDocument,
  type HistorySearchQuery,
  type HistorySearchResponse,
  type HistorySearchResult,
  type StatusMessageRecordedEvent,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { withFileLock } from "../../utils/FileLockUtils";
import { Log } from "../../utils/Log";
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  HistoryCandidateExtractor,
  type MatchCandidate,
} from "./HistoryCandidateExtractor";

const INDEX_SCHEMA_VERSION = "3.0.0" as const;
const MANIFEST_FILE_NAME = "manifest.json";
const DOCUMENTS_FILE_NAME = "documents.jsonl";
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 50;

/**
 * Maximum number of characters stored per indexed candidate. History events
 * (bash output, tool results, responses) can each be megabytes; storing them
 * verbatim made the on-disk index larger than the history itself and blew the
 * extension-host JS heap while building it. Search only needs enough text to
 * match and render a snippet, so we cap each candidate. Matches past this
 * offset within a single very large value are intentionally not indexed.
 */
const MAX_INDEXED_TEXT_LENGTH = 2000;

interface HistorySearchIndexManifest {
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

interface CursorPayload {
  offset: number;
  queryHash: string;
  sortVersion: string;
}

export class HistorySearchIndexService {
  private readonly timelineRecorder = new TimelineRecorder();
  private readonly lineageRepository = new WorkflowLineageRepository();
  private readonly candidateExtractor = new HistoryCandidateExtractor({
    maxTextLength: MAX_INDEXED_TEXT_LENGTH,
  });
  private loadedWorkspacePath?: string;
  private loadedManifest?: HistorySearchIndexManifest;
  private documents: HistorySearchDocument[] = [];
  private rebuildPromise?: Promise<void>;
  private rebuildQueued = false;

  async search(
    request: HistorySearchQuery,
    workspaceFolderPath: string
  ): Promise<HistorySearchResponse> {
    const normalizedQuery = request.query.trim();
    if (normalizedQuery.length < MIN_QUERY_LENGTH) {
      return this.emptyResponse(normalizedQuery, "ready");
    }

    const buildInProgress = Boolean(this.rebuildPromise);
    if (!buildInProgress) {
      await this.ensureReady(workspaceFolderPath);
    } else {
      await this.loadIfPossible(workspaceFolderPath);
    }

    const offset = this.decodeCursorOffset(request.cursor, normalizedQuery);
    const limit = Math.max(1, request.limit || DEFAULT_LIMIT);
    const lowered = normalizedQuery.toLowerCase();
    const filters = request.filters;

    const matches = this.documents
      .filter((document) => document.text.toLowerCase().includes(lowered))
      .filter((document) =>
        filters?.matchTypes
          ? filters.matchTypes.includes(document.eventKind)
          : true
      )
      .filter((document) =>
        filters?.workflowKeys
          ? filters.workflowKeys.includes(document.workflowKey)
          : true
      )
      .filter((document) =>
        typeof filters?.since === "number"
          ? document.startedAt >= filters.since
          : true
      )
      .filter((document) =>
        typeof filters?.until === "number"
          ? document.startedAt <= filters.until
          : true
      )
      .sort(this.compareDocuments);

    const page = matches.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < matches.length;

    return {
      query: normalizedQuery,
      results: page.map((document) => this.toResult(document, normalizedQuery)),
      totalCount: matches.length,
      nextCursor: hasMore
        ? this.encodeCursor({
            offset: nextOffset,
            queryHash: this.hashQuery(normalizedQuery),
            sortVersion: "startedAt-timestamp-sequence-desc",
          })
        : undefined,
      hasMore,
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
      return this.rebuildPromise;
    }

    this.rebuildPromise = (async () => {
      try {
        do {
          this.rebuildQueued = false;
          await this.rebuild(workspaceFolderPath, { retainDocuments: false });
        } while (this.rebuildQueued);
      } catch (error) {
        Log.warn(
          `[HistorySearchIndexService] Failed to refresh index: ${getErrorMessage(error)}`
        );
      } finally {
        this.rebuildPromise = undefined;
      }
    })();
    return this.rebuildPromise;
  }

  private async ensureReady(workspaceFolderPath: string): Promise<void> {
    await this.loadIfPossible(workspaceFolderPath);
    if (
      this.loadedWorkspacePath === workspaceFolderPath &&
      this.loadedManifest &&
      (await this.isManifestFresh(workspaceFolderPath, this.loadedManifest))
    ) {
      return;
    }

    await this.rebuild(workspaceFolderPath, { retainDocuments: true });
  }

  private async loadIfPossible(workspaceFolderPath: string): Promise<void> {
    if (
      this.loadedWorkspacePath === workspaceFolderPath &&
      this.loadedManifest
    ) {
      return;
    }

    const manifestPath = this.getIndexManifestPath(workspaceFolderPath);
    const documentsPath = this.getDocumentsPath(workspaceFolderPath);
    try {
      const manifest = JSON.parse(
        await fs.promises.readFile(manifestPath, "utf8")
      ) as HistorySearchIndexManifest;
      if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION) {
        return;
      }
      const documents = await this.readDocumentsJsonl(documentsPath);
      this.loadedWorkspacePath = workspaceFolderPath;
      this.loadedManifest = manifest;
      this.documents = documents;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.warn(
          `[HistorySearchIndexService] Failed to load search index: ${getErrorMessage(error)}`
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
    options: { retainDocuments: boolean }
  ): Promise<void> {
    const indexDir = this.getIndexDir(workspaceFolderPath);
    await fs.promises.mkdir(indexDir, { recursive: true });

    const lockTargetPath = this.getIndexManifestPath(workspaceFolderPath);
    await withFileLock(lockTargetPath, async () => {
      const builtAt = Date.now();
      const rebuildDir = path.join(indexDir, `rebuild-${builtAt}`);
      await fs.promises.mkdir(rebuildDir, { recursive: true });

      const indexedRuns: HistorySearchIndexManifest["indexedRuns"] = {};
      const runSources = await this.listRunSources(workspaceFolderPath);
      const retained: HistorySearchDocument[] | undefined =
        options.retainDocuments ? [] : undefined;

      const documentsPath = path.join(rebuildDir, DOCUMENTS_FILE_NAME);
      const manifestPath = path.join(rebuildDir, MANIFEST_FILE_NAME);
      const stream = fs.createWriteStream(documentsPath, { encoding: "utf8" });
      try {
        for (const source of runSources) {
          const manifest = await this.readManifestSafe(source.manifestPath);
          if (!manifest) {
            continue;
          }
          const events = await this.readEventsSafe(source.manifestPath);
          const metadata = await this.readWorkflowMetadata(
            workspaceFolderPath,
            source.workflowKey
          );

          for (const document of this.buildRunDocuments(
            manifest,
            events,
            metadata,
            source.workflowKey,
            source.runRef
          )) {
            retained?.push(document);
            if (!stream.write(JSON.stringify(document) + "\n")) {
              await once(stream, "drain");
            }
          }

          const manifestStats = await fs.promises.stat(source.manifestPath);
          const eventsStats = await this.statOptional(source.eventsPath);
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
        }
      } finally {
        stream.end();
        await once(stream, "finish");
      }

      const indexManifest: HistorySearchIndexManifest = {
        schemaVersion: INDEX_SCHEMA_VERSION,
        builtAt,
        workspaceRootHash: this.hashPath(workspaceFolderPath),
        historyRootMtimeMs: (
          await this.statOptional(WorkflowPaths.runsRoot(workspaceFolderPath))
        )?.mtimeMs,
        indexedRuns,
      };

      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify(indexManifest, null, 2),
        "utf8"
      );

      await this.swapIndexFiles(indexDir, manifestPath, documentsPath);
      if (retained) {
        this.loadedWorkspacePath = workspaceFolderPath;
        this.loadedManifest = indexManifest;
        this.documents = retained;
      } else {
        // Write-only refresh: drop any in-memory index so refresh-only
        // instances don't retain a full copy. A later search reloads from disk.
        this.loadedWorkspacePath = undefined;
        this.loadedManifest = undefined;
        this.documents = [];
      }
      await this.cleanupRebuildDirs(indexDir, rebuildDir);
    });
  }

  private async isManifestFresh(
    workspaceFolderPath: string,
    manifest: HistorySearchIndexManifest
  ): Promise<boolean> {
    if (
      manifest.schemaVersion !== INDEX_SCHEMA_VERSION ||
      manifest.workspaceRootHash !== this.hashPath(workspaceFolderPath)
    ) {
      return false;
    }

    const currentRuns = await this.listRunSources(workspaceFolderPath);
    const currentManifestPaths = new Set(
      currentRuns.map((run) => path.resolve(run.manifestPath))
    );
    const indexedManifestPaths = new Set(Object.keys(manifest.indexedRuns));
    if (currentManifestPaths.size !== indexedManifestPaths.size) {
      return false;
    }

    for (const source of currentRuns) {
      const key = path.resolve(source.manifestPath);
      const indexedRun = manifest.indexedRuns[key];
      if (!indexedRun) {
        return false;
      }
      const sourceManifest = await this.readManifestSafe(source.manifestPath);
      if (!sourceManifest) {
        return false;
      }
      const manifestStats = await this.statOptional(source.manifestPath);
      const eventsStats = await this.statOptional(source.eventsPath);
      if (
        sourceManifest.eventCount !== indexedRun.eventCount ||
        sourceManifest.lastUpdatedAt !== indexedRun.lastUpdatedAt ||
        manifestStats?.mtimeMs !== indexedRun.sourceManifestMtimeMs ||
        (eventsStats?.mtimeMs ?? 0) !== indexedRun.sourceEventsMtimeMs
      ) {
        return false;
      }
    }

    return true;
  }

  private async listRunSources(
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
        const manifestPath = WorkflowPaths.manifestPath(
          workspaceFolderPath,
          workflowKey,
          run.runRef
        );
        sources.push({
          workflowKey,
          runRef: run.runRef,
          manifestPath,
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

  private buildRunDocuments(
    manifest: WorkflowRunManifest,
    events: WorkflowTimelineEvent[],
    metadata: WorkflowMetadata,
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): HistorySearchDocument[] {
    return events.flatMap((event) => {
      const candidates = this.collectEventCandidates(event);
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

  private collectEventCandidates(
    event: WorkflowTimelineEvent
  ): MatchCandidate[] {
    switch (event.eventType) {
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED:
        return this.candidateExtractor.collectCliOutputCandidates(
          (event as CliOutputRecordedEvent).payload.cliOutput
        );
      case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
        return this.candidateExtractor.collectStatusCandidates(
          (event as StatusMessageRecordedEvent).payload.statusMessage.message
        );
      default:
        return [];
    }
  }

  private toResult(
    document: HistorySearchDocument,
    query: string
  ): HistorySearchResult {
    return {
      workflowKey: document.workflowKey,
      runRef: document.runRef,
      workflowName: document.workflowName,
      runId: document.runId,
      startedAt: document.startedAt,
      executionState: document.executionState,
      target: document.target,
      eventKind: document.eventKind,
      matchField: document.matchField,
      matchSnippet: this.extractSnippet(document.text, query),
      matchContext: this.formatMatchContext(
        document.target,
        document.attemptIndex
      ),
      filePath: document.filePath,
    };
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

  private async readWorkflowMetadata(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowMetadata> {
    try {
      const descriptor = await this.lineageRepository.readDescriptor(
        workspaceFolderPath,
        workflowKey
      );
      return {
        workflowName:
          descriptor.workflowName?.trim().length > 0
            ? descriptor.workflowName
            : this.deriveWorkflowName(workflowKey),
      };
    } catch {
      return {
        workflowName: this.deriveWorkflowName(workflowKey),
      };
    }
  }

  private async readManifestSafe(
    manifestPath: string
  ): Promise<WorkflowRunManifest | undefined> {
    try {
      return await this.timelineRecorder.readManifest(manifestPath);
    } catch (error) {
      Log.warn(
        `[HistorySearchIndexService] Failed to read manifest ${manifestPath}: ${getErrorMessage(error)}`
      );
      return undefined;
    }
  }

  private async readEventsSafe(
    manifestPath: string
  ): Promise<WorkflowTimelineEvent[]> {
    try {
      return await this.timelineRecorder.readEvents(manifestPath);
    } catch (error) {
      Log.warn(
        `[HistorySearchIndexService] Failed to read events ${manifestPath}: ${getErrorMessage(error)}`
      );
      return [];
    }
  }

  private async readDocumentsJsonl(
    documentsPath: string
  ): Promise<HistorySearchDocument[]> {
    const documents: HistorySearchDocument[] = [];
    const reader = readline.createInterface({
      input: fs.createReadStream(documentsPath, { encoding: "utf8" }),
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
    return documents;
  }

  private async swapIndexFiles(
    indexDir: string,
    manifestPath: string,
    documentsPath: string
  ): Promise<void> {
    const targetManifestPath = path.join(indexDir, MANIFEST_FILE_NAME);
    const targetDocumentsPath = path.join(indexDir, DOCUMENTS_FILE_NAME);
    await fs.promises.rm(targetManifestPath, { force: true });
    await fs.promises.rm(targetDocumentsPath, { force: true });
    await fs.promises.rename(documentsPath, targetDocumentsPath);
    await fs.promises.rename(manifestPath, targetManifestPath);
  }

  private async cleanupRebuildDirs(
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

  private async statOptional(filePath: string): Promise<fs.Stats | undefined> {
    try {
      return await fs.promises.stat(filePath);
    } catch {
      return undefined;
    }
  }

  private decodeCursorOffset(
    cursor: string | undefined,
    query: string
  ): number {
    if (!cursor) {
      return 0;
    }
    try {
      const payload = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8")
      ) as CursorPayload;
      return payload.queryHash === this.hashQuery(query)
        ? Math.max(0, payload.offset)
        : 0;
    } catch {
      return 0;
    }
  }

  private encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  private hashPath(filePath: string): string {
    return crypto
      .createHash("sha256")
      .update(path.resolve(filePath))
      .digest("hex");
  }

  private hashQuery(query: string): string {
    return crypto
      .createHash("sha256")
      .update(query.trim().toLowerCase())
      .digest("hex");
  }

  private extractSnippet(text: string, query: string): string {
    const searchText = text.toLowerCase();
    const searchQuery = query.toLowerCase();
    const index = searchText.indexOf(searchQuery);
    if (index === -1) {
      return text.slice(0, 100);
    }

    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + query.length + 60);
    const snippet = text.slice(start, end);
    return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
  }

  private formatMatchContext(
    target: OutputExecutionTarget,
    attemptIndex: number
  ): string {
    if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      if (target.loopIndex > 0) {
        return `Final Step Loop ${target.loopIndex + 1}`;
      }
      if (attemptIndex > 0) {
        return `Final Step Loop ${attemptIndex}`;
      }
      return "Final Step";
    }
    return `Prompt ${target.stepIndex + 1}`;
  }

  private deriveWorkflowName(workflowId: string): string {
    return workflowId.replace(
      /-\d{4}-\d{2}-\d{2}T\d{2}(?:-\d{2}){2}(?:-\d{3})?Z?$/,
      ""
    );
  }

  private getIndexDir(workspaceFolderPath: string): string {
    return path.join(
      workspaceFolderPath,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.SEARCH_INDEX_DIR
    );
  }

  private getIndexManifestPath(workspaceFolderPath: string): string {
    return path.join(this.getIndexDir(workspaceFolderPath), MANIFEST_FILE_NAME);
  }

  private getDocumentsPath(workspaceFolderPath: string): string {
    return path.join(
      this.getIndexDir(workspaceFolderPath),
      DOCUMENTS_FILE_NAME
    );
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
