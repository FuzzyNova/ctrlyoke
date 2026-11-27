import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test } from "mocha";
import {
  PAUSED_STOP_IGNORES_CONTINUE_MESSAGE,
  WorkflowInstance,
} from "../../core/WorkflowInstance";
import { SubWorkflowLauncher } from "../../core/orchestration/SubWorkflowLauncher";
import { buildSubWorkflowReferenceStep } from "../../core/SubWorkflowReferenceStep";
import {
  STOPPED_WAITING_FOR_SETTLEMENT_MESSAGE,
  buildManagedAutoCommitMessage,
} from "../../core/orchestration/WorktreeManager";
import {
  HeldResponseHarnessIntegration,
  MockHarnessIntegration,
  MockIntegrationFactory,
  MockPlatform,
} from "../helpers/mockHarness";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { captureLog } from "../helpers/logCapture";
import { MERGE_INTO_SHARED_ROOT_GUIDANCE } from "../../core/ParallelGroupPreflight";
import {
  EXECUTION_STATES,
  QUEUE_POSITION,
  STEP_TYPES,
  WORKTREE_LIFECYCLE_STATES,
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
  SUB_WORKFLOW_CANCELLATION_SOURCES,
  TERMINAL_END_REASONS,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_ATTEMPT_COMMANDS,
  type TerminalEndReason,
} from "../../types/DashboardConstants";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import {
  isSubWorkflowStep,
  type WorkingFile,
  type WorkingFileWorktreeRuntime,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { RunContinuationService } from "../../core/orchestration/RunContinuationService";
import {
  gitCommonDir,
  setGitTimeoutOverridesForTests,
} from "../../utils/GitUtils";
import { withWorktreeMutationLock } from "../../utils/WorktreeUtils";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { configService } from "../../config/CtrlYokeConfigService";
import { HarnessAdapterUtils } from "../../core/harness/shared/HarnessAdapterUtils";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { PromptFileResolver } from "../../core/PromptFileResolver";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowInstanceRegistry } from "../../core/orchestration/WorkflowInstanceRegistry";
import { TestWorkflowInstanceRegistryHost } from "../helpers/workflowInstanceRegistryHost";
import { CtrlYokeMCPServer } from "../../mcp-server";
import { MCP_APPEND_STEP_TOOL_NAME } from "../../utils/McpToolDefinitions";
import { ensureMcpStorageInitialized } from "../helpers/mcpStorage";
import type {
  UserFeedback,
  UserFeedbackSink,
} from "../../core/UserFeedbackSink";
import type { WorkflowArtifactCleanupResult } from "../../core/HarnessIntegration";
import { ExecutionRootLeaseManager } from "../../core/orchestration/ExecutionRootLeaseManager";

