import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkflowInstance } from "../../flightpath/WorkflowInstance";
import {
  HarnessIntegration,
  HarnessStatus,
} from "../../flightpath/HarnessIntegration";
import { IntegrationFactory } from "../../flightpath/IntegrationFactory";
import { TimelineRecorder } from "../../flightpath/orchestration/TimelineRecorder";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import {
  EXECUTION_STATES,
  FINAL_PROMPT_PHASES,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import { Harness, PromptItem } from "../../types/FlightPathTypes";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";

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

class MockHarnessIntegration extends HarnessIntegration {
  async initialize(): Promise<void> {}

  async sendPrompt(
    _prompt: PromptItem,
    _needsCompletionDetection?: boolean
  ): Promise<boolean> {
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

class MockIntegrationFactory extends IntegrationFactory {
  constructor(platform: PlatformAdapter) {
    super(platform);
  }

  override createForExecution(_harness: Harness): HarnessIntegration {
    return new MockHarnessIntegration(undefined, false);
  }
}

async function startQueueExecution(instance: WorkflowInstance): Promise<void> {
  const queue = instance.promptQueue;
  if (queue.getState().prompts.length === 0) {
    return;
  }

  if (queue.getRuntimeStateMachine().startExecution()) {
    await queue.commitRuntimeTransition({ persist: false });
  }
}

async function markQueueCompleted(instance: WorkflowInstance): Promise<void> {
  const queue = instance.promptQueue;
  queue.getRuntimeStateMachine().complete();
  await queue.commitRuntimeTransition({ persist: false });
}

suite("WorkflowInstance finalPrompt replay", () => {
  test("replays finalPrompt completed output, in-flight buffer, and status messages on workflow switch", async () => {
    const platform = new MockPlatform();

    const sessionRestoredCalls: any[] = [];
    const finalPromptOutputCalls: Array<{ loopIndex: number; output: any }> =
      [];
    const statusMessageCalls: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async (...args: any[]) => {
        sessionRestoredCalls.push(args);
      },
      updateExecutionStarted: () => {},
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: () => {},
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: (loopIndex: number, output: any) => {
        finalPromptOutputCalls.push({ loopIndex, output });
      },
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: (
        stepIndex: number,
        message: string,
        severity: string
      ) => {
        statusMessageCalls.push({ stepIndex, message, severity });
      },
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.promptQueue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-loop" },
    });

    await startQueueExecution(instance);
    await instance.promptQueue.setFinalPromptRuntime({
      phase: FINAL_PROMPT_PHASES.FINAL_PROMPT,
      loopCount: 0,
      status: STEP_STATUS.RUNNING,
      startedAt: Date.now(),
    });

    (instance as any).outputCaptureBuffer.finalPromptCompletedOutputs.set(0, {
      outputs: [
        {
          prompt: "final-loop",
          response: "completed-final-output",
          elapsed: 1.2,
          isStreaming: false,
          attemptIndex: 0,
        },
      ],
    });

    (instance as any).outputCaptureBuffer.finalPromptOutputBuffer.set(0, {
      prompt: "final-loop",
      cliCommand: "mock final cmd",
      workingDirectory: process.cwd(),
      timestampMs: Date.now(),
      attemptIndex: 0,
      accumulatedText: "streaming-final-output",
      accumulatedEvents: [
        {
          type: "text",
          timestamp: new Date().toISOString(),
          data: { text: "streamed event" },
        },
      ],
      rawTextOutput: true,
    });

    (instance as any).outputCaptureBuffer.finalPromptStatusMessages.set(0, [
      {
        message: "final prompt validating",
        severity: "info",
        timestamp: Date.now(),
      },
    ]);

    instance.sendFullStateToDashboard();

    assert.strictEqual(sessionRestoredCalls.length, 1);
    assert.strictEqual(
      sessionRestoredCalls[0][3],
      EXECUTION_STATES.RUNNING,
      "session restore should reflect running state"
    );

    assert.strictEqual(finalPromptOutputCalls.length, 2);
    assert.ok(
      finalPromptOutputCalls.some(
        (c) =>
          c.loopIndex === 0 &&
          c.output.response === "completed-final-output" &&
          c.output.isStreaming === false
      )
    );
    assert.ok(
      finalPromptOutputCalls.some(
        (c) =>
          c.loopIndex === 0 &&
          c.output.response === "streaming-final-output" &&
          c.output.isStreaming === true
      )
    );

    assert.deepStrictEqual(statusMessageCalls, [
      {
        stepIndex: -1,
        message: "final prompt validating",
        severity: "info",
      },
    ]);
  });
});

suite("WorkflowInstance runtime transitions", () => {
  test("drives execution-state updates and cancelled-step status from runtime transitions", async () => {
    const platform = new MockPlatform();

    const executionStates: string[] = [];
    const stepStatuses: Array<{ stepIndex: number; state: string }> = [];

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: (state: string) => {
        executionStates.push(state);
      },
      updateStepStatus: (stepIndex: number, details: { state: string }) => {
        stepStatuses.push({ stepIndex, state: details.state });
      },
      updateRetryAttempt: () => {},
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: () => {},
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: () => {},
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.setActive(true);
    instance.promptQueue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
    });

    const runtime = instance.promptQueue.getRuntimeStateMachine();
    assert.strictEqual(runtime.startExecution(), true);
    await instance.promptQueue.commitRuntimeTransition({ persist: false });

    await instance.promptQueue.markCurrentAsSent();
    runtime.beginAttempt({ kind: FINAL_PROMPT_PHASES.QUEUE, stepIndex: 0 }, 0);
    instance.promptQueue.markInFlightPromptCancelled();
    assert.strictEqual(runtime.requestStop(), true);
    await instance.promptQueue.commitRuntimeTransition({ persist: false });

    assert.deepStrictEqual(executionStates, [
      EXECUTION_STATES.RUNNING,
      EXECUTION_STATES.CANCELLING,
    ]);
    assert.deepStrictEqual(stepStatuses, [
      { stepIndex: 0, state: STEP_STATUS.CANCELLED },
    ]);
  });

  test("uses runtime-owned execution state when queue growth piggybacks prompt updates", async () => {
    const platform = new MockPlatform();

    const promptsExtendedCalls: Array<{
      promptCount: number;
      executionState: string | undefined;
    }> = [];
    const executionStates: string[] = [];

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: (state: string) => {
        executionStates.push(state);
      },
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: (
        prompts: PromptItem[],
        _finalPrompt: PromptItem | null,
        executionState?: string
      ) => {
        promptsExtendedCalls.push({
          promptCount: prompts.length,
          executionState,
        });
      },
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: () => {},
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: () => {},
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
      updateWorkflowName: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.setActive(true);
    instance.promptQueue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
    });

    const runtime = instance.promptQueue.getRuntimeStateMachine();
    assert.strictEqual(runtime.startExecution(), true);
    await instance.promptQueue.commitRuntimeTransition({ persist: false });

    (instance as any).lastKnownPromptCount = 1;

    (instance as any).onQueueStateChanged({
      ...instance.promptQueue.getState(),
      status: EXECUTION_STATES.IDLE,
      prompts: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
    });

    assert.deepStrictEqual(executionStates, [EXECUTION_STATES.RUNNING]);
    assert.ok(
      promptsExtendedCalls.some(
        (call) =>
          call.promptCount === 2 &&
          call.executionState === EXECUTION_STATES.RUNNING
      )
    );
  });

  test("emits completion notifications from runtime transitions", async () => {
    const platform = new MockPlatform();

    const executionStates: string[] = [];
    let completionNotifications = 0;

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: (state: string) => {
        executionStates.push(state);
      },
      updateExecutionCompleted: () => {
        completionNotifications++;
      },
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: () => {},
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: () => {},
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
      updateWorkflowName: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.setActive(true);
    instance.promptQueue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
    });

    const runtime = instance.promptQueue.getRuntimeStateMachine();
    assert.strictEqual(runtime.startExecution(), true);
    await instance.promptQueue.commitRuntimeTransition({ persist: false });

    assert.strictEqual(runtime.complete(), true);
    await instance.promptQueue.commitRuntimeTransition({ persist: false });

    assert.deepStrictEqual(executionStates, [
      EXECUTION_STATES.RUNNING,
      EXECUTION_STATES.COMPLETED,
    ]);
    assert.strictEqual(completionNotifications, 1);
  });

  test("persists authoritative runtime transitions through OutputHistoryManager when a run history is active", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "fp-instance-runtime-")
    );

    try {
      const platform = new MockPlatform();
      const instance = new WorkflowInstance(
        platform,
        undefined,
        new MockIntegrationFactory(platform),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );

      instance.promptQueue.loadPrompts({
        prompts: [{ prompt: "queue-1" }],
      });

      const historyInit = await instance.outputHistoryManager.initializeRun(
        "wf-runtime-instance"
      );
      const appendCalls: Array<{ historyFilePath: string; command: string }> =
        [];
      const originalAppendRuntimeTransition =
        instance.outputHistoryManager.appendRuntimeTransition.bind(
          instance.outputHistoryManager
        );

      (instance.outputHistoryManager as any).appendRuntimeTransition = async (
        historyFilePath: string,
        transition: { command: string }
      ) => {
        appendCalls.push({ historyFilePath, command: transition.command });
        return originalAppendRuntimeTransition(
          historyFilePath,
          transition as any
        );
      };

      (instance as any).activeHistoryFilePath = historyInit.filePath;

      const runtimeTransitions: Array<{ timestampMs: number }> = [];
      const runtime = instance.promptQueue.getRuntimeStateMachine();
      runtime.onDidTransition((transition) => {
        runtimeTransitions.push({ timestampMs: transition.timestampMs });
      });

      assert.strictEqual(runtime.startExecution(), true);
      await instance.promptQueue.commitRuntimeTransition({ persist: false });

      assert.strictEqual(runtime.pause(), true);
      await instance.promptQueue.commitRuntimeTransition({ persist: false });
      await (instance as any).pendingRuntimeTransitionHistoryWrite;

      const recorder = new TimelineRecorder();
      const events = await recorder.readEvents(historyInit.filePath);

      assert.deepStrictEqual(appendCalls, [
        {
          historyFilePath: historyInit.filePath,
          command: "startExecution",
        },
        {
          historyFilePath: historyInit.filePath,
          command: "pause",
        },
      ]);
      assert.deepStrictEqual(
        events.map((event) => event.eventType),
        [
          TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
          TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
        ]
      );
      assert.deepStrictEqual(
        events.map((event) => event.timestampMs),
        runtimeTransitions.map((transition) => transition.timestampMs)
      );
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("updates retry badges from attempt transitions and clears them after retry completion", () => {
    const platform = new MockPlatform();

    const retryUpdates: Array<{
      stepIndex: number;
      currentRetry: number;
      maxRetries: number;
    }> = [];
    const stepStatuses: Array<{ stepIndex: number; state: string }> = [];

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: () => {},
      updateStepStatus: (stepIndex: number, details: { state: string }) => {
        stepStatuses.push({ stepIndex, state: details.state });
      },
      updateRetryAttempt: (
        stepIndex: number,
        currentRetry: number,
        maxRetries: number
      ) => {
        retryUpdates.push({ stepIndex, currentRetry, maxRetries });
      },
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: () => {},
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: () => {},
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.setActive(true);
    instance.promptQueue.loadPrompts({
      prompts: [{ prompt: "queue-1" }],
    });

    const runtime = instance.promptQueue.getRuntimeStateMachine();
    const target = { kind: FINAL_PROMPT_PHASES.QUEUE, stepIndex: 0 };

    runtime.scheduleRetry(target, 1, 1, 2);
    runtime.beginAttempt(target, 1);
    runtime.completeAttempt(target, 1);

    assert.deepStrictEqual(retryUpdates, [
      { stepIndex: 0, currentRetry: 1, maxRetries: 2 },
      { stepIndex: 0, currentRetry: 0, maxRetries: 0 },
    ]);
    assert.deepStrictEqual(stepStatuses, [
      { stepIndex: 0, state: STEP_STATUS.RUNNING },
    ]);
  });
});

