import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import {
  HarnessIntegration,
  HarnessStatus,
} from "../../core/HarnessIntegration";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
  HARNESS_IDS,
  type HarnessId,
} from "../../types/DashboardConstants";
import { PromptStep } from "../../types/CtrlYokeTypes";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";

/** Test-only shim mirroring OutputHistoryManager.test.ts's initTestRun helper. */
async function initTestRun(
  manager: OutputHistoryManager,
  workspaceRoot: string,
  nameHint: string
): Promise<{ filePath: string; runCount: number }> {
  const workflowKey = await WorkflowPaths.allocateWorkflowKey(
    workspaceRoot,
    nameHint
  );
  const runRef = WorkflowPaths.formatRunRef(Date.now());
  const runDir = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
  return manager.initializeRunAt(workflowKey, runRef, runDir, 1, Date.now());
}

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
    _prompt: PromptStep,
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

class MockIntegrationFactory extends IntegrationFactory {
  constructor(platform: PlatformAdapter) {
    super(platform);
  }

  override createForExecution(_harness: HarnessId): HarnessIntegration {
    return new MockHarnessIntegration(undefined, false);
  }
}

async function startQueueExecution(instance: WorkflowInstance): Promise<void> {
  const queue = instance.promptQueue;
  if (queue.getState().steps.length === 0) {
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

suite("WorkflowInstance finalStep replay", () => {
  test("replays finalStep completed output, in-flight buffer, and status messages on workflow switch", async () => {
    const platform = new MockPlatform();

    const sessionRestoredCalls: any[] = [];
    const finalStepOutputCalls: Array<{ loopIndex: number; output: any }> = [];
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
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: (loopIndex: number, output: any) => {
        finalStepOutputCalls.push({ loopIndex, output });
      },
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-loop" },
    });

    await startQueueExecution(instance);
    await instance.promptQueue.setFinalStepRuntime({
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      loopCount: 0,
      status: STEP_STATUS.RUNNING,
      startedAt: Date.now(),
    });

    (instance as any).outputCaptureBuffer.finalStepCompletedOutputs.set(0, {
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

    (instance as any).outputCaptureBuffer.finalStepOutputBuffer.set(0, {
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

    (instance as any).outputCaptureBuffer.finalStepStatusMessages.set(0, [
      {
        message: "final step validating",
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

    assert.strictEqual(finalStepOutputCalls.length, 2);
    assert.ok(
      finalStepOutputCalls.some(
        (c) =>
          c.loopIndex === 0 &&
          c.output.response === "completed-final-output" &&
          c.output.isStreaming === false
      )
    );
    assert.ok(
      finalStepOutputCalls.some(
        (c) =>
          c.loopIndex === 0 &&
          c.output.response === "streaming-final-output" &&
          c.output.isStreaming === true
      )
    );

    assert.deepStrictEqual(statusMessageCalls, [
      {
        stepIndex: -1,
        message: "final step validating",
        severity: "info",
      },
    ]);
  });
});

suite("WorkflowInstance session activity forwarding", () => {
  test("forwards SessionActivityWatcher events as soon as the integration is created, not only after the run finalizes", () => {
    const platform = new MockPlatform();
    const streamingEventsCalls: Array<{
      stepIndex: number;
      events: unknown[];
      attemptIndex: number;
      runIndex: number;
    }> = [];

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
      updateCliStreamingEvents: (
        stepIndex: number,
        events: unknown[],
        attemptIndex: number,
        runIndex: number
      ) => {
        streamingEventsCalls.push({
          stepIndex,
          events,
          attemptIndex,
          runIndex,
        });
      },
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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

    // Simulate a step that already completed mid-run (this is how
    // WorkflowInstance normally records where resumed activity attributes to).
    (instance as any).lastCompletedActivityTarget = {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
    };

    // createIntegrationForMode() is what every step dispatch uses to obtain its
    // integration — this must wire onSessionActivityResumed immediately so
    // activity captured by SessionActivityWatcher between step completions (long
    // before this run's startWorkflowExecution() finally block runs) isn't lost.
    const integration = (instance as any).createIntegrationForMode(
      HARNESS_IDS.COPILOT_CLI
    ) as HarnessIntegration;

    (integration as any).sessionActivityResumedEmitter.fire({
      events: [
        { type: "userSteer", timestamp: Date.now(), data: { text: "hello" } },
      ],
    });

    assert.strictEqual(streamingEventsCalls.length, 1);
    assert.strictEqual(streamingEventsCalls[0].stepIndex, 0);
    assert.strictEqual(streamingEventsCalls[0].events.length, 1);
  });

  test("merges follow-up activity into the persisted history entry with a one-time divider and refreshed tokens/elapsed", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "fp-session-activity-history-")
    );
    let instance: WorkflowInstance | undefined;

    try {
      const platform = new MockPlatform();
      instance = new WorkflowInstance(
        platform,
        undefined,
        new MockIntegrationFactory(platform),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );

      const historyInit = await initTestRun(
        instance.outputHistoryManager,
        tempWorkspace,
        "wf-session-activity"
      );
      (instance as any).activeHistoryFilePath = historyInit.filePath;

      const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
      const startedAt = Date.now() - 5000;
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target,
        [
          {
            prompt: "do the thing",
            response: "done",
            structured: {
              events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "done" } }],
              metadata: {},
            },
            elapsed: 5,
            tokens: { prompt: 10, completion: 5 },
            isStreaming: false,
            timestampMs: startedAt,
            attemptIndex: 0,
            runIndex: 0,
          } as any,
        ]
      );

      (instance as any).lastCompletedActivityTarget = {
        target,
        runIndex: 0,
        attemptIndex: 0,
      };

      await (instance as any).handleSessionActivityResumed([
        {
          type: CLI_EVENT_TYPES.USER_STEER,
          timestamp: Date.now(),
          data: { text: "one more thing" },
        },
        {
          type: CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC,
          timestamp: Date.now(),
          data: { used: 4000, size: 200000 },
        },
      ]);
      // Second follow-up batch — must not insert a second divider.
      await (instance as any).handleSessionActivityResumed([
        {
          type: CLI_EVENT_TYPES.USER_STEER,
          timestamp: Date.now(),
          data: { text: "and another" },
        },
      ]);

      const history = await instance.outputHistoryManager.loadHistory(
        historyInit.filePath
      );
      const entry = history.orderedEntries.find(
        (e: any) =>
          e.kind === OUTPUT_HISTORY_KINDS.CLI &&
          "target" in e &&
          e.target.kind === FINAL_STEP_PHASES.QUEUE &&
          e.target.stepIndex === 0
      ) as any;
      assert.ok(entry, "expected a persisted CLI history entry for step 0");

      const events = entry.cliOutput.structured?.events ?? [];
      assert.deepStrictEqual(
        events.map((e: any) => e.type),
        [
          CLI_EVENT_TYPES.TEXT,
          CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
          CLI_EVENT_TYPES.USER_STEER,
          CLI_EVENT_TYPES.USER_STEER,
        ]
      );
      assert.deepStrictEqual(entry.cliOutput.tokens, {
        prompt: 10,
        completion: 5,
        contextWindowUsed: 4000,
        contextWindowSize: 200000,
      });
      assert.ok(
        entry.cliOutput.elapsed >= 5,
        `expected elapsed to be refreshed to at least the original 5s, got ${entry.cliOutput.elapsed}`
      );
    } finally {
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("appends resumed assistant text only to the active queue output cache", async () => {
    const platform = new MockPlatform();
    const instance = new WorkflowInstance(
      platform,
      undefined,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.promptQueue.loadPrompts({ steps: [{ prompt: "queue-1" }] });
    instance.promptQueue.cacheRuntimeOutput(0, { responseText: "before." });
    (instance as any).lastCompletedActivityTarget = {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
    };

    // A backgrounded task auto-resuming produces genuine assistant TEXT events.
    await (instance as any).handleSessionActivityResumed([
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: " and after." },
      },
    ]);

    assert.strictEqual(
      (instance.promptQueue as any).runtimeOutputCache.get(0).responseText,
      "before. and after."
    );
    assert.deepStrictEqual(
      (instance.promptQueue as any).state.steps[0]._runtime,
      undefined
    );
  });

  test("appends resumed assistant text only to the active finalStep cache", async () => {
    const platform = new MockPlatform();
    const instance = new WorkflowInstance(
      platform,
      undefined,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    instance.promptQueue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-loop" },
    });
    await instance.promptQueue.setFinalStepRuntime({
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      loopCount: 0,
      status: STEP_STATUS.RUNNING,
      startedAt: Date.now(),
    });
    await instance.promptQueue.storeFinalStepResponseText(0, "loop-before.");
    (instance as any).lastCompletedActivityTarget = {
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
    };

    await (instance as any).handleSessionActivityResumed([
      {
        type: CLI_EVENT_TYPES.TEXT,
        timestamp: Date.now(),
        data: { text: " loop-after." },
      },
    ]);

    assert.strictEqual(
      (instance.promptQueue as any).finalStepResponseCache.get(0),
      "loop-before. loop-after."
    );
  });
});

suite("WorkflowInstance runtime transitions", () => {
  test("getSummary reports the workflow-level harness instead of a step override", async () => {
    const platform = new MockPlatform();
    const instance = new WorkflowInstance(
      platform,
      {
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
        updateStepsExtended: () => {},
        updatePromptDeleted: () => {},
        updateFinalStep: () => {},
        updateFinalStepStatus: () => {},
        updateFinalStepOutput: () => {},
        updateFinalStepStreamingChunk: () => {},
        updateFinalStepStreamingEvents: () => {},
        updateStatusMessage: () => {},
        notifyWorkflowStateReset: () => {},
        notifyStartPositionSet: () => {},
        notifyPromptsReordered: () => {},
      } as any,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );

    const promptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      steps: [
        { prompt: "step-1" },
        { prompt: "step-2", harness: HARNESS_IDS.CODEX_CLI },
      ],
    };

    instance.promptQueue.loadPrompts(promptFile);
    instance.setCurrentPromptFile(
      "/workspace/example.ctrlyoke.yaml",
      promptFile
    );
    (instance.promptQueue as any).state.currentIndex = 1;

    const summary = instance.getSummary();

    assert.strictEqual(summary.harness, HARNESS_IDS.CLAUDE_CLI);
  });

  test("loading a stale running working file restores it as stopped without starting execution", async () => {
    const platform = new MockPlatform();
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-stale-running-")
    );
    const workingFilePath = path.join(tempDir, "stale.ctrlyoke.json");

    try {
      await fs.writeFile(
        workingFilePath,
        JSON.stringify(
          {
            workflowName: "stale",
            startedAt: Date.now(),
            lastModifiedAt: Date.now(),
            steps: [{ prompt: "unfinished" }],
            _runtime: {
              currentIndex: 0,
              executionState: EXECUTION_STATES.RUNNING,
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const dashboardSink: any = {
        updateFileSelected: async () => {},
        updateSessionRestored: async () => {},
        updateExecutionStarted: () => {},
        notifyRunHistoryUpdated: () => {},
        updateProgress: () => {},
        updateExecutionState: () => {},
        updateWorkflowName: () => {},
        updateStepStatus: () => {},
        updateRetryAttempt: () => {},
        updateCliOutput: () => {},
        updateCliStreamingChunk: () => {},
        updateCliStreamingEvents: () => {},
        updateStepsExtended: () => {},
        updatePromptDeleted: () => {},
        updateFinalStep: () => {},
        updateFinalStepStatus: () => {},
        updateFinalStepOutput: () => {},
        updateFinalStepStreamingChunk: () => {},
        updateFinalStepStreamingEvents: () => {},
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
        tempDir
      );

      let autoStarted = false;
      (instance as any).startWorkflowExecution = async () => {
        autoStarted = true;
      };

      await instance.loadWorkingFile(workingFilePath);

      assert.strictEqual(autoStarted, false);
      assert.strictEqual(
        instance.getQueueState().status,
        EXECUTION_STATES.STOPPED
      );

      const persisted = JSON.parse(await fs.readFile(workingFilePath, "utf8"));
      assert.strictEqual(
        persisted._runtime.executionState,
        EXECUTION_STATES.STOPPED
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

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
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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
      steps: [{ prompt: "queue-1" }],
    });

    const runtime = instance.promptQueue.getRuntimeStateMachine();
    assert.strictEqual(runtime.startExecution(), true);
    await instance.promptQueue.commitRuntimeTransition({ persist: false });

    await instance.promptQueue.markCurrentAsSent();
    runtime.beginAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }, 0);
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
      updateStepsExtended: (
        prompts: PromptStep[],
        _finalStep: PromptStep | null,
        executionState?: string
      ) => {
        promptsExtendedCalls.push({
          promptCount: prompts.length,
          executionState,
        });
      },
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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

    instance.promptQueue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
    });

    const runtime = instance.promptQueue.getRuntimeStateMachine();
    assert.strictEqual(runtime.startExecution(), true);
    await instance.promptQueue.commitRuntimeTransition({ persist: false });

    (instance as any).lastKnownStepCount = 1;

    (instance as any).onQueueStateChanged({
      ...instance.promptQueue.getState(),
      status: EXECUTION_STATES.IDLE,
      steps: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
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
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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

    instance.promptQueue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
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
    let instance: WorkflowInstance | undefined;

    try {
      const platform = new MockPlatform();
      instance = new WorkflowInstance(
        platform,
        undefined,
        new MockIntegrationFactory(platform),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );

      instance.promptQueue.loadPrompts({
        steps: [{ prompt: "queue-1" }],
      });

      const historyInit = await initTestRun(
        instance.outputHistoryManager,
        tempWorkspace,
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
      // The runtime-transition writes above each kick off a fire-and-forget
      // search-index refresh (OutputHistoryManager.refreshSearchIndex). Await
      // it before deleting the workspace, or the background refresh can still
      // be writing into `.ctrlyoke/.search-index` mid-rmdir, causing an
      // intermittent ENOTEMPTY on Windows. Same pattern as
      // OutputHistoryManager.test.ts's teardown.
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
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
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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
      steps: [{ prompt: "queue-1" }],
    });

    const runtime = instance.promptQueue.getRuntimeStateMachine();
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 };

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
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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
      initialProperties: { harness: HARNESS_IDS.CLAUDE_CLI },
    });
    const secondEnsure = instance.ensureEphemeralWorkingFile({
      initialProperties: { model: "sonnet" },
    });

    resolveCreate("mock-working-file.ctrlyoke.json");
    await Promise.all([firstEnsure, secondEnsure]);

    assert.strictEqual(createCallCount, 1);
  });
});

