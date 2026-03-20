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
import { PromptItem, PromptFile, Harness } from "../../types/FlightPathTypes";
import { EXECUTION_STATES, STEP_STATUS } from "../../types/DashboardConstants";
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
  public onSend?: (
    prompt: PromptItem,
    workflowContext?: Parameters<HarnessIntegration["sendPrompt"]>[2]
  ) => Promise<SendOutcome>;

  async initialize(): Promise<void> {}

  async sendPrompt(
    prompt: PromptItem,
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

  isIntegrationAvailable(): boolean {
    return true;
  }

  getIntegrationMode(): string {
    return Harness.CopilotCli;
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
      enabled: true,
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

suite("WorkflowExecutor finalPrompt phase 2", () => {
  test("preserves behavior when finalPrompt is absent", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const promptFile: PromptFile = {
      prompts: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
    };
    queue.loadPrompts(promptFile);

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1", "queue-2"]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getFinalPromptRuntime(), undefined);
  });

  test("runs finalPrompt once after queue drains", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      prompts: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
      finalPrompt: { prompt: "final-gate" },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "queue-1",
      "queue-2",
      "final-gate",
    ]);
    const runtime = queue.getFinalPromptRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.phase, "finalPrompt");
    assert.strictEqual(runtime?.loopCount, 0);
    assert.strictEqual(runtime?.status, STEP_STATUS.COMPLETED);
    assert.ok(runtime?.completedAt);
  });

  test("repeats loop when finalPrompt appends queue work", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    let finalRuns = 0;
    integration.onSend = async (prompt, workflowContext) => {
      if (prompt.prompt === "final-loop") {
        finalRuns++;
        if (finalRuns === 1) {
          await workflowContext?.promptQueue?.appendPrompts(
            [{ prompt: "queue-appended" }],
            "test"
          );
        }
      }
      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    queue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
      finalPrompt: { prompt: "final-loop", allowDynamicExtension: true },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "queue-1",
      "final-loop",
      "queue-appended",
      "final-loop",
    ]);
    const runtime = queue.getFinalPromptRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.loopCount, 1);
    assert.strictEqual(runtime?.phase, "finalPrompt");
  });

  test("does not loop when queue does not grow", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
      finalPrompt: { prompt: "final-once", allowDynamicExtension: true },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1", "final-once"]);
    const finalRuns = integration.sentPrompts.filter(
      (p) => p === "final-once"
    ).length;
    assert.strictEqual(finalRuns, 1);
  });

  test("preserves finalPrompt runtime phase on pause during finalPrompt", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-pause") {
        return {
          success: true,
          responseText: "ok",
          afterResponse: async () => {
            await queue.pause();
          },
        };
      }
      return { success: true, responseText: "ok" };
    };

    queue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
      finalPrompt: { prompt: "final-pause" },
    });

    await executor.execute(integration, makeContext(integration));

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.PAUSED);
    const runtime = queue.getFinalPromptRuntime();
    assert.strictEqual(runtime?.phase, "finalPrompt");
    assert.strictEqual(runtime?.loopCount, 0);
  });

  test("preserves finalPrompt runtime phase on stop/error during finalPrompt", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    let run = 0;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-stop-error") {
        run++;
        if (run === 1) {
          queue.stop();
          return { success: false };
        }
        return { success: false };
      }
      return { success: true, responseText: "ok" };
    };

    queue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
      finalPrompt: { prompt: "final-stop-error" },
    });

    await executor.execute(integration, makeContext(integration));

    const runtimeAfterStop = queue.getFinalPromptRuntime();
    assert.strictEqual(runtimeAfterStop?.phase, "finalPrompt");

    // Simulate resume and force an actual error on finalPrompt send failure
    await queue.resume();
    await executor.execute(integration, makeContext(integration));

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
    const runtimeAfterError = queue.getFinalPromptRuntime();
    assert.strictEqual(runtimeAfterError?.phase, "finalPrompt");
    assert.strictEqual(runtimeAfterError?.status, STEP_STATUS.FAILED);
  });

  test("emits finalPrompt status and output updates to dashboard sink", async () => {
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
      updateFinalPromptStatus: (
        status: string | null,
        loopCount: number,
        phase: string | null
      ) => {
        statusUpdates.push({ status, loopCount, phase });
      },
      updateFinalPromptOutput: (loopIndex: number, output: unknown) => {
        outputUpdates.push({ loopIndex, output });
      },
    } as any;

    queue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
      finalPrompt: { prompt: "final-observe" },
    });

    await executor.execute(integration, context);

    assert.ok(
      statusUpdates.some(
        (u) =>
          u.phase === "finalPrompt" &&
          u.status === STEP_STATUS.RUNNING &&
          u.loopCount === 0
      )
    );
    assert.ok(
      statusUpdates.some(
        (u) =>
          u.phase === "finalPrompt" &&
          u.status === STEP_STATUS.COMPLETED &&
          u.loopCount === 0
      )
    );
    assert.ok(outputUpdates.length >= 1);
    assert.ok(outputUpdates.every((u) => u.loopIndex === 0));
    assert.ok(outputUpdates.some((u: any) => u.output?.isStreaming === false));
  });

  test("captures finalPrompt output using dedicated replay-safe callbacks", async () => {
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
    context.captureFinalPromptOutputInit = (
      loopIndex,
      _prompt,
      _cliCommand,
      _workingDirectory,
      _timestampMs,
      attemptIndex
    ) => {
      initCalls.push({ loopIndex, attemptIndex });
    };
    context.captureFinalPromptChunk = (loopIndex, chunk) => {
      chunkCalls.push({ loopIndex, chunk });
    };
    context.captureFinalPromptEvents = (loopIndex, events) => {
      eventCalls.push({ loopIndex, events });
    };
    context.captureFinalPromptCompletedOutput = (loopIndex, output) => {
      completedCalls.push({ loopIndex, output });
    };

    queue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
      finalPrompt: { prompt: "final-capture" },
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
});
