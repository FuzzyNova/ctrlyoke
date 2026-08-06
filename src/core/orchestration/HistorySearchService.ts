import * as fs from "fs";
import * as path from "path";
import {
  FINAL_STEP_PHASES,
  HISTORY_EVENT_KINDS,
  HISTORY_MATCH_FIELDS,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";
import {
  TIMELINE_EVENT_TYPES,
  type CliOutputRecordedEvent,
  type HistorySearchQuery,
  type HistorySearchResponse,
  type HistorySearchResult,
  type StatusMessageRecordedEvent,
  type WorkflowRunManifest,
} from "../../types/WorkflowTimelineTypes";
import { getErrorMessage } from "../../utils/ErrorUtils";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { Log } from "../../utils/Log";
import { HistorySearchIndexService } from "./HistorySearchIndexService";
import {
  HistoryCandidateExtractor,
  type MatchCandidate,
} from "./HistoryCandidateExtractor";
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

const MAX_RESULTS = 50;
const MIN_QUERY_LENGTH = 2;

interface WorkflowMetadata {
  workflowName: string;
}

interface WorkflowRunEntry {
  runRef: import("../../types/CtrlYokeTypes").RunRef;
  timestamp: number;
}

export class HistorySearchService {
  private readonly timelineRecorder = new TimelineRecorder();
  private readonly indexService = new HistorySearchIndexService();
  private readonly lineageRepository = new WorkflowLineageRepository();
  private readonly candidateExtractor = new HistoryCandidateExtractor();

  async search(
    query: string | HistorySearchQuery,
    workspaceFolderPath: string
  ): Promise<HistorySearchResponse> {
    const request =
      typeof query === "string"
        ? { query, limit: MAX_RESULTS }
        : { ...query, limit: query.limit || MAX_RESULTS };

    try {
      return await this.indexService.search(request, workspaceFolderPath);
    } catch (error) {
      Log.warn(
        `[HistorySearchService] Falling back to disk scan: ${getErrorMessage(error)}`
      );
      const results = await this.searchLegacy(
        request.query,
        workspaceFolderPath,
        request.limit
      );
      return {
        query: request.query.trim(),
        results,
        totalCount: results.length,
        hasMore: results.length >= request.limit,
        indexState: "fallback",
      };
    }
  }

  private async searchLegacy(
    query: string,
    workspaceFolderPath: string,
    limit: number
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
        if (!manifest) {
          continue;
        }

        const events = await this.readEventsSafe(manifestPath);
        for (const event of events) {
          if (results.length >= limit) {
            break;
          }

          const eventMatches = this.collectEventMatches(
            event,
            normalizedQuery,
            manifest,
            metadata,
            workflow.workflowKey,
            run.runRef
          );

          for (const match of eventMatches) {
            const dedupeKey = this.getResultKey(match);
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

  private collectEventMatches(
    event: {
      eventType: string;
      payload: Record<string, unknown>;
      target?: OutputExecutionTarget;
      sequence: number;
      timestampMs: number;
    },
    query: string,
    manifest: WorkflowRunManifest,
    metadata: WorkflowMetadata,
    workflowKey: WorkflowKey,
    runRef: import("../../types/CtrlYokeTypes").RunRef
  ): HistorySearchResult[] {
    switch (event.eventType) {
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED:
        return this.collectCliOutputMatches(
          event as CliOutputRecordedEvent,
          query,
          manifest,
          metadata,
          workflowKey,
          runRef
        );
      case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
        return this.collectStatusMatches(
          event as StatusMessageRecordedEvent,
          query,
          manifest,
          metadata,
          workflowKey,
          runRef
        );
      default:
        return [];
    }
  }

  private collectCliOutputMatches(
    event: CliOutputRecordedEvent,
    query: string,
    manifest: WorkflowRunManifest,
    metadata: WorkflowMetadata,
    workflowKey: WorkflowKey,
    runRef: import("../../types/CtrlYokeTypes").RunRef
  ): HistorySearchResult[] {
    const cliOutput = event.payload.cliOutput;
    const candidates = this.candidateExtractor
      .collectCliOutputCandidates(cliOutput)
      .filter((candidate) => this.matchesQuery(candidate.text, query));

    return candidates.map((candidate) =>
      this.buildResult(
        manifest,
        metadata,
        workflowKey,
        runRef,
        event.target,
        event.attemptIndex,
        query,
        candidate
      )
    );
  }

  private collectStatusMatches(
    event: StatusMessageRecordedEvent,
    query: string,
    manifest: WorkflowRunManifest,
    metadata: WorkflowMetadata,
    workflowKey: WorkflowKey,
    runRef: import("../../types/CtrlYokeTypes").RunRef
  ): HistorySearchResult[] {
    const message = event.payload.statusMessage.message;
    if (!this.matchesQuery(message, query)) {
      return [];
    }

    return [
      this.buildResult(
        manifest,
        metadata,
        workflowKey,
        runRef,
        event.target,
        0,
        query,
        {
          eventKind: HISTORY_EVENT_KINDS.STATUS,
          matchField: HISTORY_MATCH_FIELDS.CONTENT,
          text: message,
        }
      ),
    ];
  }

  private buildResult(
    manifest: WorkflowRunManifest,
    metadata: WorkflowMetadata,
    workflowKey: WorkflowKey,
    runRef: import("../../types/CtrlYokeTypes").RunRef,
    target: OutputExecutionTarget,
    attemptIndex: number,
    query: string,
    candidate: MatchCandidate
  ): HistorySearchResult {
    return {
      workflowKey,
      runRef,
      workflowName: metadata.workflowName,
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      executionState: manifest.executionState,
      target,
      eventKind: candidate.eventKind,
      matchField: candidate.matchField,
      matchSnippet: this.extractSnippet(candidate.text, query),
      matchContext: this.formatMatchContext(target, attemptIndex),
      filePath: candidate.filePath,
    };
  }

  private matchesQuery(text: string, query: string): boolean {
    return text.toLowerCase().includes(query.toLowerCase());
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

  private getResultKey(result: HistorySearchResult): string {
    return [
      result.workflowKey,
      result.runRef,
      result.runId,
      result.eventKind,
      result.matchField,
      result.matchContext,
      result.filePath ?? "",
      result.matchSnippet,
    ].join("::");
  }
}
