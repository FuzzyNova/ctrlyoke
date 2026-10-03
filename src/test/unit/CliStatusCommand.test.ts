import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { statusCommand } from "../../cli/CliStatusCommand";
import type { CliWorkspaceBootstrap } from "../../cli/CliWorkspaceBootstrap";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { EXECUTION_STATES, RUNNER_IDS } from "../../types/DashboardConstants";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

suite("CliStatusCommand", () => {
  let root: string;

  teardown(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function createWorkspace(
    withLock: boolean
  ): Promise<CliWorkspaceBootstrap> {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-status-"));
    const workflowKey = "status-workflow-2026-01-01T00-00-00" as WorkflowKey;
    const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const descriptorPath = WorkflowPaths.descriptorPath(root, workflowKey);
    const runPath = WorkflowPaths.runFilePath(root, workflowKey, runRef);
    await fs.mkdir(path.dirname(runPath), { recursive: true });
    await fs.writeFile(
      descriptorPath,
      JSON.stringify({
        schemaVersion: 1,
        workflowKey,
        workflowName: "Status fixture",
        isFavorite: false,
        createdAt: 1,
        lastModifiedAt: 1,
        latestRunRef: runRef,
        nextRunId: 2,
        revision: 1,
      })
    );
    await fs.writeFile(
      runPath,
      JSON.stringify({
        startedAt: 1_000,
        definitionRevision: 1,
        harness: "codex-cli",
        model: "gpt-6-luna",
        steps: [{ prompt: "fixture" }],
        _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.RUNNING },
      })
    );
    if (withLock) {
      await fs.writeFile(
        WorkflowPaths.runnerLockPath(root, workflowKey),
        JSON.stringify({
          schemaVersion: 2,
          workflowKey,
          runRef,
          runner: RUNNER_IDS.CLI,
          pid: process.pid,
          hostInstanceId: "test-host",
          executionInstanceId: "test-execution",
          ownerToken: "test-token",
          startedAt: 1_000,
          lastHeartbeat: 9_500,
        })
      );
    }
    return {
      workspaceRoot: root,
      createLineageRepository: () => new WorkflowLineageRepository(),
      createOutputHistoryManager: () => {
        throw new Error("not used by status");
      },
    };
  }

  test("emits stable JSON fields and reports a live matching runner", async () => {
    const workspace = await createWorkspace(true);
    const output: string[] = [];
    await statusCommand(
      { json: true },
      { writeOut: (message) => output.push(message) },
      {
        bootstrapCliWorkspace: async () => workspace,
        now: () => 10_000,
      }
    );
    const result = JSON.parse(output[0]);
    assert.strictEqual(result.workflowCount, 1);
    assert.deepStrictEqual(result.workflows[0].liveness, {
      state: "alive",
      heartbeatAgeMs: 500,
      pid: process.pid,
      lastHeartbeat: 9_500,
    });
    assert.strictEqual(result.workflows[0].workflowName, "Status fixture");
    assert.strictEqual(result.workflows[0].currentStep, 1);
  });

  test("reports a running workflow as stale when its runner lock is absent", async () => {
    const workspace = await createWorkspace(false);
    const output: string[] = [];
    await statusCommand(
      {},
      { writeOut: (message) => output.push(message) },
      { bootstrapCliWorkspace: async () => workspace }
    );
    assert.match(output[0], /WORKFLOW.*RUN.*STATE.*STEP.*HEARTBEAT.*LIVENESS/);
    assert.match(output[0], /stale/);
  });
});
