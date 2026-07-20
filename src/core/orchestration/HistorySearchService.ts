import * as fs from "fs";
import * as path from "path";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { CliEvent } from "../../types/WebviewMessageTypes";
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
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";

const MAX_RESULTS = 50;
const MIN_QUERY_LENGTH = 2;

interface WorkflowMetadata {
  workflowName: string;
  workflowFilePath: string;
}

interface WorkflowRunEntry {
  entryName: string;
  timestamp: number;
}

interface MatchCandidate {
  matchType: HistorySearchResult["matchType"];
  text: string;
  filePath?: string;
}

export class HistorySearchService {
  private readonly timelineRecorder = new TimelineRecorder();
  private readonly indexService = new HistorySearchIndexService();
  private readonly lineageRepository = new WorkflowLineageRepository();

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

  enqueueIndexRefresh(workspaceFolderPath: string): void {
    void this.indexService.enqueueWorkspaceRefresh(workspaceFolderPath);
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
          const workflowId = entry.name as WorkflowKey;
          const workflowHistoryDir = WorkflowPaths.lineageDir(
            workspaceFolderPath,
            workflowId
          );
          const runs = await this.getWorkflowRuns(workflowHistoryDir);
          return {
            workflowId,
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
        workflow.workflowId
      );

      for (const [runIndex, run] of workflow.runs.entries()) {
        if (results.length >= limit) {
          break;
        }

        const manifestPath = TimelineRecorder.getManifestPathForRunDirectory(
          path.join(workflow.workflowHistoryDir, run.entryName)
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
            runIndex
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
          entryName: entry.name,
          timestamp: WorkflowPaths.parseRunRefTimestamp(entry.name) ?? 0,
        }))
        .sort((left, right) => right.timestamp - left.timestamp);
    } catch {
      return [];
    }
  }

  private async readWorkflowMetadata(
    workspaceFolderPath: string,
    workflowId: string
  ): Promise<WorkflowMetadata> {
    const workflowKey = workflowId as WorkflowKey;
    try {
      const descriptor = await this.lineageRepository.readDescriptor(
        workspaceFolderPath,
        workflowKey
      );
      // LOAD_WORKFLOW expects a working file path, not the original source
      // file — the resume/load flow needs the run/draft file even when the
      // original prompt file is missing or the workflow was dashboard-created.
      const workflowFilePath = descriptor.latestRunRef
        ? WorkflowPaths.runFilePath(
            workspaceFolderPath,
            workflowKey,
            descriptor.latestRunRef
          )
        : WorkflowPaths.draftFilePath(workspaceFolderPath, workflowKey);
      return {
        workflowName:
          descriptor.workflowName?.trim().length > 0
            ? descriptor.workflowName
            : this.deriveWorkflowName(workflowId),
        workflowFilePath,
      };
    } catch {
      return {
        workflowName: this.deriveWorkflowName(workflowId),
        workflowFilePath: "",
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
    runIndex: number
  ): HistorySearchResult[] {
    switch (event.eventType) {
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED:
        return this.collectCliOutputMatches(
          event as CliOutputRecordedEvent,
          query,
          manifest,
          metadata,
          runIndex
        );
      case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
        return this.collectStatusMatches(
          event as StatusMessageRecordedEvent,
          query,
          manifest,
          metadata,
          runIndex
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
    runIndex: number
  ): HistorySearchResult[] {
    const cliOutput = event.payload.cliOutput;
    const candidates: MatchCandidate[] = [];

    this.addCandidateIfMatch(candidates, "prompt", cliOutput.prompt, query);
    this.addCandidateIfMatch(candidates, "response", cliOutput.response, query);
    this.addCandidateIfMatch(candidates, "bash", cliOutput.cliCommand, query);

    if (cliOutput.structured?.events) {
      for (const structuredEvent of cliOutput.structured.events) {
        candidates.push(
          ...this.collectStructuredEventMatches(structuredEvent, query)
        );
      }
    }

    return candidates.map((candidate) =>
      this.buildResult(
        manifest,
        metadata,
        runIndex,
        event.target,
        event.attemptIndex,
        query,
        candidate
      )
    );
  }

  private collectStructuredEventMatches(
    event: CliEvent,
    query: string
  ): MatchCandidate[] {
    const candidates: MatchCandidate[] = [];
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT:
        this.addCandidateIfMatch(
          candidates,
          "response",
          this.getStringValue((event.data as { text?: unknown }).text),
          query
        );
        break;
      case CLI_EVENT_TYPES.THINKING:
        this.addCandidateIfMatch(
          candidates,
          "response",
          this.getStringValue((event.data as { text?: unknown }).text),
          query
        );
        break;
      case CLI_EVENT_TYPES.BASH_COMMAND: {
        const data = event.data as {
          command?: unknown;
          output?: unknown;
          error?: unknown;
        };
        this.addCandidateIfMatch(
          candidates,
          "bash",
          this.getStringValue(data.command),
          query
        );
        this.addCandidateIfMatch(
          candidates,
          "bash",
          this.getStringValue(data.output),
          query
        );
        this.addCandidateIfMatch(
          candidates,
          "bash",
          this.getStringValue(data.error),
          query
        );
        break;
      }
      case CLI_EVENT_TYPES.FILE_READ:
      case CLI_EVENT_TYPES.FILE_WRITE:
      case CLI_EVENT_TYPES.FILE_EDIT:
      case CLI_EVENT_TYPES.FILE_DELETE: {
        const data = event.data as {
          path?: unknown;
          structuredPatch?: unknown;
        };
        const filePath = this.getStringValue(data.path);
        this.addCandidateIfMatch(candidates, "file", filePath, query, filePath);
        if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
          const diffText = this.flattenStructuredPatch(data.structuredPatch);
          this.addCandidateIfMatch(
            candidates,
            "diff",
            diffText,
            query,
            filePath
          );
        }
        break;
      }
      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as { server?: unknown; tool?: unknown };
        this.addCandidateIfMatch(
          candidates,
          "tool",
          this.getStringValue(data.server),
          query
        );
        this.addCandidateIfMatch(
          candidates,
          "tool",
          this.getStringValue(data.tool),
          query
        );
        break;
      }
      case CLI_EVENT_TYPES.TOOL_CALL: {
        const data = event.data as { name?: unknown; parameters?: unknown };
        this.addCandidateIfMatch(
          candidates,
          "tool",
          this.getStringValue(data.name),
          query
        );
        this.addCandidateIfMatch(
          candidates,
          "tool",
          this.stringifyValue(data.parameters),
          query
        );
        break;
      }
      case CLI_EVENT_TYPES.TOOL_RESULT: {
        const result = (
          event.data as {
            result?: { output?: unknown; error?: unknown };
          }
        ).result;
        this.addCandidateIfMatch(
          candidates,
          "tool",
          this.getStringValue(result?.output),
          query
        );
        this.addCandidateIfMatch(
          candidates,
          "tool",
          this.getStringValue(result?.error),
          query
        );
        break;
      }
      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as {
          query?: unknown;
          results?: Array<{ title?: string; snippet?: string; url?: string }>;
        };
        this.addCandidateIfMatch(
          candidates,
          "tool",
          this.getStringValue(data.query),
          query
        );
        for (const result of data.results ?? []) {
          this.addCandidateIfMatch(
            candidates,
            "response",
            this.getStringValue(result.title),
            query
          );
          this.addCandidateIfMatch(
            candidates,
            "response",
            this.getStringValue(result.snippet),
            query
          );
          this.addCandidateIfMatch(
            candidates,
            "response",
            this.getStringValue(result.url),
            query
          );
        }
        break;
      }
      case CLI_EVENT_TYPES.COMPACTION:
        this.addCandidateIfMatch(
          candidates,
          "response",
          this.getStringValue((event.data as { summary?: unknown }).summary),
          query
        );
        break;
      default:
        break;
    }

    return candidates;
  }

  private collectStatusMatches(
    event: StatusMessageRecordedEvent,
    query: string,
    manifest: WorkflowRunManifest,
    metadata: WorkflowMetadata,
    runIndex: number
  ): HistorySearchResult[] {
    const message = event.payload.statusMessage.message;
    if (!this.matchesQuery(message, query)) {
      return [];
    }

    return [
      this.buildResult(manifest, metadata, runIndex, event.target, 0, query, {
        matchType: "status",
        text: message,
      }),
    ];
  }

  private buildResult(
    manifest: WorkflowRunManifest,
    metadata: WorkflowMetadata,
    runIndex: number,
    target: OutputExecutionTarget,
    attemptIndex: number,
    query: string,
    candidate: MatchCandidate
  ): HistorySearchResult {
    return {
      workflowId: manifest.workflowId,
      workflowName: metadata.workflowName,
      runId: manifest.runId,
      runIndex,
      startedAt: manifest.startedAt,
      executionState: manifest.executionState,
      target,
      matchType: candidate.matchType,
      matchSnippet: this.extractSnippet(candidate.text, query),
      matchContext: this.formatMatchContext(target, attemptIndex),
      filePath: candidate.filePath,
      workflowFilePath: metadata.workflowFilePath,
    };
  }

  private addCandidateIfMatch(
    candidates: MatchCandidate[],
    matchType: HistorySearchResult["matchType"],
    text: string | undefined,
    query: string,
    filePath?: string
  ): void {
    if (!text || !this.matchesQuery(text, query)) {
      return;
    }
    candidates.push({ matchType, text, filePath });
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

  private flattenStructuredPatch(structuredPatch: unknown): string | undefined {
    if (!Array.isArray(structuredPatch)) {
      return undefined;
    }

    const lines = structuredPatch.flatMap((hunk) => {
      if (!hunk || typeof hunk !== "object") {
        return [];
      }
      const hunkLines = (hunk as { lines?: unknown }).lines;
      return Array.isArray(hunkLines)
        ? hunkLines.filter((line): line is string => typeof line === "string")
        : [];
    });

    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private getStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private stringifyValue(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private deriveWorkflowName(workflowId: string): string {
    return workflowId.replace(
      /-\d{4}-\d{2}-\d{2}T\d{2}(?:-\d{2}){2}(?:-\d{3})?Z?$/,
      ""
    );
  }

  private getResultKey(result: HistorySearchResult): string {
    return [
      result.workflowId,
      result.runId,
      result.runIndex,
      result.matchType,
      result.matchContext,
      result.filePath ?? "",
      result.matchSnippet,
    ].join("::");
  }
}
