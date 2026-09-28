import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import type { IEvent, IPty } from "node-pty";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import {
  HarnessIntegration,
  HarnessStatus,
} from "../../core/HarnessIntegration";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { WorkflowStartupPipeline } from "../../core/orchestration/WorkflowStartupPipeline";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import {
  ACTION_TYPES,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  EXECUTION_MODES,
  EXECUTION_PHASES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  PARALLEL_GROUP_ADMISSION,
  STEP_STATUS,
  HARNESS_IDS,
  STATUS_MESSAGE_SEVERITY,
  WORKTREE_MODES,
  type HarnessId,
} from "../../types/DashboardConstants";
import { PromptStep } from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { ExecutionLeaseConflictError } from "../../core/orchestration/ExecutionRootLeaseManager";
import { configService } from "../../config/CtrlYokeConfigService";
import { secretGrantsTrustStore } from "../../config/SecretGrantsTrustStore";
import {
  initPtyProcessManager,
  PtySession,
} from "../../core/harness/PtyProcessManager";
import { spawnIdentityHash } from "../../types/ExecutionSpawnIdentity";

function createResolvedProperties(
  overrides: Partial<ResolvedProperties> = {}
): ResolvedProperties {
  return {
    harness: HARNESS_IDS.COPILOT_CLI,
    model: "test-model",
    executionMode: EXECUTION_MODES.INTERACTIVE,
    resumeSession: true,
    mcpServers: null,
    hooks: null,
    toolPermissions: null,
    ...overrides,
  };
}

function integrationCacheKey(props: ResolvedProperties): string {
  return `${props.harness}::${spawnIdentityHash(props)}`;
}

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
  getExtensionPath(): string {
    return process.cwd();
  }
}

