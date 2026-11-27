import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test } from "mocha";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import { SubWorkflowLauncher } from "../../core/orchestration/SubWorkflowLauncher";
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
import { isSubWorkflowStep } from "../../types/CtrlYokeTypes";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { setGitTimeoutOverridesForTests } from "../../utils/GitUtils";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { HarnessAdapterUtils } from "../../core/harness/shared/HarnessAdapterUtils";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";

suite("Sub-workflow host end to end", () => {
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
    beforeChildLoad?: () => Promise<void>
  ) {
    const platform = new MockPlatform(workspace);
    const integrationFactory = new MockIntegrationFactory(
      platform,
      executionIntegration
    );
    const detector = new MockHarnessIntegration(undefined, false);
    const instances: WorkflowInstance[] = [];
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
    launcher = new SubWorkflowLauncher(({ ancestorPaths, delegationChain }) => {
      const child = createInstance({ ancestorPaths, delegationChain });
      instances.push(child);
      if (beforeChildLoad) {
        const load = child.loadPromptFile.bind(child);
        child.loadPromptFile = async (...args) => {
          await beforeChildLoad();
          return load(...args);
        };
      }
      // ancestorPaths lists the root and every workflow above the child.
      const depth = ancestorPaths.length - 1;
      childrenAtDepth.set(depth, [
        ...(childrenAtDepth.get(depth) ?? []),
        child,
      ]);
      return child;
    });
    const childAt = (depth: number, launch = 0): WorkflowInstance => {
      const child = childrenAtDepth.get(depth)?.[launch];
      assert.ok(child, `no child launched at depth ${depth}`);
      return child;
    };
    return { createInstance, instances, childAt };
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
   * parent step — plus a macrotask for the parent to react.
   */
  async function waitForChildPausedCycle(
    child: WorkflowInstance
  ): Promise<void> {
    await waitFor(
      "the child to pause",
      () => child.promptQueue.getState().status === "paused"
    );
    await child.whenExecutionSettled();
    await new Promise((resolve) => setTimeout(resolve, 200));
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
        vars: { value: "authored", other: "EXPANDED" },
        steps: [
          {
            type: "workflow",
            name: "check src/core",
            workflow: {
              type: "script",
              script:
                "node -e \"require('fs').writeFileSync('inline-var.txt','{{value}}')\"",
            },
          },
          { type: "workflow", workflow: { prompt: "say {{value}}" } },
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
        "check src/core"
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
});
