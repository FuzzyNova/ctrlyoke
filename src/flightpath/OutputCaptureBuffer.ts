import type { CliEvent } from "../types/WebviewMessageTypes";
import type { PromptItem } from "../types/FlightPathTypes";
import { EXECUTION_STATES } from "../types/FlightPathTypes";
import { FINAL_PROMPT_PHASES } from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { Log } from "../utils/Log";

/**
 * Data carried by onPromptStart when a prompt step begins (or retries).
 * Fires twice per attempt: once immediately (cliCommand undefined), then again
 * when the harness CLI command is known (cliCommand populated).
 */
export interface PromptStartData {
  stepIndex: number;
  totalSteps: number;
  promptText: string;
  attemptIndex: number;
  /** The harness CLI command string, populated only on the second fire. */
  cliCommand?: string;
}

/** Data carried by onPromptComplete after each prompt fully finishes (post session-ID extraction). */
export interface PromptCompleteData {
  stepIndex: number;
  tokens?: {
    prompt: number;
    completion: number;
    cached?: number;
    cacheCreated?: number;
    contextWindowUsed?: number;
    contextWindowSize?: number;
  };
  sessionId?: string;
  harness?: string;
  elapsed?: number; // seconds
}

interface StepOutputBufferEntry {
  prompt: string;
  cliCommand: string | undefined;
  workingDirectory: string | undefined;
  timestampMs: number;
  attemptIndex: number;
  accumulatedText: string;
  accumulatedEvents: CliEvent[];
  rawTextOutput?: boolean;
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
  getPromptItem: (stepIndex: number) => PromptItem | undefined;
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
   * Per-loop streaming output buffer for workflow-level finalPrompt.
   * Uses loopIndex keys (not queue step indices) to avoid collisions.
   */
  private readonly finalPromptOutputBuffer = new Map<
    number,
    StepOutputBufferEntry
  >();

  /** Completed outputs keyed by finalPrompt loopIndex. */
  private readonly finalPromptCompletedOutputs = new Map<
    number,
    { outputs: any[] }
  >();

  /** Buffered status messages keyed by finalPrompt loopIndex. */
  private readonly finalPromptStatusMessages = new Map<
    number,
    StatusMessageEntry[]
  >();

  constructor(
    private readonly instanceTag: string,
    private readonly callbacks: OutputCaptureCallbacks
  ) {}

  get stepBufferSize(): number {
    return this.stepOutputBuffer.size;
  }

  get finalPromptBufferSize(): number {
    return this.finalPromptOutputBuffer.size;
  }

