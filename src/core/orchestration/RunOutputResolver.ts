import * as path from "path";
import { type ExecutionState } from "../../types/DashboardConstants";
import type {
  PriorContext,
  ScriptRuntimeOutput,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import { isScriptStep } from "../../types/CtrlYokeTypes";
import {
  FINAL_STEP_PHASES,
  getExecutionPhaseKeySuffix,
  PRIOR_CONTEXT_ITEM_TYPES,
  PRIOR_CONTEXT_KEYWORDS,
  RUN_OUTPUT_RESOLVER_EVENT_KINDS,
  RUN_FILE_CHANGE_SCOPES,
  SCRIPT_OUTPUT_SOURCES,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type {
  CliEvent,
  FileDeleteData,
  FileEditData,
  FileWriteData,
} from "../../types/CliOutputTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_EVENT_TYPES,
  type TimelineAttemptKind,
  type TimelineAttemptStartReason,
  type TimelineAttemptTerminalState,
  type WorkflowRuntimeTransitionPayload,
  type WorkflowDefinitionSnapshot,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import {
  CLI_EVENT_TYPES,
  type ExecutionPhase,
} from "../../types/DashboardConstants";
import { normalizeCliEvents } from "../../utils/CliEventNormalizer";
import { StreamingCliOutputAccumulator } from "../../utils/StreamingCliOutputAccumulator";
import { evaluateFileAccess } from "../../utils/FileAccessPolicy";
import { Log } from "../../utils/Log";
import { TimelineRecorder } from "./TimelineRecorder";
import type { PriorContextItem } from "../HarnessIntegration";

/** Immutable definition and step selected for one persisted attempt. */
export interface ResolvedAttemptDefinition {
  definitionRevision: number;
  definition: WorkflowDefinitionSnapshot;
  step?: WorkflowStep;
}

/** Stable per-attempt identity shared by every resolver event. */
export interface ResolvedRunAttempt {
  target: OutputExecutionTarget;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  definition?: ResolvedAttemptDefinition;
}

interface ResolvedRunAttemptOutput extends ResolvedRunAttempt {
  output: CliOutput;
  /** Exact response used for runtime responseText and output previews. */
  responseText: string;
  kind: TimelineAttemptKind;
}

export interface ResolvedRunAttemptValue extends ResolvedRunAttempt {
  prompt?: string;
  kind?: TimelineAttemptKind;
  startReason?: TimelineAttemptStartReason;
  responseText?: string;
  output?: CliOutput;
  scriptOutput?: ScriptRuntimeOutput;
  terminalState?: TimelineAttemptTerminalState;
  terminalReason?: string;
}

export type RunFileChangeOperation = "created" | "modified" | "deleted";
export type RunFileChangeScope =
  (typeof RUN_FILE_CHANGE_SCOPES)[keyof typeof RUN_FILE_CHANGE_SCOPES];

export interface RunFileChangeProjection {
  /** Workspace-relative for workspace files; absolute only when explicitly external. */
  path: string;
  scope: RunFileChangeScope;
  operations: RunFileChangeOperation[];
}

export interface RunLatestAttemptProjection {
  /** Public 1-based ordinal across initial, retry, and resumed attempts. */
  number: number;
  startReason: TimelineAttemptStartReason;
  terminalState?: TimelineAttemptTerminalState;
  terminalReason?: string;
}

export interface RunAttemptProjection {
  target: OutputExecutionTarget;
  attempts: number;
  latestAttempt?: RunLatestAttemptProjection;
  filesChanged: RunFileChangeProjection[];
  scriptOutput?: ScriptRuntimeOutput;
}

export interface RunFinalStepProjection {
  loopCount: number;
  attempts: number;
  filesChanged: RunFileChangeProjection[];
  latestLoop?: RunAttemptProjection;
}

export interface RunOutputProjection {
  /** Queue targets only. Final-step loops are reduced into `finalStep`. */
  targets: Map<string, RunAttemptProjection>;
  finalStep?: RunFinalStepProjection;
}

export interface RunOutputProjectionOptions {
  workspaceRoot: string;
  /** Additional trusted workspace folders for multi-root workspaces. */
  workspaceRoots?: readonly string[];
  approvedExternalRoots?: readonly string[];
}

interface OpenAttemptState {
  value: ResolvedRunAttemptValue;
  deltas: StreamingCliOutputAccumulator;
  terminated: boolean;
  /** Reopened after this attempt was already settled and yielded. */
  continuation: boolean;
}

/**
 * A lossless, append-order projection of response-bearing timeline events.
 * Consumers can process this incrementally instead of materializing an entire
 * run log. `output` is the same CliOutput shape used by history/dashboard
 * preview consumers, while script and terminal facts remain explicit.
 */
export type RunOutputResolverEvent =
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_STARTED;
      attempt: ResolvedRunAttempt;
      attemptKind: TimelineAttemptKind;
      startReason: TimelineAttemptStartReason;
      prompt: string;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_CHUNK;
      attempt: ResolvedRunAttempt;
      chunk: string;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_EVENTS;
      attempt: ResolvedRunAttempt;
      events: CliEvent[];
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.OUTPUT;
      attempt: ResolvedRunAttemptOutput;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.SCRIPT_EXECUTION;
      attempt: ResolvedRunAttempt;
      scriptOutput: ScriptRuntimeOutput;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.RETRY_SCHEDULED;
      attempt: ResolvedRunAttempt;
      previousAttemptIndex: number;
      retryPrompt: string;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.FOLLOW_UP_RESPONSE_APPENDED;
      attempt: ResolvedRunAttempt;
      responseTextLength: number;
      eventCount: number;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_TERMINATED;
      attempt: ResolvedRunAttempt;
      terminalState: TimelineAttemptTerminalState;
      reason?: string;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUNTIME_TRANSITION;
      transition: WorkflowRuntimeTransitionPayload;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED;
      executionState: ExecutionState;
      stepCount: number;
    };

/**
 * Settled-attempt projection plus the run-level facts that do not belong to
 * an individual attempt. Attempts are emitted in timeline settle order; in a
 * parallel group that can differ from start order, matching live CLI output.
 */
export type RunOutputResolverAttemptEvent =
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED;
      attempt: ResolvedRunAttemptValue;
      /** True when the timeline ended before ATTEMPT_TERMINATED was recorded. */
      unterminated: boolean;
      /**
       * True when this attempt was already settled earlier in the stream and
       * this value carries records appended afterwards (a post-completion
       * follow-up recorded after RUN_TERMINATED or another attempt's events).
       * Its aggregate output is cumulative, so it supersedes the earlier
       * value; the prompt and terminal state live only on that earlier value.
       */
      continuation: boolean;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUNTIME_TRANSITION;
      transition: WorkflowRuntimeTransitionPayload;
    }
  | {
      kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED;
      executionState: ExecutionState;
      stepCount: number;
    };

