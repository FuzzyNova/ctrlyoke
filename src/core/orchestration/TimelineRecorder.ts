import * as fs from "fs";
import * as path from "path";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_SCHEMA_VERSION,
  TIMELINE_STORAGE_FILES,
  TIMELINE_STORAGE_KIND,
  type WorkflowDefinitionSnapshot,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";
import type { ExecutionState } from "../../types/DashboardConstants";
import { withFileLock } from "../../utils/FileLockUtils";
import { splitLines, streamFileLines } from "../../utils/TextLines";
import { invalidateRunSummaryFor } from "./RunSummaryCache";
import { secretRedactionService } from "../../utils/SecretRedactionService";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";
import { migrateToCurrent } from "../../utils/FormatMigrations";
import { truncateCliEventTextFields } from "../../utils/CliEventText";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";

export class TimelineRecorder {
  static readonly MANIFEST_FILE_NAME = TIMELINE_STORAGE_FILES.MANIFEST;
  static readonly EVENTS_FILE_NAME = TIMELINE_STORAGE_FILES.EVENTS;
  private static readonly manifestOperationQueues = new Map<
    string,
    Promise<void>
  >();

  static getManifestPathForRunDirectory(runDirectoryPath: string): string {
    return path.join(runDirectoryPath, this.MANIFEST_FILE_NAME);
  }

  static getEventsPathFromManifestPath(manifestPath: string): string {
    return path.join(path.dirname(manifestPath), this.EVENTS_FILE_NAME);
  }

