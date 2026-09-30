import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import {
  HarnessIntegration,
  HarnessStatus,
} from "../../core/HarnessIntegration";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
  type HarnessId,
} from "../../types/DashboardConstants";
import { PromptStep } from "../../types/CtrlYokeTypes";
import type { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

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

suite("WorkflowInstance session activity forwarding", () => {
  test("buffers SessionActivityWatcher handoff events until the completed step target is known", () => {
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
    (instance as any).sessionActivityRecorder.lastCompletedActivityTarget = {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 7 },
      runIndex: 0,
      attemptIndex: 0,
    };
    (instance as any).beginActivityTargetCapture();

    // createIntegrationForMode() is what every step dispatch uses to obtain its
    // integration. The session watcher can win the narrow race against output
    // finalization, so its event must wait for completed-target attribution.
    const integration = (instance as any).createIntegrationForMode(
      HARNESS_IDS.COPILOT_CLI
    ) as HarnessIntegration;

    (integration as any).sessionActivityResumedEmitter.fire({
      events: [
        { type: "userSteer", timestamp: Date.now(), data: { text: "hello" } },
      ],
    });

    assert.strictEqual(streamingEventsCalls.length, 0);
    (instance as any).recordCompletedActivityTarget(
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      0,
      0
    );

    assert.strictEqual(streamingEventsCalls.length, 1);
    assert.strictEqual(streamingEventsCalls[0].stepIndex, 0);
    assert.strictEqual(streamingEventsCalls[0].events.length, 1);
  });

  test("merges follow-up activity into the persisted history entry with a one-time divider and refreshed tokens/elapsed", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-session-activity-history-")
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

      (instance as any).sessionActivityRecorder.lastCompletedActivityTarget = {
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
        {
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: " and did more." },
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
          CLI_EVENT_TYPES.TEXT,
          CLI_EVENT_TYPES.USER_STEER,
        ]
      );
      // The persisted response text (what $previous/$all/$step:N read via
      // RunOutputResolver.resolvePriorContextItems) must include follow-up
      // activity, not just the pre-follow-up response.
      assert.strictEqual(entry.cliOutput.response, "done\n\n and did more.");
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

      // The merged aggregate alone is not enough to render a follow-up on
      // reload: `mapOrderedHistoryEntriesToMessages` renders an attempt from
      // its activity entries whenever any exist and drops the aggregate they
      // stand in for. A follow-up recorded only into `structured.events`
      // therefore rendered live and then disappeared on the next history load,
      // so each burst must also persist a replayable streamed-events batch —
      // carrying the same one-time divider the aggregate merge decided on.
      const followUpActivity = (history.activityEntries ?? []).filter(
        (activity: any) =>
          activity.kind === OUTPUT_ACTIVITY_KINDS.STRUCTURED &&
          activity.target.kind === FINAL_STEP_PHASES.QUEUE &&
          activity.target.stepIndex === 0
      );
      assert.deepStrictEqual(
        followUpActivity.map((activity: any) =>
          (activity.events ?? []).map((e: any) => e.type)
        ),
        [
          [
            CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
            CLI_EVENT_TYPES.USER_STEER,
            CLI_EVENT_TYPES.TEXT,
          ],
          [CLI_EVENT_TYPES.USER_STEER],
        ]
      );
    } finally {
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("serializes overlapping follow-up bursts so neither burst's events are lost", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-session-activity-race-")
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
        "wf-session-activity-race"
      );
      (instance as any).activeHistoryFilePath = historyInit.filePath;

      const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
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
            isStreaming: false,
            timestampMs: Date.now() - 5000,
            attemptIndex: 0,
            runIndex: 0,
          } as any,
        ]
      );

      (instance as any).sessionActivityRecorder.lastCompletedActivityTarget = {
        target,
        runIndex: 0,
        attemptIndex: 0,
      };

      // Every caller invokes this handler fire-and-forget, so two bursts can be
      // in flight at once. Persisting one is a read-modify-write over the
      // stored aggregate, so without serialization both merge onto the same
      // pre-burst aggregate and the later save drops the earlier burst.
      await Promise.all([
        (instance as any).handleSessionActivityResumed([
          {
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: Date.now(),
            data: { text: " first." },
          },
        ]),
        (instance as any).handleSessionActivityResumed([
          {
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: Date.now(),
            data: { text: " second." },
          },
        ]),
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

      assert.deepStrictEqual(
        (entry.cliOutput.structured?.events ?? []).map((e: any) => e.type),
        [
          CLI_EVENT_TYPES.TEXT,
          CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
          CLI_EVENT_TYPES.TEXT,
          CLI_EVENT_TYPES.TEXT,
        ]
      );
      assert.strictEqual(
        entry.cliOutput.response,
        "done\n\n first.\n\n second."
      );
      // Exactly one divider, even though both bursts read the aggregate.
      assert.strictEqual(
        (entry.cliOutput.structured?.events ?? []).filter(
          (e: any) => e.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED
        ).length,
        1
      );
    } finally {
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("forwards the execution integration response to instance subscribers", () => {
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

    try {
      let response: string | undefined;
      const disposable = instance.onResponseComplete((value) => {
        response = value;
      });
      const integration = (instance as any).createIntegrationForMode(
        HARNESS_IDS.COPILOT_CLI
      ) as MockHarnessIntegration;

      (integration as any).responseCompleteEmitter.fire("generated message");

      assert.strictEqual(response, "generated message");
      disposable.dispose();
    } finally {
      instance.dispose();
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
    (instance as any).sessionActivityRecorder.lastCompletedActivityTarget = {
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
      "before.\n\n and after."
    );
    assert.ok((instance.promptQueue as any).state.steps[0]._runtime?.stepId);
    assert.strictEqual(
      (instance.promptQueue as any).state.steps[0]._runtime?.startedAt,
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
    (instance as any).sessionActivityRecorder.lastCompletedActivityTarget = {
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
      "loop-before.\n\n loop-after."
    );
  });
});
