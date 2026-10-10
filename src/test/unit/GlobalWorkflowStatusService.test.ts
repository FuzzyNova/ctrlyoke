import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { RUNNER_IDS, EXECUTION_STATES } from "../../types/DashboardConstants";
import {
  GlobalWorkflowStatusService,
  MCP_GLOBAL_STATUS_WORDING,
} from "../../core/orchestration/GlobalWorkflowStatusService";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

suite("GlobalWorkflowStatusService", () => {
  let root: string | undefined;

  teardown(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("keeps the MCP global_status error strings by default", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-global-status-"));
    for (const service of [
      new GlobalWorkflowStatusService(root),
      new GlobalWorkflowStatusService(
        root,
        undefined,
        MCP_GLOBAL_STATUS_WORDING
      ),
    ]) {
      await assert.rejects(
        service.getStatus({ runRef: "run-2026-01-01T00-00-00-000Z" as RunRef }),
        { message: "global_status: runRef requires workflowKey" }
      );
      await assert.rejects(
        service.getStatus({ workflowKey: "missing-workflow" as WorkflowKey }),
        (error: Error) =>
          error.message.startsWith(
            "global_status: no workflow 'missing-workflow' was found under "
          ) &&
          error.message.endsWith(
            "). Call global_status with no arguments to see the workflow keys that exist."
          )
      );
    }
  });

  test("uses the caller's wording for another surface", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-global-status-"));
    const service = new GlobalWorkflowStatusService(root, undefined, {
      surface: "status",
      runRequiresWorkflow: "--run requires --workflow",
      listWorkflowsHint: "List them first.",
    });
    await assert.rejects(
      service.getStatus({ runRef: "run-2026-01-01T00-00-00-000Z" as RunRef }),
      { message: "status: --run requires --workflow" }
    );
    await assert.rejects(
      service.getStatus({ workflowKey: "missing-workflow" as WorkflowKey }),
      (error: Error) =>
        error.message.startsWith("status: no workflow 'missing-workflow'") &&
        error.message.endsWith("). List them first.")
    );
  });

  test("reports the locked older run when latest run is completed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-global-status-"));
    const workflowKey = "status-workflow-2026-01-01T00-00-00" as WorkflowKey;
    const olderRun = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const latestRun = "run-2026-01-02T00-00-00-000Z" as RunRef;
    await fs.mkdir(WorkflowPaths.lineageDir(root, workflowKey), {
      recursive: true,
    });
    await fs.writeFile(
      WorkflowPaths.descriptorPath(root, workflowKey),
      JSON.stringify({
        schemaVersion: 1,
        workflowKey,
        workflowName: "Status fixture",
        isFavorite: false,
        createdAt: 1,
        lastModifiedAt: 1,
        latestRunRef: latestRun,
        nextRunId: 3,
        revision: 1,
      })
    );
    for (const [runRef, executionState] of [
      [olderRun, EXECUTION_STATES.RUNNING],
      [latestRun, EXECUTION_STATES.COMPLETED],
    ] as const) {
      const runFilePath = WorkflowPaths.runFilePath(root, workflowKey, runRef);
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          startedAt: 1_000,
          harness: "codex-cli",
          steps: [{ prompt: "fixture" }],
          _runtime: { currentIndex: 0, executionState },
        })
      );
    }
    await fs.writeFile(
      WorkflowPaths.runnerLockPath(root, workflowKey),
      JSON.stringify({
        schemaVersion: 2,
        workflowKey,
        runRef: olderRun,
        runner: RUNNER_IDS.CLI,
        pid: process.pid,
        hostInstanceId: "test-host",
        executionInstanceId: "test-execution",
        ownerToken: "test-token",
        startedAt: 1_000,
        lastHeartbeat: 9_500,
      })
    );

    const service = new GlobalWorkflowStatusService(root);
    for (const selector of [{}, { workflowKey }]) {
      const result = await service.getStatus(selector);
      assert.strictEqual(result.workflowCount, 1);
      assert.strictEqual(result.workflows[0].runRef, olderRun);
      assert.strictEqual(
        result.workflows[0].executionState,
        EXECUTION_STATES.RUNNING
      );
      assert.strictEqual(result.note, undefined);
    }
  });
});
