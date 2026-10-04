import type {
  CliEvent,
  CliOutput,
  TokenStats,
} from "../types/WebviewMessageTypes";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../types/CtrlYokeTypes";
import {
  FINAL_STEP_PHASES,
  type HarnessId,
  type StatusMessageSeverity,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { normalizeCliEvents } from "../utils/CliEventNormalizer";
import { Log } from "../utils/Log";
import { noteMemoryActivity } from "../utils/MemoryDiagnostics";

/**
 * Data carried by onPromptStart when a prompt step begins (or retries).
 * Fires twice per attempt: once immediately (cliCommand undefined), then again
 * when the harness CLI command is known (cliCommand populated).
 */
export interface PromptStartData {
  stepIndex: number;
  totalSteps: number;
  stepName: string;
  promptText: string;
  attemptIndex: number;
  runIndex: number;
  parallelGroupId?: string;
  /** The harness CLI command string, populated only on the second fire. */
  cliCommand?: string;
  /** True when cliCommand is injected prompt text instead of a spawned command. */
  cliCommandWasInjected?: boolean;
  /** Working directory used by the command, populated with the second fire. */
  workingDirectory?: string;
}

/** Data carried by onPromptComplete after each prompt fully finishes (post session-ID extraction). */
export interface PromptCompleteData {
  stepIndex: number;
  stepName: string;
  parallelGroupId?: string;
  tokens?: TokenStats;
  sessionId?: string;
  harness?: HarnessId;
  elapsed?: number; // seconds
  showCostEstimates?: boolean;
}

interface StepOutputBufferEntry {
  prompt: string;
  cliCommand: string | undefined;
  cliCommandWasInjected?: boolean;
  workingDirectory: string | undefined;
  timestampMs: number;
  attemptIndex: number;
  retryState?: { currentRetry: number; maxRetries: number };
  runIndex: number;
  accumulatedText: string;
  accumulatedEvents: CliEvent[];
  rawTextOutput?: boolean;
}

type AccumulatedOutput = Pick<
  StepOutputBufferEntry,
  "accumulatedText" | "accumulatedEvents"
>;

function getAccumulatedOutput(
  existing: StepOutputBufferEntry | undefined,
  attemptIndex: number,
  runIndex: number
): AccumulatedOutput {
  return existing?.attemptIndex === attemptIndex &&
    existing.runIndex === runIndex
    ? {
        accumulatedText: existing.accumulatedText,
        accumulatedEvents: existing.accumulatedEvents,
      }
    : { accumulatedText: "", accumulatedEvents: [] };
}

interface CompletedStepEntry {
  outputs: any[];
  retryState?: { currentRetry: number; maxRetries: number };
}

interface StatusMessageEntry {
  message: string;
  severity: string;
  timestamp: number;
}

export interface OutputCaptureCallbacks {
  onPromptStart: (data: PromptStartData) => void;
  onPromptComplete: (data: PromptCompleteData) => void;
  onStatusMessage: (
    stepIndex: number,
    message: string,
    severity: string
  ) => void;
  getWorkflowStep: (stepIndex: number) => WorkflowStep | undefined;
  getParallelGroupId: (stepIndex: number) => string | undefined;
  getTotalSteps: () => number;
}

/**
 * OutputCaptureBuffer
 *
 * RESPONSIBILITY: Per-workflow output buffering for inactive/background workflows.
 *
 * Owns the five Maps that buffer streaming and completed output while a workflow
 * runs in the background (not the active dashboard view). Provides capture methods
 * called by WorkflowExecutionContext callbacks, and a replayTo() method that
 * replays all buffered state to the dashboard when the workflow becomes active.
 *
 * Also fires PromptStart / PromptComplete / StatusMessage events through injected
 * callbacks so WorkflowInstance can forward them to standalone CLI subscribers
 * without coupling this class to TypedEmitter.
 */
export class OutputCaptureBuffer {
  /**
   * Per-step streaming output buffer — captures chunks even when the instance is inactive.
   * Replayed by replayTo() so the user sees in-progress output when switching back.
   */
  private readonly stepOutputBuffer = new Map<number, StepOutputBufferEntry>();

  /**
   * Stores the final completed output(s) for each step, indexed by stepIndex.
   * Each entry holds an array of outputs (one per attempt) plus optional retry
   * state so the webview store accepts attemptIndex > 0 outputs on replay.
   */
  private readonly completedStepOutputs = new Map<number, CompletedStepEntry>();

  /**
   * Per-loop streaming output buffer for workflow-level finalStep.
   * Uses loopIndex keys (not queue step indices) to avoid collisions.
   */
  private readonly finalStepOutputBuffer = new Map<
    number,
    StepOutputBufferEntry
  >();

  /** Completed outputs keyed by finalStep loopIndex. */
  private readonly finalStepCompletedOutputs = new Map<
    number,
    { outputs: any[] }
  >();

  /** Buffered status messages keyed by finalStep loopIndex. */
  private readonly finalStepStatusMessages = new Map<
    number,
    StatusMessageEntry[]
  >();

  /**
   * Latest live context-window reading for a queue step still streaming.
   * Never persisted (see `PromptQueue.stripHistoryOnlyRuntimeFieldsForUndoRedo`)
   * — this is the only place a switch back to this workflow mid-step can learn
   * the running step's current usage without waiting for the harness's next
   * update.
   */
  private readonly contextWindowBuffer = new Map<
    number,
    { used: number; size: number }
  >();

  constructor(
    private readonly instanceTag: string,
    private readonly callbacks: OutputCaptureCallbacks
  ) {}

  get stepBufferSize(): number {
    return this.stepOutputBuffer.size;
  }

  get finalStepBufferSize(): number {
    return this.finalStepOutputBuffer.size;
  }

  clear(): void {
    this.stepOutputBuffer.clear();
    this.completedStepOutputs.clear();
    this.finalStepOutputBuffer.clear();
    this.finalStepCompletedOutputs.clear();
    this.finalStepStatusMessages.clear();
    this.contextWindowBuffer.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Regular-step capture methods
  // ─────────────────────────────────────────────────────────────────────────

  captureOutputInit(
    stepIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    cliCommandWasInjected: boolean | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput: boolean | undefined,
    runIndex: number = 0
  ): void {
    const existing = this.stepOutputBuffer.get(stepIndex);
    const accumulatedOutput = getAccumulatedOutput(
      existing,
      attemptIndex,
      runIndex
    );
    this.stepOutputBuffer.set(stepIndex, {
      prompt,
      cliCommand,
      cliCommandWasInjected,
      workingDirectory,
      timestampMs,
      attemptIndex,
      runIndex,
      ...accumulatedOutput,
      rawTextOutput,
      retryState: this.completedStepOutputs.get(stepIndex)?.retryState,
    });

    const totalSteps = this.callbacks.getTotalSteps();
    this.callbacks.onPromptStart({
      stepIndex,
      totalSteps,
      stepName:
        this.callbacks.getWorkflowStep(stepIndex)?.name?.trim() ||
        `Step ${stepIndex + 1}`,
      promptText: prompt,
      attemptIndex,
      runIndex,
      parallelGroupId: this.callbacks.getParallelGroupId(stepIndex),
      cliCommand,
      cliCommandWasInjected,
      workingDirectory,
    });
  }

  captureChunk(stepIndex: number, chunk: string): void {
    const existing = this.stepOutputBuffer.get(stepIndex);
    if (existing) {
      existing.accumulatedText += chunk;
    }
  }

  /**
   * Appends raw. Normalizing on every streamed batch re-pairs the whole
   * accumulated array each time, which is quadratic in a long attempt's batch
   * count; every reader below already normalizes what it hands out, so the
   * write path does not need to.
   */
  captureEvents(stepIndex: number, events: CliEvent[]): void {
    const existing = this.stepOutputBuffer.get(stepIndex);
    if (existing) {
      existing.accumulatedEvents.push(...events);
    }
  }

  /** Always-on live context-window capture — enables gauge replay on workflow switch. */
  captureContextWindow(stepIndex: number, used: number, size: number): void {
    this.contextWindowBuffer.set(stepIndex, { used, size });
  }

  captureCompletedOutput(stepIndex: number, output: any): void {
    const existing = this.completedStepOutputs.get(stepIndex);
    const attemptIndex = output.attemptIndex ?? 0;
    if (existing) {
      existing.outputs.push(output);
    } else {
      this.completedStepOutputs.set(stepIndex, { outputs: [output] });
    }
    Log.trace(
      `${this.instanceTag} captureCompletedOutput: step ${stepIndex} attempt ${attemptIndex}, total outputs=${this.completedStepOutputs.get(stepIndex)!.outputs.length}, retryState=${JSON.stringify(this.completedStepOutputs.get(stepIndex)!.retryState ?? null)}`
    );
    // Step is no longer streaming. The completed CLI output's own tokens are
    // the durable source for this step's context-window stat from here on.
    this.stepOutputBuffer.delete(stepIndex);
    this.contextWindowBuffer.delete(stepIndex);
    // Fire prompt-complete event so standalone CLI can render per-step stats.
    this.callbacks.onPromptComplete({
      stepIndex,
      stepName:
        this.callbacks.getWorkflowStep(stepIndex)?.name?.trim() ||
        `Step ${stepIndex + 1}`,
      parallelGroupId: this.callbacks.getParallelGroupId(stepIndex),
      tokens: output.tokens,
      sessionId: output.structured?.metadata?.sessionId,
      harness: output.structured?.metadata?.harness,
      elapsed: output.elapsed,
    });
  }

  /** Store the exact effective retry state emitted by the runtime transition. */
  captureRetryState(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ): void {
    const retryState = { currentRetry, maxRetries };
    const completedEntry = this.completedStepOutputs.get(stepIndex);
    if (completedEntry) {
      completedEntry.retryState = retryState;
    }
    const streamingEntry = this.stepOutputBuffer.get(stepIndex);
    if (streamingEntry) {
      streamingEntry.retryState = retryState;
    }
  }

  getBufferedOutput(stepIndex: number): CliOutput | undefined {
    const buffer = this.stepOutputBuffer.get(stepIndex);
    return buffer ? this.createBufferedOutput(buffer) : undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FinalStep capture methods (mirror of regular-step methods, loopIndex key)
  // ─────────────────────────────────────────────────────────────────────────

  captureFinalStepOutputInit(
    loopIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    cliCommandWasInjected: boolean | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput: boolean | undefined,
    runIndex: number = 0
  ): void {
    const existing = this.finalStepOutputBuffer.get(loopIndex);
    const accumulatedOutput = getAccumulatedOutput(
      existing,
      attemptIndex,
      runIndex
    );
    this.finalStepOutputBuffer.set(loopIndex, {
      prompt,
      cliCommand,
      cliCommandWasInjected,
      workingDirectory,
      timestampMs,
      attemptIndex,
      runIndex,
      ...accumulatedOutput,
      rawTextOutput,
    });
  }

  captureFinalStepChunk(loopIndex: number, chunk: string): void {
    const existing = this.finalStepOutputBuffer.get(loopIndex);
    if (existing) {
      existing.accumulatedText += chunk;
    }
  }

  /** Raw append, for the reason given on `captureEvents`. */
  captureFinalStepEvents(loopIndex: number, events: CliEvent[]): void {
    const existing = this.finalStepOutputBuffer.get(loopIndex);
    if (existing) {
      existing.accumulatedEvents.push(...events);
    }
  }

  captureFinalStepCompletedOutput(loopIndex: number, output: any): void {
    const existing = this.finalStepCompletedOutputs.get(loopIndex);
    if (existing) {
      existing.outputs.push(output);
    } else {
      this.finalStepCompletedOutputs.set(loopIndex, { outputs: [output] });
    }
    this.finalStepOutputBuffer.delete(loopIndex);
  }

  getFinalStepBufferedOutput(loopIndex: number): CliOutput | undefined {
    const buffer = this.finalStepOutputBuffer.get(loopIndex);
    return buffer ? this.createBufferedOutput(buffer) : undefined;
  }

  onFinalStepStatusMessage(
    loopIndex: number,
    message: string,
    severity: string
  ): void {
    const messages = this.finalStepStatusMessages.get(loopIndex) ?? [];
    messages.push({ message, severity, timestamp: Date.now() });
    this.finalStepStatusMessages.set(loopIndex, messages);
    // Signed negative index encoding: loop N => -(N+1)
    this.callbacks.onStatusMessage(-(loopIndex + 1), message, severity);
  }

  /**
   * Pre-cache a completed step's historical outputs so they are available for
   * replay when the user switches back to this workflow mid-execution.
   * Used by append-continuation runs to restore outputs from the previous session.
   */
  cacheHistoricalStepOutput(
    stepIndex: number,
    outputs: any[],
    retryState?: { currentRetry: number; maxRetries: number }
  ): void {
    this.completedStepOutputs.set(stepIndex, { outputs, retryState });
  }

  private createBufferedOutput(buffer: StepOutputBufferEntry): CliOutput {
    return {
      prompt: buffer.prompt,
      response: buffer.accumulatedText,
      structured:
        buffer.accumulatedEvents.length > 0
          ? {
              events: normalizeCliEvents(buffer.accumulatedEvents),
              metadata: {},
            }
          : undefined,
      elapsed: 0,
      tokens: undefined,
      isStreaming: false,
      cliCommand: buffer.cliCommand,
      cliCommandWasInjected: buffer.cliCommandWasInjected,
      workingDirectory: buffer.workingDirectory,
      timestampMs: buffer.timestampMs,
      attemptIndex: buffer.attemptIndex,
      runIndex: buffer.runIndex,
      rawTextOutput: buffer.rawTextOutput,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Replay
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Replay all buffered output state to the given dashboard sink.
   * Called by WorkflowInstance.replayFullStateTo() after the initial
   * SESSION_RESTORED message to restore in-progress and completed output.
   */
  replayTo(
    dashboardSink: IDashboardSink,
    state: { status: string; currentIndex: number },
    finalRuntime: { phase: string; loopCount: number } | null | undefined,
    instanceTag: string,
    activeTargets: ReadonlySet<string> = new Set()
  ): void {
    noteMemoryActivity(
      `replay ${instanceTag} completedSteps=${this.completedStepOutputs.size} finalStepLoops=${this.finalStepCompletedOutputs.size}`
    );
    // Replay completed step outputs so the user sees prior-prompt results
    // when switching back to a workflow that is already partway through.
    if (this.completedStepOutputs.size > 0) {
      for (const [stepIndex, entry] of this.completedStepOutputs) {
        Log.trace(
          `${instanceTag} replayFullStateTo: replaying completed step ${stepIndex} (${entry.outputs.length} attempt(s))`
        );
        // Send retry state BEFORE outputs so the webview store's addCliOutput
        // guard accepts attemptIndex > 0.
        if (entry.retryState) {
          dashboardSink.updateRetryAttempt(
            stepIndex,
            entry.retryState.currentRetry,
            entry.retryState.maxRetries
          );
        }
        for (const output of entry.outputs) {
          dashboardSink.updateCliOutput(stepIndex, output);
        }
      }
    }

    // Replay finalStep completed outputs (per loop).
    if (this.finalStepCompletedOutputs.size > 0) {
      for (const [loopIndex, entry] of this.finalStepCompletedOutputs) {
        Log.trace(
          `${instanceTag} replayFullStateTo: replaying finalStep loop ${loopIndex} (${entry.outputs.length} attempt(s))`
        );
        for (const output of entry.outputs) {
          dashboardSink.updateFinalStepOutput(loopIndex, output);
        }
      }
    }

    // Replay finalStep status messages (encoded as signed negative step indices).
    if (this.finalStepStatusMessages.size > 0) {
      for (const [loopIndex, messages] of this.finalStepStatusMessages) {
        const negativeLoopStepIndex = -(loopIndex + 1);
        for (const msg of messages) {
          dashboardSink.updateStatusMessage(
            negativeLoopStepIndex,
            msg.message,
            msg.severity as StatusMessageSeverity,
            undefined,
            msg.timestamp
          );
        }
      }
    }

    // Replay every active queue target. Before target-keyed execution this
    // reduces to the current index; with multiple in-flight targets each
    // buffer must survive a reconnect independently.
    if (
      this.stepOutputBuffer.size > 0 &&
      (state.status === EXECUTION_STATES.RUNNING || activeTargets.size > 0)
    ) {
      for (const [stepIndex, buffer] of this.stepOutputBuffer) {
        if (
          state.status !== EXECUTION_STATES.RUNNING &&
          !activeTargets.has(`queue:${stepIndex}`)
        ) {
          continue;
        }
        Log.trace(
          `${instanceTag} replayFullStateTo: replaying step ${stepIndex} buffer (${buffer.accumulatedText.length} chars, attemptIndex=${buffer.attemptIndex})`
        );

        // Belt-and-suspenders: ensure retryState was already sent above so
        // the webview store accepts attemptIndex > 0 outputs.
        if (buffer.attemptIndex > 0) {
          const retryState =
            this.completedStepOutputs.get(stepIndex)?.retryState ??
            buffer.retryState;
          if (!retryState) {
            // Edge case: retry streaming started but completedStepOutputs
            // doesn't have retryState yet (defend against timing gaps).
            Log.trace(
              `${instanceTag} replayFullStateTo: retry state unavailable for streaming step ${stepIndex} attempt ${buffer.attemptIndex}`
            );
          } else {
            Log.trace(
              `${instanceTag} replayFullStateTo: sending retryState for step ${stepIndex} (attempt ${retryState.currentRetry}/${retryState.maxRetries})`
            );
            dashboardSink.updateRetryAttempt(
              stepIndex,
              retryState.currentRetry,
              retryState.maxRetries
            );
          }
        }

        dashboardSink.updateCliOutput(stepIndex, {
          prompt: buffer.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: buffer.cliCommand,
          cliCommandWasInjected: buffer.cliCommandWasInjected,
          workingDirectory: buffer.workingDirectory,
          timestampMs: buffer.timestampMs,
          attemptIndex: buffer.attemptIndex,
          runIndex: buffer.runIndex,
          rawTextOutput: buffer.rawTextOutput,
        });
        if (buffer.accumulatedText) {
          dashboardSink.updateCliStreamingChunk(
            stepIndex,
            buffer.accumulatedText,
            undefined,
            undefined,
            buffer.timestampMs,
            undefined,
            buffer.attemptIndex,
            buffer.runIndex
          );
        }
        if (buffer.accumulatedEvents.length > 0) {
          dashboardSink.updateCliStreamingEvents(
            stepIndex,
            buffer.accumulatedEvents,
            buffer.attemptIndex,
            buffer.runIndex
          );
        }
        // Replay the last known live context-window reading so the running
        // step's gauge is populated immediately, rather than staying empty
        // until the harness happens to report its next update.
        const contextWindow = this.contextWindowBuffer.get(stepIndex);
        if (contextWindow) {
          dashboardSink.updateContextWindow(
            stepIndex,
            contextWindow.used,
            contextWindow.size
          );
        }
      }
    }

    // Replay in-flight finalStep streaming output when switching back mid-loop.
    if (
      state.status === EXECUTION_STATES.RUNNING &&
      finalRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      const loopIndex = finalRuntime.loopCount;
      const buffer = this.finalStepOutputBuffer.get(loopIndex);
      if (buffer) {
        Log.trace(
          `${instanceTag} replayFullStateTo: replaying finalStep loop ${loopIndex} buffer (${buffer.accumulatedText.length} chars, events=${buffer.accumulatedEvents.length}, attemptIndex=${buffer.attemptIndex})`
        );
        dashboardSink.updateFinalStepOutput(loopIndex, {
          prompt: buffer.prompt,
          response: buffer.accumulatedText,
          structured:
            buffer.accumulatedEvents.length > 0
              ? {
                  events: normalizeCliEvents(buffer.accumulatedEvents),
                  metadata: {},
                }
              : undefined,
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: buffer.cliCommand,
          cliCommandWasInjected: buffer.cliCommandWasInjected,
          workingDirectory: buffer.workingDirectory,
          timestampMs: buffer.timestampMs,
          attemptIndex: buffer.attemptIndex,
          runIndex: buffer.runIndex,
          rawTextOutput: buffer.rawTextOutput,
        });
      }
    }
  }
}
