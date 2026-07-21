import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, test } from "mocha";
import { CtrlYokeMCPServer } from "../../mcp-server";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES, RUNNER_IDS } from "../../types/DashboardConstants";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";

interface RunFixture {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runFilePath: string;
}

function responseJson(result: unknown): any {
  const typed = result as { content: Array<{ text: string }> };
  return JSON.parse(typed.content[0].text);
}

suite("CtrlYokeMCPServer run-addressed contracts", () => {
  let workspaceRoot: string;
  let priorPinnedFile: string | undefined;

  afterEach(async () => {
    if (priorPinnedFile === undefined) {
      delete process.env.CTRLYOKE_WORKING_FILE;
    } else {
      process.env.CTRLYOKE_WORKING_FILE = priorPinnedFile;
    }
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  async function createRun(
    suffix: string,
    runTime: string,
    options: { prompt?: string; responseText?: string } = {}
  ): Promise<RunFixture> {
    const workflowKey = `mcp-${suffix}-2026-01-01T00-00-00` as WorkflowKey;
    const runRef = `run-${runTime}` as RunRef;
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const descriptor: WorkflowLineageDescriptor = {
      schemaVersion: 1,
      workflowKey,
      workflowName: `MCP ${suffix}`,
      isFavorite: false,
      createdAt: 1,
      lastModifiedAt: 1,
      latestRunRef: runRef,
      nextRunId: 2,
      revision: 3,
    };
    const workingFile: WorkingFile = {
      workflowName: descriptor.workflowName,
      startedAt: 1,
      lastModifiedAt: 1,
      definitionRevision: 4,
      steps: [
        {
          prompt: options.prompt ?? `prompt-${suffix}`,
          _runtime: {
            startedAt: 1,
            completedAt: 2,
            sessionId: `session-${suffix}`,
          },
        },
      ],
      _runtime: {
        currentIndex: 1,
        executionState: EXECUTION_STATES.COMPLETED,
      },
    };
    await fs.mkdir(path.dirname(runFilePath), { recursive: true });
    await fs.writeFile(
      WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
      JSON.stringify(descriptor),
      "utf8"
    );
    await fs.writeFile(runFilePath, JSON.stringify(workingFile), "utf8");
    const recorder = new TimelineRecorder();
    const manifestPath = await recorder.initializeRunAt(
      path.dirname(runFilePath),
      workflowKey,
      1,
      1,
      EXECUTION_STATES.COMPLETED,
      1,
      { workflowName: descriptor.workflowName, steps: workingFile.steps ?? [] }
    );
    await recorder.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 2,
        target: { kind: "queue", stepIndex: 0 },
        runIndex: 0,
        attemptIndex: 0,
        definitionRevision: 1,
        responseKind: "ai",
        payload: {
          cliOutput: {
            prompt: options.prompt ?? `prompt-${suffix}`,
            response: options.responseText ?? `output-${suffix}`,
            elapsed: 1,
            isStreaming: false,
          },
        },
      },
    ]);
    return { workflowKey, runRef, runFilePath };
  }

  async function setup(): Promise<CtrlYokeMCPServer> {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-mcp-"));
    priorPinnedFile = process.env.CTRLYOKE_WORKING_FILE;
    delete process.env.CTRLYOKE_WORKING_FILE;
    return new CtrlYokeMCPServer({ workspaceRoot });
  }

  test("publishes stable selector and revision schemas", async () => {
    const server = await setup();
    const tools = server.getToolDefinitions();
    for (const name of [
      "ctrlyoke_queue_status",
      "ctrlyoke_append_queue",
      "ctrlyoke_read_output",
      "ctrlyoke_global_status",
    ]) {
      const tool: any = tools.find((candidate) => candidate.name === name)!;
      assert.ok(tool.inputSchema.properties.workflowKey);
      assert.ok(tool.inputSchema.properties.runRef);
    }
    const append: any = tools.find(
      (candidate) => candidate.name === "ctrlyoke_append_queue"
    )!;
    assert.ok(append.inputSchema.properties.expectedDefinitionRevision);
    assert.deepStrictEqual(append.inputSchema.properties.position.enum, [
      "end",
    ]);
  });

  test("reads an explicitly selected historical run and returns its address", async () => {
    const server = await setup();
    const older = await createRun("older", "2026-01-01T00-00-00-000Z", {
      responseText: "historical output",
    });
    const current = await createRun("current", "2026-01-02T00-00-00-000Z");

    const status = responseJson(
      await server.invokeTool("ctrlyoke_queue_status", older)
    );
    const output = responseJson(
      await server.invokeTool("ctrlyoke_read_output", older)
    );
    const global = responseJson(
      await server.invokeTool("ctrlyoke_global_status", older)
    );

    assert.strictEqual(status.metadata.workflowKey, older.workflowKey);
    assert.strictEqual(status.metadata.runRef, older.runRef);
    assert.strictEqual(output.workflowKey, older.workflowKey);
    assert.strictEqual(output.runRef, older.runRef);
    assert.strictEqual(output.outputs[0].responseText, "historical output");
    assert.deepStrictEqual(
      global.workflows.map((workflow: any) => ({
        workflowKey: workflow.workflowKey,
        runRef: workflow.runRef,
      })),
      [{ workflowKey: older.workflowKey, runRef: older.runRef }]
    );
    assert.notStrictEqual(older.workflowKey, current.workflowKey);
  });

  test("requires an exact selector unless the environment pins the same run", async () => {
    const server = await setup();
    const pinned = await createRun("pinned", "2026-01-01T00-00-00-000Z");
    const other = await createRun("other", "2026-01-02T00-00-00-000Z");

    await assert.rejects(
      () => server.invokeTool("ctrlyoke_queue_status", {}),
      /workflowKey and runRef are required/i
    );
    process.env.CTRLYOKE_WORKING_FILE = pinned.runFilePath;
    const selected = responseJson(
      await server.invokeTool("ctrlyoke_queue_status", {})
    );
    assert.strictEqual(selected.metadata.runRef, pinned.runRef);
    await assert.rejects(
      () => server.invokeTool("ctrlyoke_read_output", other),
      /conflicts with CTRLYOKE_WORKING_FILE/i
    );
  });

  test("appends through the addressed continuation transaction and returns revisions", async () => {
    const server = await setup();
    const run = await createRun("append", "2026-01-01T00-00-00-000Z");
    const result = responseJson(
      await server.invokeTool("ctrlyoke_append_queue", {
        ...run,
        position: "end",
        expectedDefinitionRevision: 4,
        expectedDescriptorRevision: 3,
        steps: [{ prompt: "new tail", _runtime: { responseText: "omit" } }],
      })
    );
    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;

    assert.strictEqual(result.workflowKey, run.workflowKey);
    assert.strictEqual(result.runRef, run.runRef);
    assert.strictEqual(result.definitionRevision, 5);
    assert.strictEqual(result.descriptorRevision, 4);
    assert.strictEqual(persisted.steps?.length, 2);
    assert.strictEqual(
      persisted.steps?.[0]._runtime?.sessionId,
      "session-append"
    );
    assert.strictEqual(persisted.steps?.[1]._runtime, undefined);
    await assert.rejects(
      () =>
        server.invokeTool("ctrlyoke_append_queue", {
          ...run,
          position: "end",
          expectedDefinitionRevision: 4,
          steps: [{ prompt: "stale" }],
        }),
      /Definition revision conflict: expected 4, found 5/
    );
  });

  test("rejects busy lineages and concurrent stale revisions deterministically", async () => {
    const server = await setup();
    const run = await createRun("busy", "2026-01-01T00-00-00-000Z");
    await WorkflowLockManager.acquireLock(workspaceRoot, run.workflowKey, {
      workflowKey: run.workflowKey,
      runRef: run.runRef,
      runner: RUNNER_IDS.CLI,
      pid: process.pid,
      ownerToken: "mcp-test-owner",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    await assert.rejects(
      () =>
        server.invokeTool("ctrlyoke_append_queue", {
          ...run,
          position: "end",
          steps: [{ prompt: "blocked" }],
        }),
      /Another run in this workflow lineage is executing/
    );
    await WorkflowLockManager.releaseLock(
      workspaceRoot,
      run.workflowKey,
      "mcp-test-owner"
    );

    const results = await Promise.allSettled(
      ["first", "second"].map((prompt) =>
        server.invokeTool("ctrlyoke_append_queue", {
          ...run,
          position: "end",
          expectedDefinitionRevision: 4,
          expectedDescriptorRevision: 3,
          steps: [{ prompt }],
        })
      )
    );
    assert.strictEqual(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.match(
      (
        results.find(
          (result) => result.status === "rejected"
        ) as PromiseRejectedResult
      ).reason.message,
      /revision conflict/i
    );
  });
});
