import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
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

suite("Sub-workflow host end to end", () => {
  test("runs child scripts, links child runs, and fails through a child failure or cycle", async () => {
    const workspace = makeTempDir("ctrlyoke-subworkflow-");
    const instances: WorkflowInstance[] = [];
    try {
      const platform = new MockPlatform(workspace);
      const integrationFactory = new MockIntegrationFactory(platform);
      const detector = new MockHarnessIntegration(undefined, false);
      let launcher: SubWorkflowLauncher;
      launcher = new SubWorkflowLauncher(({ ancestorPaths }) => {
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
          { subWorkflowHost: launcher, ancestorPaths }
        );
        instances.push(child);
        return child;
      });

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
