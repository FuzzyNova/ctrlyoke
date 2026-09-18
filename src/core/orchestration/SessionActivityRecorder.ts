import { HarnessIntegration } from "../HarnessIntegration";
import { PromptQueue } from "../PromptQueue";
import {
  FINAL_STEP_PHASES,
  CLI_EVENT_TYPES,
  OUTPUT_ACTIVITY_KINDS,
} from "../../types/DashboardConstants";
import type { IDashboardSink } from "../../types/IDashboardSink";
import type {
  CliEvent,
  CliOutput,
  ContextWindowSyncData,
  FollowUpResumedData,
} from "../../types/WebviewMessageTypes";
import type {
  OutputActivityEntry,
  OutputExecutionTarget,
} from "../../types/OutputHistoryTypes";
import type { WorkflowAttemptTarget } from "../../types/CtrlYokeTypes";
import {
  OutputHistoryManager,
  type DefinitionRevisionContext,
} from "./OutputHistoryManager";
import { getCliEntryKey } from "./OutputHistoryTimelineAdapter";
import { extractTextFromEvents } from "../harness/shared/CliResponseTextExtractor";
import { Log } from "../../utils/Log";

export interface SessionActivityRecorderPort {
  readonly id: string;
  readonly dashboardSink: IDashboardSink | undefined;
  readonly promptQueue: PromptQueue;
  readonly outputHistoryManager: OutputHistoryManager;
  readonly resolveHistoryFilePath: () => string;
  readonly getDefinitionRevisionContext: () => DefinitionRevisionContext;
}

interface CompletedActivityTarget {
  target: OutputExecutionTarget;
  runIndex: number;
  attemptIndex: number;
}

/** Persists activity that resumes after a completed harness attempt. */
export class SessionActivityRecorder {
  private readonly activityIntegrationIds = new WeakMap<
    HarnessIntegration,
    string
  >();
  private nextActivityIntegrationId = 1;
  private readonly completedActivityTargets = new Map<
    string,
    CompletedActivityTarget
  >();
  private readonly latestCompletedActivityBySession = new Map<
    string,
    CompletedActivityTarget
  >();
  /** Compatibility bridge for callers that do not yet supply integration identity. */
  private legacyCompletedActivityTarget?: CompletedActivityTarget;
  /** @deprecated Kept only for older in-process callers during target migration. */
  private lastCompletedActivityTarget?: CompletedActivityTarget;
  /** Events that arrive in the monitor-to-session-watcher handoff window. */
  private readonly pendingSessionActivityEvents = new Map<string, CliEvent[]>();
  /** Per-attempt tail of follow-up persistence. */
  private readonly followUpPersistQueue = new Map<string, Promise<void>>();
  private readonly pendingSessionActivityIntegrations = new Map<
    string,
    { integration: HarnessIntegration; sessionId: string | undefined }
  >();

  constructor(private readonly port: SessionActivityRecorderPort) {}

  clear(): void {
    this.completedActivityTargets.clear();
    this.latestCompletedActivityBySession.clear();
    this.legacyCompletedActivityTarget = undefined;
    this.lastCompletedActivityTarget = undefined;
    this.pendingSessionActivityEvents.clear();
    this.pendingSessionActivityIntegrations.clear();
    this.followUpPersistQueue.clear();
  }

  getActivityIntegrationId(integration?: HarnessIntegration): string {
    if (!integration) {
      return "legacy";
    }
    let id = this.activityIntegrationIds.get(integration);
    if (!id) {
      id = `integration:${this.nextActivityIntegrationId++}`;
      this.activityIntegrationIds.set(integration, id);
    }
    return id;
  }

  getActivitySessionKey(
    integration: HarnessIntegration | undefined,
    sessionId: string | undefined
  ): string {
    return `${this.getActivityIntegrationId(integration)}:${sessionId ?? "unknown"}`;
  }

  getActivityTargetKey(
    integration: HarnessIntegration,
    sessionId: string | undefined,
    target: OutputExecutionTarget
  ): string {
    const targetKey =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? `queue:${target.stepIndex}`
        : `final:${target.loopIndex}`;
    return `${this.getActivitySessionKey(integration, sessionId)}:${targetKey}`;
  }

