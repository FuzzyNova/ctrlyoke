import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";
import { afterEach, suite, test } from "mocha";
import {
  EXECUTION_STATES,
  RUNNER_IDS,
  type ExecutionState,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  WorkflowKey,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { RunSummary } from "../../types/WorkflowTimelineTypes";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  editStepCommand,
  removeStepCommand,
  reorderStepsCommand,
  createStepCommandContext,
  type StepCommandContext,
  type StepCommandIo,
} from "../../cli/StepCommands";
import {
  registerStepCommands,
  type StepEditOptions,
  type StepRemoveOptions,
  type StepReorderOptions,
} from "../../cli/StepCommandDefinitions";
import type { CliRunSummaryProvider } from "../../cli/CliRunSelector";

class TestRunSummaryProvider implements CliRunSummaryProvider {
  constructor(private readonly summaries: RunSummary[]) {}

  async getRunSummaries(_workflowKey: WorkflowKey): Promise<RunSummary[]> {
    return this.summaries;
  }
}

class RecordingIo implements StepCommandIo {
  readonly output: string[] = [];

  writeOut(message: string): void {
    this.output.push(message);
  }
}

suite("CLI step command parser", () => {
  test("parses edit, remove, and reorder as non-executing subcommands", async () => {
    const calls: {
      edit?: { file: string | undefined; options: StepEditOptions };
      remove?: StepRemoveOptions;
      reorder?: StepReorderOptions;
    } = {};
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerStepCommands(program, {
      edit: async (file, options) => {
        calls.edit = { file, options };
      },
      remove: async (options) => {
        calls.remove = options;
      },
      reorder: async (options) => {
        calls.reorder = options;
      },
    });

    await program.parseAsync(
      [
        "step",
        "edit",
        "replacement.ctrlyoke.yaml",
        "--workflow",
        "release",
        "--run",
        "7",
        "--index",
        "3",
      ],
      { from: "user" }
    );
    await program.parseAsync(
      [
        "step",
        "remove",
        "--workflow",
        "release",
        "--run",
        "run-2026-07-20T10-30-00-000Z",
        "--index",
        "2",
      ],
      { from: "user" }
    );
    await program.parseAsync(
      [
        "step",
        "reorder",
        "--workflow",
        "release",
        "--run",
        "7",
        "--order",
        "1,3,2",
      ],
      { from: "user" }
    );

    assert.strictEqual(calls.edit?.file, "replacement.ctrlyoke.yaml");
    assert.strictEqual(calls.edit?.options.index, "3");
    assert.strictEqual(calls.remove?.index, "2");
    assert.strictEqual(calls.reorder?.order, "1,3,2");
  });
});

