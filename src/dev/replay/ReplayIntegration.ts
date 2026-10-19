import {
  HarnessIntegration,
  HarnessStatus,
} from "../../core/HarnessIntegration";
import {
  IntegrationFactory,
  type ExecutionHarnessOverride,
} from "../../core/IntegrationFactory";
import {
  ScriptProcessRunner,
  type ScriptProcessResult,
  type ScriptProcessRunnerOptions,
} from "../../core/orchestration/ScriptProcessRunner";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import {
  FAILURE_KINDS,
  type FailureKind,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { WorkflowContext } from "../../types/WorkflowContextTypes";
import { TIMELINE_ATTEMPT_TERMINAL_STATES } from "../../types/WorkflowTimelineTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import {
  retimeEvents,
  scaleDelay,
  type RecordedAiAttempt,
} from "./ReplayScript";
import {
  applyRecordedFileWrites,
  applySnapshotAfterState,
} from "./ReplayWorkspace";
import type { RunReplaySession } from "./RunReplaySession";

/** Resolves after `ms`, or as soon as `signal` aborts; false when it aborted. */
function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer =
      ms === Number.POSITIVE_INFINITY ? undefined : setTimeout(done, ms, true);
    function done(completed: boolean): void {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    }
    function onAbort(): void {
      done(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stands in for one harness during a replay. `sendPrompt` returns at once,
 * like a launched CLI, and the recorded attempt then streams in with its
 * original relative timing before the response completes.
 */
export class ReplayIntegration extends HarnessIntegration {
  private playback?: AbortController;
  private lastOutput?: CliOutput;
  private lastFailed = false;

  constructor(
    private readonly session: RunReplaySession,
    private readonly harness: HarnessId
  ) {
    super(undefined, false);
  }

  async initialize(): Promise<void> {}

  async sendPrompt(
    prompt: PromptStep,
    _needsCompletionDetection?: boolean,
    workflowContext?: WorkflowContext
  ): Promise<boolean> {
    const promptIndex = workflowContext?.promptIndex ?? 0;
    const attempt = await this.session.takeAiAttempt(promptIndex);
    if (!attempt) {
      this.lastFailureReason = `The replayed run has no further recorded attempt for step ${promptIndex + 1}.`;
      return false;
    }
    this.playback?.abort();
    const playback = new AbortController();
    this.playback = playback;
    this.lastOutput = undefined;
    this.lastFailed = false;
    this.promptReadyEmitter.fire({
      fullPrompt: prompt.prompt,
      cliCommand: attempt.finalOutput?.cliCommand,
    });
    void this.play(attempt, playback.signal);
    return true;
  }

  private async play(
    attempt: RecordedAiAttempt,
    signal: AbortSignal
  ): Promise<void> {
    const { speed, workspaceRoot } = this.session;
    const startedAt = Date.now();
    const at = (offsetMs: number): number =>
      Math.max(0, startedAt + scaleDelay(offsetMs, speed) - Date.now());
    const retime = (
      events: NonNullable<RecordedAiAttempt["items"][number]["events"]>
    ) => retimeEvents(events, attempt.startedAt, startedAt, speed);

    for (const item of attempt.items) {
      if (this.session.isPausedAt(item.sequence)) {
        await waitFor(Number.POSITIVE_INFINITY, signal);
        return;
      }
      if (!(await waitFor(at(item.offsetMs), signal))) return;
      if (item.events) {
        await applyRecordedFileWrites(workspaceRoot, item.events);
        this.streamingEventsEmitter.fire(retime(item.events));
      } else if (item.chunk !== undefined) {
        this.streamingChunkEmitter.fire(item.chunk);
      }
    }
    if (!(await waitFor(at(attempt.durationMs), signal))) return;
    if (attempt.snapshot) {
      await applySnapshotAfterState(workspaceRoot, attempt.snapshot);
    }
    const structured = attempt.finalOutput?.structured;
    this.lastOutput = attempt.finalOutput
      ? {
          ...attempt.finalOutput,
          ...(structured
            ? {
                structured: {
                  ...structured,
                  events: retime(structured.events),
                },
              }
            : {}),
        }
      : undefined;
    this.lastFailed =
      attempt.terminalState !== TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED;
    this.responseCompleteEmitter.fire(undefined);
  }

  override get rawTextOutput(): boolean {
    return this.lastOutput?.rawTextOutput === true;
  }

  override getLastParsedOutput(): UniversalCliOutput | undefined {
    return this.lastOutput?.structured as UniversalCliOutput | undefined;
  }

  override getLastCliCommand(): string | undefined {
    return this.lastOutput?.cliCommand;
  }

  override getLastFailureKind(): FailureKind | undefined {
    return this.lastFailed ? FAILURE_KINDS.HARNESS_ERROR : undefined;
  }

  override wasLastFailureHarnessError(): boolean {
    return this.lastFailed;
  }

  getStatus(): { available: boolean; message: string; strategy: string } {
    return {
      available: true,
      message: "replaying a recorded run",
      strategy: "replay",
    };
  }

  isIntegrationAvailable(): boolean {
    return true;
  }

  getIntegrationMode(): string {
    return this.harness;
  }

  getInitializationStatus(): HarnessStatus {
    return HarnessStatus.Ready;
  }

  isReady(): boolean {
    return true;
  }

  protected async cancelImplementation(): Promise<void> {
    this.playback?.abort();
  }

  override dispose(): void {
    this.playback?.abort();
    super.dispose();
  }
}

/** A script run answered from the recording; nothing is spawned. */
export class ReplayScriptProcessRunner extends ScriptProcessRunner {
  private readonly playback = new AbortController();

  constructor(
    private readonly session: RunReplaySession,
    executionRoot: string
  ) {
    super(executionRoot, {
      spawn: () => Promise.reject(new Error("a replay never spawns a process")),
      cancel: async () => {},
      dispose: () => {},
    });
  }

  override async run(
    options: ScriptProcessRunnerOptions
  ): Promise<ScriptProcessResult> {
    const script = await this.session.takeScript(options.argv);
    if (!script) {
      return {
        success: false,
        result: "",
        error: `The replayed run has no further recorded script for: ${options.argv.join(" ")}`,
        errored: true,
      };
    }
    if (
      !(await waitFor(
        scaleDelay(script.durationMs, this.session.speed),
        this.playback.signal
      ))
    ) {
      return { success: false, result: "", cancelled: true };
    }
    if (script.stdout) options.onOutput?.(script.stdout);
    return {
      success: script.exitCode === 0,
      result: script.stdout.trim(),
      stdout: script.stdout.trim(),
      stderr: script.stderr.trim(),
      error: script.stderr.trim() || undefined,
      ...(script.exitCode !== undefined ? { exitCode: script.exitCode } : {}),
      errored: false,
    };
  }

  override async cancel(): Promise<void> {
    this.playback.abort();
  }

  override dispose(): void {
    this.playback.abort();
  }
}

export class ReplayIntegrationFactory extends IntegrationFactory {
  constructor(
    platform: PlatformAdapter,
    private readonly session: RunReplaySession
  ) {
    super(platform);
  }

  override createForExecution(harness: HarnessId): HarnessIntegration {
    const integration = new ReplayIntegration(this.session, harness);
    integration.markAsReady();
    return integration;
  }

  override createScriptProcessRunner(
    executionRoot: string
  ): ScriptProcessRunner {
    return new ReplayScriptProcessRunner(this.session, executionRoot);
  }
}

/** Every harness reads as installed and ready: a replay needs none of them. */
export function createReplayOverride(
  platform: PlatformAdapter,
  session: RunReplaySession
): ExecutionHarnessOverride {
  const integrationFactory = new ReplayIntegrationFactory(platform, session);
  const detectors = new Map<HarnessId, HarnessIntegration>();
  return {
    integrationFactory,
    resolveDetectorIntegration: (harnessOverride) => {
      const harness =
        harnessOverride ?? ConfigurationUtils.getIntegrationMode();
      let detector = detectors.get(harness);
      if (!detector) {
        detector = integrationFactory.createForExecution(harness);
        detectors.set(harness, detector);
      }
      return detector;
    },
  };
}