suite("WorkflowInstance append-and-continue", () => {
  test("appendFromFile preserves the active workflow properties and appends only source steps", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "fp-append-props-")
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

      const baseSourcePath = path.join(
        tempWorkspace,
        "base-workflow.ctrlyoke.yaml"
      );
      const workingFilePath = await instance.promptQueue.createWorkingFile(
        "base-workflow.ctrlyoke.yaml",
        [{ prompt: "base prompt" }],
        tempWorkspace,
        baseSourcePath
      );

      const baseProperties = {
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "base-model",
        agent: "base-agent",
        skills: ["base-skill"],
        resumeSession: true,
        mcpServers: ["base-mcp"],
        sessionId: "base-session",
        additionalArgs: "--base-workflow",
        vars: { env: "base" },
        toolPermissions: {
          mode: "custom",
          allowedTools: ["base_read"],
          deniedTools: ["base_write"],
        },
        hooks: [{ event: "stop", command: "echo base" }],
        preCondition: {
          script: "base-pre.js",
          returns: "true",
          compareSource: "stdout",
          onPass: "continue",
          onFail: "skipPrompt",
        },
        endCondition: {
          script: "base-end.js",
          returns: "done",
          compareSource: "stdout",
          onPass: "continue",
          onFail: "retry",
          maxRetries: 1,
        },
        finalStep: { prompt: "base final" },
      };
      await instance.promptQueue.updateWorkingFileProperties(baseProperties);

      const baseWorkingFile =
        await instance.promptQueue.readWorkingFile(workingFilePath);
      instance.promptQueue.loadPrompts(baseWorkingFile, workingFilePath);
      instance.setCurrentPromptFile(baseSourcePath, baseWorkingFile);

      const appendPath = path.join(
        tempWorkspace,
        "append-workflow.ctrlyoke.yaml"
      );
      await fs.writeFile(
        appendPath,
        [
          "harness: codex-cli",
          "model: append-workflow-model",
          "agent: append-agent",
          "resumeSession: false",
          "mcpServers:",
          "  - append-mcp",
          'additionalArgs: "--append-workflow"',
          "vars:",
          "  env: append",
          "toolPermissions:",
          "  mode: custom",
          "  allowedTools:",
          "    - append_workflow_read",
          "  deniedTools:",
          "    - append_workflow_write",
          "preCondition:",
          "  script: append-pre.js",
          '  returns: "true"',
          "  compareSource: stdout",
          "  onPass: continue",
          "  onFail: skipPrompt",
          "endCondition:",
          "  script: append-end.js",
          "  returns: done",
          "  compareSource: stdout",
          "  onPass: continue",
          "  onFail: retry",
          "  maxRetries: 3",
          "finalStep:",
          "  prompt: append final",
          "steps:",
          "  - name: appended step",
          "    prompt: appended prompt",
          "    harness: antigravity-cli",
          "    model: append-step-model",
          '    additionalArgs: "--append-step"',
          "    toolPermissions:",
          "      mode: custom",
          "      allowedTools:",
          "        - append_step_read",
          "      deniedTools:",
          "        - append_step_write",
          "",
        ].join("\n")
      );

      await instance.appendFromFile(appendPath);

      const assertBaseWorkflowProperties = (workflow: any) => {
        assert.strictEqual(workflow.harness, HARNESS_IDS.CLAUDE_CLI);
        assert.strictEqual(workflow.model, "base-model");
        assert.strictEqual(workflow.agent, "base-agent");
        assert.deepStrictEqual(workflow.skills, ["base-skill"]);
        assert.strictEqual(workflow.resumeSession, true);
        assert.deepStrictEqual(workflow.mcpServers, ["base-mcp"]);
        assert.strictEqual(workflow.sessionId, "base-session");
        assert.strictEqual(workflow.additionalArgs, "--base-workflow");
        assert.deepStrictEqual(workflow.vars, { env: "base" });
        assert.deepStrictEqual(workflow.toolPermissions, {
          mode: "custom",
          allowedTools: ["base_read"],
          deniedTools: ["base_write"],
        });
        assert.deepStrictEqual(workflow.hooks, [
          { event: "stop", command: "echo base" },
        ]);
        assert.deepStrictEqual(workflow.preCondition, {
          script: "base-pre.js",
          returns: "true",
          compareSource: "stdout",
          onPass: "continue",
          onFail: "skipPrompt",
        });
        assert.deepStrictEqual(workflow.endCondition, {
          script: "base-end.js",
          returns: "done",
          compareSource: "stdout",
          onPass: "continue",
          onFail: "retry",
          maxRetries: 1,
        });
        assert.deepStrictEqual(workflow.finalStep, { prompt: "base final" });
      };

      const state = instance.promptQueue.getState();
      const workflowFile = instance.promptQueue.getWorkflowFile();
      const workingFile =
        await instance.promptQueue.readWorkingFile(workingFilePath);
      const appendedStep = state.steps[1] as PromptStep;
      const persistedAppendedStep = workingFile.steps?.[1] as PromptStep;

      assert.strictEqual(state.workingFilePath, workingFilePath);
      assert.strictEqual(
        (instance as any).currentPromptFile?.filePath,
        baseSourcePath
      );
      assert.deepStrictEqual(
        state.steps.map((step) => (step as PromptStep).prompt),
        ["base prompt", "appended prompt"]
      );
      assertBaseWorkflowProperties(workflowFile);
      assertBaseWorkflowProperties(workingFile);
      assert.deepStrictEqual(appendedStep, {
        name: "appended step",
        prompt: "appended prompt",
        harness: HARNESS_IDS.ANTIGRAVITY_CLI,
        model: "append-step-model",
        additionalArgs: "--append-step",
        toolPermissions: {
          mode: "custom",
          allowedTools: ["append_step_read"],
          deniedTools: ["append_step_write"],
        },
      });
      assert.deepStrictEqual(persistedAppendedStep, appendedStep);
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

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
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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
      steps: [{ prompt: "first prompt" }],
    });
    await markQueueCompleted(instance);
    (instance.promptQueue as any).state.results[0].status =
      STEP_STATUS.COMPLETED;

    instance.setCurrentPromptFile("ephemeral.prompt.md", {
      steps: [{ prompt: "first prompt" }],
    });

    let promptCountSeenByRun = 0;
    (instance as any).executeLoadedPromptFile = async () => {
      promptCountSeenByRun =
        (instance as any).currentPromptFile?.promptFile.steps?.length ?? 0;
    };

    await instance.executeEphemeralPrompt("follow-up prompt", {}, "run");

    assert.strictEqual(promptCountSeenByRun, 2);
    assert.strictEqual(
      (instance as any).currentPromptFile?.promptFile.steps?.length,
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
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
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
      steps: [{ prompt: "completed prompt" }, { prompt: "appended prompt" }],
    });
    await markQueueCompleted(instance);
    (instance.promptQueue as any).state.results[0].status =
      STEP_STATUS.COMPLETED;
    (instance.promptQueue as any).state.results[1].status = STEP_STATUS.PENDING;

    instance.setCurrentPromptFile("workflow.prompt.md", {
      steps: [{ prompt: "completed prompt" }, { prompt: "appended prompt" }],
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

  test("keeps an earlier harness terminal alive when the next prompt switches harnesses", () => {
    class TrackingIntegration extends MockHarnessIntegration {
      closeTerminalCalls = 0;

      constructor(private readonly harness: HarnessId) {
        super(undefined, false);
      }

      override getIntegrationMode(): string {
        return this.harness;
      }

      override closeTerminal(): void {
        this.closeTerminalCalls += 1;
      }
    }

    class TrackingFactory extends IntegrationFactory {
      readonly created: TrackingIntegration[] = [];

      override createForExecution(harness: HarnessId): HarnessIntegration {
        const integration = new TrackingIntegration(harness);
        this.created.push(integration);
        return integration;
      }
    }

    const platform = new MockPlatform();
    const factory = new TrackingFactory(platform);
    const initialIntegration = new TrackingIntegration(HARNESS_IDS.CODEX_CLI);
    const instance = new WorkflowInstance(
      platform,
      undefined,
      factory,
      () => initialIntegration,
      () => {},
      () => {},
      process.cwd()
    );
    const context = (instance as any).buildWorkflowExecutionContext(
      initialIntegration,
      "",
      undefined
    );

    const claudeIntegration = context.getIntegrationForPrompt(
      { name: "Claude follow-up", prompt: "continue" },
      HARNESS_IDS.CLAUDE_CLI
    ) as TrackingIntegration;

    assert.strictEqual(initialIntegration.closeTerminalCalls, 0);

    context.getIntegrationForPrompt(
      { name: "Copilot follow-up", prompt: "continue" },
      HARNESS_IDS.COPILOT_CLI
    );

    assert.strictEqual(claudeIntegration.closeTerminalCalls, 0);
  });
});