/**
 * Streaming, bounded-memory response reader for one run timeline.
 *
 * The resolver deliberately does not use `TimelineRecorder.readEvents()`: it
 * walks JSONL in append order and retains only the current definition revision.
 * `resolveAttempt()` is a convenience reduction that retains only one attempt's
 * output (the value it returns), never the run's complete event log.
 */
export class RunOutputResolver {
  constructor(
    private readonly recorder: TimelineRecorder = new TimelineRecorder()
  ) {}

  async *stream(
    manifestPath: string
  ): AsyncGenerator<RunOutputResolverEvent, void, undefined> {
    const manifest = await this.recorder.readManifest(manifestPath);
    yield* this.streamFromEvents(
      manifest,
      this.recorder.streamEvents(manifestPath)
    );
  }

  /**
   * Same projection as `stream()`, but over an already-loaded manifest and
   * event list instead of re-reading `manifestPath` from disk. Used by
   * callers (e.g. `OutputHistoryTimelineAdapter`) that already hold both from
   * a prior `TimelineRecorder` read, so a run's events are parsed once.
   */
  async *streamFromEvents(
    manifest: WorkflowRunManifest,
    events:
      Iterable<WorkflowTimelineEvent> | AsyncIterable<WorkflowTimelineEvent>
  ): AsyncGenerator<RunOutputResolverEvent, void, undefined> {
    let activeDefinition: ResolvedAttemptDefinition | undefined =
      manifest.initialDefinition
        ? {
            definitionRevision: 1,
            definition: manifest.initialDefinition,
          }
        : undefined;

    for await (const event of events) {
      if (
        event.eventType === TIMELINE_EVENT_TYPES.DEFINITION_REVISION_COMMITTED
      ) {
        activeDefinition = {
          definitionRevision: event.payload.definitionRevision,
          definition: event.payload.definition,
        };
        continue;
      }

      switch (event.eventType) {
        case TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUNTIME_TRANSITION,
            transition: event.payload.transition,
          };
          break;
        case TIMELINE_EVENT_TYPES.ATTEMPT_STARTED: {
          const attempt = this.createAttemptReference(
            event.target,
            event.runIndex,
            event.attemptIndex,
            event.definitionRevision,
            activeDefinition,
            event.phase
          );
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_STARTED,
            attempt,
            attemptKind: event.payload.kind,
            startReason: event.payload.startReason,
            prompt: event.payload.prompt,
          };
          break;
        }
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED: {
          const attempt = this.createAttemptReference(
            event.target,
            event.runIndex ?? 0,
            event.attemptIndex,
            event.definitionRevision ?? activeDefinition?.definitionRevision,
            activeDefinition,
            event.phase
          );
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.OUTPUT,
            attempt: {
              ...attempt,
              output: event.payload.cliOutput,
              responseText: event.payload.cliOutput.response,
              kind:
                event.responseKind ??
                (event.payload.cliOutput.source ===
                SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP
                  ? TIMELINE_ATTEMPT_KINDS.SCRIPT
                  : TIMELINE_ATTEMPT_KINDS.AI),
            },
          };
          break;
        }
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_CHUNK,
            attempt: this.createAttemptReference(
              event.target,
              event.runIndex ?? 0,
              event.attemptIndex,
              activeDefinition?.definitionRevision,
              activeDefinition,
              event.phase
            ),
            chunk: event.payload.chunk,
          };
          break;
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_EVENTS,
            attempt: this.createAttemptReference(
              event.target,
              event.runIndex ?? 0,
              event.attemptIndex,
              event.definitionRevision ?? activeDefinition?.definitionRevision,
              activeDefinition,
              event.phase
            ),
            events: event.payload.events,
          };
          break;
        case TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.SCRIPT_EXECUTION,
            attempt: this.createAttemptReference(
              event.target,
              event.runIndex,
              event.attemptIndex,
              event.definitionRevision,
              activeDefinition,
              event.phase
            ),
            scriptOutput: event.payload,
          };
          break;
        case TIMELINE_EVENT_TYPES.RETRY_SCHEDULED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.RETRY_SCHEDULED,
            attempt: this.createAttemptReference(
              event.target,
              event.runIndex,
              event.attemptIndex,
              event.definitionRevision,
              activeDefinition,
              event.phase
            ),
            previousAttemptIndex: event.payload.previousAttemptIndex,
            retryPrompt: event.payload.retryPrompt,
          };
          break;
        case TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.FOLLOW_UP_RESPONSE_APPENDED,
            attempt: this.createAttemptReference(
              event.target,
              event.runIndex,
              event.attemptIndex,
              event.definitionRevision,
              activeDefinition,
              event.phase
            ),
            responseTextLength: event.payload.responseTextLength,
            eventCount: event.payload.eventCount,
          };
          break;
        case TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_TERMINATED,
            attempt: this.createAttemptReference(
              event.target,
              event.runIndex,
              event.attemptIndex,
              event.definitionRevision,
              activeDefinition
            ),
            terminalState: event.payload.terminalState,
            ...(event.payload.reason ? { reason: event.payload.reason } : {}),
          };
          break;
        case TIMELINE_EVENT_TYPES.RUN_TERMINATED:
          yield {
            kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED,
            executionState: event.payload.executionState,
            stepCount: event.payload.stepCount,
          };
          break;
      }
    }
  }

  /**
   * Fold each attempt's streamed deltas and aggregate into one settled value.
   * Open-attempt state is discarded as soon as it settles, apart from a
   * just-terminated value held briefly so contiguous follow-up records remain
   * part of the same logical attempt. Retained memory stays bounded by the
   * number of concurrently open attempts (plus the key strings of settled
   * attempts). Attempts from a parallel group are yielded in settle order
   * rather than sorted by target.
   *
   * Post-completion follow-ups are recorded after RUN_TERMINATED, so an
   * attempt can receive records after it was already settled. Those records
   * reopen it and it settles again with `continuation: true`; reducers must
   * fold that value over the earlier one via `foldSettledAttempt()`.
   */
  async *streamAttempts(
    manifestPath: string
  ): AsyncGenerator<RunOutputResolverAttemptEvent, void, undefined> {
    const openAttempts = new Map<string, OpenAttemptState>();
    const settledKeys = new Set<string>();

    for await (const event of this.stream(manifestPath)) {
      if (
        event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUNTIME_TRANSITION ||
        event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED
      ) {
        yield* this.drainSettledAttempts(openAttempts, settledKeys);
        yield event;
        continue;
      }

      const key = getAttemptKey(event.attempt);
      yield* this.drainSettledAttempts(openAttempts, settledKeys, key);
      const state =
        openAttempts.get(key) ??
        this.createOpenAttemptState(event.attempt, settledKeys.has(key));
      openAttempts.set(key, state);
      state.value.definition =
        event.attempt.definition ?? state.value.definition;

      switch (event.kind) {
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_STARTED:
          state.value.prompt = event.prompt;
          state.value.kind = event.attemptKind;
          state.value.startReason = event.startReason;
          break;
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.OUTPUT:
          // A fresh aggregate supersedes every delta buffered before it.
          state.deltas.discard(key);
          state.value.output = event.attempt.output;
          state.value.responseText = event.attempt.responseText;
          state.value.kind = event.attempt.kind;
          break;
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_CHUNK:
          state.deltas.appendChunk(key, event.chunk);
          break;
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_EVENTS:
          state.deltas.appendEvents(key, event.events);
          break;
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.SCRIPT_EXECUTION:
          state.value.scriptOutput = event.scriptOutput;
          break;
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_TERMINATED:
          state.value.terminalState = event.terminalState;
          state.value.terminalReason = event.reason;
          state.terminated = true;
          break;
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.RETRY_SCHEDULED:
        case RUN_OUTPUT_RESOLVER_EVENT_KINDS.FOLLOW_UP_RESPONSE_APPENDED:
          break;
      }
    }

    for (const [key, state] of openAttempts) {
      yield this.createSettledAttemptEvent(state, key);
    }
  }

  /**
   * Release every attempt that has already terminated, except `exceptKey` —
   * the attempt whose own next record is being folded in, which must stay open
   * so a contiguous follow-up stays part of the same logical attempt.
   */
  private *drainSettledAttempts(
    openAttempts: Map<string, OpenAttemptState>,
    settledKeys: Set<string>,
    exceptKey?: string
  ): Generator<RunOutputResolverAttemptEvent, void, undefined> {
    for (const [key, state] of openAttempts) {
      if (key === exceptKey || !state.terminated) {
        continue;
      }
      openAttempts.delete(key);
      settledKeys.add(key);
      yield this.createSettledAttemptEvent(state, key);
    }
  }

  private createOpenAttemptState(
    attempt: ResolvedRunAttempt,
    continuation: boolean
  ): OpenAttemptState {
    return {
      value: { ...attempt },
      deltas: new StreamingCliOutputAccumulator(),
      terminated: false,
      continuation,
    };
  }

  private createSettledAttemptEvent(
    state: OpenAttemptState,
    key: string
  ): RunOutputResolverAttemptEvent {
    return {
      kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED,
      attempt: this.finishAttemptState(state, key),
      // A continuation's attempt already terminated; follow-ups never record
      // their own ATTEMPT_TERMINATED, so its absence is not an interruption.
      unterminated: !state.terminated && !state.continuation,
      continuation: state.continuation,
    };
  }

  private finishAttemptState(
    state: OpenAttemptState,
    key: string
  ): ResolvedRunAttemptValue {
    if (state.value.output?.isStreaming) {
      const merged = state.deltas.flush(key, state.value.output);
      // `responseText` tracks streamed text only — an events-only delta leaves
      // the aggregate's own responseText authoritative.
      if (merged.response !== state.value.output.response) {
        state.value.responseText = merged.response;
      }
      state.value.output = merged;
    }
    return state.value;
  }

  /** Resolve one attempt's current response, preview output, script result, and terminal state. */
  async resolveAttempt(
    manifestPath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number
  ): Promise<ResolvedRunAttemptValue | undefined> {
    let value: ResolvedRunAttemptValue | undefined;
    for await (const event of this.streamAttempts(manifestPath)) {
      if (
        event.kind !== RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED ||
        !sameAttempt(event.attempt, target, runIndex, attemptIndex)
      ) {
        continue;
      }
      value = foldSettledAttempt(value, event);
    }
    return value;
  }

  /**
   * Resolve the latest attempt for each selected target in one streamed pass.
   * The retained map is bounded by the selected active targets, never by the
   * number of historical timeline events.
   */
  async resolveLatestAttempts(
    manifestPath: string,
    targets: readonly OutputExecutionTarget[]
  ): Promise<Map<string, ResolvedRunAttemptValue>> {
    const requested = new Set(targets.map(getTargetKey));
    const latest = new Map<string, ResolvedRunAttemptValue>();

    for await (const event of this.streamAttempts(manifestPath)) {
      if (
        event.kind !== RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED ||
        !requested.has(getTargetKey(event.attempt.target))
      ) {
        continue;
      }

      const key = getTargetKey(event.attempt.target);
      const existing = latest.get(key);
      if (
        !existing ||
        isNewerAttempt(event.attempt, existing) ||
        (event.continuation &&
          getAttemptKey(existing) === getAttemptKey(event.attempt))
      ) {
        latest.set(key, foldSettledAttempt(existing, event));
      }
    }

    return latest;
  }

  /**
   * Project selected queue targets and final-step loops in one timeline pass.
   *
   * The final-step targets are reduced as they are encountered: only the
   * aggregate and the highest loop's projection survive. File events are read
   * from both streaming and completed output records because both are durable
   * timeline entries for the same attempt.
   */
  async resolveAttemptProjection(
    manifestPath: string,
    queueTargets: readonly OutputExecutionTarget[],
    finalStepTargets: readonly OutputExecutionTarget[],
    options: RunOutputProjectionOptions
  ): Promise<RunOutputProjection> {
    const queueAccumulators = new Map<string, ProjectionAccumulator>();
    const finalTargetKeys = new Set<string>();
    const projection = this.createEmptyProjection(
      queueTargets,
      finalStepTargets,
      queueAccumulators
    ).projection;
    for (const target of finalStepTargets) {
      finalTargetKeys.add(getTargetKey(target));
    }

    const finalAccumulator = new ProjectionAccumulator();
    let latestFinalLoop: ProjectionAccumulator | undefined;
    let latestFinalLoopIndex = -1;

    try {
      for await (const event of this.stream(manifestPath)) {
        if (
          event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED ||
          event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUNTIME_TRANSITION
        ) {
          continue;
        }

        const key = getTargetKey(event.attempt.target);
        const queueAccumulator = queueAccumulators.get(key);
        const isFinalTarget = finalTargetKeys.has(key);
        if (!queueAccumulator && !isFinalTarget) {
          continue;
        }

        if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_STARTED) {
          if (event.attemptKind === TIMELINE_ATTEMPT_KINDS.CONDITION) {
            continue;
          }
          queueAccumulator?.recordAttemptStart(
            event.attempt,
            event.attemptKind,
            event.startReason
          );
          if (isFinalTarget) {
            finalAccumulator.recordAttemptStart(
              event.attempt,
              event.attemptKind,
              event.startReason
            );
            const loopIndex = getFinalLoopIndex(event.attempt.target);
            if (loopIndex > latestFinalLoopIndex) {
              latestFinalLoopIndex = loopIndex;
              latestFinalLoop = new ProjectionAccumulator(event.attempt.target);
            }
            if (loopIndex === latestFinalLoopIndex) {
              latestFinalLoop?.recordAttemptStart(
                event.attempt,
                event.attemptKind,
                event.startReason
              );
            }
          }
          continue;
        }

        if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_TERMINATED) {
          queueAccumulator?.recordAttemptTermination(
            event.attempt,
            event.terminalState,
            event.reason
          );
          if (isFinalTarget) {
            finalAccumulator.recordAttemptTermination(
              event.attempt,
              event.terminalState,
              event.reason
            );
            if (
              getFinalLoopIndex(event.attempt.target) === latestFinalLoopIndex
            ) {
              latestFinalLoop?.recordAttemptTermination(
                event.attempt,
                event.terminalState,
                event.reason
              );
            }
          }
          continue;
        }

        if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.SCRIPT_EXECUTION) {
          queueAccumulator?.recordScriptOutput(
            event.attempt,
            event.scriptOutput
          );
          if (isFinalTarget) {
            finalAccumulator.recordScriptOutput(
              event.attempt,
              event.scriptOutput
            );
            if (
              getFinalLoopIndex(event.attempt.target) === latestFinalLoopIndex
            ) {
              latestFinalLoop?.recordScriptOutput(
                event.attempt,
                event.scriptOutput
              );
            }
          }
          continue;
        }

        if (
          event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_EVENTS ||
          event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.OUTPUT
        ) {
          const events =
            event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_EVENTS
              ? event.events
              : (event.attempt.output.structured?.events ?? []);
          const normalizedEvents = normalizeCliEvents(events);
          const addFiles = (accumulator: ProjectionAccumulator): void => {
            for (const cliEvent of normalizedEvents) {
              const fileChange = this.getFileChange(
                cliEvent,
                options,
                manifestPath
              );
              if (fileChange) {
                accumulator.recordFileChange(fileChange);
              }
            }
          };
          queueAccumulator && addFiles(queueAccumulator);
          if (isFinalTarget) {
            addFiles(finalAccumulator);
            if (
              getFinalLoopIndex(event.attempt.target) === latestFinalLoopIndex
            ) {
              latestFinalLoop && addFiles(latestFinalLoop);
            }
          }
        }
      }
    } catch (error) {
      Log.error(
        "[RunOutputResolver] Unable to read run output projection history",
        error
      );
      return this.createEmptyProjection(
        queueTargets,
        finalStepTargets,
        new Map<string, ProjectionAccumulator>()
      ).projection;
    }

    for (const [key, accumulator] of queueAccumulators) {
      projection.targets.set(key, accumulator.toProjection());
    }
    if (finalStepTargets.length > 0) {
      projection.finalStep = {
        loopCount: finalAccumulator.loopCount,
        attempts: finalAccumulator.attempts,
        filesChanged: finalAccumulator.toFileChanges(),
        ...(latestFinalLoop
          ? { latestLoop: latestFinalLoop.toProjection() }
          : {}),
      };
    }
    return projection;
  }

  private createEmptyProjection(
    queueTargets: readonly OutputExecutionTarget[],
    finalStepTargets: readonly OutputExecutionTarget[],
    accumulators: Map<string, ProjectionAccumulator>
  ): {
    projection: RunOutputProjection;
    accumulators: Map<string, ProjectionAccumulator>;
  } {
    for (const target of queueTargets) {
      const key = getTargetKey(target);
      if (!accumulators.has(key)) {
        accumulators.set(key, new ProjectionAccumulator(target));
      }
    }
    return {
      projection: {
        targets: new Map(
          [...accumulators].map(([key, accumulator]) => [
            key,
            accumulator.toProjection(),
          ])
        ),
        ...(finalStepTargets.length > 0
          ? {
              finalStep: {
                loopCount: 0,
                attempts: 0,
                filesChanged: [],
              },
            }
          : {}),
      },
      accumulators,
    };
  }

  private getFileChange(
    event: CliEvent,
    options: RunOutputProjectionOptions,
    manifestPath: string
  ): FileChangeObservation | undefined {
    const operation = getFileChangeOperation(event);
    if (!operation) {
      return undefined;
    }
    const data = event.data as FileWriteData | FileEditData | FileDeleteData;
    if (!data.path) {
      return undefined;
    }

    const workspaceRoots = [
      options.workspaceRoot,
      ...(options.workspaceRoots ?? []),
    ].map((root) => path.resolve(root));
    const approvedExternalRoots = (options.approvedExternalRoots ?? []).map(
      (root) => path.resolve(root)
    );
    const candidate = path.resolve(
      options.workspaceRoot,
      data.path.replace(/\\/g, path.sep)
    );
    const access = evaluateFileAccess(candidate, {
      workspaceRoots,
      approvedExternalRoots,
    });
    if (!access.allowed || !access.matchedRoot) {
      Log.trace(
        `[RunOutputResolver] Ignoring unscoped file event in run projection (${manifestPath})`
      );
      return undefined;
    }

    const normalizedPath =
      access.reason === RUN_FILE_CHANGE_SCOPES.WORKSPACE
        ? toPortableRelativePath(access.matchedRoot, candidate)
        : candidate;
    return {
      key: `${operation}:${candidate}`,
      path: normalizedPath,
      scope:
        access.reason === RUN_FILE_CHANGE_SCOPES.WORKSPACE
          ? RUN_FILE_CHANGE_SCOPES.WORKSPACE
          : RUN_FILE_CHANGE_SCOPES.EXTERNAL,
      operation,
      failed: data.success === false,
    };
  }

  /**
   * Resolve prior-context items from the timeline rather than mutable working
   * file runtime fields. Callers pass only the active prompt range, keeping the
   * retained response set proportional to the context actually requested.
   */
  async resolvePriorContextItems(
    manifestPath: string,
    contexts: readonly PriorContext[],
    allPrompts: readonly WorkflowStep[],
    groupStartBoundary: number
  ): Promise<PriorContextItem[]> {
    const queueIndices = new Set<number>();
    const explicitQueueIndices = new Set<number>();
    const previousCandidateIndices = new Set<number>();
    let includeAllQueue = false;
    let includePreviousQueue = false;
    let includeAllFinalSteps = false;
    let includePreviousFinalStep = false;

    for (const context of contexts) {
      if (context === PRIOR_CONTEXT_KEYWORDS.ALL) {
        includeAllQueue = true;
        for (let index = 0; index < groupStartBoundary; index++) {
          queueIndices.add(index);
        }
      } else if (context === PRIOR_CONTEXT_KEYWORDS.PREVIOUS) {
        includePreviousQueue = true;
        for (let index = 0; index < groupStartBoundary; index++) {
          queueIndices.add(index);
          previousCandidateIndices.add(index);
        }
      } else if (context === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL) {
        includeAllFinalSteps = true;
      } else if (context === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS) {
        includePreviousFinalStep = true;
      } else if (Array.isArray(context)) {
        for (const oneBasedIndex of context) {
          const index = oneBasedIndex - 1;
          if (index >= 0 && index < groupStartBoundary) {
            queueIndices.add(index);
            explicitQueueIndices.add(index);
          }
        }
      }
    }

    const targets: OutputExecutionTarget[] = [
      ...[...queueIndices].map((stepIndex) => ({
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex,
      })),
      ...(includeAllFinalSteps || includePreviousFinalStep
        ? await this.getFinalStepTargets(manifestPath)
        : []),
    ];
    const resolved = await this.resolveLatestAttempts(manifestPath, targets);
    const resolvedQueueItems = [...queueIndices]
      .sort((left, right) => left - right)
      .flatMap((index): PriorContextItem[] => {
        const value = resolved.get(
          getTargetKey({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: index })
        );
        const step = value?.definition?.step ?? allPrompts[index];
        if (!step || !value) return [];
        if (isScriptStep(step)) {
          const scriptOutput = value.scriptOutput;
          const text = scriptOutput
            ? [
                scriptOutput.stdout,
                scriptOutput.stderr,
                scriptOutput.exitCode !== undefined
                  ? String(scriptOutput.exitCode)
                  : "",
              ]
                .filter(Boolean)
                .join("\n")
                .trim()
            : (value.responseText ?? "");
          return text ? [{ index, name: step.name, text, scriptOutput }] : [];
        }
        const text = value.responseText ?? "";
        return text
          ? [{ index, name: step.name, prompt: step.prompt, text }]
          : [];
      });
    const selectedQueueIndices = includeAllQueue
      ? new Set(queueIndices)
      : new Set(explicitQueueIndices);
    if (includePreviousQueue) {
      const previous = resolvedQueueItems
        .filter((item) => previousCandidateIndices.has(item.index))
        .at(-1);
      if (previous) selectedQueueIndices.add(previous.index);
    }
    const queueItems = resolvedQueueItems.filter((item) =>
      selectedQueueIndices.has(item.index)
    );
    const finalItems = [...resolved.values()]
      .filter((value) => value.target.kind === FINAL_STEP_PHASES.FINAL_STEP)
      .sort(
        (left, right) =>
          (left.target as { loopIndex: number }).loopIndex -
          (right.target as { loopIndex: number }).loopIndex
      )
      .flatMap((value): PriorContextItem[] => {
        const index = (value.target as { loopIndex: number }).loopIndex;
        return value.responseText
          ? [
              {
                index,
                text: value.responseText,
                type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
              },
            ]
          : [];
      });
    const selectedFinalItems = includePreviousFinalStep
      ? finalItems.slice(-1)
      : includeAllFinalSteps
        ? finalItems
        : [];
    return deduplicatePriorContextItems([...queueItems, ...selectedFinalItems]);
  }

  /** Read a whole terminal source run through the timeline reader. */
  async resolveAllPriorContextItems(
    manifestPath: string
  ): Promise<PriorContextItem[]> {
    const queueIndices = new Set<number>();
    for await (const event of this.stream(manifestPath)) {
      if (
        event.kind !== RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED &&
        event.kind !== RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUNTIME_TRANSITION &&
        event.attempt.target.kind === FINAL_STEP_PHASES.QUEUE
      ) {
        queueIndices.add(event.attempt.target.stepIndex);
      }
    }
    const maxIndex = Math.max(-1, ...queueIndices);
    return this.resolvePriorContextItems(
      manifestPath,
      [PRIOR_CONTEXT_KEYWORDS.ALL, PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL],
      Array.from({ length: maxIndex + 1 }, () => ({
        type: "prompt" as const,
        prompt: "",
      })),
      maxIndex + 1
    );
  }

  /** Narrow manifest access for address authorization without exposing paths to callers. */
  async getManifest(manifestPath: string) {
    return this.recorder.readManifest(manifestPath);
  }

  /** Resolve all final-step loop attempts while retaining only one value per loop. */
  async resolveLatestFinalStepAttempts(
    manifestPath: string
  ): Promise<Map<string, ResolvedRunAttemptValue>> {
    return this.resolveLatestAttempts(
      manifestPath,
      await this.getFinalStepTargets(manifestPath)
    );
  }

  private async getFinalStepTargets(
    manifestPath: string
  ): Promise<OutputExecutionTarget[]> {
    const targets = new Map<string, OutputExecutionTarget>();
    for await (const event of this.stream(manifestPath)) {
      if (
        event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED ||
        event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUNTIME_TRANSITION
      )
        continue;
      if (event.attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        targets.set(getTargetKey(event.attempt.target), event.attempt.target);
      }
    }
    return [...targets.values()];
  }

  private createAttemptReference(
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    definitionRevision: number | undefined,
    activeDefinition: ResolvedAttemptDefinition | undefined,
    phase?: ExecutionPhase
  ): ResolvedRunAttempt {
    const definition =
      definitionRevision !== undefined &&
      activeDefinition?.definitionRevision === definitionRevision
        ? {
            ...activeDefinition,
            step: resolveStep(activeDefinition.definition, target),
          }
        : undefined;
    return { target, runIndex, attemptIndex, phase, definition };
  }
}

