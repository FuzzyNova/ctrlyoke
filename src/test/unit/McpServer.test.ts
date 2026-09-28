import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, suiteSetup, suiteTeardown, test } from "mocha";
import {
  CtrlYokeMCPServer,
  MAX_GLOBAL_STATUS_RESULTS,
  parseMcpToolCliArgs,
  type McpToolCallingContext,
} from "../../mcp-server";
import { getGlobalMaxSteps } from "../../utils/QueueLimitUtils";
import { ensureMcpStorageInitialized } from "../helpers/mcpStorage";
import { removeTempDir } from "../helpers/tempWorkspace";
import {
  MCP_APPEND_STEP_TOOL_NAME,
  type McpAppendStepArguments,
  MCP_CLAIM_PATHS_TOOL_NAME,
  MCP_COORDINATION_TOOL_NAMES,
  MCP_EDIT_STEP_TOOL_NAME,
  MCP_TOOL_DEFINITIONS,
  MCP_POST_NOTE_TOOL_NAME,
  MCP_READ_NOTES_TOOL_NAME,
  MCP_RELEASE_PATHS_TOOL_NAME,
  MCP_REMOVE_STEP_TOOL_NAME,
  MCP_REORDER_STEPS_TOOL_NAME,
  MCP_GLOBAL_STATUS_TOOL_NAME,
  MCP_READ_OUTPUT_TOOL_NAME,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
  MCP_WORKFLOW_MUTATION_TOOL_NAMES,
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
  DEFAULT_MAX_STEPS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PARALLEL_GROUP_ADMISSION,
  PROMPT_TERMINAL_STATUS,
  RUNNER_IDS,
  RUN_HISTORY_LOCATIONS,
  STEP_STATUS,
  type ExecutionState,
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
import { resolveCoordinationBoardScope } from "../../core/orchestration/ExecutionRootCoordinationStore";

interface RunFixture {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runFilePath: string;
}

function responseJson(result: unknown): any {
  const typed = result as { content: Array<{ text: string }> };
  return JSON.parse(typed.content[0].text);
}

async function invokeAppendHandler(
  server: CtrlYokeMCPServer,
  args: McpAppendStepArguments
): Promise<unknown> {
  return server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, args);
}

