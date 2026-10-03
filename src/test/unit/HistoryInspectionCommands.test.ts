import * as assert from "assert";
import chalk from "chalk";
import { Command } from "commander";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { existsSync } from "fs";
import { setup, suite, teardown, test } from "mocha";
import {
  EXECUTION_STATES,
  type ExecutionState,
  FINAL_STEP_PHASES,
  HISTORY_SHOW_ATTEMPT_SELECTORS,
  HISTORY_SHOW_STEP_SELECTORS,
  HISTORY_EVENT_KINDS,
  HISTORY_MATCH_FIELDS,
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
  searchHistoryCommand,
  stepsHistoryCommand,
  showHistoryCommand,
  type HistorySearchCommandService,
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
  RunAttemptLifecycleEvent,
  RunOutputResolverAttemptEvent,
} from "../../core/orchestration/RunOutputResolver";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import {
  registerHistoryCommands,
  type HistoryListOptions,
  type HistoryRunsOptions,
  type HistorySearchOptions,
  type HistoryStepsOptions,
  type HistoryShowOptions,
  type HistoryTrashCommandHandlers,
} from "../../cli/HistoryCommandDefinitions";
import type {
  HistorySearchQuery,
  HistorySearchResponse,
} from "../../types/WorkflowTimelineTypes";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import { HistorySearchService } from "../../core/orchestration/HistorySearchService";
import {
  pageOutputText,
  parseOutputTextPaging,
} from "../../core/orchestration/OutputTextPaging";
import { MAX_INDEXED_TEXT_LENGTH } from "../../core/orchestration/HistorySearchIndexService";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { Log } from "../../utils/Log";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  parseHistoryShowAttempt,
  parseHistoryShowStep,
} from "../../cli/CliRunSelector";

class TestIo implements HistoryInspectionCommandIo {
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly progress: string[] = [];
  isErrTty = false;

  writeOut(message: string): void {
    this.output.push(message);
  }

  writeErr(message: string): void {
    this.errors.push(message);
  }

  writeErrProgress(message: string): void {
    this.progress.push(message);
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
  constructor(
    private readonly events: RunOutputResolverAttemptEvent[],
    private readonly lifecycleEvents: RunAttemptLifecycleEvent[] = []
  ) {}

  async *streamAttempts(
    _manifestPath: string
  ): AsyncGenerator<RunOutputResolverAttemptEvent, void, undefined> {
    yield* this.events;
  }

  async *streamAttemptLifecycle(): AsyncGenerator<
    RunAttemptLifecycleEvent,
    void,
    undefined
  > {
    yield* this.lifecycleEvents;
  }
}

class TestHistorySearchService implements HistorySearchCommandService {
  request?: string | HistorySearchQuery;
  options?: Parameters<HistorySearchCommandService["search"]>[5];

  constructor(
    private readonly response: HistorySearchResponse,
    private readonly progressTicks: Array<[number, number]> = []
  ) {}