  clear(): void {
    this.stepOutputBuffer.clear();
    this.completedStepOutputs.clear();
    this.finalPromptOutputBuffer.clear();
    this.finalPromptCompletedOutputs.clear();
    this.finalPromptStatusMessages.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Regular-step capture methods
  // ─────────────────────────────────────────────────────────────────────────

  captureOutputInit(
    stepIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput: boolean | undefined
  ): void {
    // Preserve accumulatedText/Events across the two captureOutputInit calls
    // per attempt (the second call updates cliCommand once the process starts).
    const existing = this.stepOutputBuffer.get(stepIndex);
    this.stepOutputBuffer.set(stepIndex, {
      prompt,
      cliCommand,
      workingDirectory,
      timestampMs,
      attemptIndex,
      accumulatedText: existing?.accumulatedText ?? "",
      accumulatedEvents: existing?.accumulatedEvents ?? [],
      rawTextOutput,
    });

    // When a retry starts streaming, eagerly set retryState in completedStepOutputs
    // so replayTo() can send RETRY_ATTEMPT_CHANGED before replaying outputs.
    if (attemptIndex > 0) {
      const completedEntry = this.completedStepOutputs.get(stepIndex);
      if (completedEntry) {
        const promptItem = this.callbacks.getPromptItem(stepIndex);
        const maxRetries = promptItem?.endCondition?.maxRetries ?? attemptIndex;
        completedEntry.retryState = { currentRetry: attemptIndex, maxRetries };
        Log.debug(
          `${this.instanceTag} captureOutputInit: set retryState for step ${stepIndex} (attempt ${attemptIndex}/${maxRetries})`
        );
      }
    }

    const totalSteps = this.callbacks.getTotalSteps();
    this.callbacks.onPromptStart({
      stepIndex,
      totalSteps,
      promptText: prompt,
      attemptIndex,
      cliCommand,
    });
  }

  captureChunk(stepIndex: number, chunk: string): void {
    const existing = this.stepOutputBuffer.get(stepIndex);
    if (existing) {
      existing.accumulatedText += chunk;
    }
  }

  captureEvents(stepIndex: number, events: CliEvent[]): void {
    const existing = this.stepOutputBuffer.get(stepIndex);
    if (existing) {
      existing.accumulatedEvents.push(...events);
    }
  }

  captureCompletedOutput(stepIndex: number, output: any): void {
    const existing = this.completedStepOutputs.get(stepIndex);
    const attemptIndex = output.attemptIndex ?? 0;
    if (existing) {
      existing.outputs.push(output);
      if (attemptIndex > 0) {
        const promptItem = this.callbacks.getPromptItem(stepIndex);
        const maxRetries = promptItem?.endCondition?.maxRetries ?? attemptIndex;
        existing.retryState = { currentRetry: attemptIndex, maxRetries };
      }
    } else {
      this.completedStepOutputs.set(stepIndex, { outputs: [output] });
    }
    Log.debug(
      `${this.instanceTag} captureCompletedOutput: step ${stepIndex} attempt ${attemptIndex}, total outputs=${this.completedStepOutputs.get(stepIndex)!.outputs.length}, retryState=${JSON.stringify(this.completedStepOutputs.get(stepIndex)!.retryState ?? null)}`
    );
    // Step is no longer streaming
    this.stepOutputBuffer.delete(stepIndex);
    // Fire prompt-complete event so standalone CLI can render per-step stats.
    this.callbacks.onPromptComplete({
      stepIndex,
      tokens: output.tokens,
      sessionId: output.structured?.metadata?.sessionId,
      harness: output.structured?.metadata?.harness,
      elapsed: output.elapsed,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FinalPrompt capture methods (mirror of regular-step methods, loopIndex key)
  // ─────────────────────────────────────────────────────────────────────────

  captureFinalPromptOutputInit(
    loopIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput: boolean | undefined
  ): void {
    const existing = this.finalPromptOutputBuffer.get(loopIndex);
    this.finalPromptOutputBuffer.set(loopIndex, {
      prompt,
      cliCommand,
      workingDirectory,
      timestampMs,
      attemptIndex,
      accumulatedText: existing?.accumulatedText ?? "",
      accumulatedEvents: existing?.accumulatedEvents ?? [],
      rawTextOutput,
    });
  }

  captureFinalPromptChunk(loopIndex: number, chunk: string): void {
    const existing = this.finalPromptOutputBuffer.get(loopIndex);
    if (existing) {
      existing.accumulatedText += chunk;
    }
  }

  captureFinalPromptEvents(loopIndex: number, events: CliEvent[]): void {
    const existing = this.finalPromptOutputBuffer.get(loopIndex);
    if (existing) {
      existing.accumulatedEvents.push(...events);
    }
  }

  captureFinalPromptCompletedOutput(loopIndex: number, output: any): void {
    const existing = this.finalPromptCompletedOutputs.get(loopIndex);
    if (existing) {
      existing.outputs.push(output);
    } else {
      this.finalPromptCompletedOutputs.set(loopIndex, { outputs: [output] });
    }
    this.finalPromptOutputBuffer.delete(loopIndex);
  }

  onFinalPromptStatusMessage(
    loopIndex: number,
    message: string,
    severity: string
  ): void {
    const messages = this.finalPromptStatusMessages.get(loopIndex) ?? [];
    messages.push({ message, severity, timestamp: Date.now() });
    this.finalPromptStatusMessages.set(loopIndex, messages);
    // Legacy negative index encoding: loop N => -(N+1)
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

  // ─────────────────────────────────────────────────────────────────────────
  // Replay
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Replay all buffered output state to the given dashboard sink.
   * Called by WorkflowInstance.sendFullStateToDashboard() after the initial
   * SESSION_RESTORED message to restore in-progress and completed output.
   */
  replayTo(
    dashboardSink: IDashboardSink,
    state: { status: string; currentIndex: number },
    finalRuntime: { phase: string; loopCount: number } | null | undefined,
    instanceTag: string
  ): void {
    // Replay completed step outputs so the user sees prior-prompt results
    // when switching back to a workflow that is already partway through.
    if (this.completedStepOutputs.size > 0) {
      for (const [stepIndex, entry] of this.completedStepOutputs) {
        Log.trace(
          `${instanceTag} sendFullStateToDashboard: replaying completed step ${stepIndex} (${entry.outputs.length} attempt(s))`
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

    // Replay finalPrompt completed outputs (per loop).
    if (this.finalPromptCompletedOutputs.size > 0) {
      for (const [loopIndex, entry] of this.finalPromptCompletedOutputs) {
        Log.trace(
          `${instanceTag} sendFullStateToDashboard: replaying finalPrompt loop ${loopIndex} (${entry.outputs.length} attempt(s))`
        );
        for (const output of entry.outputs) {
          dashboardSink.updateFinalPromptOutput(loopIndex, output);
        }
      }
    }

    // Replay finalPrompt status messages (encoded as legacy negative step indices).
    if (this.finalPromptStatusMessages.size > 0) {
      const dashboard = dashboardSink as {
        updateStatusMessage?: (
          stepIndex: number,
          message: string,
          severity?: string
        ) => void;
      };
      if (dashboard.updateStatusMessage) {
        for (const [loopIndex, messages] of this.finalPromptStatusMessages) {
          const legacyLoopStepIndex = -(loopIndex + 1);
          for (const msg of messages) {
            dashboard.updateStatusMessage(
              legacyLoopStepIndex,
              msg.message,
              msg.severity
            );
          }
        }
      }
    }

    // Replay buffered streaming output for the currently-running step.
    if (
      state.status === EXECUTION_STATES.RUNNING &&
      this.stepOutputBuffer.size > 0
    ) {
      const buffer = this.stepOutputBuffer.get(state.currentIndex);
      if (buffer) {
        Log.trace(
          `${instanceTag} sendFullStateToDashboard: replaying step ${state.currentIndex} buffer (${buffer.accumulatedText.length} chars, attemptIndex=${buffer.attemptIndex})`
        );

        // Belt-and-suspenders: ensure retryState was already sent above so
        // the webview store accepts attemptIndex > 0 outputs.
        if (buffer.attemptIndex > 0) {
          const completedEntry = this.completedStepOutputs.get(
            state.currentIndex
          );
          if (!completedEntry?.retryState) {
            // Edge case: retry streaming started but completedStepOutputs
            // doesn't have retryState yet (defend against timing gaps).
            const promptItem = this.callbacks.getPromptItem(state.currentIndex);
            const maxRetries =
              promptItem?.endCondition?.maxRetries ?? buffer.attemptIndex;
            Log.trace(
              `${instanceTag} sendFullStateToDashboard: sending fallback retryState for step ${state.currentIndex} (attempt ${buffer.attemptIndex}/${maxRetries})`
            );
            dashboardSink.updateRetryAttempt(
              state.currentIndex,
              buffer.attemptIndex,
              maxRetries
            );
          } else {
            Log.trace(
              `${instanceTag} sendFullStateToDashboard: retryState already sent for step ${state.currentIndex} (attempt ${completedEntry.retryState.currentRetry}/${completedEntry.retryState.maxRetries})`
            );
          }
        }

        dashboardSink.updateCliOutput(state.currentIndex, {
          prompt: buffer.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: buffer.cliCommand,
          workingDirectory: buffer.workingDirectory,
          timestampMs: buffer.timestampMs,
          attemptIndex: buffer.attemptIndex,
          rawTextOutput: buffer.rawTextOutput,
        });
        if (buffer.accumulatedText) {
          dashboardSink.updateCliStreamingChunk(
            state.currentIndex,
            buffer.accumulatedText
          );
        }
        if (buffer.accumulatedEvents.length > 0) {
          dashboardSink.updateCliStreamingEvents(
            state.currentIndex,
            buffer.accumulatedEvents
          );
        }
      }
    }

    // Replay in-flight finalPrompt streaming output when switching back mid-loop.
    if (
      state.status === EXECUTION_STATES.RUNNING &&
      finalRuntime?.phase === FINAL_PROMPT_PHASES.FINAL_PROMPT
    ) {
      const loopIndex = finalRuntime.loopCount;
      const buffer = this.finalPromptOutputBuffer.get(loopIndex);
      if (buffer) {
        Log.trace(
          `${instanceTag} sendFullStateToDashboard: replaying finalPrompt loop ${loopIndex} buffer (${buffer.accumulatedText.length} chars, events=${buffer.accumulatedEvents.length}, attemptIndex=${buffer.attemptIndex})`
        );
        dashboardSink.updateFinalPromptOutput(loopIndex, {
          prompt: buffer.prompt,
          response: buffer.accumulatedText,
          structured:
            buffer.accumulatedEvents.length > 0
              ? { events: [...buffer.accumulatedEvents], metadata: {} }
              : undefined,
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: buffer.cliCommand,
          workingDirectory: buffer.workingDirectory,
          timestampMs: buffer.timestampMs,
          attemptIndex: buffer.attemptIndex,
          rawTextOutput: buffer.rawTextOutput,
        });
      }
    }
  }
}