  recordCompletedActivityTarget(
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    integration?: HarnessIntegration
  ): void {
    const activity = { target, runIndex, attemptIndex };
    if (!integration) {
      this.legacyCompletedActivityTarget = activity;
      this.lastCompletedActivityTarget = activity;
      for (const [sessionKey, pendingEvents] of this
        .pendingSessionActivityEvents) {
        const pendingIntegration =
          this.pendingSessionActivityIntegrations.get(sessionKey);
        if (pendingIntegration) {
          this.pendingSessionActivityEvents.delete(sessionKey);
          this.pendingSessionActivityIntegrations.delete(sessionKey);
          void this.handleSessionActivityResumed(
            pendingEvents,
            pendingIntegration.integration,
            pendingIntegration.sessionId
          );
        }
      }
      return;
    }
    const sessionId = integration.getActivitySessionId();
    const sessionKey = this.getActivitySessionKey(integration, sessionId);
    this.completedActivityTargets.set(
      this.getActivityTargetKey(integration, sessionId, target),
      activity
    );
    this.latestCompletedActivityBySession.set(sessionKey, activity);
    const pendingEvents = this.pendingSessionActivityEvents.get(sessionKey);
    if (!pendingEvents || pendingEvents.length === 0) {
      return;
    }
    this.pendingSessionActivityEvents.delete(sessionKey);
    void this.handleSessionActivityResumed(
      pendingEvents,
      integration,
      sessionId
    );
  }

  beginActivityTargetCapture(
    integration?: HarnessIntegration,
    _target?: WorkflowAttemptTarget
  ): void {
    // The completed target remains addressable until its watcher emits or the
    // integration is retired. Do not clear siblings when another target starts.
    if (integration) {
      this.getActivityIntegrationId(integration);
    } else {
      this.legacyCompletedActivityTarget = undefined;
      this.lastCompletedActivityTarget = undefined;
      this.pendingSessionActivityEvents.clear();
      this.pendingSessionActivityIntegrations.clear();
    }
  }

  getExecutionTargetRunKey(
    target: OutputExecutionTarget | WorkflowAttemptTarget
  ): `queue:${number}` | `final:${number}` {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  }

  /** Forward resumed activity live, then merge it into the completed attempt. */
  async handleSessionActivityResumed(
    events: CliEvent[],
    integration?: HarnessIntegration,
    sessionId?: string
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const sessionKey = this.getActivitySessionKey(integration, sessionId);
    const activityTarget =
      this.latestCompletedActivityBySession.get(sessionKey) ??
      this.legacyCompletedActivityTarget ??
      this.lastCompletedActivityTarget;
    if (!activityTarget) {
      Log.trace(
        `[inst:${this.port.id.slice(0, 8)}] Session activity resumed before completed step attribution — buffering`
      );
      const pending = this.pendingSessionActivityEvents.get(sessionKey) ?? [];
      pending.push(...events);
      this.pendingSessionActivityEvents.set(sessionKey, pending);
      if (integration) {
        this.pendingSessionActivityIntegrations.set(sessionKey, {
          integration,
          sessionId,
        });
      }
      return;
    }
    const { target, runIndex, attemptIndex } = activityTarget;

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      this.port.dashboardSink?.updateCliStreamingEvents(
        target.stepIndex,
        events,
        attemptIndex,
        runIndex,
        this.port.id
      );
    } else {
      this.port.dashboardSink?.updateFinalStepStreamingEvents(
        target.loopIndex,
        events,
        attemptIndex,
        runIndex,
        this.port.id
      );
    }

    const contentEvents = events.filter(
      (event) => event.type !== CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC
    );
    const followUpText = extractTextFromEvents({ events: contentEvents });
    const latestContextWindowSync = [...events]
      .reverse()
      .find((event) => event.type === CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC)
      ?.data as ContextWindowSyncData | undefined;