  async search(
    query: string | HistorySearchQuery,
    _workspaceFolderPath: string,
    onRebuildProgress?: Parameters<HistorySearchCommandService["search"]>[2],
    _signal?: AbortSignal,
    _onPartialResults?: Parameters<HistorySearchCommandService["search"]>[4],
    options?: Parameters<HistorySearchCommandService["search"]>[5]
  ): Promise<HistorySearchResponse> {
    this.request = query;
    this.options = options;
    for (const [processedRuns, totalRuns] of this.progressTicks) {
      onRebuildProgress?.(processedRuns, totalRuns);
    }
    return this.response;
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
  resolver?: HistoryInspectionRunOutputResolver,
  searchService?: HistorySearchCommandService,
  workspaceRoot = "/workspace"
): HistoryInspectionCommandDependencies {
  const workspace: HistoryInspectionWorkspace = {
    workspaceRoot,
    createLineageRepository: () => repository,
    createOutputHistoryManager: () => historyManager,
  };
  return {
    bootstrapCliWorkspace: async () => workspace,
    ...(resolver ? { createRunOutputResolver: () => resolver } : {}),
    ...(searchService
      ? { createHistorySearchService: () => searchService }
      : {}),
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
    continuation: false,
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

const NOOP_TRASH_HANDLERS: HistoryTrashCommandHandlers = {
  list: async () => {},
  restore: async () => {},
  purge: async () => {},
  empty: async () => {},
};

suite("CLI history inspection command parser", () => {
  test("registers list and runs with their discovery options", async () => {
    const calls: {
      list?: HistoryListOptions;
      runs?: HistoryRunsOptions;
      steps?: HistoryStepsOptions;
      show?: HistoryShowOptions;
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
      steps: async (options) => {
        calls.steps = options;
      },
      runs: async (options) => {
        calls.runs = options;
      },
      show: async (options) => {
        calls.show = options;
      },
      search: async () => {},
      trash: NOOP_TRASH_HANDLERS,
    });

    await program.parseAsync(
      [
        "history",
        "list",
        "--cwd",
        "workspace",
        "--all",
        "--state",
        "running",
        "paused",
        "--since",
        "7d",
        "--limit",
        "12",
        "--json",
      ],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.list, {
      cwd: "workspace",
      all: true,
      state: ["running", "paused"],
      since: "7d",
      limit: "12",
      json: true,
    });

    await program.parseAsync(
      ["history", "runs", "--workflow", "release", "--json"],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.runs, { workflow: "release", json: true });

    await program.parseAsync(
      ["history", "steps", "--workflow", "release", "--full-prompts"],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.steps, {
      workflow: "release",
      fullPrompts: true,
    });

    await program.parseAsync(
      [
        "history",
        "show",
        "--workflow",
        "release",
        "--kind",
        "prompt",
        "response",
        "--path",
        "src/",
        "--limit",
        "500",
        "--cursor",
        "0",
        "--max-events",
        "12",
      ],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.show, {
      workflow: "release",
      kind: ["prompt", "response"],
      path: "src/",
      limit: "500",
      cursor: "0",
      maxEvents: "12",
      color: true,
    });
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
      steps: async () => {},
      search: async () => {},
      trash: NOOP_TRASH_HANDLERS,
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

  test("registers search with repeatable filters and index policies", async () => {
    let searchQuery: string | undefined;
    let searchOptions: HistorySearchOptions | undefined;
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerHistoryCommands(program, {
      prune: async () => {},
      relink: async () => {},
      list: async () => {},
      runs: async () => {},
      show: async () => {},
      steps: async () => {},
      search: async (query, options) => {
        searchQuery = query;
        searchOptions = options;
      },
      trash: NOOP_TRASH_HANDLERS,
    });

    await program.parseAsync(
      [
        "history",
        "search",
        "EPERM",
        "--workflow",
        "release",
        "nightly",
        "--kind",
        "bash",
        "response",
        "--exact-count",
        "--deep",
        "--regex",
        "--no-rebuild",
        "--no-fallback",
      ],
      { from: "user" }
    );

    assert.strictEqual(searchQuery, "EPERM");
    assert.deepStrictEqual(searchOptions, {
      workflow: ["release", "nightly"],
      kind: ["bash", "response"],
      exactCount: true,
      deep: true,
      regex: true,
      rebuild: false,
      fallback: false,
      color: true,
    });
  });
});

suite("CLI history inspection command handlers", () => {
  test("shares character paging behavior and surrogate-safe cursors", () => {
    const paging = parseOutputTextPaging({ limit: 3 }, 1, "history show")!;
    assert.deepStrictEqual(pageOutputText("AB😀CD", paging), {
      text: "AB",
      nextCursor: "2",
    });
    assert.deepStrictEqual(
      pageOutputText(
        "AB😀CD",
        parseOutputTextPaging({ cursor: "3" }, 1, "history show")!
      ),
      { text: "CD" }
    );
    assert.throws(
      () => parseOutputTextPaging({ tail: 2, limit: 1 }, 1, "history show"),
      /tail is mutually exclusive/
    );
    assert.throws(
      () => parseOutputTextPaging({ limit: 2 }, 2, "history show"),
      /exactly one step/
    );
  });

  test("pages one selected show attempt and returns the shared next cursor", async () => {
    const key = "release" as WorkflowKey;
    const io = new TestIo();
    const chunks: string[] = [];
    const originalChunk = CliTerminalFormatter.renderStreamingChunk;
    CliTerminalFormatter.renderStreamingChunk = ((chunk) =>
      chunks.push(chunk)) as typeof originalChunk;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0", limit: "5" },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([
            settledAttempt(
              { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
              {
                output: {
                  response: "abcdefgh",
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
    }
    assert.deepStrictEqual(chunks, ["abcde"]);
    assert.match(io.output.join("\n"), /use --cursor 5/);
  });

  test("shows working-file steps and counts retry and final-step lifecycle events", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-steps-")
    );
    const key = "release" as WorkflowKey;
    const runRef = "run-2026-09-20T12-00-00-000Z" as RunRef;
    try {
      const workingFile = WorkflowPaths.runFilePath(workspaceRoot, key, runRef);
      await fs.mkdir(path.dirname(workingFile), { recursive: true });
      await fs.writeFile(
        workingFile,
        JSON.stringify({
          steps: [
            {
              name: "plan",
              prompt: "First line\nsecond line",
              _runtime: {
                harness: "claude-cli",
                model: "opus",
                terminalStatus: "completed",
                elapsed: 125,
              },
            },
            {
              name: "Appended step with no definition snapshot",
              prompt: "A long-running prompt",
              _runtime: {
                harness: "codex-cli",
                model: "gpt-6-luna",
                startedAt: 10,
              },
            },
            { prompt: "Pending prompt" },
          ],
          finalStep: {
            name: "review",
            prompt: "Review all changes",
            _runtime: {
              harness: "claude-cli",
              model: "opus",
              terminalStatus: "completed",
            },
          },
          _runtime: { executionState: "paused" },
        })
      );
      const manager = new TestHistoryManager(
        new Map(),
        new Map([
          [
            key,
            [
              {
                workflowKey: key,
                runRef,
                runDirectory: path.dirname(workingFile),
                runId: 3,
                startedAt: 10,
                executionState: EXECUTION_STATES.PAUSED,
                definitionRevision: 1,
                stepCount: 1,
                workingFileStepCount: 3,
                hasFinalStep: true,
                hasMixedHarnesses: false,
                hasMixedModels: false,
              },
            ],
          ],
        ])
      );
      const resolver = new TestRunOutputResolver(
        [],
        [
          {
            eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          },
          {
            eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          },
          {
            eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
          },
          {
            eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
            target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
          },
          {
            eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
            target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 },
          },
        ]
      );
      const io = new TestIo();

      await stepsHistoryCommand(
        { workflow: key, json: true },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          resolver,
          undefined,
          workspaceRoot
        )
      );

      const value = JSON.parse(io.output[0]) as {
        runRef: string;
        steps: Array<{
          selector: string;
          name: string;
          state: string;
          attempts: number;
          prompt: string;
          elapsed: string;
        }>;
        finalStep: { selector: string; passes: number };
      };
      assert.strictEqual(value.runRef, runRef);
      assert.deepStrictEqual(
        value.steps.map((step) => step.selector),
        ["0", "1", "2"]
      );
      assert.strictEqual(value.steps[0].attempts, 2);
      assert.strictEqual(value.steps[0].elapsed, "2m5s");
      assert.strictEqual(
        value.steps[1].name,
        "Appended step with no definition snapshot"
      );
      assert.strictEqual(value.steps[1].state, "running");
      assert.strictEqual(value.steps[1].attempts, 1);
      assert.strictEqual(value.steps[2].state, "pending");
      assert.strictEqual(value.steps[0].prompt, "First line");
      assert.deepStrictEqual(value.finalStep, {
        selector: "final",
        name: "review",
        state: "completed",
        harness: "claude-cli",
        model: "opus",
        elapsed: "—",
        passes: 2,
        prompt: "Review all changes",
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("history list uses the activity time of an appended in-progress step", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-recency-")
    );
    try {
      const key = "release-2026-09-20T12-00-00Z" as WorkflowKey;
      const runRef = "run-2026-09-29T10-00-00-000Z" as RunRef;
      const runFilePath = WorkflowPaths.runFilePath(workspaceRoot, key, runRef);
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          startedAt: 1_700_000_000_000,
          steps: [{ prompt: "appended and still running" }],
          _runtime: {
            currentIndex: 0,
            executionState: EXECUTION_STATES.RUNNING,
            lastActivityAt: Date.now(),
          },
        })
      );
      const manager = new TestHistoryManager(
        new Map([
          [
            key,
            {
              ...navigation(runRef, EXECUTION_STATES.RUNNING),
              startedAt: 1_700_000_000_000,
              completedAt: undefined,
            },
          ],
        ]),
        new Map()
      );
      const io = new TestIo();

      await listHistoryCommand(
        { json: true },
        io,
        dependencies(
          new TestLineageRepository(
            [key],
            new Map([[key, descriptor(key)]]),
            new Map([[key, "Release"]])
          ),
          manager,
          undefined,
          undefined,
          workspaceRoot
        )
      );

      const [row] = JSON.parse(io.output[0]) as Array<{
        lastModifiedAt: number;
        latestRun: { completedAt: number | null };
      }>;
      assert.ok(row.lastModifiedAt > 1_700_000_000_000);
      assert.strictEqual(row.latestRun.completedAt, null);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

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

  test("filters history list by latest state, shared since parsing, and limit", async () => {
    const keys = ["a", "b", "c"] as WorkflowKey[];
    const current = 1_700_000_000_000;
    const originalNow = Date.now;
    Date.now = () => current;
    try {
      const manager = new TestHistoryManager(
        new Map([
          [
            keys[0],
            {
              ...navigation("run-a" as RunRef, EXECUTION_STATES.PAUSED),
              startedAt: current - 1_000,
            },
          ],
          [
            keys[1],
            {
              ...navigation("run-b" as RunRef, EXECUTION_STATES.RUNNING),
              startedAt: current - 1_000,
            },
          ],
          [
            keys[2],
            {
              ...navigation("run-c" as RunRef, EXECUTION_STATES.PAUSED),
              startedAt: current - 8 * 86_400_000,
            },
          ],
        ]),
        new Map()
      );
      const io = new TestIo();
      await listHistoryCommand(
        { state: ["paused"], since: "7d", limit: "1", json: true },
        io,
        dependencies(
          new TestLineageRepository(keys, new Map(), new Map()),
          manager
        )
      );
      const rows = JSON.parse(io.output[0]) as Array<{ workflowKey: string }>;
      assert.deepStrictEqual(
        rows.map((row) => row.workflowKey),
        [keys[0]]
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("history runs text uses the live working-file step count", async () => {
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
              stepCount: 1,
              workingFileStepCount: 4,
              hasFinalStep: true,
              hasMixedHarnesses: false,
              hasMixedModels: false,
            },
          ],
        ],
      ])
    );
    const io = new TestIo();
    await runsHistoryCommand(
      { workflow: key },
      io,
      dependencies(
        new TestLineageRepository([key], new Map(), new Map()),
        manager
      )
    );
    assert.match(io.output[2], /  4  /);
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

  test("parses every history show step and attempt selector form", () => {
    assert.deepStrictEqual(parseHistoryShowStep("3,7,10-12"), {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndices: [3, 7, 10, 11, 12],
    });
    assert.deepStrictEqual(parseHistoryShowStep("final"), {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
    });
    assert.deepStrictEqual(parseHistoryShowStep("final:3"), {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      passNumber: 3,
    });
    assert.deepStrictEqual(parseHistoryShowStep("final:latest"), {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      passNumber: HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST,
    });
    assert.deepStrictEqual(parseHistoryShowStep("running"), {
      kind: HISTORY_SHOW_STEP_SELECTORS.RUNNING,
    });
    assert.deepStrictEqual(parseHistoryShowStep("latest"), {
      kind: HISTORY_SHOW_STEP_SELECTORS.LATEST,
    });
    assert.strictEqual(parseHistoryShowStep(undefined), undefined);
    assert.deepStrictEqual(parseHistoryShowAttempt(undefined), { kind: "all" });
    assert.deepStrictEqual(parseHistoryShowAttempt("2"), {
      kind: HISTORY_SHOW_ATTEMPT_SELECTORS.NUMBER,
      number: 2,
    });
    assert.deepStrictEqual(parseHistoryShowAttempt("latest"), {
      kind: HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST,
    });
    assert.deepStrictEqual(parseHistoryShowAttempt("all"), {
      kind: HISTORY_SHOW_ATTEMPT_SELECTORS.ALL,
    });
    for (const selector of ["", "1-0", "final:0", "final:nope", "-1", "1,,2"]) {
      assert.throws(
        () => parseHistoryShowStep(selector),
        /Invalid --step value/
      );
    }
    for (const selector of ["0", "latestest", "1.5"]) {
      assert.throws(
        () => parseHistoryShowAttempt(selector),
        /Invalid --attempt value/
      );
    }
  });

  test("filters queue attempts, final passes, running, latest, and retries", async () => {
    const key = "release" as WorkflowKey;
    const events = [
      settledAttempt(
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        { attemptIndex: 0 }
      ),
      settledAttempt(
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        { attemptIndex: 1 }
      ),
      settledAttempt({ kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 }),
      settledAttempt({ kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 }),
      {
        ...settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 }),
        unterminated: true,
      },
    ];
    const target: Array<{ stepIndex: number; attemptIndex: number }> = [];
    const finalPasses: number[] = [];
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    const originalFinalLabel = CliTerminalFormatter.renderFinalStepLabel;
    CliTerminalFormatter.renderPromptHeader = ((data) => {
      target.push({
        stepIndex: data.stepIndex,
        attemptIndex: data.attemptIndex,
      });
    }) as typeof originalHeader;
    CliTerminalFormatter.renderFinalStepLabel = ((pass) => {
      finalPasses.push(pass);
    }) as typeof originalFinalLabel;
    const show = async (step?: string, attempt?: string) => {
      target.length = 0;
      finalPasses.length = 0;
      await showHistoryCommand(
        { workflow: key, run: "3", step, attempt },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver(events)
        )
      );
      return { attempts: [...target], finalPasses: [...finalPasses] };
    };
    try {
      assert.deepStrictEqual((await show("0,1")).attempts.length, 3);
      assert.deepStrictEqual((await show("final")).finalPasses, [0, 1]);
      assert.deepStrictEqual((await show("final:1")).finalPasses, [0]);
      assert.deepStrictEqual((await show("final:latest")).finalPasses, [1]);
      assert.deepStrictEqual((await show("running")).attempts, [
        { stepIndex: 1, attemptIndex: 0 },
      ]);
      assert.deepStrictEqual(await show("latest"), {
        attempts: [{ stepIndex: 1, attemptIndex: 0 }],
        finalPasses: [],
      });
      assert.deepStrictEqual((await show("0", "2")).attempts, [
        { stepIndex: 0, attemptIndex: 1 },
      ]);
      assert.deepStrictEqual((await show("0", "latest")).attempts, [
        { stepIndex: 0, attemptIndex: 1 },
      ]);
      assert.deepStrictEqual((await show("0", "all")).attempts, [
        { stepIndex: 0, attemptIndex: 0 },
        { stepIndex: 0, attemptIndex: 1 },
      ]);
    } finally {
      CliTerminalFormatter.renderPromptHeader = originalHeader;
      CliTerminalFormatter.renderFinalStepLabel = originalFinalLabel;
    }
  });

  test("reports pending and skipped steps without rendering run terminations", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-show-pending-step-")
    );
    const key = "release" as WorkflowKey;
    const runRef = "run-2026-09-20T12-00-00-000Z" as RunRef;
    const workingFile = WorkflowPaths.runFilePath(workspaceRoot, key, runRef);
    await fs.mkdir(path.dirname(workingFile), { recursive: true });
    const manager = new TestHistoryManager(
      new Map(),
      new Map([
        [
          key,
          [
            {
              workflowKey: key,
              runRef,
              runDirectory: "/workspace/run-3",
              runId: 3,
              startedAt: 1,
              executionState: EXECUTION_STATES.PAUSED,
              definitionRevision: 1,
              stepCount: 2,
              workingFileStepCount: 2,
              hasFinalStep: true,
              hasMixedHarnesses: false,
              hasMixedModels: false,
            },
          ],
        ],
      ])
    );
    const statuses: string[] = [];
    const originalStatus = CliTerminalFormatter.renderStatusMessage;
    CliTerminalFormatter.renderStatusMessage = ((message) => {
      statuses.push(message);
    }) as typeof originalStatus;
    const pausedEvents: RunOutputResolverAttemptEvent[] = [
      {
        kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED,
        executionState: EXECUTION_STATES.PAUSED,
        stepCount: 1,
      },
      {
        kind: RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED,
        executionState: EXECUTION_STATES.PAUSED,
        stepCount: 1,
      },
    ];
    try {
      await fs.writeFile(workingFile, JSON.stringify({ steps: [{}, {}] }));
      await showHistoryCommand(
        { workflow: key, run: "3", step: "1" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver(pausedEvents),
          undefined,
          workspaceRoot
        )
      );
      assert.deepStrictEqual(statuses, ["Step 2 has not started (pending)"]);

      statuses.length = 0;
      await fs.writeFile(
        workingFile,
        JSON.stringify({
          steps: [{}, { _runtime: { terminalStatus: "skipped" } }],
        })
      );
      await showHistoryCommand(
        { workflow: key, run: "3", step: "1" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver(pausedEvents),
          undefined,
          workspaceRoot
        )
      );
      assert.deepStrictEqual(statuses, ["Step 2 was skipped"]);

      statuses.length = 0;
      await showHistoryCommand(
        { workflow: key, run: "3" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver(pausedEvents),
          undefined,
          workspaceRoot
        )
      );
      assert.deepStrictEqual(statuses, ["Run paused", "Run paused"]);
    } finally {
      CliTerminalFormatter.renderStatusMessage = originalStatus;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("defaults show to latest and uses the working file for header totals and names", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-show-working-file-")
    );
    const key = "release" as WorkflowKey;
    const runRef = "run-2026-09-20T12-00-00-000Z" as RunRef;
    const manager = new TestHistoryManager(
      new Map(),
      new Map([
        [
          key,
          [
            {
              workflowKey: key,
              runRef,
              runDirectory: "/workspace/run-3",
              runId: 3,
              startedAt: 1,
              executionState: EXECUTION_STATES.PAUSED,
              definitionRevision: 1,
              stepCount: 1,
              workingFileStepCount: 3,
              hasFinalStep: true,
              hasMixedHarnesses: false,
              hasMixedModels: false,
            },
          ],
        ],
      ])
    );
    const workingFile = WorkflowPaths.runFilePath(workspaceRoot, key, runRef);
    await fs.mkdir(path.dirname(workingFile), { recursive: true });
    await fs.writeFile(
      workingFile,
      JSON.stringify({
        steps: [
          { prompt: "First" },
          { prompt: "Second" },
          { name: "Appended named step", prompt: "Third" },
        ],
      })
    );
    const headers: Array<{ totalSteps: number; stepName: string }> = [];
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    CliTerminalFormatter.renderPromptHeader = ((data) => {
      headers.push({ totalSteps: data.totalSteps, stepName: data.stepName });
    }) as typeof originalHeader;
    const io = new TestIo();
    try {
      await showHistoryCommand(
        { workflow: key },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([
            settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 }),
          ]),
          undefined,
          workspaceRoot
        )
      );
    } finally {
      CliTerminalFormatter.renderPromptHeader = originalHeader;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
    assert.deepStrictEqual(headers, [
      { totalSteps: 3, stepName: "Appended named step" },
    ]);
    assert.deepStrictEqual(io.errors, [`Run: ${runRef}`]);
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
              hasFinalStep: true,
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

  test("rejects a queue step outside the resolved run's valid range", async () => {
    const key = "release" as WorkflowKey;
    await assert.rejects(
      () =>
        showHistoryCommand(
          { workflow: key, run: "3", step: "2" },
          new TestIo(),
          dependencies(
            new TestLineageRepository([key], new Map(), new Map()),
            historyManagerForShow(key),
            new TestRunOutputResolver([])
          )
        ),
      /Invalid --step index: 2\. This run has 2 steps, so valid zero-based indices are 0 to 1\./
    );
  });

  test("validates steps against the running working file when manifest count is zero", async () => {
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
              executionState: EXECUTION_STATES.RUNNING,
              definitionRevision: 1,
              stepCount: 0,
              workingFileStepCount: 2,
              hasFinalStep: false,
              hasMixedHarnesses: false,
              hasMixedModels: false,
            },
          ],
        ],
      ])
    );

