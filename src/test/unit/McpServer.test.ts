import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, suiteSetup, suiteTeardown, test } from "mocha";
import { CtrlYokeMCPServer, initializeMcpStorage } from "../../mcp-server";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
  WorkingFile,
  WorkingFileWorktreeRuntime,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  RUNNER_IDS,
  RUN_HISTORY_LOCATIONS,
} from "../../types/DashboardConstants";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { ProjectStateRegistry } from "../../utils/ProjectStateRegistry";
import {
  initializeRunHistoryLocation,
  isRunHistoryLocationInitialized,
} from "../../utils/RunHistoryStoragePolicy";
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
  let mcpStateRoot: string;

  suiteSetup(async () => {
    mcpStateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-mcp-test-state-")
    );
    try {
      await initializeMcpStorage(mcpStateRoot);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('already frozen as "user"')
      ) {
        throw error;
      }
    }
    if (!isRunHistoryLocationInitialized()) {
      initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
    }
  });

  suiteTeardown(async () => {
    if (mcpStateRoot) {
      await fs.rm(mcpStateRoot, { recursive: true, force: true });
    }
  });

  let workspaceRoot: string;
  let priorPinnedFile: string | undefined;
  let priorCommitOutput: string | undefined;

  afterEach(async () => {
    if (priorPinnedFile === undefined) {
      delete process.env.CTRLYOKE_WORKING_FILE;
    } else {
      process.env.CTRLYOKE_WORKING_FILE = priorPinnedFile;
    }
    if (priorCommitOutput === undefined) {
      delete process.env.CTRLYOKE_COMMIT_OUTPUT;
    } else {
      process.env.CTRLYOKE_COMMIT_OUTPUT = priorCommitOutput;
    }
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  async function createRun(
    suffix: string,
    runTime: string,
    options: {
      prompt?: string;
      responseText?: string;
      worktree?: WorkingFileWorktreeRuntime;
    } = {}
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
        ...(options.worktree ? { worktree: options.worktree } : {}),
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
    priorCommitOutput = process.env.CTRLYOKE_COMMIT_OUTPUT;
    delete process.env.CTRLYOKE_WORKING_FILE;
    delete process.env.CTRLYOKE_COMMIT_OUTPUT;
    return new CtrlYokeMCPServer({ workspaceRoot });
  }

  function runMcpToolCli(args: string[], env?: NodeJS.ProcessEnv) {
    return spawnSync(
      "node",
      [path.resolve(__dirname, "../../mcp-server.js"), ...args],
      { encoding: "utf8", ...(env ? { env } : {}) }
    );
  }

  test("invokes a tool through the CLI entrypoint", async () => {
    await setup();
    await new ProjectStateRegistry().initialize(workspaceRoot);
    const run = await createRun("cli", "2026-01-01T00-00-00-000Z");
    const success = runMcpToolCli([
      "--tool",
      "ctrlyoke_queue_status",
      "--args",
      "{}",
      "--workspace",
      workspaceRoot,
      "--working-file",
      run.runFilePath,
    ]);

    assert.strictEqual(
      success.status,
      0,
      `CLI failed: stdout=${success.stdout} stderr=${success.stderr}`
    );
    assert.strictEqual(success.stderr, "");
    assert.strictEqual(JSON.parse(success.stdout).metadata.runRef, run.runRef);

    const failure = runMcpToolCli([
      "--tool",
      "unknown_tool",
      "--args",
      "{}",
      "--workspace",
      workspaceRoot,
    ]);

    assert.strictEqual(failure.status, 1);
    assert.strictEqual(failure.stdout, "");
    assert.strictEqual(failure.stderr, "Unknown tool: unknown_tool\n");
  });

  test("writes commit output when the CLI receives --commit-output", async () => {
    await setup();
    const outputPath = path.join(workspaceRoot, "commit-output-flag.txt");
    const result = runMcpToolCli([
      "--tool",
      "ctrlyoke_submit_commit_message",
      "--args",
      JSON.stringify({ message: "feat: capture via flag" }),
      "--workspace",
      workspaceRoot,
      "--commit-output",
      outputPath,
    ]);

    assert.strictEqual(
      result.status,
      0,
      `CLI failed: stdout=${result.stdout} stderr=${result.stderr}`
    );
    assert.strictEqual(
      await fs.readFile(outputPath, "utf8"),
      "feat: capture via flag"
    );
  });

  test("writes commit output when CTRLYOKE_COMMIT_OUTPUT is set", async () => {
    await setup();
    const outputPath = path.join(workspaceRoot, "commit-output-env.txt");
    const result = runMcpToolCli(
      [
        "--tool",
        "ctrlyoke_submit_commit_message",
        "--args",
        JSON.stringify({ message: "fix: capture via env" }),
        "--workspace",
        workspaceRoot,
      ],
      { ...process.env, CTRLYOKE_COMMIT_OUTPUT: outputPath }
    );

    assert.strictEqual(
      result.status,
      0,
      `CLI failed: stdout=${result.stdout} stderr=${result.stderr}`
    );
    assert.strictEqual(
      await fs.readFile(outputPath, "utf8"),
      "fix: capture via env"
    );
  });

  test("publishes a run address on ctrlyoke_global_status and nowhere else", async () => {
    const server = await setup();
    const selectorKeys = () =>
      server.getToolDefinitions().map((tool) => ({
        name: tool.name,
        keys: ["workflowKey", "runRef"].filter(
          (key) => (tool.inputSchema as any).properties[key] !== undefined
        ),
      }));
    const addressable = () =>
      selectorKeys()
        .filter((tool) => tool.keys.length > 0)
        .map((tool) => tool.name);

    // Only the cross-workflow read tool is addressable, and the shape does not
    // change with the environment: there is one supported way to run this
    // server, so there is one tool surface.
    assert.deepStrictEqual(addressable(), ["ctrlyoke_global_status"]);
    process.env.CTRLYOKE_WORKING_FILE = (
      await createRun("schema", "2026-01-01T00-00-00-000Z")
    ).runFilePath;
    assert.deepStrictEqual(addressable(), ["ctrlyoke_global_status"]);

    const append: any = server
      .getToolDefinitions()
      .find((tool) => tool.name === "ctrlyoke_append_queue")!.inputSchema;
    assert.deepStrictEqual(Object.keys(append.properties).sort(), [
      "position",
      "source",
      "steps",
    ]);
    assert.deepStrictEqual(append.properties.position.enum, ["next", "end"]);
  });

  test("answers only for its own run, ignoring any address in the arguments", async () => {
    const server = await setup();
    const own = await createRun("own", "2026-01-01T00-00-00-000Z", {
      responseText: "own output",
    });
    const other = await createRun("other", "2026-01-02T00-00-00-000Z", {
      responseText: "other output",
    });
    process.env.CTRLYOKE_WORKING_FILE = own.runFilePath;

    const status = responseJson(
      await server.invokeTool("ctrlyoke_queue_status", other)
    );
    const output = responseJson(
      await server.invokeTool("ctrlyoke_read_output", other)
    );

    assert.strictEqual(status.metadata.workflowKey, own.workflowKey);
    assert.strictEqual(status.metadata.runRef, own.runRef);
    assert.strictEqual(output.workflowKey, own.workflowKey);
    assert.strictEqual(output.outputs[0].responseText, "own output");
  });

  test("global_status reports sibling workflows and narrows on request", async () => {
    const server = await setup();
    const own = await createRun("own", "2026-01-01T00-00-00-000Z");
    const other = await createRun("other", "2026-01-02T00-00-00-000Z", {
      worktree: {
        schemaVersion: 1,
        mode: "managed",
        origin: "created",
        branchName: "ctrlyoke/other/run-2",
        worktreePath: path.join(workspaceRoot, "worktrees", "other"),
        executionRoot: path.join(workspaceRoot, "worktrees", "other"),
        executionCheckoutRoot: path.join(workspaceRoot, "worktrees", "other"),
        sourceCheckoutRoot: workspaceRoot,
        namedWorkspaceRoots: [{ name: "workspace", fsPath: workspaceRoot }],
        baseCommit: "base",
        lifecycleOwner: "ctrlyoke",
        lifecycleState: "settled",
        directoryState: "removed",
        branchState: "present",
        landingOutcome: "landed",
        updatedAt: 2,
      },
    });
    process.env.CTRLYOKE_WORKING_FILE = own.runFilePath;

    const all = responseJson(
      await server.invokeTool("ctrlyoke_global_status", {})
    );
    assert.deepStrictEqual(
      all.workflows.map((workflow: any) => workflow.workflowKey).sort(),
      [other.workflowKey, own.workflowKey].sort()
    );

    const narrowed = responseJson(
      await server.invokeTool("ctrlyoke_global_status", {
        workflowKey: other.workflowKey,
      })
    );
    assert.deepStrictEqual(
      narrowed.workflows.map((workflow: any) => workflow.workflowKey),
      [other.workflowKey]
    );
    const otherStatus = narrowed.workflows[0];
    assert.deepStrictEqual(otherStatus.worktree, {
      mode: "managed",
      branchName: "ctrlyoke/other/run-2",
      worktreePath: path.join(workspaceRoot, "worktrees", "other"),
      lifecycleState: "settled",
      directoryState: "removed",
    });
  });

  test("refuses every workflow tool when no run is attached", async () => {
    const server = await setup();
    const run = await createRun("unattached", "2026-01-01T00-00-00-000Z");
    const notAttached = /no ctrlyoke workflow run is attached/i;

    await assert.rejects(
      () => server.invokeTool("ctrlyoke_queue_status", {}),
      notAttached
    );
    await assert.rejects(
      () => server.invokeTool("ctrlyoke_read_output", {}),
      notAttached
    );
    await assert.rejects(
      () => server.invokeTool("ctrlyoke_global_status", {}),
      notAttached
    );
    await assert.rejects(
      () =>
        server.invokeTool("ctrlyoke_append_queue", {
          position: "end",
          steps: [{ prompt: "no target" }],
        }),
      notAttached
    );

    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    assert.strictEqual(persisted.steps?.length, 1);
  });

  test("appends to its own run through the continuation transaction", async () => {
    const server = await setup();
    const run = await createRun("append", "2026-01-01T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool("ctrlyoke_append_queue", {
        position: "end",
        steps: [{ prompt: "new tail", _runtime: { responseText: "omit" } }],
      })
    );
    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;

    assert.strictEqual(result.workflowKey, run.workflowKey);
    assert.strictEqual(result.runRef, run.runRef);
    assert.strictEqual(result.definitionRevision, 5);
    // The descriptor is untouched by an ordinary append: it stays at the
    // fixture's starting revision rather than bumping alongside content.
    assert.strictEqual(result.descriptorRevision, 3);
    assert.strictEqual(persisted.steps?.length, 2);
    assert.strictEqual(
      persisted.steps?.[0]._runtime?.sessionId,
      "session-append"
    );
    assert.strictEqual(persisted.steps?.[1]._runtime, undefined);
  });

  test("cannot append to any run but its own", async () => {
    const server = await setup();
    const own = await createRun("own", "2026-01-01T00-00-00-000Z");
    const other = await createRun("other-run", "2026-01-02T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = own.runFilePath;

    // A supplied address is not an alternate target — it is ignored outright,
    // so a workflow cannot queue work into a sibling run by guessing its ref.
    const result = responseJson(
      await server.invokeTool("ctrlyoke_append_queue", {
        workflowKey: other.workflowKey,
        runRef: other.runRef,
        position: "end",
        steps: [{ prompt: "cross-run attempt" }],
      })
    );
    assert.strictEqual(result.workflowKey, own.workflowKey);
    assert.strictEqual(result.runRef, own.runRef);

    const ownFile = JSON.parse(
      await fs.readFile(own.runFilePath, "utf8")
    ) as WorkingFile;
    const otherFile = JSON.parse(
      await fs.readFile(other.runFilePath, "utf8")
    ) as WorkingFile;
    assert.strictEqual(ownFile.steps?.length, 2);
    assert.strictEqual(otherFile.steps?.length, 1);
  });

  test("permits an MCP tail append only for its exact active execution target", async () => {
    const server = await setup();
    const run = await createRun("active-append", "2026-01-01T00-00-00-000Z");
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile._runtime = {
      ...workingFile._runtime,
      currentIndex: workingFile._runtime?.currentIndex ?? 0,
      executionState: EXECUTION_STATES.RUNNING,
    };
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    await WorkflowLockManager.acquireLock(workspaceRoot, run.workflowKey, {
      schemaVersion: 2,
      workflowKey: run.workflowKey,
      runRef: run.runRef,
      runner: RUNNER_IDS.CLI,
      pid: process.pid,
      ownerToken: "mcp-active-append-owner",
      hostInstanceId: "mcp-host",
      executionInstanceId: "mcp-execution",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    try {
      const result = responseJson(
        await server.invokeTool("ctrlyoke_append_queue", {
          position: "end",
          steps: [{ prompt: "active tail" }],
        })
      );
      assert.strictEqual(result.stepsAdded, 1);
      assert.strictEqual(result.definitionRevision, 5);
    } finally {
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        run.workflowKey,
        "mcp-active-append-owner"
      );
    }
  });

  test("inserts a 'next' step after the running step without displacing completed work", async () => {
    const server = await setup();
    const run = await createRun("next-append", "2026-01-01T00-00-00-000Z");
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    // step 0 completed, step 1 running, step 2 still pending
    workingFile.steps = [
      workingFile.steps![0],
      { prompt: "running", _runtime: { startedAt: 3 } },
      { prompt: "pending" },
    ];
    workingFile._runtime = {
      currentIndex: 1,
      executionState: EXECUTION_STATES.RUNNING,
    };
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    await WorkflowLockManager.acquireLock(workspaceRoot, run.workflowKey, {
      schemaVersion: 2,
      workflowKey: run.workflowKey,
      runRef: run.runRef,
      runner: RUNNER_IDS.CLI,
      pid: process.pid,
      ownerToken: "mcp-next-append-owner",
      hostInstanceId: "mcp-host",
      executionInstanceId: "mcp-execution",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    try {
      const result = responseJson(
        await server.invokeTool("ctrlyoke_append_queue", {
          position: "next",
          steps: [{ prompt: "steered" }],
        })
      );
      assert.strictEqual(result.insertIndex, 2);
      assert.strictEqual(result.newQueueSize, 4);

      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;
      assert.deepStrictEqual(
        persisted.steps?.map((step) => (step as { prompt: string }).prompt),
        ["prompt-next-append", "running", "steered", "pending"]
      );
      // The executed prefix keeps its index and its session/runtime metadata.
      assert.deepStrictEqual(persisted.steps?.[0], workingFile.steps![0]);
      assert.strictEqual(persisted.steps?.[2]._runtime, undefined);
    } finally {
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        run.workflowKey,
        "mcp-next-append-owner"
      );
    }
  });

  test("clamps a 'next' insert past every completed step when the head lags", async () => {
    const server = await setup();
    const run = await createRun("next-clamp", "2026-01-01T00-00-00-000Z");
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    // A stale/lagging currentIndex must never let an insert land inside the
    // completed prefix, where it would re-index recorded timeline attempts.
    workingFile.steps = [
      workingFile.steps![0],
      { prompt: "also completed", _runtime: { startedAt: 3, completedAt: 4 } },
      { prompt: "pending" },
    ];
    workingFile._runtime = {
      currentIndex: 0,
      executionState: EXECUTION_STATES.PAUSED,
    };
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool("ctrlyoke_append_queue", {
        position: "next",
        steps: [{ prompt: "steered" }],
      })
    );
    assert.strictEqual(result.insertIndex, 2);

    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    assert.deepStrictEqual(
      persisted.steps?.map((step) => (step as { prompt: string }).prompt),
      ["prompt-next-clamp", "also completed", "steered", "pending"]
    );
  });

  test("rejects an append while another run in the lineage holds the lock", async () => {
    const server = await setup();
    const run = await createRun("busy", "2026-01-01T00-00-00-000Z");
    const sibling = `run-2026-01-02T00-00-00-000Z` as RunRef;
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    await WorkflowLockManager.acquireLock(workspaceRoot, run.workflowKey, {
      schemaVersion: 2,
      workflowKey: run.workflowKey,
      runRef: sibling,
      runner: RUNNER_IDS.CLI,
      pid: process.pid,
      ownerToken: "mcp-test-owner",
      hostInstanceId: "mcp-host",
      executionInstanceId: "mcp-execution",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    await assert.rejects(
      () =>
        server.invokeTool("ctrlyoke_append_queue", {
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

    // Serialized through the server's operation queue, so an agent that adds
    // work twice gets both appends rather than a spurious revision conflict.
    const results = await Promise.all(
      ["first", "second"].map((prompt) =>
        server.invokeTool("ctrlyoke_append_queue", {
          position: "end",
          steps: [{ prompt }],
        })
      )
    );
    assert.deepStrictEqual(
      results.map((result) => responseJson(result).newQueueSize),
      [2, 3]
    );
  });
});