interface FileChangeObservation {
  key: string;
  path?: string;
  scope?: RunFileChangeScope;
  operation?: RunFileChangeOperation;
  failed: boolean;
}

interface ProjectionAttemptIdentity {
  target: OutputExecutionTarget;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
}

class ProjectionAccumulator {
  private readonly fileChanges = new Map<
    string,
    {
      path: string;
      scope: RunFileChangeScope;
      operation: RunFileChangeOperation;
      failed: boolean;
    }
  >();
  private latestIdentity: ProjectionAttemptIdentity | undefined;
  private latestAttempt: RunLatestAttemptProjection | undefined;
  private latestAttemptKind: TimelineAttemptKind | undefined;
  private latestScriptOutput: ScriptRuntimeOutput | undefined;

  attempts = 0;
  loopCount = 0;

  constructor(private target?: OutputExecutionTarget) {}

  recordAttemptStart(
    attempt: ResolvedRunAttempt,
    kind: TimelineAttemptKind,
    startReason: TimelineAttemptStartReason
  ): void {
    this.target ??= attempt.target;
    this.attempts++;
    if (attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
      this.loopCount = Math.max(this.loopCount, attempt.target.loopIndex + 1);
    }

    const candidate: ProjectionAttemptIdentity = {
      target: attempt.target,
      runIndex: attempt.runIndex,
      attemptIndex: attempt.attemptIndex,
      phase: attempt.phase,
    };
    if (
      !this.latestIdentity ||
      isNewerProjectionAttempt(candidate, this.latestIdentity)
    ) {
      this.latestIdentity = candidate;
      this.latestAttemptKind = kind;
      this.latestScriptOutput = undefined;
      this.latestAttempt = {
        number: this.attempts,
        startReason,
      };
    }
  }

