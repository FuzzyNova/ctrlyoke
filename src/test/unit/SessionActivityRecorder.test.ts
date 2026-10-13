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
  StepOutputTextMode,
  type HarnessId,
  INTERACTIVE_TERMINAL_MODES,
} from "../../types/DashboardConstants";
import { PromptStep } from "../../types/CtrlYokeTypes";
import type { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { getStepOutputText } from "../../utils/StepOutputText";

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
  readonly interactiveTerminal = INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY;
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
    let resumedActivityDisposable: { dispose(): void } | undefined;

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
      const resumedActivityEvents: Array<{
        stepName: string;
        events: unknown[];
      }> = [];
      resumedActivityDisposable = instance.onTargetStreamingEvents(
        ({ stepName, events }) => {
          resumedActivityEvents.push({ stepName, events });
        }
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
        [CLI_EVENT_TYPES.TEXT]
      );
      assert.strictEqual(
        getStepOutputText(
          { output: entry.cliOutput },
          StepOutputTextMode.TRANSCRIPT
        ),
        "done"
      );
      assert.deepStrictEqual(entry.cliOutput.tokens, {
        prompt: 10,
        completion: 5,
      });
      assert.ok(
        entry.cliOutput.elapsed >= 5,
        `expected elapsed to be refreshed to at least the original 5s, got ${entry.cliOutput.elapsed}`
      );

      // Follow-up events remain append-only timeline activity. The attempt's
      // aggregate keeps only the original response.
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
      assert.strictEqual(resumedActivityEvents.length, 2);
      assert.deepStrictEqual(
        resumedActivityEvents.map(({ events }) => events),
        followUpActivity.map((activity: any) => activity.events ?? [])
      );
      assert.deepStrictEqual(
        resumedActivityEvents.map(({ stepName }) => stepName),
        ["Step 1", "Step 1"]
      );
      assert.strictEqual(
        resumedActivityEvents
          .flatMap(({ events }) => events)
          .filter(
            (event: any) => event.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED
          ).length,
        1
      );
    } finally {
      resumedActivityDisposable?.dispose();
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

      // Both bursts append independently to the same attempt timeline.
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
        [CLI_EVENT_TYPES.TEXT]
      );
      assert.strictEqual(
        getStepOutputText(
          { output: entry.cliOutput },
          StepOutputTextMode.TRANSCRIPT
        ),
        "done"
      );
      const followUpEvents = (history.activityEntries ?? []).flatMap(
        (activity: any) => activity.events ?? []
      );
      assert.deepStrictEqual(
        followUpEvents.map((event: any) => event.type),
        [
          CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
          CLI_EVENT_TYPES.TEXT,
          CLI_EVENT_TYPES.TEXT,
        ]
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
      let completed = false;
      const disposable = instance.onResponseComplete(() => {
        completed = true;
      });
      const integration = (instance as any).createIntegrationForMode(
        HARNESS_IDS.COPILOT_CLI
      ) as MockHarnessIntegration;

      (integration as any).responseCompleteEmitter.fire();

      assert.strictEqual(completed, true);
      disposable.dispose();
    } finally {
      instance.dispose();
    }
  });

  test("retains resumed events when the existing aggregate has no structured output", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-session-activity-no-structured-")
    );
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
    try {
      const historyInit = await initTestRun(
        instance.outputHistoryManager,
        tempWorkspace,
        "wf-session-activity-no-structured"
      );
      (instance as any).activeHistoryFilePath = historyInit.filePath;
      const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target,
        [
          {
            prompt: "do the thing",
            response: "before.",
            elapsed: 1,
            isStreaming: false,
            timestampMs: Date.now() - 1000,
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
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Date.now(),
          data: { text: " and after." },
        },
      ]);

      const history = await instance.outputHistoryManager.loadHistory(
        historyInit.filePath
      );
      const output = history.orderedEntries.find(
        (entry: any) => entry.kind === OUTPUT_HISTORY_KINDS.CLI
      ) as any;
      assert.strictEqual(output?.cliOutput?.structured, undefined);
      assert.ok(
        (history.activityEntries ?? []).some((activity: any) =>
          activity.events?.some(
            (event: any) =>
              event.type === CLI_EVENT_TYPES.TEXT &&
              event.data.text === " and after."
          )
        )
      );
    } finally {
      instance.dispose();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });
});
