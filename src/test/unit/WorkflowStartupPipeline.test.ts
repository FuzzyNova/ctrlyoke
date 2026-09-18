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
import type { PromptFile, QueueState } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import type { UserFeedbackSink } from "../../core/UserFeedbackSink";
import type { WorkspaceWorktreeResolution } from "../../utils/WorktreeResolution";
import type { WorktreeInfo } from "../../core/orchestration/WorktreeManager";
import type { ExecutionLeaseHandle } from "../../core/orchestration/ExecutionRootLeaseManager";
import type { DefinitionRevisionContext } from "../../core/orchestration/OutputHistoryManager";

class TestStatus implements WorkflowStartupStatusPort {
  resetCalls = 0;
  reportCalls = 0;

  resetDedupeState(): void {
    this.resetCalls += 1;
  }

  report(): void {
    this.reportCalls += 1;
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
  ensureCalls = 0;
  releaseCalls = 0;

  getResolution(): WorkspaceWorktreeResolution {
    return this.resolution;
  }

  setResolution(resolution: WorkspaceWorktreeResolution): void {
    this.resolution = resolution;
  }

  getActiveWorktree(): WorktreeInfo | undefined {
    return undefined;
  }

  clearActiveWorktree(): void {}

  getExecutionLease(): ExecutionLeaseHandle | undefined {
    return undefined;
  }

  clearExecutionLease(): void {}

  async ensureRunnerLock(_workingFilePath: string): Promise<void> {
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
    | { filePath: string; promptFile: PromptFile }
    | undefined {
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
  readonly userFeedbackSink: UserFeedbackSink | undefined = undefined;
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
      await pipeline.ensureHarnessReadiness(
        undefined,
        "workflow.prompt.md"
      ),
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
});
