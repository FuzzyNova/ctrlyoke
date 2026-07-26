import { type ExecutionState } from "../../types/DashboardConstants";
import type {
  PriorContext,
  ScriptRuntimeOutput,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import {
  FINAL_STEP_PHASES,
  PRIOR_CONTEXT_ITEM_TYPES,
  PRIOR_CONTEXT_KEYWORDS,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type { CliEvent } from "../../types/CliOutputTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_EVENT_TYPES,
  type TimelineAttemptKind,
  type TimelineAttemptStartReason,
  type TimelineAttemptTerminalState,
  type WorkflowRuntimeTransitionPayload,
  type WorkflowDefinitionSnapshot,
} from "../../types/WorkflowTimelineTypes";
import type { ExecutionPhase } from "../../types/DashboardConstants";
import { normalizeCliEvents } from "../../utils/CliEventNormalizer";
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

export interface ResolvedRunAttemptOutput extends ResolvedRunAttempt {
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

/**
 * A lossless, append-order projection of response-bearing timeline events.
 * Consumers can process this incrementally instead of materializing an entire
 * run log. `output` is the same CliOutput shape used by history/dashboard
 * preview consumers, while script and terminal facts remain explicit.
 */
export type RunOutputResolverEvent =
  | {
      kind: "attemptStarted";
      attempt: ResolvedRunAttempt;
      attemptKind: TimelineAttemptKind;
      startReason: TimelineAttemptStartReason;
      prompt: string;
    }
  | {
      kind: "streamingChunk";
      attempt: ResolvedRunAttempt;
      chunk: string;
    }
  | {
      kind: "streamingEvents";
      attempt: ResolvedRunAttempt;
      events: CliEvent[];
    }
  | {
      kind: "output";
      attempt: ResolvedRunAttemptOutput;
    }
  | {
      kind: "scriptExecution";
      attempt: ResolvedRunAttempt;
      scriptOutput: ScriptRuntimeOutput;
    }
  | {
      kind: "retryScheduled";
      attempt: ResolvedRunAttempt;
      previousAttemptIndex: number;
      retryPrompt: string;
    }
  | {
      kind: "followUpResponseAppended";
      attempt: ResolvedRunAttempt;
      responseTextLength: number;
      eventCount: number;
    }
  | {
      kind: "attemptTerminated";
      attempt: ResolvedRunAttempt;
      terminalState: TimelineAttemptTerminalState;
      reason?: string;
    }
  | { kind: "runtimeTransition"; transition: WorkflowRuntimeTransitionPayload }
  | {
      kind: "runTerminated";
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
    let activeDefinition: ResolvedAttemptDefinition | undefined =
      manifest.initialDefinition
        ? {
            definitionRevision: 1,
            definition: manifest.initialDefinition,
          }
        : undefined;

    for await (const event of this.recorder.streamEvents(manifestPath)) {
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
            kind: "runtimeTransition",
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
            kind: "attemptStarted",
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
            kind: "output",
            attempt: {
              ...attempt,
              output: event.payload.cliOutput,
              responseText: event.payload.cliOutput.response,
              kind:
                event.responseKind ??
                (event.payload.cliOutput.source === "script" ? "script" : "ai"),
            },
          };
          break;
        }
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED:
          yield {
            kind: "streamingChunk",
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
            kind: "streamingEvents",
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
            kind: "scriptExecution",
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
            kind: "retryScheduled",
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
            kind: "followUpResponseAppended",
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
            kind: "attemptTerminated",
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
            kind: "runTerminated",
            executionState: event.payload.executionState,
            stepCount: event.payload.stepCount,
          };
          break;
      }
    }
  }

  /** Resolve one attempt's current response, preview output, script result, and terminal state. */
  async resolveAttempt(
    manifestPath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number
  ): Promise<ResolvedRunAttemptValue | undefined> {
    let value: ResolvedRunAttemptValue | undefined;

    for await (const event of this.stream(manifestPath)) {
      if (
        event.kind === "runTerminated" ||
        event.kind === "runtimeTransition" ||
        !sameAttempt(event.attempt, target, runIndex, attemptIndex)
      ) {
        continue;
      }

      value ??= { ...event.attempt };
      value.definition = event.attempt.definition ?? value.definition;
      switch (event.kind) {
        case "attemptStarted":
          value.prompt = event.prompt;
          value.kind = event.attemptKind;
          value.startReason = event.startReason;
          break;
        case "output":
          value.output = event.attempt.output;
          value.responseText = event.attempt.responseText;
          value.kind = event.attempt.kind;
          break;
        case "streamingChunk":
          if (value.output?.isStreaming) {
            value.output = {
              ...value.output,
              response: value.output.response + event.chunk,
            };
            value.responseText = value.output.response;
          }
          break;
        case "streamingEvents":
          if (value.output?.isStreaming) {
            value.output = {
              ...value.output,
              structured: {
                ...value.output.structured,
                events: normalizeCliEvents([
                  ...(value.output.structured?.events ?? []),
                  ...event.events,
                ]),
                metadata: value.output.structured?.metadata ?? {},
              },
            };
          }
          break;
        case "scriptExecution":
          value.scriptOutput = event.scriptOutput;
          break;
        case "attemptTerminated":
          value.terminalState = event.terminalState;
          value.terminalReason = event.reason;
          break;
      }
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

    for await (const event of this.stream(manifestPath)) {
      if (
        event.kind === "runTerminated" ||
        event.kind === "runtimeTransition" ||
        !requested.has(getTargetKey(event.attempt.target))
      ) {
        continue;
      }

      const key = getTargetKey(event.attempt.target);
      const existing = latest.get(key);
      if (!existing || isNewerAttempt(event.attempt, existing)) {
        latest.set(key, { ...event.attempt });
      }
      const value = latest.get(key)!;
      if (
        !sameAttempt(
          event.attempt,
          value.target,
          value.runIndex,
          value.attemptIndex
        )
      ) {
        continue;
      }
      value.definition = event.attempt.definition ?? value.definition;
      switch (event.kind) {
        case "attemptStarted":
          value.prompt = event.prompt;
          value.kind = event.attemptKind;
          value.startReason = event.startReason;
          break;
        case "output":
          value.output = event.attempt.output;
          value.responseText = event.attempt.responseText;
          value.kind = event.attempt.kind;
          break;
        case "scriptExecution":
          value.scriptOutput = event.scriptOutput;
          break;
        case "attemptTerminated":
          value.terminalState = event.terminalState;
          value.terminalReason = event.reason;
          break;
      }
    }

    return latest;
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
    currentIndex: number
  ): Promise<PriorContextItem[]> {
    const queueIndices = new Set<number>();
    let includeAllFinalSteps = false;
    let includePreviousFinalStep = false;

    for (const context of contexts) {
      if (context === PRIOR_CONTEXT_KEYWORDS.ALL) {
        for (let index = 0; index < currentIndex; index++)
          queueIndices.add(index);
      } else if (context === PRIOR_CONTEXT_KEYWORDS.PREVIOUS) {
        if (currentIndex > 0) queueIndices.add(currentIndex - 1);
      } else if (context === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL) {
        includeAllFinalSteps = true;
      } else if (context === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS) {
        includePreviousFinalStep = true;
      } else if (Array.isArray(context)) {
        for (const oneBasedIndex of context) {
          const index = oneBasedIndex - 1;
          if (index >= 0 && index < currentIndex) queueIndices.add(index);
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
    const queueItems = [...queueIndices]
      .sort((left, right) => left - right)
      .flatMap((index): PriorContextItem[] => {
        const value = resolved.get(
          getTargetKey({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: index })
        );
        const step = value?.definition?.step ?? allPrompts[index];
        if (!step || !value) return [];
        if ("script" in step) {
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
        event.kind !== "runTerminated" &&
        event.kind !== "runtimeTransition" &&
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
      if (event.kind === "runTerminated" || event.kind === "runtimeTransition")
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

function getTargetKey(target: OutputExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `queue:${target.stepIndex}`
    : `final:${target.loopIndex}`;
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
