import { once } from "events";
import { spawn, type ChildProcess } from "child_process";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import { ExternalExecutionResolver } from "../../core/orchestration/ExternalExecutionResolver";
import { ExternalRunWatchSession } from "../../core/orchestration/ExternalRunWatchSession";
import { RunContinuationService } from "../../core/orchestration/RunContinuationService";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import {
  EXECUTION_STATES,
  PANEL_CLIENT_ID,
  RUNNER_IDS,
  type ExecutionState,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowRunnerLock,
} from "../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { readWorkflowStopRequest } from "../../utils/WorkflowStopRequest";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

const WORKFLOW_KEY = "shared-ownership-2026-08-28" as WorkflowKey;
const RUN_REF = "run-2026-08-28T00-00-00-000Z" as RunRef;

interface HostHarness {
  orchestrator: WorkflowOrchestrator;
  internal: any;
  identity: RunnerHostIdentity;
  resolver: ExternalExecutionResolver;
  decisions: unknown[];
  added: unknown[];
  updated: unknown[];
  dismissed: string[];
  freshLoads: string[];
}

async function startLiveChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  return child;
}

async function stopLiveChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await once(child, "exit");
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for the ownership state to settle");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function seedRun(
  workspaceRoot: string,
  executionState: ExecutionState = EXECUTION_STATES.RUNNING,
  worktree = true
): Promise<string> {
  const descriptorPath = WorkflowPaths.descriptorPath(
    workspaceRoot,
    WORKFLOW_KEY
  );
  const workingFilePath = WorkflowPaths.runFilePath(
    workspaceRoot,
    WORKFLOW_KEY,
    RUN_REF
  );
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
  await fs.writeFile(
    descriptorPath,
    JSON.stringify({
      schemaVersion: 1,
      workflowKey: WORKFLOW_KEY,
      workflowName: "Shared ownership",
      isFavorite: false,
      createdAt: 0,
      lastModifiedAt: 0,
      latestRunRef: RUN_REF,
      nextRunId: 2,
      revision: 1,
    }),
    "utf8"
  );
  await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
  await fs.writeFile(
    workingFilePath,
    JSON.stringify({
      workflowName: "Shared ownership",
      startedAt: Date.now(),
      definitionRevision: 1,
      steps: [{ prompt: "live" }],
      _runtime: {
        currentIndex: executionState === EXECUTION_STATES.COMPLETED ? 1 : 0,
        executionState,
        ...(worktree
          ? {
              worktree: {
                branchName: "ctrlyoke/shared-ownership",
                worktreePath: path.join(workspaceRoot, "named-worktree"),
              },
            }
          : {}),
      },
    }),
    "utf8"
  );
  return workingFilePath;
}

async function writeRunState(
  workingFilePath: string,
  executionState: ExecutionState,
  currentIndex = 0
): Promise<void> {
  const workingFile = JSON.parse(
    await fs.readFile(workingFilePath, "utf8")
  ) as {
    _runtime?: Record<string, unknown>;
  };
  workingFile._runtime = {
    ...workingFile._runtime,
    currentIndex,
    executionState,
  };
  await fs.writeFile(workingFilePath, JSON.stringify(workingFile), "utf8");
}

function createHost(
  workspaceRoot: string,
  identity: RunnerHostIdentity,
  now: () => number,
  isProcessAlive: (pid: number) => boolean
): HostHarness {
  const orchestrator = Object.create(
    WorkflowOrchestrator.prototype
  ) as WorkflowOrchestrator;
  const internal = orchestrator as any;
  const decisions: unknown[] = [];
  const added: unknown[] = [];
  const updated: unknown[] = [];
  const dismissed: string[] = [];
  const freshLoads: string[] = [];
  const resolver = new ExternalExecutionResolver(workspaceRoot, identity, {
    now,
    isProcessAlive,
    onDecision: (decision: unknown) => decisions.push(decision),
  }) as HostHarness["resolver"];

  internal.currentWorkspaceFolder = { uri: { fsPath: workspaceRoot } };
  internal.runnerHostIdentity = identity;
  internal.instances = new Map();
  internal.retiredInstances = new Map();
  internal.externalRunSessions = new Map();
  internal.viewerRegistry = new Map([[PANEL_CLIENT_ID, null]]);
  internal.viewAddressRegistry = new Map();
  internal.viewMessageSinks = new Map();
  internal.polledRunnerJsonMtimes = new Map();
  internal.externallyCreatedInstanceIds = new Set();
  internal.announcedExternalWorkflowIds = new Set();
  internal.lineageExecutionOwners = new Map();
  internal.dashboardBroadcastHub = {
    notifyWorkflowAdded: (summary: unknown) => added.push(summary),
    notifyWorkflowSummaryUpdated: (summary: unknown) => updated.push(summary),
    notifyWorkflowDismissed: (workflowId: string) => dismissed.push(workflowId),
    notifyStartupComplete: () => undefined,
    notifyCliPromptsExtended: () => undefined,
  };
  internal.context = { workspaceState: { update: async () => undefined } };
  internal.setupRunnerJsonCreateWatcher = () => undefined;
  internal.lineageRepository = {
    listLineageKeys: async () => [WORKFLOW_KEY],
    pruneStaleStagingDirs: async () => undefined,
  };
  internal.replayWorkflowStateTo = async () => undefined;
  internal.loadFreshInstanceAndReplay = async (filePath: string) => {
    freshLoads.push(filePath);
  };
  internal.resolveExternalExecutionForPath = (filePath: string) =>
    resolver.resolve(filePath);

  return {
    orchestrator,
    internal,
    identity,
    resolver,
    decisions,
    added,
    updated,
    dismissed,
    freshLoads,
  };
}

