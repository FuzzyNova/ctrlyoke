import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { EXECUTION_STATES, RUNNER_IDS } from "../../types/DashboardConstants";
import type {
  QueueState,
  RunnerHostIdentity,
  WorkflowRunnerLock,
} from "../../types/CtrlYokeTypes";
import {
  RunnerLockCoordinator,
  type RunnerLockCoordinatorPort,
} from "../../core/orchestration/RunnerLockCoordinator";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { readWorkflowLock } from "../../utils/WorkflowLockInspector";

class TestRunnerLockHost implements RunnerLockCoordinatorPort {
  readonly id = "test-instance";
  readonly runnerHostIdentity: RunnerHostIdentity = {
    runner: RUNNER_IDS.CLI,
    hostInstanceId: "test-host",
    pid: process.pid,
  };
  readonly queueState: QueueState;
  stopCalls = 0;

  constructor(
    private readonly workspaceRoot: string,
    workflowKey: QueueState["workflowKey"],
    runRef: QueueState["runRef"]
  ) {
    this.queueState = {
      status: EXECUTION_STATES.STOPPED,
      stopped: true,
      totalPausedDuration: 0,
      currentIndex: 0,
      steps: [],
      parallelGroups: [],
      results: [],
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      definitionRevision: 0,
      workflowKey,
      runRef,
    };
  }

  getQueueState(): QueueState {
    return this.queueState;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  getExecutionLease(): undefined {
    return undefined;
  }
}

suite("RunnerLockCoordinator", () => {
  test("reclaims a stale runner.json instead of reporting a live owner", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-runner-lock-coordinator-")
    );
    try {
      const workflowKey = await WorkflowPaths.allocateWorkflowKey(
        workspaceRoot,
        "stale-lock"
      );
      const runRef = WorkflowPaths.formatRunRef(Date.now());
      const host = new TestRunnerLockHost(workspaceRoot, workflowKey, runRef);
      const staleLock: WorkflowRunnerLock = {
        schemaVersion: 2,
        workflowKey,
        runRef,
        runner: RUNNER_IDS.CLI,
        pid: 999999,
        hostInstanceId: "dead-host",
        executionInstanceId: "dead-instance",
        ownerToken: "stale-owner-token",
        startedAt: Date.now() - 60_000,
        lastHeartbeat: Date.now() - 60_000,
      };
      const lockPath = WorkflowPaths.runnerLockPath(workspaceRoot, workflowKey);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify(staleLock), "utf8");

      const coordinator = new RunnerLockCoordinator(host);
      await coordinator.ensureRunnerLock("working-file.json");

      assert.strictEqual(coordinator.ownsLock(), true);
      const acquired = await readWorkflowLock(workspaceRoot, workflowKey);
      assert.ok(acquired);
      assert.notStrictEqual(acquired.ownerToken, staleLock.ownerToken);
      assert.strictEqual(
        acquired.hostInstanceId,
        host.runnerHostIdentity.hostInstanceId
      );

      await coordinator.releaseRunnerLock();
      assert.strictEqual(coordinator.ownsLock(), false);
      assert.strictEqual(
        await readWorkflowLock(workspaceRoot, workflowKey),
        null
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