class IneligibleMockPlatform extends MockPlatform {
  override getNamedWorkspaceRoots() {
    return [];
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

class SteerableMockHarnessIntegration extends MockHarnessIntegration {
  private activitySessionId?: string;
  readonly steerMessages: string[] = [];

  setActivitySessionId(sessionId: string): void {
    this.activitySessionId = sessionId;
  }

  override getActivitySessionId(): string | undefined {
    return this.activitySessionId;
  }

  override async sendSteerMessage(text: string): Promise<boolean> {
    this.steerMessages.push(text);
    return true;
  }
}

class MockPty implements IPty {
  readonly pid = 1;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = "test";
  handleFlowControl = false;
  readonly onData: IEvent<string> = () => ({ dispose: () => {} });
  readonly onExit: IEvent<{ exitCode: number; signal?: number }> = () => ({
    dispose: () => {},
  });

  resize(): void {}
  clear(): void {}
  write(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

function createPtySession(
  sessionId: string,
  workflowId: string,
  kind: "ai-cli" | "shell" = "ai-cli"
): PtySession {
  return new PtySession(
    sessionId,
    workflowId,
    "test session",
    0,
    kind,
    new MockPty()
  );
}

/**
 * Stands in for a `CliIntegration` holding a live interactive PTY, so
 * cross-integration session takeover can be exercised without a real harness.
 */
class SessionHoldingMockHarnessIntegration extends MockHarnessIntegration {
  private heldAiSessionId?: string;
  private heldPtySessionId?: string;
  readonly releasedAiSessions: string[] = [];

  holdAiSession(aiSessionId: string, ptySessionId: string): void {
    this.heldAiSessionId = aiSessionId;
    this.heldPtySessionId = ptySessionId;
  }

  override ownsLiveAiSession(aiSessionId: string): boolean {
    return this.heldAiSessionId === aiSessionId;
  }

  override async releaseLiveAiSession(
    aiSessionId: string
  ): Promise<string | undefined> {
    if (!this.ownsLiveAiSession(aiSessionId)) {
      return undefined;
    }
    this.releasedAiSessions.push(aiSessionId);
    const ptySessionId = this.heldPtySessionId;
    this.heldAiSessionId = undefined;
    this.heldPtySessionId = undefined;
    return ptySessionId;
  }
}

class MockIntegrationFactory extends IntegrationFactory {
  constructor(platform: PlatformAdapter) {
    super(platform);
  }

  override createForExecution(_harness: HarnessId): HarnessIntegration {
    return new SessionHoldingMockHarnessIntegration(undefined, false);
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

function createSummaryTestInstance(): WorkflowInstance {
  const platform = new MockPlatform();
  return new WorkflowInstance(
    platform,
    {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
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
      notifyPromptsReordered: () => {},
    } as any,
    new MockIntegrationFactory(platform),
    () => new MockHarnessIntegration(undefined, false),
    () => {},
    () => {},
    process.cwd()
  );
}

async function markQueueCompleted(instance: WorkflowInstance): Promise<void> {
  const queue = instance.promptQueue;
  queue.getRuntimeStateMachine().complete();
  await queue.commitRuntimeTransition({ persist: false });
}

suite("WorkflowInstance target resources", () => {
  test("gives same-harness target-keyed executions isolated integrations", () => {
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
      const sequentialProperties = createResolvedProperties();
      const first = (instance as any).createIntegrationForMode(
        HARNESS_IDS.COPILOT_CLI,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
        sequentialProperties
      ) as HarnessIntegration;
      const second = (instance as any).createIntegrationForMode(
        HARNESS_IDS.COPILOT_CLI,
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 },
        sequentialProperties
      ) as HarnessIntegration;
      const sequentialFirst = (instance as any).createIntegrationForMode(
        HARNESS_IDS.COPILOT_CLI,
        undefined,
        sequentialProperties
      ) as HarnessIntegration;
      const sequentialSecond = (instance as any).createIntegrationForMode(
        HARNESS_IDS.COPILOT_CLI,
        undefined,
        sequentialProperties
      ) as HarnessIntegration;

      assert.notStrictEqual(first, second);
      assert.strictEqual(sequentialFirst, sequentialSecond);
    } finally {
      instance.dispose();
    }
  });

  test("selects same-harness integrations by spawn identity", () => {
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
    const initial = new MockHarnessIntegration(undefined, false);
    const context = new WorkflowStartupPipeline(
      (instance as any).createWorkflowStartupPipelinePort()
    ).buildWorkflowExecutionContext(
      initial,
      "",
      undefined
    );
    const firstProperties = createResolvedProperties({ model: "model-one" });
    const secondProperties = createResolvedProperties({ model: "model-two" });

    try {
      const first = context.getIntegrationForPrompt(
        { name: "step one", prompt: "one" },
        firstProperties
      );
      const second = context.getIntegrationForPrompt(
        { name: "step two", prompt: "two" },
        secondProperties
      );
      const third = context.getIntegrationForPrompt(
        { name: "step three", prompt: "three" },
        firstProperties
      );

      assert.notStrictEqual(first, second);
      assert.strictEqual(third, first);
      assert.strictEqual(
        (instance as any).executionIntegrations.size,
        2,
        "each live spawn identity must retain its own integration"
      );
    } finally {
      instance.dispose();
    }
  });

  test("always creates a fresh integration when resumeSession is false", () => {
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
    const properties = createResolvedProperties({ resumeSession: false });

    try {
      const first = (instance as any).createIntegrationForMode(
        properties.harness,
        undefined,
        properties
      );
      const second = (instance as any).createIntegrationForMode(
        properties.harness,
        undefined,
        properties
      );

      assert.notStrictEqual(first, second);
      // The newest fresh session is the conversation that spawn identity now
      // names; the one it displaced keeps its terminal but is unselectable.
      assert.strictEqual((instance as any).executionIntegrations.size, 1);
      assert.strictEqual(
        (instance as any).executionIntegrations.get(
          integrationCacheKey(properties)
        ),
        second
      );
      assert.ok(
        (instance as any).unkeyedExecutionIntegrations.has(first),
        "a superseded integration must still be owned by the run"
      );
    } finally {
      instance.dispose();
    }
  });

  // The bug this covers: prompt 2 opens a fresh session, prompt 3 auto-resumes
  // *that* session, and selecting the pre-fresh integration made prompt 3 kill
  // prompt 1's terminal to restart on a session it did not own.
  test("continues a fresh session's integration on the next compatible prompt", () => {
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
    const initial = new MockHarnessIntegration(undefined, false);
    const context = new WorkflowStartupPipeline(
      (instance as any).createWorkflowStartupPipelinePort()
    ).buildWorkflowExecutionContext(
      initial,
      "",
      undefined
    );
    const resuming = createResolvedProperties();
    const fresh = createResolvedProperties({ resumeSession: false });

    try {
      const first = context.getIntegrationForPrompt(
        { name: "step one", prompt: "one" },
        resuming
      );
      const second = context.getIntegrationForPrompt(
        { name: "step two", prompt: "two" },
        fresh
      );
      const third = context.getIntegrationForPrompt(
        { name: "step three", prompt: "three" },
        resuming
      );

      assert.notStrictEqual(second, first);
      assert.strictEqual(
        third,
        second,
        "a resuming prompt must continue the newest session for its spawn identity"
      );
      assert.ok(
        (instance as any).unkeyedExecutionIntegrations.has(first),
        "the superseded terminal must stay owned rather than be reused or dropped"
      );
    } finally {
      instance.dispose();
    }
  });

  // Sibling terminals are only safe while they own different conversations. A
  // step that changes a spawn-time property but still resumes the previous
  // step's session must take that session over, because every harness rejects a
  // `--resume` of a session another process still holds open.
  test("retires the sibling terminal holding the session a prompt resumes", async () => {
    const platform = new MockPlatform();
    const posted: unknown[] = [];
    const ptyManager = initPtyProcessManager((message) => posted.push(message));
    const instance = new WorkflowInstance(
      platform,
      undefined,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
    const initial = new MockHarnessIntegration(undefined, false);
    const context = new WorkflowStartupPipeline(
      (instance as any).createWorkflowStartupPipelinePort()
    ).buildWorkflowExecutionContext(
      initial,
      "",
      undefined
    );

    try {
      const holder = context.getIntegrationForPrompt(
        { name: "step one", prompt: "one" },
        createResolvedProperties({ model: "model-one" })
      ) as SessionHoldingMockHarnessIntegration;
      const taker = context.getIntegrationForPrompt(
        { name: "step two", prompt: "two" },
        createResolvedProperties({ model: "model-two" })
      ) as SessionHoldingMockHarnessIntegration;
      holder.holdAiSession("ai-session-1", "pty-1");
      taker.holdAiSession("ai-session-2", "pty-2");

      await context.releaseConflictingAiSession!("ai-session-1", taker);

      assert.deepStrictEqual(holder.releasedAiSessions, ["ai-session-1"]);
      assert.deepStrictEqual(
        taker.releasedAiSessions,
        [],
        "the requester retires its own PTY through its own paths"
      );
      assert.deepStrictEqual(posted, [
        {
          type: MESSAGE_TYPES.TERMINAL_REMOVED,
          workflowId: instance.id,
          sessionId: "pty-1",
        },
      ]);

      posted.length = 0;
      await context.releaseConflictingAiSession!("ai-session-unrelated", taker);
      assert.deepStrictEqual(
        posted,
        [],
        "a sibling owning another conversation must be left alone"
      );
    } finally {
      instance.dispose();
      ptyManager.dispose();
    }
  });
});

suite("WorkflowInstance steer dispatch", () => {
  function createInstance(): WorkflowInstance {
    const platform = new MockPlatform();
    return new WorkflowInstance(
      platform,
      undefined,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
  }

  // `ptySessionId` is only populated for interactive *script* PTYs, so a
  // mid-run AI-CLI steer has to resolve through the integration's own activity
  // session id. Seeding `ptySessionId` here would test a shape production
  // never produces.
  test("resolves an active target integration by PTY session", async () => {
    const instance = createInstance();
    const integration = new SteerableMockHarnessIntegration(undefined, false);
    const session = createPtySession("active-session", instance.id);
    integration.setActivitySessionId(session.id);
    const ptyManager = initPtyProcessManager(() => undefined);
    ptyManager.getSession = () => session;
    (instance as any).activeTargetResources.set("active", {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      integration,
    });

    try {
      await instance.sendSteerMessage(session.id, "active steer");
      assert.deepStrictEqual(integration.steerMessages, ["active steer"]);
    } finally {
      instance.dispose();
      ptyManager.dispose();
    }
  });

  test("resolves a harness-keyed execution integration by PTY session", async () => {
    const instance = createInstance();
    const integration = new SteerableMockHarnessIntegration(undefined, false);
    const session = createPtySession("execution-session", instance.id);
    integration.setActivitySessionId(session.id);
    const ptyManager = initPtyProcessManager(() => undefined);
    ptyManager.getSession = () => session;
    (instance as any).executionIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.COPILOT_CLI })
      ),
      integration
    );

    try {
      await instance.sendSteerMessage(session.id, "execution steer");
      assert.deepStrictEqual(integration.steerMessages, ["execution steer"]);
    } finally {
      instance.dispose();
      ptyManager.dispose();
    }
  });

  test("resolves a retained integration by activity PTY session", async () => {
    const instance = createInstance();
    const integration = new SteerableMockHarnessIntegration(undefined, false);
    const session = createPtySession("retained-session", instance.id);
    integration.setActivitySessionId(session.id);
    const ptyManager = initPtyProcessManager(() => undefined);
    ptyManager.getSession = () => session;
    (instance as any).liveInjectIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.COPILOT_CLI })
      ),
      integration
    );

    try {
      await instance.sendSteerMessage(session.id, "retained steer");
      assert.deepStrictEqual(integration.steerMessages, ["retained steer"]);
    } finally {
      instance.dispose();
      ptyManager.dispose();
    }
  });

  test("rejects foreign, shell, and dead PTY sessions without writing", async () => {
    const instance = createInstance();
    const integration = new SteerableMockHarnessIntegration(undefined, false);
    const ptyManager = initPtyProcessManager(() => undefined);
    const foreignSession = createPtySession(
      "foreign-session",
      "other-workflow"
    );
    const shellSession = createPtySession(
      "shell-session",
      instance.id,
      "shell"
    );
    let currentSession: PtySession | undefined = foreignSession;
    ptyManager.getSession = () => currentSession;
    integration.setActivitySessionId(foreignSession.id);
    (instance as any).activeTargetResources.set("active", {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      integration,
    });

    try {
      await assert.rejects(
        instance.sendSteerMessage(foreignSession.id, "foreign steer")
      );
      currentSession = shellSession;
      await assert.rejects(
        instance.sendSteerMessage(shellSession.id, "shell steer")
      );
      currentSession = undefined;
      await assert.rejects(
        instance.sendSteerMessage("dead-session", "dead steer")
      );
      assert.deepStrictEqual(integration.steerMessages, []);
    } finally {
      instance.dispose();
      ptyManager.dispose();
    }
  });

  test("rejects a live session no integration claims", async () => {
    const instance = createInstance();
    const integration = new SteerableMockHarnessIntegration(undefined, false);
    integration.setActivitySessionId("some-other-session");
    const session = createPtySession("unclaimed-session", instance.id);
    const ptyManager = initPtyProcessManager(() => undefined);
    ptyManager.getSession = () => session;
    (instance as any).activeTargetResources.set("active", {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      integration,
    });

    try {
      await assert.rejects(
        instance.sendSteerMessage(session.id, "unclaimed steer"),
        /No live harness session/
      );
      assert.deepStrictEqual(integration.steerMessages, []);
    } finally {
      instance.dispose();
      ptyManager.dispose();
    }
  });
});

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
    assert.strictEqual(
      sessionRestoredCalls[0][12],
      instance.promptQueue.getState().definitionRevision,
      "session restore should carry the queue definition revision"
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

suite("WorkflowInstance replay classification", () => {
  test("omits the definition revision when the replay replaces the client's workflow", () => {
    const platform = new MockPlatform();
    const sessionRestoredCalls: any[] = [];
    const sink: any = {
      updateSessionRestored: async (...args: any[]) => {
        sessionRestoredCalls.push(args);
      },
      updateCliOutput: () => {},
      updateStatusMessage: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
      updateCliStreamingChunk: () => {},
      updateCliStreamingEvents: () => {},
      updateFileSelected: async () => {},
      updateExecutionStarted: () => {},
      updateProgress: () => {},
      updateExecutionState: () => {},
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      notifyPromptsReordered: () => {},
    };

    const instance = new WorkflowInstance(
      platform,
      sink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
    instance.promptQueue.loadPrompts({ steps: [{ prompt: "queue-1" }] });
    const revision = instance.promptQueue.getState().definitionRevision;

    // A replay of the workflow the client already displays: the revision is
    // what arms the webview's regressive-snapshot guard against this
    // in-memory snapshot overwriting a newer addressed one.
    instance.replayFullStateTo(sink);
    assert.strictEqual(sessionRestoredCalls[0][12], revision);

    // A replacement (a brand-new workflow, which has no lineage and therefore
    // no preceding address publish) must send none, or the webview reads it as
    // a replay and keeps the outgoing workflow's view address — every later
    // rename and prompt then lands on the workflow the user just left.
    instance.replayFullStateTo(sink, { asReplacement: true });
    assert.strictEqual(sessionRestoredCalls[1][12], undefined);
  });
});

suite("WorkflowInstance runtime transitions", () => {
  test("getSummary reports final-step definition and runtime state", async () => {
    const instance = createSummaryTestInstance();
    instance.promptQueue.loadPrompts({
      steps: [{ prompt: "queue" }],
      finalStep: { prompt: "final" },
    });
    await startQueueExecution(instance);

    const queueSummary = instance.getSummary();
    assert.strictEqual(queueSummary.hasFinalStep, true);
    assert.strictEqual(queueSummary.finalStepRunning, false);

    await instance.promptQueue.setFinalStepRuntime({
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      loopCount: 0,
      status: STEP_STATUS.RUNNING,
    });
    const finalStepSummary = instance.getSummary();
    assert.strictEqual(finalStepSummary.hasFinalStep, true);
    assert.strictEqual(finalStepSummary.finalStepRunning, true);

    instance.promptQueue.loadPrompts({ steps: [{ prompt: "queue-only" }] });
    const noFinalStepSummary = instance.getSummary();
    assert.strictEqual(noFinalStepSummary.hasFinalStep, false);
    assert.strictEqual(noFinalStepSummary.finalStepRunning, false);

    instance.promptQueue.loadPrompts({
      steps: [{ prompt: "queue" }],
      finalStep: { prompt: "disabled", enabled: false },
    });
    const disabledFinalStepSummary = instance.getSummary();
    assert.strictEqual(disabledFinalStepSummary.hasFinalStep, false);
    assert.strictEqual(disabledFinalStepSummary.finalStepRunning, false);
  });

  test("getSummary reports the workflow-level harness instead of a step override", async () => {
    const platform = new MockPlatform();
    const instance = new WorkflowInstance(
      platform,
      {
        updateFileSelected: async () => {},
        updateSessionRestored: async () => {},
        updateExecutionStarted: () => {},
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

  test("records runtime transitions to the run manifest after restoring a paused run", async () => {
    // Reproduces the post-restart shape: the previous host died while this run
    // was paused, so the instance is rebuilt from the run's working file and has
    // never called startWorkflowExecution. Its history file path is therefore
    // unset, and before resolveHistoryFilePath() every history write silently
    // no-op'd — the run resumed and completed on disk while manifest.json stayed
    // frozen at "paused", which is what desynced the run panel from the header.
    const platform = new MockPlatform();
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-restored-paused-")
    );
    let instance: WorkflowInstance | undefined;

    try {
      const dashboardSink: any = {
        updateFileSelected: async () => {},
        updateSessionRestored: async () => {},
        updateExecutionStarted: () => {},
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
        notifyPromptsReordered: () => {},
      };

      instance = new WorkflowInstance(
        platform,
        dashboardSink,
        new MockIntegrationFactory(platform),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempDir
      );

      // A promoted run on disk: lineage, run directory, manifest, and the run's
      // own working file left behind mid-run at PAUSED.
      const workflowKey = await WorkflowPaths.allocateWorkflowKey(
        tempDir,
        "restored-paused"
      );
      const runRef = WorkflowPaths.formatRunRef(Date.now());
      const runDir = WorkflowPaths.runDir(tempDir, workflowKey, runRef);
      await instance.outputHistoryManager.initializeRunAt(
        workflowKey,
        runRef,
        runDir,
        1,
        Date.now()
      );

      // initializeRunAt seeds RUNNING; the dead process left it at PAUSED, and
      // starting there is what makes the assertion below meaningful.
      const manifestPath = WorkflowPaths.manifestPath(
        tempDir,
        workflowKey,
        runRef
      );
      await new TimelineRecorder().updateManifest(manifestPath, (manifest) => ({
        ...manifest,
        executionState: EXECUTION_STATES.PAUSED,
      }));

      const runFilePath = path.join(runDir, "workflow.ctrlyoke.json");
      await fs.writeFile(
        runFilePath,
        JSON.stringify(
          {
            workflowName: "restored-paused",
            startedAt: Date.now(),
            lastModifiedAt: Date.now(),
            definitionRevision: 1,
            steps: [{ prompt: "done" }, { prompt: "pending" }],
            _runtime: {
              currentIndex: 1,
              executionState: EXECUTION_STATES.PAUSED,
            },
          },
          null,
          2
        ),
        "utf8"
      );

      let started = false;
      (instance as any).startWorkflowExecution = async () => {
        started = true;
      };

      await instance.loadWorkingFile(runFilePath);
      assert.strictEqual(
        instance.getQueueState().status,
        EXECUTION_STATES.PAUSED,
        "restored run should still be paused"
      );
      assert.strictEqual(started, false, "restore must not auto-start");
      assert.strictEqual(
        JSON.parse(await fs.readFile(manifestPath, "utf8")).executionState,
        EXECUTION_STATES.PAUSED,
        "manifest must start stale-paused or the assertion below proves nothing"
      );

      await instance.resume();
      // The transition write is queued off the transition callback, not awaited
      // by resume() itself.
      await (instance as any).pendingRuntimeTransitionHistoryWrite;

      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      assert.strictEqual(
        manifest.executionState,
        EXECUTION_STATES.RUNNING,
        "resuming a restored run must advance its manifest, not leave it stale"
      );
    } finally {
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
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
      definitionRevision: number | undefined;
    }> = [];
    const executionStates: string[] = [];

    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
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
        executionState?: string,
        definitionRevision?: number
      ) => {
        promptsExtendedCalls.push({
          promptCount: prompts.length,
          executionState,
          definitionRevision,
        });
      },
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
      updateStatusMessage: () => {},
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
      definitionRevision: 3,
    });

    assert.deepStrictEqual(executionStates, [EXECUTION_STATES.RUNNING]);
    assert.ok(
      promptsExtendedCalls.some(
        (call) =>
          call.promptCount === 2 &&
          call.executionState === EXECUTION_STATES.RUNNING &&
          call.definitionRevision === 3
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
      path.join(os.tmpdir(), "cy-instance-runtime-")
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
      path.join(os.tmpdir(), "cy-append-props-")
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
          expected: "true",
          compareSource: "stdout",
          onPass: "continue",
          onFail: "skipPrompt",
        },
        endCondition: {
          script: "base-end.js",
          expected: "done",
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
          '  expected: "true"',
          "  compareSource: stdout",
          "  onPass: continue",
          "  onFail: skipPrompt",
          "endCondition:",
          "  script: append-end.js",
          "  expected: done",
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
          expected: "true",
          compareSource: "stdout",
          onPass: "continue",
          onFail: "skipPrompt",
        });
        assert.deepStrictEqual(workflow.endCondition, {
          script: "base-end.js",
          expected: "done",
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
      const { _runtime: appendedRuntime, ...appendedDefinition } = appendedStep;
      assert.deepStrictEqual(appendedDefinition, {
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
      assert.ok(appendedRuntime?.stepId);
      assert.deepStrictEqual(persistedAppendedStep, appendedStep);
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("ephemeral append echoes workflow identity and parallel-group topology", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-ephemeral-echo-")
    );
    try {
      const updateCalls: unknown[][] = [];
      const dashboardSink: any = {
        updateStepsExtended: (...args: unknown[]) => {
          updateCalls.push(args);
        },
        updateWorkflowName: () => {},
        updateProgress: () => {},
      };
      const platform = new MockPlatform();
      const instance = new WorkflowInstance(
        platform,
        dashboardSink,
        new MockIntegrationFactory(platform),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );
      const steps: PromptStep[] = [
        { prompt: "member-a" },
        { prompt: "member-b" },
      ];
      const parallelGroups = [
        { id: "echo-group", startIndex: 0, endIndex: 1, failFast: false },
      ];
      const workingFilePath = await instance.promptQueue.createWorkingFile(
        "echo-workflow",
        steps,
        tempWorkspace,
        undefined,
        undefined,
        parallelGroups
      );
      instance.promptQueue.loadPrompts(
        { steps, parallelGroups },
        workingFilePath
      );
      updateCalls.length = 0;

      await instance.executeEphemeralPrompt(
        "queued prompt",
        {},
        ACTION_TYPES.QUEUE
      );

      const ephemeralEcho = updateCalls.find((args) => args[4] === instance.id);
      assert.ok(ephemeralEcho);
      assert.deepStrictEqual(
        ephemeralEcho[5],
        instance.promptQueue.getState().parallelGroups
      );
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("runParallel promotes the running sequential step with failFast disabled", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-ephemeral-parallel-promote-")
    );
    try {
      const updateCalls: unknown[][] = [];
      const dashboardSink = new Proxy(
        {
          updateStepsExtended: (...args: unknown[]) => updateCalls.push(args),
          updateProgress: () => {},
          updateWorkflowName: () => {},
        },
        {
          get: (target, property: string | symbol) =>
            target[property as keyof typeof target] ?? (() => {}),
        }
      );
      const instance = new WorkflowInstance(
        new MockPlatform(),
        dashboardSink as any,
        new MockIntegrationFactory(new MockPlatform()),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );
      const steps: PromptStep[] = [{ prompt: "anchor" }];
      const workingFilePath = await instance.promptQueue.createWorkingFile(
        "parallel-promote",
        steps,
        tempWorkspace
      );
      instance.promptQueue.loadPrompts({ steps }, workingFilePath);
      await startQueueExecution(instance);
      instance.promptQueue.getState().steps[0]._runtime = {
        stepId: "anchor-id",
        startedAt: Date.now(),
      };
      const joined: number[] = [];
      (instance as any).workflowExecutor.joinRunningParallelGroup = async (
        stepIndex: number
      ) => {
        joined.push(stepIndex);
        return { accepted: true };
      };

      await instance.executeEphemeralPrompt(
        "parallel member",
        {},
        ACTION_TYPES.RUN_PARALLEL
      );

      const state = instance.promptQueue.getState();
      assert.deepStrictEqual(joined, [1]);
      assert.strictEqual(state.parallelGroups.length, 1);
      assert.strictEqual(state.parallelGroups[0]?.startIndex, 0);
      assert.strictEqual(state.parallelGroups[0]?.endIndex, 1);
      assert.strictEqual(state.parallelGroups[0]?.failFast, false);
      assert.strictEqual(
        updateCalls.some((args) => args[6] === true),
        true
      );

      (instance as any).workflowExecutor.joinRunningParallelGroup = async (
        stepIndex: number
      ) => {
        joined.push(stepIndex);
        return {
          accepted: false,
          diagnostic: "admission closed during join",
        };
      };
      await assert.rejects(
        instance.executeEphemeralPrompt(
          "rejected parallel member",
          {},
          ACTION_TYPES.RUN_PARALLEL
        ),
        /admission closed during join/
      );
      assert.strictEqual(state.steps.length, 2);
      assert.strictEqual(state.parallelGroups[0]?.endIndex, 1);
      assert.deepStrictEqual(
        instance.promptQueue.getActiveParallelGroupRuntime(),
        {
          groupId: state.parallelGroups[0]?.id,
          admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
        }
      );
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("runParallel appends to an accepting live group", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-ephemeral-parallel-append-")
    );
    try {
      const instance = new WorkflowInstance(
        new MockPlatform(),
        undefined,
        new MockIntegrationFactory(new MockPlatform()),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );
      const steps: PromptStep[] = [
        { prompt: "anchor" },
        { prompt: "existing member" },
      ];
      const parallelGroups = [
        { id: "group-1", startIndex: 0, endIndex: 1, failFast: false },
      ];
      const workingFilePath = await instance.promptQueue.createWorkingFile(
        "parallel-append",
        steps,
        tempWorkspace,
        undefined,
        undefined,
        parallelGroups
      );
      instance.promptQueue.loadPrompts(
        { steps, parallelGroups },
        workingFilePath
      );
      await startQueueExecution(instance);
      await instance.promptQueue.setActiveParallelGroupAdmission(
        "group-1",
        PARALLEL_GROUP_ADMISSION.ACCEPTING
      );
      instance.promptQueue.getState().steps[0]._runtime = {
        stepId: "anchor-id",
        startedAt: Date.now(),
      };
      const joined: number[] = [];
      (instance as any).workflowExecutor.joinRunningParallelGroup = async (
        stepIndex: number
      ) => {
        joined.push(stepIndex);
        return { accepted: true };
      };

      await instance.executeEphemeralPrompt(
        "parallel member",
        {},
        ACTION_TYPES.RUN_PARALLEL
      );

      const state = instance.promptQueue.getState();
      assert.deepStrictEqual(joined, [2]);
      assert.strictEqual(state.steps.length, 3);
      assert.deepStrictEqual(state.parallelGroups, [
        { id: "group-1", startIndex: 0, endIndex: 2, failFast: false },
      ]);
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  // Regression: an ad-hoc promotion groups a step whose TUI is already live, so
  // that PTY was announced with `parallelGroupId: undefined`. The webview keeps
  // same-harness terminals apart by that field alone, so without the back-fill
  // the joining member's TERMINAL_STARTED evicted the promoted step's terminal.
  test("runParallel adopts the promoted step's live PTY session into the new group", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-ephemeral-parallel-pty-")
    );
    const posted: any[] = [];
    const ptyManager = initPtyProcessManager((msg) => posted.push(msg));
    try {
      const instance = new WorkflowInstance(
        new MockPlatform(),
        undefined,
        new MockIntegrationFactory(new MockPlatform()),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );
      const runningSession = new PtySession(
        "promoted-session",
        instance.id,
        "anchor",
        0,
        "ai-cli",
        new MockPty(),
        1,
        HARNESS_IDS.CLAUDE_CLI
      );
      // A session for a step outside the new group must be left alone.
      const unrelatedSession = new PtySession(
        "unrelated-session",
        instance.id,
        "later step",
        7,
        "ai-cli",
        new MockPty(),
        8,
        HARNESS_IDS.CLAUDE_CLI
      );
      ptyManager.getSessionsForWorkflow = () => [
        runningSession,
        unrelatedSession,
      ];

      const steps: PromptStep[] = [{ prompt: "anchor" }];
      const workingFilePath = await instance.promptQueue.createWorkingFile(
        "parallel-promote-pty",
        steps,
        tempWorkspace
      );
      instance.promptQueue.loadPrompts({ steps }, workingFilePath);
      await startQueueExecution(instance);
      instance.promptQueue.getState().steps[0]._runtime = {
        stepId: "anchor-id",
        startedAt: Date.now(),
      };
      (instance as any).workflowExecutor.joinRunningParallelGroup =
        async () => ({ accepted: true });

      posted.length = 0;
      await instance.executeEphemeralPrompt(
        "parallel member",
        {},
        ACTION_TYPES.RUN_PARALLEL
      );

      const groupId = instance.promptQueue.getState().parallelGroups[0]?.id;
      assert.ok(groupId);
      assert.strictEqual(runningSession.parallelGroupId, groupId);
      assert.strictEqual(unrelatedSession.parallelGroupId, undefined);

      const adoption = posted.filter(
        (msg) =>
          msg?.type === MESSAGE_TYPES.TERMINAL_STARTED &&
          msg.sessionId === runningSession.id
      );
      assert.strictEqual(adoption.length, 1);
      assert.strictEqual(adoption[0].parallelGroupId, groupId);
      assert.strictEqual(adoption[0].stepIndex, 0);
      assert.strictEqual(adoption[0].harnessId, HARNESS_IDS.CLAUDE_CLI);
      assert.strictEqual(
        posted.some((msg) => msg?.sessionId === unrelatedSession.id),
        false
      );
    } finally {
      ptyManager.dispose();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("runParallel rejects without mutating an idle queue", async () => {
    const instance = new WorkflowInstance(
      new MockPlatform(),
      undefined,
      new MockIntegrationFactory(new MockPlatform()),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
    try {
      instance.promptQueue.loadPrompts({ steps: [{ prompt: "queued" }] });
      await assert.rejects(
        instance.executeEphemeralPrompt(
          "must reject",
          {},
          ACTION_TYPES.RUN_PARALLEL
        ),
        /No step is running/
      );
      assert.strictEqual(instance.promptQueue.getState().steps.length, 1);
      assert.deepStrictEqual(
        instance.promptQueue.getState().parallelGroups,
        []
      );
    } finally {
      instance.dispose();
    }
  });

  test("runParallel rejects final-step, pausing, stopping, and closed admission states", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-ephemeral-parallel-reject-")
    );
    try {
      const instance = new WorkflowInstance(
        new MockPlatform(),
        undefined,
        new MockIntegrationFactory(new MockPlatform()),
        () => new MockHarnessIntegration(undefined, false),
        () => {},
        () => {},
        tempWorkspace
      );
      const steps: PromptStep[] = [{ prompt: "anchor" }, { prompt: "member" }];
      const parallelGroups = [
        { id: "group-1", startIndex: 0, endIndex: 1, failFast: false },
      ];
      const workingFilePath = await instance.promptQueue.createWorkingFile(
        "parallel-reject",
        steps,
        tempWorkspace,
        undefined,
        undefined,
        parallelGroups
      );
      instance.promptQueue.loadPrompts(
        { steps, parallelGroups },
        workingFilePath
      );
      await startQueueExecution(instance);

      await instance.promptQueue.setFinalStepRuntime({
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: 0,
        startedAt: Date.now(),
      });
      await assert.rejects(
        instance.executeEphemeralPrompt(
          "reject final",
          {},
          ACTION_TYPES.RUN_PARALLEL
        ),
        /final step cannot run in parallel/
      );
      assert.strictEqual(instance.promptQueue.getState().steps.length, 2);
      await instance.promptQueue.setFinalStepRuntime(undefined);

      const stateMachine = instance.promptQueue.getRuntimeStateMachine();
      assert.strictEqual(stateMachine.pause(), true);
      await assert.rejects(
        instance.executeEphemeralPrompt(
          "reject pause",
          {},
          ACTION_TYPES.RUN_PARALLEL
        ),
        /pausing/
      );
      assert.strictEqual(stateMachine.cancelPause(), true);

      assert.strictEqual(stateMachine.requestStop(), true);
      await assert.rejects(
        instance.executeEphemeralPrompt(
          "reject stopping",
          {},
          ACTION_TYPES.RUN_PARALLEL
        ),
        /No step is running/
      );
      assert.strictEqual(stateMachine.confirmStopped(), true);
      await assert.rejects(
        instance.executeEphemeralPrompt(
          "reject stopped",
          {},
          ACTION_TYPES.RUN_PARALLEL
        ),
        /No step is running/
      );

      assert.strictEqual(stateMachine.resume(), true);
      await instance.promptQueue.setActiveParallelGroupAdmission(
        "group-1",
        PARALLEL_GROUP_ADMISSION.CLOSING
      );
      instance.promptQueue.getState().steps[0]._runtime = {
        stepId: "anchor-id",
        startedAt: Date.now(),
      };
      await assert.rejects(
        instance.executeEphemeralPrompt(
          "reject closed",
          {},
          ACTION_TYPES.RUN_PARALLEL
        ),
        /no longer accepting members/
      );
      assert.strictEqual(instance.promptQueue.getState().steps.length, 2);
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
    const lifecycle: string[] = [];
    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: (...args: any[]) => {
        executionStartedArgs = args;
        lifecycle.push("execution-started");
      },
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
    (instance as any).prepareExecutionWorktree = async () => {
      lifecycle.push("prepare-worktree");
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
      undefined,
      "interactive",
    ]);
    assert.deepStrictEqual(lifecycle, [
      "prepare-worktree",
      "execution-started",
    ]);
  });

  test("dispatches fresh execution start before preparing its worktree", async () => {
    const platform = new MockPlatform();
    const lifecycle: string[] = [];
    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {
        lifecycle.push("execution-started");
      },
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

    instance.promptQueue.loadPrompts({ steps: [{ prompt: "fresh prompt" }] });
    instance.setCurrentPromptFile("workflow.prompt.md", {
      steps: [{ prompt: "fresh prompt" }],
    });
    (instance as any).prepareExecutionWorktree = async () => {
      lifecycle.push("prepare-worktree");
    };
    (instance as any).startWorkflowExecution = async () => {};

    await (instance as any).executeLoadedPromptFile();

    assert.deepStrictEqual(lifecycle, [
      "execution-started",
      "prepare-worktree",
    ]);
  });

  // finalizeFailedInFlightPrompt advances currentIndex past the step it just
  // failed, so by the time the workflow flips to ERROR the dashboard's
  // currentStep names the *next* step. Nothing else reports this failure — the
  // setup/startup path never reaches the attempt state machine — so without an
  // explicit updateStepStatus the webview paints the error icon one row low.
  test("reports the failed step index when execution start throws mid-run", async () => {
    const platform = new MockPlatform();
    const stepStatusCalls: Array<{ stepIndex: number; state: string }> = [];
    const dashboardSink: any = {
      updateFileSelected: async () => {},
      updateSessionRestored: async () => {},
      updateExecutionStarted: () => {},
      updateProgress: () => {},
      updateExecutionState: () => {},
      updateStepStatus: (stepIndex: number, status: { state: string }) => {
        stepStatusCalls.push({ stepIndex, state: status.state });
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

    const steps = [
      { prompt: "first" },
      { prompt: "second" },
      { prompt: "third" },
    ];
    instance.promptQueue.loadPrompts({ steps });
    instance.setCurrentPromptFile("workflow.prompt.md", { steps });
    // Mid-run: step 0 done, step 1 in flight.
    (instance.promptQueue as any).state.currentIndex = 1;
    (instance.promptQueue as any).state.results[0].status =
      STEP_STATUS.COMPLETED;
    (instance.promptQueue as any).state.results[1].status = STEP_STATUS.RUNNING;

    (instance as any).prepareExecutionWorktree = async () => {};
    (instance as any).startWorkflowExecution = async () => {
      throw new Error("EPERM: operation not permitted, rename '…'");
    };

    await (instance as any).executeLoadedPromptFile(undefined, true);

    assert.deepStrictEqual(stepStatusCalls, [
      { stepIndex: 1, state: STEP_STATUS.FAILED },
    ]);
    // The reported index is the step that failed, not the advanced cursor.
    assert.strictEqual(instance.promptQueue.getState().currentIndex, 2);
    assert.strictEqual(
      instance.promptQueue.getState().results[1].status,
      STEP_STATUS.FAILED
    );
    assert.match(
      instance.promptQueue.getState().results[1].error ?? "",
      /EPERM/
    );
  });

  // Publishing a run deletes the lineage's draft, so once promotion succeeds the
  // run is the only place the user's definition lives. A start that throws after
  // that point — here the timeline init the promotion itself needs — must still
  // finalize the run it published: its staged manifest reads RUNNING, and left
  // that way the lineage shows a permanently executing run that retention never
  // prunes and whose header offers neither Resume nor Run. `historyFilePath` is
  // not yet resolved on this path, which is exactly why the promoted RunRef is
  // tracked separately.
  test("finalizes and reports a run whose start failed after the promotion published it", async () => {
    const platform = new MockPlatform();
    const statusMessages: Array<{ message: string; severity: string }> = [];
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
      updateCliStreamingEvents: () => {},
      updateStepsExtended: () => {},
      updatePromptDeleted: () => {},
      updateFinalStep: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
      updateStatusMessage: (
        _stepIndex: number,
        message: string,
        severity: string
      ) => {
        statusMessages.push({ message, severity });
      },
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
      steps: [{ prompt: "an hour of work" }],
    });
    instance.setCurrentPromptFile("workflow.ctrlyoke.json", {
      steps: [{ prompt: "an hour of work" }],
    });
    const workflowKey = "doomed-2026-07-30T14-00-00-000";
    const runRef = "run-2026-07-30T14-00-00-000Z";
    (instance.promptQueue as any).state.workflowKey = workflowKey;
    (instance.promptQueue as any).promoteToNewRun = async () => ({
      workingFilePath: "run/workflow.ctrlyoke.json",
      runRef,
      runId: 1,
      runDir: "run",
      stagingRunDir: "staging",
      stagingWorkingFilePath: "staging/workflow.ctrlyoke.json",
      allocation: {},
    });
    (instance as any).syncCurrentPromptFileFromQueue = () => {};

    const history = (instance as any).outputHistoryManager;
    // The published run exists; only its timeline init fails.
    history.initializeRunAt = async () => ({ filePath: "" });
    history.getHistoryFilePath = (key: string, ref: string) =>
      `${key}/${ref}/manifest.json`;
    const finalized: Array<{ path: string; state: string }> = [];
    history.finalizeRun = async (filePath: string, state: string) => {
      finalized.push({ path: filePath, state });
    };
    const persistedStatusMessages: Array<{
      filePath: string;
      message: string;
      severity: string;
    }> = [];
    history.appendStatusMessage = async (
      filePath: string,
      _target: unknown,
      statusMessage: { message: string; severity: string }
    ) => {
      persistedStatusMessages.push({
        filePath,
        message: statusMessage.message,
        severity: statusMessage.severity,
      });
    };

    await (instance as any).executeLoadedPromptFile();

    assert.deepStrictEqual(
      finalized,
      [
        {
          path: `${workflowKey}/${runRef}/manifest.json`,
          state: EXECUTION_STATES.ERROR,
        },
      ],
      "the published run must not be left reading RUNNING forever"
    );
    assert.strictEqual(
      statusMessages.filter(
        (entry) => entry.severity === STATUS_MESSAGE_SEVERITY.ERROR
      ).length,
      1,
      "the failure must reach the dashboard, not only the VS Code notification"
    );
    // The live-only push above vanishes on the next workflow switch unless it
    // is also written to history — this is the failure this test guards
    // against (a user navigating away and back must still see why it failed).
    assert.strictEqual(
      persistedStatusMessages.length,
      1,
      "the execution-failure row must survive navigating away and back"
    );
    assert.strictEqual(
      persistedStatusMessages[0].filePath,
      `${workflowKey}/${runRef}/manifest.json`
    );
    assert.strictEqual(
      persistedStatusMessages[0].severity,
      STATUS_MESSAGE_SEVERITY.ERROR
    );
    assert.strictEqual(
      persistedStatusMessages[0].message,
      statusMessages.find(
        (entry) => entry.severity === STATUS_MESSAGE_SEVERITY.ERROR
      )?.message
    );
  });

  test("deduplicates compatibility live pushes while persisting after history starts", () => {
    const statusMessages: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];
    const dashboardSink: any = {
      updateStatusMessage: (
        stepIndex: number,
        message: string,
        severity: string
      ) => {
        statusMessages.push({ stepIndex, message, severity });
      },
    };
    const instance = new WorkflowInstance(
      new MockPlatform(),
      dashboardSink,
      new MockIntegrationFactory(new MockPlatform()),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
    const persistedStatusMessages: Array<{
      filePath: string;
      message: string;
      severity: string;
    }> = [];
    (instance as any).outputHistoryManager.appendStatusMessage = async (
      filePath: string,
      _target: unknown,
      statusMessage: { message: string; severity: string }
    ) => {
      persistedStatusMessages.push({
        filePath,
        message: statusMessage.message,
        severity: statusMessage.severity,
      });
    };
    const diagnostic: CompatibilityDiagnostic = {
      code: "compatibility.test",
      severity: "warning",
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      capability: "images",
      state: {
        fidelity: "unsupported",
        mechanism: "none",
        verification: "unknown",
      },
      consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      message: "Images are not supported.",
    };

    (instance as any).reportCompatibilityDiagnostics([diagnostic], 1234);
    (instance as any).activeHistoryFilePath = "history.json";
    (instance as any).reportCompatibilityDiagnostics([diagnostic], 1234);

    assert.deepStrictEqual(statusMessages, [
      {
        stepIndex: 0,
        message: diagnostic.message,
        severity: diagnostic.severity,
      },
    ]);
    assert.deepStrictEqual(persistedStatusMessages, [
      {
        filePath: "history.json",
        message: diagnostic.message,
        severity: diagnostic.severity,
      },
    ]);
  });

  test("re-reports missing-asset warnings once history starts", () => {
    const statusMessages: Array<{ message: string; severity: string }> = [];
    const persistedStatusMessages: Array<{
      filePath: string;
      message: string;
      severity: string;
    }> = [];
    const dashboardSink: any = {
      updateStatusMessage: (
        _stepIndex: number,
        message: string,
        severity: string
      ) => {
        statusMessages.push({ message, severity });
      },
    };
    const platform = new MockPlatform();
    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
    const history = (instance as any).outputHistoryManager;
    history.appendStatusMessage = async (
      filePath: string,
      _target: unknown,
      statusMessage: { message: string; severity: string }
    ) => {
      persistedStatusMessages.push({
        filePath,
        message: statusMessage.message,
        severity: statusMessage.severity,
      });
    };
    const loader = (instance as any).promptFileLoader;
    loader.lastMissingAssetDirectories = ["portable.assets"];

    (instance as any).reportMissingAssetWarning(
      loader.getLastMissingAssetDirectories()
    );
    (instance as any).statusMessageReporter.resetDedupeState([
      JSON.stringify(loader.getLastMissingAssetDirectories()),
    ]);
    (instance as any).activeHistoryFilePath = "history.json";
    (instance as any).reportMissingAssetWarning(
      loader.getLastMissingAssetDirectories()
    );

    assert.deepStrictEqual(statusMessages, [
      {
        message:
          "Workflow references missing exported assets: portable.assets. Restore the sibling *.assets/ directory or use Save As to create a portable copy.",
        severity: "warning",
      },
    ]);
    assert.deepStrictEqual(persistedStatusMessages, [
      {
        filePath: "history.json",
        message:
          "Workflow references missing exported assets: portable.assets. Restore the sibling *.assets/ directory or use Save As to create a portable copy.",
        severity: "warning",
      },
    ]);
  });

  test("reports and persists missing-secret warnings", async () => {
    const missingSecretName = `CTRLYOKE_MISSING_${Date.now()}`;
    const statusMessages: Array<{ message: string; severity: string }> = [];
    const persistedStatusMessages: Array<{
      filePath: string;
      message: string;
      severity: string;
    }> = [];
    const dashboardSink: any = {
      updateExecutionStarted: () => {},
      updateStepsExtended: () => {},
      updateProgress: () => {},
      updateStatusMessage: (
        _stepIndex: number,
        message: string,
        severity: string
      ) => {
        statusMessages.push({ message, severity });
      },
    };
    const platform = new MockPlatform();
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
      steps: [{ prompt: "missing secret", secrets: [missingSecretName] }],
    });
    instance.setCurrentPromptFile("workflow.ctrlyoke.json", {
      steps: [{ prompt: "missing secret", secrets: [missingSecretName] }],
    });
    (instance as any).activeHistoryFilePath = "history.json";
    (instance as any).outputHistoryManager.appendStatusMessage = async (
      filePath: string,
      _target: unknown,
      statusMessage: { message: string; severity: string }
    ) => {
      persistedStatusMessages.push({
        filePath,
        message: statusMessage.message,
        severity: statusMessage.severity,
      });
    };
    (instance as any).ensureRunnerLock = async () => {};
    (instance as any).prepareExecutionWorktree = async () => {};
    (instance as any).computeTargetRunIndices = async () => new Map();
    (instance as any).startWorkflowExecution = async () => {};

    const originalGetDecision = secretGrantsTrustStore.getDecision;
    secretGrantsTrustStore.getDecision = () => "allow";
    try {
      configService.setCliOverlay({
        execution: {
          contextResolutionFailure: CONTEXT_RESOLUTION_FAILURE_MODES.WARN,
        },
      });
      await (instance as any).executeLoadedPromptFile(
        undefined,
        false,
        "history.json",
        true
      );
    } finally {
      secretGrantsTrustStore.getDecision = originalGetDecision;
      configService.setCliOverlay({});
    }

    assert.strictEqual(statusMessages.length, 1);
    assert.strictEqual(statusMessages[0].severity, "warning");
    assert.strictEqual(persistedStatusMessages.length, 1);
    assert.deepStrictEqual(persistedStatusMessages[0], {
      filePath: "history.json",
      message: statusMessages[0].message,
      severity: statusMessages[0].severity,
    });
  });

  test("reports and persists inherited-worktree notices", async () => {
    const statusMessages: Array<{ message: string; severity: string }> = [];
    const persistedStatusMessages: Array<{
      filePath: string;
      message: string;
      severity: string;
    }> = [];
    const dashboardSink: any = {
      updateExecutionStarted: () => {},
      updateStepsExtended: () => {},
      updateProgress: () => {},
      updateStatusMessage: (
        _stepIndex: number,
        message: string,
        severity: string
      ) => {
        statusMessages.push({ message, severity });
      },
    };
    const platform = new IneligibleMockPlatform();
    const instance = new WorkflowInstance(
      platform,
      dashboardSink,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd()
    );
    instance.promptQueue.loadPrompts({ steps: [{ prompt: "worktree" }] });
    instance.setCurrentPromptFile("workflow.ctrlyoke.json", {
      steps: [{ prompt: "worktree" }],
    });
    (instance as any).activeHistoryFilePath = "history.json";
    (instance as any).outputHistoryManager.appendStatusMessage = async (
      filePath: string,
      _target: unknown,
      statusMessage: { message: string; severity: string }
    ) => {
      persistedStatusMessages.push({
        filePath,
        message: statusMessage.message,
        severity: statusMessage.severity,
      });
    };
    (instance as any).ensureRunnerLock = async () => {};
    (instance as any).prepareExecutionWorktree = async () => {};
    (instance as any).computeTargetRunIndices = async () => new Map();
    (instance as any).startWorkflowExecution = async () => {};

    try {
      configService.setCliOverlay({
        defaults: {
          worktree: { mode: WORKTREE_MODES.NAMED, branch: "notice-test" },
        },
      });
      await (instance as any).executeLoadedPromptFile(
        undefined,
        false,
        "history.json",
        true
      );
    } finally {
      configService.setCliOverlay({});
    }

    assert.strictEqual(statusMessages.length, 1);
    assert.strictEqual(statusMessages[0].severity, "warning");
    assert.strictEqual(persistedStatusMessages.length, 1);
    assert.deepStrictEqual(persistedStatusMessages[0], {
      filePath: "history.json",
      message: statusMessages[0].message,
      severity: statusMessages[0].severity,
    });
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
    const context = new WorkflowStartupPipeline(
      (instance as any).createWorkflowStartupPipelinePort()
    ).buildWorkflowExecutionContext(
      initialIntegration,
      "",
      undefined
    );

    const claudeIntegration = context.getIntegrationForPrompt(
      { name: "Claude follow-up", prompt: "continue" },
      createResolvedProperties({ harness: HARNESS_IDS.CLAUDE_CLI })
    ) as TrackingIntegration;

    assert.strictEqual(initialIntegration.closeTerminalCalls, 0);

    context.getIntegrationForPrompt(
      { name: "Copilot follow-up", prompt: "continue" },
      createResolvedProperties({ harness: HARNESS_IDS.COPILOT_CLI })
    );

    assert.strictEqual(claudeIntegration.closeTerminalCalls, 0);
  });
});

suite("WorkflowInstance secret-grant approval callback", () => {
  test("invokes approval before secret preflight", async () => {
    const secretName = `CTRLYOKE_APPROVAL_${Date.now()}`;
    const previousSecret = process.env[secretName];
    process.env[secretName] = "resolved";
    const originalGetDecision = secretGrantsTrustStore.getDecision;
    let approvalCalled = false;

    const platform = new MockPlatform();
    const instance = new WorkflowInstance(
      platform,
      undefined,
      new MockIntegrationFactory(platform),
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      process.cwd(),
      true,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      async (_workflow, _workspaceRoot) => {
        approvalCalled = true;
        secretGrantsTrustStore.getDecision = () => "allow";
      }
    );
    const workflow = {
      steps: [{ prompt: "use the approved secret", secrets: [secretName] }],
    };
    instance.promptQueue.loadPrompts(workflow);
    instance.setCurrentPromptFile("workflow.ctrlyoke.json", workflow);
    (instance as any).ensureRunnerLock = async () => {};
    (instance as any).prepareExecutionWorktree = async () => {};
    (instance as any).computeTargetRunIndices = async () => new Map();
    (instance as any).startWorkflowExecution = async () => {};

    try {
      configService.setCliOverlay({
        execution: {
          contextResolutionFailure: CONTEXT_RESOLUTION_FAILURE_MODES.WARN,
        },
      });
      await (instance as any).executeLoadedPromptFile(
        undefined,
        false,
        "history.json",
        true
      );
    } finally {
      secretGrantsTrustStore.getDecision = originalGetDecision;
      configService.setCliOverlay({});
      if (previousSecret === undefined) {
        delete process.env[secretName];
      } else {
        process.env[secretName] = previousSecret;
      }
    }

    assert.strictEqual(approvalCalled, true);
  });
});

suite("WorkflowInstance retained integration artifacts", () => {
  test("keeps required completion hooks until a reusable PTY integration actually exits", async () => {
    class RetainedIntegration extends MockHarnessIntegration {
      cleanupCalls = 0;
      disposeCalls = 0;
      private ptyEndedCallback: (() => void) | undefined;

      override canReuseForInject(): boolean {
        return true;
      }

      override shouldRetainWorkflowArtifactsForReuse(): boolean {
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
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.ANTIGRAVITY_CLI })
      ),
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

  test("cleans ordinary provider artifacts when execution ends while retaining the reusable PTY", async () => {
    class EagerCleanupIntegration extends MockHarnessIntegration {
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
    const integration = new EagerCleanupIntegration(undefined, false);
    (instance as any).executionIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.CODEX_CLI })
      ),
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
      1,
      "Codex-style artifacts should be removed as soon as execution completes"
    );
    assert.strictEqual(
      integration.disposeCalls,
      0,
      "the reusable PTY integration should remain available for injection"
    );

    integration.firePtyEnded();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(
      integration.cleanupCalls,
      1,
      "PTY exit must not repeat eager artifact cleanup"
    );
    assert.strictEqual(integration.disposeCalls, 1);
  });

  test("gracefully closes the terminal before disposing a worktree-run integration", async () => {
    class WorktreeIntegration extends MockHarnessIntegration {
      gracefulCloseCalls = 0;
      disposeCalls = 0;
      private gracefulCloseHappened = false;
      private disposedAfterGracefulClose = false;

      override closeTerminalGracefully(): void {
        this.gracefulCloseCalls += 1;
        this.gracefulCloseHappened = true;
      }

      override dispose(): void {
        this.disposeCalls += 1;
        this.disposedAfterGracefulClose = this.gracefulCloseHappened;
        super.dispose();
      }

      wasGracefullyClosedBeforeDispose(): boolean {
        return this.disposedAfterGracefulClose;
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
    const integration = new WorktreeIntegration(undefined, false);
    (instance as any).executionIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.CLAUDE_CLI })
      ),
      integration
    );
    (instance as any).workflowExecutor.execute = async () => {};
    // Simulate a live worktree run reaching terminal settlement: an active
    // worktree reservation with no pause in effect.
    (instance as any).executionWorkspace.worktree = { mode: "named" };
    (instance as any).activeWorktree = { mode: "named" };

    await (instance as any).startWorkflowExecution(
      integration,
      "",
      "workflow.ctrlyoke.json"
    );

    assert.strictEqual(
      integration.gracefulCloseCalls,
      1,
      "a worktree-rooted PTY must be gracefully closed, not merely detached, " +
        "before its execution lease can be released"
    );
    assert.strictEqual(integration.disposeCalls, 1);
    assert.ok(
      integration.wasGracefullyClosedBeforeDispose(),
      "closeTerminalGracefully must run before dispose so no orphaned " +
        "process survives worktree settlement"
    );
  });

  test("retains the PTY and worktree reservation when a named-worktree run settles with an injectable PTY", async () => {
    class InjectableIntegration extends MockHarnessIntegration {
      disposeCalls = 0;
      gracefulCloseCalls = 0;
      private ptyEndedCallback: (() => void) | undefined;

      override canReuseForInject(): boolean {
        return true;
      }

      override closeTerminalGracefully(): void {
        this.gracefulCloseCalls += 1;
      }

      override dispose(): void {
        this.disposeCalls += 1;
        super.dispose();
      }

      override onPtySessionEnded(callback: () => void): void {
        this.ptyEndedCallback = callback;
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
    const integration = new InjectableIntegration(undefined, false);
    let leaseReleaseCalls = 0;
    let runnerLockReleaseCalls = 0;
    let runtimeTrustReleaseCalls = 0;
    (instance as any).executionIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.CLAUDE_CLI })
      ),
      integration
    );
    (instance as any).workflowExecutor.execute = async () => {};
    // Named worktrees never auto-commit, so a run finishing (not pausing)
    // must not tear down a still-injectable PTY the same way managed mode
    // does.
    (instance as any).executionWorkspace.worktree = { mode: "named" };
    (instance as any).activeWorktree = {
      mode: "named",
      runtimeTrust: {
        release: () => {
          runtimeTrustReleaseCalls += 1;
        },
      },
    };
    (instance as any).executionLease = {
      updateHeartbeat: async () => undefined,
      release: async () => {
        leaseReleaseCalls += 1;
      },
    };
    (instance as any).releaseRunnerLock = async () => {
      runnerLockReleaseCalls += 1;
    };

    await (instance as any).startWorkflowExecution(
      integration,
      "",
      "workflow.ctrlyoke.json"
    );

    assert.strictEqual(
      integration.disposeCalls,
      0,
      "an injectable PTY on a named worktree must survive run settlement"
    );
    assert.strictEqual(integration.gracefulCloseCalls, 0);
    assert.strictEqual(
      (instance as any).liveInjectIntegrations.get(
        integrationCacheKey(
          createResolvedProperties({ harness: HARNESS_IDS.CLAUDE_CLI })
        )
      ),
      integration,
      "the integration must be parked so the next run can reuse it via inject"
    );
    assert.ok(
      (instance as any).activeWorktree,
      "the named worktree reservation must stay live while its PTY is retained"
    );

    integration.firePtyEnded();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(integration.disposeCalls, 1);
    assert.strictEqual(runtimeTrustReleaseCalls, 1);
    assert.strictEqual(leaseReleaseCalls, 1);
    assert.strictEqual(runnerLockReleaseCalls, 1);
    assert.strictEqual((instance as any).activeWorktree, undefined);
    assert.strictEqual((instance as any).executionLease, undefined);
    assert.strictEqual((instance as any).heartbeatInterval, undefined);
  });

  test("does not let a non-reusable integration strand a named-worktree lease", async () => {
    class DisposableIntegration extends MockHarnessIntegration {
      disposeCalls = 0;

      override dispose(): void {
        this.disposeCalls += 1;
        super.dispose();
      }
    }

    class InjectableIntegration extends MockHarnessIntegration {
      private ptyEndedCallback: (() => void) | undefined;

      override canReuseForInject(): boolean {
        return true;
      }

      override onPtySessionEnded(callback: () => void): void {
        this.ptyEndedCallback = callback;
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
    const injectable = new InjectableIntegration(undefined, false);
    const ordinary = new DisposableIntegration(undefined, false);
    let leaseReleaseCalls = 0;
    let runnerLockReleaseCalls = 0;
    (instance as any).executionIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.CLAUDE_CLI })
      ),
      injectable
    );
    (instance as any).executionIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.CODEX_CLI })
      ),
      ordinary
    );
    (instance as any).workflowExecutor.execute = async () => {};
    (instance as any).executionWorkspace.worktree = { mode: "named" };
    (instance as any).activeWorktree = {
      mode: "named",
      runtimeTrust: { release: () => {} },
    };
    (instance as any).executionLease = {
      updateHeartbeat: async () => undefined,
      release: async () => {
        leaseReleaseCalls += 1;
      },
    };
    (instance as any).releaseRunnerLock = async () => {
      runnerLockReleaseCalls += 1;
    };

    await (instance as any).startWorkflowExecution(
      injectable,
      "",
      "workflow.ctrlyoke.json"
    );

    assert.strictEqual(
      ordinary.disposeCalls,
      1,
      "a non-reusable integration must be disposed at worktree settlement"
    );
    assert.strictEqual(
      (instance as any).liveInjectIntegrations.size,
      1,
      "only the reusable PTY may remain parked"
    );

    injectable.firePtyEnded();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(leaseReleaseCalls, 1);
    assert.strictEqual(runnerLockReleaseCalls, 1);
    assert.strictEqual((instance as any).activeWorktree, undefined);
    assert.strictEqual((instance as any).executionLease, undefined);
  });

  test("closes retained terminals when a different run starts", async () => {
    class RetainedTerminalIntegration extends MockHarnessIntegration {
      closeCalls = 0;
      gracefulCloseCalls = 0;
      disposeCalls = 0;

      override closeTerminal(): void {
        this.closeCalls += 1;
      }

      override closeTerminalGracefully(): void {
        this.gracefulCloseCalls += 1;
      }

      override dispose(): void {
        this.disposeCalls += 1;
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
    const disposedPrevious = new RetainedTerminalIntegration(undefined, false);
    const livePrevious = new RetainedTerminalIntegration(undefined, false);
    (instance as any).lastRunIntegrations = [disposedPrevious];
    (instance as any).liveInjectIntegrations.set(
      integrationCacheKey(
        createResolvedProperties({ harness: HARNESS_IDS.OPENCODE_CLI })
      ),
      livePrevious
    );

    await instance.closeRetainedTerminalsForFreshRun();

    assert.strictEqual(disposedPrevious.closeCalls, 1);
    assert.strictEqual(livePrevious.gracefulCloseCalls, 1);
    assert.strictEqual(livePrevious.disposeCalls, 1);
    assert.strictEqual((instance as any).lastRunIntegrations.length, 0);
    assert.strictEqual((instance as any).liveInjectIntegrations.size, 0);
  });
});