suite("WorkflowInstance retained integration artifacts", () => {
  test("keeps completion hooks until a reusable PTY integration actually exits", async () => {
    class RetainedIntegration extends MockHarnessIntegration {
      cleanupCalls = 0;
      disposeCalls = 0;
      private ptyEndedCallback: (() => void) | undefined;

      override canReuseForInject(): boolean {
        return true;
      }

      override async cleanupWorkflowArtifacts(): Promise<void> {
        this.cleanupCalls += 1;
      }

      override onPtySessionEnded(callback: () => void): void {
        this.ptyEndedCallback = callback;
      }

      override dispose(): void {
        this.disposeCalls += 1;
        super.dispose();
      }

      firePtyEnded(): void {
        this.ptyEndedCallback?.();
      }
    }

    const platform = new MockPlatform();
    const instance = new WorkflowInstance(
      platform,
      undefined,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
    const integration = new RetainedIntegration(undefined, false);
    (instance as any).executionIntegrations.set(
      HARNESS_IDS.ANTIGRAVITY_CLI,
      integration
    );
    (instance as any).workflowExecutor.execute = async () => {};

    await (instance as any).startWorkflowExecution(
      integration,
      "",
      "workflow.ctrlyoke.json"
    );

    assert.strictEqual(
      integration.cleanupCalls,
      0,
      "completion hooks must remain installed while the integration can receive another injected prompt"
    );
    assert.strictEqual(integration.disposeCalls, 0);

    integration.firePtyEnded();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(
      integration.cleanupCalls,
      1,
      "provider artifacts should be cleaned once the retained PTY exits"
    );
    assert.strictEqual(integration.disposeCalls, 1);
  });
});

suite("WorkflowInstance executeSeededRun", () => {
  test("executes an already-seeded run without re-promoting or restarting, and initializes its own timeline", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "fp-seeded-run-")
    );
    let instance: WorkflowInstance | undefined;

    try {
      const platform = new MockPlatform();
      instance = new WorkflowInstance(
        platform,
        undefined,
        new MockIntegrationFactory(platform),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );

      // Build a source lineage + first run the same way a normal fresh execution
      // start would (draft -> promoteToNewRun), independent of executeSeededRun.
      // createWorkingFile only writes the draft to disk and sets workflowKey;
      // it does not hydrate in-memory queue steps (that's loadPrompts, which
      // replaces the whole queue state — including workflowKey/runRef — so it
      // isn't usable here). Set steps directly instead.
      await instance.promptQueue.createWorkingFile(
        "source-workflow",
        [{ prompt: "source step" }],
        tempWorkspace
      );
      (instance.promptQueue as any).state.steps = [{ prompt: "source step" }];
      const sourcePromotion = await instance.promptQueue.promoteToNewRun(
        tempWorkspace,
        Date.now()
      );
      assert.ok(sourcePromotion, "expected the source run to promote");
      const workflowKey = instance.promptQueue.getState().workflowKey!;

      const seeded = await WorkingFileManager.seedNewRun(
        tempWorkspace,
        workflowKey,
        sourcePromotion!.runRef
      );

      let promoteToNewRunCalls = 0;
      const originalPromoteToNewRun = instance.promptQueue.promoteToNewRun.bind(
        instance.promptQueue
      );
      (instance.promptQueue as any).promoteToNewRun = async (
        ...args: unknown[]
      ) => {
        promoteToNewRunCalls += 1;
        return (originalPromoteToNewRun as any)(...args);
      };

      let restartCalled = false;
      const originalRestart = instance.promptQueue.restart.bind(
        instance.promptQueue
      );
      (instance.promptQueue as any).restart = async (...args: unknown[]) => {
        restartCalled = true;
        return (originalRestart as any)(...args);
      };

      let executionHistoryFilePath: string | undefined;
      (instance as any).startWorkflowExecution = async (
        _integration: unknown,
        historyFilePath: string
      ) => {
        executionHistoryFilePath = historyFilePath;
      };
      await instance.executeSeededRun(seeded, workflowKey);

      assert.strictEqual(
        promoteToNewRunCalls,
        0,
        "executeSeededRun must not promote a second new run — the seeded run is already promoted"
      );
      assert.strictEqual(
        restartCalled,
        false,
        "executeSeededRun must not restart() the already-fresh seeded run"
      );
      assert.strictEqual(instance.promptQueue.getState().runRef, seeded.runRef);
      assert.strictEqual(
        (instance.promptQueue.getState().steps[0] as PromptStep).prompt,
        "source step"
      );

      await assert.doesNotReject(
        () => fs.access(path.join(seeded.runDir, "manifest.json")),
        "seeded run should have its own manifest.json"
      );
      await assert.doesNotReject(
        () => fs.access(path.join(seeded.runDir, "events.jsonl")),
        "seeded run should have its own events.jsonl"
      );
      const seededWorkingFile = JSON.parse(
        await fs.readFile(seeded.workingFilePath, "utf-8")
      );
      const seededManifest = JSON.parse(
        await fs.readFile(path.join(seeded.runDir, "manifest.json"), "utf-8")
      );
      assert.strictEqual(
        seededManifest.startedAt,
        seededWorkingFile.startedAt,
        "the seeded working file and manifest must share one run start timestamp"
      );
      assert.strictEqual(
        executionHistoryFilePath,
        path.join(seeded.runDir, "manifest.json"),
        "execution must write to the seeded run's manifest, not re-resolve the latest run"
      );

      const lineageDir = WorkflowPaths.lineageDir(tempWorkspace, workflowKey);
      const entries = await fs.readdir(lineageDir, { withFileTypes: true });
      const runDirs = entries.filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("run-")
      );
      assert.strictEqual(
        runDirs.length,
        2,
        `expected exactly the source run + the seeded run, found: ${runDirs.map((e) => e.name).join(", ")}`
      );
    } finally {
      // initializeRunAt triggers a fire-and-forget search-index refresh; without
      // waiting for it, deleting the workspace can race it (ENOTEMPTY on .search-index).
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });
});