suite("CLI step command handlers", () => {
  const workflowKey = "cli-step-commands-2026-01-01T00-00-00" as WorkflowKey;
  const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
  let workspaceRoot: string;
  let stateHome: string;
  const originalStateHome = process.env.CTRLYOKE_HOME;

  afterEach(async () => {
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
    if (stateHome) {
      await fs.rm(stateHome, { recursive: true, force: true });
    }
    if (originalStateHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalStateHome;
    }
  });

  test("preserves parser errors from a missing or invalid edit source", async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-step-parse-")
    );
    const commandContext = createStepCommandContext(workspaceRoot);
    await assert.rejects(
      () =>
        commandContext.parseStepFile(
          path.join(workspaceRoot, "missing.yaml")
        ),
      /ENOENT/u
    );

    const invalidFile = path.join(workspaceRoot, "invalid.ctrlyoke.yaml");
    await fs.writeFile(invalidFile, "steps:\n  - bogus: 1\n", "utf8");
    await assert.rejects(
      () => commandContext.parseStepFile(invalidFile),
      /Validation failed:.*steps/u
    );
  });

  test("edits a pending step of an idle run", async () => {
    await seedRun(EXECUTION_STATES.IDLE, 0, [
      { prompt: "old prompt" },
      { prompt: "later" },
    ]);
    const io = new RecordingIo();

    await editStepCommand(
      undefined,
      editOptions({ index: "0", prompt: "new prompt" }),
      context(),
      io
    );

    const persisted = await readRun();
    assert.strictEqual(
      (persisted.steps?.[0] as { prompt?: string } | undefined)?.prompt,
      "new prompt"
    );
    assert.match(io.output[0], /Edited step 0/);
  });

  test("edits a pending step while another process actively executes the run", async () => {
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "completed", _runtime: { startedAt: 9, completedAt: 10 } },
      { prompt: "in flight", _runtime: { startedAt: 11 } },
      { prompt: "pending" },
    ]);
    const ownerToken = await acquireExternalLock();
    try {
      await editStepCommand(
        undefined,
        editOptions({ index: "2", prompt: "corrected while running" }),
        context(),
        new RecordingIo()
      );
      const persisted = await readRun();
      assert.strictEqual(
        (persisted.steps?.[2] as { prompt?: string } | undefined)?.prompt,
        "corrected while running"
      );
    } finally {
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        workflowKey,
        ownerToken
      );
    }
  });

  test("rejects a completed step and the in-flight step", async () => {
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "completed", _runtime: { startedAt: 9, completedAt: 10 } },
      { prompt: "in flight", _runtime: { startedAt: 11 } },
      { prompt: "pending" },
    ]);
    const ownerToken = await acquireExternalLock();
    try {
      await assert.rejects(
        () =>
          editStepCommand(
            undefined,
            editOptions({ index: "0", prompt: "blocked" }),
            context(),
            new RecordingIo()
          ),
        /completed step/i
      );
      await assert.rejects(
        () =>
          editStepCommand(
            undefined,
            editOptions({ index: "1", prompt: "blocked" }),
            context(),
            new RecordingIo()
          ),
        /currently executing/i
      );
    } finally {
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        workflowKey,
        ownerToken
      );
    }
  });

  test("removes a pending step", async () => {
    await seedRun(EXECUTION_STATES.IDLE, 0, [
      { prompt: "first" },
      { prompt: "remove" },
      { prompt: "last" },
    ]);

    await removeStepCommand(
      { ...removeOptions(), index: "1" },
      context(),
      new RecordingIo()
    );

    assert.deepStrictEqual(
      (await readRun()).steps?.map(
        (step) => (step as { prompt?: string }).prompt
      ),
      ["first", "last"]
    );
  });

  test("reorders pending steps using absolute indices", async () => {
    await seedRun(EXECUTION_STATES.IDLE, 0, [
      { prompt: "first" },
      { prompt: "second" },
      { prompt: "third" },
    ]);

    await reorderStepsCommand(
      { ...reorderOptions(), order: "2,0,1" },
      context(),
      new RecordingIo()
    );

    assert.deepStrictEqual(
      (await readRun()).steps?.map(
        (step) => (step as { prompt?: string }).prompt
      ),
      ["third", "first", "second"]
    );
  });

  test("reorders not-yet-started steps without splitting a parallel group", async () => {
    await seedRun(EXECUTION_STATES.RUNNING, 1, [
      { prompt: "completed", _runtime: { completedAt: 10 } },
      { prompt: "in flight", _runtime: { startedAt: 11 } },
      { prompt: "group first" },
      { prompt: "group second" },
      { prompt: "tail" },
    ]);
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const workingFile = JSON.parse(await fs.readFile(runFilePath, "utf8")) as {
      parallelGroups?: unknown;
    };
    workingFile.parallelGroups = [
      { id: "cli-group", startIndex: 2, endIndex: 3, failFast: true },
    ];
    await fs.writeFile(runFilePath, JSON.stringify(workingFile), "utf8");
    const ownerToken = await acquireExternalLock();
    try {
      await reorderStepsCommand(
        { ...reorderOptions(), order: "4,2,3" },
        context(),
        new RecordingIo()
      );

      const persisted = JSON.parse(await fs.readFile(runFilePath, "utf8")) as {
        steps?: WorkflowStep[];
        parallelGroups?: Array<{
          id: string;
          startIndex: number;
          endIndex: number;
          failFast: boolean;
        }>;
      };
      assert.deepStrictEqual(
        persisted.steps?.map((step) => (step as { prompt: string }).prompt),
        ["completed", "in flight", "tail", "group first", "group second"]
      );
      assert.deepStrictEqual(persisted.parallelGroups, [
        { id: "cli-group", startIndex: 3, endIndex: 4, failFast: true },
      ]);
    } finally {
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        workflowKey,
        ownerToken
      );
    }
  });

  test("rejects an unresolvable --run reference", async () => {
    await seedRun(EXECUTION_STATES.IDLE, 0, [{ prompt: "pending" }]);
    await assert.rejects(
      () =>
        removeStepCommand(
          { ...removeOptions(), run: "run-2026-01-02T00-00-00-000Z" },
          context(),
          new RecordingIo()
        ),
      /was not found in workflow/
    );
  });

  function context(): StepCommandContext {
    return {
      workspaceRoot,
      outputHistoryManager: new TestRunSummaryProvider([
        {
          workflowKey,
          runRef,
          runDirectory: WorkflowPaths.runDir(
            workspaceRoot,
            workflowKey,
            runRef
          ),
          runId: 1,
          startedAt: 0,
          executionState: EXECUTION_STATES.IDLE,
          definitionRevision: 1,
          stepCount: 3,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ]),
      lineageRepository: new WorkflowLineageRepository(),
      observer: {
        runner: RUNNER_IDS.CLI,
        hostInstanceId: "cli-test-observer",
        pid: process.pid,
      },
      parseStepFile: async () => [{ prompt: "from file" }],
    };
  }

  async function seedRun(
    executionState: ExecutionState,
    currentIndex: number,
    steps: WorkflowStep[]
  ): Promise<void> {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-step-")
    );
    stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-state-"));
    process.env.CTRLYOKE_HOME = stateHome;
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
    await fs.writeFile(
      descriptorPath,
      JSON.stringify({
        schemaVersion: 1,
        workflowKey,
        workflowName: "CLI step commands",
        isFavorite: false,
        createdAt: 0,
        lastModifiedAt: 0,
        latestRunRef: runRef,
        nextRunId: 2,
        revision: 1,
      })
    );
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    await fs.mkdir(path.dirname(runFilePath), { recursive: true });
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        workflowName: "CLI step commands",
        startedAt: 0,
        definitionRevision: 1,
        steps,
        _runtime: { currentIndex, executionState },
      })
    );
  }

  async function acquireExternalLock(): Promise<string> {
    const ownerToken = WorkflowLockManager.generateOwnerToken();
    await WorkflowLockManager.acquireLock(workspaceRoot, workflowKey, {
      schemaVersion: 2,
      workflowKey,
      runRef,
      runner: RUNNER_IDS.VSCODE,
      pid: process.ppid,
      hostInstanceId: "other-process-host",
      executionInstanceId: "other-execution",
      ownerToken,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    return ownerToken;
  }

  async function readRun(): Promise<{
    steps?: WorkflowStep[];
  }> {
    return JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(workspaceRoot, workflowKey, runRef),
        "utf8"
      )
    ) as { steps?: WorkflowStep[] };
  }

  function editOptions(
    overrides: Partial<StepEditOptions> = {}
  ): StepEditOptions {
    return {
      workflow: workflowKey,
      run: runRef,
      index: "0",
      prompt: "updated",
      ...overrides,
    };
  }

  function removeOptions(): StepRemoveOptions {
    return { workflow: workflowKey, run: runRef, index: "0" };
  }

  function reorderOptions(): StepReorderOptions {
    return { workflow: workflowKey, run: runRef, order: "0,1,2" };
  }
});
