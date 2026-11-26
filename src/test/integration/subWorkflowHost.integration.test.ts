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
import { STEP_STATUS } from "../../types/DashboardConstants";
import { isSubWorkflowStep } from "../../types/CtrlYokeTypes";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";

suite("Sub-workflow host end to end", () => {
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
      launcher = new SubWorkflowLauncher(
        ({ ancestorPaths, delegationChain }) => {
          const instance = new WorkflowInstance(
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
            { subWorkflowHost: launcher, ancestorPaths, delegationChain }
          );
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
      const parent = new WorkflowInstance(
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
        { subWorkflowHost: launcher }
      );
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
      const secondParent = new WorkflowInstance(
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
        { subWorkflowHost: launcher }
      );
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
      launcher = new SubWorkflowLauncher(
        ({ ancestorPaths, delegationChain }) => {
          const child: WorkflowInstance = new WorkflowInstance(
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
            { subWorkflowHost: launcher, ancestorPaths, delegationChain }
          );
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
      const parent = new WorkflowInstance(
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
        { subWorkflowHost: launcher }
      );
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
      assert.ok(childManifest.parentRun?.stepId);

      await writeWorkflow(child, [
        { type: "script", script: 'node -e "process.exit(1)"' },
      ]);
      const failingParent = new WorkflowInstance(
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
        { subWorkflowHost: launcher }
      );
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
      const cyclicParent = new WorkflowInstance(
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
        { subWorkflowHost: launcher }
      );
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
