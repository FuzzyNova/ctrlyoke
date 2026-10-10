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
    withLock: boolean,
    lockOverrides: Record<string, unknown> = {},
    executionState: string = EXECUTION_STATES.RUNNING
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
        _runtime: { currentIndex: 0, executionState },
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
          ...lockOverrides,
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
      reason: "active",
      heartbeatAgeMs: 500,
      pid: process.pid,
      lastHeartbeat: 9_500,
    });
    assert.strictEqual(result.workflows[0].workflowName, "Status fixture");
    assert.strictEqual(result.workflows[0].currentStep, 1);
  });

  test("reports the locked older run as alive when a newer run is latest", async () => {
    const workspace = await createWorkspace(true);
    const workflowKey = "status-workflow-2026-01-01T00-00-00" as WorkflowKey;
    const olderRun = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const latestRun = "run-2026-01-02T00-00-00-000Z" as RunRef;
    const descriptorPath = WorkflowPaths.descriptorPath(root, workflowKey);
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
    descriptor.latestRunRef = latestRun;
    await fs.writeFile(descriptorPath, JSON.stringify(descriptor));
    const latestRunPath = WorkflowPaths.runFilePath(
      root,
      workflowKey,
      latestRun
    );
    await fs.mkdir(path.dirname(latestRunPath), { recursive: true });
    await fs.writeFile(
      latestRunPath,
      JSON.stringify({
        startedAt: 1_000,
        harness: "codex-cli",
        steps: [{ prompt: "fixture" }],
        _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.COMPLETED },
      })
    );

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
    assert.strictEqual(result.workflows[0].runRef, olderRun);
    assert.strictEqual(result.workflows[0].liveness.state, "alive");
    assert.strictEqual(result.workflows[0].liveness.reason, "active");
  });

  test("reports a running workflow as stale when its runner lock is absent", async () => {
    const workspace = await createWorkspace(false);
    const output: string[] = [];
    await statusCommand(
      {},
      { writeOut: (message) => output.push(message) },
      { bootstrapCliWorkspace: async () => workspace }
    );
    assert.match(
      output[0],
      /WORKFLOW.*RUN.*STATE.*STEP.*PID.*HEARTBEAT.*LIVENESS/
    );
    assert.match(output[0], /stale \(absent\)/);
  });

  test("keeps a dead-PID lock's evidence and names why it is stale", async () => {
    const workspace = await createWorkspace(true, { pid: 424242 });
    const output: string[] = [];
    await statusCommand(
      { json: true },
      { writeOut: (message) => output.push(message) },
      {
        bootstrapCliWorkspace: async () => workspace,
        isProcessAlive: (pid) => pid !== 424242,
        now: () => 10_000,
      }
    );
    assert.deepStrictEqual(JSON.parse(output[0]).workflows[0].liveness, {
      state: "stale",
      reason: "stale-dead-pid",
      heartbeatAgeMs: 500,
      pid: 424242,
      lastHeartbeat: 9_500,
    });

    const text: string[] = [];
    await statusCommand(
      {},
      { writeOut: (message) => text.push(message) },
      {
        bootstrapCliWorkspace: async () => workspace,
        isProcessAlive: (pid) => pid !== 424242,
        now: () => 10_000,
      }
    );
    assert.match(text[0], /424242/);
    assert.match(text[0], /stale \(stale-dead-pid\)/);
    assert.doesNotMatch(text[0], /NaN/);
  });

  test("reports a silent heartbeat separately from a dead process", async () => {
    const workspace = await createWorkspace(true, { lastHeartbeat: 1_000 });
    const output: string[] = [];
    await statusCommand(
      { json: true },
      { writeOut: (message) => output.push(message) },
      {
        bootstrapCliWorkspace: async () => workspace,
        isProcessAlive: () => true,
        now: () => 100_000,
      }
    );
    const liveness = JSON.parse(output[0]).workflows[0].liveness;
    assert.strictEqual(liveness.reason, "stale-heartbeat");
    assert.strictEqual(liveness.heartbeatAgeMs, 99_000);
  });

  test("text mode says when nothing is executing and prints the narrowing note", async () => {
    const workspace = await createWorkspace(
      false,
      {},
      EXECUTION_STATES.COMPLETED
    );
    const output: string[] = [];
    await statusCommand(
      { workflow: "status-workflow-2026-01-01T00-00-00" },
      { writeOut: (message) => output.push(message) },
      { bootstrapCliWorkspace: async () => workspace }
    );
    assert.match(output[0], /^No workflows are executing\./);
    assert.match(output[0], /exists but is not executing \(state: completed\)/);
  });

  test("names CLI flags rather than MCP arguments in selector errors", async () => {
    const workspace = await createWorkspace(false);
    await assert.rejects(
      statusCommand(
        { run: "run-2026-01-01T00-00-00-000Z" },
        { writeOut: () => {} },
        { bootstrapCliWorkspace: async () => workspace }
      ),
      { message: "status: --run requires --workflow" }
    );
  });
});
