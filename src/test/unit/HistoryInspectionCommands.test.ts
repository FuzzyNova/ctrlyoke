import * as assert from "assert";
import chalk from "chalk";
import { Command } from "commander";
import { setup, suite, teardown, test } from "mocha";
import {
  EXECUTION_STATES,
  type ExecutionState,
  FINAL_STEP_PHASES,
  RUN_OUTPUT_RESOLVER_EVENT_KINDS,
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
  showHistoryCommand,
  type HistoryInspectionCommandDependencies,
  type HistoryInspectionCommandIo,
  type HistoryInspectionLineageRepository,
  type HistoryInspectionOutputHistoryManager,
  type HistoryInspectionRunOutputResolver,
  type HistoryInspectionWorkspace,
} from "../../cli/HistoryInspectionCommands";
import { CliTerminalFormatter } from "../../cli/CliTerminalFormatter";
import type {
  ResolvedRunAttemptValue,
  RunOutputResolverAttemptEvent,
} from "../../core/orchestration/RunOutputResolver";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import {
  registerHistoryCommands,
  type HistoryListOptions,
  type HistoryRunsOptions,
  type HistoryShowOptions,
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

class TestRunOutputResolver implements HistoryInspectionRunOutputResolver {
  constructor(private readonly events: RunOutputResolverAttemptEvent[]) {}

  async *streamAttempts(
    _manifestPath: string
  ): AsyncGenerator<RunOutputResolverAttemptEvent, void, undefined> {
    yield* this.events;
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
  historyManager: HistoryInspectionOutputHistoryManager,
  resolver?: HistoryInspectionRunOutputResolver
): HistoryInspectionCommandDependencies {
  const workspace: HistoryInspectionWorkspace = {
    workspaceRoot: "/workspace",
    createLineageRepository: () => repository,
    createOutputHistoryManager: () => historyManager,
  };
  return {
    bootstrapCliWorkspace: async () => workspace,
    ...(resolver ? { createRunOutputResolver: () => resolver } : {}),
  };
}

function settledAttempt(
  target: OutputExecutionTarget,
  overrides: Partial<ResolvedRunAttemptValue> = {}
): Extract<
  RunOutputResolverAttemptEvent,
  { kind: typeof RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED }
> {
  return {
    kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED,
    attempt: {
      target,
      runIndex: 0,
      attemptIndex: 0,
      prompt: "show this prompt",
      kind: "ai",
      output: {
        response: "show this response",
        elapsed: 1,
        isStreaming: false,
      },
      terminalState: "completed",
      ...overrides,
    },
    unterminated: false,
  };
}

let chalkLevel: typeof chalk.level;
setup(() => {
  chalkLevel = chalk.level;
  chalk.level = 0;
});

teardown(() => {
  chalk.level = chalkLevel;
});

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
      show: async () => {},
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

  test("registers show with its selector and NDJSON options", async () => {
    let showOptions: HistoryShowOptions | undefined;
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerHistoryCommands(program, {
      prune: async () => {},
      relink: async () => {},
      list: async () => {},
      runs: async () => {},
      show: async (options) => {
        showOptions = options;
      },
    });

    await program.parseAsync(
      [
        "history",
        "show",
        "--workflow",
        "release",
        "--run",
        "3",
        "--step",
        "final",
        "--json",
        "--no-color",
      ],
      { from: "user" }
    );

    assert.deepStrictEqual(showOptions, {
      workflow: "release",
      run: "3",
      step: "final",
      json: true,
      color: false,
    });
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

  test("--step final selects final-step loops rather than a queue step", async () => {
    const key = "release" as WorkflowKey;
    const manager = new TestHistoryManager(
      new Map(),
      new Map([
        [
          key,
          [
            {
              workflowKey: key,
              runRef: "run-2026-09-20T12-00-00-000Z" as RunRef,
              runDirectory: "/workspace/run-3",
              runId: 3,
              startedAt: 1,
              executionState: EXECUTION_STATES.COMPLETED,
              definitionRevision: 1,
              stepCount: 2,
              hasMixedHarnesses: false,
              hasMixedModels: false,
            },
          ],
        ],
      ])
    );
    const promptHeaders: number[] = [];
    const finalLabels: number[] = [];
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    const originalFinalLabel = CliTerminalFormatter.renderFinalStepLabel;
    CliTerminalFormatter.renderPromptHeader = ((data) => {
      promptHeaders.push(data.stepIndex);
    }) as typeof originalHeader;
    CliTerminalFormatter.renderFinalStepLabel = ((loopIndex) => {
      finalLabels.push(loopIndex);
    }) as typeof originalFinalLabel;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", step: "final" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([
            settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 }),
            settledAttempt({
              kind: FINAL_STEP_PHASES.FINAL_STEP,
              loopIndex: 0,
            }),
            settledAttempt({
              kind: FINAL_STEP_PHASES.FINAL_STEP,
              loopIndex: 1,
            }),
          ])
        )
      );
    } finally {
      CliTerminalFormatter.renderPromptHeader = originalHeader;
      CliTerminalFormatter.renderFinalStepLabel = originalFinalLabel;
    }
    assert.deepStrictEqual(promptHeaders, [0, 1]);
    assert.deepStrictEqual(finalLabels, [0, 1]);
  });

  test("renders a folded attempt response exactly once", async () => {
    const key = "release" as WorkflowKey;
    const manager = historyManagerForShow(key);
    const chunks: string[] = [];
    let flushes = 0;
    const originalChunk = CliTerminalFormatter.renderStreamingChunk;
    const originalFlush = CliTerminalFormatter.flushStreamingBuffer;
    CliTerminalFormatter.renderStreamingChunk = ((chunk) => {
      chunks.push(chunk);
    }) as typeof originalChunk;
    CliTerminalFormatter.flushStreamingBuffer = (() => {
      flushes++;
    }) as typeof originalFlush;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([
            settledAttempt(
              { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
              {
                output: {
                  response: "the answer",
                  elapsed: 1,
                  isStreaming: false,
                },
              }
            ),
          ])
        )
      );
    } finally {
      CliTerminalFormatter.renderStreamingChunk = originalChunk;
      CliTerminalFormatter.flushStreamingBuffer = originalFlush;
    }
    assert.deepStrictEqual(chunks, ["the answer"]);
    assert.strictEqual(flushes, 1);
  });

  test("emits redacted NDJSON attempts without invoking the renderer", async () => {
    const key = "release" as WorkflowKey;
    const manager = historyManagerForShow(key);
    const io = new TestIo();
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    let rendered = false;
    CliTerminalFormatter.renderPromptHeader = (() => {
      rendered = true;
    }) as typeof originalHeader;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", json: true },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([
            settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }),
            {
              ...settledAttempt({
                kind: FINAL_STEP_PHASES.QUEUE,
                stepIndex: 1,
              }),
              unterminated: true,
            },
          ])
        )
      );
    } finally {
      CliTerminalFormatter.renderPromptHeader = originalHeader;
    }
    assert.strictEqual(rendered, false);
    assert.strictEqual(io.output.length, 2);
    for (const line of io.output) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });

  test("renders and marks an unterminated attempt", async () => {
    const key = "release" as WorkflowKey;
    const manager = historyManagerForShow(key);
    const statuses: string[] = [];
    const originalStatus = CliTerminalFormatter.renderStatusMessage;
    CliTerminalFormatter.renderStatusMessage = ((message) => {
      statuses.push(message);
    }) as typeof originalStatus;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([
            {
              ...settledAttempt({
                kind: FINAL_STEP_PHASES.QUEUE,
                stepIndex: 0,
              }),
              unterminated: true,
            },
          ])
        )
      );
    } finally {
      CliTerminalFormatter.renderStatusMessage = originalStatus;
    }
    assert.deepStrictEqual(statuses, [
      "Attempt did not terminate before the recorded history ended",
    ]);
  });
});

function historyManagerForShow(key: WorkflowKey): TestHistoryManager {
  return new TestHistoryManager(
    new Map(),
    new Map([
      [
        key,
        [
          {
            workflowKey: key,
            runRef: "run-2026-09-20T12-00-00-000Z" as RunRef,
            runDirectory: "/workspace/run-3",
            runId: 3,
            startedAt: 1,
            executionState: EXECUTION_STATES.COMPLETED,
            definitionRevision: 1,
            stepCount: 2,
            hasMixedHarnesses: false,
            hasMixedModels: false,
          },
        ],
      ],
    ])
  );
}