    await this.enqueueFollowUpPersist(target, runIndex, attemptIndex, () =>
      this.persistResumedSessionActivity(
        target,
        runIndex,
        attemptIndex,
        contentEvents,
        followUpText,
        latestContextWindowSync
          ? {
              used: latestContextWindowSync.used,
              size: latestContextWindowSync.size,
            }
          : undefined
      )
    );
  }

  enqueueFollowUpPersist(
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    work: () => Promise<void>
  ): Promise<void> {
    const key = getCliEntryKey(target, runIndex, attemptIndex);
    const tail = (this.followUpPersistQueue.get(key) ?? Promise.resolve()).then(
      work
    );
    // The stored tail never rejects, so one failed burst cannot poison the
    // chain for the bursts queued behind it.
    const guarded = tail.catch(() => undefined);
    this.followUpPersistQueue.set(key, guarded);
    void guarded.then(() => {
      if (this.followUpPersistQueue.get(key) === guarded) {
        this.followUpPersistQueue.delete(key);
      }
    });
    return tail;
  }

  async persistResumedSessionActivity(
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    contentEvents: CliEvent[],
    followUpText: string,
    contextWindow: { used: number; size: number } | undefined
  ): Promise<void> {
    const historyFilePath = this.port.resolveHistoryFilePath();
    let existingOutput: CliOutput | undefined;
    if (historyFilePath) {
      try {
        existingOutput = (
          await this.port.outputHistoryManager
            .getRunOutputResolver()
            .resolveAttempt(historyFilePath, target, runIndex, attemptIndex)
        )?.output;
      } catch (error) {
        Log.warn(
          `[inst:${this.port.id.slice(0, 8)}] Failed to resolve attempt for resumed session activity:`,
          error
        );
      }
    }

    const existingEvents = existingOutput?.structured?.events ?? [];
    const hasFollowUpDivider = existingEvents.some(
      (event) => event.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED
    );
    const eventsToAppend: CliEvent[] =
      contentEvents.length > 0 && existingOutput && !hasFollowUpDivider
        ? [
            {
              type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
              timestamp: Date.now(),
              data: { resumedAt: Date.now() } as FollowUpResumedData,
            },
            ...contentEvents,
          ]
        : contentEvents;

    if (historyFilePath) {
      try {
        await this.port.outputHistoryManager.recordFollowUpResponse(
          historyFilePath,
          target,
          runIndex,
          attemptIndex,
          followUpText,
          eventsToAppend,
          contextWindow,
          this.port.getDefinitionRevisionContext()
        );
      } catch (error) {
        Log.warn(
          `[inst:${this.port.id.slice(0, 8)}] Failed to persist resumed session activity event:`,
          error
        );
      }
    }
    if (followUpText) {
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        this.port.promptQueue.appendPromptResponseText(
          target.stepIndex,
          followUpText
        );
      } else {
        this.port.promptQueue.appendFinalStepResponseText(
          target.loopIndex,
          followUpText
        );
      }
    }

    if (!historyFilePath || !existingOutput) {
      return;
    }
    try {
      const merged: CliOutput = {
        ...existingOutput,
        response: existingOutput.response + followUpText,
        structured: existingOutput.structured
          ? {
              ...existingOutput.structured,
              events: [...existingEvents, ...eventsToAppend],
            }
          : undefined,
        tokens:
          contextWindow && existingOutput.tokens
            ? {
                ...existingOutput.tokens,
                contextWindowUsed: contextWindow.used,
                contextWindowSize: contextWindow.size,
              }
            : existingOutput.tokens,
        elapsed:
          existingOutput.timestampMs != null
            ? (Date.now() - existingOutput.timestampMs) / 1000
            : existingOutput.elapsed,
      };
      await this.port.outputHistoryManager.saveExecutionOutput(
        historyFilePath,
        target,
        [merged],
        this.port.getDefinitionRevisionContext()
      );
    } catch (error) {
      Log.warn(
        `[inst:${this.port.id.slice(0, 8)}] Failed to persist resumed session activity to history:`,
        error
      );
    }
  }

  publishOutputActivity(entry: OutputActivityEntry): void {
    if (!this.port.dashboardSink) {
      return;
    }

    if (entry.target.kind === FINAL_STEP_PHASES.QUEUE) {
      if (entry.kind === OUTPUT_ACTIVITY_KINDS.TEXT) {
        this.port.dashboardSink.updateCliStreamingChunk(
          entry.target.stepIndex,
          entry.text ?? "",
          entry.phase,
          this.port.id,
          entry.timestampMs,
          entry.sequence,
          entry.attemptIndex,
          entry.runIndex
        );
      } else if (
        entry.kind === OUTPUT_ACTIVITY_KINDS.STRUCTURED &&
        entry.events
      ) {
        this.port.dashboardSink.updateCliStreamingEvents(
          entry.target.stepIndex,
          entry.events,
          entry.attemptIndex,
          entry.runIndex,
          this.port.id,
          entry.phase,
          entry.timestampMs,
          entry.sequence
        );
      }
      return;
    }

    if (entry.kind === OUTPUT_ACTIVITY_KINDS.TEXT) {
      this.port.dashboardSink.updateFinalStepStreamingChunk(
        entry.target.loopIndex,
        entry.text ?? "",
        entry.phase,
        this.port.id,
        entry.timestampMs,
        entry.sequence,
        entry.attemptIndex,
        entry.runIndex
      );
    } else if (
      entry.kind === OUTPUT_ACTIVITY_KINDS.STRUCTURED &&
      entry.events
    ) {
      this.port.dashboardSink.updateFinalStepStreamingEvents(
        entry.target.loopIndex,
        entry.events,
        entry.attemptIndex,
        entry.runIndex,
        this.port.id,
        entry.phase,
        entry.timestampMs,
        entry.sequence
      );
    }
  }
}