  recordAttemptTermination(
    attempt: ResolvedRunAttempt,
    terminalState: TimelineAttemptTerminalState,
    terminalReason?: string
  ): void {
    if (this.isLatestAttempt(attempt) && this.latestAttempt) {
      this.latestAttempt.terminalState = terminalState;
      this.latestAttempt.terminalReason = terminalReason;
    }
  }

  recordScriptOutput(
    attempt: ResolvedRunAttempt,
    scriptOutput: ScriptRuntimeOutput
  ): void {
    if (
      this.isLatestAttempt(attempt) &&
      this.latestAttemptKind === TIMELINE_ATTEMPT_KINDS.SCRIPT
    ) {
      this.latestScriptOutput = scriptOutput;
    }
  }

  recordFileChange(observation: FileChangeObservation): void {
    if (!observation.path || !observation.scope || !observation.operation) {
      return;
    }
    const existing = this.fileChanges.get(observation.key);
    if (existing) {
      existing.failed ||= observation.failed;
      if (!observation.failed) {
        existing.failed = false;
      }
      return;
    }
    this.fileChanges.set(observation.key, {
      path: observation.path,
      scope: observation.scope,
      operation: observation.operation,
      failed: observation.failed,
    });
  }

  toFileChanges(): RunFileChangeProjection[] {
    const changes = new Map<
      string,
      {
        path: string;
        scope: RunFileChangeScope;
        operations: Set<RunFileChangeOperation>;
      }
    >();
    for (const change of this.fileChanges.values()) {
      if (change.failed) {
        continue;
      }
      const key = `${change.scope}:${change.path}`;
      const existing = changes.get(key);
      if (existing) {
        existing.operations.add(change.operation);
      } else {
        changes.set(key, {
          path: change.path,
          scope: change.scope,
          operations: new Set([change.operation]),
        });
      }
    }
    return [...changes.values()].map((change) => ({
      path: change.path,
      scope: change.scope,
      operations: [...change.operations],
    }));
  }

