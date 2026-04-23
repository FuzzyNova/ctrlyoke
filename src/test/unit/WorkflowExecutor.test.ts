import * as assert from "assert";
import { suite, test } from "mocha";
import {
  WorkflowExecutor,
  WorkflowExecutionContext,
} from "../../flightpath/WorkflowExecutor";
import { PromptQueue } from "../../flightpath/PromptQueue";
import { EndConditionEvaluator } from "../../flightpath/EndConditionEvaluator";
import { EndConditionHandler } from "../../flightpath/EndConditionHandler";
import { HarnessIntegration } from "../../flightpath/HarnessIntegration";
import { HarnessStatus } from "../../flightpath/HarnessIntegration";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import { PromptStep, PromptFile } from "../../types/FlightPathTypes";
import {
  HARNESS_IDS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import { CliEvent } from "../../types/WebviewMessageTypes";

class MockPlatform implements PlatformAdapter {
  getConfig<T>(_key: string, defaultValue: T): T {
    return defaultValue;
  }
  getWorkspaceRoot(): string {
    return process.cwd();
  }
  log(_message: string): void {}
  warn(_message: string): void {}
  error(_message: string): void {}
  showProgress(_message: string): void {}
  async showChoice(
    _message: string,
    ..._options: string[]
  ): Promise<string | undefined> {
    return undefined;
  }
  getExtensionPath(): string {
    return process.cwd();
  }
}

type SendOutcome = {
  success?: boolean;
  responseText?: string;
  afterResponse?: () => Promise<void> | void;
};

class MockHarnessIntegration extends HarnessIntegration {
  public sentPrompts: string[] = [];
  public processExitFailure: boolean = false;
  public lastFailureOutput?: string;
  public lastCliCommandValue?: string;
  public onSend?: (
    prompt: PromptStep,
    workflowContext?: Parameters<HarnessIntegration["sendPrompt"]>[2]
  ) => Promise<SendOutcome>;

  async initialize(): Promise<void> {}

  async sendPrompt(
    prompt: PromptStep,
    _needsCompletionDetection?: boolean,
    workflowContext?: Parameters<HarnessIntegration["sendPrompt"]>[2]
  ): Promise<boolean> {
    this.sentPrompts.push(prompt.prompt);
    this.promptReadyEmitter.fire({ fullPrompt: prompt.prompt });

    const outcome = this.onSend
      ? await this.onSend(prompt, workflowContext)
      : { success: true, responseText: `ok:${prompt.prompt}` };

    const success = outcome.success ?? true;
    if (!success) {
      return false;
    }

    this.responseCompleteEmitter.fire(
      outcome.responseText ?? `ok:${prompt.prompt}`
    );
    if (outcome.afterResponse) {
      await outcome.afterResponse();
    }

    return true;
  }

  getStatus(): { available: boolean; message: string; strategy: string } {
    return { available: true, message: "ready", strategy: "mock" };
  }

  override wasLastFailureProcessExit(): boolean {
    return this.processExitFailure;
  }

  override getLastFailureOutput(): string | undefined {
    return this.lastFailureOutput;
  }

  override getLastCliCommand(): string | undefined {
    return this.lastCliCommandValue;
  }

  isIntegrationAvailable(): boolean {
    return true;
  }

  getIntegrationMode(): string {
    return HARNESS_IDS.COPILOT_CLI;
  }

  getInitializationStatus(): HarnessStatus {
    return HarnessStatus.Ready;
  }

  isReady(): boolean {
    return true;
  }

  protected async cancelImplementation(): Promise<void> {}
}

function makeContext(
  integration: MockHarnessIntegration
): WorkflowExecutionContext {
  return {
    workspaceFolderPath: process.cwd(),
    currentPromptFilePath: "workflow.flightpath.yaml",
    shouldShowCliCommand: false,
    showCliOutput: false,
    dynamicQueueConfig: {
      maxQueueSize: 100,
      maxWorkflowExecutionTime: 3600,
      unlimitedMode: false,
      notifyOnExtension: false,
    },
    getIntegrationForPrompt: () => integration,
    historyFilePath: "",
  };
}

function makeExecutor(queue: PromptQueue): WorkflowExecutor {
  const platform = new MockPlatform();
  const evaluator = new EndConditionEvaluator(platform);
  const handler = new EndConditionHandler(
    evaluator,
    queue,
    () => undefined,
    platform
  );
  return new WorkflowExecutor(queue, handler, evaluator, platform);
}

async function pauseQueueExecution(queue: PromptQueue): Promise<void> {
  if (queue.getRuntimeStateMachine().pause()) {
    await queue.commitRuntimeTransition({ persist: false });
  }
}

async function requestQueueStop(queue: PromptQueue): Promise<void> {
  if (!queue.getRuntimeStateMachine().requestStop()) {
    return;
  }

  queue.markInFlightPromptCancelled();
  await queue.commitRuntimeTransition({ persist: false });
}

async function confirmQueueStopped(queue: PromptQueue): Promise<void> {
  if (!queue.getRuntimeStateMachine().confirmStopped()) {
    return;
  }

  queue.finalizeCancelledPromptAfterStop();
  await queue.commitRuntimeTransition({ persist: false });
}

async function resumeQueueExecution(queue: PromptQueue): Promise<void> {
  if (queue.getRuntimeStateMachine().resume()) {
    await queue.commitRuntimeTransition({ persist: false });
  }
}

suite("WorkflowExecutor finalStep phase 2", () => {
  test("preserves behavior when finalStep is absent", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const promptFile: PromptFile = {
      steps: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
    };
    queue.loadPrompts(promptFile);

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1", "queue-2"]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getFinalStepRuntime(), undefined);
  });

  test("runs finalStep once after queue drains", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
      finalStep: { prompt: "final-gate" },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "queue-1",
      "queue-2",
      "final-gate",
    ]);
    const runtime = queue.getFinalStepRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(runtime?.loopCount, 0);
    assert.strictEqual(runtime?.status, STEP_STATUS.COMPLETED);
    assert.ok(runtime?.completedAt);
  });

  test("repeats loop when finalStep appends queue work", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    let finalRuns = 0;
    integration.onSend = async (prompt, _workflowContext) => {
      if (prompt.prompt === "final-loop") {
        finalRuns++;
        if (finalRuns === 1) {
          await queue.appendSteps([{ prompt: "queue-appended" }], "test");
        }
      }
      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-loop", mcpServers: ["flightpath"] },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "queue-1",
      "final-loop",
      "queue-appended",
      "final-loop",
    ]);
    const runtime = queue.getFinalStepRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.loopCount, 1);
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
  });

  test("does not loop when queue does not grow", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-once" },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1", "final-once"]);
    const finalRuns = integration.sentPrompts.filter(
      (p) => p === "final-once"
    ).length;
    assert.strictEqual(finalRuns, 1);
  });

  test("preserves finalStep runtime phase on pause during finalStep", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-pause") {
        return {
          success: true,
          responseText: "ok",
          afterResponse: async () => {
            await pauseQueueExecution(queue);
          },
        };
      }
      return { success: true, responseText: "ok" };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-pause" },
    });

    await executor.execute(integration, makeContext(integration));

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.PAUSED);
    const runtime = queue.getFinalStepRuntime();
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(runtime?.loopCount, 0);
  });

  test("preserves finalStep runtime phase on stop/error during finalStep", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    let run = 0;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-stop-error") {
        run++;
        if (run === 1) {
          await requestQueueStop(queue);
          return { success: false };
        }
        return { success: false };
      }
      return { success: true, responseText: "ok" };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-stop-error" },
    });

    await executor.execute(integration, makeContext(integration));

    const runtimeAfterStop = queue.getFinalStepRuntime();
    assert.strictEqual(runtimeAfterStop?.phase, FINAL_STEP_PHASES.FINAL_STEP);

    // Simulate resume and force an actual error on finalStep send failure
    await confirmQueueStopped(queue);
    await resumeQueueExecution(queue);
    await executor.execute(integration, makeContext(integration));

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
    const runtimeAfterError = queue.getFinalStepRuntime();
    assert.strictEqual(runtimeAfterError?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(runtimeAfterError?.status, STEP_STATUS.FAILED);
  });

  test("emits finalStep status and output updates to dashboard sink", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const statusUpdates: Array<{
      status: string | null;
      loopCount: number;
      phase: string | null;
    }> = [];
    const outputUpdates: Array<{ loopIndex: number; output: unknown }> = [];

    const context = makeContext(integration);
    context.dashboardProvider = {
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateProgress: () => {},
      updateCliStreamingChunk: () => {},
      updateCliOutput: () => {},
      updateExecutionCompleted: () => {},
      updateFinalStepStatus: (
        status: string | null,
        loopCount: number,
        phase: string | null
      ) => {
        statusUpdates.push({ status, loopCount, phase });
      },
      updateFinalStepOutput: (loopIndex: number, output: unknown) => {
        outputUpdates.push({ loopIndex, output });
      },
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
    } as any;

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-observe" },
    });

    await executor.execute(integration, context);

    assert.ok(
      statusUpdates.some(
        (u) =>
          u.phase === FINAL_STEP_PHASES.FINAL_STEP &&
          u.status === STEP_STATUS.RUNNING &&
          u.loopCount === 0
      )
    );
    assert.ok(
      statusUpdates.some(
        (u) =>
          u.phase === FINAL_STEP_PHASES.FINAL_STEP &&
          u.status === STEP_STATUS.COMPLETED &&
          u.loopCount === 0
      )
    );
    assert.ok(outputUpdates.length >= 1);
    assert.ok(outputUpdates.every((u) => u.loopIndex === 0));
    assert.ok(outputUpdates.some((u: any) => u.output?.isStreaming === false));
  });

  test("captures finalStep output using dedicated replay-safe callbacks", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const initCalls: Array<{ loopIndex: number; attemptIndex: number }> = [];
    const chunkCalls: Array<{ loopIndex: number; chunk: string }> = [];
    const eventCalls: Array<{ loopIndex: number; events: CliEvent[] }> = [];
    const completedCalls: Array<{ loopIndex: number; output: any }> = [];

    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-capture") {
        (integration as any).streamingChunkEmitter.fire("final-chunk");
        (integration as any).streamingEventsEmitter.fire([
          {
            type: "text",
            timestamp: new Date().toISOString(),
            data: { text: "structured" },
          },
        ]);
      }

      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    const context = makeContext(integration);
    context.captureFinalStepOutputInit = (
      loopIndex,
      _prompt,
      _cliCommand,
      _workingDirectory,
      _timestampMs,
      attemptIndex
    ) => {
      initCalls.push({ loopIndex, attemptIndex });
    };
    context.captureFinalStepChunk = (loopIndex, chunk) => {
      chunkCalls.push({ loopIndex, chunk });
    };
    context.captureFinalStepEvents = (loopIndex, events) => {
      eventCalls.push({ loopIndex, events });
    };
    context.captureFinalStepCompletedOutput = (loopIndex, output) => {
      completedCalls.push({ loopIndex, output });
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-capture" },
    });

    await executor.execute(integration, context);

    assert.ok(initCalls.some((c) => c.loopIndex === 0 && c.attemptIndex === 0));
    assert.ok(
      chunkCalls.some((c) => c.loopIndex === 0 && c.chunk === "final-chunk")
    );
    assert.ok(
      eventCalls.some(
        (c) => c.loopIndex === 0 && c.events.some((e) => e.type === "text")
      )
    );
    assert.strictEqual(completedCalls.length, 1);
    assert.strictEqual(completedCalls[0].loopIndex, 0);
    assert.strictEqual(completedCalls[0].output.prompt, "final-capture");
    assert.strictEqual(completedCalls[0].output.isStreaming, false);
  });

  test("stops on process exit and persists warning plus PTY tail", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const captureCalls: Array<{ stepIndex: number; output: any }> = [];
    const statusCalls: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];
    const appendedStatusMessages: Array<{
      target: unknown;
      statusMessage: any;
    }> = [];
    const historySaves: Array<{
      target: unknown;
      cliOutputs: any[];
    }> = [];
    const historyCallOrder: string[] = [];

    integration.processExitFailure = true;
    integration.lastFailureOutput = [
      "copilot: starting interactive session",
      "error: unknown option '--poopy'",
    ].join("\n");
    integration.lastCliCommandValue = "copilot --poopy";
    integration.onSend = async () => {
      (integration as any).lastFailureReason =
        "CLI process exited unexpectedly while waiting for SessionStart hook (exit code 0)";
      return { success: false };
    };

    const context = makeContext(integration);
    context.captureCompletedOutput = (stepIndex, output) => {
      captureCalls.push({ stepIndex, output });
    };
    context.onStatusMessage = (stepIndex, message, severity) => {
      statusCalls.push({ stepIndex, message, severity });
    };
    context.historyFilePath = "history.json";
    context.outputHistoryManager = {
      appendStatusMessage: async (
        _historyFilePath: string,
        target: unknown,
        statusMessage: any
      ) => {
        historyCallOrder.push("status");
        appendedStatusMessages.push({ target, statusMessage });
      },
      saveExecutionOutput: async (
        _historyFilePath: string,
        target: unknown,
        cliOutputs: any[]
      ) => {
        historyCallOrder.push("output");
        historySaves.push({ target, cliOutputs });
      },
    } as any;

    queue.loadPrompts({
      steps: [{ prompt: "bad-args" }, { prompt: "next-step" }],
    });

    await executor.execute(integration, context);

    const finalState = queue.getState();
    assert.strictEqual(finalState.status, EXECUTION_STATES.STOPPED);
    assert.strictEqual(finalState.currentIndex, 1);
    assert.strictEqual(finalState.results[0].status, STEP_STATUS.CANCELLED);
    assert.strictEqual(finalState.results[1].status, STEP_STATUS.PENDING);

    assert.strictEqual(statusCalls.length, 1);
    assert.strictEqual(statusCalls[0].stepIndex, 0);
    assert.strictEqual(statusCalls[0].severity, "warning");
    assert.match(statusCalls[0].message, /Process exited unexpectedly/);

    assert.strictEqual(captureCalls.length, 1);
    assert.strictEqual(captureCalls[0].stepIndex, 0);
    assert.strictEqual(
      captureCalls[0].output.errorMessage,
      "CLI process exited unexpectedly while waiting for SessionStart hook (exit code 0)"
    );
    assert.match(captureCalls[0].output.response, /unknown option '--poopy'/);
    assert.strictEqual(captureCalls[0].output.rawTextOutput, true);

    assert.strictEqual(historySaves.length, 1);
    assert.strictEqual(appendedStatusMessages.length, 1);
    assert.deepStrictEqual(appendedStatusMessages[0].target, {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    });
    assert.strictEqual(
      appendedStatusMessages[0].statusMessage.severity,
      "warning"
    );
    assert.match(
      appendedStatusMessages[0].statusMessage.message,
      /Process exited unexpectedly/
    );
    assert.deepStrictEqual(historyCallOrder, ["status", "output"]);
    assert.deepStrictEqual(historySaves[0].target, {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    });
    assert.strictEqual(historySaves[0].cliOutputs.length, 1);
    assert.match(
      historySaves[0].cliOutputs[0].response,
      /unknown option '--poopy'/
    );
  });
});
