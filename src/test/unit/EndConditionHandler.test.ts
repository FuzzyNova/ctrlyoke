import * as assert from "assert";
import { suite, test } from "mocha";
import { EndConditionHandler } from "../../core/EndConditionHandler";
import {
  EndConditionEvaluator,
  type EvaluationResult,
} from "../../core/EndConditionEvaluator";
import { PromptQueue } from "../../core/PromptQueue";
import { WorkflowStateMachine } from "../../core/WorkflowStateMachine";
import {
  HarnessIntegration,
  HarnessStatus,
} from "../../core/HarnessIntegration";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { StatusMessageReporter } from "../../core/orchestration/StatusMessageReporter";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { IDashboardSink } from "../../types/IDashboardSink";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import {
  type PromptStep,
  type ScriptProperties,
  type EndConditionAction,
} from "../../types/CtrlYokeTypes";
import type { StatusMessage } from "../../types/WebviewMessageTypes";
import {
  WORKFLOW_ATTEMPT_STATUS,
  FINAL_STEP_PHASES,
  WORKFLOW_ATTEMPT_COMMANDS,
  HARNESS_IDS,
} from "../../types/DashboardConstants";
import type { StatusMessageSeverity } from "../../types/DashboardConstants";

class MockPlatform implements PlatformAdapter {
  getConfig<T>(_key: string, defaultValue: T): T {
    return defaultValue;
  }

  getWorkspaceRoot(): string {
    return process.cwd();
  }

  getWorkspaceRoots(): string[] {
    return [process.cwd()];
  }

  getNamedWorkspaceRoots() {
    return [{ name: "root", fsPath: process.cwd() }];
  }

  getExtensionPath(): string {
    return process.cwd();
  }
}

class MockHarnessIntegration extends HarnessIntegration {
  async initialize(): Promise<void> {}

  async sendPrompt(): Promise<boolean> {
    return true;
  }

  getStatus(): { available: boolean; message: string; strategy: string } {
    return { available: true, message: "ready", strategy: "mock" };
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

class TestEndConditionEvaluator extends EndConditionEvaluator {
  readonly varsSeen: Array<Record<string, string> | undefined> = [];

  constructor(
    platform: PlatformAdapter,
    private readonly retryResults: EvaluationResult[] = []
  ) {
    super(platform);
  }

  override async evaluateCondition(
    _condition: ScriptProperties,
    _workingDirectory?: string,
    vars?: Record<string, string>
  ): Promise<EvaluationResult> {
    this.varsSeen.push(vars);
    return this.retryResults.shift() ?? successResult();
  }
}

function successResult(stdout: string = "ok"): EvaluationResult {
  return {
    passed: true,
    actual: stdout,
    errored: false,
    result: stdout,
    stdout,
    stderr: "",
    duration: 1,
    exitCode: 0,
  };
}

function validationFailure(result: string = "bad"): EvaluationResult {
  return {
    passed: false,
    actual: result,
    errored: false,
    result,
    stdout: result,
    stderr: "",
    duration: 1,
    exitCode: 0,
  };
}

function evaluationError(error: string = "could not run"): EvaluationResult {
  return {
    passed: false,
    actual: "",
    errored: true,
    result: "",
    stdout: "partial stdout",
    stderr: "stderr",
    duration: 7,
    error,
  };
}

function createPrompt(
  maxRetries: number | undefined,
  onPass: EndConditionAction = "continue",
  options: {
    onFail?: EndConditionAction;
    retryPrompt?: string;
    passRetryPrompt?: string;
    resumeSessionOnRetry?: boolean;
  } = {}
): PromptStep {
  const endCondition = {
    script: "check-results.js",
    expected: "ok",
    retryPrompt: "Please fix the issues",
    maxRetries,
    onPass,
    ...options,
  };
  return {
    prompt: "run task",
    endCondition,
  };
}

class DashboardSinkDouble implements IDashboardSink {
  readonly statusMessages: Array<{
    stepIndex: number;
    message: string;
    severity: StatusMessageSeverity | undefined;
  }> = [];

  updateFileSelected(): Promise<void> {
    return Promise.resolve();
  }
  updateSessionRestored(
    ..._args: Parameters<IDashboardSink["updateSessionRestored"]>
  ): Promise<void> {
    return Promise.resolve();
  }
  updateExecutionStarted(): void {}
  updateProgress(): void {}
  updateExecutionState(): void {}
  updateStepStatus(): void {}
  updateRetryAttempt(): void {}
  updateCliOutput(): void {}
  updateCliStreamingChunk(): void {}
  updateCliStreamingEvents(): void {}
  updateContextWindow(): void {}
  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity
  ): void {
    this.statusMessages.push({ stepIndex, message, severity });
  }
  updateStepsExtended(): void {}
  updateStepColor(): void {}
  updatePromptDeleted(): void {}
  updateFinalStep(): void {}
  updateFinalStepStatus(): void {}
  updateFinalStepOutput(): void {}
  updateFinalStepStreamingChunk(): void {}
  updateFinalStepStreamingEvents(): void {}
  notifyPromptsReordered(): void {}
  notifyUndoRedoSynced(): void {}
  updateWorkflowName(): void {}
  sendStepUndoDataUpdated(
    _target: Parameters<IDashboardSink["sendStepUndoDataUpdated"]>[0],
    _snapshot?: Parameters<IDashboardSink["sendStepUndoDataUpdated"]>[1],
    _workflowId?: string
  ): void {}
  updateHarnessUsage(): void {}
  updateWorktreeMerge(): void {}
}

class HistoryManagerDouble extends OutputHistoryManager {
  readonly statusMessages: Array<{
    filePath: string;
    target: OutputExecutionTarget;
    statusMessage: StatusMessage;
  }> = [];

