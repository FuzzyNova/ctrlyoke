import { suite, test } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ExternalRunWatchSession } from "../../core/orchestration/ExternalRunWatchSession";
import {
  ExternalRunWatchCoordinator,
  type ExternalRunWatchBroadcast,
  type ExternalRunWatchHost,
  type ExternalRunWatchInstance,
  type ExternalRunWatchLineageRepository,
} from "../../core/orchestration/ExternalRunWatchCoordinator";
import type { FileWatcher, FileWatcherFactory } from "../../core/HostPorts";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import type {
  QueueState,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowSummary,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  RUNNER_IDS,
  STEP_STATUS,
  type ExecutionState,
} from "../../types/DashboardConstants";
import type { IDashboardSink } from "../../types/IDashboardSink";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";

class TestLineageRepository implements ExternalRunWatchLineageRepository {
  constructor(private readonly keys: WorkflowKey[] = []) {}

  listLineageKeys(): Promise<WorkflowKey[]> {
    return Promise.resolve(this.keys);
  }

  readWorkflowDisplayName(): Promise<string> {
    return Promise.resolve("fixture");
  }

  pruneStaleStagingDirs(): Promise<void> {
    return Promise.resolve();
  }
}

class TestFileWatcher implements FileWatcher {
  onDidCreate(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onDidChange(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onDidDelete(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  dispose(): void {}
}

class TestFileWatcherFactory implements FileWatcherFactory {
  create(): FileWatcher {
    return new TestFileWatcher();
  }
}

class TestBroadcast implements ExternalRunWatchBroadcast {
  readonly statusCalls: Array<{
    index: number;
    state: string;
    workflowId?: string;
  }> = [];
  readonly restoredCalls: Array<unknown[]> = [];
  readonly updatedSummaries: WorkflowSummary[] = [];
  dismissed = false;

  notifyWorkflowAdded(): void {}
  notifyWorkflowDismissed(): void {
    this.dismissed = true;
  }
  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    this.updatedSummaries.push(summary);
  }
  notifyCliWatchOutput(): void {}
  notifyCliPromptsExtended(): void {}
  updateStepStatus(
    index: number,
    status: { state: string },
    _details?: Record<string, unknown>,
    workflowId?: string
  ): void {
    this.statusCalls.push({ index, state: status.state, workflowId });
  }
  updateSessionRestored(
    ...args: Parameters<IDashboardSink["updateSessionRestored"]>
  ): Promise<void> {
    this.restoredCalls.push(args);
    return Promise.resolve();
  }
}

class TestHost implements ExternalRunWatchHost {
  readonly broadcast = new TestBroadcast();
  readonly lineageRepository: ExternalRunWatchLineageRepository;
  readonly fileWatcherFactory = new TestFileWatcherFactory();
  readonly instances: ExternalRunWatchInstance[] = [];
  readonly retired: string[] = [];
  readonly outputHistoryManager: OutputHistoryManager;
  readonly runnerHostIdentity: RunnerHostIdentity;
  constructor(
    readonly workspaceRoot: string,
    lineageKeys: WorkflowKey[] = [],
    runnerHostIdentity: RunnerHostIdentity = {
      runner: RUNNER_IDS.VSCODE,
      hostInstanceId: "observer-host",
      pid: 999999,
    }
  ) {
    this.lineageRepository = new TestLineageRepository(lineageKeys);
    this.outputHistoryManager = new OutputHistoryManager(workspaceRoot);
    this.runnerHostIdentity = runnerHostIdentity;
  }

  findInstanceForWorkingFile(
    workingFilePath: string
  ): ExternalRunWatchInstance[] {
    return this.instances.filter(
      (instance) =>
        instance.getSummary().workingFilePath?.replace(/\\/g, "/") ===
        workingFilePath.replace(/\\/g, "/")
    );
  }

  retireWorkflow(workflowId: string): void {
    this.retired.push(workflowId);
    const index = this.instances.findIndex(
      (instance) => instance.id === workflowId
    );
    if (index !== -1) this.instances.splice(index, 1);
  }

  saveState(): Promise<void> {
    return Promise.resolve();
  }

  getOutputHistoryManager(): OutputHistoryManager {
    return this.outputHistoryManager;
  }
}

function createCoordinator(
  workspace: string,
  runnerHostIdentity?: RunnerHostIdentity
): { coordinator: ExternalRunWatchCoordinator; host: TestHost } {
  const host = new TestHost(workspace, [], runnerHostIdentity);
  return { coordinator: new ExternalRunWatchCoordinator(host), host };
}

async function createLiveRun(
  workspace: string,
  runner: typeof RUNNER_IDS.CLI | typeof RUNNER_IDS.VSCODE,
  name: string,
  executionState: ExecutionState = EXECUTION_STATES.RUNNING,
  hostInstanceId = `${name}-host`
): Promise<{ workflowKey: WorkflowKey; filePath: string }> {
  const workflowKey = `${name}-workflow` as WorkflowKey;
  const runRef = "run-2026-08-25T00-00-00-000Z" as never;
  const filePath = WorkflowPaths.runFilePath(workspace, workflowKey, runRef);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      workflowName: name,
      startedAt: Date.now(),
      steps: [{ prompt: "live" }],
      _runtime: { currentIndex: 0, executionState },
    }),
    "utf8"
  );
  await fs.writeFile(
    WorkflowLockManager.getLockPath(workspace, workflowKey),
    JSON.stringify({
      schemaVersion: 2,
      workflowKey,
      runRef,
      runner,
      pid: process.pid,
      ownerToken: `${name}-owner`,
      hostInstanceId,
      executionInstanceId: `${name}-instance`,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }),
    "utf8"
  );
  return { workflowKey, filePath };
}