function restoreEnvironmentValues(
  values: Readonly<Record<string, string | undefined>>
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * A `WorkflowInstance` that can run a hook the moment a start or resume has
 * marked its pre-dispatch startup, before its caller goes on: the one point
 * where a resume has marked a startup but done none of its setup.
 */
class StartupHookedWorkflowInstance extends WorkflowInstance {
  /** Awaited once, right after the next startup is marked. */
  afterStartupMarked?: () => Promise<void>;

  protected override async beginPreDispatchStartup(
    stopRequestBaseline?: number
  ) {
    const startup = await super.beginPreDispatchStartup(stopRequestBaseline);
    const hook = this.afterStartupMarked;
    this.afterStartupMarked = undefined;
    await hook?.();
    return startup;
  }
}

/** Records the operational feedback an instance raises. */
class RecordingFeedbackSink implements UserFeedbackSink {
  readonly notices: UserFeedback[] = [];

  notify(message: UserFeedback): void {
    this.notices.push(message);
  }
}

/**
 * A harness whose best-effort artifact cleanup removes nothing and whose
 * strict cleanup reports a provider file left behind, as a hook or MCP
 * config file the harness wrote into the worktree would be.
 */
class ArtifactLeavingIntegration extends MockHarnessIntegration {
  static readonly LEFT_ARTIFACT = "provider-hooks.json";
  bestEffortCleanups = 0;
  readonly strictCleanupRoots: string[] = [];
  readonly closedTerminals: TerminalEndReason[] = [];

  override async cleanupWorkflowArtifacts(): Promise<void> {
    this.bestEffortCleanups++;
  }

  override async cleanupWorkflowArtifactsStrict(
    _workingFilePath: string | undefined,
    workspaceRoot: string
  ): Promise<WorkflowArtifactCleanupResult> {
    this.strictCleanupRoots.push(workspaceRoot);
    return {
      cleaned: false,
      failures: [
        `Provider artifact remains after cleanup: ${path.join(workspaceRoot, ArtifactLeavingIntegration.LEFT_ARTIFACT)}`,
      ],
    };
  }

  override closeTerminal(reason: TerminalEndReason): void {
    this.closedTerminals.push(reason);
  }
}

suite("Sub-workflow host end to end", () => {
  /**
   * Per child: whether anything subscribed to its queue state while it was
   * PAUSED since its latest execution cycle started. The launcher does
   * exactly that when a cycle ends with the run paused (it waits for the run
   * to settle), so it marks the moment the launcher chose to keep waiting.
   */
  const pausedRunWaiters = new WeakMap<WorkflowInstance, boolean>();

  function trackPausedRunWaits(child: WorkflowInstance): void {
    let cycleStarted = false;
    child.onDidStartExecutionCycle(() => {
      cycleStarted = true;
      pausedRunWaiters.set(child, false);
    });
    const subscribe = child.promptQueue.onDidChangeState;
    Object.defineProperty(child.promptQueue, "onDidChangeState", {
      configurable: true,
      value: (...args: Parameters<typeof subscribe>) => {
        if (
          cycleStarted &&
          child.promptQueue.getState().status === EXECUTION_STATES.PAUSED
        ) {
          pausedRunWaiters.set(child, true);
        }
        return subscribe(...args);
      },
    });
  }

  function buildInstance(
    workspace: string,
    platform: MockPlatform,
    integrationFactory: MockIntegrationFactory,
    detector: MockHarnessIntegration,
    launcher: SubWorkflowLauncher,
    childOptions?: {
      ancestorPaths: readonly string[];
      delegationChain: readonly string[];
    },
    userFeedbackSink?: UserFeedbackSink
  ): StartupHookedWorkflowInstance {
    return new StartupHookedWorkflowInstance(
      platform,
      undefined,
      integrationFactory,
      () => detector,
      () => {},
      () => {},
      workspace,
      false,
      false,
      undefined,
      userFeedbackSink,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { subWorkflowHost: launcher, ...childOptions }
    );
  }

  async function waitForFile(filePath: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        await fs.access(filePath);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.fail("Timed out waiting for " + filePath);
  }

  const STOP_FALLBACK_WARNING = "Stop timeout: cancellation did not settle";

  /**
   * Run `action` (a stop or a resume that must settle on its own) and fail if
   * any instance fell back to stop()'s 10 s timer. Elapsed time alone would
   * still pass a fallback stop, so the guard reads the warning it logs.
   */
  async function withoutStopFallback(action: () => Promise<void>) {
    const log = captureLog();
    try {
      await action();
    } finally {
      log.restore();
    }
    const fallbacks = log.lines.filter((line) =>
      line.message.includes(STOP_FALLBACK_WARNING)
    );
    assert.deepStrictEqual(fallbacks, [], "stop settled without the fallback");
  }

  function makeInstanceFactory(
    workspace: string,
    executionIntegration?: MockHarnessIntegration,
    /** Awaited inside `host.launch`, before the child loads its definition. */
    beforeChildLoad?: () => Promise<void>,
    /** Called with each child instance the launcher creates. */
    onChildCreated?: (child: WorkflowInstance) => void,
    /** Where every instance built here raises its user feedback. */
    userFeedbackSink?: UserFeedbackSink
  ) {
    const platform = new MockPlatform(workspace);
    const integrationFactory = new MockIntegrationFactory(
      platform,
      executionIntegration
    );
    const detector = new MockHarnessIntegration(undefined, false);
    const instances: WorkflowInstance[] = [];
    /** The `concurrent` flag of every child the launcher asked for, in order. */
    const concurrentLaunches: boolean[] = [];
    /** The `delegationChain` of every child the launcher asked for, in order. */
    const launchChains: (readonly string[])[] = [];
    /** Child instances in launch order, keyed by depth (1 = child, 2 = grandchild). */
    const childrenAtDepth = new Map<number, WorkflowInstance[]>();
    let launcher: SubWorkflowLauncher;
    const createInstance = (childOptions?: {
      ancestorPaths: readonly string[];
      delegationChain: readonly string[];
    }) =>
      buildInstance(
        workspace,
        platform,
        integrationFactory,
        detector,
        launcher,
        childOptions,
        userFeedbackSink
      );
    launcher = new SubWorkflowLauncher(
      ({ ancestorPaths, delegationChain, concurrent }) => {
        concurrentLaunches.push(concurrent);
        launchChains.push(delegationChain);
        const child = createInstance({ ancestorPaths, delegationChain });
        trackPausedRunWaits(child);
        instances.push(child);
        if (beforeChildLoad) {
          const load = child.loadPromptFile.bind(child);
          child.loadPromptFile = async (...args) => {
            await beforeChildLoad();
            return load(...args);
          };
          const loadInline = child.loadFromMemoryOrThrow.bind(child);
          child.loadFromMemoryOrThrow = async (...args) => {
            await beforeChildLoad();
            return loadInline(...args);
          };
        }
        onChildCreated?.(child);
        // ancestorPaths lists the root and every workflow above the child.
        const depth = ancestorPaths.length - 1;
        childrenAtDepth.set(depth, [
          ...(childrenAtDepth.get(depth) ?? []),
          child,
        ]);
        return child;
      }
    );
    const childAt = (depth: number, launch = 0): WorkflowInstance => {
      const child = childrenAtDepth.get(depth)?.[launch];
      assert.ok(child, `no child launched at depth ${depth}`);
      return child;
    };
    return {
      createInstance,
      instances,
      childAt,
      concurrentLaunches,
      launchChains,
      detector,
    };
  }

  test("stops a plain script promptly without waiting for the detector fallback", async () => {
    const workspace = makeTempDir("ctrlyoke-script-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      const marker = path.join(workspace, "started");
      const workflow = path.join(workspace, "plain.ctrlyoke.json");
      const script =
        "node -e \"require('fs').writeFileSync('" +
        marker.replace(/\\/g, "\\\\") +
        "','started');setTimeout(()=>{},60000)\"";
      await fs.writeFile(
        workflow,
        JSON.stringify({ steps: [{ type: "script", script }] })
      );
      const instance = createInstance();
      instances.push(instance);
      assert.strictEqual(await instance.loadPromptFile(workflow), true);
      const execution = instance.executeLoadedPromptFile();
      await waitForFile(marker);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await withoutStopFallback(async () => {
        await instance.stop();
        await execution;
      });
      assert.strictEqual(instance.promptQueue.getState().status, "stopped");
    } finally {
      for (const instance of instances) {
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      removeTempDir(workspace);
    }
  });

  test("stopping a parent stops its live child script", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-stop-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      const marker = path.join(workspace, "child-started");
      const childPath = path.join(workspace, "child.ctrlyoke.json");
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      const script =
        "node -e \"require('fs').writeFileSync('" +
        marker.replace(/\\/g, "\\\\") +
        "','yes');setTimeout(()=>{},60000)\"";
      await fs.writeFile(
        childPath,
        JSON.stringify({ steps: [{ type: "script", script }] })
      );
      await fs.writeFile(
        parentPath,
        JSON.stringify({
          steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
        })
      );
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(marker);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await withoutStopFallback(async () => {
        await parent.stop();
        await execution;
      });
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(childAt(1).promptQueue.getState().status, "stopped");
      assert.strictEqual(
        parent.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
    } finally {
      for (const instance of instances) {
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      removeTempDir(workspace);
    }
  });

  /** A child script that records each start and waits for `sentinel`. */
  function sentinelScript(markerName: string, sentinelName: string): string {
    return (
      "node -e \"const fs=require('fs');fs.appendFileSync('" +
      markerName +
      "','ran\\n');const t=setInterval(()=>{if(fs.existsSync('" +
      sentinelName +
      "')){clearInterval(t);process.exit(0)}},50)\""
    );
  }

  async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(value));
  }

  async function waitFor(
    description: string,
    predicate: () => boolean,
    timeoutMs = 10000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Timed out waiting for " + description);
  }

  function countStoppedTransitions(instance: WorkflowInstance): () => number {
    let count = 0;
    let previous = instance.promptQueue.getState().status;
    instance.promptQueue.onDidChangeState((state) => {
      if (
        state.status === EXECUTION_STATES.STOPPED &&
        previous !== EXECUTION_STATES.STOPPED
      ) {
        count++;
      }
      previous = state.status;
    });
    return () => count;
  }

  /**
   * Record every attempt cancellation from now on: the dashboard draws the
   * cancelled target's step as CANCELLED, whatever its queue result says.
   */
  function recordAttemptCancellations(
    instance: WorkflowInstance
  ): () => string[] {
    const cancelled: string[] = [];
    instance.promptQueue
      .getRuntimeStateMachine()
      .onDidAttemptTransition((transition) => {
        if (transition.command === WORKFLOW_ATTEMPT_COMMANDS.CANCEL) {
          cancelled.push(JSON.stringify(transition.current.target));
        }
      });
    return () => cancelled;
  }

  async function readExecutionState(
    instance: WorkflowInstance
  ): Promise<string | undefined> {
    const state = instance.promptQueue.getState();
    const manifest = await new TimelineRecorder().readManifest(
      instance.outputHistoryManager.getHistoryFilePath(
        state.workflowKey!,
        state.runRef!
      )
    );
    return manifest.executionState;
  }

  async function disposeAll(
    instances: readonly WorkflowInstance[],
    workspace: string
  ): Promise<void> {
    for (const instance of instances) {
      await instance.outputHistoryManager.flushPendingIndexRefresh();
      instance.dispose();
    }
    removeTempDir(workspace);
  }

  test("stopping the child directly stops the parent through its outcome", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-child-stop-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [{ type: "script", script: sentinelScript("marker", "never") }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = childAt(1);

      await withoutStopFallback(async () => {
        await child.stop();
        await execution;
      });

      assert.strictEqual(child.promptQueue.getState().status, "stopped");
      const parentState = parent.promptQueue.getState();
      assert.strictEqual(parentState.status, "stopped");
      assert.strictEqual(parentStops(), 1, "parent confirmed STOPPED once");
      assert.strictEqual(parentState.results[0].status, STEP_STATUS.CANCELLED);
      assert.strictEqual(await readExecutionState(parent), "stopped");
      const events = await new TimelineRecorder().readEvents(
        parent.outputHistoryManager.getHistoryFilePath(
          parentState.workflowKey!,
          parentState.runRef!
        )
      );
      assert.deepStrictEqual(
        events.flatMap((event) =>
          event.eventType === TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED
            ? [event.payload.outcome]
            : []
        ),
        [
          {
            status: PROMPT_TERMINAL_STATUS.CANCELLED,
            cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
          },
        ]
      );
      // The settlement names its parent step by stepId, which survives a
      // reorder where the recorded stepIndex does not.
      const parentStepId = parentState.steps[0]._runtime?.stepId;
      assert.ok(parentStepId);
      assert.deepStrictEqual(
        events.flatMap((event) =>
          event.eventType === TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED
            ? [event.stepId]
            : []
        ),
        [parentStepId]
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("stopping the root of a three-level chain stops every run", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-chain-stop-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      await writeJson(path.join(workspace, "grandchild.ctrlyoke.json"), {
        steps: [{ type: "script", script: sentinelScript("marker", "never") }],
      });
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [{ type: "workflow", workflow: "grandchild.ctrlyoke.json" }],
      });
      const rootPath = path.join(workspace, "root.ctrlyoke.json");
      await writeJson(rootPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const root = createInstance();
      instances.push(root);
      const stopCounts = new Map<WorkflowInstance, () => number>([
        [root, countStoppedTransitions(root)],
      ]);
      assert.strictEqual(await root.loadPromptFile(rootPath), true);
      const execution = root.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = childAt(1);
      const grandchild = childAt(2);
      stopCounts.set(child, countStoppedTransitions(child));
      stopCounts.set(grandchild, countStoppedTransitions(grandchild));

      await withoutStopFallback(async () => {
        await root.stop();
        await execution;
      });

      for (const [label, instance] of [
        ["root", root],
        ["child", child],
        ["grandchild", grandchild],
      ] as const) {
        assert.strictEqual(
          instance.promptQueue.getState().status,
          "stopped",
          label
        );
        assert.strictEqual(
          instance.promptQueue.getState().results[0].status,
          STEP_STATUS.CANCELLED,
          label
        );
        assert.strictEqual(
          await readExecutionState(instance),
          "stopped",
          label
        );
        assert.strictEqual(stopCounts.get(instance)!(), 1, label);
      }
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  async function countLines(filePath: string): Promise<number> {
    return (await fs.readFile(filePath, "utf8")).split("\n").filter(Boolean)
      .length;
  }

  /** Child workflow: a script held open by `sentinel`, then a second script. */
  async function writePausableChild(workspace: string): Promise<void> {
    await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
      steps: [
        { type: "script", script: sentinelScript("marker", "sentinel") },
        {
          type: "script",
          script: "node -e \"require('fs').appendFileSync('after','ran\\n')\"",
        },
      ],
    });
  }

  /**
   * Wait until the child has paused and its execution cycle has ended — the
   * point at which a launcher that settles on the first cycle would fail the
   * parent step — and the launcher has reacted by waiting on the paused
   * run instead of settling (see `trackPausedRunWaits`).
   */
  async function waitForChildPausedCycle(
    child: WorkflowInstance
  ): Promise<void> {
    await waitFor(
      "the child to pause",
      () => child.promptQueue.getState().status === "paused"
    );
    await child.whenExecutionSettled();
    await waitFor(
      "the launcher to wait on the paused child run",
      () => pausedRunWaiters.get(child) === true
    );
  }

  function assertStepUnsettled(parent: WorkflowInstance): void {
    const result = parent.promptQueue.getState().results[0];
    assert.ok(
      result.status !== STEP_STATUS.FAILED &&
        result.status !== STEP_STATUS.COMPLETED &&
        result.status !== STEP_STATUS.CANCELLED,
      JSON.stringify(result)
    );
  }

  test("pausing the parent pauses its child, and resuming the parent finishes both once", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-pause-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      await writePausableChild(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = childAt(1);

      await parent.pause();
      assert.strictEqual(parent.promptQueue.getState().status, "pausing");
      assert.strictEqual(child.promptQueue.getState().status, "pausing");

      // The child pauses at its own step boundary once its script ends; the
      // parent keeps waiting on the child run, so it stays PAUSING.
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await waitForChildPausedCycle(child);
      assert.strictEqual(parent.promptQueue.getState().status, "pausing");
      assertStepUnsettled(parent);

      await withoutStopFallback(async () => {
        await parent.resume();
        await execution;
      });

      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(child.promptQueue.getState().status, "completed");
      assert.strictEqual(instances.length, 2, "no second child instance");
      assert.strictEqual(await countLines(path.join(workspace, "marker")), 1);
      assert.strictEqual(await countLines(path.join(workspace, "after")), 1);
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("pausing the child directly leaves the parent running until the child resumes", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-child-pause-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      await writePausableChild(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = childAt(1);

      await child.pause();
      assert.strictEqual(child.promptQueue.getState().status, "pausing");
      assert.strictEqual(parent.promptQueue.getState().status, "running");

      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await waitForChildPausedCycle(child);
      assert.strictEqual(parent.promptQueue.getState().status, "running");
      assertStepUnsettled(parent);

      await withoutStopFallback(async () => {
        await child.resume();
        await execution;
      });

      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(child.promptQueue.getState().status, "completed");
      assert.strictEqual(instances.length, 2, "no second child instance");
      assert.strictEqual(await countLines(path.join(workspace, "marker")), 1);
      assert.strictEqual(await countLines(path.join(workspace, "after")), 1);
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  /** A one-step child script that logs each start and each finish to `marker`. */
  function startFinishScript(sentinelName: string): string {
    return (
      "node -e \"const fs=require('fs');fs.appendFileSync('marker','start\\n');const t=setInterval(()=>{if(fs.existsSync('" +
      sentinelName +
      "')){clearInterval(t);fs.appendFileSync('marker','done\\n');process.exit(0)}},50)\""
    );
  }

  async function readWorkingFileExecutionState(
    instance: WorkflowInstance
  ): Promise<string | undefined> {
    const workingFilePath = instance.promptQueue.getState().workingFilePath;
    assert.ok(workingFilePath);
    const file = JSON.parse(await fs.readFile(workingFilePath, "utf8")) as {
      _runtime?: { executionState?: string };
    };
    return file._runtime?.executionState;
  }

  test("resuming a pausing parent whose child is paused commits RUNNING while the child still runs", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-resume-paused-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [
          { type: "script", script: sentinelScript("marker", "sentinel") },
          { type: "script", script: sentinelScript("marker2", "sentinel2") },
        ],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = childAt(1);
      await parent.pause();
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await waitForChildPausedCycle(child);

      let resumed = false;
      const resume = parent.resume().then(() => {
        resumed = true;
      });
      await waitForFile(path.join(workspace, "marker2"));
      // The child's second script is held open by sentinel2, so a resume
      // that awaited the child's run could not have returned by now.
      await waitFor("the parent's resume to return", () => resumed);
      assert.strictEqual(child.promptQueue.getState().status, "running");
      assert.strictEqual(parent.promptQueue.getState().status, "running");
      assert.strictEqual(
        await readWorkingFileExecutionState(parent),
        "running"
      );

      await fs.writeFile(path.join(workspace, "sentinel2"), "go");
      await withoutStopFallback(async () => {
        await resume;
        await execution;
      });
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(child.promptQueue.getState().status, "completed");
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  /** A gate the child's load waits on, and a signal that the load reached it. */
  function makeLoadGate() {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      beforeChildLoad: async () => {
        reached();
        await released;
      },
      reached: reachedPromise,
      release,
    };
  }

  test("stopping a parent while its child is still launching stops the child", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-launch-stop-");
    const gate = makeLoadGate();
    const { createInstance, instances, childAt } = makeInstanceFactory(
      workspace,
      undefined,
      gate.beforeChildLoad
    );
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [{ type: "script", script: sentinelScript("marker", "never") }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await gate.reached;

      await withoutStopFallback(async () => {
        await parent.stop();
        assert.notStrictEqual(
          parent.promptQueue.getState().status,
          "stopped",
          "the parent confirms STOPPED only through the child's outcome"
        );
        gate.release();
        await execution;
      });

      const child = childAt(1);
      assert.strictEqual(child.promptQueue.getState().status, "stopped");
      const parentState = parent.promptQueue.getState();
      assert.strictEqual(parentState.status, "stopped");
      assert.strictEqual(parentStops(), 1, "parent confirmed STOPPED once");
      assert.strictEqual(parentState.results[0].status, STEP_STATUS.CANCELLED);
    } finally {
      gate.release();
      await disposeAll(instances, workspace);
    }
  });

  test("pausing a parent while its child is still launching pauses the child", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-launch-pause-");
    const gate = makeLoadGate();
    const { createInstance, instances, childAt } = makeInstanceFactory(
      workspace,
      undefined,
      gate.beforeChildLoad
    );
    try {
      await writePausableChild(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await gate.reached;
      await parent.pause();
      gate.release();

      // The pause reached the child before it dispatched anything, so its
      // next step boundary is the one before its first step.
      const child = childAt(1);
      await waitForChildPausedCycle(child);
      assert.strictEqual(parent.promptQueue.getState().status, "pausing");
      assertStepUnsettled(parent);
      await assert.rejects(fs.access(path.join(workspace, "marker")));

      await fs.writeFile(path.join(workspace, "sentinel"), "go");

      await withoutStopFallback(async () => {
        await parent.resume();
        await execution;
      });
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(await countLines(path.join(workspace, "marker")), 1);
      assert.strictEqual(await countLines(path.join(workspace, "after")), 1);
    } finally {
      gate.release();
      await disposeAll(instances, workspace);
    }
  });

  /**
   * Holds a child continued by D6 inside `executeContinuationAtRun` once its
   * run identity is bound (so the launcher has returned its handle), before
   * its execution cycle starts. Pass `install` as `onChildCreated`.
   */
  function makeContinuationGate() {
    const gate = makeLoadGate();
    const install = (child: WorkflowInstance) => {
      const continueAtRun = child.executeContinuationAtRun.bind(child);
      child.executeContinuationAtRun = async (...args) => {
        const history = child.outputHistoryManager;
        const commit = history.commitDefinitionRevision.bind(history);
        history.commitDefinitionRevision = async (...commitArgs) => {
          history.commitDefinitionRevision = commit;
          await gate.beforeChildLoad();
          return commit(...commitArgs);
        };
        return continueAtRun(...args);
      };
    };
    return { reached: gate.reached, release: gate.release, install };
  }

  /** Run `parent` until its one-step child is stopped mid-step by the parent. */
  async function stopParentMidChild(
    workspace: string,
    parent: WorkflowInstance,
    /** Workflow-level fields for both files. */
    workflowFields: Record<string, unknown> = {}
  ): Promise<void> {
    await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
      ...workflowFields,
      steps: [{ type: "script", script: startFinishScript("sentinel") }],
    });
    const parentPath = path.join(workspace, "parent.ctrlyoke.json");
    await writeJson(parentPath, {
      ...workflowFields,
      steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
    });
    assert.strictEqual(await parent.loadPromptFile(parentPath), true);
    const execution = parent.executeLoadedPromptFile();
    await waitForFile(path.join(workspace, "marker"));
    await withoutStopFallback(async () => {
      await parent.stop();
      await execution;
    });
    assert.strictEqual(parent.promptQueue.getState().status, "stopped");
  }

  function continueParent(parent: WorkflowInstance): Promise<void> {
    const state = parent.promptQueue.getState();
    return parent.executeContinuationAtRun(
      state.workflowKey!,
      state.runRef!,
      state.definitionRevision
    );
  }

  test("stopping a parent while its reattached child is still continuing stops the child before it runs", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-continue-stop-");
    const gate = makeContinuationGate();
    const { createInstance, instances, childAt } = makeInstanceFactory(
      workspace,
      undefined,
      undefined,
      gate.install
    );
    try {
      const parent = createInstance();
      instances.push(parent);
      await stopParentMidChild(workspace, parent);
      const marker = path.join(workspace, "marker");

      const parentStops = countStoppedTransitions(parent);
      const continuation = continueParent(parent);
      await gate.reached;
      await withoutStopFallback(async () => {
        await parent.stop();
        gate.release();
        await continuation;
      });

      const parentState = parent.promptQueue.getState();
      assert.strictEqual(parentState.status, "stopped");
      assert.strictEqual(parentStops(), 1, "parent confirmed STOPPED once");
      assert.strictEqual(parentState.results[0].status, STEP_STATUS.CANCELLED);
      const continued = childAt(1, 1);
      assert.strictEqual(continued.promptQueue.getState().status, "stopped");
      // The stop reached the child before it dispatched, so the step its
      // first stop interrupted is still rewound for the next continue.
      assert.strictEqual(
        continued.promptQueue.getState().results[0].status,
        STEP_STATUS.PENDING
      );
      assert.strictEqual(await fs.readFile(marker, "utf8"), "start\n");

      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await continueParent(parent);
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(
        await fs.readFile(marker, "utf8"),
        "start\nstart\ndone\n"
      );
    } finally {
      gate.release();
      await disposeAll(instances, workspace);
    }
  });

  test("pausing a parent while its reattached child is still continuing pauses the child before it runs", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-continue-pause-");
    const gate = makeContinuationGate();
    const { createInstance, instances, childAt } = makeInstanceFactory(
      workspace,
      undefined,
      undefined,
      gate.install
    );
    try {
      const parent = createInstance();
      instances.push(parent);
      await stopParentMidChild(workspace, parent);
      const marker = path.join(workspace, "marker");

      const continuation = continueParent(parent);
      await gate.reached;
      await parent.pause();
      gate.release();

      const continued = childAt(1, 1);
      await waitForChildPausedCycle(continued);
      // D3: the parent waits on its paused child, so it stays PAUSING.
      assert.strictEqual(parent.promptQueue.getState().status, "pausing");
      assertStepUnsettled(parent);
      assert.strictEqual(await fs.readFile(marker, "utf8"), "start\n");

      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await withoutStopFallback(async () => {
        await parent.resume();
        await continuation;
      });
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(continued.promptQueue.getState().status, "completed");
      assert.strictEqual(
        await fs.readFile(marker, "utf8"),
        "start\nstart\ndone\n"
      );
    } finally {
      gate.release();
      await disposeAll(instances, workspace);
    }
  });

  test("a paused child disposed by a host shutdown stops its parent and continues once when reattached", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-dispose-paused-");
    const gate = makeContinuationGate();
    const { createInstance, instances, childAt } = makeInstanceFactory(
      workspace,
      undefined,
      undefined,
      gate.install
    );
    try {
      await writePausableChild(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = childAt(1);
      await parent.pause();
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await waitForChildPausedCycle(child);

      // The real dispose(): the step settles CANCELLED (never FAILED), the
      // parent stops, and the paused child run stays continuable.
      child.dispose();
      await withoutStopFallback(async () => {
        await execution;
      });
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(
        parent.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
      assert.strictEqual(await readExecutionState(child), "paused");

      // A restarted host reclaims the shut-down process's runner lock. This
      // process is still alive, so remove it the way that reclaim would.
      const childKey = child.promptQueue.getState().workflowKey!;
      await fs.rm(WorkflowPaths.runnerLockPath(workspace, childKey), {
        force: true,
      });

      const continuation = continueParent(parent);
      await gate.reached;
      const continued = childAt(1, 1);
      assert.strictEqual(continued.promptQueue.getState().status, "paused");
      await parent.pause();
      await parent.resume();
      // Neither the held pause nor its cancellation resumed the child: the
      // continuation's own resume is the only one.
      assert.strictEqual(continued.promptQueue.getState().status, "paused");
      gate.release();
      await withoutStopFallback(async () => {
        await continuation;
      });

      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(continued.promptQueue.getState().status, "completed");
      assert.strictEqual(await countLines(path.join(workspace, "marker")), 1);
      assert.strictEqual(await countLines(path.join(workspace, "after")), 1);
    } finally {
      gate.release();
      await disposeAll(instances, workspace);
    }
  });

  test("a running child disposed by a host shutdown settles its parent step CANCELLED", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-dispose-running-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    let child: WorkflowInstance | undefined;
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [{ type: "script", script: startFinishScript("sentinel") }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            type: "workflow",
            workflow: "child.ctrlyoke.json",
            onFail: "continue",
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      child = childAt(1);

      child.dispose();
      await withoutStopFallback(async () => {
        await execution;
      });
      // CANCELLED stops the parent even under onFail: continue (D9).
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(parentStops(), 1);
      assert.strictEqual(
        parent.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
    } finally {
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await child?.whenExecutionSettled();
      await disposeAll(instances, workspace);
    }
  });

  test("stopping a parent while its workflow step resolves the child skips the launch", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-resolve-stop-");
    const gate = makeLoadGate();
    const { createInstance, instances } = makeInstanceFactory(workspace);
    const resolver = PromptFileResolver.prototype;
    const resolvePath = resolver.resolvePath;
    resolver.resolvePath = async function (
      this: PromptFileResolver,
      ...args: Parameters<PromptFileResolver["resolvePath"]>
    ) {
      // Only the workflow step's own resolution, not the parent's load-time
      // reference checks of the same path.
      if (new Error().stack?.includes("prepareSubWorkflowLaunch")) {
        await gate.beforeChildLoad();
      }
      return resolvePath.apply(this, args);
    };
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [{ type: "script", script: sentinelScript("marker", "never") }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await gate.reached;
      await withoutStopFallback(async () => {
        await parent.stop();
        gate.release();
        await execution;
      });

      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(parentStops(), 1);
      assert.strictEqual(
        parent.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
      assert.strictEqual(instances.length, 1, "no child was launched");
    } finally {
      resolver.resolvePath = resolvePath;
      gate.release();
      await disposeAll(instances, workspace);
    }
  });

  test("stopping a parent while its child's launch fails settles the step CANCELLED", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-launch-throw-stop-");
    const gate = makeLoadGate();
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      undefined,
      gate.beforeChildLoad
    );
    try {
      // Not a workflow: the child fails to load once the gate opens.
      await fs.writeFile(
        path.join(workspace, "child.ctrlyoke.json"),
        "{ not json"
      );
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            type: "workflow",
            workflow: "child.ctrlyoke.json",
            onFail: "continue",
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await gate.reached;
      await withoutStopFallback(async () => {
        await parent.stop();
        gate.release();
        await execution;
      });

      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(parentStops(), 1);
      assert.strictEqual(
        parent.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
    } finally {
      gate.release();
      await disposeAll(instances, workspace);
    }
  });

  /** A registry-built instance can host a PTY; these scripts run headless. */
  const HEADLESS = { executionMode: "headless" } as const;

  /**
   * A registry wired like the VS Code host's: every child the launcher
   * creates is a registry instance that no client views, so the registry's
   * own lifecycle (retire on a terminal state, dispose when unviewed) applies
   * to it. The parent is viewed by the panel, as a workflow a user continues.
   */
  function makeRegistry(
    workspace: string,
    executionIntegration?: MockHarnessIntegration
  ) {
    const host = new TestWorkflowInstanceRegistryHost(
      workspace,
      executionIntegration
    );
    const registry = new WorkflowInstanceRegistry(host);
    const parent = registry.registerNewInstance(host.panelClientId);
    const residents = () => [
      ...registry.getInstances().values(),
      ...registry.getRetiredInstances().values(),
    ];
    /** Dispose every instance, retired first, as the host's dispose does. */
    const disposeHost = () => {
      for (const instance of [
        ...registry.getRetiredInstances().values(),
        ...registry.getInstances().values(),
      ]) {
        instance.dispose();
      }
    };
    return { registry, host, parent, residents, disposeHost };
  }

  async function disposeRegistry(
    residents: () => WorkflowInstance[],
    extra: readonly WorkflowInstance[],
    workspace: string
  ): Promise<void> {
    await disposeAll([...new Set([...residents(), ...extra])], workspace);
  }

  /** Every instance the registry has built, including disposed ones. */
  function trackBuiltInstances(registry: WorkflowInstanceRegistry) {
    const built: WorkflowInstance[] = [];
    const build = registry.buildWorkflowInstanceForHost.bind(registry);
    registry.buildWorkflowInstanceForHost = (...args) => {
      const instance = build(...args);
      built.push(instance);
      return instance;
    };
    return built;
  }

  test("through the registry, continuing a parent reattaches its unviewed STOPPED child and completes", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-registry-stopped-");
    const { registry, parent, residents } = makeRegistry(workspace);
    const built = trackBuiltInstances(registry);
    try {
      await stopParentMidChild(workspace, parent, HEADLESS);
      const marker = path.join(workspace, "marker");

      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await withoutStopFallback(() => continueParent(parent));

      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(
        await fs.readFile(marker, "utf8"),
        "start\nstart\ndone\n"
      );
      const continued = built[built.length - 1];
      assert.notStrictEqual(continued, parent);
      assert.strictEqual(continued.promptQueue.getState().status, "completed");
      // Released by its launcher, the finished child retires as usual.
      assert.strictEqual(registry.getInstances().has(continued.id), false);
    } finally {
      await disposeRegistry(residents, built, workspace);
    }
  });

  test("through the registry, continuing a parent reattaches its unviewed ERROR child and completes", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-registry-error-");
    const { registry, parent, residents } = makeRegistry(workspace);
    const built = trackBuiltInstances(registry);
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        ...HEADLESS,
        steps: [
          {
            type: "script",
            script:
              "node -e \"require('fs').appendFileSync('marker','ran\\n');process.exit(require('fs').existsSync('sentinel')?0:1)\"",
          },
          {
            type: "script",
            script:
              "node -e \"require('fs').appendFileSync('after','ran\\n')\"",
          },
        ],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        ...HEADLESS,
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();
      assert.strictEqual(parent.promptQueue.getState().status, "error");
      const failed = built[built.length - 1];
      assert.strictEqual(failed.promptQueue.getState().status, "error");

      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await withoutStopFallback(() => continueParent(parent));

      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      const continued = built[built.length - 1];
      assert.notStrictEqual(continued, failed);
      assert.strictEqual(continued.promptQueue.getState().status, "completed");
      assert.strictEqual(
        continued.promptQueue.getState().runRef,
        failed.promptQueue.getState().runRef
      );
      assert.strictEqual(await countLines(path.join(workspace, "marker")), 2);
      assert.strictEqual(await countLines(path.join(workspace, "after")), 1);
    } finally {
      await disposeRegistry(residents, built, workspace);
    }
  });

  test("disposing the host while a child runs stops the child's execution and settles the parent step CANCELLED once", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-registry-dispose-");
    const { registry, parent, residents, disposeHost } =
      makeRegistry(workspace);
    const built = trackBuiltInstances(registry);
    try {
      const next = path.join(workspace, "next-step");
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        ...HEADLESS,
        steps: [
          {
            type: "script",
            script: startFinishScript("sentinel"),
            // A step torn down by the dispose must not be what ends the run.
            errorBehavior: { onError: "continue" },
            onFail: "continue",
          },
          {
            type: "script",
            script:
              "node -e \"require('fs').writeFileSync('next-step','ran')\"",
          },
        ],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        ...HEADLESS,
        steps: [
          {
            type: "workflow",
            workflow: "child.ctrlyoke.json",
            onFail: "continue",
          },
        ],
      });
      const parentStops = countStoppedTransitions(parent);
      const settlements: unknown[] = [];
      const record = parent.outputHistoryManager.recordSubWorkflowSettled.bind(
        parent.outputHistoryManager
      );
      parent.outputHistoryManager.recordSubWorkflowSettled = async (
        ...args
      ) => {
        settlements.push(args[4].outcome);
        return record(...args);
      };
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = built[built.length - 1];
      assert.notStrictEqual(child, parent);

      await withoutStopFallback(async () => {
        disposeHost();
        await execution;
      });

      // `done` settled only once the child's execution had ended, so the
      // sentinel can no longer let its first step finish into the next one.
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await child.whenExecutionSettled();
      assert.strictEqual(child.promptQueue.getState().status, "stopped");
      await assert.rejects(fs.access(next), "the child's next step never ran");
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(parentStops(), 1);
      assert.strictEqual(
        parent.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
      assert.deepStrictEqual(settlements, [
        {
          status: PROMPT_TERMINAL_STATUS.CANCELLED,
          cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
        },
      ]);
    } finally {
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await disposeRegistry(residents, built, workspace);
    }
  });

  /** Settle within `ms` or fail: a hang must fail the test, not time it out. */
  async function settlesWithin(
    description: string,
    promise: Promise<unknown>,
    ms = 10000
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    });
    try {
      const result = await Promise.race([
        promise.then(() => "settled" as const),
        timedOut,
      ]);
      assert.strictEqual(result, "settled", `${description} never settled`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Record each `subWorkflowSettled` outcome `parent` records, in order. */
  function recordSettlements(parent: WorkflowInstance): unknown[] {
    const settlements: unknown[] = [];
    const record = parent.outputHistoryManager.recordSubWorkflowSettled.bind(
      parent.outputHistoryManager
    );
    parent.outputHistoryManager.recordSubWorkflowSettled = async (...args) => {
      settlements.push(args[4].outcome);
      return record(...args);
    };
    return settlements;
  }

  test("disposing the host while a child waits on an AI response settles the parent step CANCELLED and releases the child", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-registry-dispose-ai-");
    const harness = new HeldResponseHarnessIntegration(undefined, false);
    const { registry, parent, residents, disposeHost } = makeRegistry(
      workspace,
      harness
    );
    const built = trackBuiltInstances(registry);
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        ...HEADLESS,
        steps: [
          { prompt: "a turn that never ends" },
          {
            type: "script",
            script:
              "node -e \"require('fs').writeFileSync('next-step','ran')\"",
          },
        ],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        ...HEADLESS,
        steps: [
          {
            type: "workflow",
            workflow: "child.ctrlyoke.json",
            onFail: "continue",
          },
        ],
      });
      const settlements = recordSettlements(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitFor("the child to wait on its AI response", () => {
        const child = built[built.length - 1];
        return (
          child !== parent &&
          harness.sentPrompts.length === 1 &&
          child.workflowExecutor.isAwaitingResponse()
        );
      });
      const child = built[built.length - 1];

      await withoutStopFallback(async () => {
        disposeHost();
        await settlesWithin("the parent's execution", execution);
      });

      assert.strictEqual(child.promptQueue.getState().status, "stopped");
      await assert.rejects(
        fs.access(path.join(workspace, "next-step")),
        "the child's next step never ran"
      );
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(
        parent.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
      assert.deepStrictEqual(settlements, [
        {
          status: PROMPT_TERMINAL_STATUS.CANCELLED,
          cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
        },
      ]);
      // Released by its launcher, the child now follows the registry's
      // lifecycle: a retire removes it, where an owned child is kept.
      registry.retireWorkflow(child.id);
      assert.strictEqual(registry.getInstances().has(child.id), false);
    } finally {
      await disposeRegistry(residents, built, workspace);
    }
  });

  test("a child released unstarted after a failed launch is disposed when no client views it", async () => {
    const workspace = makeTempDir(
      "ctrlyoke-subworkflow-registry-release-idle-"
    );
    const { registry, parent, residents } = makeRegistry(workspace);
    const built = trackBuiltInstances(registry);
    try {
      // Valid for the parent's resolution, refused by the child's own load.
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        ...HEADLESS,
        steps: [{ type: "script" }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        ...HEADLESS,
        steps: [
          {
            type: "workflow",
            workflow: "child.ctrlyoke.json",
            onFail: "continue",
          },
        ],
      });
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();

      const child = built[built.length - 1];
      assert.notStrictEqual(child, parent, "the launcher created a child");
      assert.strictEqual(child.promptQueue.getState().status, "idle");
      assert.strictEqual(child.isDisposed, true);
      assert.strictEqual(registry.getInstances().has(child.id), false);
      assert.strictEqual(registry.getRetiredInstances().has(child.id), false);
    } finally {
      await disposeRegistry(residents, built, workspace);
    }
  });

  test("a paused child released after a failed resume is retired when unviewed, and its pause stays continuable", async () => {
    const workspace = makeTempDir(
      "ctrlyoke-subworkflow-registry-release-paused-"
    );
    const { registry, parent, residents } = makeRegistry(workspace);
    const built = trackBuiltInstances(registry);
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        ...HEADLESS,
        steps: [
          { type: "script", script: sentinelScript("marker", "sentinel") },
          {
            type: "script",
            script:
              "node -e \"require('fs').appendFileSync('after','ran\\n')\"",
          },
        ],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        ...HEADLESS,
        steps: [
          {
            type: "workflow",
            workflow: "child.ctrlyoke.json",
            onFail: "continue",
          },
        ],
      });
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "marker"));
      const child = built[built.length - 1];
      assert.notStrictEqual(child, parent, "the launcher created a child");

      // Pause the parent: the child pauses at its step boundary, and the
      // parent waits PAUSING on it.
      await parent.pause();
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      await waitFor(
        "the child to pause",
        () => child.promptQueue.getState().status === EXECUTION_STATES.PAUSED
      );
      await child.whenExecutionSettled();
      const { workflowKey, runRef } = child.promptQueue.getState();

      // Cancelling the parent's pause resumes the child; that resume fails,
      // so the launcher releases the child still PAUSED.
      child.resume = async () => {
        throw new Error("resume failed");
      };
      await parent.resume();
      await settlesWithin("the parent's execution", execution);

      assert.strictEqual(child.isDisposed, true, "the released child retired");
      assert.strictEqual(registry.getInstances().has(child.id), false);
      assert.strictEqual(registry.getRetiredInstances().has(child.id), false);
      assert.strictEqual(
        await readWorkingFileExecutionState(child),
        EXECUTION_STATES.PAUSED,
        "retiring disposed only the instance: the pause is still on disk"
      );
      await assert.rejects(fs.access(path.join(workspace, "after")));

      // A fresh instance continues the paused run to completion.
      const fresh = registry.buildWorkflowInstanceForHost();
      const childFile = JSON.parse(
        await fs.readFile(child.promptQueue.getState().workingFilePath!, "utf8")
      ) as { definitionRevision: number };
      const revision = childFile.definitionRevision;
      await withoutStopFallback(() =>
        fresh.executeContinuationAtRun(workflowKey!, runRef!, revision)
      );
      assert.strictEqual(
        fresh.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(fresh.promptQueue.getState().results)
      );
      assert.strictEqual(fresh.promptQueue.getState().runRef, runRef);
      assert.strictEqual(await countLines(path.join(workspace, "marker")), 1);
      assert.strictEqual(await countLines(path.join(workspace, "after")), 1);
    } finally {
      await fs
        .writeFile(path.join(workspace, "sentinel"), "go")
        .catch(() => {});
      await disposeRegistry(residents, built, workspace);
    }
  });

  /**
   * Stop `parent` mid-child, then continue it until its reattached child is
   * still loading (restored STOPPED) and launcher-owned; `check` runs there.
   */
  async function checkOwnedChildWhileContinuing(
    workspace: string,
    check: (options: {
      registry: WorkflowInstanceRegistry;
      host: TestWorkflowInstanceRegistryHost;
      continued: WorkflowInstance;
    }) => Promise<void>
  ): Promise<void> {
    const { registry, host, parent, residents } = makeRegistry(workspace);
    const built = trackBuiltInstances(registry);
    const gate = makeContinuationGate();
    try {
      await stopParentMidChild(workspace, parent, HEADLESS);
      const build = registry.buildWorkflowInstanceForHost.bind(registry);
      registry.buildWorkflowInstanceForHost = (...args) => {
        const instance = build(...args);
        gate.install(instance);
        return instance;
      };
      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      const continuation = continueParent(parent);
      await gate.reached;
      const continued = built[built.length - 1];
      assert.notStrictEqual(continued, parent);
      assert.strictEqual(continued.promptQueue.getState().status, "stopped");

      await check({ registry, host, continued });

      assert.strictEqual(continued.isDisposed, false);
      assert.strictEqual(registry.getInstances().has(continued.id), true);
      gate.release();
      await withoutStopFallback(() => continuation);
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.strictEqual(continued.promptQueue.getState().status, "completed");
    } finally {
      gate.release();
      await disposeRegistry(residents, built, workspace);
    }
  }

  test("closing the only viewer of a launcher-owned child does not dispose it", async () => {
    await checkOwnedChildWhileContinuing(
      makeTempDir("ctrlyoke-subworkflow-registry-owned-unregister-"),
      async ({ registry, continued }) => {
        registry.registerClient("tab");
        registry.setViewedWorkflowId("tab", continued.id);
        registry.unregisterClient("tab");
      }
    );
  });

  test("creating a workflow from a panel viewing a launcher-owned child does not dispose it", async () => {
    await checkOwnedChildWhileContinuing(
      makeTempDir("ctrlyoke-subworkflow-registry-owned-create-"),
      async ({ registry, host, continued }) => {
        registry.setViewedWorkflowId(host.panelClientId, continued.id);
        const created = await registry.createWorkflow();
        assert.ok(created);
        assert.notStrictEqual(created, continued);
      }
    );
  });

  test("a child continued by its parent re-runs the step its stop interrupted", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-rerun-cancelled-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [{ type: "script", script: startFinishScript("sentinel") }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      const marker = path.join(workspace, "marker");
      await waitForFile(marker);
      await withoutStopFallback(async () => {
        await parent.stop();
        await execution;
      });
      const stoppedChild = childAt(1);
      assert.strictEqual(
        stoppedChild.promptQueue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );

      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      const state = parent.promptQueue.getState();
      await parent.executeContinuationAtRun(
        state.workflowKey!,
        state.runRef!,
        state.definitionRevision
      );

      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      const continued = childAt(1, 1);
      assert.strictEqual(
        continued.promptQueue.getState().runRef,
        stoppedChild.promptQueue.getState().runRef
      );
      assert.strictEqual(continued.promptQueue.getState().status, "completed");
      assert.strictEqual(
        continued.promptQueue.getState().results[0].status,
        STEP_STATUS.COMPLETED
      );
      assert.strictEqual(
        await fs.readFile(marker, "utf8"),
        "start\nstart\ndone\n"
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a finalStep pass stopped mid-child reattaches to that pass's child when continued", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-final-continue-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [{ type: "script", script: startFinishScript("sentinel") }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            type: "script",
            script:
              "node -e \"require('fs').appendFileSync('queue','ran\\n')\"",
          },
        ],
        finalStep: { type: "workflow", workflow: "child.ctrlyoke.json" },
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      const marker = path.join(workspace, "marker");
      await waitForFile(marker);
      await withoutStopFallback(async () => {
        await parent.stop();
        await execution;
      });
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      const stoppedChild = childAt(1);
      const childRunRef = stoppedChild.promptQueue.getState().runRef;
      assert.strictEqual(stoppedChild.promptQueue.getState().status, "stopped");

      await fs.writeFile(path.join(workspace, "sentinel"), "go");
      const state = parent.promptQueue.getState();
      await parent.executeContinuationAtRun(
        state.workflowKey!,
        state.runRef!,
        state.definitionRevision
      );

      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      // The queue step is not re-run, and the pass reconnects to its own
      // child (D8: reattach only within one pass) instead of launching anew.
      assert.strictEqual(await countLines(path.join(workspace, "queue")), 1);
      const continued = childAt(1, 1);
      assert.strictEqual(continued.promptQueue.getState().runRef, childRunRef);
      assert.strictEqual(continued.promptQueue.getState().status, "completed");
      assert.strictEqual(instances.length, 3, "no third child instance");
      const finalRuntime = (
        parent.promptQueue.getWorkflowFile().finalStep as {
          _runtime?: { childRunRef?: string };
        }
      )._runtime;
      assert.strictEqual(finalRuntime?.childRunRef, childRunRef);
      assert.strictEqual(
        await fs.readFile(marker, "utf8"),
        "start\nstart\ndone\n"
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("continuing a parent stopped mid-child reattaches to the recorded child run", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-resume-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      const marker = path.join(workspace, "marker.txt");
      const waiting = path.join(workspace, "child-waiting");
      const sentinel = path.join(workspace, "sentinel");
      const childPath = path.join(workspace, "child.ctrlyoke.json");
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await fs.writeFile(
        childPath,
        JSON.stringify({
          steps: [
            {
              type: "script",
              script:
                "node -e \"require('fs').appendFileSync('marker.txt','ran\\n')\"",
            },
            {
              type: "script",
              script:
                "node -e \"const fs=require('fs');fs.writeFileSync('child-waiting','y');const t=setInterval(()=>{if(fs.existsSync('sentinel')){clearInterval(t);process.exit(0)}},50)\"",
            },
          ],
        })
      );
      await fs.writeFile(
        parentPath,
        JSON.stringify({
          steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
        })
      );
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(waiting);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await parent.stop();
      await execution;

      const child = instances[instances.length - 1];
      assert.notStrictEqual(child, parent);
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(child.promptQueue.getState().status, "stopped");
      const stoppedStep = parent.promptQueue.getState().steps[0];
      assert.ok(isSubWorkflowStep(stoppedStep));
      const childWorkflowKey = stoppedStep._runtime?.childWorkflowKey;
      const childRunRef = stoppedStep._runtime?.childRunRef;
      assert.ok(childWorkflowKey && childRunRef);
      const parentState = parent.promptQueue.getState();
      const childLineageDir = path.dirname(
        path.dirname(
          parent.outputHistoryManager.getHistoryFilePath(
            childWorkflowKey,
            childRunRef
          )
        )
      );
      const runsRoot = path.dirname(childLineageDir);
      const listRuns = async () =>
        (await fs.readdir(childLineageDir)).filter((entry) =>
          entry.startsWith("run-")
        );
      const lineagesBefore = (await fs.readdir(runsRoot)).sort();
      const childRunsBefore = await listRuns();
      assert.deepStrictEqual(childRunsBefore, [childRunRef]);

      await fs.writeFile(sentinel, "go");
      await parent.executeContinuationAtRun(
        parentState.workflowKey!,
        parentState.runRef!,
        parentState.definitionRevision
      );

      const resumedState = parent.promptQueue.getState();
      assert.strictEqual(
        resumedState.status,
        "completed",
        JSON.stringify(resumedState.results)
      );
      const resumedStep = resumedState.steps[0];
      assert.ok(isSubWorkflowStep(resumedStep));
      assert.strictEqual(
        resumedStep._runtime?.childWorkflowKey,
        childWorkflowKey
      );
      assert.strictEqual(resumedStep._runtime?.childRunRef, childRunRef);
      assert.deepStrictEqual(await listRuns(), childRunsBefore);
      assert.deepStrictEqual(
        (await fs.readdir(runsRoot)).sort(),
        lineagesBefore
      );
      assert.strictEqual(await fs.readFile(marker, "utf8"), "ran\n");
      const continuedChild = instances[instances.length - 1];
      assert.notStrictEqual(continuedChild, child);
      assert.strictEqual(
        continuedChild.promptQueue.getState().status,
        "completed"
      );
      assert.strictEqual(
        continuedChild.promptQueue.getState().runRef,
        childRunRef
      );
      // A child continued by D6 re-runs the step its stop interrupted; the
      // sentinel lets that second run finish.
      assert.strictEqual(
        continuedChild.promptQueue.getState().results[1]?.status,
        STEP_STATUS.COMPLETED
      );
      const childManifest = await new TimelineRecorder().readManifest(
        parent.outputHistoryManager.getHistoryFilePath(
          childWorkflowKey,
          childRunRef
        )
      );
      assert.strictEqual(childManifest.executionState, "completed");

      // An explicit re-run seeds a new parent run with clean step runtime, so
      // its workflow step launches a fresh child instead of reattaching.
      const seeded = await WorkingFileManager.seedNewRun(
        workspace,
        parentState.workflowKey!,
        parentState.runRef!,
        {},
        undefined,
        undefined,
        EXECUTION_STATES.RUNNING
      );
      await parent.executeSeededRun(seeded, parentState.workflowKey!);
      const rerunState = parent.promptQueue.getState();
      assert.strictEqual(rerunState.runRef, seeded.runRef);
      assert.strictEqual(
        rerunState.status,
        "completed",
        JSON.stringify(rerunState.results)
      );
      const rerunStep = rerunState.steps[0];
      assert.ok(isSubWorkflowStep(rerunStep));
      const rerunChildKey = rerunStep._runtime?.childWorkflowKey;
      const rerunChildRunRef = rerunStep._runtime?.childRunRef;
      assert.ok(rerunChildKey && rerunChildRunRef);
      assert.notStrictEqual(rerunChildRunRef, childRunRef);
      const rerunChildManifest = await new TimelineRecorder().readManifest(
        parent.outputHistoryManager.getHistoryFilePath(
          rerunChildKey,
          rerunChildRunRef
        )
      );
      assert.deepStrictEqual(rerunChildManifest.parentRun, {
        workflowKey: parentState.workflowKey,
        runRef: seeded.runRef,
        phase: FINAL_STEP_PHASES.QUEUE,
        stepId: rerunStep._runtime?.stepId,
      });
      assert.strictEqual(await fs.readFile(marker, "utf8"), "ran\nran\n");
    } finally {
      for (const instance of instances) {
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      removeTempDir(workspace);
    }
  });

  test("inherits a managed parent's worktree when worktree is absent and honors false", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-inherit-");
    const instances: WorkflowInstance[] = [];
    try {
      execFileSync("git", ["init", workspace], { stdio: "ignore" });
      execFileSync("git", ["-C", workspace, "config", "user.name", "Tests"]);
      execFileSync("git", [
        "-C",
        workspace,
        "config",
        "user.email",
        "tests@example.com",
      ]);
      await fs.writeFile(path.join(workspace, "tracked.txt"), "base\n");
      execFileSync("git", ["-C", workspace, "add", "."]);
      execFileSync("git", ["-C", workspace, "commit", "-m", "initial"]);

      const platform = new MockPlatform(workspace);
      const integrationFactory = new MockIntegrationFactory(platform);
      const detector = new MockHarnessIntegration(undefined, false);
      let launcher: SubWorkflowLauncher;
      const createInstance = (childOptions?: {
        ancestorPaths: readonly string[];
        delegationChain: readonly string[];
      }) =>
        buildInstance(
          workspace,
          platform,
          integrationFactory,
          detector,
          launcher,
          childOptions
        );
      launcher = new SubWorkflowLauncher(
        ({ ancestorPaths, delegationChain }) => {
          const instance = createInstance({ ancestorPaths, delegationChain });
          instances.push(instance);
          return instance;
        }
      );
      const childPath = path.join(workspace, "child.ctrlyoke.json");
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await fs.writeFile(
        childPath,
        JSON.stringify({
          steps: [
            {
              type: "script",
              script:
                "node -e \"require('fs').writeFileSync('inherited-marker.txt','yes')\"",
            },
          ],
        })
      );
      await fs.writeFile(
        parentPath,
        JSON.stringify({
          worktree: { mode: "managed", keep: true },
          steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
        })
      );
      execFileSync("git", [
        "-C",
        workspace,
        "add",
        "child.ctrlyoke.json",
        "parent.ctrlyoke.json",
      ]);
      execFileSync("git", ["-C", workspace, "commit", "-m", "add workflows"]);
      const parent = createInstance();
      instances.push(parent);
      await parent.loadPromptFile(parentPath);
      await parent.executeLoadedPromptFile();
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      const worktreePaths = execFileSync(
        "git",
        ["-C", workspace, "worktree", "list", "--porcelain"],
        { encoding: "utf8" }
      )
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9));
      const worktree = worktreePaths.find(
        (candidate) => candidate !== workspace
      );
      assert.ok(worktree, "managed parent should create a linked worktree");
      assert.ok(await fs.stat(path.join(worktree, "inherited-marker.txt")));
      await assert.rejects(
        fs.access(path.join(workspace, "inherited-marker.txt"))
      );

      await fs.writeFile(
        childPath,
        JSON.stringify({
          worktree: false,
          steps: [
            {
              type: "script",
              script:
                "node -e \"require('fs').writeFileSync('main-marker.txt','yes')\"",
            },
          ],
        })
      );
      execFileSync("git", ["-C", workspace, "add", "child.ctrlyoke.json"]);
      execFileSync("git", [
        "-C",
        workspace,
        "commit",
        "-m",
        "disable child worktree",
      ]);
      const secondParent = createInstance();
      instances.push(secondParent);
      await secondParent.loadPromptFile(parentPath);
      await secondParent.executeLoadedPromptFile();
      assert.ok(await fs.stat(path.join(workspace, "main-marker.txt")));
      assert.strictEqual(
        secondParent.promptQueue.getState().status,
        "completed"
      );
    } finally {
      for (const instance of instances) {
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      removeTempDir(workspace);
    }
  });

  test("runs child scripts, links child runs, and fails through a child failure or cycle", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-");
    const instances: WorkflowInstance[] = [];
    try {
      const platform = new MockPlatform(workspace);
      const integrationFactory = new MockIntegrationFactory(platform);
      const detector = new MockHarnessIntegration(undefined, false);
      let launcher: SubWorkflowLauncher;
      const createInstance = (childOptions?: {
        ancestorPaths: readonly string[];
        delegationChain: readonly string[];
      }) =>
        buildInstance(
          workspace,
          platform,
          integrationFactory,
          detector,
          launcher,
          childOptions
        );
      launcher = new SubWorkflowLauncher(
        ({ ancestorPaths, delegationChain }) => {
          const child: WorkflowInstance = createInstance({
            ancestorPaths,
            delegationChain,
          });
          instances.push(child);
          return child;
        }
      );

      const root = path.join(workspace, "root.ctrlyoke.json");
      const child = path.join(workspace, "child.ctrlyoke.json");
      const grandchild = path.join(workspace, "grandchild.ctrlyoke.json");
      const writeWorkflow = (filePath: string, steps: unknown[]) =>
        fs.writeFile(
          filePath,
          JSON.stringify({ name: path.basename(filePath), steps })
        );
      await writeWorkflow(child, [
        { type: "script", script: 'node -e "process.exit(0)"' },
      ]);
      await writeWorkflow(root, [
        { type: "workflow", workflow: "child.ctrlyoke.json" },
      ]);
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(root), true);
      await parent.executeLoadedPromptFile();
      assert.strictEqual(parent.promptQueue.getState().status, "completed");
      const childStep = parent.promptQueue.getState().steps[0];
      assert.ok(isSubWorkflowStep(childStep));
      const childRuntime = childStep._runtime;
      assert.ok(childRuntime?.childWorkflowKey);
      assert.ok(childRuntime?.childRunRef);
      const childManifest = await new TimelineRecorder().readManifest(
        instances[0].outputHistoryManager.getHistoryFilePath(
          childRuntime!.childWorkflowKey!,
          childRuntime!.childRunRef!
        )
      );
      assert.strictEqual(
        childManifest.parentRun?.workflowKey,
        parent.promptQueue.getState().workflowKey
      );
      assert.strictEqual(
        childManifest.parentRun?.runRef,
        parent.getExecutionRunRef()
      );
      assert.deepStrictEqual(childManifest.parentRun, {
        workflowKey: parent.promptQueue.getState().workflowKey,
        runRef: parent.getExecutionRunRef(),
        phase: FINAL_STEP_PHASES.QUEUE,
        stepId: childRuntime?.stepId,
      });

      await writeWorkflow(child, [
        { type: "script", script: 'node -e "process.exit(0)"' },
      ]);
      await fs.writeFile(
        root,
        JSON.stringify({
          steps: [{ type: "script", script: 'node -e "process.exit(0)"' }],
          finalStep: {
            type: "workflow",
            workflow: "child.ctrlyoke.json",
          },
        })
      );
      const finalStepParent = createInstance();
      instances.push(finalStepParent);
      assert.strictEqual(await finalStepParent.loadPromptFile(root), true);
      await finalStepParent.executeLoadedPromptFile();
      assert.strictEqual(
        finalStepParent.promptQueue.getState().status,
        "completed",
        JSON.stringify(finalStepParent.promptQueue.getState().results)
      );
      const finalRuntime = finalStepParent.promptQueue.getWorkflowFile()
        .finalStep as {
        _runtime?: { childWorkflowKey?: string; childRunRef?: string };
      };
      assert.ok(finalRuntime._runtime?.childWorkflowKey);
      assert.ok(finalRuntime._runtime?.childRunRef);
      const finalChildManifest = await new TimelineRecorder().readManifest(
        instances[instances.length - 1].outputHistoryManager.getHistoryFilePath(
          finalRuntime._runtime!.childWorkflowKey! as never,
          finalRuntime._runtime!.childRunRef! as never
        )
      );
      assert.deepStrictEqual(finalChildManifest.parentRun, {
        workflowKey: finalStepParent.promptQueue.getState().workflowKey,
        runRef: finalStepParent.getExecutionRunRef(),
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: 0,
      });
      await writeWorkflow(root, [
        { type: "workflow", workflow: "child.ctrlyoke.json" },
      ]);

      await writeWorkflow(child, [
        { type: "script", script: 'node -e "process.exit(1)"' },
      ]);
      const failingParent = createInstance();
      instances.push(failingParent);
      await failingParent.loadPromptFile(root);
      await failingParent.executeLoadedPromptFile();
      assert.strictEqual(failingParent.promptQueue.getState().status, "error");
      assert.strictEqual(
        failingParent.promptQueue.getState().results[0].status,
        STEP_STATUS.FAILED
      );

      await writeWorkflow(root, [
        { type: "workflow", workflow: "child.ctrlyoke.json" },
      ]);
      await writeWorkflow(child, [
        { type: "workflow", workflow: "grandchild.ctrlyoke.json" },
      ]);
      await writeWorkflow(grandchild, [
        { type: "workflow", workflow: "root.ctrlyoke.json" },
      ]);
      const cyclicParent = createInstance();
      instances.push(cyclicParent);
      await cyclicParent.loadPromptFile(root);
      await cyclicParent.executeLoadedPromptFile();
      const errorMessages = instances.flatMap((instance) =>
        instance.promptQueue
          .getState()
          .steps.map((step) => step._runtime?.failureMessage ?? "")
      );
      assert.ok(
        errorMessages.some((message) =>
          message.includes(
            "Sub-workflow cycle detected: root.ctrlyoke.json → child.ctrlyoke.json → grandchild.ctrlyoke.json → root.ctrlyoke.json"
          )
        ),
        errorMessages.join("\n")
      );
    } finally {
      for (const instance of instances) {
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      removeTempDir(workspace);
    }
  });

  test("a workflow file queued as a sub-workflow while the run is RUNNING runs as a child at the next boundary", async () => {
    const workspace = makeTempDir("ctrlyoke-queue-subworkflow-");
    const { createInstance, instances, childAt } =
      makeInstanceFactory(workspace);
    try {
      const childMarker = path.join(workspace, "child-ran");
      const childPath = path.join(workspace, "flows", "child.ctrlyoke.json");
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await fs.mkdir(path.dirname(childPath), { recursive: true });
      await writeJson(childPath, {
        steps: [
          {
            type: "script",
            script:
              "node -e \"require('fs').writeFileSync('" +
              childMarker.replace(/\\/g, "\\\\") +
              "','yes')\"",
          },
        ],
      });
      await writeJson(parentPath, {
        steps: [{ type: "script", script: sentinelScript("first-ran", "go") }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "first-ran"));
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.RUNNING
      );

      await parent.appendFromFile(
        childPath,
        QUEUE_POSITION.END,
        buildSubWorkflowReferenceStep(childPath, workspace)
      );

      const queued = parent.promptQueue.getState().steps;
      assert.strictEqual(queued.length, 2);
      assert.ok(isSubWorkflowStep(queued[1]));
      assert.strictEqual(queued[1].type, STEP_TYPES.WORKFLOW);
      assert.strictEqual(queued[1].workflow, "flows/child.ctrlyoke.json");
      assert.strictEqual(
        instances.length,
        1,
        "no child starts before the running step finishes"
      );

      await fs.writeFile(path.join(workspace, "go"), "");
      await execution;

      const state = parent.promptQueue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.COMPLETED);
      assert.strictEqual(state.results[1].status, STEP_STATUS.COMPLETED);
      assert.strictEqual(
        childAt(1).promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      assert.strictEqual(await fs.readFile(childMarker, "utf8"), "yes");
      const childRef = childRunRefOf(state.steps[1]);
      assert.ok(childRef, "the workflow step records its child run");
      assert.strictEqual(childRef, childAt(1).promptQueue.getState().runRef);
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("runs and records a self-contained inline script child", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-subworkflow-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Inline parent",
        vars: { value: "from-parent" },
        steps: [
          {
            type: "workflow",
            workflow: {
              type: "script",
              script:
                "node -e \"require('fs').writeFileSync('inline-result.txt','{{value}}')\"",
            },
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();
      assert.strictEqual(parent.promptQueue.getState().status, "completed");
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "inline-result.txt"), "utf8"),
        "from-parent"
      );
      const state = parent.promptQueue.getState();
      const events = await new TimelineRecorder().readEvents(
        parent.outputHistoryManager.getHistoryFilePath(
          state.workflowKey!,
          state.runRef!
        )
      );
      assert.ok(
        events.some(
          (event) =>
            event.eventType === TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED
        )
      );
      assert.deepStrictEqual(
        instances[1]!.promptQueue.getWorkflowFile().steps?.length,
        1
      );
      assert.strictEqual(
        instances[1]!.promptQueue.getWorkflowFile().vars?.value,
        "from-parent"
      );
    } finally {
      for (const instance of instances) {
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      removeTempDir(workspace);
    }
  });

  test("reattaches an inline child run without a source file", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-reattach-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      const waiting = path.join(workspace, "inline-waiting");
      const sentinel = path.join(workspace, "inline-sentinel");
      const script =
        "node -e \"const fs=require('fs');fs.writeFileSync('inline-waiting','y');const t=setInterval(()=>{if(fs.existsSync('inline-sentinel')){clearInterval(t);process.exit(0)}},50)\"";
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: { type: "script", script } }],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(waiting);
      const child = instances[instances.length - 1]!;
      const identity = child.promptQueue.getState();
      await parent.stop();
      await execution;
      await fs.writeFile(sentinel, "go");
      await parent.executeContinuationAtRun(
        parent.promptQueue.getState().workflowKey!,
        parent.promptQueue.getState().runRef!,
        parent.promptQueue.getState().definitionRevision
      );
      assert.strictEqual(parent.promptQueue.getState().status, "completed");
      const reattached = instances[instances.length - 1]!;
      assert.notStrictEqual(reattached, child);
      assert.strictEqual(
        reattached.promptQueue.getState().workflowKey,
        identity.workflowKey
      );
      assert.strictEqual(
        reattached.promptQueue.getState().runRef,
        identity.runRef
      );
      const childRunsDirectory = path.dirname(
        path.dirname(
          parent.outputHistoryManager.getHistoryFilePath(
            identity.workflowKey!,
            identity.runRef!
          )
        )
      );
      assert.strictEqual(
        (await fs.readdir(childRunsDirectory)).filter((entry) =>
          entry.startsWith("run-")
        ).length,
        1
      );
    } finally {
      for (const instance of instances) {
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      removeTempDir(workspace);
    }
  });
  /** A one-commit git repository, so a managed worktree can branch from it. */
  function initGitRepository(workspace: string): void {
    execFileSync("git", ["init", workspace], { stdio: "ignore" });
    execFileSync("git", ["-C", workspace, "config", "user.name", "Tests"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "tests@example.com",
    ]);
  }

  function commitAll(workspace: string, message: string): void {
    execFileSync("git", ["-C", workspace, "add", "."]);
    execFileSync("git", ["-C", workspace, "commit", "-m", message], {
      stdio: "ignore",
    });
  }

  /** The child launched by `parent`'s step, identified by its runtime link. */
  function launchedChild(
    instances: readonly WorkflowInstance[],
    parent: WorkflowInstance,
    stepIndex = 0
  ): WorkflowInstance {
    const step = parent.promptQueue.getState().steps[stepIndex];
    assert.ok(isSubWorkflowStep(step));
    const child = instances.find(
      (instance) =>
        instance !== parent &&
        instance.promptQueue.getState().runRef === step._runtime?.childRunRef
    );
    assert.ok(child, "the step's child instance");
    return child;
  }

  test("an inline child without worktree runs in its managed parent's worktree", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(120_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-inline-inherit-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        worktree: { mode: "managed", keep: true },
        steps: [
          {
            type: "workflow",
            workflow: {
              type: "script",
              script:
                "node -e \"require('fs').writeFileSync('inline-cwd.txt',process.cwd())\"",
            },
          },
        ],
      });
      commitAll(workspace, "add parent");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      const worktree = execFileSync(
        "git",
        ["-C", workspace, "worktree", "list", "--porcelain"],
        { encoding: "utf8" }
      )
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .find(
          (candidate) =>
            path.resolve(candidate) !== path.resolve(workspace) &&
            candidate !== workspace
        );
      assert.ok(worktree, "the managed parent created a linked worktree");
      const ranIn = await fs.readFile(
        path.join(worktree, "inline-cwd.txt"),
        "utf8"
      );
      assert.strictEqual(await fs.realpath(ranIn), await fs.realpath(worktree));
      await assert.rejects(fs.access(path.join(workspace, "inline-cwd.txt")));
      assert.strictEqual(
        launchedChild(instances, parent).promptQueue.getState().status,
        "completed"
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
    }
  });

  test("an inline child resolves references and trust from its parent's file", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-definition-");
    const recorder = new MockHarnessIntegration(undefined, false);
    const seenDefinitionPaths: (string | undefined)[] = [];
    recorder.prepareSentPrompt = (prompt, workflowContext) => {
      seenDefinitionPaths.push(workflowContext?.sourceDefinitionPath);
      return prompt.prompt;
    };
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      recorder
    );
    try {
      const flows = path.join(workspace, "flows");
      const external = makeTempDir("ctrlyoke-inline-external-");
      await fs.mkdir(flows, { recursive: true });
      await fs.writeFile(path.join(flows, "notes.prompt.md"), "FROM-FLOWS");
      // A workspace-root decoy: resolving without the parent's file finds it.
      await fs.writeFile(path.join(workspace, "notes.prompt.md"), "WRONG");
      const parentPath = path.join(flows, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        trustedExternalRoots: [external],
        steps: [
          { type: "workflow", workflow: { prompt: "./notes.prompt.md" } },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      assert.deepStrictEqual(recorder.sentPrompts, ["FROM-FLOWS"]);
      assert.deepStrictEqual(seenDefinitionPaths, [parentPath]);

      const child = launchedChild(instances, parent);
      assert.strictEqual(child.getWorkflowTrustSourcePath(), parentPath);
      // Approvals recorded for the parent's file alone reach the child.
      const parentIdentity =
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          workspace,
          parentPath
        );
      const trustStore = {
        getApprovedRoots: (identity: string, roots: readonly string[]) =>
          identity === parentIdentity ? [...roots] : [],
        getPendingRoots: () => [],
      };
      const effectiveRoots = (instance: WorkflowInstance) => {
        const context = HarnessAdapterUtils.getWorkflowExternalRootsContext(
          workspace,
          {
            sourceDefinitionPath: instance.getWorkflowTrustSourcePath(),
            stateRoot: workspace,
            workflowFile: instance.promptQueue.getWorkflowFile(),
          }
        );
        assert.ok(context);
        return ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          context.workspaceIdentity,
          { identity: context.identity, declaredRoots: context.declaredRoots },
          trustStore
        );
      };
      assert.deepStrictEqual(effectiveRoots(parent), [external]);
      assert.deepStrictEqual(effectiveRoots(child), effectiveRoots(parent));
      removeTempDir(external);
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a template parent's inline child shares its trust identity but gets no reference base", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-template-");
    const external = makeTempDir("ctrlyoke-inline-template-external-");
    const recorder = new MockHarnessIntegration(undefined, false);
    const seen: Array<{
      sourceDefinitionPath?: string;
      workflowTrustSourcePath?: string;
    }> = [];
    recorder.prepareSentPrompt = (prompt, workflowContext) => {
      seen.push({
        sourceDefinitionPath: workflowContext?.sourceDefinitionPath,
        workflowTrustSourcePath: workflowContext?.workflowTrustSourcePath,
      });
      return prompt.prompt;
    };
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      recorder
    );
    try {
      const parent = createInstance();
      instances.push(parent);
      await parent.loadFromTemplate(
        {
          trustedExternalRoots: [external],
          steps: [{ type: "workflow", workflow: { prompt: "hello" } }],
        },
        "Review loop"
      );
      await parent.executeLoadedPromptFile();
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      const child = launchedChild(instances, parent);
      const parentIdentityPath = parent.getWorkflowTrustSourcePath();
      assert.ok(parentIdentityPath);
      assert.strictEqual(
        child.getWorkflowTrustSourcePath(),
        parentIdentityPath
      );
      // The harness sees the parent's identity for trust, and no file to
      // resolve `./` references against: the template has none.
      assert.deepStrictEqual(seen, [
        {
          sourceDefinitionPath: undefined,
          workflowTrustSourcePath: parentIdentityPath,
        },
      ]);

      const parentIdentity =
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          workspace,
          parentIdentityPath
        );
      const trustStore = {
        getApprovedRoots: (identity: string, roots: readonly string[]) =>
          identity === parentIdentity ? [...roots] : [],
        getPendingRoots: () => [],
      };
      const effectiveRoots = (instance: WorkflowInstance) => {
        const context = HarnessAdapterUtils.getWorkflowExternalRootsContext(
          workspace,
          {
            workflowTrustSourcePath: instance.getWorkflowTrustSourcePath(),
            stateRoot: workspace,
            workflowFile: instance.promptQueue.getWorkflowFile(),
          }
        );
        assert.ok(context);
        return ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          context.workspaceIdentity,
          { identity: context.identity, declaredRoots: context.declaredRoots },
          trustStore
        );
      };
      assert.deepStrictEqual(effectiveRoots(parent), [external]);
      assert.deepStrictEqual(effectiveRoots(child), [external]);

      // `./x` in the child fails exactly as it does in a template step.
      const runTemplate = async (step: object): Promise<WorkflowInstance> => {
        const instance = createInstance();
        instances.push(instance);
        await instance.loadFromTemplate(
          { steps: [step as never] },
          "Review loop"
        );
        await instance.executeLoadedPromptFile();
        assert.strictEqual(instance.promptQueue.getState().status, "error");
        return instance;
      };
      const direct = await runTemplate({ prompt: "./notes.prompt.md" });
      const inlineParent = await runTemplate({
        type: "workflow",
        workflow: { prompt: "./notes.prompt.md" },
      });
      const inlineChild = launchedChild(instances, inlineParent);
      assert.strictEqual(inlineChild.promptQueue.getState().status, "error");
      const directError = direct.promptQueue.getState().results[0].error;
      assert.ok(directError);
      assert.strictEqual(
        inlineChild.promptQueue.getState().results[0].error,
        directError
      );
      assert.strictEqual(seen.length, 1, "neither ./x prompt was sent");
    } finally {
      removeTempDir(external);
      await disposeAll(instances, workspace);
    }
  });

  test("a continued inline child stays in its managed parent's worktree and later inline steps resolve from the parent's folder", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(120_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-inline-continue-worktree-");
    // Outside the repository, so probing never dirties either checkout.
    const probe = makeTempDir("ctrlyoke-inline-continue-probe-");
    const recorder = new MockHarnessIntegration(undefined, false);
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      recorder
    );
    try {
      initGitRepository(workspace);
      const flows = path.join(workspace, "flows");
      await fs.mkdir(flows, { recursive: true });
      await fs.writeFile(path.join(flows, "notes.prompt.md"), "FROM-FLOWS");
      // A root decoy: losing the parent's folder as the base finds it.
      await fs.writeFile(path.join(workspace, "notes.prompt.md"), "WRONG");
      const probeDir = probe.replace(/\\/g, "\\\\");
      const waitScript =
        "node -e \"const fs=require('fs');fs.appendFileSync('" +
        probeDir +
        "/cwd',process.cwd()+'\\n');const t=setInterval(()=>{if(fs.existsSync('" +
        probeDir +
        "/sentinel')){clearInterval(t);process.exit(0)}},50)\"";
      const parentPath = path.join(flows, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        worktree: { mode: "managed", keep: true },
        steps: [
          {
            type: "workflow",
            workflow: { type: "script", script: waitScript },
          },
          { type: "workflow", workflow: { prompt: "./notes.prompt.md" } },
        ],
      });
      commitAll(workspace, "add parent");

      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(probe, "cwd"));
      await withoutStopFallback(async () => {
        await parent.stop();
        await execution;
      });
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      const stoppedChild = launchedChild(instances, parent);
      const childRunRef = stoppedChild.promptQueue.getState().runRef;

      await fs.writeFile(path.join(probe, "sentinel"), "go");
      const state = parent.promptQueue.getState();
      await parent.executeContinuationAtRun(
        state.workflowKey!,
        state.runRef!,
        state.definitionRevision
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );

      // The step still names the stopped child's run, and a second instance
      // continued that run rather than launching a new lineage.
      assert.strictEqual(
        launchedChild(instances, parent).promptQueue.getState().runRef,
        childRunRef
      );
      const continued = instances.filter(
        (instance) =>
          instance !== stoppedChild &&
          instance.promptQueue.getState().runRef === childRunRef
      );
      assert.strictEqual(
        continued.length,
        1,
        "the stopped child is reattached"
      );
      assert.strictEqual(
        continued[0].promptQueue.getState().status,
        "completed"
      );

      const worktree = execFileSync(
        "git",
        ["-C", workspace, "worktree", "list", "--porcelain"],
        { encoding: "utf8" }
      )
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .find(
          (candidate) => path.resolve(candidate) !== path.resolve(workspace)
        );
      assert.ok(worktree, "the managed parent created a linked worktree");
      const cwds = (await fs.readFile(path.join(probe, "cwd"), "utf8"))
        .split("\n")
        .filter(Boolean);
      assert.strictEqual(cwds.length, 2, "ran once, then once more continued");
      for (const cwd of cwds) {
        assert.strictEqual(await fs.realpath(cwd), await fs.realpath(worktree));
      }
      assert.deepStrictEqual(recorder.sentPrompts, ["FROM-FLOWS"]);
    } finally {
      restoreGitTimeouts();
      await fs.writeFile(path.join(probe, "sentinel"), "go").catch(() => {});
      await disposeAll(instances, workspace);
      removeTempDir(probe);
    }
  });

  test("a continued inline child re-resolves its ./ reference from the parent's folder and keeps the parent's trust identity", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-continue-base-");
    const recorder = new MockHarnessIntegration(undefined, false);
    // The child's first send fails, so its run ends in ERROR and the parent's
    // continuation (D6) continues that run, re-running the prompt step.
    let sends = 0;
    recorder.onSend = async () => {
      sends += 1;
      return sends === 1 ? { success: false } : { success: true };
    };
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      recorder
    );
    try {
      const flows = path.join(workspace, "flows");
      await fs.mkdir(flows, { recursive: true });
      await fs.writeFile(path.join(flows, "notes.prompt.md"), "FROM-FLOWS");
      // A root decoy: losing the parent's folder as the base finds it.
      await fs.writeFile(path.join(workspace, "notes.prompt.md"), "WRONG");
      const parentPath = path.join(flows, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        errorBehavior: { onError: "stopWorkflow" },
        steps: [
          { type: "workflow", workflow: { prompt: "./notes.prompt.md" } },
        ],
      });

      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();
      assert.notStrictEqual(parent.promptQueue.getState().status, "completed");
      const failedChild = launchedChild(instances, parent);
      assert.strictEqual(failedChild.promptQueue.getState().status, "error");
      const childRunRef = failedChild.promptQueue.getState().runRef;

      const state = parent.promptQueue.getState();
      await parent.executeContinuationAtRun(
        state.workflowKey!,
        state.runRef!,
        state.definitionRevision
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );

      const continued = instances.filter(
        (instance) =>
          instance !== parent &&
          instance !== failedChild &&
          instance.promptQueue.getState().runRef === childRunRef
      );
      assert.strictEqual(continued.length, 1, "the failed child is continued");
      const child = continued[0];
      assert.strictEqual(child.promptQueue.getState().status, "completed");
      // The re-run step resolved `./` beside the parent's file again.
      assert.deepStrictEqual(recorder.sentPrompts, [
        "FROM-FLOWS",
        "FROM-FLOWS",
      ]);
      // Its restored lineage records no source file: both come from the parent.
      assert.strictEqual(child.getSourceDefinitionPath(), parentPath);
      assert.ok(parent.getWorkflowTrustSourcePath());
      assert.strictEqual(
        child.getWorkflowTrustSourcePath(),
        parent.getWorkflowTrustSourcePath()
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("an inline child checks exported assets beside its parent's file", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-assets-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    const missingAssetWarnings = async (child: WorkflowInstance) => {
      const state = child.promptQueue.getState();
      const events = await new TimelineRecorder().readEvents(
        child.outputHistoryManager.getHistoryFilePath(
          state.workflowKey!,
          state.runRef!
        )
      );
      return events
        .filter(
          (event) =>
            event.eventType === TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED
        )
        .map(
          (event) =>
            (event.payload as { statusMessage: { message: string } })
              .statusMessage.message
        )
        .filter((message) => message.includes("missing exported assets"));
    };
    const runParent = async (): Promise<WorkflowInstance> => {
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();
      assert.strictEqual(
        parent.promptQueue.getState().status,
        "completed",
        JSON.stringify(parent.promptQueue.getState().results)
      );
      return launchedChild(instances, parent);
    };
    const flows = path.join(workspace, "flows");
    const assets = path.join(flows, "parent.assets");
    const parentPath = path.join(flows, "parent.ctrlyoke.json");
    try {
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(assets, "x.md"), "asset");
      // No `parent.assets` at the workspace root.
      await writeJson(parentPath, {
        steps: [
          {
            type: "workflow",
            workflow: { prompt: "Review @./parent.assets/x.md" },
          },
        ],
      });
      assert.deepStrictEqual(await missingAssetWarnings(await runParent()), []);

      await fs.rm(assets, { recursive: true, force: true });
      const warnings = await missingAssetWarnings(await runParent());
      assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
      assert.match(
        warnings[0],
        /missing exported assets: flows\/parent\.assets\./
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("an inline child gets a host var override substituted exactly once, named and linked without a path", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-vars-");
    const recorder = new MockHarnessIntegration(undefined, false);
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      recorder
    );
    try {
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Vars parent",
        vars: { value: "authored", other: "EXPANDED", blank: "" },
        steps: [
          {
            type: "workflow",
            name: "check {{value}} in src/core",
            workflow: {
              type: "script",
              script:
                "node -e \"require('fs').writeFileSync('inline-var.txt','{{value}}')\"",
            },
          },
          {
            type: "workflow",
            // Substitutes to nothing: the default label, not the `{{…}}` text.
            name: "{{blank}}",
            workflow: { prompt: "say {{value}}" },
          },
        ],
        finalStep: {
          type: "workflow",
          workflow: { prompt: "final {{value}}" },
        },
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      // What `ctrlyoke run --var` does after loading.
      const workflowFile = parent.promptQueue.getWorkflowFile();
      parent.promptQueue.updateWorkflowProperty("vars", {
        ...workflowFile.vars,
        value: "cli-{{other}}",
      });
      await parent.promptQueue.updateWorkingFile(true);
      await parent.executeLoadedPromptFile();
      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "inline-var.txt"), "utf8"),
        "cli-{{other}}"
      );
      assert.deepStrictEqual(recorder.sentPrompts, [
        "say cli-{{other}}",
        "final cli-{{other}}",
      ]);

      assert.strictEqual(
        launchedChild(instances, parent, 0).promptQueue.getState().workflowName,
        // Substituted once, with the host override: not "cli-EXPANDED".
        "check cli-{{other}} in src/core"
      );
      assert.strictEqual(
        launchedChild(instances, parent, 1).promptQueue.getState().workflowName,
        "Vars parent · step 2"
      );
      const finalRuntime = (
        parent.promptQueue.getWorkflowFile().finalStep as {
          _runtime?: { childRunRef?: string };
        }
      )._runtime;
      const finalChild = instances.find(
        (instance) =>
          instance.promptQueue.getState().runRef === finalRuntime?.childRunRef
      );
      assert.strictEqual(
        finalChild?.promptQueue.getState().workflowName,
        "Vars parent · final step pass 1"
      );

      for (const step of state.steps) {
        assert.ok(isSubWorkflowStep(step));
        assert.ok(step._runtime?.childRunRef);
        assert.ok(!("resolvedWorkflowPath" in (step._runtime ?? {})));
      }
      const events = await new TimelineRecorder().readEvents(
        parent.outputHistoryManager.getHistoryFilePath(
          state.workflowKey!,
          state.runRef!
        )
      );
      const settled = events.filter(
        (event) => event.eventType === TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED
      );
      assert.strictEqual(settled.length, 3);
      for (const event of settled) {
        assert.ok(!("resolvedWorkflowPath" in (event.payload as object)));
      }
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("an inline step whose name does not substitute fails before any child is named", async () => {
    const workspace = makeTempDir("ctrlyoke-inline-name-error-");
    const recorder = new MockHarnessIntegration(undefined, false);
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      recorder
    );
    try {
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Names parent",
        steps: [
          {
            type: "workflow",
            // `{{missing}}` is undefined, so the name does not substitute.
            name: "{{missing}} lane",
            workflow: { prompt: "hello" },
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();
      // The step substitutes as a whole before launching, so the undefined
      // variable fails it and no child takes the `{{…}}` text as its name
      // (`substituteInlineStepName` covers a caller that names first).
      const state = parent.promptQueue.getState();
      assert.notStrictEqual(state.status, "completed");
      assert.match(
        state.results[0]?.error ?? "",
        /variable "missing"/,
        JSON.stringify(state.results)
      );
      assert.deepStrictEqual(
        instances.filter((instance) => instance !== parent),
        []
      );
      assert.deepStrictEqual(recorder.sentPrompts, []);
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  /**
   * A lane script: marks itself started, then waits for every named sibling
   * to start too, so it can only succeed when the lanes run side by side.
   * With no siblings it holds until stopped.
   */
  async function writeLaneScript(workspace: string): Promise<void> {
    await fs.writeFile(
      path.join(workspace, "lane.js"),
      [
        "const fs = require('fs');",
        "const [self, ...others] = process.argv.slice(2);",
        "fs.writeFileSync(self + '-started', '');",
        "if (others.length === 0) {",
        "  setInterval(() => {}, 60000);",
        "} else {",
        "  const deadline = Date.now() + 15000;",
        "  const timer = setInterval(() => {",
        "    if (others.every((other) => fs.existsSync(other + '-started'))) {",
        "      clearInterval(timer);",
        "      process.exit(0);",
        "    }",
        "    if (Date.now() > deadline) process.exit(1);",
        "  }, 25);",
        "}",
      ].join("\n")
    );
  }

  function childRunRefOf(step: WorkflowStep | undefined): string | undefined {
    return step && isSubWorkflowStep(step)
      ? step._runtime?.childRunRef
      : undefined;
  }

  /** Each `subWorkflowSettled` outcome the parent recorded, in step order. */
  async function settledOutcomesByStep(
    parent: WorkflowInstance
  ): Promise<Array<{ stepIndex: number; outcome: unknown }>> {
    const state = parent.promptQueue.getState();
    const events = await new TimelineRecorder().readEvents(
      parent.outputHistoryManager.getHistoryFilePath(
        state.workflowKey!,
        state.runRef!
      )
    );
    return events
      .flatMap((event) =>
        event.eventType === TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED &&
        event.target?.kind === FINAL_STEP_PHASES.QUEUE
          ? [
              {
                stepIndex: event.target.stepIndex,
                outcome: event.payload.outcome,
              },
            ]
          : []
      )
      .sort((left, right) => left.stepIndex - right.stepIndex);
  }

  const inlineLane = (
    name: string,
    script: string,
    extra: Record<string, unknown> = {}
  ) => ({
    type: "workflow",
    name,
    workflow: { type: "script", script, ...extra },
  });

  test("runs inline script lanes side by side and records each on its own member target", async () => {
    const workspace = makeTempDir("ctrlyoke-parallel-lanes-");
    const { createInstance, instances, concurrentLaunches } =
      makeInstanceFactory(workspace);
    try {
      await writeLaneScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Lanes",
        steps: [
          {
            parallel: [
              inlineLane("Lane A", "node lane.js a b"),
              inlineLane("Lane B", "node lane.js b a"),
            ],
            failFast: false,
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      assert.deepStrictEqual(concurrentLaunches, [true, true]);
      for (const stepIndex of [0, 1]) {
        assert.strictEqual(
          launchedChild(instances, parent, stepIndex).promptQueue.getState()
            .status,
          "completed"
        );
      }
      const events = await new TimelineRecorder().readEvents(
        parent.outputHistoryManager.getHistoryFilePath(
          state.workflowKey!,
          state.runRef!
        )
      );
      const settled = events.filter(
        (event) => event.eventType === TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED
      );
      assert.deepStrictEqual(
        settled
          .map((event) => ({
            target: event.target,
            childRunRef: (event.payload as { childRunRef?: string })
              .childRunRef,
          }))
          .sort(
            (left, right) =>
              (left.target as { stepIndex: number }).stepIndex -
              (right.target as { stepIndex: number }).stepIndex
          ),
        [0, 1].map((stepIndex) => ({
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
          childRunRef: childRunRefOf(state.steps[stepIndex]),
        }))
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("stopping the parent stops every running lane", async () => {
    const workspace = makeTempDir("ctrlyoke-parallel-lanes-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeLaneScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              inlineLane("Lane A", "node lane.js a"),
              inlineLane("Lane B", "node lane.js b"),
            ],
            failFast: false,
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-started"));
      await waitForFile(path.join(workspace, "b-started"));
      // Each lane's script is running; wait until the parent has recorded
      // both children (their handles are attached) and both are RUNNING.
      await waitFor("both lanes attached and running", () =>
        [0, 1].every((stepIndex) => {
          const childRunRef = childRunRefOf(
            parent.promptQueue.getState().steps[stepIndex]
          );
          return instances.some(
            (instance) =>
              instance !== parent &&
              childRunRef !== undefined &&
              instance.promptQueue.getState().runRef === childRunRef &&
              instance.promptQueue.getState().status ===
                EXECUTION_STATES.RUNNING
          );
        })
      );
      await withoutStopFallback(async () => {
        await parent.stop();
        await execution;
      });

      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(parentStops(), 1, "parent confirmed STOPPED once");
      assert.strictEqual(await readExecutionState(parent), "stopped");
      for (const stepIndex of [0, 1]) {
        assert.strictEqual(
          launchedChild(instances, parent, stepIndex).promptQueue.getState()
            .status,
          "stopped"
        );
      }
      assert.deepStrictEqual(
        await settledOutcomesByStep(parent),
        [0, 1].map((stepIndex) => ({
          stepIndex,
          outcome: {
            status: PROMPT_TERMINAL_STATUS.CANCELLED,
            cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT,
          },
        }))
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a failing lane cancels its running sibling under failFast and fails the parent", async () => {
    const workspace = makeTempDir("ctrlyoke-parallel-lanes-failfast-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeLaneScript(workspace);
      await fs.writeFile(
        path.join(workspace, "fail.js"),
        "const fs = require('fs');" +
          "const t = setInterval(() => {" +
          "if (fs.existsSync('b-started')) { clearInterval(t); process.exit(1); }" +
          "}, 25);"
      );
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              inlineLane("Failing lane", "node fail.js"),
              inlineLane("Held lane", "node lane.js b"),
            ],
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      await withoutStopFallback(() => parent.executeLoadedPromptFile());

      const state = parent.promptQueue.getState();
      // The sibling's cancellation came from the group, so the group fails
      // for the failing lane's reason under its onFail (stopWorkflow), as it
      // would with prompt members, instead of stopping the parent.
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.ERROR,
        JSON.stringify(state.results)
      );
      assert.strictEqual(await readExecutionState(parent), "error");
      assert.strictEqual(
        launchedChild(instances, parent, 1).promptQueue.getState().status,
        "stopped"
      );
      assert.deepStrictEqual(
        state.steps.map((step) => step._runtime?.terminalStatus),
        [PROMPT_TERMINAL_STATUS.FAILED, PROMPT_TERMINAL_STATUS.CANCELLED]
      );
      assert.match(state.results[0].error ?? "", /exited with code 1/);
      const settled = await settledOutcomesByStep(parent);
      assert.deepStrictEqual(
        settled.map(({ stepIndex, outcome }) => ({
          stepIndex,
          status: (outcome as { status: string }).status,
        })),
        [
          { stepIndex: 0, status: PROMPT_TERMINAL_STATUS.FAILED },
          { stepIndex: 1, status: PROMPT_TERMINAL_STATUS.CANCELLED },
        ]
      );
      assert.strictEqual(
        (settled[1].outcome as { cancelledBy?: string }).cancelledBy,
        SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT,
        "a fail-fast-stopped lane is a sibling cancellation, not a user stop"
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  /** `node gate.js <name>` records each run, then exits once <name>-go exists. */
  async function writeGateScript(workspace: string): Promise<void> {
    await fs.writeFile(
      path.join(workspace, "gate.js"),
      [
        "const fs = require('fs');",
        "const name = process.argv[2];",
        "fs.appendFileSync(name + '-runs', 'ran\\n');",
        "const timer = setInterval(() => {",
        "  if (fs.existsSync(name + '-go')) {",
        "    clearInterval(timer);",
        "    process.exit(0);",
        "  }",
        "}, 25);",
      ].join("\n")
    );
  }

  /** The newest instance running a parent step's recorded child run. */
  function laneChildOf(
    instances: readonly WorkflowInstance[],
    parent: WorkflowInstance,
    stepIndex: number
  ): WorkflowInstance | undefined {
    const childRunRef = childRunRefOf(
      parent.promptQueue.getState().steps[stepIndex]
    );
    return [...instances]
      .reverse()
      .find(
        (instance) =>
          instance !== parent &&
          childRunRef !== undefined &&
          instance.promptQueue.getState().runRef === childRunRef
      );
  }

  /**
   * Wait until each lane's child runs and its gate script (`lanes`, by name)
   * has started: a stop that lands before the script spawns is not the stop
   * these tests are about.
   */
  async function waitForLanesRunning(
    workspace: string,
    instances: readonly WorkflowInstance[],
    parent: WorkflowInstance,
    lanes: Readonly<Record<number, string>>
  ): Promise<void> {
    const stepIndices = Object.keys(lanes).map(Number);
    for (const stepIndex of stepIndices) {
      await waitForFile(path.join(workspace, `${lanes[stepIndex]}-runs`));
    }
    await waitFor("every lane attached and running", () =>
      stepIndices.every(
        (stepIndex) =>
          laneChildOf(instances, parent, stepIndex)?.promptQueue.getState()
            .status === EXECUTION_STATES.RUNNING
      )
    );
  }

  /**
   * "Run alongside the current step": promote the running step into a group
   * with `step` and start it beside the anchor, through the same queue and
   * executor seams `executeEphemeralParallelPrompt` uses.
   */
  async function promoteBesideRunningStep(
    parent: WorkflowInstance,
    step: Record<string, unknown>,
    failFast: boolean
  ): Promise<void> {
    const insertion = await parent.promptQueue.promoteStepToParallelGroup(
      parent.promptQueue.getState().currentIndex,
      step as unknown as WorkflowStep,
      { failFast }
    );
    const join = await parent.workflowExecutor.joinRunningParallelGroup(
      insertion.stepIndex
    );
    assert.ok(join.accepted, JSON.stringify(join));
  }

  const AFTER_SCRIPT_STEP = {
    type: "script",
    script: "node -e \"require('fs').writeFileSync('after','')\"",
  };

  /**
   * Run `members` (a three-member group, then AFTER_SCRIPT_STEP) at width 2
   * and pause it while the first two (gates `a` and `b`) run: the group stops
   * dispatching the third and returns `paused` with the head still inside
   * it. Then stop, and check the stop confirms and a continue re-enters the
   * group, running only its unstarted member.
   */
  async function stopsRunPausedInsideGroup(
    prefix: string,
    members: readonly Record<string, unknown>[],
    waitForMembersRunning: (
      workspace: string,
      instances: readonly WorkflowInstance[],
      parent: WorkflowInstance
    ) => Promise<void>
  ): Promise<void> {
    const workspace = makeTempDir(prefix);
    const { createInstance, instances } = makeInstanceFactory(workspace);
    configService.setCliOverlay({ queue: { maxParallelSteps: 2 } });
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ parallel: members, failFast: false }, AFTER_SCRIPT_STEP],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForMembersRunning(workspace, instances, parent);

      await parent.pause();
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await fs.writeFile(path.join(workspace, "b-go"), "");
      await settlesWithin("the paused execution", execution);
      const paused = parent.promptQueue.getState();
      assert.strictEqual(
        paused.status,
        EXECUTION_STATES.PAUSED,
        JSON.stringify(paused.results)
      );
      assert.strictEqual(paused.currentIndex, 0, "the head stays in the group");
      assert.deepStrictEqual(
        paused.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED, STEP_STATUS.PENDING]
      );

      const cancellations = recordAttemptCancellations(parent);
      await withoutStopFallback(() => settlesWithin("the stop", parent.stop()));
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(parentStops(), 1);
      assert.deepStrictEqual(cancellations(), [], "no attempt was cancelled");
      // The stop cancelled nothing: the settled members stay COMPLETED and the
      // unstarted one stays pending for the Continue.
      assert.deepStrictEqual(
        stopped.results.slice(0, 4).map((result) => result.status),
        [
          STEP_STATUS.COMPLETED,
          STEP_STATUS.COMPLETED,
          STEP_STATUS.PENDING,
          STEP_STATUS.PENDING,
        ]
      );
      // No executor finalizes this run: the transition reaches the manifest
      // through the instance's queued history write.
      const deadline = Date.now() + 10000;
      let manifestState = await readExecutionState(parent);
      while (manifestState !== "stopped" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        manifestState = await readExecutionState(parent);
      }
      assert.strictEqual(manifestState, "stopped");
      assert.strictEqual(stopped.currentIndex, 0);
      await assert.rejects(fs.access(path.join(workspace, "c-ran")));

      // A continue re-enters the group: the settled members are recovered,
      // only the unstarted one runs, and the run then moves past the group.
      configService.setCliOverlay({});
      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent))
      );
      const resumed = parent.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      assert.deepStrictEqual(
        resumed.results.slice(0, 4).map((result) => result.status),
        [
          STEP_STATUS.COMPLETED,
          STEP_STATUS.COMPLETED,
          STEP_STATUS.COMPLETED,
          STEP_STATUS.COMPLETED,
        ]
      );
      assert.strictEqual(await countLines(path.join(workspace, "a-runs")), 1);
      assert.strictEqual(await countLines(path.join(workspace, "b-runs")), 1);
      await fs.access(path.join(workspace, "c-ran"));
      await fs.access(path.join(workspace, "after"));
    } finally {
      configService.setCliOverlay({});
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(workspace, "b-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  }

  const WRITE_C_RAN = "node -e \"require('fs').writeFileSync('c-ran','')\"";

  test("stopping a top-level run paused inside a parallel group confirms STOPPED, and a continue re-enters the group", async () => {
    await stopsRunPausedInsideGroup(
      "ctrlyoke-paused-group-stop-",
      [
        { type: "script", script: "node gate.js a" },
        { type: "script", script: "node gate.js b" },
        { type: "script", script: WRITE_C_RAN },
      ],
      async (workspace) => {
        await waitForFile(path.join(workspace, "a-runs"));
        await waitForFile(path.join(workspace, "b-runs"));
      }
    );
  });

  test("stopping a parent paused inside a group of lanes confirms STOPPED, and a continue re-enters the group", async () => {
    await stopsRunPausedInsideGroup(
      "ctrlyoke-paused-lane-group-stop-",
      [
        inlineLane("Lane A", "node gate.js a"),
        inlineLane("Lane B", "node gate.js b"),
        inlineLane("Lane C", WRITE_C_RAN),
      ],
      (workspace, instances, parent) =>
        waitForLanesRunning(workspace, instances, parent, { 0: "a", 1: "b" })
    );
  });

  test("stopping a sequential run paused at a step boundary keeps its next step pending, and a continue runs it", async () => {
    const workspace = makeTempDir("ctrlyoke-paused-sequential-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          { type: "script", script: "node gate.js a" },
          { type: "script", script: WRITE_C_RAN },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-runs"));

      await parent.pause();
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await settlesWithin("the paused execution", execution);
      const paused = parent.promptQueue.getState();
      assert.strictEqual(paused.status, EXECUTION_STATES.PAUSED);
      assert.strictEqual(paused.currentIndex, 1);

      const cancellations = recordAttemptCancellations(parent);
      await withoutStopFallback(() => settlesWithin("the stop", parent.stop()));
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(parentStops(), 1);
      assert.deepStrictEqual(cancellations(), [], "no attempt was cancelled");
      assert.strictEqual(
        stopped.currentIndex,
        1,
        "the next step is not skipped"
      );
      assert.deepStrictEqual(
        stopped.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.PENDING, STEP_STATUS.PENDING]
      );
      await assert.rejects(fs.access(path.join(workspace, "c-ran")));

      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent))
      );
      const resumed = parent.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      assert.deepStrictEqual(
        resumed.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED]
      );
      assert.strictEqual(await countLines(path.join(workspace, "a-runs")), 1);
      await fs.access(path.join(workspace, "c-ran"));
      await fs.access(path.join(workspace, "after"));
    } finally {
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("a stop landing as a parallel group confirms PAUSED waits for it to unwind instead of the detector", async () => {
    const workspace = makeTempDir("ctrlyoke-paused-group-unwind-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    configService.setCliOverlay({ queue: { maxParallelSteps: 2 } });
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              { type: "script", script: "node gate.js a" },
              { type: "script", script: "node gate.js b" },
              { type: "script", script: WRITE_C_RAN },
            ],
            failFast: false,
          },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-runs"));
      await waitForFile(path.join(workspace, "b-runs"));

      // Stop the moment the group confirms PAUSED, while the executor is
      // still unwinding from it.
      const cancellations = recordAttemptCancellations(parent);
      let stop: Promise<void> | undefined;
      let liveAtStop: boolean | undefined;
      parent.promptQueue.onDidChangeState((state) => {
        if (stop || state.status !== EXECUTION_STATES.PAUSED) return;
        liveAtStop = parent.workflowExecutor.hasLiveExecution();
        stop = parent.stop();
      });
      await withoutStopFallback(async () => {
        await parent.pause();
        await fs.writeFile(path.join(workspace, "a-go"), "");
        await fs.writeFile(path.join(workspace, "b-go"), "");
        await settlesWithin("the paused execution", execution);
        await waitFor("the stop to start", () => stop !== undefined);
        await settlesWithin("the stop", stop!);
      });
      assert.strictEqual(liveAtStop, true, "the stop landed mid-unwind");
      assert.deepStrictEqual(cancellations(), [], "no attempt was cancelled");
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(stopped.currentIndex, 0);
      assert.deepStrictEqual(
        stopped.results.slice(0, 4).map((result) => result.status),
        [
          STEP_STATUS.COMPLETED,
          STEP_STATUS.COMPLETED,
          STEP_STATUS.PENDING,
          STEP_STATUS.PENDING,
        ]
      );
      await assert.rejects(fs.access(path.join(workspace, "c-ran")));
    } finally {
      configService.setCliOverlay({});
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(workspace, "b-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  /**
   * Run a two-member gated group (a third member unstarted, a step after
   * it), pause it, and run `press` the moment the group confirms PAUSED,
   * while the executor is still unwinding from the pause. Whatever `press`
   * does, it must end the run STOPPED with nothing cancelled and nothing
   * skipped, without stop()'s 10 s fallback, and a later Continue must run
   * the rest. Returns the feedback the instance raised meanwhile.
   */
  async function pressesWhileAPauseUnwinds(
    prefix: string,
    press: (parent: WorkflowInstance) => Promise<void>[]
  ): Promise<UserFeedback[]> {
    const workspace = makeTempDir(prefix);
    const feedback = new RecordingFeedbackSink();
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      undefined,
      undefined,
      undefined,
      feedback
    );
    configService.setCliOverlay({ queue: { maxParallelSteps: 2 } });
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              { type: "script", script: "node gate.js a" },
              { type: "script", script: "node gate.js b" },
              { type: "script", script: WRITE_C_RAN },
            ],
            failFast: false,
          },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-runs"));
      await waitForFile(path.join(workspace, "b-runs"));

      const cancellations = recordAttemptCancellations(parent);
      let presses: Promise<void>[] | undefined;
      let unsettledAtPress: boolean | undefined;
      parent.promptQueue.onDidChangeState((state) => {
        if (presses || state.status !== EXECUTION_STATES.PAUSED) return;
        // The paused execution has not settled (it clears startPending).
        unsettledAtPress = parent.startPending;
        presses = press(parent);
      });
      await withoutStopFallback(async () => {
        await parent.pause();
        await fs.writeFile(path.join(workspace, "a-go"), "");
        await fs.writeFile(path.join(workspace, "b-go"), "");
        await settlesWithin("the paused execution", execution);
        await waitFor("the presses", () => presses !== undefined);
        for (const pressed of presses!) {
          await settlesWithin("a press", pressed);
        }
      });
      assert.strictEqual(unsettledAtPress, true, "pressed mid-unwind");
      assert.deepStrictEqual(cancellations(), [], "no attempt was cancelled");
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(stopped.currentIndex, 0);
      assert.deepStrictEqual(
        stopped.results.slice(0, 4).map((result) => result.status),
        [
          STEP_STATUS.COMPLETED,
          STEP_STATUS.COMPLETED,
          STEP_STATUS.PENDING,
          STEP_STATUS.PENDING,
        ]
      );
      await assert.rejects(fs.access(path.join(workspace, "c-ran")));
      const raised = [...feedback.notices];

      // Nothing was skipped: a later Continue runs the unstarted member.
      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent))
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      await fs.access(path.join(workspace, "c-ran"));
      await fs.access(path.join(workspace, "after"));
      return raised;
    } finally {
      configService.setCliOverlay({});
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(workspace, "b-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  }

  const continueIgnoredNotice: UserFeedback = {
    severity: USER_FEEDBACK_SEVERITY.INFO,
    message: PAUSED_STOP_IGNORES_CONTINUE_MESSAGE,
  };

  test("a Continue pressed while a stop waits for a pause to unwind is ignored with a notice, and the stop cancels nothing", async () => {
    const raised = await pressesWhileAPauseUnwinds(
      "ctrlyoke-paused-stop-continue-race-",
      (parent) => [parent.stop(), parent.resume()]
    );
    assert.deepStrictEqual(raised, [continueIgnoredNotice]);
  });

  test("a stop pressed after a Continue, while the pause still unwinds, stops the paused run and cancels nothing", async () => {
    const raised = await pressesWhileAPauseUnwinds(
      "ctrlyoke-paused-continue-stop-unwind-",
      (parent) => [parent.resume(), parent.stop()]
    );
    // The Continue came first, so it was not ignored: the stop overtook it.
    assert.deepStrictEqual(raised, []);
  });

  test("a second stop of a paused run while its pause unwinds joins the first and cancels nothing", async () => {
    await pressesWhileAPauseUnwinds(
      "ctrlyoke-paused-double-stop-unwind-",
      (parent) => [parent.stop(), parent.stop()]
    );
  });

  test("a second stop of an idle paused run joins the first and skips nothing", async () => {
    const workspace = makeTempDir("ctrlyoke-paused-double-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          { type: "script", script: "node gate.js a" },
          { type: "script", script: WRITE_C_RAN },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-runs"));
      await parent.pause();
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await settlesWithin("the paused execution", execution);
      assert.strictEqual(parent.startPending, false, "the pause has settled");

      // A parent's forwarded stop beside a direct one, or a double click.
      const cancellations = recordAttemptCancellations(parent);
      await withoutStopFallback(async () => {
        const first = parent.stop();
        const second = parent.stop();
        await settlesWithin("the second stop", second);
        await settlesWithin("the first stop", first);
      });
      assert.deepStrictEqual(cancellations(), [], "no attempt was cancelled");
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(stopped.status, EXECUTION_STATES.STOPPED);
      assert.strictEqual(stopped.currentIndex, 1);
      assert.deepStrictEqual(
        stopped.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.PENDING, STEP_STATUS.PENDING]
      );

      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent))
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      await fs.access(path.join(workspace, "c-ran"));
    } finally {
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("a stop landing after a Continue resumed a paused run, before its setup began, stops it without skipping the next step", async () => {
    const workspace = makeTempDir("ctrlyoke-paused-continue-stop-race-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          { type: "script", script: "node gate.js a" },
          { type: "script", script: WRITE_C_RAN },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-runs"));
      await parent.pause();
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await settlesWithin("the paused execution", execution);
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.PAUSED
      );

      // Continue makes the run RUNNING at once but begins its setup only
      // after persisting that; the stop lands in between.
      const cancellations = recordAttemptCancellations(parent);
      await withoutStopFallback(async () => {
        const resume = parent.resume();
        assert.strictEqual(
          parent.promptQueue.getState().status,
          EXECUTION_STATES.RUNNING
        );
        await settlesWithin("the stop", parent.stop());
        await settlesWithin("the overtaken continue", resume);
      });
      assert.deepStrictEqual(cancellations(), [], "no attempt was cancelled");
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(stopped.currentIndex, 1);
      assert.deepStrictEqual(
        stopped.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.PENDING, STEP_STATUS.PENDING]
      );
      await assert.rejects(fs.access(path.join(workspace, "c-ran")));

      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent))
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      await fs.access(path.join(workspace, "c-ran"));
      await fs.access(path.join(workspace, "after"));
    } finally {
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("disposing a lane's child paused inside a group stops the parent at the join and keeps the child's pause", async () => {
    const workspace = makeTempDir("ctrlyoke-paused-lane-dispose-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      // Lane A's child pauses at the boundary after its first step.
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [
          { type: "script", script: "node gate.js a" },
          {
            type: "script",
            script: "node -e \"require('fs').writeFileSync('a-after','')\"",
          },
        ],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              { type: "workflow", workflow: "child.ctrlyoke.json" },
              inlineLane("Lane B", "node gate.js b"),
            ],
            failFast: false,
          },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForLanesRunning(workspace, instances, parent, {
        0: "a",
        1: "b",
      });
      const pausedChild = laneChildOf(instances, parent, 0)!;

      await parent.pause();
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await fs.writeFile(path.join(workspace, "b-go"), "");
      await waitForChildPausedCycle(pausedChild);
      await waitFor(
        "lane B to settle",
        () =>
          parent.promptQueue.getState().results[1]?.status ===
          STEP_STATUS.COMPLETED
      );
      // The paused lane never finishes on its own: the parent waits PAUSING.
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.PAUSING
      );

      pausedChild.dispose();
      await withoutStopFallback(() =>
        settlesWithin("the parent's execution", execution)
      );
      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(state.results)
      );
      assert.deepStrictEqual(
        state.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.CANCELLED, STEP_STATUS.COMPLETED, STEP_STATUS.PENDING]
      );
      assert.strictEqual(await readExecutionState(pausedChild), "paused");
      await assert.rejects(fs.access(path.join(workspace, "a-after")));
      await assert.rejects(fs.access(path.join(workspace, "after")));
    } finally {
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(workspace, "b-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("stopping one lane's child directly lets its sibling finish, stops the parent at the join, and a continue reattaches that lane", async () => {
    const workspace = makeTempDir("ctrlyoke-parallel-lane-user-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              inlineLane("Stopped lane", "node gate.js a"),
              inlineLane("Sibling lane", "node gate.js b"),
            ],
            failFast: true,
          },
          {
            type: "script",
            script: "node -e \"require('fs').writeFileSync('after','')\"",
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-runs"));
      await waitForFile(path.join(workspace, "b-runs"));
      const childOf = (stepIndex: number) =>
        laneChildOf(instances, parent, stepIndex);
      await waitFor("both lanes attached and running", () =>
        [0, 1].every(
          (stepIndex) =>
            childOf(stepIndex)?.promptQueue.getState().status ===
            EXECUTION_STATES.RUNNING
        )
      );
      const stoppedChild = childOf(0)!;
      const siblingChild = childOf(1)!;
      const stoppedChildRunRef = stoppedChild.promptQueue.getState().runRef;

      await withoutStopFallback(() => stoppedChild.stop());
      await waitFor(
        "the stopped lane settles CANCELLED",
        () =>
          parent.promptQueue.getState().results[0]?.status ===
          STEP_STATUS.CANCELLED
      );
      // Only that member settled: the parent keeps running its sibling, and
      // even failFast does not cancel it, because nothing failed.
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.RUNNING
      );
      assert.strictEqual(
        siblingChild.promptQueue.getState().status,
        EXECUTION_STATES.RUNNING
      );

      await fs.writeFile(path.join(workspace, "b-go"), "");
      await withoutStopFallback(() => execution);

      const stoppedState = parent.promptQueue.getState();
      assert.strictEqual(
        stoppedState.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stoppedState.results)
      );
      assert.strictEqual(parentStops(), 1, "parent confirmed STOPPED once");
      assert.strictEqual(await readExecutionState(parent), "stopped");
      assert.deepStrictEqual(
        stoppedState.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.CANCELLED, STEP_STATUS.COMPLETED, STEP_STATUS.PENDING]
      );
      assert.strictEqual(
        siblingChild.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      await assert.rejects(fs.access(path.join(workspace, "after")));
      assert.deepStrictEqual(await settledOutcomesByStep(parent), [
        {
          stepIndex: 0,
          outcome: {
            status: PROMPT_TERMINAL_STATUS.CANCELLED,
            cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
          },
        },
        {
          stepIndex: 1,
          outcome: { status: PROMPT_TERMINAL_STATUS.COMPLETED },
        },
      ]);

      // Continuing recovers the completed sibling and reattaches the stopped
      // lane to its recorded child (D6), which re-runs its interrupted step.
      const launchesBefore = instances.length;
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await parent.executeContinuationAtRun(
        stoppedState.workflowKey!,
        stoppedState.runRef!,
        stoppedState.definitionRevision
      );

      const resumed = parent.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      assert.deepStrictEqual(
        resumed.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED]
      );
      assert.strictEqual(childRunRefOf(resumed.steps[0]), stoppedChildRunRef);
      assert.strictEqual(
        instances.length,
        launchesBefore + 1,
        "only the stopped lane launched again"
      );
      const continuedChild = instances[instances.length - 1];
      assert.strictEqual(
        continuedChild.promptQueue.getState().runRef,
        stoppedChildRunRef
      );
      assert.strictEqual(
        continuedChild.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "a-runs"), "utf8"),
        "ran\nran\n"
      );
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "b-runs"), "utf8"),
        "ran\n"
      );
      await fs.access(path.join(workspace, "after"));
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a lane stopped directly before a host restart is reattached when the restarted parent continues", async () => {
    const workspace = makeTempDir("ctrlyoke-parallel-lane-restart-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              inlineLane("Sibling lane", "node gate.js b"),
              inlineLane("Stopped lane", "node gate.js a"),
            ],
            failFast: true,
          },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForLanesRunning(workspace, instances, parent, {
        0: "b",
        1: "a",
      });
      const laneRunRefs = [0, 1].map((stepIndex) =>
        childRunRefOf(parent.promptQueue.getState().steps[stepIndex])
      );

      await withoutStopFallback(() =>
        laneChildOf(instances, parent, 1)!.stop()
      );
      const { workflowKey, runRef, workingFilePath } =
        parent.promptQueue.getState();
      const readParentFile = async () =>
        JSON.parse(await fs.readFile(workingFilePath!, "utf8")) as {
          definitionRevision?: number;
          steps: WorkflowStep[];
        };
      // The host dies here: the stopped lane's CANCELLED is on disk, its
      // sibling is still running, and the group never joined.
      const deadline = Date.now() + 10000;
      let crashed = await fs.readFile(workingFilePath!, "utf8");
      while (
        (JSON.parse(crashed) as { steps: WorkflowStep[] }).steps[1]._runtime
          ?.terminalStatus !== PROMPT_TERMINAL_STATUS.CANCELLED
      ) {
        assert.ok(Date.now() < deadline, "the stopped lane reaches disk");
        await new Promise((resolve) => setTimeout(resolve, 20));
        crashed = await fs.readFile(workingFilePath!, "utf8");
      }
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.RUNNING
      );
      const crashedSteps = (JSON.parse(crashed) as { steps: WorkflowStep[] })
        .steps;
      assert.strictEqual(crashedSteps[0]._runtime?.completedAt, undefined);

      // This process lives on, so end the old host's execution and put back
      // the run file as the crash left it; a restarted host would reclaim
      // the dead process's runner lock, so remove it the same way.
      await withoutStopFallback(async () => {
        await parent.stop();
        await execution;
      });
      for (const instance of instances) {
        await instance.whenExecutionSettled();
        instance.dispose();
      }
      await fs.writeFile(workingFilePath!, crashed);
      await fs.rm(WorkflowPaths.runnerLockPath(workspace, workflowKey!), {
        force: true,
      });

      const restarted = createInstance();
      instances.push(restarted);
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await fs.writeFile(path.join(workspace, "b-go"), "");
      await withoutStopFallback(() =>
        restarted.executeContinuationAtRun(
          workflowKey!,
          runRef!,
          (JSON.parse(crashed) as { definitionRevision?: number })
            .definitionRevision ?? 1
        )
      );

      const resumed = restarted.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      assert.deepStrictEqual(
        resumed.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED]
      );
      // Both lanes reattached to their recorded child runs (D6) and re-ran
      // the step the stop or the restart interrupted.
      assert.deepStrictEqual(
        [0, 1].map((stepIndex) => childRunRefOf(resumed.steps[stepIndex])),
        laneRunRefs
      );
      for (const stepIndex of [0, 1]) {
        assert.strictEqual(
          laneChildOf(instances, restarted, stepIndex)?.promptQueue.getState()
            .status,
          EXECUTION_STATES.COMPLETED
        );
      }
      for (const lane of ["a", "b"]) {
        assert.strictEqual(
          await fs.readFile(path.join(workspace, `${lane}-runs`), "utf8"),
          "ran\nran\n",
          lane
        );
      }
      assert.deepStrictEqual(
        (await readParentFile()).steps
          .slice(0, 2)
          .map((step) => step._runtime?.terminalStatus),
        [PROMPT_TERMINAL_STATUS.COMPLETED, PROMPT_TERMINAL_STATUS.COMPLETED]
      );
      await fs.access(path.join(workspace, "after"));
    } finally {
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(workspace, "b-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("a promoted workflow anchor whose child is stopped directly lets its sibling finish and stops the parent at the join", async () => {
    const workspace = makeTempDir("ctrlyoke-promoted-anchor-user-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [inlineLane("Anchor lane", "node gate.js a"), AFTER_SCRIPT_STEP],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForLanesRunning(workspace, instances, parent, { 0: "a" });
      await promoteBesideRunningStep(
        parent,
        inlineLane("Sibling lane", "node gate.js b"),
        false
      );
      await waitForLanesRunning(workspace, instances, parent, {
        0: "a",
        1: "b",
      });
      const anchorChild = laneChildOf(instances, parent, 0)!;
      const siblingChild = laneChildOf(instances, parent, 1)!;
      const anchorRunRef = anchorChild.promptQueue.getState().runRef;

      await withoutStopFallback(() => anchorChild.stop());
      await waitFor(
        "the anchor settles CANCELLED",
        () =>
          parent.promptQueue.getState().results[0]?.status ===
          STEP_STATUS.CANCELLED
      );
      // The anchor follows the member rule although it runs on the
      // sequential path: its sibling keeps running.
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.RUNNING
      );
      assert.strictEqual(
        siblingChild.promptQueue.getState().status,
        EXECUTION_STATES.RUNNING
      );

      await fs.writeFile(path.join(workspace, "b-go"), "");
      await withoutStopFallback(() => execution);
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(parentStops(), 1, "parent confirmed STOPPED once");
      assert.deepStrictEqual(
        stopped.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.CANCELLED, STEP_STATUS.COMPLETED, STEP_STATUS.PENDING]
      );
      await assert.rejects(fs.access(path.join(workspace, "after")));
      assert.deepStrictEqual((await settledOutcomesByStep(parent))[0], {
        stepIndex: 0,
        outcome: {
          status: PROMPT_TERMINAL_STATUS.CANCELLED,
          cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
        },
      });

      await fs.writeFile(path.join(workspace, "a-go"), "");
      await withoutStopFallback(() => continueParent(parent));
      const resumed = parent.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      assert.strictEqual(childRunRefOf(resumed.steps[0]), anchorRunRef);
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "a-runs"), "utf8"),
        "ran\nran\n"
      );
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "b-runs"), "utf8"),
        "ran\n"
      );
      await fs.access(path.join(workspace, "after"));
    } finally {
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(workspace, "b-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("fail-fast cancels a promoted workflow anchor as a sibling and fails the parent", async () => {
    const workspace = makeTempDir("ctrlyoke-promoted-anchor-failfast-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [inlineLane("Anchor lane", "node gate.js a"), AFTER_SCRIPT_STEP],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForLanesRunning(workspace, instances, parent, { 0: "a" });
      const anchorChild = laneChildOf(instances, parent, 0)!;
      await promoteBesideRunningStep(
        parent,
        {
          type: "script",
          name: "Failing sibling",
          script: 'node -e "process.exit(1)"',
        },
        true
      );
      await withoutStopFallback(() => execution);

      const state = parent.promptQueue.getState();
      // The anchor's cancel came from the group, so the group fails for the
      // failing member's reason under its onFail instead of stopping.
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.ERROR,
        JSON.stringify(state.results)
      );
      assert.strictEqual(parentStops(), 0);
      assert.strictEqual(await readExecutionState(parent), "error");
      assert.strictEqual(
        anchorChild.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      assert.deepStrictEqual(
        state.results.slice(0, 2).map((result) => result.status),
        [STEP_STATUS.CANCELLED, STEP_STATUS.FAILED]
      );
      assert.deepStrictEqual((await settledOutcomesByStep(parent))[0], {
        stepIndex: 0,
        outcome: {
          status: PROMPT_TERMINAL_STATUS.CANCELLED,
          cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT,
        },
      });
      await assert.rejects(fs.access(path.join(workspace, "after")));
    } finally {
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("fail-fast cancels a promoted prompt anchor as a sibling and fails the parent", async () => {
    const workspace = makeTempDir("ctrlyoke-promoted-prompt-anchor-failfast-");
    const harness = new HeldResponseHarnessIntegration(undefined, false);
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      harness
    );
    try {
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          { prompt: "a turn that only a cancel ends" },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitFor(
        "the anchor to wait on its AI response",
        () =>
          harness.sentPrompts.length === 1 &&
          parent.workflowExecutor.isAwaitingResponse()
      );
      await promoteBesideRunningStep(
        parent,
        {
          type: "script",
          name: "Failing sibling",
          script: 'node -e "process.exit(1)"',
        },
        true
      );
      await withoutStopFallback(() => settlesWithin("the parent", execution));

      const state = parent.promptQueue.getState();
      // Cancelled by the group like a dispatched member, so its cancel does
      // not read as a completed turn, and the group fails for the failure.
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.ERROR,
        JSON.stringify(state.results)
      );
      assert.deepStrictEqual(
        state.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.CANCELLED, STEP_STATUS.FAILED, STEP_STATUS.PENDING]
      );
      await assert.rejects(fs.access(path.join(workspace, "after")));
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a stale join mark from a stopped cycle does not stop the parent when fail-fast cancels the re-run anchor", async () => {
    const workspace = makeTempDir("ctrlyoke-promoted-anchor-stale-mark-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    // Width 1: the promotion starts no group run, so nothing consumes the
    // anchor's join mark before the parent stops.
    configService.setCliOverlay({ queue: { maxParallelSteps: 1 } });
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [inlineLane("Anchor lane", "node gate.js a"), AFTER_SCRIPT_STEP],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForLanesRunning(workspace, instances, parent, { 0: "a" });
      const anchorChild = laneChildOf(instances, parent, 0)!;
      await promoteBesideRunningStep(
        parent,
        {
          type: "script",
          name: "Failing sibling",
          script: 'node -e "process.exit(1)"',
        },
        true
      );

      // The parent is stopped while the anchor settles from its child's
      // direct stop: the anchor is marked to stop the parent at the join,
      // and the parent stops before any group run consumes that mark.
      const record = parent.outputHistoryManager.recordSubWorkflowSettled.bind(
        parent.outputHistoryManager
      );
      let parentStop: Promise<void> | undefined;
      parent.outputHistoryManager.recordSubWorkflowSettled = async (
        ...args
      ) => {
        parentStop ??= parent.stop();
        return record(...args);
      };
      await withoutStopFallback(async () => {
        await anchorChild.stop();
        await settlesWithin("the stopped parent", execution);
        await parentStop;
      });
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(stopped.results[0].status, STEP_STATUS.CANCELLED);
      parent.outputHistoryManager.recordSubWorkflowSettled = record;

      // Continue at full width: the anchor re-runs beside its sibling, and
      // the sibling's failure cancels it through fail-fast.
      configService.setCliOverlay({});
      await withoutStopFallback(() =>
        settlesWithin("the continued parent", continueParent(parent))
      );
      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.ERROR,
        JSON.stringify(state.results)
      );
      assert.deepStrictEqual(
        state.results.slice(0, 2).map((result) => result.status),
        [STEP_STATUS.CANCELLED, STEP_STATUS.FAILED]
      );
      await assert.rejects(fs.access(path.join(workspace, "after")));
    } finally {
      configService.setCliOverlay({});
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("stopping the parent while a promoted anchor runs with no group run confirms STOPPED when the anchor settles", async () => {
    const workspace = makeTempDir("ctrlyoke-promoted-anchor-width1-stop-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    // Width 1: the promotion starts no group run, so only the anchor's
    // sequential settlement is left to confirm the stop.
    configService.setCliOverlay({ queue: { maxParallelSteps: 1 } });
    try {
      await writeGateScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          { type: "script", name: "Anchor", script: "node gate.js a" },
          AFTER_SCRIPT_STEP,
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      const parentStops = countStoppedTransitions(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(workspace, "a-runs"));
      await promoteBesideRunningStep(
        parent,
        { type: "script", name: "Sibling", script: WRITE_C_RAN },
        false
      );

      await withoutStopFallback(async () => {
        await settlesWithin("the stop", parent.stop());
        await settlesWithin("the stopped parent", execution);
      });
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.strictEqual(parentStops(), 1);
      assert.deepStrictEqual(
        stopped.results.slice(0, 3).map((result) => result.status),
        [STEP_STATUS.CANCELLED, STEP_STATUS.PENDING, STEP_STATUS.PENDING]
      );
      await assert.rejects(fs.access(path.join(workspace, "c-ran")));
      await assert.rejects(fs.access(path.join(workspace, "after")));

      // A continue at full width re-runs the anchor beside its sibling.
      configService.setCliOverlay({});
      await fs.writeFile(path.join(workspace, "a-go"), "");
      await withoutStopFallback(() =>
        settlesWithin("the continued parent", continueParent(parent))
      );
      const resumed = parent.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      await fs.access(path.join(workspace, "c-ran"));
      await fs.access(path.join(workspace, "after"));
    } finally {
      configService.setCliOverlay({});
      await fs.writeFile(path.join(workspace, "a-go"), "").catch(() => {});
      await disposeAll(instances, workspace);
    }
  });

  test("checkpoints a dirty managed parent once, before any worktree lane loads", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-lanes-checkpoint-");
    const recordDir = makeTempDir("ctrlyoke-lanes-checkpoint-record-");
    const recordPath = path.join(recordDir, "parent-checkout.txt");
    /** The parent checkout's `git status` each time a lane starts loading. */
    const statusAtLaneLoad: string[] = [];
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      undefined,
      async () => {
        const checkout = await fs.readFile(recordPath, "utf8");
        statusAtLaneLoad.push(
          execFileSync("git", ["-C", checkout, "status", "--porcelain"], {
            encoding: "utf8",
          })
        );
      }
    );
    try {
      initGitRepository(workspace);
      await fs.writeFile(
        path.join(workspace, "dirty.js"),
        "require('fs').writeFileSync('dirty.txt', 'unsaved');" +
          "require('fs').writeFileSync(process.argv[2], process.cwd());"
      );
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Checkpointed lanes",
        worktree: { mode: "managed", keep: true },
        steps: [
          { type: "script", script: `node dirty.js "${recordPath}"` },
          {
            parallel: [
              inlineLane("Lane A", "node --version", {
                worktree: { mode: "managed" },
              }),
              inlineLane("Lane B", "node --version", {
                worktree: { mode: "managed" },
              }),
            ],
            failFast: false,
          },
        ],
      });
      commitAll(workspace, "add parent");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      // The group checked once before fan-out: no lane ever saw it dirty.
      assert.deepStrictEqual(statusAtLaneLoad, ["", ""]);
      const checkout = await fs.readFile(recordPath, "utf8");
      const commitsWithDirtyFile = execFileSync(
        "git",
        ["-C", checkout, "log", "--format=%s", "--", "dirty.txt"],
        { encoding: "utf8" }
      )
        .split(/\r?\n/)
        .filter(Boolean);
      assert.strictEqual(commitsWithDirtyFile.length, 1);
      for (const stepIndex of [1, 2]) {
        assert.strictEqual(
          launchedChild(instances, parent, stepIndex).promptQueue.getState()
            .status,
          "completed"
        );
      }
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
      removeTempDir(recordDir);
    }
  });

  test("a dirty user checkout refuses only the worktree lanes, under their onFail", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(120_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-lanes-refuse-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        steps: [
          {
            parallel: [
              {
                ...inlineLane("Worktree lane", "node --version", {
                  worktree: { mode: "managed" },
                }),
                onFail: "continue",
              },
              inlineLane(
                "Shared lane",
                "node -e \"require('fs').writeFileSync('shared.txt','ran')\""
              ),
            ],
            failFast: false,
          },
        ],
      });
      commitAll(workspace, "add parent");
      await fs.writeFile(path.join(workspace, "dirty.txt"), "unsaved");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      assert.match(
        state.steps[0]?._runtime?.failureMessage ?? "",
        /Commit or stash the parent's changes before starting worktree sub-workflows/
      );
      assert.strictEqual(childRunRefOf(state.steps[0]), undefined);
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "shared.txt"), "utf8"),
        "ran"
      );
      assert.strictEqual(
        execFileSync("git", ["-C", workspace, "log", "--format=%s"], {
          encoding: "utf8",
        }).trim(),
        "add parent",
        "ctrlyoke never commits to a checkout the user owns"
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("at width 1 a lane after a member that dirtied the user checkout is refused at its own launch (P6)", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(120_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    configService.setCliOverlay({ queue: { maxParallelSteps: 1 } });
    const workspace = makeTempDir("ctrlyoke-lanes-width1-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await fs.writeFile(
        path.join(workspace, "dirty.js"),
        "require('fs').writeFileSync('dirty.txt', 'unsaved');"
      );
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        steps: [
          {
            parallel: [
              // Runs first and leaves the user's checkout dirty.
              { type: "script", script: "node dirty.js" },
              {
                ...inlineLane("Worktree lane", "node --version", {
                  worktree: { mode: "managed" },
                }),
                onFail: "continue",
              },
            ],
            failFast: false,
          },
        ],
      });
      commitAll(workspace, "add parent");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "dirty.txt"), "utf8"),
        "unsaved"
      );
      // The checkout was clean when the group started; the lane's own launch
      // is what saw the earlier member's edit.
      assert.match(
        state.steps[1]?._runtime?.failureMessage ?? "",
        /Commit or stash the parent's changes before starting worktree sub-workflows/
      );
      assert.strictEqual(
        execFileSync("git", ["-C", workspace, "log", "--format=%s"], {
          encoding: "utf8",
        }).trim(),
        "add parent",
        "ctrlyoke never commits to a checkout the user owns"
      );
    } finally {
      configService.setCliOverlay({});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("a D4a child inside its parent's managed worktree checkpoints it before a worktree grandchild starts", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-d4a-checkpoint-");
    const recordDir = makeTempDir("ctrlyoke-d4a-checkpoint-record-");
    const childCheckoutRecord = path.join(recordDir, "child-checkout.txt");
    const grandchildRecord = path.join(recordDir, "grandchild.json");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      // The child's own step leaves the shared checkout dirty, and records
      // which checkout it ran in.
      await fs.writeFile(
        path.join(workspace, "dirty.js"),
        "require('fs').writeFileSync('dirty.txt', 'unsaved');" +
          "require('fs').writeFileSync(process.argv[2], process.cwd());"
      );
      // The grandchild records where it runs and the shared checkout's state
      // at the moment it starts, which proves the checkpoint came first (the
      // parent's own settlement commits with the same message, but only after
      // the whole run).
      await fs.writeFile(
        path.join(workspace, "grandchild.js"),
        "const fs = require('fs');" +
          "const { execFileSync } = require('child_process');" +
          "const shared = fs.readFileSync(process.argv[3], 'utf8');" +
          "const git = (...args) => execFileSync('git', ['-C', shared, ...args], { encoding: 'utf8' }).trim();" +
          "fs.writeFileSync(process.argv[2], JSON.stringify({" +
          " cwd: process.cwd(), sharedHead: git('rev-parse', 'HEAD')," +
          " sharedStatus: git('status', '--porcelain') }));"
      );
      // No `worktree` key: D4a, so the child shares its parent's checkout and
      // has no managed worktree of its own.
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        name: "Inheriting child",
        steps: [
          { type: "script", script: `node dirty.js "${childCheckoutRecord}"` },
          inlineLane(
            "Grandchild",
            `node grandchild.js "${grandchildRecord}" "${childCheckoutRecord}"`,
            {
              worktree: { mode: "managed", keep: true },
            }
          ),
        ],
      });
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Managed parent",
        worktree: { mode: "managed", keep: true },
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      const child = launchedChild(instances, parent);
      assert.strictEqual(
        child.promptQueue.getState().status,
        "completed",
        JSON.stringify(child.promptQueue.getState().results)
      );

      const sharedCheckout = await fs.realpath(
        await fs.readFile(childCheckoutRecord, "utf8")
      );
      assert.notStrictEqual(
        sharedCheckout,
        await fs.realpath(workspace),
        "the D4a child ran in its parent's managed worktree, not main"
      );
      // The checkpoint is the commit in the shared checkout that added the
      // child's uncommitted file, with settlement's deterministic message.
      const checkpoint = execFileSync(
        "git",
        [
          "-C",
          sharedCheckout,
          "log",
          "--diff-filter=A",
          "--format=%H%x09%s",
          "--",
          "dirty.txt",
        ],
        { encoding: "utf8" }
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [hash, subject] = line.split("\t");
          return { hash, subject };
        });
      assert.strictEqual(checkpoint.length, 1, JSON.stringify(checkpoint));
      assert.strictEqual(
        checkpoint[0]?.subject,
        buildManagedAutoCommitMessage("Managed parent")
      );

      const grandchild = JSON.parse(
        await fs.readFile(grandchildRecord, "utf8")
      ) as { cwd: string; sharedHead: string; sharedStatus: string };
      assert.notStrictEqual(
        await fs.realpath(grandchild.cwd),
        sharedCheckout,
        "the grandchild ran in a worktree of its own"
      );
      assert.strictEqual(
        grandchild.sharedStatus,
        "",
        "the shared checkout was clean when the grandchild started"
      );
      assert.strictEqual(
        grandchild.sharedHead,
        checkpoint[0]?.hash,
        "the checkpoint was committed before the grandchild started"
      );
      // D4b: the grandchild's worktree branches from the shared checkout's
      // checkpoint, targets its branch, and sits beside it under the main
      // checkout's worktrees root rather than in a nested one.
      const grandchildWorktree = await worktreeRuntimeOf(
        launchedChild(instances, child, 1)
      );
      assert.strictEqual(grandchildWorktree.baseCommit, checkpoint[0]?.hash);
      assert.strictEqual(
        await fs.realpath(grandchildWorktree.sourceCheckoutRoot),
        sharedCheckout
      );
      assert.strictEqual(
        grandchildWorktree.targetBranch,
        execFileSync(
          "git",
          ["-C", sharedCheckout, "branch", "--show-current"],
          {
            encoding: "utf8",
          }
        ).trim()
      );
      assert.strictEqual(
        path.dirname(grandchildWorktree.worktreePath),
        path.dirname(sharedCheckout)
      );
      assert.strictEqual(
        path.dirname(sharedCheckout),
        await fs.realpath(`${workspace}.worktrees`)
      );
      assert.strictEqual(
        execFileSync("git", ["-C", workspace, "log", "--format=%s"], {
          encoding: "utf8",
        }).trim(),
        "add workflows",
        "the user's main checkout gets no commit"
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
      removeTempDir(recordDir);
    }
  });

  /** The worktree runtime a run recorded on disk; fails when it has none. */
  async function worktreeRuntimeOf(
    instance: WorkflowInstance
  ): Promise<WorkingFileWorktreeRuntime> {
    const workingFilePath = instance.promptQueue.getState().workingFilePath;
    assert.ok(workingFilePath, "the run has a working file");
    const workingFile = JSON.parse(
      await fs.readFile(workingFilePath, "utf8")
    ) as WorkingFile;
    const worktree = workingFile._runtime?.worktree;
    assert.ok(worktree, "the run recorded a worktree");
    return worktree;
  }

  /** A lane script that writes `lane.txt` in the directory it runs in. */
  async function writeMergeLaneScript(workspace: string): Promise<void> {
    await fs.writeFile(
      path.join(workspace, "merge-lane.js"),
      "require('fs').writeFileSync('lane.txt', 'lane');"
    );
  }

  test("a managed child of a managed parent merges back into the parent's worktree branch, not main", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-d4b-merge-parent-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await writeMergeLaneScript(workspace);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Merging parent",
        worktree: { mode: "managed", keep: true },
        steps: [
          inlineLane("Lane", "node merge-lane.js", {
            worktree: { mode: "managed", merge: true },
          }),
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      const parentWorktree = await worktreeRuntimeOf(parent);
      const laneWorktree = await worktreeRuntimeOf(
        launchedChild(instances, parent)
      );
      assert.strictEqual(
        laneWorktree.mergeOutcome,
        "fast-forward",
        String(laneWorktree.message)
      );
      assert.strictEqual(laneWorktree.targetBranch, parentWorktree.branchName);
      assert.strictEqual(
        path.dirname(laneWorktree.worktreePath),
        path.dirname(parentWorktree.worktreePath)
      );
      assert.strictEqual(
        execFileSync(
          "git",
          [
            "-C",
            parentWorktree.worktreePath,
            "log",
            "--format=%s",
            "--",
            "lane.txt",
          ],
          { encoding: "utf8" }
        ).trim(),
        buildManagedAutoCommitMessage("Lane"),
        "the lane's commit is on the parent's worktree branch"
      );
      assert.strictEqual(
        execFileSync("git", ["-C", workspace, "log", "--format=%s"], {
          encoding: "utf8",
        }).trim(),
        "add workflows",
        "the user's main checkout gets no commit"
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("nested fan-out: a managed child's merging lanes merge into its worktree, which then merges into main", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(240_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-nested-fan-out-");
    const { createInstance, instances, childAt, launchChains } =
      makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await fs.writeFile(
        path.join(workspace, "named-lane.js"),
        "require('fs').writeFileSync(process.argv[2] + '.txt', process.argv[2]);"
      );
      const mergeLane = { worktree: { mode: "managed", merge: true } };
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        name: "Fan-out child",
        worktree: { mode: "managed", merge: true },
        steps: [
          {
            parallel: [
              inlineLane("Lane A", "node named-lane.js a", mergeLane),
              inlineLane("Lane B", "node named-lane.js b", mergeLane),
            ],
            failFast: false,
          },
        ],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Nested parent",
        steps: [
          {
            type: "workflow",
            name: "Fan out",
            workflow: "child.ctrlyoke.json",
          },
        ],
      });
      commitAll(workspace, "add workflows");
      const mainBranch = execFileSync(
        "git",
        ["-C", workspace, "branch", "--show-current"],
        { encoding: "utf8" }
      ).trim();
      const mainHeadBefore = git(workspace, "rev-parse", "HEAD");
      const parent = createInstance();
      instances.push(parent);
      const lines = await runCapturingLog(parent, parentPath);

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.COMPLETED,
        `${JSON.stringify(state.results)}\n${lines.join("\n")}`
      );
      const child = childAt(1);
      const childWorktree = await worktreeRuntimeOf(child);
      const lanes = [0, 1].map((stepIndex) => {
        const lane = laneChildOf(instances, child, stepIndex);
        assert.ok(lane, `lane ${stepIndex + 1} has a child instance`);
        return lane;
      });
      const worktreesRoot = await fs.realpath(`${workspace}.worktrees`);
      // The child branched from main's HEAD, and the group is its first step
      // in a clean worktree (no D4c checkpoint), so its HEAD at fan-out is
      // that same commit. Both lanes must branch from it (D4b), and neither
      // from a commit a faster sibling's merge added to the child's branch.
      assert.strictEqual(childWorktree.baseCommit, mainHeadBefore);
      // The child's worktree is every lane's source checkout and target.
      for (const [index, lane] of lanes.entries()) {
        const laneWorktree = await worktreeRuntimeOf(lane);
        assert.strictEqual(
          laneWorktree.baseCommit,
          childWorktree.baseCommit,
          `lane ${index + 1} branches from the child worktree's HEAD at fan-out`
        );
        assert.ok(
          laneWorktree.mergeOutcome === "fast-forward" ||
            laneWorktree.mergeOutcome === "merge-commit",
          `lane ${index + 1}: ${laneWorktree.mergeOutcome} ${String(laneWorktree.message)}`
        );
        assert.strictEqual(laneWorktree.targetBranch, childWorktree.branchName);
        // Settlement removed both worktrees, so compare the recorded paths.
        assert.strictEqual(
          path.resolve(laneWorktree.sourceCheckoutRoot),
          path.resolve(childWorktree.worktreePath)
        );
        // Under the main checkout's worktrees folder, not a nested one.
        assert.strictEqual(
          path.dirname(laneWorktree.worktreePath),
          path.dirname(childWorktree.worktreePath)
        );
      }
      assert.strictEqual(
        await fs.realpath(path.dirname(childWorktree.worktreePath)),
        worktreesRoot
      );
      // The child carried both lanes' work into the main checkout.
      assert.strictEqual(childWorktree.targetBranch, mainBranch);
      assert.ok(
        childWorktree.mergeOutcome === "fast-forward" ||
          childWorktree.mergeOutcome === "merge-commit",
        `child: ${childWorktree.mergeOutcome} ${String(childWorktree.message)}`
      );
      for (const lane of ["a", "b"]) {
        assert.strictEqual(
          await fs.readFile(path.join(workspace, `${lane}.txt`), "utf8"),
          lane
        );
      }
      // Lease chains: the child is delegated by the parent; both lanes by
      // the parent, then by the child, so they share an immediate delegator
      // (the inner sibling merge wait) that is not the parent.
      assert.strictEqual(launchChains.length, 3, JSON.stringify(launchChains));
      const [childChain, ...laneChains] = launchChains;
      assert.strictEqual(childChain.length, 1, JSON.stringify(childChain));
      for (const laneChain of laneChains) {
        assert.strictEqual(laneChain.length, 2, JSON.stringify(laneChain));
        assert.strictEqual(laneChain[0], childChain[0]);
        assert.notStrictEqual(laneChain[1], childChain[0]);
      }
      assert.strictEqual(laneChains[0][1], laneChains[1][1]);
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("a merge: true lane of a main-checkout parent fast-forwards main instead of ending blocked", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-d4d-merge-main-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await writeMergeLaneScript(workspace);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Main parent",
        steps: [
          inlineLane("Lane", "node merge-lane.js", {
            worktree: { mode: "managed", merge: true },
          }),
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      const laneWorktree = await worktreeRuntimeOf(
        launchedChild(instances, parent)
      );
      assert.strictEqual(
        laneWorktree.mergeOutcome,
        "fast-forward",
        String(laneWorktree.message)
      );
      assert.strictEqual(
        path.dirname(laneWorktree.worktreePath),
        await fs.realpath(`${workspace}.worktrees`)
      );
      assert.strictEqual(
        execFileSync("git", ["-C", workspace, "log", "-1", "--format=%s"], {
          encoding: "utf8",
        }).trim(),
        buildManagedAutoCommitMessage("Lane")
      );
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "lane.txt"), "utf8"),
        "lane"
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  /** `git worktree list --porcelain` paths of `workspace`'s repository. */
  function gitWorktreePaths(workspace: string): string[] {
    return execFileSync(
      "git",
      ["-C", workspace, "worktree", "list", "--porcelain"],
      { encoding: "utf8" }
    )
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }

  /**
   * How the host goes away while both lanes run. `reload`: the window
   * reloads, disposing every instance, so each lane's child settles CANCELLED
   * and the parent stops at the join. `crash`: the process dies, so every
   * run directory stays as it was mid-group (RUNNING, members unsettled).
   */
  type HostLoss = "reload" | "crash";

  async function reattachesManagedLanesAfter(loss: HostLoss): Promise<void> {
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir(`ctrlyoke-lanes-${loss}-`);
    // Lanes run in their own worktrees, so the gate script and its records
    // live outside the repository at absolute paths.
    const recordDir = makeTempDir(`ctrlyoke-lanes-${loss}-record-`);
    const { createInstance, instances } = makeInstanceFactory(workspace);
    const gate = (lane: string) =>
      `node ${JSON.stringify(path.join(recordDir, "gate.js"))} ${JSON.stringify(
        path.join(recordDir, lane)
      )}`;
    try {
      initGitRepository(workspace);
      await writeGateScript(recordDir);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Reloaded lanes",
        steps: [
          {
            parallel: [
              inlineLane("Lane A", gate("a"), {
                worktree: { mode: "managed", keep: true },
              }),
              inlineLane("Lane B", gate("b"), {
                worktree: { mode: "managed", keep: true },
              }),
            ],
            failFast: false,
          },
          AFTER_SCRIPT_STEP,
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      const execution = parent.executeLoadedPromptFile();
      await waitForLanesRunning(recordDir, instances, parent, {
        0: "a",
        1: "b",
      });
      const laneRunRefs = [0, 1].map((stepIndex) =>
        childRunRefOf(parent.promptQueue.getState().steps[stepIndex])
      );
      assert.ok(laneRunRefs.every(Boolean), "both lanes recorded a child run");
      const laneStates = [0, 1].map((stepIndex) =>
        laneChildOf(instances, parent, stepIndex)!.promptQueue.getState()
      );
      const laneKeys = laneStates.map((state) => state.workflowKey!);
      const worktreesBefore = gitWorktreePaths(workspace);
      assert.strictEqual(worktreesBefore.length, 3, worktreesBefore.join("\n"));
      const { workflowKey, runRef, workingFilePath } =
        parent.promptQueue.getState();

      const runDirs = [
        workingFilePath!,
        ...laneStates.map((state) => state.workingFilePath!),
      ].map((filePath) => WorkflowPaths.runDirectoryForWorkingFile(filePath));
      const crashSnapshot = path.join(recordDir, "crash-snapshot");
      if (loss === "crash") {
        // Every lane is parked in its gate script, so nothing is mid-write.
        for (const [index, runDir] of runDirs.entries()) {
          await fs.cp(runDir, path.join(crashSnapshot, String(index)), {
            recursive: true,
          });
        }
      }

      await withoutStopFallback(async () => {
        if (loss === "reload") {
          // The host disposes every instance it holds.
          for (const instance of [...instances]) instance.dispose();
        } else {
          // This process lives on, so end the old host's execution here and
          // put the run directories back as the crash left them below.
          await parent.stop();
        }
        await execution;
      });
      for (const instance of instances) {
        await instance.whenExecutionSettled();
        instance.dispose();
      }
      if (loss === "crash") {
        for (const [index, runDir] of runDirs.entries()) {
          await fs.rm(runDir, { recursive: true, force: true });
          await fs.cp(path.join(crashSnapshot, String(index)), runDir, {
            recursive: true,
          });
        }
      }
      // A reloaded host reclaims the shut-down process's runner locks. This
      // process is still alive, so remove them the way that reclaim would.
      for (const key of [workflowKey!, ...laneKeys]) {
        await fs.rm(WorkflowPaths.runnerLockPath(workspace, key), {
          force: true,
        });
      }
      const reloadedFile = JSON.parse(
        await fs.readFile(workingFilePath!, "utf8")
      ) as { definitionRevision?: number; steps: WorkflowStep[] };
      assert.notStrictEqual(
        reloadedFile.steps[2]._runtime?.terminalStatus,
        PROMPT_TERMINAL_STATUS.COMPLETED,
        "the step after the group has not run"
      );
      assert.deepStrictEqual(
        reloadedFile.steps
          .slice(0, 2)
          .map((step) => step._runtime?.terminalStatus),
        loss === "crash"
          ? [undefined, undefined]
          : [
              PROMPT_TERMINAL_STATUS.CANCELLED,
              PROMPT_TERMINAL_STATUS.CANCELLED,
            ],
        "the lanes are in flight after a crash and cancelled after a reload"
      );

      const reloaded = createInstance();
      instances.push(reloaded);
      await fs.writeFile(path.join(recordDir, "a-go"), "");
      await fs.writeFile(path.join(recordDir, "b-go"), "");
      await withoutStopFallback(() =>
        reloaded.executeContinuationAtRun(
          workflowKey!,
          runRef!,
          reloadedFile.definitionRevision ?? 1
        )
      );

      const resumed = reloaded.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      assert.deepStrictEqual(
        [0, 1].map((stepIndex) => childRunRefOf(resumed.steps[stepIndex])),
        laneRunRefs,
        "each lane reattached to its recorded child run"
      );
      const worktreesAfter = gitWorktreePaths(workspace);
      assert.deepStrictEqual(
        worktreesAfter,
        worktreesBefore,
        "no lane created a second worktree for the same work"
      );
      for (const stepIndex of [0, 1]) {
        const lane = laneChildOf(instances, reloaded, stepIndex);
        assert.strictEqual(
          lane?.promptQueue.getState().status,
          EXECUTION_STATES.COMPLETED
        );
        assert.ok(
          worktreesBefore.includes(
            (await worktreeRuntimeOf(lane)).worktreePath
          ),
          "the continued lane ran in its original worktree"
        );
      }
      for (const lane of ["a", "b"]) {
        // The reload interrupted each lane's step, and the continued child
        // re-ran it.
        assert.strictEqual(
          await fs.readFile(path.join(recordDir, `${lane}-runs`), "utf8"),
          "ran\nran\n",
          lane
        );
      }
      await fs.access(path.join(workspace, "after"));
    } finally {
      await fs.writeFile(path.join(recordDir, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(recordDir, "b-go"), "").catch(() => {});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
      removeTempDir(recordDir);
    }
  }

  test("a window reload mid-group reattaches each managed-worktree lane to its child run and worktree (D6)", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    await reattachesManagedLanesAfter("reload");
  });

  test("a host crash mid-group reattaches each in-flight managed-worktree lane to its child run and worktree (D6)", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    await reattachesManagedLanesAfter("crash");
  });

  test("a group that runs a merge lane beside a member editing the parent's checkout fails preflight before any lane launches", async () => {
    const workspace = makeTempDir("ctrlyoke-merge-into-shared-root-");
    const { createInstance, instances, concurrentLaunches } =
      makeInstanceFactory(workspace);
    try {
      await writeJson(path.join(workspace, "merge-lane.ctrlyoke.json"), {
        worktree: { mode: "managed", merge: true },
        steps: [{ type: "script", script: 'node -e ""' }],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [
          {
            parallel: [
              {
                type: "script",
                name: "Edit in place",
                script: "node -e \"require('fs').writeFileSync('edited','')\"",
              },
              {
                type: "workflow",
                name: "Merge lane",
                workflow: "merge-lane.ctrlyoke.json",
              },
            ],
          },
        ],
      });
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(await parent.loadPromptFile(parentPath), true);
      const log = captureLog();
      try {
        await parent.executeLoadedPromptFile();
      } finally {
        log.restore();
      }

      assert.notStrictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      assert.ok(
        log.lines.some((line) =>
          line.message.includes(
            `Step 2 ("Merge lane") merges into the parent's checkout, which Step 1 ("Edit in place") edits in the same parallel group. ${MERGE_INTO_SHARED_ROOT_GUIDANCE}`
          )
        ),
        log.lines.map((line) => line.message).join("\n")
      );
      assert.deepStrictEqual(concurrentLaunches, [], "no lane launched");
      await assert.rejects(fs.access(path.join(workspace, "edited")));
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a merge lane of a managed parent continued directly from its own run merges into the parent's worktree branch, not main", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-direct-continue-");
    // The lane runs in its own worktree, so the gate lives outside the
    // repository at an absolute path.
    const recordDir = makeTempDir("ctrlyoke-direct-continue-record-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await writeGateScript(recordDir);
      await writeJson(path.join(workspace, "lane.ctrlyoke.json"), {
        name: "Lane",
        worktree: { mode: "managed", merge: true },
        steps: [
          {
            type: "script",
            script:
              "node -e \"require('fs').writeFileSync('lane.txt','lane')\"",
          },
          {
            type: "script",
            script: `node ${JSON.stringify(path.join(recordDir, "gate.js"))} ${JSON.stringify(path.join(recordDir, "lane"))}`,
          },
        ],
      });
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Managed parent",
        worktree: { mode: "managed", keep: true },
        steps: [{ type: "workflow", workflow: "lane.ctrlyoke.json" }],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(recordDir, "lane-runs"));
      const lane = launchedChild(instances, parent);
      await waitFor(
        "the lane to run",
        () => lane.promptQueue.getState().status === EXECUTION_STATES.RUNNING
      );
      const parentWorktree = await worktreeRuntimeOf(parent);
      const laneBefore = await worktreeRuntimeOf(lane);
      assert.strictEqual(laneBefore.targetBranch, parentWorktree.branchName);

      // Stopped from its own row; the parent stops through the outcome.
      await withoutStopFallback(async () => {
        await lane.stop();
        await execution;
      });
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      const { workflowKey, runRef, workingFilePath } =
        lane.promptQueue.getState();
      for (const instance of instances) {
        await instance.whenExecutionSettled();
        await instance.outputHistoryManager.flushPendingIndexRefresh();
        instance.dispose();
      }
      for (const key of [
        workflowKey!,
        parent.promptQueue.getState().workflowKey!,
      ]) {
        await fs.rm(WorkflowPaths.runnerLockPath(workspace, key), {
          force: true,
        });
      }
      const laneFile = JSON.parse(
        await fs.readFile(workingFilePath!, "utf8")
      ) as { definitionRevision?: number };

      // Continued directly: a fresh instance with no parent link.
      const continued = createInstance();
      instances.push(continued);
      await fs.writeFile(path.join(recordDir, "lane-go"), "");
      await withoutStopFallback(() =>
        continued.executeContinuationAtRun(
          workflowKey!,
          runRef!,
          laneFile.definitionRevision ?? 1
        )
      );

      assert.strictEqual(
        continued.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(continued.promptQueue.getState().results)
      );
      const laneAfter = await worktreeRuntimeOf(continued);
      assert.strictEqual(laneAfter.worktreePath, laneBefore.worktreePath);
      assert.strictEqual(laneAfter.baseCommit, laneBefore.baseCommit);
      assert.strictEqual(laneAfter.targetBranch, parentWorktree.branchName);
      assert.strictEqual(
        await fs.realpath(laneAfter.sourceCheckoutRoot),
        await fs.realpath(parentWorktree.worktreePath)
      );
      assert.strictEqual(
        laneAfter.mergeOutcome,
        "fast-forward",
        String(laneAfter.message)
      );
      assert.strictEqual(
        execFileSync(
          "git",
          [
            "-C",
            parentWorktree.worktreePath,
            "log",
            "--format=%s",
            "--",
            "lane.txt",
          ],
          { encoding: "utf8" }
        ).trim(),
        buildManagedAutoCommitMessage("Lane"),
        "the lane's commit is on the parent's worktree branch"
      );
      assert.strictEqual(
        execFileSync("git", ["-C", workspace, "log", "--format=%s"], {
          encoding: "utf8",
        }).trim(),
        "add workflows",
        "the user's main checkout gets no commit"
      );
    } finally {
      await fs.writeFile(path.join(recordDir, "lane-go"), "").catch(() => {});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
      removeTempDir(recordDir);
    }
  });

  /** A `worktree: false` lane beside a `merge: true` lane. */
  const mainCheckoutAndMergeLanes = (script: string) => ({
    parallel: [
      inlineLane("Main lane", script, { worktree: false }),
      inlineLane("Merge lane", "node merge-lane.js", {
        worktree: { mode: "managed", merge: true },
      }),
    ],
    failFast: false,
  });

  const MERGE_INTO_SHARED_ROOT_MESSAGE = `Step 2 ("Merge lane") merges into the parent's checkout, which Step 1 ("Main lane") edits in the same parallel group. ${MERGE_INTO_SHARED_ROOT_GUIDANCE}`;

  /** Run `definition`'s workflow to its end, capturing the log. */
  async function runCapturingLog(
    parent: WorkflowInstance,
    definitionPath: string
  ): Promise<string[]> {
    assert.strictEqual(await parent.loadPromptFile(definitionPath), true);
    const log = captureLog();
    try {
      await parent.executeLoadedPromptFile();
    } finally {
      log.restore();
    }
    return log.lines.map((line) => line.message);
  }

  test("a parent in the main checkout counts a worktree: false lane as editing its checkout beside a merge lane", async () => {
    const workspace = makeTempDir("ctrlyoke-main-parent-false-lane-");
    const { createInstance, instances, concurrentLaunches } =
      makeInstanceFactory(workspace);
    try {
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [mainCheckoutAndMergeLanes('node -e ""')],
      });
      const parent = createInstance();
      instances.push(parent);
      const lines = await runCapturingLog(parent, parentPath);

      assert.ok(
        lines.some((line) => line.includes(MERGE_INTO_SHARED_ROOT_MESSAGE)),
        lines.join("\n")
      );
      assert.deepStrictEqual(concurrentLaunches, [], "no lane launched");
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a D4a child of a main-checkout parent counts a worktree: false lane as editing the checkout it inherits", async () => {
    const workspace = makeTempDir("ctrlyoke-d4a-child-false-lane-");
    const { createInstance, instances, concurrentLaunches } =
      makeInstanceFactory(workspace);
    try {
      // No worktree key: the child runs in the parent's main checkout.
      await writeJson(path.join(workspace, "child.ctrlyoke.json"), {
        steps: [mainCheckoutAndMergeLanes('node -e ""')],
      });
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
      });
      const parent = createInstance();
      instances.push(parent);
      const lines = await runCapturingLog(parent, parentPath);

      assert.notStrictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      assert.ok(
        lines.some((line) => line.includes(MERGE_INTO_SHARED_ROOT_MESSAGE)),
        lines.join("\n")
      );
      assert.deepStrictEqual(
        concurrentLaunches,
        [false],
        "only the child launched; none of its lanes did"
      );
    } finally {
      await disposeAll(instances, workspace);
    }
  });

  test("a managed parent runs a worktree: false lane beside a merge lane, which merges into its worktree", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-managed-parent-false-lane-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await writeMergeLaneScript(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Managed parent",
        worktree: { mode: "managed", keep: true },
        steps: [
          mainCheckoutAndMergeLanes(
            "node -e \"require('fs').writeFileSync('main-lane','')\""
          ),
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      const lines = await runCapturingLog(parent, parentPath);

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(state.results)
      );
      assert.ok(
        !lines.some((line) => line.includes(MERGE_INTO_SHARED_ROOT_GUIDANCE)),
        lines.join("\n")
      );
      // The worktree: false lane ran in the main checkout.
      await fs.access(path.join(workspace, "main-lane"));
      const parentWorktree = await worktreeRuntimeOf(parent);
      const mergeLane = await worktreeRuntimeOf(
        launchedChild(instances, parent, 1)
      );
      assert.strictEqual(
        mergeLane.mergeOutcome,
        "fast-forward",
        String(mergeLane.message)
      );
      assert.strictEqual(mergeLane.targetBranch, parentWorktree.branchName);
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  /**
   * A script that proves two members ran at the same time: it writes
   * `<me>.ready` in its working directory, then waits for `<other>.ready`
   * there and fails if the other never appears.
   */
  async function writeRendezvousScript(directory: string): Promise<string> {
    const scriptPath = path.join(directory, "rendezvous.js");
    await fs.writeFile(
      scriptPath,
      [
        "const fs = require('fs');",
        "const [me, other] = process.argv.slice(2);",
        "fs.writeFileSync(me + '.ready', process.cwd());",
        "const deadline = Date.now() + 60000;",
        "const t = setInterval(() => {",
        "  if (fs.existsSync(other + '.ready')) { clearInterval(t); process.exit(0); }",
        "  if (Date.now() > deadline) { clearInterval(t); process.exit(1); }",
        "}, 25);",
      ].join("\n")
    );
    return scriptPath;
  }

  /** The managed worktree `instance`'s run recorded, by real path. */
  async function realWorktreePathOf(instance: WorkflowInstance) {
    return fs.realpath((await worktreeRuntimeOf(instance)).worktreePath);
  }

  // Inheriting children ask for shared-native leases, which were already
  // compatible with each other (and rule 1 admits the parent's exclusive
  // lease), so this case passes without D4d rule 2; rule 2 itself is pinned
  // by ExecutionRootLeaseManager.test.ts's exclusive-mode cases.
  test("two inheriting members of a managed parent run side by side in the parent's worktree", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-inheriting-members-");
    const scriptDir = makeTempDir("ctrlyoke-inheriting-members-script-");
    const { createInstance, instances, concurrentLaunches } =
      makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      const rendezvous = JSON.stringify(await writeRendezvousScript(scriptDir));
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Inheriting members",
        worktree: { mode: "managed", keep: true },
        steps: [
          {
            parallel: [
              inlineLane("Member A", `node ${rendezvous} a b`),
              inlineLane("Member B", `node ${rendezvous} b a`),
            ],
            failFast: false,
          },
          AFTER_SCRIPT_STEP,
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      const lines = await runCapturingLog(parent, parentPath);

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.COMPLETED,
        `${JSON.stringify(state.results)}\n${lines.join("\n")}`
      );
      assert.deepStrictEqual(concurrentLaunches, [true, true]);
      const parentWorktree = await realWorktreePathOf(parent);
      for (const marker of ["a.ready", "b.ready", "after"]) {
        await fs.access(path.join(parentWorktree, marker));
        await assert.rejects(fs.access(path.join(workspace, marker)), marker);
      }
      for (const stepIndex of [0, 1]) {
        const member = launchedChild(instances, parent, stepIndex);
        assert.strictEqual(
          await fs.realpath(
            await fs.readFile(
              path.join(parentWorktree, `${"ab"[stepIndex]}.ready`),
              "utf8"
            )
          ),
          parentWorktree,
          "the member ran in the parent's worktree"
        );
        assert.strictEqual(
          member.promptQueue.getState().status,
          EXECUTION_STATES.COMPLETED
        );
      }
      assert.deepStrictEqual(
        gitWorktreePaths(workspace).length,
        2,
        "the inheriting members created no worktree of their own"
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
      removeTempDir(scriptDir);
    }
  });

  test("a window reload mid-group reattaches each inheriting member of a managed parent in the parent's worktree (D6)", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-inheriting-reload-");
    const recordDir = makeTempDir("ctrlyoke-inheriting-reload-record-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    const member = (lane: string) =>
      inlineLane(
        `Member ${lane}`,
        `node ${JSON.stringify(path.join(recordDir, "gate.js"))} ${JSON.stringify(
          path.join(recordDir, lane)
        )} && node -e "require('fs').writeFileSync('${lane}-done','')"`
      );
    try {
      initGitRepository(workspace);
      await writeGateScript(recordDir);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Reloaded inheriting members",
        worktree: { mode: "managed", keep: true },
        steps: [
          { parallel: [member("a"), member("b")], failFast: false },
          AFTER_SCRIPT_STEP,
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      const execution = parent.executeLoadedPromptFile();
      await waitForLanesRunning(recordDir, instances, parent, {
        0: "a",
        1: "b",
      });
      const memberRunRefs = [0, 1].map((stepIndex) =>
        childRunRefOf(parent.promptQueue.getState().steps[stepIndex])
      );
      assert.ok(memberRunRefs.every(Boolean), "both members recorded a run");
      const memberKeys = [0, 1].map(
        (stepIndex) =>
          laneChildOf(instances, parent, stepIndex)!.promptQueue.getState()
            .workflowKey!
      );
      const parentWorktree = await realWorktreePathOf(parent);
      const worktreesBefore = gitWorktreePaths(workspace);
      assert.strictEqual(worktreesBefore.length, 2, worktreesBefore.join("\n"));
      const { workflowKey, runRef, workingFilePath } =
        parent.promptQueue.getState();

      await withoutStopFallback(async () => {
        for (const instance of [...instances]) instance.dispose();
        await execution;
      });
      for (const instance of instances) {
        await instance.whenExecutionSettled();
        instance.dispose();
      }
      for (const key of [workflowKey!, ...memberKeys]) {
        await fs.rm(WorkflowPaths.runnerLockPath(workspace, key), {
          force: true,
        });
      }
      const reloadedFile = JSON.parse(
        await fs.readFile(workingFilePath!, "utf8")
      ) as { definitionRevision?: number };

      const reloaded = createInstance();
      instances.push(reloaded);
      await fs.writeFile(path.join(recordDir, "a-go"), "");
      await fs.writeFile(path.join(recordDir, "b-go"), "");
      await withoutStopFallback(() =>
        reloaded.executeContinuationAtRun(
          workflowKey!,
          runRef!,
          reloadedFile.definitionRevision ?? 1
        )
      );

      const resumed = reloaded.promptQueue.getState();
      assert.strictEqual(
        resumed.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(resumed.results)
      );
      assert.deepStrictEqual(
        [0, 1].map((stepIndex) => childRunRefOf(resumed.steps[stepIndex])),
        memberRunRefs,
        "each member reattached to its recorded child run"
      );
      assert.deepStrictEqual(gitWorktreePaths(workspace), worktreesBefore);
      for (const lane of ["a", "b"]) {
        assert.strictEqual(
          await fs.readFile(path.join(recordDir, `${lane}-runs`), "utf8"),
          "ran\nran\n",
          lane
        );
        // The continued member ran in the parent's worktree again.
        await fs.access(path.join(parentWorktree, `${lane}-done`));
        await assert.rejects(fs.access(path.join(workspace, `${lane}-done`)));
      }
      await fs.access(path.join(parentWorktree, "after"));
    } finally {
      await fs.writeFile(path.join(recordDir, "a-go"), "").catch(() => {});
      await fs.writeFile(path.join(recordDir, "b-go"), "").catch(() => {});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
      removeTempDir(recordDir);
    }
  });

  test("two merge: true lanes of one group that finish together both merge into the parent's checkout", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-d4d-sibling-merge-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await fs.writeFile(
        path.join(workspace, "named-lane.js"),
        "require('fs').writeFileSync(process.argv[2] + '.txt', process.argv[2]);"
      );
      const mergeLane = { worktree: { mode: "managed", merge: true } };
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Merging lanes",
        steps: [
          {
            parallel: [
              inlineLane("Lane A", "node named-lane.js a", mergeLane),
              inlineLane("Lane B", "node named-lane.js b", mergeLane),
            ],
            failFast: false,
          },
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      const outcomes: string[] = [];
      for (const stepIndex of [0, 1]) {
        const lane = laneChildOf(instances, parent, stepIndex);
        assert.ok(lane, `lane ${stepIndex + 1} has a child instance`);
        const laneWorktree = await worktreeRuntimeOf(lane);
        outcomes.push(String(laneWorktree.mergeOutcome));
        assert.ok(
          laneWorktree.mergeOutcome === "fast-forward" ||
            laneWorktree.mergeOutcome === "merge-commit",
          `lane ${stepIndex + 1}: ${laneWorktree.mergeOutcome} ${String(laneWorktree.message)}`
        );
      }
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "a.txt"), "utf8"),
        "a"
      );
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "b.txt"), "utf8"),
        "b"
      );
      assert.ok(
        !outcomes.includes("blocked"),
        `neither lane was blocked: ${outcomes.join(", ")}`
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("an MCP-appended lane runs as an inline child in its own managed worktree", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(120_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const environment = {
      CTRLYOKE_WORKING_FILE: process.env.CTRLYOKE_WORKING_FILE,
      CTRLYOKE_EXECUTION_ROOT: process.env.CTRLYOKE_EXECUTION_ROOT,
    };
    const workspace = makeTempDir("ctrlyoke-mcp-lane-");
    const integration = new MockHarnessIntegration(undefined, false);
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      integration
    );
    let parent: WorkflowInstance | undefined;
    let appendError: unknown;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "lane work") return { responseText: "lane done" };
      try {
        const queue = parent!.promptQueue;
        const runFile = queue.getState().workingFilePath;
        assert.ok(runFile, "the parent run has a working file");
        process.env.CTRLYOKE_WORKING_FILE = runFile;
        process.env.CTRLYOKE_EXECUTION_ROOT = workspace;
        await new CtrlYokeMCPServer({ workspaceRoot: workspace }).invokeTool(
          MCP_APPEND_STEP_TOOL_NAME,
          {
            position: "end",
            steps: [
              { prompt: "lane work", name: "Lane", worktree: { use: "lane" } },
            ],
          }
        );
        // The working-file watcher's merge of an out-of-process append.
        await queue.mergeStepsFromDisk();
      } catch (error) {
        appendError = error;
      }
      return { responseText: "anchor done" };
    };
    try {
      // The MCP server and this host share one project state directory, so
      // register it before the parent writes its first run.
      await ensureMcpStorageInitialized(workspace);
      initGitRepository(workspace);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Agent lanes",
        worktreePresets: { lane: { mode: "managed", keep: true } },
        steps: [{ prompt: "queue a lane" }],
      });
      commitAll(workspace, "add parent");
      parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      await parent.executeLoadedPromptFile();

      assert.ifError(appendError);
      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        "completed",
        JSON.stringify(state.results)
      );
      const lane = state.steps[1];
      assert.ok(isSubWorkflowStep(lane), "the appended step is a lane");
      assert.strictEqual(lane.name, "Lane");
      const child = launchedChild(instances, parent, 1);
      assert.strictEqual(child.promptQueue.getState().status, "completed");
      const laneWorktree = await worktreeRuntimeOf(child);
      assert.strictEqual(laneWorktree.mode, "managed");
      assert.ok(integration.sentPrompts.includes("lane work"));
      assert.notStrictEqual(
        await fs.realpath(laneWorktree.executionRoot),
        await fs.realpath(workspace)
      );
      const linkedWorktrees = execFileSync(
        "git",
        ["-C", workspace, "worktree", "list", "--porcelain"],
        { encoding: "utf8" }
      );
      assert.ok(
        linkedWorktrees.includes(
          `branch refs/heads/${laneWorktree.branchName}`
        ),
        linkedWorktrees
      );
    } finally {
      restoreEnvironmentValues(environment);
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("stopping the parent ends a merging lane's wait for the worktree mutation lock", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-d4d-lock-stop-");
    // Gate files live outside the repository so they never dirty the
    // parent's checkout the lane merges into.
    const gates = makeTempDir("ctrlyoke-d4d-lock-stop-gates-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    const log = captureLog();
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      initGitRepository(workspace);
      // Signals it started, then waits for `<name>-go` before writing.
      await fs.writeFile(
        path.join(workspace, "gated-lane.js"),
        [
          "const fs = require('fs');",
          "const path = require('path');",
          "const [name, gates] = process.argv.slice(2);",
          "fs.writeFileSync(path.join(gates, name + '-started'), '');",
          "const timer = setInterval(() => {",
          "  if (!fs.existsSync(path.join(gates, name + '-go'))) return;",
          "  clearInterval(timer);",
          "  fs.writeFileSync(name + '.txt', name);",
          "}, 20);",
        ].join("\n")
      );
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Stopped lane",
        steps: [
          inlineLane(
            "Lane A",
            `node gated-lane.js a ${JSON.stringify(gates)}`,
            {
              worktree: { mode: "managed", merge: true },
            }
          ),
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(gates, "a-started"));

      // A sibling's settlement holds the lock from here on.
      const commonDirectory = await gitCommonDir(workspace);
      assert.ok(commonDirectory);
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => (signalHeld = resolve));
      const holder = withWorktreeMutationLock(commonDirectory, async () => {
        signalHeld();
        await gate;
      });
      releaseLock = async () => {
        openGate();
        await holder;
      };
      await held;

      await fs.writeFile(path.join(gates, "a-go"), "");
      await waitFor("the lane to start settling its worktree", () =>
        log.lines.some((line) =>
          line.message.includes("Settling managed worktree")
        )
      );
      await parent.stop();
      // Awaited while the lock is still held: with no abort the lane would
      // wait out WORKTREE_MERGE_LEASE_WAIT_MS (120 s) and then fail the
      // /Stopped while waiting/ check below.
      await execution;

      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      const lane = laneChildOf(instances, parent, 0);
      assert.ok(lane, "the lane has a child instance");
      const laneWorktree = await worktreeRuntimeOf(lane);
      assert.strictEqual(laneWorktree.mergeOutcome, "blocked");
      assert.match(String(laneWorktree.message), /Stopped while waiting/);
      await assert.rejects(fs.stat(path.join(workspace, "a.txt")), /ENOENT/);
      assert.ok(
        !log.lines.some((line) => line.message.includes(STOP_FALLBACK_WARNING)),
        "stop settled without the 10 s fallback"
      );
    } finally {
      log.restore();
      await releaseLock?.();
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(gates);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("a second stop ends the settlement wait of a merging lane stopped during its worktree setup", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-d4d-setup-stop-");
    let releaseLock: (() => Promise<void>) | undefined;
    let stopDuringSetup: Promise<void> | undefined;
    // When the lane's worktree is ready, its setup having just finished, a
    // sibling's settlement takes the mutation lock and the lane is stopped:
    // the startup then settles the worktree behind that lock instead of
    // dispatching. Doing both inside the runtime update the worktree manager
    // awaits pins the order without racing the settlement for the lock.
    const onChildCreated = (child: WorkflowInstance) => {
      const update = child.promptQueue.updateWorktreeRuntime.bind(
        child.promptQueue
      );
      child.promptQueue.updateWorktreeRuntime = async (patch) => {
        await update(patch);
        if (
          patch.lifecycleState !== WORKTREE_LIFECYCLE_STATES.READY ||
          stopDuringSetup
        )
          return;
        const commonDirectory = await gitCommonDir(workspace);
        assert.ok(commonDirectory);
        let openGate!: () => void;
        const gate = new Promise<void>((resolve) => (openGate = resolve));
        let signalHeld!: () => void;
        const held = new Promise<void>((resolve) => (signalHeld = resolve));
        const holder = withWorktreeMutationLock(commonDirectory, async () => {
          signalHeld();
          await gate;
        });
        releaseLock = async () => {
          openGate();
          await holder;
        };
        await held;
        stopDuringSetup = child.stop();
        await stopDuringSetup;
      };
    };
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      undefined,
      undefined,
      onChildCreated
    );
    const log = captureLog();
    try {
      initGitRepository(workspace);
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Lane stopped in setup",
        steps: [
          inlineLane("Lane A", "node --version", {
            worktree: { mode: "managed", merge: true, setup: "node --version" },
          }),
        ],
      });
      commitAll(workspace, "add workflows");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      const execution = parent.executeLoadedPromptFile();

      // Reaching settlement takes a real `git worktree add` and the setup
      // command, which the raised git timeouts above already allow for, so
      // the default 10 s would be the tightest bound in this test.
      await waitFor(
        "the stopped lane to start settling its worktree",
        () =>
          log.lines.some((line) =>
            line.message.includes("Settling managed worktree")
          ),
        60_000
      );
      const lane = laneChildOf(instances, parent, 0);
      assert.ok(lane, "the lane has a child instance");
      // The first stop arrived before settlement began, so the settlement
      // queues behind the sibling as any stopped lane's does; a second stop
      // ends that wait. Without it the lane waits out
      // WORKTREE_MERGE_LEASE_WAIT_MS (120 s), well past this bound.
      await lane.stop();
      let bound: NodeJS.Timeout | undefined;
      await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          bound = setTimeout(
            () => reject(new Error("the second stop did not end the wait")),
            60_000
          );
        }),
      ]).finally(() => clearTimeout(bound));

      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      const laneWorktree = await worktreeRuntimeOf(lane);
      assert.strictEqual(laneWorktree.landingOutcome, "blocked");
      assert.strictEqual(laneWorktree.mergeOutcome, "blocked");
      assert.strictEqual(
        laneWorktree.message,
        STOPPED_WAITING_FOR_SETTLEMENT_MESSAGE
      );
      assert.ok(laneWorktree.worktreePath, "the lane recorded its worktree");
      await fs.stat(laneWorktree.worktreePath);
    } finally {
      log.restore();
      await releaseLock?.();
      await stopDuringSetup?.catch(() => undefined);
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
    }).trim();
  }

  /** Run a fresh `definitionPath` run on a new parent instance to its end. */
  async function runParent(
    createInstance: () => WorkflowInstance,
    instances: WorkflowInstance[],
    definitionPath: string
  ): Promise<WorkflowInstance> {
    const parent = createInstance();
    instances.push(parent);
    assert.strictEqual(await parent.loadPromptFile(definitionPath), true);
    await parent.executeLoadedPromptFile();
    return parent;
  }

  /** A lane script that writes `<name>.txt` and commits it in the checkout it runs in. */
  async function writeCommittingLaneScript(workspace: string): Promise<void> {
    await fs.writeFile(
      path.join(workspace, "commit-lane.js"),
      [
        "const fs = require('fs');",
        "const { execFileSync } = require('child_process');",
        "const name = process.argv[2];",
        "fs.writeFileSync(name + '.txt', name + ' ' + Date.now());",
        "execFileSync('git', ['add', name + '.txt']);",
        "execFileSync('git', ['commit', '-m', 'lane ' + name]);",
      ].join("\n")
    );
  }

  test("named-worktree members branch from the parent's HEAD or their base, never merge, and are reused by the next run", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(240_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-named-members-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      await writeCommittingLaneScript(workspace);
      commitAll(workspace, "initial");
      const initialCommit = git(workspace, "rev-parse", "HEAD");
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Named members",
        steps: [
          {
            parallel: [
              // The string shorthand and the object form name a branch alike.
              inlineLane("Lane A", "node commit-lane.js a", {
                worktree: "lane/a",
              }),
              inlineLane("Lane B", "node commit-lane.js b", {
                worktree: {
                  mode: "named",
                  branch: "lane/b",
                  base: initialCommit,
                },
              }),
            ],
            failFast: false,
          },
        ],
      });
      commitAll(workspace, "add workflows");
      const parentHead = git(workspace, "rev-parse", "HEAD");

      const first = await runParent(createInstance, instances, parentPath);
      const firstState = first.promptQueue.getState();
      assert.strictEqual(
        firstState.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(firstState.results)
      );
      const laneA = await worktreeRuntimeOf(launchedChild(instances, first, 0));
      const laneB = await worktreeRuntimeOf(launchedChild(instances, first, 1));
      assert.deepStrictEqual(
        [laneA.mode, laneA.branchName, laneA.origin],
        ["named", "lane/a", "created"]
      );
      assert.deepStrictEqual(
        [laneB.mode, laneB.branchName, laneB.origin],
        ["named", "lane/b", "created"]
      );
      // D4b: no base branches from the parent's HEAD; `base` wins.
      assert.strictEqual(laneA.baseCommit, parentHead);
      assert.strictEqual(laneB.baseCommit, initialCommit);
      assert.strictEqual(git(workspace, "rev-parse", "lane/a~1"), parentHead);
      assert.strictEqual(
        git(workspace, "rev-parse", "lane/b~1"),
        initialCommit
      );
      // Named never merges, and is kept.
      assert.strictEqual(laneA.mergeOutcome, undefined);
      assert.strictEqual(laneB.mergeOutcome, undefined);
      assert.strictEqual(
        git(workspace, "rev-parse", "HEAD"),
        parentHead,
        "the parent's checkout gets no merge"
      );
      await fs.access(path.join(laneA.worktreePath, "a.txt"));
      const laneATip = git(workspace, "rev-parse", "lane/a");

      // A later run reuses the existing named worktree and its branch.
      const second = await runParent(createInstance, instances, parentPath);
      const secondState = second.promptQueue.getState();
      assert.strictEqual(
        secondState.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(secondState.results)
      );
      assert.notStrictEqual(secondState.runRef, firstState.runRef);
      const reusedA = await worktreeRuntimeOf(
        launchedChild(instances, second, 0)
      );
      assert.strictEqual(reusedA.origin, "discovered");
      assert.strictEqual(reusedA.worktreePath, laneA.worktreePath);
      assert.strictEqual(reusedA.baseCommit, laneATip);
      assert.strictEqual(git(workspace, "rev-parse", "lane/a~1"), laneATip);
      assert.strictEqual(git(workspace, "rev-parse", "HEAD"), parentHead);
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("a child naming the named worktree its parent holds fails to start under its onFail", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-named-parent-collision-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      const parentPath = path.join(workspace, "parent.ctrlyoke.json");
      await writeJson(parentPath, {
        name: "Named parent",
        worktree: "parent/work",
        steps: [
          {
            ...inlineLane("Same worktree", "node --version", {
              worktree: { mode: "named", branch: "refs/heads/parent/work" },
            }),
            onFail: "continue",
          },
          {
            type: "script",
            script:
              "node -e \"require('fs').writeFileSync('after.txt','ran')\"",
          },
        ],
      });
      commitAll(workspace, "add parent");

      const parent = await runParent(createInstance, instances, parentPath);
      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(state.results)
      );
      assert.match(
        state.steps[0]?._runtime?.failureMessage ?? "",
        /Named branch "parent\/work" is already checked out in the initiating source checkout/
      );
      const parentWorktree = await worktreeRuntimeOf(parent);
      assert.strictEqual(parentWorktree.branchName, "parent/work");
      assert.strictEqual(
        await fs.readFile(
          path.join(parentWorktree.worktreePath, "after.txt"),
          "utf8"
        ),
        "ran",
        "onFail: continue moves on to the next step"
      );
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  const joinerCollisionCases = [
    {
      label: "with onFail: continue, in a failFast: false group",
      onFail: "continue" as const,
      failFast: false,
    },
    {
      label: "without onFail, in a failFast group",
      onFail: undefined,
      failFast: true,
    },
  ];
  for (const joinerCase of joinerCollisionCases) {
    test(`a parallelWithCurrent joiner naming a running member's named branch fails alone with WORKTREE_COLLISION ${joinerCase.label}`, async function () {
      // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
      this.timeout(180_000);
      const restoreGitTimeouts = setGitTimeoutOverridesForTests({
        shortTimeoutMs: 60_000,
        mutationTimeoutMs: 120_000,
      });
      const workspace = makeTempDir("ctrlyoke-named-joiner-collision-");
      // Gate files live outside the repository, so the holder's worktree and
      // the parent's checkout stay clean.
      const gates = makeTempDir("ctrlyoke-named-joiner-collision-gates-");
      const { createInstance, instances } = makeInstanceFactory(workspace);
      try {
        initGitRepository(workspace);
        await fs.writeFile(
          path.join(workspace, "hold.js"),
          [
            "const fs = require('fs');",
            "const path = require('path');",
            "const dir = process.argv[2];",
            "fs.writeFileSync(path.join(dir, 'holder-runs'), 'ran');",
            "const timer = setInterval(() => {",
            "  if (fs.existsSync(path.join(dir, 'holder-go'))) {",
            "    clearInterval(timer);",
            "    process.exit(0);",
            "  }",
            "}, 25);",
          ].join("\n")
        );
        const latePath = path.join(workspace, "flows", "late.ctrlyoke.json");
        await fs.mkdir(path.dirname(latePath), { recursive: true });
        await writeJson(latePath, {
          name: "Late",
          worktree: { mode: "named", branch: "refs/heads/lane/shared" },
          steps: [{ type: "script", script: "node --version" }],
        });
        const parentPath = path.join(workspace, "parent.ctrlyoke.json");
        await writeJson(parentPath, {
          name: "Named joiner",
          steps: [
            {
              parallel: [
                inlineLane("Holder", `node hold.js ${JSON.stringify(gates)}`, {
                  worktree: "lane/shared",
                }),
                inlineLane("Quick", "node --version"),
              ],
              failFast: joinerCase.failFast,
            },
          ],
        });
        commitAll(workspace, "add workflows");

        const parent = createInstance();
        instances.push(parent);
        assert.strictEqual(await parent.loadPromptFile(parentPath), true);
        const execution = parent.executeLoadedPromptFile();
        await waitForFile(path.join(gates, "holder-runs"));
        await waitFor(
          "the holder lane running",
          () =>
            laneChildOf(instances, parent, 0)?.promptQueue.getState().status ===
            EXECUTION_STATES.RUNNING
        );
        const launchesBeforeJoin = instances.length;

        // The dashboard's "run alongside" and MCP's `parallelWithCurrent` both
        // join through this transaction; the executor learns of the member
        // from the working-file watcher's merge.
        const { workflowKey, runRef } = parent.promptQueue.getState();
        await RunContinuationService.appendStepsToActiveParallelGroup(
          workspace,
          workflowKey!,
          runRef!,
          [
            {
              type: STEP_TYPES.WORKFLOW,
              name: "Late",
              workflow: "flows/late.ctrlyoke.json",
              ...(joinerCase.onFail ? { onFail: joinerCase.onFail } : {}),
            },
          ],
          await RunContinuationService.readRunDefinitionRevision(
            workspace,
            workflowKey!,
            runRef!
          ),
          100,
          undefined,
          QUEUE_POSITION.PARALLEL_WITH_CURRENT,
          6,
          workspace
        );
        await parent.promptQueue.mergeStepsFromDisk();
        await waitFor(
          "the joiner to settle",
          () =>
            parent.promptQueue.getState().steps[2]?._runtime?.completedAt !==
            undefined
        );
        const holderStatus = laneChildOf(
          instances,
          parent,
          0
        )?.promptQueue.getState().status;
        await fs.writeFile(path.join(gates, "holder-go"), "");
        await execution;

        const state = parent.promptQueue.getState();
        assert.strictEqual(
          holderStatus,
          EXECUTION_STATES.RUNNING,
          "the holder kept running while the joiner failed"
        );
        assert.strictEqual(state.steps[2]?.name, "Late");
        // D9: onFail: continue records the failure on a COMPLETED step, as a
        // member whose child failed group preflight does.
        assert.strictEqual(
          state.steps[2]?._runtime?.terminalStatus,
          joinerCase.onFail
            ? PROMPT_TERMINAL_STATUS.COMPLETED
            : PROMPT_TERMINAL_STATUS.FAILED
        );
        assert.match(
          state.steps[2]?._runtime?.failureMessage ?? "",
          /use the same named worktree "lane\/shared" in one parallel group/
        );
        assert.strictEqual(
          childRunRefOf(state.steps[2]),
          undefined,
          "the joiner never launched a child"
        );
        assert.strictEqual(
          instances.length,
          launchesBeforeJoin,
          "no child instance was created for the joiner"
        );
        assert.strictEqual(
          laneChildOf(instances, parent, 0)?.promptQueue.getState().status,
          EXECUTION_STATES.COMPLETED
        );
        // The joiner never cancels its siblings, even under fail-fast: they
        // complete. Its onFail then decides the join: continue advances, and
        // the default stopWorkflow fails the group there, as a conflict found
        // at group preflight fails its group.
        assert.deepStrictEqual(
          state.steps.slice(0, 2).map((step) => step._runtime?.terminalStatus),
          [PROMPT_TERMINAL_STATUS.COMPLETED, PROMPT_TERMINAL_STATUS.COMPLETED]
        );
        assert.strictEqual(
          state.status,
          joinerCase.onFail
            ? EXECUTION_STATES.COMPLETED
            : EXECUTION_STATES.ERROR,
          JSON.stringify(state.results)
        );
      } finally {
        restoreGitTimeouts();
        await disposeAll(instances, workspace);
        removeTempDir(gates);
        removeTempDir(`${workspace}.worktrees`);
      }
    });
  }

  /**
   * The staging-plan pattern (spec "Parallel Sub-workflow Steps"): wave 1 of
   * managed-worktree file children, a script step that merges the branches
   * the lanes' D12a settlements report and commits, then wave 2. `mergeArgs`
   * is passed to the merge script; `dirty` leaves its fix uncommitted.
   */
  async function writeStagingPlan(
    workspace: string,
    mergeArgs: string
  ): Promise<string> {
    await writeCommittingLaneScript(workspace);
    await fs.writeFile(
      path.join(workspace, "merge-wave.js"),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const { execFileSync } = require('child_process');",
        "const [first, last, mode] = process.argv.slice(2);",
        "const events = fs",
        "  .readFileSync(path.join(path.dirname(process.env.CTRLYOKE_WORKING_FILE), 'events.jsonl'), 'utf8')",
        "  .split('\\n')",
        "  .filter(Boolean)",
        "  .map((line) => JSON.parse(line));",
        "const branches = events",
        "  .filter((event) => event.eventType === 'subWorkflowSettled' && event.target && event.target.kind === 'queue'",
        "    && event.target.stepIndex >= Number(first) && event.target.stepIndex <= Number(last))",
        "  .map((event) => event.payload.worktree.branchName);",
        "if (branches.length === 0) process.exit(2);",
        "for (const branch of branches) execFileSync('git', ['merge', '--no-edit', branch]);",
        "fs.writeFileSync('fix.txt', branches.join('\\n'));",
        "if (mode !== 'dirty') {",
        "  execFileSync('git', ['add', 'fix.txt']);",
        "  execFileSync('git', ['commit', '-m', 'merge wave and fix']);",
        "}",
      ].join("\n")
    );
    await fs.mkdir(path.join(workspace, "waves"));
    for (const name of ["w1a", "w1b", "w2a", "w2b"]) {
      await writeJson(path.join(workspace, "waves", `${name}.ctrlyoke.json`), {
        name,
        worktree: { mode: "managed" },
        steps: [{ type: "script", script: `node commit-lane.js ${name}` }],
      });
    }
    const parentPath = path.join(workspace, "staging.ctrlyoke.json");
    await writeJson(parentPath, {
      name: "Staging plan",
      worktree: false,
      steps: [
        {
          parallel: [
            { type: "workflow", workflow: "waves/w1a.ctrlyoke.json" },
            { type: "workflow", workflow: "waves/w1b.ctrlyoke.json" },
          ],
          failFast: false,
        },
        {
          type: "script",
          name: "Merge wave 1 and fix",
          script: `node merge-wave.js 0 1 ${mergeArgs}`,
        },
        {
          parallel: [
            { type: "workflow", workflow: "waves/w2a.ctrlyoke.json" },
            { type: "workflow", workflow: "waves/w2b.ctrlyoke.json" },
          ],
          failFast: false,
        },
      ],
    });
    commitAll(workspace, "add staging plan");
    return parentPath;
  }

  test("authored waves: wave 2 branches from the merge step's commit of wave 1's branches", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(300_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-authored-waves-");
    const { createInstance, instances, concurrentLaunches } =
      makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      const parentPath = await writeStagingPlan(workspace, "commit");
      const planCommit = git(workspace, "rev-parse", "HEAD");

      const parent = await runParent(createInstance, instances, parentPath);
      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.COMPLETED,
        JSON.stringify(state.results)
      );
      assert.deepStrictEqual(
        concurrentLaunches,
        [true, true, true, true],
        "each wave fans out"
      );

      const wave1 = await Promise.all(
        [0, 1].map(async (index) =>
          worktreeRuntimeOf(launchedChild(instances, parent, index))
        )
      );
      for (const lane of wave1) {
        assert.strictEqual(lane.mode, "managed");
        assert.strictEqual(lane.baseCommit, planCommit, "wave 1 shares a base");
        assert.strictEqual(
          lane.mergeOutcome,
          undefined,
          "left to the merge step"
        );
      }
      // The merge step merged both lanes' branches into main and committed.
      const mergeCommit = git(workspace, "rev-parse", "HEAD");
      assert.strictEqual(
        git(workspace, "log", "-1", "--format=%s"),
        "merge wave and fix"
      );
      // The merge step reads branches in settlement order, and the two lanes
      // run concurrently, so either may have settled first.
      assert.deepStrictEqual(
        (await fs.readFile(path.join(workspace, "fix.txt"), "utf8"))
          .split("\n")
          .sort(),
        wave1.map((lane) => lane.branchName).sort()
      );
      for (const name of ["w1a", "w1b"]) {
        await fs.access(path.join(workspace, `${name}.txt`));
      }
      assert.strictEqual(git(workspace, "status", "--porcelain"), "");

      const wave2 = await Promise.all(
        [3, 4].map(async (index) =>
          worktreeRuntimeOf(launchedChild(instances, parent, index))
        )
      );
      for (const lane of wave2) {
        assert.strictEqual(
          lane.baseCommit,
          mergeCommit,
          "wave 2 branches from the merge step's commit"
        );
        assert.strictEqual(
          git(workspace, "rev-parse", `${lane.branchName}~1`),
          mergeCommit
        );
        assert.strictEqual(
          git(workspace, "show", `${lane.branchName}:fix.txt`).split("\n")
            .length,
          2,
          "wave 2 sees the merge step's fix"
        );
      }
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("authored waves: a merge step that leaves the main checkout dirty refuses wave 2 before any lane starts (D4c)", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(300_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-authored-waves-dirty-");
    const { createInstance, instances, concurrentLaunches } =
      makeInstanceFactory(workspace);
    try {
      initGitRepository(workspace);
      const parentPath = await writeStagingPlan(workspace, "dirty");

      const parent = await runParent(createInstance, instances, parentPath);
      const state = parent.promptQueue.getState();
      assert.strictEqual(
        state.status,
        EXECUTION_STATES.ERROR,
        JSON.stringify(state.results)
      );
      assert.deepStrictEqual(
        concurrentLaunches,
        [true, true],
        "no wave 2 lane launched"
      );
      for (const index of [3, 4]) {
        assert.match(
          state.steps[index]?._runtime?.failureMessage ?? "",
          /Commit or stash the parent's changes before starting worktree sub-workflows \(dirty: 1 file/
        );
        assert.strictEqual(childRunRefOf(state.steps[index]), undefined);
      }
      // The lanes settle in either order, so the merge step's last commit
      // merges whichever lane's branch it read second.
      const wave1Merges = await Promise.all(
        [0, 1].map(
          async (index) =>
            "Merge branch '" +
            (await worktreeRuntimeOf(launchedChild(instances, parent, index)))
              .branchName +
            "'"
        )
      );
      assert.ok(
        wave1Merges.includes(git(workspace, "log", "-1", "--format=%s")),
        "ctrlyoke commits nothing to the user's checkout"
      );
      assert.strictEqual(git(workspace, "status", "--porcelain"), "?? fix.txt");
    } finally {
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  /**
   * A top-level worktree run paused at its gated step's boundary: that step
   * writes `lane.txt` in its checkout and waits on `<control>/a-go`, the
   * next writes `<control>/second-ran`. `leadingSteps` run before the gated
   * one. The control files live outside the repository so the run's
   * checkout stays the step's own work.
   */
  async function pausedWorktreeRun<T extends WorkflowInstance>(
    workspace: string,
    control: string,
    worktree: unknown,
    createInstance: () => T,
    instances: WorkflowInstance[],
    leadingSteps: readonly unknown[] = []
  ): Promise<T> {
    initGitRepository(workspace);
    await writeGateScript(control);
    await fs.writeFile(
      path.join(control, "write.js"),
      "require('fs').writeFileSync(process.argv[2], 'ran\\n');"
    );
    const write = (target: string) =>
      `node "${path.join(control, "write.js")}" "${target}"`;
    await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
      name: "Paused worktree run",
      worktree,
      steps: [
        ...leadingSteps,
        {
          type: "script",
          script: `${write("lane.txt")} && node "${path.join(control, "gate.js")}" "${path.join(control, "a")}"`,
        },
        { type: "script", script: write(path.join(control, "second-ran")) },
      ],
    });
    commitAll(workspace, "add workflow");
    const parent = createInstance();
    instances.push(parent);
    assert.strictEqual(
      await parent.loadPromptFile(path.join(workspace, "parent.ctrlyoke.json")),
      true
    );
    const execution = parent.executeLoadedPromptFile();
    await waitForFile(path.join(control, "a-runs"));
    await parent.pause();
    await fs.writeFile(path.join(control, "a-go"), "");
    await settlesWithin("the paused execution", execution, 60_000);
    assert.strictEqual(
      parent.promptQueue.getState().status,
      EXECUTION_STATES.PAUSED
    );
    return parent;
  }

  /**
   * Where a run's worktree keeps its execution leases. Lease scopes live in
   * the Git common directory, so the path outlives a removed worktree.
   */
  async function worktreeLeasesRoot(
    instance: WorkflowInstance
  ): Promise<string> {
    const { executionRoot } = await worktreeRuntimeOf(instance);
    return (await ExecutionRootLeaseManager.getScopeInfo(executionRoot))
      .leasesRoot;
  }

  /** The run's runner lock file, and the leases held on its worktree. */
  async function runReservations(
    instance: WorkflowInstance,
    workspace: string,
    leasesRoot: string
  ): Promise<{ runnerLock: boolean; leases: number }> {
    const { workflowKey } = instance.promptQueue.getState();
    assert.ok(workflowKey);
    const runnerLock = await fs
      .access(WorkflowPaths.runnerLockPath(workspace, workflowKey))
      .then(
        () => true,
        () => false
      );
    const leases = (await fs.readdir(leasesRoot).catch(() => [])).filter(
      (name) => name.endsWith(".json")
    ).length;
    return { runnerLock, leases };
  }

  test("stopping a paused managed merge run settles its worktree and releases its lease and runner lock", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-paused-managed-stop-");
    const control = makeTempDir("ctrlyoke-paused-managed-stop-control-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      const parent = await pausedWorktreeRun(
        workspace,
        control,
        { mode: "managed", merge: true },
        createInstance,
        instances
      );
      const leasesRoot = await worktreeLeasesRoot(parent);
      // The pause keeps the reservation for Continue.
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        {
          runnerLock: true,
          leases: 1,
        }
      );
      const paused = await worktreeRuntimeOf(parent);
      assert.strictEqual(paused.landingOutcome, undefined);

      await withoutStopFallback(() =>
        settlesWithin("the stop", parent.stop(), 60_000)
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        {
          runnerLock: false,
          leases: 0,
        }
      );
      const settled = await worktreeRuntimeOf(parent);
      assert.strictEqual(settled.landingOutcome, "landed");
      assert.strictEqual(settled.mergeOutcome, "fast-forward");
      assert.strictEqual(
        await fs.readFile(path.join(workspace, "lane.txt"), "utf8"),
        "ran\n",
        "the stopped run's work merged into the main checkout"
      );
      await assert.rejects(fs.access(path.join(control, "second-ran")));

      // Nothing is left to block a Continue, which runs the step after the
      // pause.
      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent), 60_000)
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      await fs.access(path.join(control, "second-ran"));
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        {
          runnerLock: false,
          leases: 0,
        }
      );
    } finally {
      await fs.writeFile(path.join(control, "a-go"), "").catch(() => {});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(control);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("stopping a paused named worktree run keeps its worktree and releases its lease and runner lock", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-paused-named-stop-");
    const control = makeTempDir("ctrlyoke-paused-named-stop-control-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      const parent = await pausedWorktreeRun(
        workspace,
        control,
        { mode: "named", branch: "lane/paused" },
        createInstance,
        instances
      );
      const worktreePath = await realWorktreePathOf(parent);
      const leasesRoot = await worktreeLeasesRoot(parent);
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        {
          runnerLock: true,
          leases: 1,
        }
      );

      await withoutStopFallback(() =>
        settlesWithin("the stop", parent.stop(), 60_000)
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        {
          runnerLock: false,
          leases: 0,
        }
      );
      // A named worktree is never merged or removed.
      await fs.access(path.join(worktreePath, "lane.txt"));
      await assert.rejects(fs.access(path.join(workspace, "lane.txt")));

      // Another run can take the released worktree.
      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent), 60_000)
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      await fs.access(path.join(control, "second-ran"));
    } finally {
      await fs.writeFile(path.join(control, "a-go"), "").catch(() => {});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(control);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  /**
   * A managed merge run paused inside a gated group, with `press` run the
   * moment the group confirms PAUSED, while the executor is still unwinding
   * from it: whatever `press` does, the run ends STOPPED with its worktree
   * landed and its lease and runner lock released.
   */
  async function stopsManagedGroupMidUnwind(
    prefix: string,
    press: (parent: WorkflowInstance) => Promise<void>[]
  ): Promise<void> {
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir(prefix);
    const control = makeTempDir(`${prefix}control-`);
    const { createInstance, instances } = makeInstanceFactory(workspace);
    configService.setCliOverlay({ queue: { maxParallelSteps: 2 } });
    try {
      initGitRepository(workspace);
      await writeGateScript(control);
      const gate = (name: string) =>
        `node "${path.join(control, "gate.js")}" "${path.join(control, name)}"`;
      await writeJson(path.join(workspace, "parent.ctrlyoke.json"), {
        name: "Paused managed group",
        worktree: { mode: "managed", merge: true },
        steps: [
          {
            parallel: [
              {
                type: "script",
                script: `node -e "require('fs').writeFileSync('lane.txt','')" && ${gate("a")}`,
              },
              { type: "script", script: gate("b") },
              { type: "script", script: gate("c") },
            ],
            failFast: false,
          },
        ],
      });
      commitAll(workspace, "add workflow");
      const parent = createInstance();
      instances.push(parent);
      assert.strictEqual(
        await parent.loadPromptFile(
          path.join(workspace, "parent.ctrlyoke.json")
        ),
        true
      );
      const execution = parent.executeLoadedPromptFile();
      await waitForFile(path.join(control, "a-runs"));
      await waitForFile(path.join(control, "b-runs"));
      const leasesRoot = await worktreeLeasesRoot(parent);
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        {
          runnerLock: true,
          leases: 1,
        }
      );

      let presses: Promise<void>[] | undefined;
      let unsettledAtPress: boolean | undefined;
      parent.promptQueue.onDidChangeState((state) => {
        if (presses || state.status !== EXECUTION_STATES.PAUSED) return;
        // The paused execution has not settled (it clears startPending).
        unsettledAtPress = parent.startPending;
        presses = press(parent);
      });
      await withoutStopFallback(async () => {
        await parent.pause();
        await fs.writeFile(path.join(control, "a-go"), "");
        await fs.writeFile(path.join(control, "b-go"), "");
        await settlesWithin("the paused execution", execution, 60_000);
        await waitFor("the presses", () => presses !== undefined);
        for (const pressed of presses!) {
          await settlesWithin("a press", pressed, 60_000);
        }
      });
      assert.strictEqual(unsettledAtPress, true, "pressed mid-unwind");
      const stopped = parent.promptQueue.getState();
      assert.strictEqual(
        stopped.status,
        EXECUTION_STATES.STOPPED,
        JSON.stringify(stopped.results)
      );
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        {
          runnerLock: false,
          leases: 0,
        }
      );
      const settled = await worktreeRuntimeOf(parent);
      assert.strictEqual(settled.landingOutcome, "landed");
      assert.strictEqual(settled.mergeOutcome, "fast-forward");
      await fs.access(path.join(workspace, "lane.txt"));
      await assert.rejects(fs.access(path.join(control, "c-runs")));
    } finally {
      configService.setCliOverlay({});
      for (const name of ["a", "b", "c"]) {
        await fs
          .writeFile(path.join(control, `${name}-go`), "")
          .catch(() => {});
      }
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(control);
      removeTempDir(`${workspace}.worktrees`);
    }
  }

  test("a stop landing while a managed run's parallel group unwinds its pause settles the worktree", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    // The settlement the stop waits for runs as PAUSED and keeps the
    // reservation, which the stop must then end.
    await stopsManagedGroupMidUnwind(
      "ctrlyoke-paused-managed-group-stop-",
      (parent) => [parent.stop()]
    );
  });

  test("a stop pressed after a Continue while a managed run's parallel group unwinds its pause settles the worktree", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    await stopsManagedGroupMidUnwind(
      "ctrlyoke-paused-managed-group-continue-stop-",
      (parent) => [parent.resume(), parent.stop()]
    );
  });

  test("stopping a paused managed run lands it only through the strict artifact check, and releases its parked terminals", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-paused-managed-artifact-stop-");
    const control = makeTempDir("ctrlyoke-paused-managed-artifact-control-");
    const integration = new ArtifactLeavingIntegration(undefined, false);
    const { createInstance, instances } = makeInstanceFactory(
      workspace,
      integration
    );
    try {
      const parent = await pausedWorktreeRun(
        workspace,
        control,
        { mode: "managed", merge: true },
        createInstance,
        instances,
        [{ prompt: "write the provider hooks" }]
      );
      assert.deepStrictEqual(integration.sentPrompts, [
        "write the provider hooks",
      ]);
      // The pause kept the worktree, so it ran only the best-effort cleanup
      // and left the integration's terminal open.
      assert.ok(integration.bestEffortCleanups > 0, "best-effort cleanup ran");
      assert.deepStrictEqual(integration.strictCleanupRoots, []);
      assert.deepStrictEqual(integration.closedTerminals, []);
      const leasesRoot = await worktreeLeasesRoot(parent);

      await withoutStopFallback(() =>
        settlesWithin("the stop", parent.stop(), 60_000)
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      assert.ok(
        integration.strictCleanupRoots.length > 0,
        "the stop ran the strict cleanup a terminal settlement runs"
      );
      assert.ok(integration.closedTerminals.length > 0, "terminals closed");
      assert.ok(
        integration.closedTerminals.every(
          (reason) => reason === TERMINAL_END_REASONS.WORKTREE_RELEASED
        ),
        integration.closedTerminals.join(", ")
      );
      const settled = await worktreeRuntimeOf(parent);
      assert.strictEqual(settled.landingOutcome, "blocked");
      assert.ok(
        settled.message?.includes(ArtifactLeavingIntegration.LEFT_ARTIFACT),
        String(settled.message)
      );
      await assert.rejects(
        fs.access(path.join(workspace, "lane.txt")),
        "nothing landed in the main checkout"
      );
      assert.strictEqual(
        (await runReservations(parent, workspace, leasesRoot)).runnerLock,
        false
      );
    } finally {
      await fs.writeFile(path.join(control, "a-go"), "").catch(() => {});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(control);
      removeTempDir(`${workspace}.worktrees`);
    }
  });

  test("a stop landing just as a Continue marks its startup settles the paused managed run's reservation", async function () {
    // Real git under a loaded `npm test` (see WorktreeManager.test.ts).
    this.timeout(180_000);
    const restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 120_000,
    });
    const workspace = makeTempDir("ctrlyoke-paused-managed-startup-stop-");
    const control = makeTempDir("ctrlyoke-paused-managed-startup-control-");
    const { createInstance, instances } = makeInstanceFactory(workspace);
    try {
      const parent = await pausedWorktreeRun(
        workspace,
        control,
        { mode: "managed", merge: true },
        createInstance,
        instances
      );
      const leasesRoot = await worktreeLeasesRoot(parent);
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        { runnerLock: true, leases: 1 }
      );

      // The Continue has marked its pre-dispatch startup but done none of
      // its setup when the stop lands.
      let stop: Promise<void> | undefined;
      parent.afterStartupMarked = async () => {
        stop = parent.stop();
        await stop;
      };
      const cancellations = recordAttemptCancellations(parent);
      await withoutStopFallback(() =>
        settlesWithin("the overtaken continue", parent.resume(), 60_000)
      );
      assert.ok(stop, "the stop landed inside the continue's startup");
      assert.deepStrictEqual(cancellations(), [], "no attempt was cancelled");
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.STOPPED
      );
      assert.deepStrictEqual(
        await runReservations(parent, workspace, leasesRoot),
        { runnerLock: false, leases: 0 }
      );
      const settled = await worktreeRuntimeOf(parent);
      assert.strictEqual(settled.landingOutcome, "landed");
      assert.strictEqual(settled.mergeOutcome, "fast-forward");
      await assert.rejects(fs.access(path.join(control, "second-ran")));

      await withoutStopFallback(() =>
        settlesWithin("the continue", continueParent(parent), 60_000)
      );
      assert.strictEqual(
        parent.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      await fs.access(path.join(control, "second-ran"));
    } finally {
      await fs.writeFile(path.join(control, "a-go"), "").catch(() => {});
      restoreGitTimeouts();
      await disposeAll(instances, workspace);
      removeTempDir(control);
      removeTempDir(`${workspace}.worktrees`);
    }
  });
});
