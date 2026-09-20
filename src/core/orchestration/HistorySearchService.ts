import * as fs from "fs";
import * as path from "path";
import { HISTORY_SEARCH_COUNT_STATES } from "../../types/DashboardConstants";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";
import {
  type HistorySearchFilters,
  type HistorySearchQuery,
  type HistorySearchResponse,
  type HistorySearchResult,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import { getErrorMessage } from "../../utils/ErrorUtils";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { Log } from "../../utils/Log";
import { logMemoryUsage } from "../../utils/MemoryDiagnostics";
import { FileLockTimeoutError } from "../../utils/FileLockUtils";
import {
  HistorySearchCancelledError,
  MAX_INDEXED_TEXT_LENGTH,
  type HistorySearchIndexSearchOptions,
  type IndexRebuildProgressCallback,
  type PartialSearchResultsCallback,
} from "./HistorySearchIndexService";
import { getSharedHistorySearchIndexService } from "./HistorySearchIndexServiceRegistry";
import { HistoryRunDocumentBuilder } from "./HistoryRunDocumentBuilder";
import { matchesFilters } from "./HistorySearchFilters";
import {
  getHistorySearchDocumentDedupeKey,
  projectHistorySearchResult,
} from "./HistorySearchResultUtils";
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

const MAX_RESULTS = 50;
const MIN_QUERY_LENGTH = 2;

export interface HistorySearchOptions extends HistorySearchIndexSearchOptions {
  allowLegacyFallback?: boolean;
}

interface WorkflowMetadata {
  workflowName: string;
}

interface WorkflowRunEntry {
  runRef: import("../../types/CtrlYokeTypes").RunRef;
  timestamp: number;
}

export class HistorySearchService {
  private readonly timelineRecorder = new TimelineRecorder();
  private readonly lineageRepository = new WorkflowLineageRepository();
  // Capped the same as the indexed rebuild path (HistorySearchIndexService) —
  // this fallback used to build full, uncapped candidate text for every event
  // it scanned, which is exactly the "megabyte-per-event verbatim" pattern
  // that path's own cap exists to avoid, and is more likely to run under
  // memory pressure since it only fires when the index path already failed.
  private readonly runDocumentBuilder = new HistoryRunDocumentBuilder(
    MAX_INDEXED_TEXT_LENGTH
  );

  async search(
    query: string | HistorySearchQuery,
    workspaceFolderPath: string,
    onRebuildProgress?: IndexRebuildProgressCallback,
    signal?: AbortSignal,
    onPartialResults?: PartialSearchResultsCallback,
    options?: HistorySearchOptions
  ): Promise<HistorySearchResponse> {
    const request =
      typeof query === "string"
        ? { query, limit: MAX_RESULTS }
        : { ...query, limit: query.limit || MAX_RESULTS };

    const indexAttemptStart = Date.now();
    try {
      return await getSharedHistorySearchIndexService(
        workspaceFolderPath
      ).search(
        request,
        workspaceFolderPath,
        onRebuildProgress,
        signal,
        onPartialResults,
        options
      );
    } catch (error) {
      if (error instanceof HistorySearchCancelledError) {
        // Superseded by a newer search — not a failure, so it must not fall
        // through to the disk-scan fallback below (that would spend the
        // exact full-history-read cost this cancellation exists to avoid).
        throw error;
      }
      if (options?.allowLegacyFallback === false) {
        throw error;
      }
      const reason =
        error instanceof FileLockTimeoutError
          ? `lock still contended after its extended timeout (${getErrorMessage(error)})`
          : getErrorMessage(error);
      Log.warn(
        `[HistorySearchService] Indexed search failed after ${Date.now() - indexAttemptStart}ms, falling back to disk scan: ${reason}`
      );
      logMemoryUsage("HistorySearchService falling back to disk scan");
      const fallbackStart = Date.now();
      const offset = Math.max(0, Math.floor(request.offset ?? 0));
      // The unindexed path cannot know a total match count without reading the
      // whole history, so it scans only as far as the requested window and
      // reports what it found. `hasMore` stays optimistic while the scan hit
      // its budget, which is what the virtualized list needs to keep paging.
      // Deep search is an index-path capability; this legacy fallback stays
      // capped and intentionally ignores request.deep because it is used only
      // after the index path has already failed, often under memory pressure.
      const scanned = await this.searchLegacy(
        request.query,
        workspaceFolderPath,
        offset + request.limit,
        request.filters,
        options?.snippetChars
      );
      const results = scanned.slice(offset, offset + request.limit);
      Log.info(
        `[HistorySearchService] Disk scan fallback complete: query="${request.query.trim()}" offset=${offset} scanned=${scanned.length} results=${results.length} durationMs=${Date.now() - fallbackStart}`
      );
      logMemoryUsage("HistorySearchService disk scan fallback complete");
      return {
        query: request.query.trim(),
        offset,
        results,
        totalCount: scanned.length,
        countState: HISTORY_SEARCH_COUNT_STATES.AT_LEAST,
        hasMore: scanned.length >= offset + request.limit,
        indexState: "fallback",
      };
    }
  }

  private async searchLegacy(
    query: string,
    workspaceFolderPath: string,
    limit: number,
    filters: HistorySearchFilters | undefined,
    snippetChars?: number
  ): Promise<HistorySearchResult[]> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < MIN_QUERY_LENGTH) {
      return [];
    }

    const runsRoot = WorkflowPaths.runsRoot(workspaceFolderPath);

    let lineageEntries: fs.Dirent[];
    try {
      lineageEntries = await fs.promises.readdir(runsRoot, {
        withFileTypes: true,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      Log.warn(
        `[HistorySearchService] Failed to read runs directory: ${getErrorMessage(error)}`
      );
      return [];
    }

    const workflowRuns = await Promise.all(
      lineageEntries
        .filter((entry) => WorkflowPaths.isLineageDirEntry(entry))
        .map(async (entry) => {
          const workflowKey = entry.name as WorkflowKey;
          const workflowHistoryDir = WorkflowPaths.lineageDir(
            workspaceFolderPath,
            workflowKey
          );
          const runs = await this.getWorkflowRuns(workflowHistoryDir);
          return {
            workflowKey,
            workflowHistoryDir,
            runs,
            latestTimestamp: runs[0]?.timestamp ?? 0,
          };
        })
    );

    workflowRuns.sort(
      (left, right) => right.latestTimestamp - left.latestTimestamp
    );

    const totalRuns = workflowRuns.reduce(
      (sum, workflow) => sum + workflow.runs.length,
      0
    );
    Log.info(
      `[HistorySearchService] disk scan starting: query="${normalizedQuery}" workflows=${workflowRuns.length} runs=${totalRuns} limit=${limit}`
    );
    const scanStart = Date.now();
    let scannedRuns = 0;
    const PROGRESS_LOG_INTERVAL = 200;

    const results: HistorySearchResult[] = [];
    const seen = new Set<string>();

    for (const workflow of workflowRuns) {
      if (results.length >= limit) {
        break;
      }
      if (workflow.runs.length === 0) {
        continue;
      }

      const metadata = await this.readWorkflowMetadata(
        workspaceFolderPath,
        workflow.workflowKey
      );

      for (const run of workflow.runs) {
        if (results.length >= limit) {
          break;
        }

        const manifestPath = TimelineRecorder.getManifestPathForRunDirectory(
          path.join(workflow.workflowHistoryDir, run.runRef)
        );
        const manifest = await this.readManifestSafe(manifestPath);
        scannedRuns += 1;
        if (scannedRuns % PROGRESS_LOG_INTERVAL === 0) {
          Log.debug(
            `[HistorySearchService] disk scan progress: ${scannedRuns}/${totalRuns} runs, ${results.length} matches so far, elapsedMs=${Date.now() - scanStart}`
          );
        }
        if (!manifest) {
          continue;
        }

        const events = await this.readEventsSafe(manifestPath);
        for (const event of events) {
          if (results.length >= limit) {
            break;
          }

          const eventDocuments = this.collectEventDocuments(
            event,
            manifest,
            metadata,
            workflow.workflowKey,
            run.runRef
          );

          for (const document of eventDocuments) {
            if (
              !this.matchesQuery(document.text, normalizedQuery) ||
              !matchesFilters(document, filters)
            ) {
              continue;
            }

            const match = projectHistorySearchResult(
              document,
              normalizedQuery,
              snippetChars
            );
            const dedupeKey = getHistorySearchDocumentDedupeKey(
              document,
              match
            );
            if (seen.has(dedupeKey)) {
              continue;
            }
            seen.add(dedupeKey);
            results.push(match);
            if (results.length >= limit) {
              break;
            }
          }
        }
      }
    }

    Log.info(
      `[HistorySearchService] disk scan finished: query="${normalizedQuery}" scannedRuns=${scannedRuns}/${totalRuns} matches=${results.length} durationMs=${Date.now() - scanStart}`
    );

    return results
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, limit);
  }

  private async getWorkflowRuns(
    workflowHistoryDir: string
  ): Promise<WorkflowRunEntry[]> {
    try {
      const entries = await fs.promises.readdir(workflowHistoryDir, {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => WorkflowPaths.isRunDirEntry(entry))
        .map((entry) => ({
          runRef: entry.name as import("../../types/CtrlYokeTypes").RunRef,
          timestamp: WorkflowPaths.parseRunRefTimestamp(entry.name) ?? 0,
        }))
        .sort((left, right) => right.timestamp - left.timestamp);
    } catch {
      return [];
    }
  }

  private async readWorkflowMetadata(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowMetadata> {
    return {
      workflowName: await this.lineageRepository.readWorkflowDisplayName(
        workspaceFolderPath,
        workflowKey
      ),
    };
  }

  private async readManifestSafe(
    manifestPath: string
  ): Promise<WorkflowRunManifest | undefined> {
    try {
      return await this.timelineRecorder.readManifest(manifestPath);
    } catch (error) {
      Log.warn(
        `[HistorySearchService] Failed to read manifest ${manifestPath}: ${getErrorMessage(error)}`
      );
      return undefined;
    }
  }

  private async readEventsSafe(manifestPath: string) {
    try {
      return await this.timelineRecorder.readEvents(manifestPath);
    } catch (error) {
      Log.warn(
        `[HistorySearchService] Failed to read events ${manifestPath}: ${getErrorMessage(error)}`
      );
      return [];
    }
  }

  private collectEventDocuments(
    event: WorkflowTimelineEvent,
    manifest: WorkflowRunManifest,
    metadata: WorkflowMetadata,
    workflowKey: WorkflowKey,
    runRef: import("../../types/CtrlYokeTypes").RunRef
  ) {
    return this.runDocumentBuilder.buildEventDocuments(event, {
      manifest,
      workflowKey,
      runRef,
      workflowName: metadata.workflowName,
    });
  }

  private matchesQuery(text: string, query: string): boolean {
    return text.toLowerCase().includes(query.toLowerCase());
  }
}
