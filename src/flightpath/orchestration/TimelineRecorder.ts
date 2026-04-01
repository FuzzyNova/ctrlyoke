import * as fs from "fs";
import * as path from "path";
import {
  TIMELINE_SCHEMA_VERSION,
  TIMELINE_STORAGE_FILES,
  TIMELINE_STORAGE_KIND,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";
import type { ExecutionState } from "../../types/DashboardConstants";
import { withFileLock } from "../../utils/FileLockUtils";

export class TimelineRecorder {
  static readonly MANIFEST_FILE_NAME = TIMELINE_STORAGE_FILES.MANIFEST;
  static readonly EVENTS_FILE_NAME = TIMELINE_STORAGE_FILES.EVENTS;
  private static readonly manifestOperationQueues = new Map<
    string,
    Promise<void>
  >();

  static createRunDirectoryName(timestampMs: number): string {
    const timestamp = new Date(timestampMs).toISOString().replace(/[:.]/g, "-");
    return `run-${timestamp}`;
  }

  static isLegacyRunFile(entryName: string): boolean {
    return /^run-.*\.json$/.test(entryName);
  }

  static isTimelineRunDirectory(entryName: string): boolean {
    return /^run-/.test(entryName) && !entryName.endsWith(".json");
  }

  static isRunEntry(entry: fs.Dirent): boolean {
    return (
      (entry.isFile() && this.isLegacyRunFile(entry.name)) ||
      (entry.isDirectory() && this.isTimelineRunDirectory(entry.name))
    );
  }

  static getManifestPathForRunDirectory(runDirectoryPath: string): string {
    return path.join(runDirectoryPath, this.MANIFEST_FILE_NAME);
  }

  static getEventsPathFromManifestPath(manifestPath: string): string {
    return path.join(path.dirname(manifestPath), this.EVENTS_FILE_NAME);
  }

  static extractRunTimestamp(entryName: string): number {
    const match = entryName.match(
      /^run-(?:\d+-)?(\d{4}-\d{2}-\d{2}T[\d-]+Z?)(?:\.json)?$/
    );
    if (!match) {
      return 0;
    }

    const restored = match[1].replace(
      /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z?)$/,
      "$1$2:$3:$4.$5"
    );
    const timestampMs = new Date(restored).getTime();
    return Number.isNaN(timestampMs) ? 0 : timestampMs;
  }

  async initializeRun(
    historyDir: string,
    workflowId: string,
    runId: number,
    startedAt: number,
    executionState: ExecutionState
  ): Promise<string> {
    const runDirectoryName = TimelineRecorder.createRunDirectoryName(startedAt);
    const runDirectoryPath = path.join(historyDir, runDirectoryName);
    const manifestPath =
      TimelineRecorder.getManifestPathForRunDirectory(runDirectoryPath);
    const manifest: WorkflowRunManifest = {
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      storageKind: TIMELINE_STORAGE_KIND,
      workflowId,
      runId,
      startedAt,
      executionState,
      runStepCount: 0,
      eventCount: 0,
      nextSequence: 1,
      lastUpdatedAt: startedAt,
    };

    await fs.promises.mkdir(runDirectoryPath, { recursive: true });
    await this.writeManifestDirect(manifestPath, manifest);
    await fs.promises.writeFile(
      TimelineRecorder.getEventsPathFromManifestPath(manifestPath),
      "",
      "utf8"
    );

    return manifestPath;
  }

  async readManifest(manifestPath: string): Promise<WorkflowRunManifest> {
    const content = await fs.promises.readFile(manifestPath, "utf8");
    return JSON.parse(content) as WorkflowRunManifest;
  }

  private async writeManifestDirect(
    manifestPath: string,
    manifest: WorkflowRunManifest
  ): Promise<void> {
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
  }

  async readEvents(manifestPath: string): Promise<WorkflowTimelineEvent[]> {
    const eventsPath =
      TimelineRecorder.getEventsPathFromManifestPath(manifestPath);

    try {
      const content = await fs.promises.readFile(eventsPath, "utf8");
      if (!content.trim()) {
        return [];
      }

      const lines = content.split(/\r?\n/);
      const events: WorkflowTimelineEvent[] = [];

      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        try {
          events.push(JSON.parse(line) as WorkflowTimelineEvent);
        } catch (error) {
          const isLastLine = index === lines.length - 1;
          if (isLastLine) {
            break;
          }
          throw error;
        }
      }

      return events;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async appendEvents(
    manifestPath: string,
    drafts: WorkflowTimelineEventDraft[]
  ): Promise<WorkflowTimelineEvent[]> {
    if (drafts.length === 0) {
      return [];
    }

    return this.runSerializedManifestOperation(manifestPath, async () =>
      withFileLock(manifestPath, async () => {
        const manifest = await this.readManifest(manifestPath);
        let nextSequence = manifest.nextSequence;

        const events: WorkflowTimelineEvent[] = drafts.map((draft) => ({
          ...draft,
          workflowId: manifest.workflowId,
          runId: manifest.runId,
          sequence: nextSequence++,
        }));

        await fs.promises.appendFile(
          TimelineRecorder.getEventsPathFromManifestPath(manifestPath),
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          "utf8"
        );

        const lastEventTimestamp = events[events.length - 1].timestampMs;
        await this.writeManifestDirect(manifestPath, {
          ...manifest,
          eventCount: manifest.eventCount + events.length,
          nextSequence,
          lastUpdatedAt: Math.max(manifest.lastUpdatedAt, lastEventTimestamp),
        });

        return events;
      })
    );
  }

  async updateManifest(
    manifestPath: string,
    updater: (manifest: WorkflowRunManifest) => WorkflowRunManifest
  ): Promise<WorkflowRunManifest> {
    return this.runSerializedManifestOperation(manifestPath, async () =>
      withFileLock(manifestPath, async () => {
        const manifest = await this.readManifest(manifestPath);
        const updatedManifest = updater(manifest);
        await this.writeManifestDirect(manifestPath, updatedManifest);
        return updatedManifest;
      })
    );
  }

  private async runSerializedManifestOperation<T>(
    manifestPath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const queueKey = path.resolve(manifestPath);
    const previousOperation =
      TimelineRecorder.manifestOperationQueues.get(queueKey) ??
      Promise.resolve();
    const operationPromise = previousOperation.then(operation);
    const settledOperation = operationPromise.then(
      () => undefined,
      () => undefined
    );

    TimelineRecorder.manifestOperationQueues.set(queueKey, settledOperation);

    try {
      return await operationPromise;
    } finally {
      if (
        TimelineRecorder.manifestOperationQueues.get(queueKey) ===
        settledOperation
      ) {
        TimelineRecorder.manifestOperationQueues.delete(queueKey);
      }
    }
  }
}