  constructor() {
    super(".");
  }

  override appendStatusMessage(
    filePath: string,
    target: OutputExecutionTarget,
    statusMessage: StatusMessage
  ): Promise<void> {
    this.statusMessages.push({ filePath, target, statusMessage });
    return Promise.resolve();
  }
}

function createReporter(
  dashboard?: IDashboardSink,
  history?: HistoryManagerDouble
): StatusMessageReporter {
  return new StatusMessageReporter(
    () => dashboard,
    () => (history ? { filePath: "history.json", manager: history } : undefined)
  );
}

suite("EndConditionHandler", () => {
  test("completes the current attempt through the runtime owner on initial success", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1, "continue");
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    const transitions: Array<{ command: string; attemptIndex: number }> = [];

    queue.loadPrompts({ steps: [prompt] });
    runtime.onDidAttemptTransition((transition) => {
      transitions.push({
        command: transition.command,
        attemptIndex: transition.current.attemptIndex,
      });
    });

    const result = await handler.handleEndConditionResult(
      prompt,
      successResult(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        throw new Error("retry callback should not be invoked");
      }
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(transitions, [
      { command: WORKFLOW_ATTEMPT_COMMANDS.COMPLETE, attemptIndex: 0 },
    ]);
    assert.deepStrictEqual(queue.getState().results[0].endCondition, {
      passed: true,
      script: "check-results.js",
      expected: "ok",
      actual: "ok",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
  });

  test("stops the workflow when the end condition passes with stopWorkflow", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1, "stopWorkflow");
    const integration = new MockHarnessIntegration(undefined, false);
    const handler = new EndConditionHandler(
      new TestEndConditionEvaluator(platform),
      queue,
      createReporter()
    );

    queue.loadPrompts({ steps: [prompt] });
    const result = await handler.handleEndConditionResult(
      prompt,
      successResult(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        throw new Error("retry callback should not be invoked");
      }
    );

    assert.strictEqual(result.shouldContinue, false);
    assert.strictEqual(
      result.failureReason,
      "End condition passed with onPass: stopWorkflow"
    );
  });

  test("schedules a retry and completes the retry attempt on retry success", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1);
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform, [
      successResult(),
    ]);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    const transitions: Array<{
      command: string;
      attemptIndex: number;
      status: string;
      retryCount?: number;
      maxRetries?: number;
    }> = [];
    const retryAttemptIndices: number[] = [];
    const retryEvaluations: Array<{
      attemptIndex: number;
      result: EvaluationResult;
    }> = [];