  toProjection(): RunAttemptProjection {
    if (!this.target) {
      throw new Error("A target is required for an attempt projection");
    }
    return {
      target: this.target,
      attempts: this.attempts,
      ...(this.latestAttempt
        ? { latestAttempt: { ...this.latestAttempt } }
        : {}),
      filesChanged: this.toFileChanges(),
      ...(this.latestScriptOutput
        ? { scriptOutput: this.latestScriptOutput }
        : {}),
    };
  }

  private isLatestAttempt(attempt: ResolvedRunAttempt): boolean {
    return Boolean(
      this.latestIdentity && sameProjectionAttempt(this.latestIdentity, attempt)
    );
  }
}

function getFileChangeOperation(
  event: CliEvent
): RunFileChangeOperation | undefined {
  switch (event.type) {
    case CLI_EVENT_TYPES.FILE_WRITE:
      return "created";
    case CLI_EVENT_TYPES.FILE_EDIT:
      return "modified";
    case CLI_EVENT_TYPES.FILE_DELETE:
      return "deleted";
    default:
      return undefined;
  }
}

function getFinalLoopIndex(target: OutputExecutionTarget): number {
  return target.kind === FINAL_STEP_PHASES.FINAL_STEP ? target.loopIndex : -1;
}

function sameProjectionAttempt(
  identity: ProjectionAttemptIdentity,
  attempt: ResolvedRunAttempt
): boolean {
  return (
    identity.runIndex === attempt.runIndex &&
    identity.attemptIndex === attempt.attemptIndex &&
    (identity.phase === undefined ||
      attempt.phase === undefined ||
      identity.phase === attempt.phase) &&
    getTargetKey(identity.target) === getTargetKey(attempt.target)
  );
}

