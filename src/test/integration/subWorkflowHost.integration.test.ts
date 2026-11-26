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
import { FINAL_STEP_PHASES, STEP_STATUS } from "../../types/DashboardConstants";
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

  function makeInstanceFactory(workspace: string) {
    const platform = new MockPlatform(workspace);
    const integrationFactory = new MockIntegrationFactory(platform);
    const detector = new MockHarnessIntegration(undefined, false);
    const instances: WorkflowInstance[] = [];
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
      return child;
    });
    return { createInstance, instances };
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
      await instance.stop();
      await execution;
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
    const { createInstance, instances } = makeInstanceFactory(workspace);
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
      await parent.stop();
      await execution;
      assert.strictEqual(parent.promptQueue.getState().status, "stopped");
      assert.strictEqual(instances[0].promptQueue.getState().status, "stopped");
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