suite("CtrlYokeMCPServer run-addressed contracts", () => {
  let mcpStateRoot: string;

  suiteSetup(async () => {
    mcpStateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-mcp-test-state-")
    );
    await ensureMcpStorageInitialized(mcpStateRoot);
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
  let priorExecutionRoot: string | undefined;
  let priorParticipantLabel: string | undefined;
  let priorMcpCliMode: string | undefined;
  let priorPromptIndex: string | undefined;
  let priorParallelGroupId: string | undefined;
  let priorMaxParallelSteps: string | undefined;
  let priorMaxSteps: string | undefined;

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
    if (priorExecutionRoot === undefined) {
      delete process.env.CTRLYOKE_EXECUTION_ROOT;
    } else {
      process.env.CTRLYOKE_EXECUTION_ROOT = priorExecutionRoot;
    }
    if (priorParticipantLabel === undefined) {
      delete process.env.CTRLYOKE_PARTICIPANT_LABEL;
    } else {
      process.env.CTRLYOKE_PARTICIPANT_LABEL = priorParticipantLabel;
    }
    if (priorMcpCliMode === undefined) {
      delete process.env.CTRLYOKE_MCP_CLI_MODE;
    } else {
      process.env.CTRLYOKE_MCP_CLI_MODE = priorMcpCliMode;
    }
    if (priorPromptIndex === undefined) {
      delete process.env.CTRLYOKE_PROMPT_INDEX;
    } else {
      process.env.CTRLYOKE_PROMPT_INDEX = priorPromptIndex;
    }
    if (priorParallelGroupId === undefined) {
      delete process.env.CTRLYOKE_PARALLEL_GROUP_ID;
    } else {
      process.env.CTRLYOKE_PARALLEL_GROUP_ID = priorParallelGroupId;
    }
    if (priorMaxParallelSteps === undefined) {
      delete process.env.CTRLYOKE_MAX_PARALLEL_STEPS;
    } else {
      process.env.CTRLYOKE_MAX_PARALLEL_STEPS = priorMaxParallelSteps;
    }
    if (priorMaxSteps === undefined) {
      delete process.env.CTRLYOKE_MAX_STEPS;
    } else {
      process.env.CTRLYOKE_MAX_STEPS = priorMaxSteps;
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
      currentIndex?: number;
      parallelGroups?: WorkingFile["parallelGroups"];
      draftOnly?: boolean;
      executionState?: ExecutionState;
      maxSteps?: number;
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
    const executionState = options.executionState ?? EXECUTION_STATES.COMPLETED;
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
      startedAt: 1,
      definitionRevision: 4,
      steps,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.parallelGroups
        ? { parallelGroups: options.parallelGroups }
        : {}),
      _runtime: {
        currentIndex: stepCount,
        ...(options.currentIndex !== undefined
          ? { currentIndex: options.currentIndex }
          : {}),
        executionState,
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
        executionState,
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

  async function prepareAttachedGroupRun(suffix: string): Promise<{
    run: RunFixture;
    ownerToken: string;
  }> {
    const active = await prepareActiveRun(suffix);
    const workingFile = JSON.parse(
      await fs.readFile(active.run.runFilePath, "utf8")
    ) as WorkingFile;
    const groupId = "group-" + suffix;
    workingFile.parallelGroups = [
      { id: groupId, startIndex: 1, endIndex: 3, failFast: true },
    ];
    await fs.writeFile(
      active.run.runFilePath,
      JSON.stringify(workingFile),
      "utf8"
    );
    process.env.CTRLYOKE_PROMPT_INDEX = "1";
    process.env.CTRLYOKE_PARALLEL_GROUP_ID = groupId;
    return active;
  }

  async function setup(): Promise<CtrlYokeMCPServer> {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-mcp-"));
    priorPinnedFile = process.env.CTRLYOKE_WORKING_FILE;
    priorCommitOutput = process.env.CTRLYOKE_COMMIT_OUTPUT;
    priorExecutionRoot = process.env.CTRLYOKE_EXECUTION_ROOT;
    priorParticipantLabel = process.env.CTRLYOKE_PARTICIPANT_LABEL;
    priorMcpCliMode = process.env.CTRLYOKE_MCP_CLI_MODE;
    priorPromptIndex = process.env.CTRLYOKE_PROMPT_INDEX;
    priorParallelGroupId = process.env.CTRLYOKE_PARALLEL_GROUP_ID;
    priorMaxParallelSteps = process.env.CTRLYOKE_MAX_PARALLEL_STEPS;
    priorMaxSteps = process.env.CTRLYOKE_MAX_STEPS;
    delete process.env.CTRLYOKE_WORKING_FILE;
    delete process.env.CTRLYOKE_COMMIT_OUTPUT;
    delete process.env.CTRLYOKE_EXECUTION_ROOT;
    delete process.env.CTRLYOKE_PARTICIPANT_LABEL;
    delete process.env.CTRLYOKE_MCP_CLI_MODE;
    delete process.env.CTRLYOKE_PROMPT_INDEX;
    delete process.env.CTRLYOKE_PARALLEL_GROUP_ID;
    delete process.env.CTRLYOKE_MAX_PARALLEL_STEPS;
    delete process.env.CTRLYOKE_MAX_STEPS;
    process.env.CTRLYOKE_EXECUTION_ROOT = workspaceRoot;
    return new CtrlYokeMCPServer({ workspaceRoot });
  }

  test("pins the complete built-in MCP tool-name set", () => {
    assert.deepStrictEqual(
      [...MCP_TOOL_DEFINITIONS.map((tool) => tool.name)].sort(),
      [
        "append_step",
        "claim_paths",
        "edit_step",
        "global_status",
        "list_harnesses",
        "post_note",
        "read_notes",
        "read_output",
        "release_paths",
        "remove_step",
        "reorder_steps",
        "submit_commit_message",
        "workflow_status",
      ]
    );
  });

  test("keeps coordination names separate from the queue skill names", () => {
    assert.deepStrictEqual([...MCP_COORDINATION_TOOL_NAMES].sort(), [
      "claim_paths",
      "post_note",
      "read_notes",
      "release_paths",
    ]);
  });

  test("filters tools for attested, grouped, and external callers", () => {
    const names = (context: McpToolCallingContext) =>
      new CtrlYokeMCPServer()
        .getToolDefinitions(context)
        .map((tool) => tool.name);
    const ordinary = names({ attested: true, groupMember: false });
    const grouped = names({
      attested: true,
      groupMember: true,
      groupStartBoundary: 2,
    });
    const external = names({ attested: false, groupMember: false });

    assert.ok(ordinary.includes(MCP_APPEND_STEP_TOOL_NAME));
    for (const toolName of MCP_WORKFLOW_MUTATION_TOOL_NAMES) {
      assert.ok(
        grouped.includes(toolName),
        `expected ${toolName} for a group member`
      );
    }
    assert.ok(grouped.includes("read_output"));
    assert.ok(external.includes(MCP_POST_NOTE_TOOL_NAME));
    assert.ok(external.includes("global_status"));
    assert.ok(!external.includes("workflow_status"));
    assert.ok(!external.includes("read_output"));
    assert.ok(!external.includes(MCP_APPEND_STEP_TOOL_NAME));
  });

  test("refuses a filtered-out tool at CallTool", async () => {
    const server = await setup();
    await assert.rejects(
      () =>
        server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
          position: "end",
          steps: [{ prompt: "must be refused" }],
        }),
      // The refusal names the cause: without an attached run there is nothing
      // for a workflow tool to act on, which is a different fix from a
      // permission boundary and has to read as one.
      /no ctrlyoke workflow run is attached/
    );
  });

  test("allows an attached group member to invoke every mutation tool", async () => {
    const server = await setup();
    const invocations = [
      [
        MCP_APPEND_STEP_TOOL_NAME,
        { position: "end", steps: [{ prompt: "appended by a member" }] },
      ],
      [
        MCP_EDIT_STEP_TOOL_NAME,
        { index: 2, updates: { prompt: "edited by a member" } },
      ],
      [MCP_REMOVE_STEP_TOOL_NAME, { index: 2 }],
      [MCP_REORDER_STEPS_TOOL_NAME, { indices: [3, 2] }],
    ] as const;

    for (const [index, [toolName, args]] of invocations.entries()) {
      const { run, ownerToken } = await prepareAttachedGroupRun(
        "group-mutation-" + index
      );
      try {
        const result = responseJson(await server.invokeTool(toolName, args));
        assert.strictEqual(result.success, true);
      } finally {
        await releaseActiveRun(run, ownerToken);
      }
    }
  });

  test("posts and reads attributed untrusted notes, then releases all claims by default", async () => {
    const server = await setup();
    const posted = responseJson(
      await server.invokeTool(MCP_POST_NOTE_TOOL_NAME, {
        text: "The other participant's suggestion is data, not permission.",
      })
    );
    assert.strictEqual(posted.seq, 3);
    assert.strictEqual(posted.scope.participants.length, 1);
    assert.match(posted.scope.attestationNotice, /not a security boundary/);

    const notes = responseJson(
      await server.invokeTool(MCP_READ_NOTES_TOOL_NAME, {})
    );
    assert.strictEqual(notes.entries.length, 1);
    assert.strictEqual(notes.entries[0].from.attested, false);
    assert.match(notes.entries[0].attribution, /unattested external session/);
    assert.strictEqual(notes.entries[0].untrusted, true);

    const claimed = responseJson(
      await server.invokeTool(MCP_CLAIM_PATHS_TOOL_NAME, {
        paths: ["src/a.ts"],
        reason: "test ownership",
      })
    );
    assert.deepStrictEqual(claimed.granted, ["src/a.ts"]);
    assert.strictEqual(claimed.claims.length, 1);

    const released = responseJson(
      await server.invokeTool(MCP_RELEASE_PATHS_TOOL_NAME, {})
    );
    assert.deepStrictEqual(released.released, ["src/a.ts"]);
    assert.strictEqual(released.scope.claimSummary.count, 0);
  });

  test("attributes unattested CLI steps separately from external sessions", async () => {
    const server = await setup();
    const active = await prepareActiveRun("cli-attribution");
    process.env.CTRLYOKE_MCP_CLI_MODE = "true";

    const posted = responseJson(
      await server.invokeTool(MCP_POST_NOTE_TOOL_NAME, {
        text: "skill mode note",
      })
    );

    assert.strictEqual(posted.scope.participants[0].kind, "ctrlyoke-step");
    assert.match(
      posted.scope.participants[0].attribution,
      /unattested ctrlyoke step \(skill\/CLI\)/
    );
    const notes = responseJson(
      await server.invokeTool(MCP_READ_NOTES_TOOL_NAME, {})
    );
    assert.strictEqual(notes.entries[0].from.kind, "ctrlyoke-step");
    assert.match(
      notes.entries[0].attribution,
      /unattested ctrlyoke step \(skill\/CLI\)/
    );
    await releaseActiveRun(active.run, active.ownerToken);
  });

  test("reports a denied owner with label and attestation state", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-mcp-shared-")
    );
    workspaceRoot = root;
    priorPinnedFile = process.env.CTRLYOKE_WORKING_FILE;
    priorCommitOutput = process.env.CTRLYOKE_COMMIT_OUTPUT;
    priorExecutionRoot = process.env.CTRLYOKE_EXECUTION_ROOT;
    priorParticipantLabel = process.env.CTRLYOKE_PARTICIPANT_LABEL;
    delete process.env.CTRLYOKE_WORKING_FILE;
    delete process.env.CTRLYOKE_COMMIT_OUTPUT;
    delete process.env.CTRLYOKE_EXECUTION_ROOT;
    process.env.CTRLYOKE_EXECUTION_ROOT = root;
    process.env.CTRLYOKE_PARTICIPANT_LABEL = "Alice's session";
    const owner = new CtrlYokeMCPServer({ workspaceRoot: root });
    await owner.invokeTool(MCP_CLAIM_PATHS_TOOL_NAME, { paths: ["shared.ts"] });

    process.env.CTRLYOKE_PARTICIPANT_LABEL = "Bob's session";
    const contender = new CtrlYokeMCPServer({ workspaceRoot: root });
    const denied = responseJson(
      await contender.invokeTool(MCP_CLAIM_PATHS_TOOL_NAME, {
        paths: ["shared.ts"],
      })
    );
    assert.strictEqual(denied.denied[0].owner.label, "Alice's session");
    assert.strictEqual(denied.denied[0].owner.attested, false);
    assert.match(denied.denied[0].owner.attribution, /untrusted/);
  });

  test("resolves execution scope from env, run metadata, then cwd", async () => {
    const server = await setup();
    const configuredRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-mcp-execution-")
    );
    process.env.CTRLYOKE_EXECUTION_ROOT = configuredRoot;
    const envScope = responseJson(
      await server.invokeTool(MCP_POST_NOTE_TOOL_NAME, { text: "env" })
    );
    assert.strictEqual(
      envScope.scope.executionRoot,
      path.resolve(configuredRoot)
    );
    await fs.rm(configuredRoot, { recursive: true, force: true });

    const runRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-mcp-run-root-")
    );
    const run = await createRun("scope-run", "2026-01-01T00-00-00-000Z", {
      worktree: {
        schemaVersion: 1,
        mode: "managed",
        origin: "created",
        branchName: "scope",
        worktreePath: runRoot,
        executionRoot: runRoot,
        executionCheckoutRoot: runRoot,
        sourceCheckoutRoot: workspaceRoot,
        namedWorkspaceRoots: [],
        baseCommit: "base",
        lifecycleOwner: "ctrlyoke",
        lifecycleState: "ready",
        directoryState: "present",
        branchState: "present",
        updatedAt: 1,
      },
    });
    delete process.env.CTRLYOKE_EXECUTION_ROOT;
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    const runScope = responseJson(
      await new CtrlYokeMCPServer({ workspaceRoot }).invokeTool(
        MCP_POST_NOTE_TOOL_NAME,
        { text: "run" }
      )
    );
    assert.strictEqual(runScope.scope.executionRoot, path.resolve(runRoot));

    delete process.env.CTRLYOKE_WORKING_FILE;
    const cwdRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-mcp-cwd-root-")
    );
    const previousCwd = process.cwd();
    try {
      process.chdir(cwdRoot);
      const cwdScope = responseJson(
        await new CtrlYokeMCPServer({ workspaceRoot }).invokeTool(
          MCP_POST_NOTE_TOOL_NAME,
          { text: "cwd" }
        )
      );
      assert.strictEqual(cwdScope.scope.executionRoot, path.resolve(cwdRoot));
      assert.notStrictEqual(
        cwdScope.scope.executionRoot,
        path.resolve(workspaceRoot)
      );
    } finally {
      process.chdir(previousCwd);
      // The just-left cwd can stay briefly locked on Windows.
      removeTempDir(cwdRoot);
      removeTempDir(runRoot);
    }
  });

  test("discards a frozen prompt index that disagrees with the run runtime", async () => {
    const server = await setup();
    const run = await createRun("stale-index", "2026-01-01T00-00-00-000Z", {
      stepCount: 3,
      currentIndex: 1,
      executionState: EXECUTION_STATES.RUNNING,
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    process.env.CTRLYOKE_PROMPT_INDEX = "0";

    const posted = responseJson(
      await server.invokeTool(MCP_POST_NOTE_TOOL_NAME, { text: "stale" })
    );

    assert.strictEqual(
      posted.scope.participants[0].address.stepIndex,
      undefined
    );
    assert.strictEqual(
      posted.scope.participants[0].address.parallelGroupId,
      undefined
    );
  });

  test("attaches a group member's index and group id", async () => {
    const server = await setup();
    const run = await createRun("group-identity", "2026-01-01T00-00-00-000Z", {
      stepCount: 3,
      currentIndex: 1,
      parallelGroups: [
        { id: "group-1", startIndex: 1, endIndex: 2, failFast: true },
      ],
      executionState: EXECUTION_STATES.RUNNING,
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    process.env.CTRLYOKE_PROMPT_INDEX = "2";
    process.env.CTRLYOKE_PARALLEL_GROUP_ID = "group-1";

    const posted = responseJson(
      await server.invokeTool(MCP_POST_NOTE_TOOL_NAME, { text: "group" })
    );
    const address = posted.scope.participants[0].address;

    assert.strictEqual(address.stepIndex, 2);
    assert.strictEqual(address.parallelGroupId, "group-1");
  });

  test("rejects absolute and escaping coordination paths", async () => {
    const server = await setup();
    await assert.rejects(
      () =>
        server.invokeTool(MCP_CLAIM_PATHS_TOOL_NAME, { paths: ["../secret"] }),
      /escapes the execution root/
    );
    await assert.rejects(
      () =>
        server.invokeTool(MCP_CLAIM_PATHS_TOOL_NAME, {
          paths: [path.join(workspaceRoot, "secret")],
        }),
      /execution-root-relative/
    );
  });

  test("uses the shared steps default when no max-steps environment value is set", () => {
    const priorMaxSteps = process.env.CTRLYOKE_MAX_STEPS;
    try {
      delete process.env.CTRLYOKE_MAX_STEPS;
      assert.strictEqual(getGlobalMaxSteps(), DEFAULT_MAX_STEPS);
    } finally {
      if (priorMaxSteps === undefined) {
        delete process.env.CTRLYOKE_MAX_STEPS;
      } else {
        process.env.CTRLYOKE_MAX_STEPS = priorMaxSteps;
      }
    }
  });

  function runMcpToolCli(
    args: string[],
    env?: NodeJS.ProcessEnv,
    cwd?: string
  ) {
    return spawnSync(
      "node",
      [path.resolve(__dirname, "../../mcp-server.js"), ...args],
      { encoding: "utf8", ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }
    );
  }

  test("pins the CLI flag set and rejects unknown options", () => {
    assert.deepStrictEqual(
      parseMcpToolCliArgs([
        "--tool",
        "post_note",
        "--args",
        "{}",
        "--workspace",
        "workspace",
        "--working-file",
        "run.json",
        "--commit-output",
        "commit.txt",
        "--step-index",
        "2",
        "--parallel-group-id",
        "group-1",
        "--execution-root",
        "checkout",
      ]),
      {
        tool: "post_note",
        argsJson: "{}",
        workspace: "workspace",
        workingFile: "run.json",
        commitOutput: "commit.txt",
        stepIndex: 2,
        parallelGroupId: "group-1",
        executionRoot: "checkout",
      }
    );
    assert.throws(
      () => parseMcpToolCliArgs(["--tool", "post_note", "--unknown", "x"]),
      /Unknown option: --unknown/
    );
  });

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

  test("invokes coordination through the CLI with a cli lease", async () => {
    await setup();
    await new ProjectStateRegistry().initialize(workspaceRoot);
    const run = await createRun(
      "cli-coordination",
      "2026-01-01T00-00-00-000Z",
      {
        currentIndex: 0,
        executionState: EXECUTION_STATES.RUNNING,
      }
    );
    const result = runMcpToolCli(
      [
        "--tool",
        MCP_POST_NOTE_TOOL_NAME,
        "--args",
        JSON.stringify({ text: "cli note" }),
        "--workspace",
        workspaceRoot,
        "--working-file",
        run.runFilePath,
        "--execution-root",
        workspaceRoot,
      ],
      undefined,
      workspaceRoot
    );

    assert.strictEqual(
      result.status,
      0,
      `CLI failed: stdout=${result.stdout} stderr=${result.stderr}`
    );
    const board = await resolveCoordinationBoardScope(workspaceRoot);
    const entries = (await fs.readFile(board.boardPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const note = entries.find(
      (entry: { kind: string }) => entry.kind === "note"
    );
    assert.ok(note);
    assert.strictEqual(note.via, "cli");
    assert.strictEqual(note.from.attested, false);
  });

  test("releases a claim made by an earlier CLI coordination call", async () => {
    await setup();
    await new ProjectStateRegistry().initialize(workspaceRoot);
    const run = await createRun(
      "cli-coordination-release",
      "2026-01-01T00-00-00-000Z",
      {
        currentIndex: 0,
        executionState: EXECUTION_STATES.RUNNING,
      }
    );
    const callCli = (tool: string, args: object) => {
      const result = runMcpToolCli(
        [
          "--tool",
          tool,
          "--args",
          JSON.stringify(args),
          "--workspace",
          workspaceRoot,
          "--working-file",
          run.runFilePath,
          "--execution-root",
          workspaceRoot,
        ],
        undefined,
        workspaceRoot
      );
      assert.strictEqual(
        result.status,
        0,
        `CLI failed: stdout=${result.stdout} stderr=${result.stderr}`
      );
      return JSON.parse(result.stdout);
    };

    const claimed = callCli(MCP_CLAIM_PATHS_TOOL_NAME, { paths: ["src/a.ts"] });
    assert.deepStrictEqual(claimed.granted, ["src/a.ts"]);

    const released = callCli(MCP_RELEASE_PATHS_TOOL_NAME, {});
    assert.deepStrictEqual(released.released, ["src/a.ts"]);
    assert.strictEqual(released.scope.claimSummary.count, 0);
    assert.strictEqual(released.scope.participants.length, 1);
  });

  test("rejects a CLI coordination call for a bad working-file address", async () => {
    await setup();
    const result = runMcpToolCli(
      [
        "--tool",
        MCP_POST_NOTE_TOOL_NAME,
        "--args",
        JSON.stringify({ text: "should fail" }),
        "--workspace",
        workspaceRoot,
        "--working-file",
        path.join(workspaceRoot, "missing-run.ctrlyoke.json"),
        "--execution-root",
        workspaceRoot,
      ],
      undefined,
      workspaceRoot
    );

    assert.strictEqual(result.status, 1);
    assert.match(
      result.stderr,
      /CLI coordination address is not a valid live run/
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
      "parallelWithCurrent",
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

  test("ends a page before a surrogate pair", async () => {
    const server = await setup();
    const run = await createRun(
      "surrogate-page-end",
      "2026-01-01T00-00-00-000Z",
      {
        responseText: "AB😀CD",
      }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const output = responseJson(
      await server.invokeTool("read_output", { indices: [0], limit: 3 })
    );

    assert.strictEqual(output.outputs[0].responseText, "AB");
    assert.strictEqual(output.outputs[0].nextCursor, "2");
  });

  test("advances a cursor past a surrogate pair", async () => {
    const server = await setup();
    const run = await createRun(
      "surrogate-cursor-start",
      "2026-01-01T00-00-00-000Z",
      {
        responseText: "AB😀CD",
      }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const output = responseJson(
      await server.invokeTool("read_output", {
        indices: [0],
        cursor: "3",
      })
    );

    assert.strictEqual(output.outputs[0].responseText, "CD");
  });

  test("starts a tail after a surrogate pair", async () => {
    const server = await setup();
    const run = await createRun(
      "surrogate-tail-start",
      "2026-01-01T00-00-00-000Z",
      {
        responseText: "AB😀CD",
      }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const output = responseJson(
      await server.invokeTool("read_output", { indices: [0], tail: 3 })
    );

    assert.strictEqual(output.outputs[0].responseText, "CD");
  });

  test("rejects a zero read_output limit", async () => {
    const server = await setup();
    const run = await createRun("zero-limit", "2026-01-01T00-00-00-000Z");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await assert.rejects(
      () => server.invokeTool("read_output", { indices: [0], limit: 0 }),
      /limit.*(?:positive integer|greater than or equal to 1)/
    );
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
      /limit.*(?:positive integer|greater than or equal to 1)/
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
    const own = await createRun("own", "2026-01-01T00-00-00-000Z", {
      executionState: EXECUTION_STATES.RUNNING,
    });
    const other = await createRun("other", "2026-01-02T00-00-00-000Z", {
      executionState: EXECUTION_STATES.PAUSED,
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
    const completed = await createRun("completed", "2026-01-04T00-00-00-000Z");
    const stopped = await createRun("stopped", "2026-01-05T00-00-00-000Z", {
      executionState: EXECUTION_STATES.STOPPED,
    });
    const errored = await createRun("errored", "2026-01-06T00-00-00-000Z", {
      executionState: EXECUTION_STATES.ERROR,
    });
    process.env.CTRLYOKE_WORKING_FILE = own.runFilePath;

    const all = responseJson(await server.invokeTool("global_status", {}));
    assert.deepStrictEqual(
      all.workflows.map((workflow: any) => workflow.workflowKey).sort(),
      [other.workflowKey, own.workflowKey].sort()
    );
    assert.strictEqual(all.workflowCount, 2);
    assert.strictEqual(all.truncated, false);
    assert.strictEqual(all.omittedCount, 0);
    assert.ok(
      !all.workflows.some((workflow: any) =>
        [
          draft.workflowKey,
          completed.workflowKey,
          stopped.workflowKey,
          errored.workflowKey,
        ].includes(workflow.workflowKey)
      )
    );
    const expectedWorkingFiles = new Map([
      [own.workflowKey, own.runFilePath],
      [other.workflowKey, other.runFilePath],
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

  test("allows global_status without an attached run", async () => {
    const server = await setup();
    const run = await createRun("unattached", "2026-01-01T00-00-00-000Z");
    const notAttached =
      /(no ctrlyoke workflow run is attached|tool is not available)/i;

    const globalStatus = responseJson(
      await server.invokeTool("global_status", {})
    );
    assert.deepStrictEqual(globalStatus.workflows, []);
    assert.strictEqual(globalStatus.truncated, false);
    assert.strictEqual(globalStatus.omittedCount, 0);

    await assert.rejects(
      () => server.invokeTool("workflow_status", {}),
      notAttached
    );
    await assert.rejects(
      () => server.invokeTool("read_output", {}),
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

  test("caps global_status results and reports omitted active lineages", async () => {
    const server = await setup();
    for (let index = 0; index < MAX_GLOBAL_STATUS_RESULTS + 1; index++) {
      await createRun(
        `cap-${index}`,
        new Date(Date.UTC(2026, 1, 1, 0, 0, index))
          .toISOString()
          .replace(/[:.]/g, "-"),
        { executionState: EXECUTION_STATES.RUNNING }
      );
    }

    const result = responseJson(await server.invokeTool("global_status", {}));

    assert.strictEqual(result.workflowCount, MAX_GLOBAL_STATUS_RESULTS);
    assert.strictEqual(result.workflows.length, MAX_GLOBAL_STATUS_RESULTS);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.omittedCount, 1);
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

  test("merges a partial edit into a pending script step", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("edit-script-step");
    try {
      const file = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;
      file.steps![2] = {
        type: "script",
        script: "npm test",
        name: "tests",
        onFail: "stopWorkflow",
        _runtime: { stepId: "script-step-2" },
      };
      await fs.writeFile(run.runFilePath, JSON.stringify(file), "utf8");

      await server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
        index: 2,
        updates: { name: "renamed tests" },
      });

      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;
      assert.deepStrictEqual(persisted.steps?.[2], {
        type: "script",
        script: "npm test",
        name: "renamed tests",
        onFail: "stopWorkflow",
        _runtime: { stepId: "script-step-2" },
      });

      await server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
        index: 2,
        updates: { type: "prompt", prompt: "now a prompt" },
      });
      const replaced = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;
      assert.deepStrictEqual(replaced.steps?.[2], {
        type: "prompt",
        prompt: "now a prompt",
      });
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("validates the effective harness and model when editing a step", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun(
      "edit-invalid-capability"
    );
    try {
      await fs.mkdir(path.join(workspaceRoot, ".ctrlyoke"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(workspaceRoot, ".ctrlyoke", "capabilities.json"),
        JSON.stringify({
          harnesses: [
            {
              id: "claude-cli",
              available: true,
              models: [{ value: "valid-model" }],
            },
          ],
        }),
        "utf8"
      );
      const before = await fs.readFile(run.runFilePath, "utf8");

      await assert.rejects(
        server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
          index: 2,
          updates: { harness: "not-installed" },
        }),
        /Invalid harness 'not-installed'/
      );
      await assert.rejects(
        server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
          index: 2,
          updates: { harness: "claude-cli", model: "bad-model" },
        }),
        /Invalid model 'bad-model'/
      );
      assert.strictEqual(await fs.readFile(run.runFilePath, "utf8"), before);
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("refuses edits that clear required prompt or script content", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("edit-required-content");
    try {
      const file = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;
      file.steps![2] = {
        type: "script",
        script: "npm test",
        _runtime: { stepId: "script-step-2" },
      };
      await fs.writeFile(run.runFilePath, JSON.stringify(file), "utf8");
      const before = await fs.readFile(run.runFilePath, "utf8");

      await assert.rejects(
        server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
          index: 3,
          updates: {},
          clearProperties: ["prompt"],
        }),
        /non-empty prompt/
      );
      await assert.rejects(
        server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
          index: 2,
          updates: {},
          clearProperties: ["script"],
        }),
        /non-empty script/
      );
      assert.strictEqual(await fs.readFile(run.runFilePath, "utf8"), before);
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
          indices: [3, 2],
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

  test("reorders not-yet-started steps while keeping pending parallel groups intact", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun(
      "reorder-parallel-block"
    );
    try {
      const workingFile = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;
      workingFile.steps?.push({ prompt: "tail" });
      workingFile.parallelGroups = [
        { id: "group-reorder", startIndex: 2, endIndex: 3, failFast: true },
      ];
      await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");

      const result = responseJson(
        await server.invokeTool(MCP_REORDER_STEPS_TOOL_NAME, {
          indices: [4, 2, 3],
        })
      );
      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(
        persisted.steps?.map((step) => (step as { prompt: string }).prompt),
        ["completed", "in flight", "tail", "pending-a", "pending-b"]
      );
      assert.deepStrictEqual(persisted.parallelGroups, [
        { id: "group-reorder", startIndex: 3, endIndex: 4, failFast: true },
      ]);
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
        /not-yet-started step indices/i
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
        /not-yet-started step indices/i
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
      assert.deepStrictEqual(inserted.placement, {
        requestedIndex: 2,
        insertedIndex: 2,
      });

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

  test("validates capabilities for members inside a parallel container", async () => {
    const server = await setup();
    const run = await createRun(
      "nested-capability",
      "2026-01-01T00-00-00-000Z",
      { executionState: EXECUTION_STATES.RUNNING }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    const capabilitiesDirectory = path.join(workspaceRoot, ".ctrlyoke");
    await fs.mkdir(capabilitiesDirectory, { recursive: true });
    await fs.writeFile(
      path.join(capabilitiesDirectory, "capabilities.json"),
      JSON.stringify({
        generatedAt: 1,
        harnesses: [
          {
            id: "copilot-cli",
            displayName: "Copilot CLI",
            available: true,
            models: [],
          },
        ],
      }),
      "utf8"
    );
    const before = await fs.readFile(run.runFilePath, "utf8");

    await assert.rejects(
      () =>
        server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
          position: "end",
          steps: [
            {
              parallel: [
                { prompt: "valid member", harness: "copilot-cli" },
                { prompt: "invalid member", harness: "not-installed" },
              ],
            },
          ],
        }),
      /Invalid harness 'not-installed'/
    );
    assert.strictEqual(await fs.readFile(run.runFilePath, "utf8"), before);
  });

  test("reports flattened mixed topology and relocation in the append response", async () => {
    const server = await setup();
    const run = await createRun("mixed-append", "2026-01-01T00-00-00-000Z", {
      stepCount: 4,
      currentIndex: -1,
      executionState: EXECUTION_STATES.RUNNING,
    });
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.parallelGroups = [
      { id: "existing-a", startIndex: 0, endIndex: 1, failFast: true },
      { id: "existing-b", startIndex: 2, endIndex: 3, failFast: true },
    ];
    // Pending steps: the run is live and its head has not reached them, so the
    // numeric insert is relocated past the group rather than refused as a
    // splice into the completed prefix.
    workingFile.steps = workingFile.steps?.map((step) => ({
      prompt: (step as { prompt: string }).prompt,
    })) as WorkflowStep[];
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
        position: 1,
        steps: [
          { prompt: "flat-before" },
          {
            parallel: [{ prompt: "group-first" }, { prompt: "group-second" }],
            failFast: false,
          },
          { prompt: "flat-after" },
        ],
      })
    );
    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.destination, "queue");
    assert.strictEqual(result.queueItemsAdded, 3);
    assert.strictEqual(result.stepsAdded, 4);
    assert.strictEqual(result.newQueueSize, 8);
    assert.strictEqual(result.insertIndex, 2);
    assert.strictEqual(result.insertedEndIndex, 5);
    assert.deepStrictEqual(result.placement, {
      requestedIndex: 1,
      insertedIndex: 2,
      relocation: {
        kind: "afterParallelGroup",
        groupId: "existing-a",
      },
    });
    assert.deepStrictEqual(
      result.parallelGroupsAdded.map(
        (group: {
          startIndex: number;
          endIndex: number;
          failFast: boolean;
        }) => ({
          startIndex: group.startIndex,
          endIndex: group.endIndex,
          failFast: group.failFast,
        })
      ),
      [{ startIndex: 3, endIndex: 4, failFast: false }]
    );
    assert.deepStrictEqual(
      persisted.steps?.map((step) => (step as { prompt: string }).prompt),
      [
        "prompt-mixed-append",
        "prompt-mixed-append-1",
        "flat-before",
        "group-first",
        "group-second",
        "flat-after",
        "prompt-mixed-append-2",
        "prompt-mixed-append-3",
      ]
    );
    assert.deepStrictEqual(
      persisted.parallelGroups?.map(
        ({ id, startIndex, endIndex, failFast }) => ({
          id,
          startIndex,
          endIndex,
          failFast,
        })
      ),
      [
        { id: "existing-a", startIndex: 0, endIndex: 1, failFast: true },
        {
          id: result.parallelGroupsAdded[0].id,
          startIndex: 3,
          endIndex: 4,
          failFast: false,
        },
        { id: "existing-b", startIndex: 6, endIndex: 7, failFast: true },
      ]
    );
  });

  test("rejects invalid parallel container shapes without changing the definition", async () => {
    const server = await setup();
    const run = await createRun(
      "invalid-container",
      "2026-01-01T00-00-00-000Z",
      { executionState: EXECUTION_STATES.RUNNING }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    const before = await fs.readFile(run.runFilePath, "utf8");

    await assert.rejects(
      () =>
        server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
          position: "end",
          steps: [{ parallel: [{ prompt: "only member" }] }],
        }),
      /append_step\.steps\[0\] must be object or object/
    );
    await assert.rejects(
      () =>
        server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
          position: "end",
          steps: [
            {
              parallel: [
                {
                  parallel: [{ prompt: "nested-a" }, { prompt: "nested-b" }],
                },
                { prompt: "flat" },
              ],
            },
          ],
        }),
      /append_step\.steps\[0\] must be object or object/
    );
    assert.strictEqual(await fs.readFile(run.runFilePath, "utf8"), before);
  });

  test("appends to its own run through the continuation transaction", async () => {
    const server = await setup();
    const run = await createRun("append", "2026-01-01T00-00-00-000Z", {
      executionState: EXECUTION_STATES.RUNNING,
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool("append_step", {
        position: "end",
        steps: [{ prompt: "new tail" }],
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
    assert.ok(persisted.steps?.[1]._runtime?.stepId);
  });

  test("workflow maxSteps rejects an MCP append even when the global limit is unlimited", async () => {
    const server = await setup();
    process.env.CTRLYOKE_MAX_STEPS = "-1";
    const run = await createRun(
      "workflow-step-cap",
      "2026-01-01T00-00-00-000Z",
      { maxSteps: 1, executionState: EXECUTION_STATES.RUNNING }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
    const before = await fs.readFile(run.runFilePath, "utf8");

    await assert.rejects(
      () =>
        server.invokeTool("append_step", {
          position: "end",
          steps: [{ prompt: "over cap" }],
        }),
      /Step limit reached: this run has 1\/1 steps \(workflow maxSteps: 1\)\. Do not retry; finish without appending\./
    );
    assert.strictEqual(await fs.readFile(run.runFilePath, "utf8"), before);
  });

  test("workflow maxSteps=-1 overrides the global MCP cap and status", async () => {
    const server = await setup();
    process.env.CTRLYOKE_MAX_STEPS = "1";
    const run = await createRun(
      "workflow-unlimited-step-cap",
      "2026-01-01T00-00-00-000Z",
      { maxSteps: -1, executionState: EXECUTION_STATES.RUNNING }
    );
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool("append_step", {
        position: "end",
        steps: [{ prompt: "past global cap" }],
      })
    );
    const status = responseJson(await server.invokeTool("workflow_status", {}));
    const persisted = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;

    assert.strictEqual(result.stepsAdded, 1);
    assert.strictEqual(persisted.steps?.length, 2);
    assert.strictEqual(status.metadata.maxSteps, "unlimited");
    assert.strictEqual(status.metadata.remainingSteps, "unlimited");
  });

  test("accepts an append whose prompt matches a completed step", async () => {
    const server = await setup();
    const run = await createRun(
      "repeat-completed",
      "2026-01-01T00-00-00-000Z",
      {
        prompt: "repeat this gate",
        executionState: EXECUTION_STATES.RUNNING,
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
    assert.strictEqual("stepsRejected" in result, false);
    assert.strictEqual(persisted.steps?.length, 2);
    assert.strictEqual(
      (persisted.steps?.[1] as { prompt: string }).prompt,
      "repeat this gate"
    );
  });

  test("cannot append to any run but its own", async () => {
    const server = await setup();
    const own = await createRun("own", "2026-01-01T00-00-00-000Z", {
      executionState: EXECUTION_STATES.RUNNING,
    });
    const other = await createRun("other-run", "2026-01-02T00-00-00-000Z", {
      executionState: EXECUTION_STATES.RUNNING,
    });
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
      const { _runtime: persistedRuntime, ...persistedDefinition } =
        persisted.steps![0];
      const { stepId: _stepId, ...persistedExecutionRuntime } =
        persistedRuntime!;
      assert.deepStrictEqual(
        { ...persistedDefinition, _runtime: persistedExecutionRuntime },
        workingFile.steps![0]
      );
      assert.ok(_stepId);
      assert.ok(persisted.steps?.[2]._runtime?.stepId);
    } finally {
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        run.workflowKey,
        "mcp-next-append-owner"
      );
    }
  });

  test("promotes a running sequential step and returns the live-join shape", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("live-promote");
    try {
      const result = responseJson(
        await server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
          position: "parallelWithCurrent",
          steps: [{ prompt: "join-a" }, { prompt: "join-b" }],
        })
      );
      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;

      assert.strictEqual(result.destination, "activeParallelGroup");
      assert.strictEqual(result.queueItemsAdded, 2);
      assert.strictEqual(result.stepsAdded, 2);
      assert.strictEqual(result.insertIndex, 2);
      assert.strictEqual(result.insertedEndIndex, 3);
      assert.deepStrictEqual(result.placement, {
        requestedIndex: 2,
        insertedIndex: 2,
      });
      assert.strictEqual(result.joinedParallelGroup.promoted, true);
      assert.deepStrictEqual(result.joinedParallelGroup, {
        id: result.parallelGroupsAdded[0].id,
        startIndex: 1,
        endIndex: 3,
        promoted: true,
      });
      assert.deepStrictEqual(
        result.parallelGroupsAdded.map(
          ({
            id,
            startIndex,
            endIndex,
            failFast,
          }: NonNullable<WorkingFile["parallelGroups"]>[number]) => ({
            id,
            startIndex,
            endIndex,
            failFast,
          })
        ),
        [
          {
            id: result.joinedParallelGroup.id,
            startIndex: 1,
            endIndex: 3,
            failFast: false,
          },
        ]
      );
      assert.deepStrictEqual(
        persisted.steps?.map((step) => (step as { prompt: string }).prompt),
        ["completed", "in flight", "join-a", "join-b", "pending-a", "pending-b"]
      );
      assert.deepStrictEqual(persisted._runtime?.activeParallelGroup, {
        groupId: result.joinedParallelGroup.id,
        admission: "accepting",
      });
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("extends an active group once, preserves failFast, and accepts saturation", async () => {
    const server = await setup();
    const { run, ownerToken } = await prepareActiveRun("live-group");
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.parallelGroups = [
      { id: "active-group", startIndex: 1, endIndex: 2, failFast: true },
    ];
    workingFile._runtime = {
      ...workingFile._runtime,
      currentIndex: workingFile._runtime?.currentIndex ?? 0,
      executionState:
        workingFile._runtime?.executionState ?? EXECUTION_STATES.RUNNING,
      activeParallelGroup: {
        groupId: "active-group",
        admission: PARALLEL_GROUP_ADMISSION.ACCEPTING,
      },
    };
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    try {
      const result = responseJson(
        await invokeAppendHandler(server, {
          position: "parallelWithCurrent",
          steps: [{ prompt: "late-a" }, { prompt: "late-b" }],
        })
      );
      const persisted = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;

      assert.strictEqual(result.destination, "activeParallelGroup");
      assert.strictEqual(result.joinedParallelGroup.id, "active-group");
      assert.strictEqual(result.joinedParallelGroup.startIndex, 1);
      assert.strictEqual(result.joinedParallelGroup.endIndex, 4);
      assert.strictEqual(result.joinedParallelGroup.promoted, false);
      assert.deepStrictEqual(result.parallelGroupsAdded, []);
      assert.strictEqual(result.insertIndex, 3);
      assert.strictEqual(result.insertedEndIndex, 4);
      assert.deepStrictEqual(persisted.parallelGroups, [
        { id: "active-group", startIndex: 1, endIndex: 4, failFast: true },
      ]);
    } finally {
      await releaseActiveRun(run, ownerToken);
    }
  });

  test("rejects every live-join availability edge without falling back", async () => {
    const server = await setup();
    async function rejectJoin(
      run: RunFixture,
      expected: RegExp,
      ownerToken?: string,
      directHandler = false
    ): Promise<void> {
      process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
      const before = await fs.readFile(run.runFilePath, "utf8");
      const args: McpAppendStepArguments = {
        position: "parallelWithCurrent",
        steps: [{ prompt: "must not be queued" }],
      };
      await assert.rejects(
        directHandler
          ? invokeAppendHandler(server, args)
          : server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, args),
        expected
      );
      assert.strictEqual(await fs.readFile(run.runFilePath, "utf8"), before);
      if (ownerToken) {
        await releaseActiveRun(run, ownerToken);
      }
    }

    // Live, but with its head past the last step: the run still accepts
    // mutations, and the join is refused for the reason under test rather than
    // for the run having settled.
    await rejectJoin(
      await createRun("live-no-running", "2026-01-01T00-00-00-000Z", {
        executionState: EXECUTION_STATES.RUNNING,
      }),
      /running queue step|No queue step is currently running/i
    );

    const finalRun = await createRun("live-final", "2026-01-02T00-00-00-000Z");
    let finalFile = JSON.parse(
      await fs.readFile(finalRun.runFilePath, "utf8")
    ) as WorkingFile;
    finalFile._runtime = {
      ...finalFile._runtime,
      currentIndex: 0,
      executionState: EXECUTION_STATES.RUNNING,
      finalStep: {
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: 0,
        startedAt: 3,
      },
    };
    await fs.writeFile(finalRun.runFilePath, JSON.stringify(finalFile), "utf8");
    await rejectJoin(finalRun, /final step/i);

    for (const [suffix, state] of [
      ["pausing", EXECUTION_STATES.PAUSING],
      ["cancelling", EXECUTION_STATES.CANCELLING],
      ["stopped", EXECUTION_STATES.STOPPED],
      ["terminal", EXECUTION_STATES.COMPLETED],
    ] as const) {
      const { run, ownerToken } = await prepareActiveRun(`live-${suffix}`);
      const file = JSON.parse(
        await fs.readFile(run.runFilePath, "utf8")
      ) as WorkingFile;
      file._runtime = {
        ...file._runtime,
        currentIndex: file._runtime?.currentIndex ?? 0,
        executionState: state,
      };
      await fs.writeFile(run.runFilePath, JSON.stringify(file), "utf8");
      await rejectJoin(run, /state|executing|running/i, ownerToken);
    }

    const { run: closingRun, ownerToken: closingOwner } =
      await prepareActiveRun("live-closing");
    const closingFile = JSON.parse(
      await fs.readFile(closingRun.runFilePath, "utf8")
    ) as WorkingFile;
    closingFile.parallelGroups = [
      { id: "closing-group", startIndex: 1, endIndex: 2, failFast: true },
    ];
    closingFile._runtime = {
      ...closingFile._runtime,
      currentIndex: closingFile._runtime?.currentIndex ?? 0,
      executionState:
        closingFile._runtime?.executionState ?? EXECUTION_STATES.RUNNING,
      activeParallelGroup: {
        groupId: "closing-group",
        admission: PARALLEL_GROUP_ADMISSION.CLOSING,
      },
    };
    await fs.writeFile(
      closingRun.runFilePath,
      JSON.stringify(closingFile),
      "utf8"
    );
    await rejectJoin(closingRun, /accepting/i, closingOwner, true);

    const { run: widthRun, ownerToken: widthOwner } =
      await prepareActiveRun("live-width-one");
    process.env.CTRLYOKE_MAX_PARALLEL_STEPS = "1";
    await rejectJoin(widthRun, /queue\.maxParallelSteps/i, widthOwner);
    delete process.env.CTRLYOKE_MAX_PARALLEL_STEPS;

    const { run: containerRun, ownerToken: containerOwner } =
      await prepareActiveRun("live-container");
    process.env.CTRLYOKE_WORKING_FILE = containerRun.runFilePath;
    const beforeContainer = await fs.readFile(containerRun.runFilePath, "utf8");
    await assert.rejects(
      invokeAppendHandler(server, {
        position: "parallelWithCurrent",
        steps: [{ parallel: [{ prompt: "nested-a" }, { prompt: "nested-b" }] }],
      }),
      /flat steps only/i
    );
    assert.strictEqual(
      await fs.readFile(containerRun.runFilePath, "utf8"),
      beforeContainer
    );
    await releaseActiveRun(containerRun, containerOwner);

    const { run: invalidRun, ownerToken: invalidOwner } =
      await prepareActiveRun("live-invalid-member");
    await fs.mkdir(path.join(workspaceRoot, ".ctrlyoke"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ctrlyoke", "capabilities.json"),
      JSON.stringify({
        harnesses: [
          {
            id: "claude-cli",
            available: true,
            models: [{ value: "valid-model" }],
          },
        ],
      }),
      "utf8"
    );
    process.env.CTRLYOKE_WORKING_FILE = invalidRun.runFilePath;
    const beforeInvalid = await fs.readFile(invalidRun.runFilePath, "utf8");
    await assert.rejects(
      server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
        position: "parallelWithCurrent",
        steps: [
          {
            prompt: "invalid model",
            harness: "claude-cli",
            model: "bad-model",
          },
        ],
      }),
      /Invalid model/i
    );
    await assert.rejects(
      server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
        position: "parallelWithCurrent",
        steps: [{ prompt: "invalid harness", harness: "not-installed" }],
      }),
      /Invalid harness/i
    );
    assert.strictEqual(
      await fs.readFile(invalidRun.runFilePath, "utf8"),
      beforeInvalid
    );
    await releaseActiveRun(invalidRun, invalidOwner);
  });

  test("includes numeric group relocation in the append response", async () => {
    const server = await setup();
    const run = await createRun("group-append", "2026-01-01T00-00-00-000Z", {
      stepCount: 2,
      currentIndex: 0,
    });
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.parallelGroups = [
      { id: "mcp-authored-group", startIndex: 0, endIndex: 1, failFast: true },
    ];
    // A live run whose head has not reached the authored group yet, so the
    // numeric insert is relocated rather than blocked: unattached to any
    // executor, so the Phase 8 caller-level group mutation ban remains
    // exercised by the live-run tests above.
    workingFile.steps = [
      { prompt: "authored-a" },
      { prompt: "authored-b" },
    ] as WorkflowStep[];
    workingFile._runtime = {
      ...workingFile._runtime,
      currentIndex: -1,
      executionState: EXECUTION_STATES.RUNNING,
    };
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const result = responseJson(
      await server.invokeTool("append_step", {
        position: 1,
        steps: [{ prompt: "after authored group" }],
      })
    );

    assert.deepStrictEqual(result.placement, {
      requestedIndex: 1,
      insertedIndex: 2,
      relocation: {
        kind: "afterParallelGroup",
        groupId: "mcp-authored-group",
      },
    });
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
    const run = await createRun("busy", "2026-01-01T00-00-00-000Z", {
      executionState: EXECUTION_STATES.RUNNING,
    });
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
    // Which of the two reaches the queue first is deliberately not asserted:
    // `invokeTool` awaits `resolveCallingContext` before it enqueues, so two
    // concurrently issued calls race to that boundary — and MCP gives an
    // in-flight request no ordering guarantee either. Both landing is the
    // contract; the order they land in is not.
    const results = await Promise.all(
      ["first", "second"].map((prompt) =>
        server.invokeTool("append_step", {
          position: "end",
          steps: [{ prompt }],
        })
      )
    );
    assert.deepStrictEqual(
      results.map((result) => responseJson(result).newQueueSize).sort(),
      [2, 3]
    );
  });

  // A harness TUI outlives the run that launched it and keeps this server
  // attached, so a person typing into a finished workflow's TUI reaches the
  // mutation tools. Writing to a settled run's file and reporting success told
  // the agent it had queued work that would never execute.
  for (const settled of [
    EXECUTION_STATES.COMPLETED,
    EXECUTION_STATES.ERROR,
    EXECUTION_STATES.STOPPED,
    EXECUTION_STATES.IDLE,
  ] as const) {
    test(`refuses every queue mutation once the run is ${settled}`, async () => {
      const server = await setup();
      const run = await createRun(
        `settled-${settled}`,
        "2026-01-01T00-00-00-000Z",
        { stepCount: 2, executionState: settled }
      );
      process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;
      const before = await fs.readFile(run.runFilePath, "utf8");

      const invocations: Array<[string, Record<string, unknown>]> = [
        [
          MCP_APPEND_STEP_TOOL_NAME,
          { position: "end", steps: [{ prompt: "too late" }] },
        ],
        [
          MCP_EDIT_STEP_TOOL_NAME,
          { index: 1, updates: { prompt: "too late" } },
        ],
        [MCP_REMOVE_STEP_TOOL_NAME, { index: 1 }],
        [MCP_REORDER_STEPS_TOOL_NAME, { indices: [1, 0] }],
      ];

      for (const [toolName, args] of invocations) {
        await assert.rejects(
          () => server.invokeTool(toolName, args),
          (error: Error) => {
            assert.match(error.message, /no longer executing/);
            // The state it refused on, so the caller can tell "finished" from
            // "never started" rather than retrying blind.
            assert.match(error.message, new RegExp(`state: ${settled}`));
            assert.match(error.message, /nothing was changed/);
            return true;
          },
          `${toolName} must refuse a ${settled} run`
        );
      }

      assert.strictEqual(await fs.readFile(run.runFilePath, "utf8"), before);
    });
  }

  test("still reports status and output for a settled run", async () => {
    const server = await setup();
    const run = await createRun("settled-reads", "2026-01-01T00-00-00-000Z", {
      responseText: "the finished answer",
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    // Refusing mutations must not cost the caller its own history: reading a
    // finished run is exactly what a follow-up step needs.
    const status = responseJson(await server.invokeTool("workflow_status", {}));
    assert.strictEqual(
      status.metadata.executionState,
      EXECUTION_STATES.COMPLETED
    );
    const output = responseJson(
      await server.invokeTool(MCP_READ_OUTPUT_TOOL_NAME, {})
    );
    assert.strictEqual(output.outputs[0].responseText, "the finished answer");
  });

  test("reports started parallel group members as running", async () => {
    const server = await setup();
    const run = await createRun("parallel-status", "2026-01-01T00-00-00-000Z", {
      stepCount: 3,
      currentIndex: 0,
      parallelGroups: [
        { id: "status-group", startIndex: 0, endIndex: 2, failFast: true },
      ],
      executionState: EXECUTION_STATES.RUNNING,
    });
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.steps = workingFile.steps!.map((step) => ({
      ...step,
      _runtime: { startedAt: 1 },
    }));
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const status = responseJson(await server.invokeTool("workflow_status", {}));

    assert.deepStrictEqual(
      status.steps.map((step: { status: string }) => step.status),
      [STEP_STATUS.RUNNING, STEP_STATUS.RUNNING, STEP_STATUS.RUNNING]
    );
  });

  test("reports terminal failures instead of completed", async () => {
    const server = await setup();
    const run = await createRun(
      "failed-step-status",
      "2026-01-01T00-00-00-000Z",
      {
        stepCount: 2,
        currentIndex: 1,
        executionState: EXECUTION_STATES.ERROR,
      }
    );
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.steps![0]._runtime = {
      startedAt: 1,
      completedAt: 2,
      terminalStatus: PROMPT_TERMINAL_STATUS.FAILED,
    };
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const status = responseJson(await server.invokeTool("workflow_status", {}));

    assert.strictEqual(status.steps[0].status, STEP_STATUS.FAILED);
  });

  test("returns the newer workflow format refusal as a tool error", async () => {
    const server = await setup();
    const run = await createRun("newer-format", "2026-01-01T00-00-00-000Z");
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.schemaVersion = 2;
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await assert.rejects(
      () =>
        server.invokeTool(MCP_APPEND_STEP_TOOL_NAME, {
          position: "end",
          steps: [{ prompt: "must not append" }],
        }),
      /workflow\.ctrlyoke\.json \(JSON\) uses workflow format 2[\s\S]*supports format 1/u
    );
  });

  test("includes authored schema warnings in workflow_status", async () => {
    const server = await setup();
    const run = await createRun("schema-warnings", "2026-01-01T00-00-00-000Z");
    const sourcePath = path.join(workspaceRoot, "authored-workflow.yaml");
    await fs.writeFile(
      sourcePath,
      "harnes: typo\nsteps:\n  - prompt: loaded\n",
      "utf8"
    );
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      run.workflowKey
    );
    const descriptor = JSON.parse(
      await fs.readFile(descriptorPath, "utf8")
    ) as WorkflowLineageDescriptor;
    descriptor.originalFile = sourcePath;
    await fs.writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const status = responseJson(await server.invokeTool("workflow_status", {}));

    assert.strictEqual(status.schemaWarnings.length, 1);
    assert.strictEqual(status.schemaWarnings[0].propertyPointer, "/harnes");
  });

  test("names the valid range when read_output is given a step that does not exist", async () => {
    const server = await setup();
    const run = await createRun("bad-index", "2026-01-01T00-00-00-000Z", {
      stepCount: 2,
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    // Dropping the index silently returned `outputs: []`, which reads as "that
    // step produced nothing" — the wrong conclusion for a mis-numbered read.
    await assert.rejects(
      () => server.invokeTool(MCP_READ_OUTPUT_TOOL_NAME, { indices: [5] }),
      /has no step 5[\s\S]*valid zero-based indices are 0 to 1/
    );
  });

  test("reports a no-op edit as changed: false", async () => {
    const server = await setup();
    const run = await createRun("noop-edit", "2026-01-01T00-00-00-000Z", {
      stepCount: 2,
      currentIndex: 0,
      parallelGroups: [],
      executionState: EXECUTION_STATES.RUNNING,
    });
    const workingFile = JSON.parse(
      await fs.readFile(run.runFilePath, "utf8")
    ) as WorkingFile;
    workingFile.steps = [
      { prompt: "running", _runtime: { startedAt: 1 } },
      { prompt: "pending" },
    ] as WorkflowStep[];
    await fs.writeFile(run.runFilePath, JSON.stringify(workingFile), "utf8");
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    const unchanged = responseJson(
      await server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
        index: 1,
        updates: { prompt: "pending" },
      })
    );
    assert.strictEqual(unchanged.success, true);
    assert.strictEqual(unchanged.changed, false);
    assert.match(unchanged.note, /wrote nothing/);

    const changed = responseJson(
      await server.invokeTool(MCP_EDIT_STEP_TOOL_NAME, {
        index: 1,
        updates: { prompt: "actually different" },
      })
    );
    assert.strictEqual(changed.changed, true);
    assert.strictEqual("note" in changed, false);
  });

  test("refuses to submit a commit message with nowhere to put it", async () => {
    const server = await setup();
    delete process.env.CTRLYOKE_COMMIT_OUTPUT;

    // Reporting success here discarded the message and said it had been
    // submitted; the only trace was a log line that is off by default.
    await assert.rejects(
      () =>
        server.invokeTool(MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME, {
          message: "feat: nowhere to go",
        }),
      /CTRLYOKE_COMMIT_OUTPUT is unset[\s\S]*discarded rather than submitted/
    );
  });

  test("distinguishes a missing workflow from an idle one on a narrowed global_status", async () => {
    const server = await setup();
    const idle = await createRun("narrow-idle", "2026-01-01T00-00-00-000Z");

    const narrowed = responseJson(
      await server.invokeTool(MCP_GLOBAL_STATUS_TOOL_NAME, {
        workflowKey: idle.workflowKey,
      })
    );
    assert.deepStrictEqual(narrowed.workflows, []);
    assert.match(
      narrowed.note,
      /exists but is not executing \(state: completed\)/
    );

    await assert.rejects(
      () =>
        server.invokeTool(MCP_GLOBAL_STATUS_TOOL_NAME, {
          workflowKey: "mcp-absent-2026-01-01T00-00-00",
        }),
      /no workflow 'mcp-absent-2026-01-01T00-00-00' was found/
    );
  });

  test("refuses a note addressed to a participant that does not exist", async () => {
    const server = await setup();
    const run = await createRun("note-target", "2026-01-01T00-00-00-000Z", {
      executionState: EXECUTION_STATES.RUNNING,
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    // An unknown recipient produced an entry nobody is a recipient of: posted,
    // acknowledged with a sequence number, and read by no one.
    await assert.rejects(
      () =>
        server.invokeTool(MCP_POST_NOTE_TOOL_NAME, {
          text: "for nobody",
          to: ["no-such-participant"],
        }),
      /no live participant[\s\S]*no-such-participant[\s\S]*note was not posted/
    );
  });

  test("reports paths it never held on release_paths", async () => {
    const server = await setup();
    const run = await createRun("release-unheld", "2026-01-01T00-00-00-000Z", {
      executionState: EXECUTION_STATES.RUNNING,
    });
    process.env.CTRLYOKE_WORKING_FILE = run.runFilePath;

    await server.invokeTool(MCP_CLAIM_PATHS_TOOL_NAME, {
      paths: ["src/mine.ts"],
    });
    const released = responseJson(
      await server.invokeTool(MCP_RELEASE_PATHS_TOOL_NAME, {
        paths: ["src/mine.ts", "src/never-claimed.ts"],
      })
    );

    assert.deepStrictEqual(released.released, ["src/mine.ts"]);
    assert.deepStrictEqual(released.notHeld, ["src/never-claimed.ts"]);
    assert.match(released.note, /not released/);
  });
});
