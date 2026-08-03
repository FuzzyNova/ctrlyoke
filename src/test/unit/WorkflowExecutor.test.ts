import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  WorkflowExecutor,
  WorkflowExecutionContext,
} from "../../core/WorkflowExecutor";
import { PromptQueue } from "../../core/PromptQueue";
import {
  EndConditionEvaluator,
  type EvaluationResult,
} from "../../core/EndConditionEvaluator";
import { EndConditionHandler } from "../../core/EndConditionHandler";
import { PromptFile, type ScriptProperties } from "../../types/CtrlYokeTypes";
import {
  HARNESS_IDS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  CONDITION_ACTIONS,
} from "../../types/DashboardConstants";
import { CliEvent } from "../../types/WebviewMessageTypes";
import { Log } from "../../utils/Log";
import { MockHarnessIntegration, MockPlatform } from "../helpers/mockHarness";

function makeContext(
  integration: MockHarnessIntegration
): WorkflowExecutionContext {
  return {
    workspaceFolderPath: process.cwd(),
    currentPromptFilePath: "workflow.ctrlyoke.yaml",
    shouldShowCliCommand: false,
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

function makeExecutor(
  queue: PromptQueue,
  evaluator?: EndConditionEvaluator
): WorkflowExecutor {
  const platform = new MockPlatform();
  const conditionEvaluator = evaluator ?? new EndConditionEvaluator(platform);
  const handler = new EndConditionHandler(
    conditionEvaluator,
    queue,
    () => undefined
  );
  return new WorkflowExecutor(queue, handler, conditionEvaluator, platform);
}

class FixedEvaluationEvaluator extends EndConditionEvaluator {
  constructor(
    platform: MockPlatform,
    private readonly fixedResult: EvaluationResult
  ) {
    super(platform);
  }

  override async evaluateCondition(
    _condition: ScriptProperties
  ): Promise<EvaluationResult> {
    return this.fixedResult;
  }
}

async function requestQueuePause(queue: PromptQueue): Promise<void> {
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
  test("logs the effective next-step harness instead of the default integration", async () => {
    const queue = new PromptQueue();
    const defaultIntegration = new MockHarnessIntegration(undefined, false);
    const effectiveIntegration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    const requestedHarnesses: Array<string | undefined> = [];
    const messages: string[] = [];

    queue.loadPrompts({
      steps: [
        {
          prompt: "uses an override",
          harness: HARNESS_IDS.ANTIGRAVITY_CLI,
        },
      ],
    });
    const context: WorkflowExecutionContext = {
      ...makeContext(effectiveIntegration),
      getIntegrationForPrompt: (_prompt, harnessOverride) => {
        requestedHarnesses.push(harnessOverride);
        return effectiveIntegration;
      },
    };
    const originalInfo = Log.info;
    Log.info = (message: string) => {
      messages.push(message);
    };

    try {
      await executor.execute(defaultIntegration, context);
    } finally {
      Log.info = originalInfo;
    }

    const startMessage = messages.find((message) =>
      message.includes("Workflow started -")
    );
    assert.ok(startMessage);
    assert.ok(
      startMessage.includes(`next harness: ${HARNESS_IDS.ANTIGRAVITY_CLI}`),
      startMessage
    );
    assert.deepStrictEqual(requestedHarnesses, [HARNESS_IDS.ANTIGRAVITY_CLI]);
  });

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

  test("publishes and persists pre- and end-condition output", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    const liveStatuses: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];
    const persistedStatuses: Array<{
      target: unknown;
      message: string;
      severity: string;
    }> = [];

    const outputHistoryManager = new Proxy(
      {
        appendStatusMessage: async (
          _historyFilePath: string,
          target: unknown,
          statusMessage: { message: string; severity: string }
        ) => {
          persistedStatuses.push({
            target,
            message: statusMessage.message,
            severity: statusMessage.severity,
          });
        },
      },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (async () => undefined),
      }
    );

    queue.loadPrompts({
      steps: [
        {
          prompt: "condition-output",
          preCondition: {
            script: `node -e "process.stdout.write('pre-output')"`,
            compareSource: "stdout",
            returns: "pre-output",
          },
          endCondition: {
            script: `node -e "process.stdout.write('end-output')"`,
            compareSource: "stdout",
            returns: "end-output",
          },
        },
      ],
    });

    await executor.execute(integration, {
      ...makeContext(integration),
      historyFilePath: "manifest.json",
      outputHistoryManager: outputHistoryManager as any,
      onStatusMessage: (stepIndex, message, severity) => {
        liveStatuses.push({ stepIndex, message, severity });
      },
    });

    const preResult = liveStatuses.find((status) =>
      status.message.startsWith("Pre-condition passed")
    );
    assert.ok(preResult);
    assert.match(preResult.message, /stdout = "pre-output"/);
    assert.match(preResult.message, /→ continue/);
    assert.strictEqual(preResult.severity, "info");

    const endResult = liveStatuses.find((status) =>
      status.message.startsWith("End condition passed")
    );
    assert.ok(endResult);
    assert.match(endResult.message, /stdout = "end-output"/);
    assert.strictEqual(endResult.severity, "info");

    assert.deepStrictEqual(
      persistedStatuses.map(({ message, severity }) => ({
        message,
        severity,
      })),
      liveStatuses.map(({ message, severity }) => ({ message, severity }))
    );
    assert.ok(
      persistedStatuses.every(
        ({ target }) =>
          JSON.stringify(target) ===
          JSON.stringify({
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: 0,
          })
      )
    );

    assert.deepStrictEqual(queue.getState().results[0].preCondition, {
      passed: true,
      action: CONDITION_ACTIONS.CONTINUE,
      script: `node -e "process.stdout.write('pre-output')"`,
      actual: "pre-output",
      actualSource: "stdout",
      stdout: "pre-output",
      stderr: "",
      exitCode: 0,
      durationMs: queue.getState().results[0].preCondition?.durationMs,
    });
    assert.strictEqual(queue.getState().results[0].endCondition?.passed, true);
    assert.strictEqual(
      queue.getState().results[0].endCondition?.stdout,
      "end-output"
    );
  });

  test("round-trips a passing end-condition retry through history before advancing", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    const retryRecords: Array<{
      target: unknown;
      runIndex: number;
      attemptIndex: number;
      previousAttemptIndex: number;
      retryPrompt: string;
    }> = [];
    const outputHistoryManager = new Proxy(
      {
        recordRetryScheduled: async (
          _historyFilePath: string,
          target: unknown,
          runIndex: number,
          attemptIndex: number,
          previousAttemptIndex: number,
          retryPrompt: string
        ) => {
          retryRecords.push({
            target,
            runIndex,
            attemptIndex,
            previousAttemptIndex,
            retryPrompt,
          });
        },
      },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (async () => undefined),
      }
    );

    queue.loadPrompts({
      steps: [
        {
          prompt: "write the regression test",
          endCondition: {
            script: `node -e "process.stdout.write('ok')"`,
            compareSource: "stdout",
            returns: "ok",
            onPass: "retry",
            onFail: "stopWorkflow",
            maxRetries: 1,
            passRetryPrompt: "strengthen the regression test",
          },
        },
        { prompt: "continue the workflow" },
      ],
    });

    await executor.execute(integration, {
      ...makeContext(integration),
      historyFilePath: "history.json",
      outputHistoryManager: outputHistoryManager as any,
    });

    assert.deepStrictEqual(integration.sentPrompts, [
      "write the regression test",
      "strengthen the regression test",
      "continue the workflow",
    ]);
    assert.deepStrictEqual(retryRecords, [
      {
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 0,
        attemptIndex: 1,
        previousAttemptIndex: 0,
        retryPrompt: "strengthen the regression test",
      },
    ]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getState().currentIndex, 2);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
    assert.strictEqual(
      queue.getState().results[1].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("skips disabled queue steps without sending them to the harness", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [
        { prompt: "disabled-step", enabled: false },
        { prompt: "enabled-step" },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["enabled-step"]);
    assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.SKIPPED);
    assert.strictEqual(
      queue.getState().steps[0]._runtime?.terminalStatus,
      STEP_STATUS.SKIPPED
    );
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
  });

  test("records a failed pre-condition that skips the prompt", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [
        {
          prompt: "should be skipped",
          preCondition: {
            script: `node -e "process.exit(1)"`,
            onFail: CONDITION_ACTIONS.SKIP_PROMPT,
          },
        },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, []);
    assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.SKIPPED);
    assert.strictEqual(queue.getState().results[0].preCondition?.passed, false);
    assert.strictEqual(
      queue.getState().results[0].preCondition?.action,
      CONDITION_ACTIONS.SKIP_PROMPT
    );
  });

  test("records a pre-condition evaluator error before continuing", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const platform = new MockPlatform();
    const evaluator = new FixedEvaluationEvaluator(platform, {
      passed: false,
      matchRule: "none",
      actual: "",
      actualSource: "exitCode",
      errored: true,
      stdout: "",
      stderr: "evaluator failed",
      result: "",
      duration: 3,
      error: "evaluator failed",
    });
    const executor = makeExecutor(queue, evaluator);

    queue.loadPrompts({
      steps: [
        {
          prompt: "continues after gate error",
          preCondition: { script: "check-gate.js" },
          errorBehavior: { onError: "continue" },
        },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "continues after gate error",
    ]);
    assert.strictEqual(queue.getState().results[0].preCondition?.passed, false);
    assert.strictEqual(
      queue.getState().results[0].preCondition?.action,
      CONDITION_ACTIONS.CONTINUE
    );
    assert.strictEqual(
      queue.getState().results[0].preCondition?.error,
      "evaluator failed"
    );
  });

  test("runs finalStep once after queue drains", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
      finalStep: {
        prompt: "final-gate",
        harness: HARNESS_IDS.CODEX_CLI,
        model: "gpt-5.4-mini",
      },
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
    assert.strictEqual(
      queue.getWorkflowFile().finalStep?._runtime?.harness,
      HARNESS_IDS.CODEX_CLI
    );
    assert.strictEqual(
      queue.getWorkflowFile().finalStep?._runtime?.model,
      "gpt-5.4-mini"
    );
  });

  test("keeps disabled finalStep present but skips execution", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-disabled", enabled: false },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1"]);
    assert.strictEqual(
      queue.getWorkflowFile().finalStep?.enabled,
      false,
      "disabled finalStep should remain in the workflow"
    );
    const runtime = queue.getFinalStepRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.status, STEP_STATUS.SKIPPED);
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
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
      finalStep: { prompt: "final-loop", mcpServers: ["ctrlyoke"] },
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

  test("fully finalizes a finalStep before honoring pause", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-pause") {
        return {
          success: true,
          responseText: "ok",
          afterResponse: async () => {
            await requestQueuePause(queue);
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

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    const runtime = queue.getFinalStepRuntime();
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(runtime?.loopCount, 0);
    assert.strictEqual(runtime?.status, STEP_STATUS.COMPLETED);
    assert.ok(runtime?.completedAt);
  });

  test("finalizes output, stats, and queue position before pausing", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    let completedOutput: { response?: string; elapsed?: number } | undefined;
    const statusUpdates: Array<{ state: string; duration?: number }> = [];
    const dashboardProvider = new Proxy(
      {
        updateStepStatus: (
          _stepIndex: number,
          status: { state: string; duration?: number }
        ) => statusUpdates.push(status),
      },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (() => undefined),
      }
    );

    integration.onSend = async (prompt) => ({
      success: true,
      responseText: `done:${prompt.prompt}`,
      afterResponse: async () => requestQueuePause(queue),
    });
    queue.loadPrompts({
      steps: [{ prompt: "pause-after-me" }, { prompt: "not-yet" }],
    });

    await executor.execute(integration, {
      ...makeContext(integration),
      captureCompletedOutput: (_stepIndex, output) => {
        completedOutput = output;
      },
      dashboardProvider: dashboardProvider as any,
    });

    const state = queue.getState();
    assert.strictEqual(state.status, EXECUTION_STATES.PAUSED);
    assert.strictEqual(state.currentIndex, 1);
    assert.strictEqual(state.results[0]?.status, STEP_STATUS.COMPLETED);
    assert.ok(state.steps[0]?._runtime?.completedAt);
    assert.deepStrictEqual(integration.sentPrompts, ["pause-after-me"]);
    assert.strictEqual(completedOutput?.response, "done:pause-after-me");
    assert.strictEqual(typeof completedOutput?.elapsed, "number");
    assert.ok(
      statusUpdates.some((status) => status.state === STEP_STATUS.COMPLETED)
    );
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

  test("persists user-stopped output without an error message and emits a warning status", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const captureCalls: Array<{ stepIndex: number; output: any }> = [];
    const statusCalls: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];

    integration.lastFailureOutput = "partial response before stop";
    integration.onSend = async () => {
      (integration as any).lastFailureReason = "Stopped by user";
      await requestQueueStop(queue);
      return { success: false };
    };

    const context = makeContext(integration);
    context.captureCompletedOutput = (stepIndex, output) => {
      captureCalls.push({ stepIndex, output });
    };
    context.onStatusMessage = (stepIndex, message, severity) => {
      statusCalls.push({ stepIndex, message, severity });
    };

    queue.loadPrompts({
      steps: [{ prompt: "stop-me" }, { prompt: "after-stop" }],
    });

    await executor.execute(integration, context);

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.STOPPED);
    assert.strictEqual(captureCalls.length, 1);
    assert.strictEqual(captureCalls[0].stepIndex, 0);
    assert.strictEqual(
      captureCalls[0].output.response,
      "partial response before stop"
    );
    assert.strictEqual(captureCalls[0].output.errorMessage, undefined);

    assert.deepStrictEqual(statusCalls, [
      {
        stepIndex: 0,
        message: "Stopped by user",
        severity: "warning",
      },
    ]);
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

  test("forwards runIndex on queue streaming events", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const streamingUpdates: Array<{
      stepIndex: number;
      attemptIndex?: number;
      runIndex?: number;
    }> = [];

    integration.onSend = async () => {
      (integration as any).streamingEventsEmitter.fire([
        {
          type: "text",
          data: { text: "streaming body" },
        },
      ]);
      return { success: true, responseText: "done" };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-rerun" }],
    });

    const context = makeContext(integration);
    context.targetRunIndices = new Map([["queue:0", 2]]);
    context.dashboardProvider = {
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateProgress: () => {},
      updateCliStreamingChunk: () => {},
      updateCliOutput: () => {},
      updateExecutionCompleted: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
      updateCliStreamingEvents: (
        stepIndex: number,
        _events: CliEvent[],
        attemptIndex?: number,
        runIndex?: number
      ) => {
        streamingUpdates.push({ stepIndex, attemptIndex, runIndex });
      },
    } as any;

    await executor.execute(integration, context);

    assert.deepStrictEqual(streamingUpdates, [
      { stepIndex: 0, attemptIndex: 0, runIndex: 2 },
    ]);
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
      _cliCommandWasInjected,
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

  test("fails the step on process exit by default and persists warning plus PTY tail", async () => {
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
      startStreamingExecutionOutput: async () => {
        historyCallOrder.push("start");
      },
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
    assert.strictEqual(finalState.status, EXECUTION_STATES.ERROR);
    assert.strictEqual(finalState.currentIndex, 1);
    assert.strictEqual(finalState.results[0].status, STEP_STATUS.FAILED);
    assert.strictEqual(finalState.results[1].status, STEP_STATUS.PENDING);

    assert.strictEqual(statusCalls.length, 1);
    assert.strictEqual(statusCalls[0].stepIndex, 0);
    assert.strictEqual(statusCalls[0].severity, "error");
    assert.match(statusCalls[0].message, /Stopping workflow/);

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
      "error"
    );
    assert.match(
      appendedStatusMessages[0].statusMessage.message,
      /Stopping workflow/
    );
    assert.deepStrictEqual(historyCallOrder, ["start", "status", "output"]);
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

  test("continues to the next step when errorBehavior.onError is continue", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    integration.harnessErrorFailure = true;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "first-step") {
        (integration as any).lastFailureReason = "Claude StopFailure";
        return { success: false };
      }
      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    queue.loadPrompts({
      steps: [
        {
          prompt: "first-step",
          errorBehavior: { onError: "continue" },
        },
        { prompt: "second-step" },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "first-step",
      "second-step",
    ]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.FAILED);
    assert.strictEqual(
      queue.getState().results[1].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("routes errored script steps through errorBehavior", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [
        {
          type: "script",
          script: `node -e "setTimeout(() => {}, 1000)"`,
          timeout: 0.01,
          errorBehavior: { onError: "continue" },
        },
        { prompt: "after-script-error" },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["after-script-error"]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("retries the same step when errorBehavior.onError is retry", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    let firstStepAttempts = 0;

    integration.processExitFailure = true;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "retry-step") {
        firstStepAttempts++;
        if (firstStepAttempts === 1) {
          (integration as any).lastFailureReason =
            "CLI process exited unexpectedly (exit code 1)";
          return { success: false };
        }
        integration.processExitFailure = false;
      }
      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-exec-"));
    const marker = path.join(tempDir, "gate-marker.txt");
    const markerCommand = marker.replace(/\\/g, "/");

    queue.loadPrompts({
      steps: [
        {
          prompt: "retry-step",
          preCondition: {
            script: `node -e "require('fs').appendFileSync('${markerCommand}', 'x')"`,
          },
          errorBehavior: { onError: "retry", maxRetries: 1, retryDelayMs: 0 },
        },
        { prompt: "after-retry" },
      ],
    });

    try {
      await executor.execute(integration, makeContext(integration));
    } finally {
      const markerText = await fs.readFile(marker, "utf8");
      assert.strictEqual(
        markerText,
        "xx",
        "a whole-step retry must re-run the pre-condition"
      );
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    assert.deepStrictEqual(integration.sentPrompts, [
      "retry-step",
      "retry-step",
      "after-retry",
    ]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
    assert.strictEqual(
      queue.getState().results[1].status,
      STEP_STATUS.COMPLETED
    );
  });
});