  /**
   * Initializes manifest.json/events.jsonl inside an already-allocated run directory.
   * The directory itself is created (exclusively) by `WorkflowLineageRepository.allocateRun`;
   * this only populates the two timeline files within it.
   */
  async initializeRunAt(
    runDirectoryPath: string,
    workflowId: string,
    runId: number,
    startedAt: number,
    executionState: ExecutionState,
    definitionRevision: number = 1,
    initialDefinition?: WorkflowDefinitionSnapshot
  ): Promise<string> {
    const manifestPath =
      TimelineRecorder.getManifestPathForRunDirectory(runDirectoryPath);
    const eventsPath =
      TimelineRecorder.getEventsPathFromManifestPath(manifestPath);
    try {
      const manifestStat = await fs.promises.lstat(manifestPath);
      if (manifestStat.isFile() && !manifestStat.isSymbolicLink()) {
        assertWritableSchema(
          PERSISTED_STORES.TIMELINE,
          await this.readManifest(manifestPath),
          manifestPath
        );
      }
      const eventsStat = await fs.promises.lstat(eventsPath);
      if (
        manifestStat.isFile() &&
        !manifestStat.isSymbolicLink() &&
        eventsStat.isFile() &&
        !eventsStat.isSymbolicLink()
      ) {
        return manifestPath;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const manifest: WorkflowRunManifest = {
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      storageKind: TIMELINE_STORAGE_KIND,
      workflowId,
      runId,
      startedAt,
      executionState,
      definitionRevision,
      ...(initialDefinition ? { initialDefinition } : {}),
      stepCount: 0,
      eventCount: 0,
      nextSequence: 1,
      lastUpdatedAt: startedAt,
    };

    await fs.promises.mkdir(runDirectoryPath, { recursive: true });
    await this.writeManifestDirect(manifestPath, manifest);
    await fs.promises.writeFile(eventsPath, "", "utf8");

    return manifestPath;
  }

  async readManifest(manifestPath: string): Promise<WorkflowRunManifest> {
    const content = await fs.promises.readFile(manifestPath, "utf8");
    return migrateToCurrent(PERSISTED_STORES.TIMELINE, JSON.parse(content))
      .doc as WorkflowRunManifest;
  }

  private async writeManifestDirect(
    manifestPath: string,
    manifest: WorkflowRunManifest
  ): Promise<void> {
    assertWritableSchema(PERSISTED_STORES.TIMELINE, manifest, manifestPath);
    try {
      await writeFileAtomic(
        manifestPath,
        JSON.stringify(
          secretRedactionService.redactValue({
            ...manifest,
            schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.TIMELINE],
          }),
          null,
          2
        )
      );
    } finally {
      // The single writer of the manifest half of a run summary. In `finally`
      // because a failed atomic replacement can leave the old manifest in
      // place, while a successful replacement changes the cached summary.
      invalidateRunSummaryFor(manifestPath);
    }
  }

  async readEvents(manifestPath: string): Promise<WorkflowTimelineEvent[]> {
    const eventsPath =
      TimelineRecorder.getEventsPathFromManifestPath(manifestPath);

    try {
      const content = await fs.promises.readFile(eventsPath, "utf8");
      if (!content.trim()) {
        return [];
      }

      const lines = splitLines(content);
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

  /**
   * Streams timeline events in their append/sequence order without first
   * materializing events.jsonl. A partially written final JSONL line is
   * ignored, matching `readEvents` crash-recovery semantics.
   */
  async *streamEvents(
    manifestPath: string
  ): AsyncGenerator<WorkflowTimelineEvent, void, undefined> {
    const eventsPath =
      TimelineRecorder.getEventsPathFromManifestPath(manifestPath);
    let pendingParseError: unknown;

    try {
      for await (const rawLine of streamFileLines(eventsPath)) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        if (pendingParseError) {
          throw pendingParseError;
        }
        try {
          yield JSON.parse(line) as WorkflowTimelineEvent;
        } catch (error) {
          // Keep consuming so only a malformed trailing line is tolerated.
          pendingParseError = error;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  /**
   * Streams the event projection needed by history indexing. Candidate text is
   * capped before the event is handed to the indexer, so processed event data
   * is not retained in the run's shard beyond the configured limit.
   * `readEvents` remains the lossless reader used by replay/history callers.
   */
  async *streamEventsForHistorySearch(
    manifestPath: string,
    maxTextLength: number,
    onStringTruncated?: () => void
  ): AsyncGenerator<WorkflowTimelineEvent, void, undefined> {
    for await (const event of this.streamEvents(manifestPath)) {
      yield truncateHistorySearchEvent(event, maxTextLength, onStringTruncated);
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
        assertWritableSchema(PERSISTED_STORES.TIMELINE, manifest, manifestPath);
        let nextSequence = manifest.nextSequence;

        const events: WorkflowTimelineEvent[] = drafts.map((draft) => ({
          ...draft,
          workflowId: manifest.workflowId,
          runId: manifest.runId,
          sequence: nextSequence++,
        }));
        const redactedEvents = secretRedactionService.redactValue(events);

        await fs.promises.appendFile(
          TimelineRecorder.getEventsPathFromManifestPath(manifestPath),
          `${redactedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
          "utf8"
        );

        const lastEventTimestamp = events[events.length - 1].timestampMs;
        await this.writeManifestDirect(manifestPath, {
          ...manifest,
          eventCount: manifest.eventCount + events.length,
          nextSequence,
          lastUpdatedAt: Math.max(manifest.lastUpdatedAt, lastEventTimestamp),
        });

        return redactedEvents;
      })
    );
  }

  /**
   * Commit a `DEFINITION_REVISION_COMMITTED` snapshot for `definitionRevision`, but only
   * if it is newer than the manifest's currently recorded revision. No-ops (returns
   * `committed: false`) for a revision the manifest already reflects, so repeated calls
   * from every output-writing call site for the same revision are cheap and race-safe —
   * the read-decide-write happens atomically under this manifest's serialized queue+lock,
   * the same guarantee `appendEvents`/`updateManifest` rely on individually.
   *
   * `initializeRunAt` seeds the manifest at the run's actual starting `definitionRevision`
   * (1 for a fresh run), so the initial revision never gets a redundant event here — the
   * run's own `workflow.ctrlyoke.json`, written at promotion, is already the exact record of
   * what that revision is. Only later revisions (definition changes after the run started)
   * need a timeline event, because those are the ones a reader scanning only events.jsonl
   * would otherwise have no durable record of.
   */
  async commitDefinitionRevisionIfNewer(
    manifestPath: string,
    definitionRevision: number,
    definition: WorkflowDefinitionSnapshot,
    timestampMs: number
  ): Promise<{ committed: boolean; event?: WorkflowTimelineEvent }> {
    return this.runSerializedManifestOperation(manifestPath, async () =>
      withFileLock(manifestPath, async () => {
        const manifest = await this.readManifest(manifestPath);
        assertWritableSchema(PERSISTED_STORES.TIMELINE, manifest, manifestPath);
        if (definitionRevision <= manifest.definitionRevision) {
          return { committed: false };
        }

        const event: WorkflowTimelineEvent = {
          eventType: TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED,
          timestampMs,
          workflowId: manifest.workflowId,
          runId: manifest.runId,
          sequence: manifest.nextSequence,
          payload: {
            definitionRevision,
            priorDefinitionRevision: manifest.definitionRevision,
            definition,
          },
        };

        const redactedEvent = secretRedactionService.redactValue(event);
        await fs.promises.appendFile(
          TimelineRecorder.getEventsPathFromManifestPath(manifestPath),
          `${JSON.stringify(redactedEvent)}\n`,
          "utf8"
        );

        await this.writeManifestDirect(manifestPath, {
          ...manifest,
          definitionRevision,
          eventCount: manifest.eventCount + 1,
          nextSequence: manifest.nextSequence + 1,
          lastUpdatedAt: Math.max(manifest.lastUpdatedAt, timestampMs),
        });

        return { committed: true, event: redactedEvent };
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

  /**
   * Reopen an existing run for an explicit continuation.  Unlike
   * {@link initializeRunAt}, this deliberately retains the run's identity and
   * append-only timeline counters: a continuation is another execution of the
   * same durable run, not a new run.
   */
  async reopenRun(
    manifestPath: string,
    executionState: ExecutionState,
    definitionRevision: number,
    stepCount: number,
    timestampMs: number = Date.now()
  ): Promise<WorkflowRunManifest> {
    return this.updateManifest(manifestPath, (manifest) => ({
      ...manifest,
      completedAt: undefined,
      executionState,
      definitionRevision,
      stepCount,
      lastUpdatedAt: Math.max(manifest.lastUpdatedAt, timestampMs),
    }));
  }

  async flushPendingOperations(manifestPath?: string): Promise<void> {
    if (manifestPath) {
      await (TimelineRecorder.manifestOperationQueues.get(
        path.resolve(manifestPath)
      ) ?? Promise.resolve());
      return;
    }
    await Promise.all(TimelineRecorder.manifestOperationQueues.values());
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

function truncateHistorySearchEvent(
  event: WorkflowTimelineEvent,
  maxTextLength: number,
  onStringTruncated?: () => void
): WorkflowTimelineEvent {
  if (event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED) {
    const cliOutput = event.payload.cliOutput;
    cliOutput.prompt = truncateString(
      cliOutput.prompt,
      maxTextLength,
      onStringTruncated
    );
    cliOutput.cliCommand = truncateString(
      cliOutput.cliCommand,
      maxTextLength,
      onStringTruncated
    );
    for (const structuredEvent of cliOutput.structured?.events ?? []) {
      truncateCliEventTextFields(
        structuredEvent,
        maxTextLength,
        onStringTruncated
      );
    }
  } else if (
    event.eventType === TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED
  ) {
    event.payload.stdout = truncateRequiredString(
      event.payload.stdout,
      maxTextLength,
      onStringTruncated
    );
    event.payload.stderr = truncateRequiredString(
      event.payload.stderr,
      maxTextLength,
      onStringTruncated
    );
  } else if (
    event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED
  ) {
    for (const structuredEvent of event.payload.events) {
      truncateCliEventTextFields(
        structuredEvent,
        maxTextLength,
        onStringTruncated
      );
    }
  } else if (event.eventType === TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED) {
    event.payload.statusMessage.message = truncateRequiredString(
      event.payload.statusMessage.message,
      maxTextLength,
      onStringTruncated
    );
  }

  return event;
}

function truncateString(
  value: string | undefined,
  maxTextLength: number,
  onStringTruncated?: () => void
): string | undefined {
  if (value && value.length > maxTextLength) {
    onStringTruncated?.();
    return value.slice(0, maxTextLength);
  }
  return value;
}

function truncateRequiredString(
  value: string,
  maxTextLength: number,
  onStringTruncated?: () => void
): string {
  if (value.length > maxTextLength) {
    onStringTruncated?.();
    return value.slice(0, maxTextLength);
  }
  return value;
}