    queue.loadPrompts({ steps: [prompt] });
    runtime.onDidAttemptTransition((transition) => {
      transitions.push({
        command: transition.command,
        attemptIndex: transition.current.attemptIndex,
        status: transition.current.status,
        retryCount: transition.current.retryCount,
        maxRetries: transition.current.maxRetries,
      });
    });

    const result = await handler.handleEndConditionResult(
      prompt,
      validationFailure(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
        vars: { CHECK: "expected" },
        onEvaluation: async (evaluationResult, attemptIndex) => {
          retryEvaluations.push({ attemptIndex, result: evaluationResult });
        },
      },
      async (_retryPrompt, _currentIndex, attemptIndex) => {
        retryAttemptIndices.push(attemptIndex);
        return "fixed";
      }
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(retryAttemptIndices, [1]);
    assert.strictEqual(retryEvaluations.length, 1);
    assert.strictEqual(retryEvaluations[0].attemptIndex, 1);
    assert.strictEqual(retryEvaluations[0].result.stdout, "ok");
    assert.deepStrictEqual(evaluator.varsSeen, [{ CHECK: "expected" }]);
    assert.deepStrictEqual(transitions, [
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY,
        attemptIndex: 1,
        status: WORKFLOW_ATTEMPT_STATUS.RETRYING,
        retryCount: 1,
        maxRetries: 1,
      },
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.COMPLETE,
        attemptIndex: 1,
        status: WORKFLOW_ATTEMPT_STATUS.COMPLETED,
        retryCount: 1,
        maxRetries: 1,
      },
    ]);
  });

  test("fails the current attempt when retries are exhausted and the workflow stops", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(0);
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform);
    const dashboard = new DashboardSinkDouble();
    const history = new HistoryManagerDouble();
    const handler = new EndConditionHandler(
      evaluator,
      queue,
      createReporter(dashboard, history)
    );
    const transitions: Array<{ command: string; attemptIndex: number }> = [];

    queue.loadPrompts({ steps: [prompt] });
    runtime.onDidAttemptTransition((transition) => {
      transitions.push({
        command: transition.command,
        attemptIndex: transition.current.attemptIndex,
      });
    });

    const result = await handler.handleEndConditionResult(
      prompt,
      validationFailure("actual-result"),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        throw new Error("retry callback should not be invoked");
      }
    );

    assert.strictEqual(result.shouldContinue, false);
    assert.deepStrictEqual(transitions, [
      { command: WORKFLOW_ATTEMPT_COMMANDS.FAIL, attemptIndex: 0 },
    ]);
    assert.deepStrictEqual(dashboard.statusMessages, [
      {
        stepIndex: 0,
        message:
          "End condition validation failed.\n\nExpected: exit code == ok\nActual: actual-result\n\nScript output:\nactual-result",
        severity: "error",
      },
    ]);
    assert.deepStrictEqual(history.statusMessages, [
      {
        filePath: "history.json",
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        statusMessage: {
          message:
            "End condition validation failed.\n\nExpected: exit code == ok\nActual: actual-result\n\nScript output:\nactual-result",
          severity: "error",
          timestamp: history.statusMessages[0]?.statusMessage.timestamp,
        },
      },
    ]);
    assert.strictEqual(queue.getState().results[0].endCondition?.passed, false);
    assert.strictEqual(
      queue.getState().results[0].endCondition?.actual,
      "actual-result"
    );
    assert.strictEqual(queue.getState().results[0].endConditionResult, false);
  });

  test("failure message names the comparison that ran and the compared value, not stdout", async () => {
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    // Zero-config default: no `expected`, so the comparison is "exit code == 0".
    const prompt: PromptStep = {
      prompt: "run task",
      endCondition: { script: "check-results.js" },
    };
    const dashboard = new DashboardSinkDouble();
    const handler = new EndConditionHandler(
      new TestEndConditionEvaluator(new MockPlatform()),
      queue,
      createReporter(dashboard, new HistoryManagerDouble())
    );
    queue.loadPrompts({ steps: [prompt] });

    await handler.handleEndConditionResult(
      prompt,
      { ...validationFailure("3 tests failed"), actual: "1", exitCode: 1 },
      {
        integration: new MockHarnessIntegration(undefined, false),
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        throw new Error("retry callback should not be invoked");
      }
    );

    assert.strictEqual(
      dashboard.statusMessages[0]?.message,
      "End condition validation failed.\n\nExpected: exit code == 0\nActual: 1\n\nScript output:\n3 tests failed"
    );
  });

  test("records evaluator errors as the final end-condition evaluation", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(0);
    const integration = new MockHarnessIntegration(undefined, false);
    const handler = new EndConditionHandler(
      new TestEndConditionEvaluator(platform),
      queue,
      createReporter()
    );

    queue.loadPrompts({ steps: [prompt] });
    const result = await handler.handleEndConditionResult(
      prompt,
      evaluationError(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        throw new Error("retry callback should not be invoked");
      }
    );

    assert.strictEqual(result.errorResult?.error, "could not run");
    assert.deepStrictEqual(queue.getState().results[0].endCondition, {
      passed: false,
      script: "check-results.js",
      expected: "ok",
      actual: "",
      stdout: "partial stdout",
      stderr: "stderr",
      durationMs: 7,
      error: "could not run",
    });
  });

  test("leaves the final failed verdict after retry exhaustion", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1);
    const integration = new MockHarnessIntegration(undefined, false);
    const handler = new EndConditionHandler(
      new TestEndConditionEvaluator(platform, [validationFailure("final")]),
      queue,
      createReporter()
    );

    queue.loadPrompts({ steps: [prompt] });
    const result = await handler.handleEndConditionResult(
      prompt,
      validationFailure("initial"),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => "retry response"
    );

    assert.strictEqual(result.shouldContinue, false);
    assert.strictEqual(
      queue.getState().results[0].endCondition?.actual,
      "final"
    );
    assert.strictEqual(queue.getState().results[0].endCondition?.passed, false);
  });

  test("retries onFail without a retry prompt using its fallback and budget", async () => {
    for (const maxRetries of [undefined, 3]) {
      const platform = new MockPlatform();
      const runtime = new WorkflowStateMachine();
      const queue = new PromptQueue(runtime);
      const prompt = createPrompt(maxRetries, "continue", {
        onFail: "retry",
        retryPrompt: undefined,
      });
      const retryLimit = maxRetries ?? 1;
      const evaluator = new TestEndConditionEvaluator(
        platform,
        [
          ...Array.from({ length: retryLimit - 1 }, (_, index) =>
            validationFailure(`failure-${index + 1}`)
          ),
          successResult(),
        ]
      );
      const handler = new EndConditionHandler(evaluator, queue, createReporter());
      const retryPrompts: string[] = [];

      queue.loadPrompts({ steps: [prompt] });
      const result = await handler.handleEndConditionResult(
        prompt,
        validationFailure("initial failure"),
        {
          integration: new MockHarnessIntegration(undefined, false),
          totalSteps: 1,
          workspaceFolderPath: process.cwd(),
          currentPromptFilePath: "workflow.ctrlyoke.yaml",
          runtime,
          attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          attemptIndex: 0,
        },
        async (retryPromptStep) => {
          retryPrompts.push(retryPromptStep.prompt);
          return "retry response";
        }
      );

      assert.strictEqual(result.shouldContinue, true);
      assert.strictEqual(retryPrompts.length, retryLimit);
      assert.match(retryPrompts[0] ?? "", /Expected: exit code == ok/);
      assert.match(retryPrompts[0] ?? "", /Script output:\ninitial failure/);
    }
  });

  test("continues the workflow when onFail is continue after exhaustion", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(0, "continue", { onFail: "continue" });
    const integration = new MockHarnessIntegration(undefined, false);
    const handler = new EndConditionHandler(
      new TestEndConditionEvaluator(platform),
      queue,
      createReporter()
    );
    const transitions: string[] = [];

    queue.loadPrompts({ steps: [prompt] });
    runtime.onDidAttemptTransition((transition) => {
      transitions.push(transition.command);
    });

    const result = await handler.handleEndConditionResult(
      prompt,
      validationFailure(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        throw new Error("retry callback should not be invoked");
      }
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(transitions, [WORKFLOW_ATTEMPT_COMMANDS.COMPLETE]);
  });

  test("aborts retries when the runtime is stopped before queue state sync catches up", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1);
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform, [
      successResult("should-not-run"),
    ]);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    let retryCallbackCount = 0;

    queue.loadPrompts({ steps: [prompt] });
    assert.strictEqual(runtime.requestStop(), true);

    const result = await handler.handleEndConditionResult(
      prompt,
      validationFailure(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        retryCallbackCount++;
        return "fixed";
      }
    );

    assert.strictEqual(result.shouldContinue, false);
    assert.strictEqual(result.failureReason, "Workflow stopped by user");
    assert.strictEqual(retryCallbackCount, 0);
    assert.strictEqual(runtime.stopped, true);
  });

  test("re-runs while the condition passes, then advances when the pass budget is exhausted", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(2, "retry", {
      passRetryPrompt: "Run the task again",
    });
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform, [
      successResult("second"),
      successResult("third"),
    ]);
    const retryPrompts: string[] = [];
    const dashboard = new DashboardSinkDouble();
    const history = new HistoryManagerDouble();
    const handler = new EndConditionHandler(
      evaluator,
      queue,
      createReporter(dashboard, history)
    );
    const transitions: string[] = [];

    queue.loadPrompts({ steps: [prompt] });
    runtime.onDidAttemptTransition((transition) => {
      transitions.push(
        `${transition.command}:${transition.current.attemptIndex}`
      );
    });

    const result = await handler.handleEndConditionResult(
      prompt,
      successResult("first"),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async (retryPromptStep, _currentIndex, attemptIndex) => {
        retryPrompts.push(`${retryPromptStep.prompt}:${attemptIndex}`);
        return "response";
      }
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(retryPrompts, [
      "Run the task again:1",
      "Run the task again:2",
    ]);
    assert.deepStrictEqual(
      dashboard.statusMessages.map(({ message }) => message),
      [
        "Re-running Prompt 1 (Pass retry 1/2): Run the task again",
        "Re-running Prompt 1 (Pass retry 2/2): Run the task again",
      ]
    );
    assert.deepStrictEqual(
      history.statusMessages.map(({ target, statusMessage }) => ({
        target,
        message: statusMessage.message,
        severity: statusMessage.severity,
      })),
      [
        {
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          message: "Re-running Prompt 1 (Pass retry 1/2): Run the task again",
          severity: "warning",
        },
        {
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          message: "Re-running Prompt 1 (Pass retry 2/2): Run the task again",
          severity: "warning",
        },
      ]
    );
    assert.deepStrictEqual(transitions, [
      `${WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY}:1`,
      `${WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY}:2`,
      `${WORKFLOW_ATTEMPT_COMMANDS.COMPLETE}:2`,
    ]);
    assert.strictEqual(queue.getCurrentRetryCount(), 0);
  });

  test("pass retry followed by failure uses onFail: continue", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(2, "retry", {
      onFail: "continue",
      passRetryPrompt: "Strengthen the test",
    });
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform, [
      validationFailure("still green"),
    ]);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    const retryPrompts: string[] = [];

    queue.loadPrompts({ steps: [prompt] });
    const result = await handler.handleEndConditionResult(
      prompt,
      successResult("green"),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async (retryPromptStep) => {
        retryPrompts.push(retryPromptStep.prompt);
        return "response";
      }
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(retryPrompts, ["Strengthen the test"]);
    assert.strictEqual(queue.getCurrentRetryCount(), 0);
  });

  test("applies onFail: stopWorkflow after a pass retry fails", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1, "retry", {
      onFail: "stopWorkflow",
      retryPrompt: undefined,
      passRetryPrompt: "Run again",
    });
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform, [
      validationFailure("red"),
    ]);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());

    queue.loadPrompts({ steps: [prompt] });
    const result = await handler.handleEndConditionResult(
      prompt,
      successResult(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
        attemptIndex: 0,
      },
      async () => "response"
    );

    assert.strictEqual(result.shouldContinue, false);
    assert.match(
      result.failureReason ?? "",
      /End condition failed after 1 retries/
    );
    assert.strictEqual(queue.getCurrentRetryCount(), 0);
  });

  test("defaults pass retries to one when maxRetries is unset", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(undefined, "retry", {
      passRetryPrompt: "Again",
    });
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform, [
      successResult(),
    ]);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    const retryAttempts: number[] = [];
    const maxRetries: number[] = [];

    queue.loadPrompts({ steps: [prompt] });
    runtime.onDidAttemptTransition((transition) => {
      if (transition.command === WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY) {
        retryAttempts.push(transition.current.attemptIndex);
        maxRetries.push(transition.current.maxRetries ?? 0);
      }
    });

    const result = await handler.handleEndConditionResult(
      prompt,
      successResult(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
        attemptIndex: 0,
      },
      async () => "response"
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(retryAttempts, [1]);
    assert.deepStrictEqual(maxRetries, [1]);
  });

  test("honors a stop requested during a pass retry", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(2, "retry", { passRetryPrompt: "Again" });
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    let retryCallbackCount = 0;

    queue.loadPrompts({ steps: [prompt] });
    const result = await handler.handleEndConditionResult(
      prompt,
      successResult(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async () => {
        retryCallbackCount++;
        runtime.requestStop();
        return "response";
      }
    );

    assert.strictEqual(result.shouldContinue, false);
    assert.strictEqual(result.failureReason, "Workflow stopped during retry");
    assert.strictEqual(retryCallbackCount, 1);
  });

  test("shares one retry budget across alternating pass and failure evaluations", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(2, "retry", {
      onFail: "retry",
      passRetryPrompt: "Pass again",
      retryPrompt: "Fix failure",
    });
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform, [
      validationFailure("failure after pass retry"),
      successResult("passing again"),
    ]);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    const retryPrompts: string[] = [];

    queue.loadPrompts({ steps: [prompt] });
    const result = await handler.handleEndConditionResult(
      prompt,
      successResult("initial pass"),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async (retryPromptStep) => {
        retryPrompts.push(retryPromptStep.prompt);
        return "response";
      }
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(retryPrompts, ["Pass again", "Fix failure"]);
    assert.strictEqual(queue.getCurrentRetryCount(), 0);
  });

  test("returns raw pass-retry templates and falls back to the step prompt", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1, "retry", {
      passRetryPrompt: "pre=$preCondition:stdout;end=$endCondition:stderr",
    });
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new EndConditionEvaluator(platform);
    const handler = new EndConditionHandler(evaluator, queue, createReporter());
    let retryPromptText = "";

    queue.loadPrompts({ steps: [prompt] });
    await handler.handleEndConditionResult(
      prompt,
      {
        ...successResult("actual-value"),
        stderr: "stderr-value",
        exitCode: 7,
        result: "actual-value",
      },
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
        evaluateCondition: async () => ({
          evaluationResult: successResult("done"),
        }),
      },
      async (retryPromptStep) => {
        retryPromptText = retryPromptStep.prompt;
        return "response";
      }
    );

    assert.strictEqual(
      retryPromptText,
      "pre=$preCondition:stdout;end=$endCondition:stderr"
    );

    const fallbackPrompt = createPrompt(1, "retry", {
      passRetryPrompt: undefined,
    });
    fallbackPrompt.endCondition!.passRetryPrompt = undefined;
    const fallbackHandler = new EndConditionHandler(
      new TestEndConditionEvaluator(platform, [successResult()]),
      queue,
      createReporter()
    );
    let fallbackText = "";
    await fallbackHandler.handleEndConditionResult(
      fallbackPrompt,
      successResult(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.ctrlyoke.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async (retryPromptStep) => {
        fallbackText = retryPromptStep.prompt;
        return "response";
      }
    );
    assert.strictEqual(fallbackText, "run task");
  });
});
