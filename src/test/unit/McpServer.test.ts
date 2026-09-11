import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, suiteSetup, suiteTeardown, test } from "mocha";
import {
  CtrlYokeMCPServer,
  getMaxQueueSize,
  initializeMcpStorage,
} from "../../mcp-server";
import {
  MCP_APPEND_STEP_TOOL_NAME,
  MCP_EDIT_STEP_TOOL_NAME,
  MCP_TOOL_DEFINITIONS,
  MCP_REMOVE_STEP_TOOL_NAME,
  MCP_REORDER_STEPS_TOOL_NAME,
} from "../../utils/McpToolDefinitions";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
  WorkflowStep,
  WorkingFile,
  WorkingFileWorktreeRuntime,
} from "../../types/CtrlYokeTypes";
import {
  DEFAULT_MAX_QUEUE_SIZE,
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
      stepCount?: number;
      draftOnly?: boolean;
    } = {}
  ): Promise<RunFixture> {
    const workflowKey = `mcp-${suffix}-2026-01-01T00-00-00` as WorkflowKey;
    const runRef = `run-${runTime}` as RunRef;
    const runFilePath = options.draftOnly
      ? WorkflowPaths.draftFilePath(workspaceRoot, workflowKey)
      : WorkflowPaths.runFilePath(workspaceRoot, workflowKey, runRef);
    const descriptor: WorkflowLineageDescriptor = {
      schemaVersion: 1,
      workflowKey,
      workflowName: `MCP ${suffix}`,
      isFavorite: false,
      createdAt: 1,
      lastModifiedAt: 1,
      ...(options.draftOnly ? {} : { latestRunRef: runRef }),
      nextRunId: options.draftOnly ? 1 : 2,
      revision: 3,
    };
    const stepCount = options.stepCount ?? 1;
    const steps = Array.from({ length: stepCount }, (_, index) => ({
      prompt:
        index === 0
          ? (options.prompt ?? `prompt-${suffix}`)
          : `prompt-${suffix}-${index}`,
      _runtime: {
        startedAt: 1,
        completedAt: 2,
        sessionId:
          index === 0 ? `session-${suffix}` : `session-${suffix}-${index}`,
      },
    }));
    const workingFile: WorkingFile = {
      workflowName: descriptor.workflowName,
      startedAt: 1,
      lastModifiedAt: 1,
      definitionRevision: 4,
      steps,
      _runtime: {
        currentIndex: stepCount,
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
    if (!options.draftOnly) {
      const recorder = new TimelineRecorder();
      const manifestPath = await recorder.initializeRunAt(
        path.dirname(runFilePath),
        workflowKey,
        1,
        1,
        EXECUTION_STATES.COMPLETED,
        1,
        {
          workflowName: descriptor.workflowName,
          steps: workingFile.steps ?? [],
        }
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
    }
    return { workflowKey, runRef, runFilePath };
  }

  async function prepareActiveRun(suffix: string): Promise<{
    run: RunFixture;
    ownerToken: string;
  }> {
    const run = await createRun(suffix, "2026-01-01T00-00-00-000Z", {
      stepCount: 4,
    });
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.steps = [
      { prompt: "completed", _runtime: { completedAt: 2 } },
      { prompt: "in flight", _runtime: { startedAt: 3 } },
      { prompt: "pending-a" },
      { prompt: "pending-b" },
    ] as WorkflowStep[];
    workingFile._runtime = {
      ...workingFile._runtime,
      currentIndex: 1,
      executionState: EXECUTION_STATES.RUNNING,
    };
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    const ownerToken = `mcp-${suffix}-owner`;
    await WorkflowLockManager.acquireLock(workspaceRoot, run.workflowKey, {
      schemaVersion: 2,
      workflowKey: run.workflowKey,
      runRef: run.runRef,
      runner: RUNNER_IDS.CLI,
      pid: process.pid,
      ownerToken,
      hostInstanceId: "mcp-host",
      executionInstanceId: "mcp-execution",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    return { run, ownerToken };
  }

  async function releaseActiveRun(run: RunFixture, ownerToken: string) {
    await WorkflowLockManager.releaseLock(
      workspaceRoot,
      run.workflowKey,
      ownerToken
    );
  }

  async function setup(): Promise<CtrlYokeMCPServer> {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-mcp-"));
    priorPinnedFile = process.env.CTRLYOKE_WORKING_FILE;
    priorCommitOutput = process.env.CTRLYOKE_COMMIT_OUTPUT;
    delete process.env.CTRLYOKE_WORKING_FILE;
    delete process.env.CTRLYOKE_COMMIT_OUTPUT;
    return new CtrlYokeMCPServer({ workspaceRoot });
  }

  test("pins the complete built-in MCP tool-name set", () => {
    assert.deepStrictEqual(
      [...MCP_TOOL_DEFINITIONS.map((tool) => tool.name)].sort(),
      [
        "append_step",
        "edit_step",
        "global_status",
        "list_harnesses",
        "read_output",
        "remove_step",
        "reorder_steps",
        "submit_commit_message",
        "workflow_status",
      ]
    );
  });

  test("uses the shared queue default when no max-size environment value is set", () => {
    const priorMaxQueueSize = process.env.CTRLYOKE_MAX_QUEUE_SIZE;
    try {
      delete process.env.CTRLYOKE_MAX_QUEUE_SIZE;
      assert.strictEqual(getMaxQueueSize(), DEFAULT_MAX_QUEUE_SIZE);
    } finally {
      if (priorMaxQueueSize === undefined) {
        delete process.env.CTRLYOKE_MAX_QUEUE_SIZE;
      } else {
        process.env.CTRLYOKE_MAX_QUEUE_SIZE = priorMaxQueueSize;
      }
    }
  });

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
      "workflow_status",
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
      "submit_commit_message",
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
        "submit_commit_message",
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

  test("publishes a run address on global_status and nowhere else", async () => {
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
    assert.deepStrictEqual(addressable(), ["global_status"]);
    process.env.CTRLYOKE_WORKING_FILE = (
      await createRun("schema", "2026-01-01T00-00-00-000Z")
    ).runFilePath;
    assert.deepStrictEqual(addressable(), ["global_status"]);

    const append: any = server
      .getToolDefinitions()
      .find((tool) => tool.name === MCP_APPEND_STEP_TOOL_NAME)!.inputSchema;
    assert.deepStrictEqual(Object.keys(append.properties).sort(), [
      "position",
      "source",
      "steps",
    ]);
    assert.deepStrictEqual(append.properties.position.oneOf[0].enum, [
      "next",
      "end",
    ]);
    assert.strictEqual(append.properties.position.oneOf[1].type, "number");

    const readOutput: any = server
      .getToolDefinitions()
      .find((tool) => tool.name === "read_output")!.inputSchema;
    assert.deepStrictEqual(Object.keys(readOutput.properties).sort(), [
      "cursor",
      "indices",
      "limit",
      "tail",
    ]);
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
      await server.invokeTool("workflow_status", other)
    );
    const output = responseJson(await server.invokeTool("read_output", other));

    assert.strictEqual(status.metadata.workflowKey, own.workflowKey);
    assert.strictEqual(status.metadata.runRef, own.runRef);
    assert.strictEqual(status.metadata.workingFile, own.runFilePath);
    assert.strictEqual(
      status.metadata.runDirectory,
      path.dirname(own.runFilePath)
    );
    assert.strictEqual(path.isAbsolute(status.metadata.workingFile), true);
    assert.strictEqual(path.isAbsolute(status.metadata.runDirectory), true);
    assert.strictEqual(status.metadata.workingFile.startsWith(".."), false);
    assert.strictEqual(status.metadata.runDirectory.startsWith(".."), false);
    assert.strictEqual(output.workflowKey, own.workflowKey);
    assert.strictEqual(output.outputs[0].responseText, "own output");
  });

  test("preserves the read_output response when paging is omitted", async () => {
    const server = await setup();
    const run = await createRun("no-paging", "2026-01-01T00-00-00-000Z", {
      responseText: "plain output",
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = await server.invokeTool("read_output", {});
    const text = (result as { content: Array<{ text: string }> }).content[0]
      .text;

    assert.strictEqual(
      text,
      JSON.stringify(
        {
          workflowKey: run.workflowKey,
          runRef: run.runRef,
          outputs: [
            {
              index: 0,
              prompt: "prompt-no-paging",
              status: "completed",
              responseText: "plain output",
            },
          ],
        },
        null,
        2
      )
    );
  });

  test("returns a next cursor for a forward page", async () => {
    const server = await setup();
    const run = await createRun("forward-page", "2026-01-01T00-00-00-000Z", {
      responseText: "abcdef",
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const output = responseJson(
      await server.invokeTool("read_output", { indices: [0], limit: 3 })
    );

    assert.strictEqual(output.outputs[0].responseText, "abc");
    assert.strictEqual(output.outputs[0].nextCursor, "3");
  });

  test("resumes from a cursor through the end without another cursor", async () => {
    const server = await setup();
    const run = await createRun("resume-page", "2026-01-01T00-00-00-000Z", {
      responseText: "abcdef",
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const output = responseJson(
      await server.invokeTool("read_output", {
        indices: [0],
        cursor: "3",
      })
    );

    assert.strictEqual(output.outputs[0].responseText, "def");
    assert.strictEqual("nextCursor" in output.outputs[0], false);
  });

  test("returns a bounded tail without a next cursor", async () => {
    const server = await setup();
    const run = await createRun("tail-page", "2026-01-01T00-00-00-000Z", {
      responseText: "abcdef",
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const output = responseJson(
      await server.invokeTool("read_output", { indices: [0], tail: 3 })
    );

    assert.strictEqual(output.outputs[0].responseText, "def");
    assert.strictEqual("nextCursor" in output.outputs[0], false);
  });

  test("reads the first page when limit is supplied without a cursor", async () => {
    const server = await setup();
    const run = await createRun("limit-page", "2026-01-01T00-00-00-000Z", {
      responseText: "abcdef",
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const output = responseJson(
      await server.invokeTool("read_output", { indices: [0], limit: 2 })
    );

    assert.strictEqual(output.outputs[0].responseText, "ab");
    assert.strictEqual(output.outputs[0].nextCursor, "2");
  });

  test("rejects paging for multiple selected steps", async () => {
    const server = await setup();
    const run = await createRun("multi-page", "2026-01-01T00-00-00-000Z", {
      stepCount: 2,
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await assert.rejects(
      () => server.invokeTool("read_output", { indices: [0, 1], limit: 1 }),
      /require indices to name exactly one step/
    );
  });

  test("rejects paging when no step is selected", async () => {
    const server = await setup();
    const run = await createRun("zero-page", "2026-01-01T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await assert.rejects(
      () => server.invokeTool("read_output", { indices: [], limit: 1 }),
      /require indices to name exactly one step/
    );
  });

  test("rejects tail combined with cursor", async () => {
    const server = await setup();
    const run = await createRun("tail-cursor", "2026-01-01T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await assert.rejects(
      () =>
        server.invokeTool("read_output", {
          indices: [0],
          tail: 1,
          cursor: "0",
        }),
      /tail is mutually exclusive/
    );
  });

  test("rejects tail combined with limit", async () => {
    const server = await setup();
    const run = await createRun("tail-limit", "2026-01-01T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await assert.rejects(
      () =>
        server.invokeTool("read_output", {
          indices: [0],
          tail: 1,
          limit: 1,
        }),
      /tail is mutually exclusive/
    );
  });

  test("rejects malformed paging values and returns an empty past-end page", async () => {
    const server = await setup();
    const run = await createRun("invalid-page", "2026-01-01T00-00-00-000Z", {
      responseText: "abcdef",
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await assert.rejects(
      () => server.invokeTool("read_output", { indices: [0], limit: -1 }),
      /limit must be a non-negative integer/
    );
    await assert.rejects(
      () => server.invokeTool("read_output", { indices: [0], tail: "2" }),
      /read_output\.tail must be a number/
    );

    const output = responseJson(
      await server.invokeTool("read_output", {
        indices: [0],
        cursor: "999",
      })
    );
    assert.strictEqual(output.outputs[0].responseText, "");
    assert.strictEqual("nextCursor" in output.outputs[0], false);
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
    const draft = await createRun("draft", "2026-01-03T00-00-00-000Z", {
      draftOnly: true,
    });
    process.env.CTRLYOKE_WORKING_FILE = own.runFilePath;

    const all = responseJson(await server.invokeTool("global_status", {}));
    assert.deepStrictEqual(
      all.workflows.map((workflow: any) => workflow.workflowKey).sort(),
      [draft.workflowKey, other.workflowKey, own.workflowKey].sort()
    );
    const expectedWorkingFiles = new Map([
      [own.workflowKey, own.runFilePath],
      [other.workflowKey, other.runFilePath],
      [draft.workflowKey, draft.runFilePath],
    ]);
    for (const workflow of all.workflows) {
      const expectedWorkingFile = expectedWorkingFiles.get(
        workflow.workflowKey
      );
      assert.ok(expectedWorkingFile);
      assert.strictEqual(workflow.workingFile, expectedWorkingFile);
      assert.strictEqual(
        workflow.runDirectory,
        path.dirname(expectedWorkingFile)
      );
      assert.strictEqual(path.isAbsolute(workflow.workingFile), true);
      assert.strictEqual(path.isAbsolute(workflow.runDirectory), true);
      assert.strictEqual(workflow.workingFile.startsWith(".."), false);
      assert.strictEqual(workflow.runDirectory.startsWith(".."), false);
    }

    const narrowed = responseJson(
      await server.invokeTool("global_status", {
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
      () => server.invokeTool("workflow_status", {}),
      notAttached
    );
    await assert.rejects(
      () => server.invokeTool("read_output", {}),
      notAttached
    );
    await assert.rejects(
      () => server.invokeTool("global_status", {}),
      notAttached
    );
    await assert.rejects(
      () =>
        server.invokeTool("append_step", {
          position: "end",
          steps: [{ prompt: "no target" }],
        }),
      notAttached
    );
    await assert.rejects(
      () =>
        server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
          index: 0,
          updates: { prompt: "no target" },
        }),
      notAttached
    );
    await assert.rejects(
      () => server.invokeTool(MCP_REMOVE_STEP_TOOL_NAME, { index: 0 }),
      notAttached
    );
    await assert.rejects(
      () => server.invokeTool(MCP_REORDER_STEPS_TOOL_NAME, { indices: [0] }),
      notAttached
    );

    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    assert.strictEqual(persisted.steps?.length, 1);
  });

  test("edits a pending step's prompt and configuration", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("edit-step");
    try {
      const result = responseJson(
        await server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
          index: 2,
          updates: { prompt: "pending-a (corrected)", model: "model-x" },
        })
      );
      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.index, 2);
      assert.strictEqual(result.definitionRevision, 5);
      assert.strictEqual(result.workingFile, run.runFilePath);
      assert.strictEqual(result.runDirectory, path.dirname(run.runFilePath));
      assert.strictEqual(path.isAbsolute(result.workingFile), true);
      assert.strictEqual(path.isAbsolute(result.runDirectory), true);
      assert.strictEqual(result.workingFile.startsWith(".."), false);
      assert.strictEqual(result.runDirectory.startsWith(".."), false);
      assert.deepStrictEqual(persisted.steps?.[2], {
        prompt: "pending-a (corrected)",
        model: "model-x",
      });
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("removes a pending step", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("remove-step");
    try {
      const result = responseJson(
        await server.invokeTool(MCP_REMOVE_STEP_TOOL_NAME, { index: 3 })
      );
      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.index, 3);
      assert.deepStrictEqual(
        persisted.steps?.map((step) => (step as { prompt: string }).prompt),
        ["completed", "in flight", "pending-a"]
      );
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("reorders pending steps using absolute indices", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("reorder-steps");
    try {
      const result = responseJson(
        await server.invokeTool(MCP_REORDER_STEPS_TOOL_NAME, {
          indices: [1, 3, 2],
        })
      );
      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(
        persisted.steps?.map((step) => (step as { prompt: string }).prompt),
        ["completed", "in flight", "pending-b", "pending-a"]
      );
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  for (const [tool, args] of [
    [MCP_EDIT_STEP_TOOL_NAME, { index: 0, updates: { prompt: "blocked" } }],
    [MCP_REMOVE_STEP_TOOL_NAME, { index: 0 }],
  ] as const) {
    test(`${tool} rejects a completed step`, async () => {
      const server = await setup();
      const { run, ownerToken } = await prepareActiveRun(`completed-${tool}`);
      try {
        await assert.rejects(
          () => server.invokeTool(tool, args),
          /completed step/i
        );
      } finally {
        await releaseActiveRun(run, ownerToken);
      }
    });
  }

  test("reorder_steps rejects an order that moves the completed prefix", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("completed-reorder");
    try {
      await assert.rejects(
        () =>
          server.invokeTool(MCP_REORDER_STEPS_TOOL_NAME, {
            indices: [0, 2, 1],
          }),
        /completed step/i
      );
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  for (const [tool, args] of [
    [MCP_EDIT_STEP_TOOL_NAME, { index: 1, updates: { prompt: "blocked" } }],
    [MCP_REMOVE_STEP_TOOL_NAME, { index: 1 }],
  ] as const) {
    test(`${tool} rejects the in-flight step`, async () => {
      const server = await setup();
      const { run, ownerToken } = await prepareActiveRun(`in-flight-${tool}`);
      try {
        await assert.rejects(
          () => server.invokeTool(tool, args),
          /currently executing/i
        );
      } finally {
        await releaseActiveRun(run, ownerToken);
      }
    });
  }

  test("reorder_steps rejects moving the in-flight step", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("in-flight-reorder");
    try {
      await assert.rejects(
        () =>
          server.invokeTool(MCP_REORDER_STEPS_TOOL_NAME, {
            indices: [2, 1, 3],
          }),
        /currently executing/i
      );
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("supports a numeric append position and rejects one before the execution head", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("numeric-append");
    try {
      const inserted = responseJson(
        await server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
          position: 2,
          steps: [{ prompt: "inserted before pending-a" }],
        })
      );
      assert.strictEqual(inserted.insertIndex, 2);

      await assert.rejects(
        () =>
          server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
            position: 0,
            steps: [{ prompt: "must not move execution head" }],
          }),
        /completed step/i
      );
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("appends to its own run through the continuation transaction", async () => {
    const server = await setup();
    const run = await createRun("append", "2026-01-01T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool("append_step", {
        position: "end",
        steps: [{ prompt: "new tail", _runtime: { responseText: "omit" } }],
      })
    );
    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;

    assert.strictEqual(result.workflowKey, run.workflowKey);
    assert.strictEqual(result.runRef, run.runRef);
    assert.strictEqual(result.workingFile, run.runFilePath);
    assert.strictEqual(result.runDirectory, path.dirname(run.runFilePath));
    assert.strictEqual(path.isAbsolute(result.workingFile), true);
    assert.strictEqual(path.isAbsolute(result.runDirectory), true);
    assert.strictEqual(result.workingFile.startsWith(".."), false);
    assert.strictEqual(result.runDirectory.startsWith(".."), false);
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

  test("accepts an append whose prompt matches a completed step", async () => {
    const server = await setup();
    const run = await createRun(
      "repeat-completed",
      "2026-01-01T00-00-00-000Z",
      {
        prompt: "repeat this gate",
      }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool("append_step", {
        position: "end",
        steps: [{ prompt: "repeat this gate" }],
      })
    );
    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;

    assert.strictEqual(result.stepsAdded, 1);
    assert.strictEqual(result.stepsRejected, 0);
    assert.strictEqual(persisted.steps?.length, 2);
    assert.strictEqual(
      (persisted.steps?.[1] as { prompt: string }).prompt,
      "repeat this gate"
    );
  });

  test("cannot append to any run but its own", async () => {
    const server = await setup();
    const own = await createRun("own", "2026-01-01T00-00-00-000Z");
    const other = await createRun("other-run", "2026-01-02T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = own.runFilePath;

    // A supplied address is not an alternate target — it is ignored outright,
    // so a workflow cannot queue work into a sibling run by guessing its ref.
    const result = responseJson(
      await server.invokeTool("append_step", {
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
        await server.invokeTool("append_step", {
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
        await server.invokeTool("append_step", {
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
      await server.invokeTool("append_step", {
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
        server.invokeTool("append_step", {
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
        server.invokeTool("append_step", {
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