    await showHistoryCommand(
      { workflow: key, run: "3", step: "1" },
      new TestIo(),
      dependencies(
        new TestLineageRepository([key], new Map(), new Map()),
        manager,
        new TestRunOutputResolver([
          settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 }),
        ])
      )
    );
  });

  test("rejects final when the resolved run has no final step", async () => {
    const key = "release" as WorkflowKey;
    const manager = historyManagerForShow(key);
    const summary = (await manager.getRunSummaries(key))[0];
    assert.ok(summary);
    summary.hasFinalStep = false;

    await assert.rejects(
      () =>
        showHistoryCommand(
          { workflow: key, run: "3", step: "final" },
          new TestIo(),
          dependencies(
            new TestLineageRepository([key], new Map(), new Map()),
            manager,
            new TestRunOutputResolver([])
          )
        ),
      /no final step; valid zero-based indices are 0 to 1/
    );
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

suite("CLI history search command", () => {
  test("rewrites throttled TTY progress in place and terminates the line", async () => {
    const io = new TestIo();
    io.isErrTty = true;
    const service = new TestHistorySearchService(searchResponse(), [
      [0, 10],
      [1, 10],
      [3, 10],
      [10, 10],
    ]);
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      await searchHistoryCommand(
        "EPERM",
        { json: true },
        io,
        dependencies(
          new TestLineageRepository([], new Map(), new Map()),
          new TestHistoryManager(new Map(), new Map()),
          undefined,
          service
        )
      );
    } finally {
      Date.now = originalNow;
    }

    assert.deepStrictEqual(io.progress, [
      "\r\x1b[KRebuilding search index (0/10 runs)…",
      "\r\x1b[KRebuilding search index (10/10 runs)…",
      "\n",
    ]);
    assert.deepStrictEqual(io.errors, []);
    assert.strictEqual(io.output.length, 1);
    assert.deepStrictEqual(JSON.parse(io.output[0]), {
      schemaVersion: 1,
      query: "EPERM",
      offset: 0,
      limit: 20,
      deep: false,
      regex: false,
      totalCount: 4,
      countState: "atLeast",
      hasMore: true,
      indexState: "ready",
      results: searchResponse().results,
    });
  });

  test("limits non-TTY progress to a start and elapsed-time completion line", async () => {
    const io = new TestIo();
    const service = new TestHistorySearchService(searchResponse(), [
      [0, 10],
      [1, 10],
      [3, 10],
      [10, 10],
    ]);
    await searchHistoryCommand(
      "EPERM",
      { json: true },
      io,
      dependencies(
        new TestLineageRepository([], new Map(), new Map()),
        new TestHistoryManager(new Map(), new Map()),
        undefined,
        service
      )
    );

    assert.strictEqual(io.errors.length, 2);
    assert.strictEqual(io.errors[0], "Rebuilding search index (10 runs)…");
    assert.match(io.errors[1], /^Search index rebuild completed in \d+ ms\.$/);
    assert.deepStrictEqual(io.progress, []);
    assert.strictEqual(io.output.length, 1);
    assert.doesNotMatch(io.output[0], /Rebuilding search index/);
    assert.doesNotMatch(io.output[0], /completed in/);
    assert.doesNotThrow(() => JSON.parse(io.output[0]));
  });

  test("passes exact-count, deep, regex, cache, and fallback policies to the service", async () => {
    const service = new TestHistorySearchService(searchResponse());
    const io = new TestIo();

    await searchHistoryCommand(
      "EPERM",
      {
        limit: "3",
        offset: "2",
        snippet: "140",
        exactCount: true,
        deep: true,
        regex: true,
        rebuild: false,
        fallback: false,
      },
      io,
      dependencies(
        new TestLineageRepository([], new Map(), new Map()),
        new TestHistoryManager(new Map(), new Map()),
        undefined,
        service
      )
    );

    assert.deepStrictEqual(service.request, {
      query: "EPERM",
      limit: 3,
      offset: 2,
      deep: true,
      regex: true,
      exhaustive: true,
      filters: {},
    });
    assert.deepStrictEqual(service.options, {
      allowRebuild: false,
      allowLegacyFallback: false,
      snippetChars: 140,
    });
  });

  test("finds a past-cap term through the --deep command path", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-history-search-")
    );
    const term = "cli-history-deep-hidden-term";
    const messages: string[] = [];
    const originalInfo = Log.info;

    try {
      await createDeepSearchRun(workspaceRoot, term);
      Log.info = (message: string) => {
        messages.push(message);
      };

      const makeDependencies = (service: HistorySearchCommandService) =>
        dependencies(
          new TestLineageRepository([], new Map(), new Map()),
          new TestHistoryManager(new Map(), new Map()),
          undefined,
          service,
          workspaceRoot
        );

      const shallowIo = new TestIo();
      await searchHistoryCommand(
        term,
        {},
        shallowIo,
        makeDependencies(new HistorySearchService())
      );

      assert.strictEqual(
        shallowIo.output[0]?.startsWith("0 of 0 results"),
        true
      );
      assert.match(
        shallowIo.output.join("\n"),
        /use --deep for terms later in long output/
      );

      const deepIo = new TestIo();
      await searchHistoryCommand(
        term,
        { deep: true },
        deepIo,
        makeDependencies(new HistorySearchService())
      );

      assert.match(deepIo.output[0] ?? "", /^1 of 1 results/);
      assert.match(deepIo.output.join("\n"), /cli-history-deep-hidden-term/);
      assert.ok(
        messages.some(
          (message) =>
            message.includes("deep=true") &&
            message.includes("deepScannedRuns=1")
        ),
        messages.join("\n")
      );
    } finally {
      Log.info = originalInfo;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("uses regex matching when the pattern is not a literal substring", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-history-search-regex-")
    );
    const term = "cli-history-regex-hidden-term";

    try {
      await createDeepSearchRun(workspaceRoot, term);
      const io = new TestIo();
      await searchHistoryCommand(
        "cli-history-regex-.*-term",
        { deep: true, regex: true },
        io,
        dependencies(
          new TestLineageRepository([], new Map(), new Map()),
          new TestHistoryManager(new Map(), new Map()),
          undefined,
          new HistorySearchService(),
          workspaceRoot
        )
      );

      assert.match(io.output[0] ?? "", /^1 of 1 results/);
      assert.match(io.output.join("\n"), /case-insensitive regex search/);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports invalid regex patterns with the pattern and parse failure", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-history-search-invalid-regex-")
    );

    try {
      await assert.rejects(
        () =>
          searchHistoryCommand(
            "[a",
            { regex: true },
            new TestIo(),
            dependencies(
              new TestLineageRepository([], new Map(), new Map()),
              new TestHistoryManager(new Map(), new Map()),
              undefined,
              new HistorySearchService(),
              workspaceRoot
            )
          ),
        (error: unknown) => {
          assert.match(
            error instanceof Error ? error.message : String(error),
            /Invalid history search pattern.*\[.*unterminated|Invalid history search pattern.*\[.*Unterminated/i
          );
          return true;
        }
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("derives --this-workflow from CTRLYOKE_WORKING_FILE", async () => {
    const service = new TestHistorySearchService(searchResponse());
    const originalWorkingFile = process.env.CTRLYOKE_WORKING_FILE;
    process.env.CTRLYOKE_WORKING_FILE = path.join(
      "/workspace",
      "release",
      "run-2026-09-20T12-00-00-000Z",
      "workflow.ctrlyoke.json"
    );
    try {
      await searchHistoryCommand(
        "EPERM",
        { thisWorkflow: true },
        new TestIo(),
        dependencies(
          new TestLineageRepository([], new Map(), new Map()),
          new TestHistoryManager(new Map(), new Map()),
          undefined,
          service
        )
      );
    } finally {
      if (originalWorkingFile === undefined) {
        delete process.env.CTRLYOKE_WORKING_FILE;
      } else {
        process.env.CTRLYOKE_WORKING_FILE = originalWorkingFile;
      }
    }

    assert.deepStrictEqual(service.request, {
      query: "EPERM",
      limit: 20,
      offset: 0,
      deep: false,
      regex: false,
      exhaustive: false,
      filters: { workflowKeys: ["release"] },
    });
  });

  test("rejects invalid taxonomy values and missing --this-workflow context", async () => {
    const command = (options: HistorySearchOptions) =>
      searchHistoryCommand(
        "EPERM",
        options,
        new TestIo(),
        dependencies(
          new TestLineageRepository([], new Map(), new Map()),
          new TestHistoryManager(new Map(), new Map()),
          undefined,
          new TestHistorySearchService(searchResponse())
        )
      );

    await assert.rejects(command({ kind: ["not-a-kind"] }), /Valid values: /);
    await assert.rejects(
      command({ harness: ["not-a-harness"] }),
      /Valid values: /
    );
    await assert.rejects(command({ state: ["not-a-state"] }), /Valid values: /);

    const originalWorkingFile = process.env.CTRLYOKE_WORKING_FILE;
    delete process.env.CTRLYOKE_WORKING_FILE;
    try {
      await assert.rejects(
        command({ thisWorkflow: true }),
        /CTRLYOKE_WORKING_FILE to be set/
      );
    } finally {
      if (originalWorkingFile !== undefined) {
        process.env.CTRLYOKE_WORKING_FILE = originalWorkingFile;
      }
    }
  });

  test("renders selector lines for queue and final-step targets", async () => {
    const io = new TestIo();
    await searchHistoryCommand(
      "EPERM",
      {},
      io,
      dependencies(
        new TestLineageRepository([], new Map(), new Map()),
        new TestHistoryManager(new Map(), new Map()),
        undefined,
        new TestHistorySearchService(searchResponse())
      )
    );

    const output = io.output.join("\n");
    assert.match(output, /--workflow release --run run-queue --step 2/);
    assert.match(output, /--workflow release --run run-final --step final/);
    assert.match(output, /one matching event or field, not one occurrence/);
    assert.match(output, /lower bound/);
    assert.match(output, /--deep/);
    assert.match(output, /case-insensitive substring search/);
    assert.match(output, /history show/);
  });

  test("emits one redacted JSON result blob with the response states verbatim", async () => {
    const io = new TestIo();
    await searchHistoryCommand(
      "EPERM",
      { json: true },
      io,
      dependencies(
        new TestLineageRepository([], new Map(), new Map()),
        new TestHistoryManager(new Map(), new Map()),
        undefined,
        new TestHistorySearchService(searchResponse())
      )
    );

    assert.strictEqual(io.output.length, 1);
    assert.deepStrictEqual(JSON.parse(io.output[0]), {
      schemaVersion: 1,
      query: "EPERM",
      offset: 0,
      limit: 20,
      deep: false,
      regex: false,
      totalCount: 4,
      countState: "atLeast",
      hasMore: true,
      indexState: "ready",
      results: searchResponse().results,
    });
  });

  test("discloses regex mode in JSON output", async () => {
    const io = new TestIo();
    await searchHistoryCommand(
      "EP.*RM",
      { json: true, regex: true },
      io,
      dependencies(
        new TestLineageRepository([], new Map(), new Map()),
        new TestHistoryManager(new Map(), new Map()),
        undefined,
        new TestHistorySearchService(searchResponse())
      )
    );

    assert.strictEqual(JSON.parse(io.output[0]).regex, true);
    assert.strictEqual(JSON.parse(io.output[0]).schemaVersion, 1);
  });

  test("parses relative history times", async () => {
    const now = 1_700_000_000_000;
    const service = new TestHistorySearchService(searchResponse());
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      await searchHistoryCommand(
        "EPERM",
        { since: "7d", until: "2026-09-20T00:00:00.000Z" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([], new Map(), new Map()),
          new TestHistoryManager(new Map(), new Map()),
          undefined,
          service
        )
      );
    } finally {
      Date.now = originalNow;
    }

    const request = service.request as HistorySearchQuery;
    assert.strictEqual(request.filters?.since, now - 7 * 86_400_000);
    assert.strictEqual(
      request.filters?.until,
      Date.parse("2026-09-20T00:00:00.000Z")
    );
  });

  test("keeps the rebuild worker beside the CLI bundle", () => {
    assert.strictEqual(
      existsSync(
        path.resolve(__dirname, "../../historySearchRebuildWorker.js")
      ),
      true
    );
  });
});

function searchResponse(): HistorySearchResponse {
  return {
    query: "EPERM",
    offset: 0,
    totalCount: 4,
    countState: "atLeast",
    hasMore: true,
    indexState: "ready",
    results: [
      {
        workflowKey: "release" as WorkflowKey,
        runRef: "run-queue" as RunRef,
        workflowName: "Release",
        runId: 4,
        startedAt: 1_700_000_000_000,
        executionState: EXECUTION_STATES.COMPLETED,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 },
        eventKind: HISTORY_EVENT_KINDS.BASH,
        matchField: HISTORY_MATCH_FIELDS.OUTPUT,
        matchSnippet: "rename raised EPERM",
        matchContext: "Prompt 3",
      },
      {
        workflowKey: "release" as WorkflowKey,
        runRef: "run-final" as RunRef,
        workflowName: "Release",
        runId: 3,
        startedAt: 1_699_000_000_000,
        executionState: EXECUTION_STATES.ERROR,
        target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
        eventKind: HISTORY_EVENT_KINDS.RESPONSE,
        matchField: HISTORY_MATCH_FIELDS.RESPONSE,
        matchSnippet: "EPERM was handled",
        matchContext: "Final Step",
      },
    ],
  };
}

async function createDeepSearchRun(
  workspaceRoot: string,
  term: string
): Promise<void> {
  const workflowKey = "cli-history-deep-workflow" as WorkflowKey;
  const startedAt = 1_800_000_000_000;
  const runRef = WorkflowPaths.formatRunRef(startedAt);
  const runDirectory = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
  const recorder = new TimelineRecorder();
  const manifestPath = await recorder.initializeRunAt(
    runDirectory,
    workflowKey,
    1,
    startedAt,
    EXECUTION_STATES.COMPLETED
  );

  await recorder.appendEvents(manifestPath, [
    {
      eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
      timestampMs: startedAt + 1,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      payload: {
        cliOutput: {
          prompt: "prompt",
          response: `${"x".repeat(MAX_INDEXED_TEXT_LENGTH + 100)}${term}`,
          elapsed: 1,
          isStreaming: false,
        },
      },
    },
  ]);
}

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
            hasFinalStep: true,
            hasMixedHarnesses: false,
            hasMixedModels: false,
          },
        ],
      ],
    ])
  );
}
