import * as assert from "assert";
import { suite, test } from "mocha";
import { EndConditionHandler } from "../../flightpath/EndConditionHandler";
import {
  EndConditionEvaluator,
  type EvaluationResult,
} from "../../flightpath/EndConditionEvaluator";
import { PromptQueue } from "../../flightpath/PromptQueue";
import { WorkflowStateMachine } from "../../flightpath/WorkflowStateMachine";
import {
  HarnessIntegration,
  HarnessStatus,
} from "../../flightpath/HarnessIntegration";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import { Harness, type PromptStep } from "../../types/FlightPathTypes";
import {
  WORKFLOW_ATTEMPT_STATUS,
  FINAL_STEP_PHASES,
  WORKFLOW_ATTEMPT_COMMANDS,
} from "../../types/DashboardConstants";

class MockPlatform implements PlatformAdapter {
  constructor(private readonly choice?: string) {}

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
    return this.choice;
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

class TestEndConditionEvaluator extends EndConditionEvaluator {
  constructor(
    platform: PlatformAdapter,
    private readonly retryResults: EvaluationResult[] = []
  ) {
    super(platform);
  }

  override async evaluateCondition(): Promise<EvaluationResult> {
    return this.retryResults.shift() ?? successResult();
  }

  override buildRetryPrompt(
    retryPromptTemplate: string,
    _evaluationResult: EvaluationResult,
    _expectedResult: string
  ): string {
    return `${retryPromptTemplate} [retry]`;
  }
}

function successResult(stdout: string = "ok"): EvaluationResult {
  return {
    passed: true,
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
    result,
    stdout: result,
    stderr: "",
    duration: 1,
    exitCode: 0,
  };
}

function createPrompt(maxRetries: number): PromptStep {
  return {
    prompt: "run task",
    endCondition: {
      script: "check-results.js",
      returns: "ok",
      retryPrompt: "Please fix the issues",
      maxRetries,
    },
  };
}

suite("EndConditionHandler", () => {
  test("completes the current attempt through the runtime owner on initial success", async () => {
    const platform = new MockPlatform();
    const runtime = new WorkflowStateMachine();
    const queue = new PromptQueue(runtime);
    const prompt = createPrompt(1);
    const integration = new MockHarnessIntegration(undefined, false);
    const evaluator = new TestEndConditionEvaluator(platform);
    const handler = new EndConditionHandler(
      evaluator,
      queue,
      () => undefined,
      platform
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
      successResult(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.flightpath.yaml",
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
    const handler = new EndConditionHandler(
      evaluator,
      queue,
      () => undefined,
      platform
    );
    const transitions: Array<{
      command: string;
      attemptIndex: number;
      status: string;
      retryCount?: number;
      maxRetries?: number;
    }> = [];
    const retryAttemptIndices: number[] = [];

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
        currentPromptFilePath: "workflow.flightpath.yaml",
        runtime,
        attemptTarget: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
      },
      async (_retryPrompt, _currentIndex, attemptIndex) => {
        retryAttemptIndices.push(attemptIndex);
        return "fixed";
      }
    );

    assert.strictEqual(result.shouldContinue, true);
    assert.deepStrictEqual(retryAttemptIndices, [1]);
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
    const handler = new EndConditionHandler(
      evaluator,
      queue,
      () => undefined,
      platform
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
      validationFailure(),
      {
        integration,
        totalSteps: 1,
        workspaceFolderPath: process.cwd(),
        currentPromptFilePath: "workflow.flightpath.yaml",
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
    const handler = new EndConditionHandler(
      evaluator,
      queue,
      () => undefined,
      platform
    );
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
        currentPromptFilePath: "workflow.flightpath.yaml",
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
});
