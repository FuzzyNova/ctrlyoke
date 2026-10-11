import * as assert from "assert";
import { suite, test } from "mocha";
import { type HarnessIntegration } from "../../core/HarnessIntegration";
import { PromptQueue } from "../../core/PromptQueue";
import { WorkflowStateMachine } from "../../core/WorkflowStateMachine";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import {
  WorkflowStartupPipeline,
  type WorkflowStartupExecutionPort,
  type WorkflowStartupHistoryPort,
  type WorkflowStartupPipelinePort,
  type WorkflowStartupQueuePort,
  type WorkflowStartupStatusPort,
  type WorkflowStartupWorktreeManagerPort,
  type WorkflowStartupWorktreePort,
} from "../../core/orchestration/WorkflowStartupPipeline";
import { MockHarnessIntegration, MockPlatform } from "../helpers/mockHarness";
import type {
  PromptFile,
  QueueState,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  WORKTREE_MODES,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import type { UserFeedbackSink } from "../../core/UserFeedbackSink";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import type { WorkspaceWorktreeResolution } from "../../utils/WorktreeResolution";
import type { WorktreeInfo } from "../../core/orchestration/WorktreeManager";
import type { ExecutionLeaseHandle } from "../../core/orchestration/ExecutionRootLeaseManager";
import type { DefinitionRevisionContext } from "../../core/orchestration/OutputHistoryManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { WorkflowEventTarget } from "../../core/orchestration/StatusMessageReporter";
import { RecordedTargetFailureError } from "../../core/RecordedTargetFailureError";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "../../types/DashboardConstants";
import type { HarnessUsageSnapshot } from "../../types/UsageTypes";

class TestStatus implements WorkflowStartupStatusPort {
  resetCalls = 0;
  reportCalls = 0;
  readonly reports: Array<{ target: WorkflowEventTarget; message: string }> =
    [];

  resetDedupeState(): void {
    this.resetCalls += 1;
  }

  report(target: WorkflowEventTarget, message: string): void {
    this.reportCalls += 1;
    this.reports.push({ target, message });
  }
}

class TestWorktreeManager implements WorkflowStartupWorktreeManagerPort {
  completeCalls = 0;

  releaseRuntimeTrust(_worktree: WorktreeInfo): void {}

  async completeManagedRun(
    _worktree: WorktreeInfo,
    _options?: Parameters<
      WorkflowStartupWorktreeManagerPort["completeManagedRun"]
    >[1]
  ): Promise<never> {
    this.completeCalls += 1;
    throw new Error("managed worktree settlement is not used in this test");
  }
}

class TestWorktree implements WorkflowStartupWorktreePort {
  resolution: WorkspaceWorktreeResolution = { origin: "default" };
  readonly manager = new TestWorktreeManager();
  activeWorktree: WorktreeInfo | undefined;
  ensureCalls = 0;
  releaseCalls = 0;

  getResolution(): WorkspaceWorktreeResolution {
    return this.resolution;
  }

  setResolution(resolution: WorkspaceWorktreeResolution): void {
    this.resolution = resolution;
  }

  getActiveWorktree(): WorktreeInfo | undefined {
    return this.activeWorktree;
  }

  clearActiveWorktree(): void {
    this.activeWorktree = undefined;
  }

  getExecutionLease(): ExecutionLeaseHandle | undefined {
    return undefined;
  }

  clearExecutionLease(): void {}

  async ensureRunnerLock(_workingFilePath: string | undefined): Promise<void> {
    this.ensureCalls += 1;
  }

  async releaseRunnerLock(): Promise<void> {
    this.releaseCalls += 1;
  }
}

class TestExecution implements WorkflowStartupExecutionPort {
  currentPrompt: { filePath: string; promptFile: PromptFile } | undefined = {
    filePath: "workflow.prompt.md",
    promptFile: { steps: [{ prompt: "one" }] },
  };
  preparedWorktree = "";
  started = false;
  cleared = false;
  readonly integration = new MockHarnessIntegration(undefined, false);

  currentPromptFile():
    { filePath: string; promptFile: PromptFile } | undefined {
    return this.currentPrompt;
  }

  getAuthoritativeExecutionState(): QueueState["status"] {
    return EXECUTION_STATES.IDLE;
  }

  async closeRetainedTerminalsForFreshRun(): Promise<void> {}

  syncCurrentPromptFileFromQueue(): void {}

  setExecutionRunRef(
    _runRef: Parameters<
      NonNullable<WorkflowStartupExecutionPort["setExecutionRunRef"]>
    >[0]
  ): void {}

  clearOutputBuffers(): void {
    this.cleared = true;
  }

  async prepareExecutionWorktree(historyFilePath: string): Promise<void> {
    this.preparedWorktree = historyFilePath;
  }

  createIntegrationForMode(_modeOverride?: HarnessId): HarnessIntegration {
    return this.integration;
  }

  async startWorkflowExecution(
    _integration: HarnessIntegration,
    _historyFilePath: string,
    _workingFilePath: string | undefined,
    _targetRunIndices: Map<string, number>
  ): Promise<void> {
    this.started = true;
  }

  reportMissingAssetWarning(): void {}

  getMissingAssetDirectories(): readonly string[] {
    return [];
  }

  getMissingAssetDedupeKey(missingDirectories: readonly string[]): string {
    return JSON.stringify(missingDirectories);
  }

  getDefinitionRevisionContext(): DefinitionRevisionContext {
    throw new Error("definition context is not used in this test");
  }

  getResolvedHistoryFilePath(): string {
    return "";
  }

  getActiveHistoryFilePath(): string {
    return "";
  }

  setActiveHistoryFilePath(_filePath: string): void {}

  startPending(): boolean {
    return false;
  }
}

class TestPort implements WorkflowStartupPipelinePort {
  readonly id = "pipeline-test";
  readonly platform = new MockPlatform();
  readonly workspaceFolderPath = process.cwd();
  readonly dashboardSink: IDashboardSink | undefined = undefined;
  readonly feedback: Array<{ severity: string; message: string }> = [];
  readonly userFeedbackSink: UserFeedbackSink = {
    notify: ({ severity, message }) => this.feedback.push({ severity, message }),
  };
  usageSnapshots: readonly HarnessUsageSnapshot[] = [];
  readonly getHarnessUsageSnapshots = () => this.usageSnapshots;
  readonly queue: WorkflowStartupQueuePort;
  readonly history: WorkflowStartupHistoryPort;
  readonly execution = new TestExecution();
  readonly worktree = new TestWorktree();
  readonly status = new TestStatus();
  readonly detector = new MockHarnessIntegration(undefined, false);
  diagnostics: CompatibilityDiagnostic[] = [];
  approveCalls = 0;
  failed = false;

  constructor() {
    const queue = new PromptQueue(new WorkflowStateMachine());
    queue.loadPrompts({ steps: [{ prompt: "one" }] });
    this.queue = queue;
    this.history = new OutputHistoryManager(process.cwd());
  }

  getDetectorIntegration(): HarnessIntegration {
    return this.detector;
  }

  async analyzeWorkflowCompatibility(): Promise<CompatibilityDiagnostic[]> {
    return this.diagnostics;
  }

  async approveSecretGrants(): Promise<void> {
    this.approveCalls += 1;
  }

  failRuntime(): void {
    this.failed = true;
  }

  readonly hostCanProvidePty = true;
}

function createPipeline(): {
  pipeline: WorkflowStartupPipeline;
  port: TestPort;
} {
  const port = new TestPort();
  return { pipeline: new WorkflowStartupPipeline(port), port };
}

suite("WorkflowStartupPipeline", () => {
  function freshHighUsageSnapshot(): HarnessUsageSnapshot {
    const now = Date.now();
    return {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      updatedAt: now,
      quota: {
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
        fetchedAt: now,
        staleAfterMs: 60_000,
        windows: [
          {
            id: "five-hour",
            kind: HARNESS_USAGE_WINDOW_KINDS.ROLLING,
            label: "5h",
            percentUsed: 95,
            resetAt: now + 60_000,
            windowMinutes: 300,
            unit: HARNESS_USAGE_UNITS.PERCENT,
            confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
          },
        ],
      },
      observed: {},
    };
  }

  function configureUsageTracking(enabled: boolean): () => void {
    const original = ConfigurationUtils.getHarnessUsageSettings;
    ConfigurationUtils.getHarnessUsageSettings = () => ({
      ...CTRLYOKE_SETTINGS_DEFAULTS.usageTracking,
      enabled,
    });
    return () => {
      ConfigurationUtils.getHarnessUsageSettings = original;
    };
  }

  test("suppresses a fresh near-limit warning when usage tracking is disabled", () => {
    const restoreSettings = configureUsageTracking(false);
    try {
      const { pipeline, port } = createPipeline();
      port.usageSnapshots = [freshHighUsageSnapshot()];

      pipeline.warnBeforeWorkflowStart(
        port.queue.getState(),
        { harness: HARNESS_IDS.CLAUDE_CLI, steps: [{ prompt: "one" }] },
        undefined,
        false
      );

      assert.deepStrictEqual(port.feedback, []);
    } finally {
      restoreSettings();
    }
  });

  test("warns about a fresh near-limit snapshot when usage tracking is enabled", () => {
    const restoreSettings = configureUsageTracking(true);
    try {
      const { pipeline, port } = createPipeline();
      port.usageSnapshots = [freshHighUsageSnapshot()];

      pipeline.warnBeforeWorkflowStart(
        port.queue.getState(),
        { harness: HARNESS_IDS.CLAUDE_CLI, steps: [{ prompt: "one" }] },
        undefined,
        false
      );

      assert.strictEqual(port.feedback.length, 1);
      assert.match(port.feedback[0].message, /Quota warning/);
    } finally {
      restoreSettings();
    }
  });

  test("classifies a fresh start", () => {
    const { pipeline } = createPipeline();
    const result = pipeline.classifyContinuation(false, {
      steps: [{ prompt: "one" }],
    });

    assert.strictEqual(result.isAppendContinuation, false);
    assert.strictEqual(result.isIdleContinuation, false);
  });

  test("runs the secrets preflight after approval", async () => {
    const { pipeline, port } = createPipeline();

    await pipeline.preflightSecrets();

    assert.strictEqual(port.approveCalls, 1);
  });

  test("resolves and stores the worktree selection", async () => {
    const { pipeline, port } = createPipeline();

    await pipeline.resolveWorktree();

    assert.strictEqual(port.worktree.resolution.origin, "default");
  });

  test("allows a compatible workflow through the hard-fail preflight", async () => {
    const { pipeline, port } = createPipeline();

    assert.strictEqual(await pipeline.preflightCompatibility(), true);
    assert.strictEqual(port.failed, false);
  });

  test("accepts a ready harness", async () => {
    const { pipeline } = createPipeline();

    assert.strictEqual(
      await pipeline.ensureHarnessReadiness(undefined, "workflow.prompt.md"),
      true
    );
  });

  test("settles run identity before acquiring the runner lock", async () => {
    const { pipeline, port } = createPipeline();

    await pipeline.promoteRunAndInitializeHistory(
      undefined,
      false,
      true,
      pipeline.classifyContinuation(false, { steps: [{ prompt: "one" }] })
    );

    assert.strictEqual(port.worktree.ensureCalls, 1);
  });

  test("prepares the worktree, creates integration, and dispatches", async () => {
    const { pipeline, port } = createPipeline();
    const classification = pipeline.classifyContinuation(false, {
      steps: [{ prompt: "one" }],
    });
    const startup = await pipeline.promoteRunAndInitializeHistory(
      undefined,
      false,
      true,
      classification
    );

    await pipeline.prepareWorktreeAndDispatch(
      undefined,
      false,
      "workflow.prompt.md",
      startup
    );

    assert.strictEqual(port.execution.preparedWorktree, "");
    assert.strictEqual(port.execution.started, true);
  });

  test("reports the failed step before the queue status advances", () => {
    const { pipeline, port } = createPipeline();
    const state = (port.queue as any).state as QueueState;
    state.results[0].status = STEP_STATUS.RUNNING;
    const reported: number[] = [];
    (port as any).dashboardSink = {
      updateStepStatus: (stepIndex: number) => reported.push(stepIndex),
    };

    const failedStepIndex =
      pipeline.finalizeFailedStepBeforeStatusFlip("startup failed");

    assert.strictEqual(failedStepIndex, 0);
    assert.deepStrictEqual(reported, [0]);
    assert.strictEqual(port.queue.getState().currentIndex, 1);
  });

  // The executor fails the step, advances past it, and only then rethrows.
  // Treating that rethrow as a startup failure used to fail the next,
  // never-started step with the same message, putting error icons on two steps.
  test("leaves the next step alone when the executor already recorded the failure", async () => {
    const { pipeline, port } = createPipeline();
    const steps = [{ prompt: "one" }, { prompt: "two" }];
    (port.queue as PromptQueue).loadPrompts({ steps });
    port.execution.currentPrompt = {
      filePath: "workflow.prompt.md",
      promptFile: { steps },
    };
    const state = (port.queue as any).state as QueueState;
    port.execution.startWorkflowExecution = async () => {
      state.results[0].status = STEP_STATUS.FAILED;
      state.currentIndex = 1;
      throw new RecordedTargetFailureError(
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        new Error('Secret "B" is missing')
      );
    };

    await pipeline.execute();

    assert.strictEqual(port.failed, true);
    assert.strictEqual(state.results[1].status, STEP_STATUS.PENDING);
    assert.strictEqual(port.queue.getState().currentIndex, 1);
    assert.deepStrictEqual(port.status.reports.at(-1), {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      message: 'Execution failed: Secret "B" is missing',
    });
  });

  test("fails and reports the in-flight step for a startup failure", async () => {
    const { pipeline, port } = createPipeline();
    const state = (port.queue as any).state as QueueState;
    port.execution.startWorkflowExecution = async () => {
      state.results[0].status = STEP_STATUS.RUNNING;
      throw new Error("EPERM");
    };

    await pipeline.execute();

    assert.strictEqual(state.results[0].status, STEP_STATUS.FAILED);
    assert.deepStrictEqual(port.status.reports.at(-1), {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      message: "Execution failed: EPERM",
    });
  });

  test("settles a provisioned managed worktree on an early failure", async () => {
    const { pipeline, port } = createPipeline();
    port.worktree.activeWorktree = {
      mode: WORKTREE_MODES.MANAGED,
    } as WorktreeInfo;

    await pipeline.settleProvisionedWorktreeAfterEarlyFailure();

    assert.strictEqual(port.worktree.manager.completeCalls, 1);
    assert.strictEqual(port.worktree.activeWorktree, undefined);
  });

  test("releases the lineage lock on an early failure", async () => {
    const { pipeline, port } = createPipeline();

    await pipeline.releaseLineageLockAfterEarlyFailure();

    assert.strictEqual(port.worktree.releaseCalls, 1);
  });

  test("finalizes a promoted run when history initialization never assigned its path", async () => {
    const { pipeline, port } = createPipeline();
    const workflowKey = "workflow-key" as WorkflowKey;
    const runRef = WorkflowPaths.formatRunRef(Date.now()) as RunRef;
    (port.queue as any).state.workflowKey = workflowKey;
    (pipeline as any).promotedRunRef = runRef;
    const finalizedPaths: string[] = [];
    (port.history as any).finalizeRun = async (filePath: string) => {
      finalizedPaths.push(filePath);
    };

    const finalizedPath = await pipeline.finalizePromotedRunAfterEarlyFailure();

    assert.strictEqual(
      finalizedPath,
      port.history.getHistoryFilePath(workflowKey, runRef)
    );
    assert.deepStrictEqual(finalizedPaths, [finalizedPath]);
  });
});