function fakeInstance(
  id: string,
  workingFilePath: string,
  executionState: string
): ExternalRunWatchInstance {
  return {
    id,
    getSummary: () =>
      ({
        id,
        workingFilePath,
        executionState,
      }) as WorkflowSummary,
    getQueueState: () => ({ status: executionState }) as QueueState,
  };
}

suite("ExternalRunWatchCoordinator dashboard state", () => {
  test("reports final-step state in live and finished external summaries", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordinator-final-step-")
    );
    const originalStart = ExternalRunWatchSession.prototype.start;
    ExternalRunWatchSession.prototype.start = async () => undefined;
    try {
      const run = await createLiveRun(
        workspace,
        RUNNER_IDS.CLI,
        "external-final-step"
      );
      const liveWorkingFile = {
        workflowName: "external-final-step",
        startedAt: Date.now(),
        finalStep: { prompt: "final" },
        steps: [{ prompt: "queue" }],
        _runtime: {
          currentIndex: 1,
          executionState: EXECUTION_STATES.RUNNING,
          finalStep: {
            phase: FINAL_STEP_PHASES.FINAL_STEP,
            loopCount: 0,
            status: STEP_STATUS.RUNNING,
          },
        },
      };
      await fs.writeFile(run.filePath, JSON.stringify(liveWorkingFile), "utf8");

      const { coordinator, host } = createCoordinator(workspace);
      assert.strictEqual(
        await coordinator.startExternalRunWatchSessionIfExternal(
          run.filePath,
          workspace
        ),
        true
      );
      const liveSummary = coordinator.getEntry(run.workflowKey)?.summary;
      assert.strictEqual(liveSummary?.hasFinalStep, true);
      assert.strictEqual(liveSummary?.finalStepRunning, true);

      await fs.writeFile(
        run.filePath,
        JSON.stringify({
          ...liveWorkingFile,
          _runtime: {
            ...liveWorkingFile._runtime,
            executionState: EXECUTION_STATES.COMPLETED,
          },
        }),
        "utf8"
      );
      coordinator.handleExternalRunFinished(
        run.workflowKey,
        run.filePath,
        "lock-deleted"
      );
      for (
        let i = 0;
        i < 100 && host.broadcast.updatedSummaries.length === 0;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const finishedSummary = host.broadcast.updatedSummaries.at(-1);
      assert.strictEqual(finishedSummary?.hasFinalStep, true);
      assert.strictEqual(finishedSummary?.finalStepRunning, false);
    } finally {
      ExternalRunWatchSession.prototype.start = originalStart;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("omits the definition revision for external replays", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordinator-revision-")
    );
    try {
      const workingFilePath = path.join(workspace, "workflow.json");
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          workflowName: "external workflow",
          startedAt: 0,
          definitionRevision: 11,
          steps: [{ prompt: "step" }],
        })
      );
      const { coordinator, host } = createCoordinator(workspace);
      await coordinator.sendExternalRunFullStateToDashboard("external-run", {
        session: { getActiveHistoryFilePath: () => undefined } as never,
        summary: {
          workingFilePath,
          workflowName: "external workflow",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
        } as WorkflowSummary,
        lastStepStatuses: [],
      });
      assert.strictEqual(host.broadcast.restoredCalls[0][12], undefined);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("derives step results from each step's runtime status", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordinator-results-")
    );
    try {
      const workingFilePath = path.join(workspace, "workflow.json");
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          workflowName: "error showcase",
          startedAt: 0,
          _runtime: { currentIndex: 2, executionState: EXECUTION_STATES.ERROR },
          steps: [
            {
              _runtime: {
                completedAt: 1,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {
              _runtime: { completedAt: 2, terminalStatus: STEP_STATUS.FAILED },
            },
            { prompt: "never executes" },
          ],
        })
      );
      const { coordinator, host } = createCoordinator(workspace);
      await coordinator.sendExternalRunFullStateToDashboard("external-run", {
        session: { getActiveHistoryFilePath: () => undefined } as never,
        summary: {
          workingFilePath,
          workflowName: "error showcase",
          executionState: EXECUTION_STATES.ERROR,
          currentStep: 2,
        } as WorkflowSummary,
        lastStepStatuses: [],
      });
      const results = host.broadcast.restoredCalls[0][2] as Array<{
        status: string;
      }>;
      assert.deepStrictEqual(
        results.map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.FAILED, STEP_STATUS.PENDING]
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("pushes only changed per-step statuses", () => {
    const { coordinator, host } = createCoordinator(os.tmpdir());
    const entry = {
      lastStepStatuses: [
        STEP_STATUS.COMPLETED,
        STEP_STATUS.RUNNING,
        STEP_STATUS.PENDING,
        STEP_STATUS.PENDING,
        STEP_STATUS.PENDING,
      ],
    };
    const steps = [
      { _runtime: { completedAt: 1, terminalStatus: STEP_STATUS.COMPLETED } },
      { _runtime: { completedAt: 2, terminalStatus: STEP_STATUS.COMPLETED } },
      { _runtime: { completedAt: 3, terminalStatus: STEP_STATUS.COMPLETED } },
      { _runtime: { completedAt: 4, terminalStatus: STEP_STATUS.FAILED } },
      {},
    ];
    coordinator.broadcastExternalRunStepStatuses("external-run", entry, steps, {
      currentStep: 4,
      executionState: EXECUTION_STATES.ERROR,
    } as WorkflowSummary);
    assert.deepStrictEqual(host.broadcast.statusCalls, [
      { index: 1, state: STEP_STATUS.COMPLETED, workflowId: "external-run" },
      { index: 2, state: STEP_STATUS.COMPLETED, workflowId: "external-run" },
      { index: 3, state: STEP_STATUS.FAILED, workflowId: "external-run" },
    ]);
    host.broadcast.statusCalls.length = 0;
    coordinator.broadcastExternalRunStepStatuses("external-run", entry, steps, {
      currentStep: 4,
      executionState: EXECUTION_STATES.ERROR,
    } as WorkflowSummary);
    assert.deepStrictEqual(host.broadcast.statusCalls, []);
  });

  test("sends the final step layout when a watched run finishes", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordinator-finished-")
    );
    try {
      const workingFilePath = path.join(workspace, "workflow.json");
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          _runtime: { currentIndex: 4, executionState: EXECUTION_STATES.ERROR },
          steps: [
            {
              _runtime: {
                completedAt: 1,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {
              _runtime: {
                completedAt: 2,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {
              _runtime: {
                completedAt: 3,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {
              _runtime: { completedAt: 4, terminalStatus: STEP_STATUS.FAILED },
            },
            {},
          ],
        })
      );
      const run = await createLiveRun(
        workspace,
        RUNNER_IDS.CLI,
        "external-run"
      );
      await fs.writeFile(
        run.filePath,
        JSON.stringify({
          workflowName: "external-run",
          startedAt: Date.now(),
          _runtime: {
            currentIndex: 1,
            executionState: EXECUTION_STATES.RUNNING,
          },
          steps: [
            {
              _runtime: {
                completedAt: 1,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {},
            {},
            {},
            {},
          ],
        })
      );
      const { coordinator, host } = createCoordinator(workspace);
      assert.strictEqual(
        await coordinator.startExternalRunWatchSessionIfExternal(
          run.filePath,
          workspace
        ),
        true
      );
      await fs.writeFile(
        run.filePath,
        JSON.stringify({
          workflowName: "external-run",
          startedAt: Date.now(),
          _runtime: { currentIndex: 4, executionState: EXECUTION_STATES.ERROR },
          steps: [
            {
              _runtime: {
                completedAt: 1,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {
              _runtime: {
                completedAt: 2,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {
              _runtime: {
                completedAt: 3,
                terminalStatus: STEP_STATUS.COMPLETED,
              },
            },
            {
              _runtime: { completedAt: 4, terminalStatus: STEP_STATUS.FAILED },
            },
            {},
          ],
        })
      );
      coordinator.handleExternalRunFinished(
        run.workflowKey,
        run.filePath,
        "lock-deleted"
      );
      for (let i = 0; i < 100 && !host.broadcast.dismissed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(host.broadcast.dismissed);
      assert.deepStrictEqual(
        host.broadcast.statusCalls.map(({ index, state }) => ({
          index,
          state,
        })),
        [
          { index: 1, state: STEP_STATUS.COMPLETED },
          { index: 2, state: STEP_STATUS.COMPLETED },
          { index: 3, state: STEP_STATUS.FAILED },
        ]
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("ExternalRunWatchCoordinator ownership", () => {
  test("watches a live sibling lock and does not watch a self-owned lock", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordinator-ownership-")
    );
    const originalStart = ExternalRunWatchSession.prototype.start;
    ExternalRunWatchSession.prototype.start = async () => undefined;
    try {
      const sibling = await createLiveRun(
        workspace,
        RUNNER_IDS.VSCODE,
        "sibling"
      );
      const { coordinator } = createCoordinator(workspace);
      assert.strictEqual(
        await coordinator.ensureExternalRunWatchSession(sibling.filePath),
        true
      );
      assert.ok(coordinator.getEntry(sibling.workflowKey));
      coordinator.dispose();

      const self = await createLiveRun(
        workspace,
        RUNNER_IDS.VSCODE,
        "self",
        EXECUTION_STATES.RUNNING,
        "observer-host"
      );
      const selfHost = new TestHost(workspace, [], {
        runner: RUNNER_IDS.VSCODE,
        hostInstanceId: "observer-host",
        pid: process.pid,
      });
      const selfCoordinator = new ExternalRunWatchCoordinator(selfHost);
      assert.strictEqual(
        await selfCoordinator.ensureExternalRunWatchSession(self.filePath),
        false
      );
      assert.strictEqual(selfCoordinator.getEntry(self.workflowKey), undefined);
    } finally {
      ExternalRunWatchSession.prototype.start = originalStart;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("preserves the active local execution and retires only a paused one", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordinator-local-")
    );
    const originalStart = ExternalRunWatchSession.prototype.start;
    ExternalRunWatchSession.prototype.start = async () => undefined;
    try {
      const run = await createLiveRun(workspace, RUNNER_IDS.CLI, "takeover");
      const { coordinator, host } = createCoordinator(workspace);
      host.instances.push(
        fakeInstance("running", run.filePath, EXECUTION_STATES.RUNNING)
      );
      assert.strictEqual(
        await coordinator.startExternalRunWatchSessionIfExternal(
          run.filePath,
          workspace
        ),
        false
      );
      assert.deepStrictEqual(host.retired, []);

      host.instances.length = 0;
      host.instances.push(
        fakeInstance("paused", run.filePath, EXECUTION_STATES.PAUSED)
      );
      assert.strictEqual(
        await coordinator.startExternalRunWatchSessionIfExternal(
          run.filePath,
          workspace
        ),
        true
      );
      assert.deepStrictEqual(host.retired, ["paused"]);
      assert.ok(coordinator.getEntry(run.workflowKey));
    } finally {
      ExternalRunWatchSession.prototype.start = originalStart;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not watch a terminal working file with a retained lock", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-coordinator-terminal-")
    );
    const originalStart = ExternalRunWatchSession.prototype.start;
    ExternalRunWatchSession.prototype.start = async () => undefined;
    try {
      const run = await createLiveRun(
        workspace,
        RUNNER_IDS.VSCODE,
        "completed",
        EXECUTION_STATES.COMPLETED
      );
      const { coordinator } = createCoordinator(workspace);
      assert.strictEqual(
        await coordinator.ensureExternalRunWatchSession(run.filePath),
        false
      );
      assert.strictEqual(coordinator.getEntry(run.workflowKey), undefined);
    } finally {
      ExternalRunWatchSession.prototype.start = originalStart;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