function isNewerProjectionAttempt(
  candidate: ProjectionAttemptIdentity,
  existing: ProjectionAttemptIdentity
): boolean {
  return (
    candidate.runIndex > existing.runIndex ||
    (candidate.runIndex === existing.runIndex &&
      (candidate.attemptIndex > existing.attemptIndex ||
        (candidate.attemptIndex === existing.attemptIndex &&
          candidate.phase !== existing.phase)))
  );
}

function toPortableRelativePath(root: string, candidate: string): string {
  return path.relative(root, candidate).replace(/\\/g, "/");
}

/**
 * The one producer of `RunOutputProjection.targets` keys. Exported because
 * consumers outside this module (notably `CliJsonResultBuilder`) must look
 * entries up by the same format — a hand-built `queue:${index}` literal on the
 * reader side silently degrades to a miss if this ever changes, yielding
 * `attempts: 0` and empty file lists instead of an error.
 */
export function queueTargetKey(stepIndex: number): string {
  return `queue:${stepIndex}`;
}

function getTargetKey(target: OutputExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? queueTargetKey(target.stepIndex)
    : `final:${target.loopIndex}`;
}

/** Compare execution targets by their discriminated identity. */
export function sameOutputExecutionTarget(
  left: OutputExecutionTarget,
  right: OutputExecutionTarget
): boolean {
  return getTargetKey(left) === getTargetKey(right);
}