function addLocalExecution(host: HostHarness, workingFilePath: string): void {
  let state: ExecutionState = EXECUTION_STATES.RUNNING;
  host.internal.instances.set("host-a-instance", {
    id: "host-a-instance",
    getSummary: () => ({
      workingFilePath,
      executionState: state,
      workflowName: "Shared ownership",
    }),
    getQueueState: () => ({
      workflowKey: WORKFLOW_KEY,
      runRef: RUN_REF,
      status: state,
    }),
    setState: (next: ExecutionState) => {
      state = next;
    },
    dispose: () => undefined,
  });
  host.internal.viewerRegistry.set(PANEL_CLIENT_ID, "host-a-instance");
  host.internal.startupPanelViewedId = "host-a-instance";
}

async function acquireLock(
  workspaceRoot: string,
  pid: number,
  hostInstanceId: string,
  ownerToken: string
): Promise<WorkflowRunnerLock> {
  const lock: WorkflowRunnerLock = {
    schemaVersion: 2,
    workflowKey: WORKFLOW_KEY,
    runRef: RUN_REF,
    runner: RUNNER_IDS.VSCODE,
    pid,
    hostInstanceId,
    executionInstanceId: `${hostInstanceId}-execution`,
    ownerToken,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  await WorkflowLockManager.acquireLock(workspaceRoot, WORKFLOW_KEY, lock);
  return lock;
}

suite("multi-instance runner ownership regression", () => {
  let originalShouldAutoLoad: () => boolean;

  test("keeps owner and sibling behavior separate across every discovery path", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-two-host-ownership-")
    );
    const child = await startLiveChild();
    const now = Date.now();
    const isProcessAlive = (pid: number): boolean => pid === child.pid;
    const workingFilePath = await seedRun(workspaceRoot);
    const lock = await acquireLock(
      workspaceRoot,
      child.pid!,
      "host-a",
      "owner-a"
    );
    const hostA = createHost(
      workspaceRoot,
      { runner: RUNNER_IDS.VSCODE, hostInstanceId: "host-a", pid: child.pid! },
      () => now,
      isProcessAlive
    );
    const hostB = createHost(
      workspaceRoot,
      { runner: RUNNER_IDS.VSCODE, hostInstanceId: "host-b", pid: process.pid },
      () => now,
      isProcessAlive
    );
    addLocalExecution(hostA, workingFilePath);

    const originalStart = ExternalRunWatchSession.prototype.start;
    ExternalRunWatchSession.prototype.start = async () => undefined;
    try {
      // Activation discovery: the owner sees liveness but does not create an
      // external session; the sibling gets a watch pinned to the exact run.
      await hostA.internal.setupCliWatching();
      await hostB.internal.setupCliWatching();
      assert.strictEqual(hostA.internal.externalRunSessions.size, 0);
      const siblingEntry = hostB.internal.externalRunSessions.get(WORKFLOW_KEY);
      assert.ok(siblingEntry);
      assert.deepStrictEqual(siblingEntry.summary.externalOwner, {
        locality: "external",
        runner: RUNNER_IDS.VSCODE,
      });
      assert.deepStrictEqual(siblingEntry.summary.worktree, {
        branchName: "ctrlyoke/shared-ownership",
        worktreePath: path.join(workspaceRoot, "named-worktree"),
      });
      assert.strictEqual(siblingEntry.session.getOwnerToken(), lock.ownerToken);

      // Recent-session loading is still resolver-driven for the sibling. The
      // owner remains bound to its local instance and never gets an external
      // owner summary.
      originalShouldAutoLoad = ConfigurationUtils.shouldAutoLoadRecentSession;
      ConfigurationUtils.shouldAutoLoadRecentSession = () => true;
      hostB.internal.viewerRegistry.set(PANEL_CLIENT_ID, null);
      hostB.internal.startupPanelViewedId = null;
      hostB.internal.workspaceSessionManager = {
        autoLoadRecentSession: async (
          _root: string,
          onLoad: (filePath: string) => Promise<void>
        ) => onLoad(workingFilePath),
      };
      hostB.internal.dashboardReadyAt = now;
      hostB.internal.resolveStartupAutoLoad = () => undefined;
      await hostB.internal.triggerAutoLoad();
      assert.strictEqual(hostB.internal.externalRunSessions.size, 1);
      assert.strictEqual(hostA.added.length, 0);

      // Explicit dashboard and working-file loads reuse the sibling watch;
      // the owner's addressed load remains attached to its local instance.
      await hostB.orchestrator.loadWorkflowForClient(
        workingFilePath,
        () => undefined,
        "browser:sibling",
        { skipReplay: true }
      );
      await hostB.orchestrator.loadWorkingFile(workingFilePath);
      await hostA.orchestrator.loadWorkflowForClient(
        workingFilePath,
        () => undefined,
        "browser:owner",
        { skipReplay: true }
      );
      await hostA.orchestrator.loadWorkingFile(workingFilePath);
      assert.strictEqual(hostA.internal.externalRunSessions.size, 0);
      assert.strictEqual(hostA.added.length, 0);
      assert.strictEqual(hostB.internal.externalRunSessions.size, 1);

      // The sibling cannot continue/mutate the live run directly.
      await assert.rejects(
        RunContinuationService.validateContinuationTarget(
          workspaceRoot,
          WORKFLOW_KEY,
          RUN_REF,
          new WorkflowLineageRepository(),
          "continue",
          false,
          hostB.identity
        ),
        /executing/i
      );

      // The stop sentinel is named by the exact owner token supplied by the
      // sibling's current watch proof.
      const stopRequestPath = WorkflowPaths.stopRequestPath(
        workspaceRoot,
        WORKFLOW_KEY,
        lock.ownerToken
      );
      const stopPromise = hostB.orchestrator.requestVscodeStop(WORKFLOW_KEY);
      await waitFor(() => pathExists(stopRequestPath));
      const stopRequest = await readWorkflowStopRequest(
        workspaceRoot,
        WORKFLOW_KEY,
        lock.ownerToken
      );
      assert.strictEqual(stopRequest?.ownerToken, lock.ownerToken);
      await fs.unlink(stopRequestPath);
      assert.strictEqual(await stopPromise, "picked-up");

      // File-watcher/poll discovery is exercised after replacing the current
      // observation, and still resolves the same owner proof.
      hostB.internal.externalRunSessions.clear();
      await hostB.internal.pollRunnerJsonDiscovery(
        WorkflowPaths.runsRoot(workspaceRoot),
        workspaceRoot
      );
      assert.strictEqual(hostB.internal.externalRunSessions.size, 1);

      // Pause/resume writes are observed by the sibling while the owner keeps
      // the lock and local execution record.
      await writeRunState(workingFilePath, EXECUTION_STATES.PAUSED);
      await (
        siblingEntry.session as unknown as {
          handleWorkingFileChange: () => Promise<void>;
        }
      ).handleWorkingFileChange();
      assert.strictEqual(
        hostB.internal.externalRunSessions.get(WORKFLOW_KEY).summary
          .executionState,
        EXECUTION_STATES.PAUSED
      );
      await writeRunState(workingFilePath, EXECUTION_STATES.RUNNING);
      await (
        hostB.internal.externalRunSessions.get(WORKFLOW_KEY)
          .session as unknown as {
          handleWorkingFileChange: () => Promise<void>;
        }
      ).handleWorkingFileChange();
      assert.strictEqual(
        hostB.internal.externalRunSessions.get(WORKFLOW_KEY).summary
          .executionState,
        EXECUTION_STATES.RUNNING
      );

      // Terminal persisted state wins over the retained named-worktree lock.
      await writeRunState(workingFilePath, EXECUTION_STATES.COMPLETED, 1);
      const currentSiblingSession = hostB.internal.externalRunSessions.get(
        WORKFLOW_KEY
      ).session as ExternalRunWatchSession;
      await (
        currentSiblingSession as unknown as {
          handleWorkingFileChange: () => Promise<void>;
        }
      ).handleWorkingFileChange();
      await waitFor(() => hostB.internal.externalRunSessions.size === 0);
      assert.strictEqual(
        (await hostA.resolver.resolve(workingFilePath)).kind,
        "not-external"
      );
      assert.strictEqual(
        (await hostB.resolver.resolve(workingFilePath)).kind,
        "not-external"
      );
      assert.ok(
        hostB.updated.some(
          (summary: any) =>
            summary.executionState === EXECUTION_STATES.COMPLETED &&
            summary.externalOwner === undefined
        )
      );
      assert.deepStrictEqual(hostB.dismissed, [WORKFLOW_KEY]);
      assert.strictEqual(
        await pathExists(
          WorkflowPaths.runnerLockPath(workspaceRoot, WORKFLOW_KEY)
        ),
        true
      );

      // A release of the old acquisition cannot touch a successor lock.
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        WORKFLOW_KEY,
        lock.ownerToken
      );
      const successor = await acquireLock(
        workspaceRoot,
        child.pid!,
        "successor-host",
        "successor-owner"
      );
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        WORKFLOW_KEY,
        lock.ownerToken
      );
      assert.strictEqual(
        (await WorkflowLockManager.readLock(workspaceRoot, WORKFLOW_KEY))
          ?.ownerToken,
        successor.ownerToken
      );
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        WORKFLOW_KEY,
        successor.ownerToken
      );
    } finally {
      ConfigurationUtils.shouldAutoLoadRecentSession = originalShouldAutoLoad;
      ExternalRunWatchSession.prototype.start = originalStart;
      await stopLiveChild(child);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("preserves a self-owned untracked run and emits an invariant diagnostic", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-self-owned-untracked-")
    );
    const workingFilePath = await seedRun(workspaceRoot);
    const lock = await acquireLock(
      workspaceRoot,
      process.pid,
      "self-host",
      "self-owner"
    );
    const host = createHost(
      workspaceRoot,
      {
        runner: RUNNER_IDS.VSCODE,
        hostInstanceId: "self-host",
        pid: process.pid,
      },
      Date.now,
      (pid) => pid === process.pid
    );
    originalShouldAutoLoad = ConfigurationUtils.shouldAutoLoadRecentSession;
    let diagnostic: unknown;
    ConfigurationUtils.shouldAutoLoadRecentSession = () => true;
    try {
      await host.internal.setupCliWatching();
      await host.orchestrator.loadWorkflowForClient(
        workingFilePath,
        () => undefined,
        "browser:self",
        { skipReplay: true }
      );
      await host.orchestrator.loadWorkingFile(workingFilePath);
      host.internal.workspaceSessionManager = {
        autoLoadRecentSession: async (
          _root: string,
          onLoad: (filePath: string) => Promise<void>
        ) => onLoad(workingFilePath),
      };
      host.internal.dashboardReadyAt = Date.now();
      host.internal.startupPanelViewedId = null;
      host.internal.resolveStartupAutoLoad = () => undefined;
      await host.internal.triggerAutoLoad();

      await assert.rejects(
        RunContinuationService.validateContinuationTarget(
          workspaceRoot,
          WORKFLOW_KEY,
          RUN_REF,
          new WorkflowLineageRepository(),
          "continue",
          false,
          host.identity,
          (value) => {
            diagnostic = value;
          }
        ),
        /self-owned execution is not tracked/i
      );

      assert.strictEqual(host.internal.externalRunSessions.size, 0);
      assert.deepStrictEqual(host.added, []);
      assert.deepStrictEqual(host.dismissed, []);
      assert.deepStrictEqual(host.freshLoads, []);
      assert.strictEqual(
        await host.orchestrator.requestVscodeStop(WORKFLOW_KEY),
        "unavailable"
      );
      assert.strictEqual(
        await pathExists(
          WorkflowPaths.stopRequestPath(
            workspaceRoot,
            WORKFLOW_KEY,
            lock.ownerToken
          )
        ),
        false
      );
      assert.strictEqual(
        (await WorkflowLockManager.readLock(workspaceRoot, WORKFLOW_KEY))
          ?.ownerToken,
        lock.ownerToken
      );
      assert.strictEqual(
        (JSON.parse(await fs.readFile(workingFilePath, "utf8")) as any)._runtime
          .executionState,
        EXECUTION_STATES.RUNNING
      );

      assert.deepStrictEqual(diagnostic, {
        event: "workflow-ownership-invariant",
        workflowKey: WORKFLOW_KEY,
        runRef: RUN_REF,
        locality: "self-owned-but-untracked",
        decision: "preserve-non-mutating",
      });
      assert.ok(
        host.decisions.some(
          (decision: any) =>
            decision.locality === "self" &&
            decision.externalWatchEligible === false
        )
      );
    } finally {
      ConfigurationUtils.shouldAutoLoadRecentSession = originalShouldAutoLoad;
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        WORKFLOW_KEY,
        lock.ownerToken
      );
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
