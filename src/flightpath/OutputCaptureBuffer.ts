import type { CliEvent } from "../types/WebviewMessageTypes";
import type { WorkflowStep, PromptStep } from "../types/FlightPathTypes";
import { isScriptStep } from "../types/FlightPathTypes";
import { EXECUTION_STATES } from "../types/FlightPathTypes";
import { FINAL_STEP_PHASES } from "../types/DashboardConstants";
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
  getWorkflowStep: (stepIndex: number) => WorkflowStep | undefined;
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
        const promptStep = this.callbacks.getWorkflowStep(stepIndex);
        const promptStepTyped =
          promptStep && !isScriptStep(promptStep)
            ? (promptStep as PromptStep)
            : undefined;
        const maxRetries =
          promptStepTyped?.endCondition?.maxRetries ?? attemptIndex;
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
        const promptStep = this.callbacks.getWorkflowStep(stepIndex);
        const promptStepTyped =
          promptStep && !isScriptStep(promptStep)
            ? (promptStep as PromptStep)
            : undefined;
        const maxRetries =
          promptStepTyped?.endCondition?.maxRetries ?? attemptIndex;
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
  // FinalStep capture methods (mirror of regular-step methods, loopIndex key)
  // ─────────────────────────────────────────────────────────────────────────

  captureFinalStepOutputInit(
    loopIndex: number,
    prompt: string,
    cliCommand: string | undefined,
    workingDirectory: string | undefined,
    timestampMs: number,
    attemptIndex: number,
    rawTextOutput: boolean | undefined
  ): void {
    const existing = this.finalStepOutputBuffer.get(loopIndex);
    this.finalStepOutputBuffer.set(loopIndex, {
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

  captureFinalStepChunk(loopIndex: number, chunk: string): void {
    const existing = this.finalStepOutputBuffer.get(loopIndex);
    if (existing) {
      existing.accumulatedText += chunk;
    }
  }

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

    // Replay finalStep completed outputs (per loop).
    if (this.finalStepCompletedOutputs.size > 0) {
      for (const [loopIndex, entry] of this.finalStepCompletedOutputs) {
        Log.trace(
          `${instanceTag} sendFullStateToDashboard: replaying finalStep loop ${loopIndex} (${entry.outputs.length} attempt(s))`
        );
        for (const output of entry.outputs) {
          dashboardSink.updateFinalStepOutput(loopIndex, output);
        }
      }
    }

    // Replay finalStep status messages (encoded as signed negative step indices).
    if (this.finalStepStatusMessages.size > 0) {
      const dashboard = dashboardSink as {
        updateStatusMessage?: (
          stepIndex: number,
          message: string,
          severity?: string
        ) => void;
      };
      if (dashboard.updateStatusMessage) {
        for (const [loopIndex, messages] of this.finalStepStatusMessages) {
          const negativeLoopStepIndex = -(loopIndex + 1);
          for (const msg of messages) {
            dashboard.updateStatusMessage(
              negativeLoopStepIndex,
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
            const promptStep = this.callbacks.getWorkflowStep(
              state.currentIndex
            );
            const promptStepTyped =
              promptStep && !isScriptStep(promptStep)
                ? (promptStep as PromptStep)
                : undefined;
            const maxRetries =
              promptStepTyped?.endCondition?.maxRetries ?? buffer.attemptIndex;
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

    // Replay in-flight finalStep streaming output when switching back mid-loop.
    if (
      state.status === EXECUTION_STATES.RUNNING &&
      finalRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      const loopIndex = finalRuntime.loopCount;
      const buffer = this.finalStepOutputBuffer.get(loopIndex);
      if (buffer) {
        Log.trace(
          `${instanceTag} sendFullStateToDashboard: replaying finalStep loop ${loopIndex} buffer (${buffer.accumulatedText.length} chars, events=${buffer.accumulatedEvents.length}, attemptIndex=${buffer.attemptIndex})`
        );
        dashboardSink.updateFinalStepOutput(loopIndex, {
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
