import * as assert from "assert";
import { Command } from "commander";
import { suite, test } from "mocha";
import {
  EXECUTION_STATES,
  type ExecutionState,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import type { RunSummary } from "../../types/WorkflowTimelineTypes";
import type { RunNavigationSummary } from "../../core/orchestration/OutputHistoryManager";
import {
  listHistoryCommand,
  runsHistoryCommand,
  type HistoryInspectionCommandDependencies,
  type HistoryInspectionCommandIo,
  type HistoryInspectionLineageRepository,
  type HistoryInspectionOutputHistoryManager,
  type HistoryInspectionWorkspace,
} from "../../cli/HistoryInspectionCommands";
import {
  registerHistoryCommands,
  type HistoryListOptions,
  type HistoryRunsOptions,
} from "../../cli/HistoryCommandDefinitions";

class TestIo implements HistoryInspectionCommandIo {
  readonly output: string[] = [];
  readonly errors: string[] = [];

  writeOut(message: string): void {
    this.output.push(message);
  }

  writeErr(message: string): void {
    this.errors.push(message);
  }
}

class TestLineageRepository implements HistoryInspectionLineageRepository {
  constructor(
    private readonly keys: WorkflowKey[],
    private readonly descriptors: Map<WorkflowKey, WorkflowLineageDescriptor>,
    private readonly names: Map<WorkflowKey, string>
  ) {}

  async listLineageKeys(): Promise<WorkflowKey[]> {
    return this.keys;
  }

  async tryReadDescriptor(
    _workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowLineageDescriptor | undefined> {
    return this.descriptors.get(workflowKey);
  }

  async readWorkflowDisplayName(
    _workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<string> {
    return this.names.get(workflowKey) ?? `derived-${workflowKey}`;
  }
}

class TestHistoryManager implements HistoryInspectionOutputHistoryManager {
  navigationCalls: WorkflowKey[] = [];
  runSummaryCalls: WorkflowKey[] = [];

  constructor(
    private readonly navigation: Map<WorkflowKey, RunNavigationSummary>,
    private readonly summaries: Map<WorkflowKey, RunSummary[]>
  ) {}

  async getRunNavigationSummary(
    workflowKey: WorkflowKey
  ): Promise<RunNavigationSummary> {
    this.navigationCalls.push(workflowKey);
    return this.navigation.get(workflowKey) ?? { runCount: 0 };
  }

  async getRunSummaries(workflowKey: WorkflowKey): Promise<RunSummary[]> {
    this.runSummaryCalls.push(workflowKey);
    return this.summaries.get(workflowKey) ?? [];
  }
}

function descriptor(
  workflowKey: WorkflowKey,
  overrides: Partial<WorkflowLineageDescriptor> = {}
): WorkflowLineageDescriptor {
  return {
    schemaVersion: 1,
    workflowKey,
    workflowName: "Workflow",
    isFavorite: false,
    createdAt: 100,
    lastModifiedAt: 200,
    nextRunId: 2,
    revision: 1,
    ...overrides,
  };
}

function navigation(
  runRef: RunRef,
  executionState: ExecutionState = EXECUTION_STATES.COMPLETED
): RunNavigationSummary {
  return {
    runCount: 3,
    primaryRunId: 3,
    primaryRunRef: runRef,
    startedAt: 1_700_000_000_000,
    executionState,
    completedAt: 1_700_000_060_000,
  };
}

function dependencies(
  repository: HistoryInspectionLineageRepository,
  historyManager: HistoryInspectionOutputHistoryManager
): HistoryInspectionCommandDependencies {
  const workspace: HistoryInspectionWorkspace = {
    workspaceRoot: "/workspace",
    createLineageRepository: () => repository,
    createOutputHistoryManager: () => historyManager,
  };
  return {
    bootstrapCliWorkspace: async () => workspace,
  };
}

suite("CLI history inspection command parser", () => {
  test("registers list and runs with their discovery options", async () => {
    const calls: {
      list?: HistoryListOptions;
      runs?: HistoryRunsOptions;
    } = {};
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerHistoryCommands(program, {
      prune: async () => {},
      relink: async () => {},
      list: async (options) => {
        calls.list = options;
      },
      runs: async (options) => {
        calls.runs = options;
      },
    });

    await program.parseAsync(
      ["history", "list", "--cwd", "workspace", "--all", "--json"],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.list, {
      cwd: "workspace",
      all: true,
      json: true,
    });

    await program.parseAsync(
      ["history", "runs", "--workflow", "release", "--json"],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.runs, { workflow: "release", json: true });
  });
});

suite("CLI history inspection command handlers", () => {
  test("uses one navigation-manifest read per lineage instead of every run summary", async () => {
    const key = "release-2026-09-20T12-00-00Z" as WorkflowKey;
    const manager = new TestHistoryManager(
      new Map([[key, navigation("run-3" as RunRef)]]),
      new Map()
    );
    const io = new TestIo();

    await listHistoryCommand(
      {},
      io,
      dependencies(
        new TestLineageRepository(
          [key],
          new Map([[key, descriptor(key)]]),
          new Map([[key, "Release"]])
        ),
        manager
      )
    );

    assert.deepStrictEqual(manager.navigationCalls, [key]);
    assert.deepStrictEqual(manager.runSummaryCalls, []);
    assert.match(io.output[1], /3/);
    assert.match(io.output[1], /completed/);
  });

  test("excludes system-generated lineages unless --all is supplied", async () => {
    const userKey = "user" as WorkflowKey;
    const systemKey = "system" as WorkflowKey;
    const repository = new TestLineageRepository(
      [userKey, systemKey],
      new Map([
        [userKey, descriptor(userKey)],
        [systemKey, descriptor(systemKey, { isSystemGenerated: true })],
      ]),
      new Map([
        [userKey, "User workflow"],
        [systemKey, "System workflow"],
      ])
    );
    const manager = new TestHistoryManager(
      new Map([
        [userKey, { runCount: 0 }],
        [systemKey, { runCount: 0 }],
      ]),
      new Map()
    );

    const defaultIo = new TestIo();
    await listHistoryCommand({}, defaultIo, dependencies(repository, manager));
    assert.match(defaultIo.output.join("\n"), /User workflow/);
    assert.doesNotMatch(defaultIo.output.join("\n"), /System workflow/);

    const allIo = new TestIo();
    await listHistoryCommand(
      { all: true, json: true },
      allIo,
      dependencies(repository, manager)
    );
    const rows = JSON.parse(allIo.output[0]) as Array<{ workflowName: string }>;
    assert.deepStrictEqual(
      rows.map((row) => row.workflowName),
      ["User workflow", "System workflow"]
    );
  });

  test("renders a missing descriptor as a JSON row", async () => {
    const key = "legacy-2026-09-20T12-00-00Z" as WorkflowKey;
    const io = new TestIo();
    const manager = new TestHistoryManager(
      new Map([[key, { runCount: 0 }]]),
      new Map()
    );

    await listHistoryCommand(
      { json: true },
      io,
      dependencies(
        new TestLineageRepository(
          [key],
          new Map(),
          new Map([[key, "Legacy lineage"]])
        ),
        manager
      )
    );

    assert.deepStrictEqual(JSON.parse(io.output[0]), [
      {
        workflowKey: key,
        workflowName: "Legacy lineage",
        isFavorite: false,
        createdAt: null,
        lastModifiedAt: null,
        runCount: 0,
        latestRun: null,
      },
    ]);
  });

  test("lists runs newest-first and preserves RunSummary JSON", async () => {
    const key = "release" as WorkflowKey;
    const summaries: RunSummary[] = [
      {
        workflowKey: key,
        runRef: "run-2" as RunRef,
        runDirectory: "/workspace/run-2",
        runId: 2,
        startedAt: 1_700_000_000_000,
        executionState: EXECUTION_STATES.COMPLETED,
        definitionRevision: 1,
        stepCount: 4,
        hasMixedHarnesses: false,
        hasMixedModels: false,
      },
    ];
    const manager = new TestHistoryManager(
      new Map(),
      new Map([[key, summaries]])
    );
    const repository = new TestLineageRepository(
      [key],
      new Map([[key, descriptor(key, { workflowName: "Release" })]]),
      new Map([[key, "Release"]])
    );
    const io = new TestIo();

    await runsHistoryCommand(
      { workflow: key, json: true },
      io,
      dependencies(repository, manager)
    );

    assert.deepStrictEqual(JSON.parse(io.output[0]), summaries);
    assert.deepStrictEqual(manager.runSummaryCalls, [key]);
  });

  test("rejects an unknown workflow key", async () => {
    const key = "known" as WorkflowKey;
    await assert.rejects(
      () =>
        runsHistoryCommand(
          { workflow: "missing" },
          new TestIo(),
          dependencies(
            new TestLineageRepository([key], new Map(), new Map()),
            new TestHistoryManager(new Map(), new Map())
          )
        ),
      /Workflow lineage "missing" was not found/
    );
  });
});
