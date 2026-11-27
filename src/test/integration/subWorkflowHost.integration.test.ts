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

  function makeInstanceFactory(workspace: string) {
    const platform = new MockPlatform(workspace);
    const integrationFactory = new MockIntegrationFactory(platform);
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
      // The child follows the ordinary stopped-run rule: its cancelled script
      // step stays settled and continuation resumes after it. The sentinel
      // only keeps the script from hanging if that rule ever changes.
      assert.strictEqual(
        continuedChild.promptQueue.getState().results[1]?.status,
        STEP_STATUS.CANCELLED
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
});