suite("WorkflowInstance execution-lease conflict messaging", () => {
  test("names the worktree and the owning workflow instead of raw lease internals", async () => {
    const stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lease-conflict-")
    );
    try {
      const owningLineage = await new WorkflowLineageRepository().createLineage(
        stateRoot,
        "release-notes",
        "Draft release notes"
      );

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
      (instance as any).worktreeResolution = {
        origin: "authored",
        config: { mode: "named", branch: "small-feature" },
      };

      const conflictError = new ExecutionLeaseConflictError(
        {
          lease: {
            ownerToken: "owner-token",
            mode: "exclusive-worktree",
            pid: 4242,
            runner: "vscode",
            instanceId: "owner-instance",
            stateRoot,
            executionRoot: path.join(stateRoot, "worktree"),
            workflowKey: owningLineage.workflowKey,
            runRef: "run-2026-08-16T12-00-00-000Z" as any,
            startedAt: Date.now() - 90_000,
            lastHeartbeat: Date.now(),
          },
          ageMs: 90_000,
          retryAction: "retry",
        },
        async () => {
          throw new Error("retry not exercised in this test");
        }
      );

      const message = await (instance as any).describeLeaseConflict(
        conflictError
      );

      assert.ok(
        message.includes("Draft release notes"),
        `expected the owning workflow's display name in: ${message}`
      );
      assert.ok(
        message.includes("small-feature"),
        `expected the named worktree branch in: ${message}`
      );
      assert.ok(
        !message.includes(owningLineage.workflowKey),
        "the friendly name should replace the raw workflowKey, not sit alongside it"
      );
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("falls back to the workflow key when the owning lineage's descriptor can't be read", async () => {
    const stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lease-conflict-fallback-")
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
        process.cwd()
      );
      (instance as any).worktreeResolution = { origin: "default" };

      const conflictError = new ExecutionLeaseConflictError(
        {
          lease: {
            ownerToken: "owner-token",
            mode: "exclusive-worktree",
            pid: 4242,
            runner: "cli",
            instanceId: "owner-instance",
            stateRoot,
            executionRoot: path.join(stateRoot, "worktree"),
            workflowKey: "missing-lineage-key" as any,
            runRef: "run-2026-08-16T12-00-00-000Z" as any,
            startedAt: Date.now() - 5_000,
            lastHeartbeat: Date.now(),
          },
          ageMs: 5_000,
          retryAction: "retry",
        },
        async () => {
          throw new Error("retry not exercised in this test");
        }
      );

      const message = await (instance as any).describeLeaseConflict(
        conflictError
      );

      assert.ok(
        message.includes("missing-lineage-key"),
        `expected the raw workflow key as a fallback in: ${message}`
      );
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });
});

suite("WorkflowInstance executeSeededRun", () => {
  test("executes an already-seeded run without re-promoting or restarting, and initializes its own timeline", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-seeded-run-")
    );
    let instance: WorkflowInstance | undefined;

    try {
      const platform = new MockPlatform();
      let executionStartedArgs: any[] | undefined;
      const dashboardSink: any = {
        updateFileSelected: async () => {},
        updateSessionRestored: async () => {},
        updateExecutionStarted: (...args: any[]) => {
          executionStartedArgs = args;
        },
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
        notifyPromptsReordered: () => {},
      };
      instance = new WorkflowInstance(
        platform,
        dashboardSink,
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
      let prepared = false;
      await instance.executeSeededRun(
        seeded,
        workflowKey,
        undefined,
        async () => {
          prepared = true;
        }
      );

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
      assert.strictEqual(prepared, true);
      assert.deepStrictEqual(
        executionStartedArgs?.slice(1, 3),
        ["workflow.ctrlyoke.json", 1],
        "a seeded run must be announced as a fresh start, not a continuation"
      );
      assert.strictEqual(
        executionStartedArgs?.[3],
        undefined,
        "fresh execution must not carry the continuation flag"
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

suite("WorkflowInstance run-metadata bookkeeping", () => {
  test("getNextWorktreeSetupAttemptIndex scans the timeline for the phase's max attempt index", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-worktree-attempt-")
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
        "wf-worktree-attempt"
      );

      assert.strictEqual(
        await (instance as any).getNextWorktreeSetupAttemptIndex(
          historyInit.filePath
        ),
        0,
        "an empty timeline has no prior worktree setup attempts"
      );

      const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target,
        [
          {
            prompt: "setup",
            response: "ok",
            elapsed: 1,
            isStreaming: false,
            timestampMs: 100,
            attemptIndex: 0,
          } as any,
        ],
        undefined,
        EXECUTION_PHASES.WORKTREE_SETUP
      );
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target,
        [
          {
            prompt: "setup retry",
            response: "ok",
            elapsed: 1,
            isStreaming: false,
            timestampMs: 200,
            attemptIndex: 1,
          } as any,
        ],
        undefined,
        EXECUTION_PHASES.WORKTREE_SETUP
      );
      // A later attempt outside WORKTREE_SETUP must not affect the phase-scoped count.
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target,
        [
          {
            prompt: "regular step",
            response: "ok",
            elapsed: 1,
            isStreaming: false,
            timestampMs: 300,
            attemptIndex: 5,
          } as any,
        ]
      );

      assert.strictEqual(
        await (instance as any).getNextWorktreeSetupAttemptIndex(
          historyInit.filePath
        ),
        2
      );
    } finally {
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("computeTargetRunIndices resolves each rerun target's next run index from the timeline", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-rerun-index-")
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
        "wf-rerun-index"
      );

      const target0 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
      const target1 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target0,
        [
          {
            prompt: "p0",
            response: "r0",
            elapsed: 1,
            isStreaming: false,
            timestampMs: 1,
            attemptIndex: 0,
            runIndex: 0,
          } as any,
        ]
      );
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target0,
        [
          {
            prompt: "p0 rerun",
            response: "r0b",
            elapsed: 1,
            isStreaming: false,
            timestampMs: 2,
            attemptIndex: 0,
            runIndex: 1,
          } as any,
        ]
      );
      await instance.outputHistoryManager.saveExecutionOutput(
        historyInit.filePath,
        target1,
        [
          {
            prompt: "p1",
            response: "r1",
            elapsed: 1,
            isStreaming: false,
            timestampMs: 3,
            attemptIndex: 0,
            runIndex: 0,
          } as any,
        ]
      );

      // currentIndex 0 with two pending steps makes both queue:0 and queue:1
      // rerun targets, and no final step has run yet.
      instance.promptQueue.loadPrompts({
        steps: [{ prompt: "p0" }, { prompt: "p1" }],
      });

      const nextRunIndices = await (instance as any).computeTargetRunIndices(
        historyInit.filePath,
        true
      );

      assert.strictEqual(nextRunIndices.get("queue:0"), 2);
      assert.strictEqual(nextRunIndices.get("queue:1"), 1);
    } finally {
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("computeTargetRunIndices returns an empty map when the run is not a continuation", async () => {
    const tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-rerun-index-noncontinuation-")
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
        "wf-rerun-index-noncontinuation"
      );
      instance.promptQueue.loadPrompts({
        steps: [{ prompt: "p0" }],
      });

      const nextRunIndices = await (instance as any).computeTargetRunIndices(
        historyInit.filePath,
        false
      );

      assert.strictEqual(nextRunIndices.size, 0);
    } finally {
      await instance?.outputHistoryManager.flushPendingIndexRefresh();
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });
});