function getAttemptKey(attempt: ResolvedRunAttempt): string {
  return `${getTargetKey(attempt.target)}:run:${attempt.runIndex}:attempt:${attempt.attemptIndex}${getExecutionPhaseKeySuffix(attempt.phase)}`;
}

function isNewerAttempt(
  candidate: ResolvedRunAttempt,
  existing: ResolvedRunAttemptValue
): boolean {
  return (
    candidate.runIndex > existing.runIndex ||
    (candidate.runIndex === existing.runIndex &&
      candidate.attemptIndex > existing.attemptIndex)
  );
}

/**
 * Reduce one settled attempt into the value already held for it. A
 * continuation of that same attempt carries its cumulative output, while the
 * prompt, start metadata, and terminal state exist only on the earlier value;
 * anything else replaces the held value outright.
 */
function foldSettledAttempt(
  existing: ResolvedRunAttemptValue | undefined,
  event: Extract<
    RunOutputResolverAttemptEvent,
    { kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED }
  >
): ResolvedRunAttemptValue {
  const continued = event.attempt;
  if (
    !event.continuation ||
    !existing ||
    getAttemptKey(existing) !== getAttemptKey(continued)
  ) {
    return continued;
  }
  return {
    ...existing,
    definition: continued.definition ?? existing.definition,
    kind: continued.kind ?? existing.kind,
    output: continued.output ?? existing.output,
    responseText: continued.responseText ?? existing.responseText,
    scriptOutput: continued.scriptOutput ?? existing.scriptOutput,
  };
}

function deduplicatePriorContextItems(
  items: PriorContextItem[]
): PriorContextItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type ?? "queue"}:${item.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveStep(
  definition: WorkflowDefinitionSnapshot,
  target: OutputExecutionTarget
): WorkflowStep | undefined {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? definition.steps[target.stepIndex]
    : definition.finalStep;
}

function sameAttempt(
  attempt: ResolvedRunAttempt,
  target: OutputExecutionTarget,
  runIndex: number,
  attemptIndex: number
): boolean {
  if (attempt.runIndex !== runIndex || attempt.attemptIndex !== attemptIndex) {
    return false;
  }
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? attempt.target.kind === target.kind &&
        attempt.target.stepIndex === target.stepIndex
    : attempt.target.kind === target.kind &&
        attempt.target.loopIndex === target.loopIndex;
}
