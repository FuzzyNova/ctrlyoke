import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test } from "mocha";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import { SubWorkflowLauncher } from "../../core/orchestration/SubWorkflowLauncher";
import { buildManagedAutoCommitMessage } from "../../core/orchestration/WorktreeManager";
import {
  MockHarnessIntegration,
  MockIntegrationFactory,
  MockPlatform,
} from "../helpers/mockHarness";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { captureLog } from "../helpers/logCapture";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
  SUB_WORKFLOW_CANCELLATION_SOURCES,
} from "../../types/DashboardConstants";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import {
  isSubWorkflowStep,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { setGitTimeoutOverridesForTests } from "../../utils/GitUtils";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { configService } from "../../config/CtrlYokeConfigService";
import { HarnessAdapterUtils } from "../../core/harness/shared/HarnessAdapterUtils";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { PromptFileResolver } from "../../core/PromptFileResolver";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WorkflowInstanceRegistry } from "../../core/orchestration/WorkflowInstanceRegistry";
import { TestWorkflowInstanceRegistryHost } from "../helpers/workflowInstanceRegistryHost";

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
    }
  ): WorkflowInstance {
    return new WorkflowInstance(
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
      undefined,
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
    onChildCreated?: (child: WorkflowInstance) => void
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
        childOptions
      );
    launcher = new SubWorkflowLauncher(
      ({ ancestorPaths, delegationChain, concurrent }) => {
        concurrentLaunches.push(concurrent);
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
    return { createInstance, instances, childAt, concurrentLaunches };
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
    predicate: () => boolean
  ): Promise<void> {
    const deadline = Date.now() + 10000;
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

  /**
   * A registry wired like the VS Code host's: every child the launcher
   * creates is a registry instance that no client views, so the registry's
   * own lifecycle (retire on a terminal state, dispose when unviewed) applies
   * to it. The parent is viewed by the panel, as a workflow a user continues.
   */
  /** A registry-built instance can host a PTY; these scripts run headless. */
  const HEADLESS = { executionMode: "headless" } as const;

  function makeRegistry(workspace: string) {
    const host = new TestWorkflowInstanceRegistryHost(workspace);
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
    return { registry, parent, residents, disposeHost };
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
      // Not asserted: that the grandchild's branch starts at the checkpoint.
      // That needs D4b (the parent's checkout as the child's source checkout),
      // which is not implemented yet; until then a worktree child branches
      // from the main checkout's HEAD, as a top-level run does.
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
});