suite("WorkflowInstance eager working file creation", () => {
  test("deduplicates concurrent ensureEphemeralWorkingFile calls", async () => {
    const platform = new MockPlatform();

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: () => {},
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: () => {},
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: () => {},
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    let createCallCount = 0;
    let resolveCreate!: (value: string) => void;
    const createPromise = new Promise<string>((resolve) => {
      resolveCreate = resolve;
    });

    (instance.promptQueue as any).getState = () => ({
      workingFilePath: undefined,
      workflowName: undefined,
    });
    (instance.promptQueue as any).createWorkingFile = async () => {
      createCallCount += 1;
      return createPromise;
    };
    (instance.promptQueue as any).updateWorkingFileProperties = async () =>
      null;

    const firstEnsure = instance.ensureEphemeralWorkingFile({
      initialProperties: { harness: Harness.ClaudeCli },
    });
    const secondEnsure = instance.ensureEphemeralWorkingFile({
      initialProperties: { model: "sonnet" },
    });

    resolveCreate("mock-working-file.flightpath.json");
    await Promise.all([firstEnsure, secondEnsure]);

    assert.strictEqual(createCallCount, 1);
  });
});

suite("WorkflowInstance append-and-continue", () => {
  test("syncs currentPromptFile before rerunning a completed ephemeral workflow", async () => {
    const platform = new MockPlatform();

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: () => {},
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: () => {},
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: () => {},
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.promptQueue.loadPrompts({
      prompts: [{ prompt: "first prompt" }],
    });
    await markQueueCompleted(instance);
    (instance.promptQueue as any).state.results[0].status =
      STEP_STATUS.COMPLETED;

    instance.setCurrentPromptFile("ephemeral.prompt.md", {
      prompts: [{ prompt: "first prompt" }],
    });

    let promptCountSeenByRun = 0;
    (instance as any).executeLoadedPromptFile = async () => {
      promptCountSeenByRun =
        (instance as any).currentPromptFile?.promptFile.prompts?.length ?? 0;
    };

    await instance.executeEphemeralPrompt("follow-up prompt", {}, "run");

    assert.strictEqual(promptCountSeenByRun, 2);
    assert.strictEqual(
      (instance as any).currentPromptFile?.promptFile.prompts?.length,
      2
    );
  });

  test("treats completed queue with appended pending prompt as continuation", async () => {
    const platform = new MockPlatform();

    let executionStartedArgs: any[] | undefined;
    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: (...args: any[]) => {
        executionStartedArgs = args;
      },
      notifyRunHistoryUpdated: () => {},
      updateProgress: () => {},
      updateExecutionState: () => {},
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateCliOutput: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updatePromptsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalPrompt: () => {},
      updateFinalPromptStatus: () => {},
      updateFinalPromptOutput: () => {},
      updateFinalPromptStreamingChunk: () => {},
      updateFinalPromptStreamingEvents: () => {},
      updateStatusMessage: () => {},
      notifyWorkflowStateReset: () => {},
      notifyStartPositionSet: () => {},
      notifyPromptsReordered: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.promptQueue.loadPrompts({
      prompts: [{ prompt: "completed prompt" }, { prompt: "appended prompt" }],
    });
    await markQueueCompleted(instance);
    (instance.promptQueue as any).state.results[0].status =
      STEP_STATUS.COMPLETED;
    (instance.promptQueue as any).state.results[1].status = STEP_STATUS.PENDING;

    instance.setCurrentPromptFile("workflow.prompt.md", {
      prompts: [{ prompt: "completed prompt" }, { prompt: "appended prompt" }],
    });

    let restartCalled = false;
    (instance.promptQueue as any).restart = async () => {
      restartCalled = true;
    };
    (instance as any).startWorkflowExecution = async () => {};

    await (instance as any).executeLoadedPromptFile();

    assert.strictEqual(restartCalled, false);
    assert.strictEqual(typeof executionStartedArgs![0], "string"); // workflowId (UUID)
    assert.deepStrictEqual(executionStartedArgs!.slice(1), [
      "workflow.prompt.md",
      2,
      true,
      1,
    ]);
  });
});
