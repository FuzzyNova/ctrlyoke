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
  SCRIPT_OUTPUT_SOURCES,
  HISTORY_SEARCH_INDEX_STATES,
  CLI_EVENT_TYPES,
} from "../../types/DashboardConstants";
import type { CliEvent, UniversalCliOutput } from "../../types/CliOutputTypes";
import { SCRIPT_EVENT_KIND_BY_SOURCE } from "../../core/orchestration/HistoryCandidateExtractor";
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
import { RunOutputResolver } from "../../core/orchestration/RunOutputResolver";
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
  READ_OUTPUT_PAGING_WORDING,
} from "../../core/orchestration/OutputTextPaging";
import { MAX_INDEXED_TEXT_LENGTH } from "../../core/orchestration/HistorySearchIndexService";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { Log } from "../../utils/Log";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  resolveCliWorkflowKey,
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

  async listRunRefs(
    _workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<RunRef[]> {
    const latestRunRef = this.descriptors.get(workflowKey)?.latestRunRef;
    return latestRunRef ? [latestRunRef] : [];
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
  lifecycleReads = 0;
  attemptReads = 0;

  /**
   * Without explicit lifecycle events, the lifecycle stream is derived from
   * the settled attempts the way the real timeline records them: one start
   * per attempt, and a termination unless the attempt is unterminated.
   */
  constructor(
    private readonly events: RunOutputResolverAttemptEvent[],
    private readonly lifecycleEvents?: RunAttemptLifecycleEvent[]
  ) {}

  async *streamAttempts(
    _manifestPath: string
  ): AsyncGenerator<RunOutputResolverAttemptEvent, void, undefined> {
    this.attemptReads++;
    yield* this.events;
  }

  async *streamAttemptLifecycle(): AsyncGenerator<
    RunAttemptLifecycleEvent,
    void,
    undefined
  > {
    this.lifecycleReads++;
    if (this.lifecycleEvents) {
      yield* this.lifecycleEvents;
      return;
    }
    for (const event of this.events) {
      if (event.kind !== RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
        continue;
      }
      const { target, runIndex, attemptIndex, phase } = event.attempt;
      const identity = {
        target,
        runIndex,
        attemptIndex,
        ...(phase !== undefined ? { phase } : {}),
      };
      yield {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        ...identity,
        timestampMs: 1_000,
        attemptKind: event.attempt.kind ?? "ai",
      };
      if (!event.unterminated) {
        yield {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
          ...identity,
          timestampMs: 2_000,
          terminalState: event.attempt.terminalState ?? "completed",
        };
      }
    }
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

function structuredEvents(events: CliEvent[]): UniversalCliOutput {
  return { events, metadata: {} };
}

function lifecycleStarted(
  target: OutputExecutionTarget,
  overrides: Partial<
    Extract<
      RunAttemptLifecycleEvent,
      { eventType: typeof TIMELINE_EVENT_TYPES.ATTEMPT_STARTED }
    >
  > = {}
): RunAttemptLifecycleEvent {
  return {
    eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
    target,
    runIndex: 0,
    attemptIndex: 0,
    timestampMs: 1_000,
    attemptKind: "ai",
    ...overrides,
  };
}

function lifecycleTerminated(
  target: OutputExecutionTarget,
  overrides: Partial<
    Extract<
      RunAttemptLifecycleEvent,
      { eventType: typeof TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED }
    >
  > = {}
): RunAttemptLifecycleEvent {
  return {
    eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
    target,
    runIndex: 0,
    attemptIndex: 0,
    timestampMs: 2_000,
    terminalState: "completed",
    ...overrides,
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
    const paging = parseOutputTextPaging({ limit: 3 }, 1)!;
    assert.deepStrictEqual(pageOutputText("AB😀CD", paging), {
      text: "AB",
      nextCursor: "2",
    });
    assert.deepStrictEqual(
      pageOutputText("AB😀CD", parseOutputTextPaging({ cursor: "3" }, 1)!),
      { text: "CD" }
    );
  });

  test("keeps MCP read_output paging errors byte-identical", () => {
    // These strings are part of the MCP tool contract; the CLI's wording is
    // supplied separately and must never leak into them.
    for (const wording of [undefined, READ_OUTPUT_PAGING_WORDING]) {
      assert.throws(
        () => parseOutputTextPaging({ tail: 2, limit: 1 }, 1, wording),
        {
          message:
            "read_output: tail is mutually exclusive with cursor and limit",
        }
      );
      assert.throws(() => parseOutputTextPaging({ limit: 2 }, 2, wording), {
        message:
          "read_output: cursor, limit, and tail require indices to name exactly one step",
      });
      assert.throws(() => parseOutputTextPaging({ cursor: "x" }, 1, wording), {
        message:
          "read_output: cursor must be a non-negative integer cursor returned by read_output",
      });
      assert.throws(() => parseOutputTextPaging({ limit: 0 }, 1, wording), {
        message: "read_output: limit must be a positive integer",
      });
      assert.throws(() => parseOutputTextPaging({ tail: -1 }, 1, wording), {
        message: "read_output: tail must be a non-negative integer",
      });
    }
  });

  test("names CLI flags and history show in its paging errors", async () => {
    const key = "release" as WorkflowKey;
    await assert.rejects(
      showHistoryCommand(
        { workflow: key, run: "3", step: "0", cursor: "x" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([])
        )
      ),
      {
        message:
          "history show: --cursor must be a non-negative integer cursor returned by history show",
      }
    );
    await assert.rejects(
      showHistoryCommand(
        { workflow: key, run: "3", step: "0", tail: "3", limit: "4" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([])
        )
      ),
      {
        message:
          "history show: --tail is mutually exclusive with --cursor and --limit",
      }
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
                // Over an hour, so the text ELAPSED column renders hours.
                elapsed: 3725,
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
            },
          },
          _runtime: {
            executionState: EXECUTION_STATES.PAUSED,
            currentIndex: 1,
            finalStep: {
              phase: FINAL_STEP_PHASES.FINAL_STEP,
              loopCount: 2,
              status: "completed",
            },
          },
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
      const step0 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
      const step1 = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
      const pass1 = {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: 0,
      } as const;
      const pass2 = {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: 1,
      } as const;
      const resolver = new TestRunOutputResolver(
        [],
        [
          // A pre-condition and an end-condition share the AI attempt
          // indices; neither is an attempt of the step.
          lifecycleStarted(step0, {
            attemptKind: "condition",
            phase: "preCondition",
          }),
          lifecycleTerminated(step0, { phase: "preCondition" }),
          lifecycleStarted(step0),
          lifecycleTerminated(step0, { terminalState: "failed" }),
          lifecycleStarted(step0, {
            attemptKind: "condition",
            phase: "endCondition",
          }),
          lifecycleTerminated(step0, { phase: "endCondition" }),
          lifecycleStarted(step0, { attemptIndex: 1 }),
          lifecycleTerminated(step0, { attemptIndex: 1 }),
          lifecycleStarted(step1),
          lifecycleStarted(pass1, { timestampMs: 10_000 }),
          lifecycleTerminated(pass1, { timestampMs: 14_500 }),
          lifecycleStarted(pass2, { timestampMs: 20_000 }),
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
          name: string | null;
          state: string;
          harness: string | null;
          attempts: number;
          prompt: string;
          elapsedSeconds: number | null;
          next?: true;
        }>;
        finalStep: {
          elapsedSeconds: number | null;
          nextPass: number | null;
          passes: Array<{ elapsedSeconds: number | null }>;
        };
      };
      assert.strictEqual(value.runRef, runRef);
      assert.deepStrictEqual(
        value.steps.map((step) => step.selector),
        ["0", "1", "2"]
      );
      assert.strictEqual(value.steps[0].attempts, 2);
      assert.strictEqual(value.steps[0].elapsedSeconds, 3725);
      assert.strictEqual(
        value.steps[1].name,
        "Appended step with no definition snapshot"
      );
      assert.strictEqual(value.steps[1].state, "running");
      assert.strictEqual(value.steps[1].next, true);
      assert.strictEqual(value.steps[1].attempts, 1);
      assert.strictEqual(value.steps[2].state, "pending");
      assert.strictEqual(value.steps[2].name, null);
      assert.strictEqual(value.steps[2].harness, null);
      assert.strictEqual(value.steps[2].elapsedSeconds, null);
      assert.strictEqual(value.steps[0].prompt, "First line");
      assert.deepStrictEqual(value.finalStep, {
        selector: "final",
        name: "review",
        state: "completed",
        harness: "claude-cli",
        model: "opus",
        elapsedSeconds: 4.5,
        nextPass: null,
        passes: [
          {
            selector: "final:1",
            pass: 1,
            state: "completed",
            attempts: 1,
            startedAt: 10_000,
            completedAt: 14_500,
            elapsedSeconds: 4.5,
          },
          {
            selector: "final:2",
            pass: 2,
            state: "running",
            attempts: 1,
            startedAt: 20_000,
            completedAt: null,
            elapsedSeconds: null,
          },
        ],
        prompt: "Review all changes",
      });

      const textIo = new TestIo();
      await stepsHistoryCommand(
        { workflow: key },
        textIo,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          resolver,
          undefined,
          workspaceRoot
        )
      );
      const [header, ...rows] = textIo.output;
      assert.match(header, /^# +NAME +STATE +HARNESS/);
      // Columns line up: every row STATE starts where the header STATE does.
      const stateColumn = header.indexOf("STATE");
      for (const row of rows) {
        assert.match(row.slice(stateColumn), /^(completed|running|pending) /);
      }
      assert.match(rows[0], / 1h2m /);
      assert.match(rows[3], / 5s /);
      assert.match(rows[2], /^2 +— +pending/);
      assert.match(rows[1], /running \(next\)/);
      assert.match(rows[3], /^final +review +completed .* 2 passes +Review/);

      await fs.writeFile(
        workingFile,
        JSON.stringify({
          steps: [{ prompt: "Queue" }],
          finalStep: { name: "review", prompt: "Review" },
          _runtime: {
            executionState: EXECUTION_STATES.PAUSED,
            currentIndex: 1,
          },
        })
      );
      const pendingIo = new TestIo();
      await stepsHistoryCommand(
        { workflow: key, json: true },
        pendingIo,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([], []),
          undefined,
          workspaceRoot
        )
      );
      const pendingValue = JSON.parse(pendingIo.output[0]) as {
        finalStep: { state: string; nextPass: number | null };
      };
      assert.strictEqual(pendingValue.finalStep.state, "pending");
      assert.strictEqual(pendingValue.finalStep.nextPass, 1);
      const pendingTextIo = new TestIo();
      await stepsHistoryCommand(
        { workflow: key },
        pendingTextIo,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([], []),
          undefined,
          workspaceRoot
        )
      );
      // The "(next)" marker matches queue rows and appears once per row;
      // the pass number stays explicit in --json as nextPass.
      assert.match(
        pendingTextIo.output[2],
        /^final +review +pending \(next\) /
      );
      assert.match(pendingTextIo.output[2], / 0 passes /);
      assert.doesNotMatch(pendingTextIo.output[2], /1 next/);

      await fs.writeFile(
        workingFile,
        JSON.stringify({
          steps: [{ prompt: "Queue" }],
          finalStep: {
            name: "review",
            prompt: "Review",
            _runtime: { startedAt: 30_000 },
          },
          _runtime: {
            executionState: EXECUTION_STATES.RUNNING,
            currentIndex: 1,
          },
        })
      );
      const runningPassIo = new TestIo();
      await stepsHistoryCommand(
        { workflow: key, json: true },
        runningPassIo,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver(
            [],
            [
              lifecycleStarted(
                { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 2 },
                { timestampMs: 30_000 }
              ),
            ]
          ),
          undefined,
          workspaceRoot
        )
      );
      const runningPassValue = JSON.parse(runningPassIo.output[0]) as {
        finalStep: {
          state: string;
          nextPass: number | null;
          passes: Array<{ state: string }>;
        };
      };
      assert.strictEqual(runningPassValue.finalStep.state, "running");
      assert.strictEqual(runningPassValue.finalStep.nextPass, null);
      assert.strictEqual(runningPassValue.finalStep.passes[0].state, "running");

      const runningPassTextIo = new TestIo();
      await stepsHistoryCommand(
        { workflow: key },
        runningPassTextIo,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver(
            [],
            [
              lifecycleStarted(
                { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 2 },
                { timestampMs: 30_000 }
              ),
            ]
          ),
          undefined,
          workspaceRoot
        )
      );
      assert.match(runningPassTextIo.output[2], /^final +review +running /);
      assert.doesNotMatch(runningPassTextIo.output[2], /\(next\)/);

      await fs.writeFile(
        workingFile,
        JSON.stringify({
          steps: [{ prompt: "Queue" }],
          finalStep: { name: "review", prompt: "Review" },
          _runtime: {
            executionState: EXECUTION_STATES.COMPLETED,
            finalStep: {
              phase: FINAL_STEP_PHASES.FINAL_STEP,
              loopCount: 1,
              status: "completed",
            },
          },
        })
      );
      const rootRuntimeIo = new TestIo();
      await stepsHistoryCommand(
        { workflow: key, json: true },
        rootRuntimeIo,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([], []),
          undefined,
          workspaceRoot
        )
      );
      const rootRuntimeValue = JSON.parse(rootRuntimeIo.output[0]) as {
        finalStep: { state: string; passes: unknown[] };
      };
      assert.strictEqual(rootRuntimeValue.finalStep.state, "completed");
      assert.deepStrictEqual(rootRuntimeValue.finalStep.passes, []);
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

  test("keeps history steps JSON bounded by the working file when output is large", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-steps-size-")
    );
    const key = "release" as WorkflowKey;
    const runRef = "run-2026-09-29T10-00-00-000Z" as RunRef;
    const workingFile = WorkflowPaths.runFilePath(workspaceRoot, key, runRef);
    const eventsFile = WorkflowPaths.eventsPath(workspaceRoot, key, runRef);
    try {
      await fs.mkdir(path.dirname(workingFile), { recursive: true });
      await fs.writeFile(
        workingFile,
        JSON.stringify({ steps: [{ name: "Inspect", prompt: "Review" }] })
      );
      const largeOutput = "output payload ".repeat(70_000);
      const recorder = new TimelineRecorder();
      const manifestPath = await recorder.initializeRunAt(
        path.dirname(workingFile),
        key,
        3,
        1,
        EXECUTION_STATES.COMPLETED
      );
      const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
      await recorder.appendEvents(manifestPath, [
        {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
          timestampMs: 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          payload: { kind: "ai", startReason: "initial", prompt: "Review" },
        },
        {
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
          timestampMs: 2,
          target,
          runIndex: 0,
          attemptIndex: 0,
          definitionRevision: 1,
          responseKind: "ai",
          payload: {
            cliOutput: {

              structured: { events: [{ type: "text", data: { text: largeOutput } }], metadata: {} },
              elapsed: 1,
              isStreaming: false,
            },
          },
        },
      ]);
      const workingBytes = (await fs.stat(workingFile)).size;
      const eventsBytes = (await fs.stat(eventsFile)).size;
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
                startedAt: 1,
                executionState: EXECUTION_STATES.COMPLETED,
                definitionRevision: 1,
                stepCount: 1,
                workingFileStepCount: 1,
                hasFinalStep: false,
                hasMixedHarnesses: false,
                hasMixedModels: false,
              },
            ],
          ],
        ])
      );
      const io = new TestIo();
      await stepsHistoryCommand(
        { workflow: key, json: true },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new RunOutputResolver(),
          undefined,
          workspaceRoot
        )
      );
      assert.ok(eventsBytes > workingBytes * 100);
      assert.ok(Buffer.byteLength(io.output[0]) < workingBytes + 512);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("counts only step attempts from a recorded timeline with condition scripts", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-steps-conditions-")
    );
    const key = "release" as WorkflowKey;
    const runRef = "run-2026-09-29T10-00-00-000Z" as RunRef;
    const workingFile = WorkflowPaths.runFilePath(workspaceRoot, key, runRef);
    try {
      await fs.mkdir(path.dirname(workingFile), { recursive: true });
      await fs.writeFile(
        workingFile,
        JSON.stringify({ steps: [{ name: "Guarded", prompt: "Say hi" }] })
      );
      const recorder = new TimelineRecorder();
      const manifestPath = await recorder.initializeRunAt(
        path.dirname(workingFile),
        key,
        3,
        1,
        EXECUTION_STATES.COMPLETED
      );
      const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
      const attempt = (
        sequence: number,
        kind: "ai" | "condition",
        phase?: "preCondition" | "endCondition"
      ) => [
        {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
          timestampMs: sequence,
          target,
          runIndex: 0,
          attemptIndex: 0,
          ...(phase ? { phase } : {}),
          definitionRevision: 1,
          payload: { kind, startReason: "initial" as const, prompt: "p" },
        },
        {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
          timestampMs: sequence + 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          ...(phase ? { phase } : {}),
          definitionRevision: 1,
          payload: { terminalState: "completed" as const },
        },
      ];
      await recorder.appendEvents(manifestPath, [
        ...attempt(10, "condition", "preCondition"),
        ...attempt(20, "ai"),
        ...attempt(30, "condition", "endCondition"),
      ]);
      const lifecycle: RunAttemptLifecycleEvent[] = [];
      for await (const event of new RunOutputResolver().streamAttemptLifecycle(
        manifestPath
      )) {
        lifecycle.push(event);
      }
      assert.deepStrictEqual(
        lifecycle
          .filter(
            (event) => event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED
          )
          .map((event) => [
            event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED
              ? event.attemptKind
              : undefined,
            event.phase,
          ]),
        [
          ["condition", "preCondition"],
          ["ai", undefined],
          ["condition", "endCondition"],
        ]
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
                startedAt: 1,
                executionState: EXECUTION_STATES.COMPLETED,
                definitionRevision: 1,
                stepCount: 1,
                workingFileStepCount: 1,
                hasFinalStep: false,
                hasMixedHarnesses: false,
                hasMixedModels: false,
              },
            ],
          ],
        ])
      );
      const io = new TestIo();
      await stepsHistoryCommand(
        { workflow: key, json: true },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new RunOutputResolver(),
          undefined,
          workspaceRoot
        )
      );
      const value = JSON.parse(io.output[0]) as {
        steps: Array<{ attempts: number }>;
      };
      assert.strictEqual(value.steps[0].attempts, 1);
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

  test("caps history list names in text while preserving full JSON names", async () => {
    const key = "release" as WorkflowKey;
    const longName = "A".repeat(70);
    const repository = new TestLineageRepository(
      [key],
      new Map([[key, descriptor(key)]]),
      new Map([[key, longName]])
    );
    const dependenciesForList = dependencies(
      repository,
      new TestHistoryManager(new Map(), new Map())
    );
    const textIo = new TestIo();
    await listHistoryCommand({}, textIo, dependenciesForList);
    const nameCell = textIo.output[1].split(/\s{2,}/)[1];
    assert.strictEqual(nameCell.length, 48);
    assert.ok(nameCell.endsWith("…"));

    const jsonIo = new TestIo();
    await listHistoryCommand({ json: true }, jsonIo, dependenciesForList);
    const [row] = JSON.parse(jsonIo.output[0]) as Array<{
      workflowName: string;
    }>;
    assert.strictEqual(row.workflowName, longName);
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
    // Neither lineage has run, so the default latest-run order falls back
    // to the workflow key.
    assert.deepStrictEqual(
      rows.map((row) => row.workflowName),
      ["System workflow", "User workflow"]
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

  test("an exact lineage key wins over another lineage's matching name", async () => {
    const exactKey = "Release" as WorkflowKey;
    const otherKey = "release-2026-09-20T12-00-00-000Z" as WorkflowKey;
    const repository = new TestLineageRepository(
      [exactKey, otherKey],
      new Map([
        [exactKey, descriptor(exactKey, { workflowName: "Other" })],
        [otherKey, descriptor(otherKey, { workflowName: "Release" })],
      ]),
      new Map()
    );
    const errors: string[] = [];

    assert.strictEqual(
      await resolveCliWorkflowKey(
        "/workspace",
        repository,
        "Release",
        (message) => errors.push(message)
      ),
      exactKey
    );
    assert.deepStrictEqual(errors, []);
  });

  test("resolves a unique exact case-insensitive name with JSON stdout clean", async () => {
    const key = "release-2026-09-20T12-00-00-000Z" as WorkflowKey;
    const summary: RunSummary = {
      workflowKey: key,
      runRef: "run-2026-09-20T12-00-00-000Z" as RunRef,
      runDirectory: "/workspace/run",
      runId: 1,
      startedAt: 1_700_000_000_000,
      executionState: EXECUTION_STATES.COMPLETED,
      definitionRevision: 1,
      stepCount: 1,
      hasMixedHarnesses: false,
      hasMixedModels: false,
    };
    const manager = new TestHistoryManager(
      new Map(),
      new Map([[key, [summary]]])
    );
    const repository = new TestLineageRepository(
      [key],
      new Map([[key, descriptor(key, { workflowName: "Release Plan" })]]),
      new Map()
    );
    const io = new TestIo();

    await runsHistoryCommand(
      { workflow: "rElEaSe PlAn", json: true },
      io,
      dependencies(repository, manager)
    );

    assert.deepStrictEqual(JSON.parse(io.output[0]), [summary]);
    assert.deepStrictEqual(io.errors, [`Using lineage ${key}`]);
    assert.deepStrictEqual(manager.runSummaryCalls, [key]);
  });

  test("rejects an ambiguous name with each key and latest run date", async () => {
    const older = "release-2026-09-19T12-00-00-000Z" as WorkflowKey;
    const newer = "release-2026-09-20T12-00-00-000Z" as WorkflowKey;
    const repository = new TestLineageRepository(
      [older, newer],
      new Map([
        [
          older,
          descriptor(older, {
            workflowName: "Release",
            latestRunRef: "run-2026-09-19T12-00-00-000Z" as RunRef,
          }),
        ],
        [
          newer,
          descriptor(newer, {
            workflowName: "release",
            latestRunRef: "run-2026-09-20T12-00-00-000Z" as RunRef,
          }),
        ],
      ]),
      new Map()
    );

    await assert.rejects(
      resolveCliWorkflowKey("/workspace", repository, "RELEASE", () => {}),
      (error: Error) => {
        assert.match(error.message, new RegExp(`${older}.*2026-09-19`));
        assert.match(error.message, new RegExp(`${newer}.*2026-09-20`));
        return true;
      }
    );
  });

  test("keeps the not-found error and suggests history list", async () => {
    const key = "known" as WorkflowKey;
    await assert.rejects(
      resolveCliWorkflowKey(
        "/workspace",
        new TestLineageRepository([key], new Map(), new Map()),
        "missing",
        () => {}
      ),
      /Workflow lineage "missing" was not found\. Run `ctrlyoke history list` to find a lineage key\./
    );
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
    // Parts are trimmed like `step reorder`, and duplicates are counted once
    // against the size cap.
    assert.deepStrictEqual(parseHistoryShowStep(" 3, 4 ,3-4"), {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndices: [3, 4],
    });
    assert.strictEqual(
      parseHistoryShowStep("0-9999,0-9999")?.kind,
      FINAL_STEP_PHASES.QUEUE
    );
    assert.throws(() => parseHistoryShowStep("0-10000"), {
      message:
        'Invalid --step value "0-10000"; the selection is too large (more than 10000 distinct step indices)',
    });
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
      assert.deepStrictEqual(statuses, ["--step 1 has not started (pending)"]);

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
      assert.deepStrictEqual(statuses, ["--step 1 was skipped"]);

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

  test("omits queue position from final-step attempt headers", async () => {
    const key = "release" as WorkflowKey;
    const manager = historyManagerForShow(key);
    const headers: Array<{
      stepIndex: number;
      includeStepPosition?: boolean;
    }> = [];
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    CliTerminalFormatter.renderPromptHeader = ((data) => {
      headers.push({
        stepIndex: data.stepIndex,
        includeStepPosition: data.includeStepPosition,
      });
    }) as typeof originalHeader;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          manager,
          new TestRunOutputResolver([
            settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }),
            settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 }),
            settledAttempt({
              kind: FINAL_STEP_PHASES.FINAL_STEP,
              loopIndex: 0,
            }),
          ])
        )
      );
    } finally {
      CliTerminalFormatter.renderPromptHeader = originalHeader;
    }

    assert.deepStrictEqual(headers, [
      { stepIndex: 0, includeStepPosition: true },
      { stepIndex: 1, includeStepPosition: true },
      { stepIndex: 0, includeStepPosition: false },
    ]);
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

  test("slims default JSON and supports summary and per-event projections", async () => {
    const key = "release" as WorkflowKey;
    const attempt = settledAttempt(
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        runIndex: 2,
        attemptIndex: 1,
        prompt: "the prompt",
        definition: {
          definitionRevision: 7,
          definition: {
            steps: [{ prompt: "large workflow snapshot" }],
          } as never,
          step: { prompt: "the attempt step" } as never,
        },
        output: {
          response: "the answer",
          elapsed: 2,
          timestampMs: 123,
          tokens: { prompt: 4, completion: 5, total: 9 },
          isStreaming: false,
          structured: {
            events: [
              { type: "text", data: { text: "the complete answer" } },
              { type: "toolCall", data: { toolName: "Read" } },
            ],
          } as never,
        },
      }
    );
    const run = async (options: Omit<HistoryShowOptions, "workflow">) => {
      const io = new TestIo();
      await showHistoryCommand(
        { workflow: key, run: "3", json: true, ...options },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([attempt])
        )
      );
      return io.output.map((line) => JSON.parse(line));
    };

    const [full] = await run({});
    assert.strictEqual(full.definitionRevision, 7);
    assert.deepStrictEqual(full.definition, {
      step: { prompt: "the attempt step" },
    });
    assert.strictEqual("steps" in full.definition, false);
    // Each text appears once: top-level prompt/responseText, no output copies.
    assert.strictEqual(full.prompt, "the prompt");
    assert.strictEqual(full.responseText, "the complete answer");
    assert.strictEqual("prompt" in full.output, false);
    assert.strictEqual("response" in full.output, false);
    assert.strictEqual(full.output.structured.events.length, 2);

    const [unpaged] = await run({ summary: true });
    assert.strictEqual(unpaged.prompt, "the prompt");
    assert.strictEqual(unpaged.responseText, "the complete answer");
    assert.strictEqual("nextCursor" in unpaged, false);

    // A page is bounded by --limit, so it carries the page and a cursor but
    // not the unpaged prompt.
    const [summary] = await run({ summary: true, limit: "4" });
    assert.deepStrictEqual(summary, {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 2,
      attemptIndex: 1,
      state: "completed",
      timings: { elapsed: 2, timestampMs: 123 },
      tokens: { prompt: 4, completion: 5, total: 9 },
      responseText: "the ",
      nextCursor: "4",
    });

    const events = await run({ events: true });
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(
      events.map(({ event }) => event.type),
      ["text", "toolCall"]
    );
    assert.ok(events.every(({ target }) => target.stepIndex === 0));
  });

  test("requires JSON and disallows combining history show projections", async () => {
    const key = "release" as WorkflowKey;
    const invoke = (options: Omit<HistoryShowOptions, "workflow">) =>
      showHistoryCommand(
        { workflow: key, run: "3", ...options },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([])
        )
      );
    await assert.rejects(() => invoke({ summary: true }), /require --json/);
    await assert.rejects(
      () => invoke({ json: true, summary: true, events: true }),
      /mutually exclusive/
    );
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
  test("reports each unrendered index of a --step list on its own line", async () => {
    const key = "release" as WorkflowKey;
    const statuses: string[] = [];
    const originalStatus = CliTerminalFormatter.renderStatusMessage;
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    const headers: Array<string | undefined> = [];
    CliTerminalFormatter.renderStatusMessage = ((message) => {
      statuses.push(message);
    }) as typeof originalStatus;
    CliTerminalFormatter.renderPromptHeader = ((data) => {
      headers.push(data.stepSelector);
    }) as typeof originalHeader;
    const resolver = new TestRunOutputResolver([
      settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }),
    ]);
    const deps = dependencies(
      new TestLineageRepository([key], new Map(), new Map()),
      historyManagerForShow(key),
      resolver
    );
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0, 1" },
        new TestIo(),
        deps
      );
    } finally {
      CliTerminalFormatter.renderStatusMessage = originalStatus;
      CliTerminalFormatter.renderPromptHeader = originalHeader;
    }
    assert.deepStrictEqual(headers, ["0"]);
    assert.deepStrictEqual(statuses, [
      "Attempt completed",
      "--step 1 has not started (pending)",
    ]);

    const io = new TestIo();
    await showHistoryCommand(
      { workflow: key, run: "3", step: "0-1", json: true },
      io,
      deps
    );
    assert.strictEqual(io.output.length, 2);
    assert.deepStrictEqual(JSON.parse(io.output[1]), {
      runRef: "run-2026-09-20T12-00-00-000Z",
      selector: "1",
      step: 1,
      status: "pending",
      message: "--step 1 has not started (pending)",
    });
  });

  test("rejects an --attempt beyond the recorded attempts before writing", async () => {
    const key = "release" as WorkflowKey;
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const io = new TestIo();
    await assert.rejects(
      showHistoryCommand(
        { workflow: key, run: "3", step: "0", attempt: "3" },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([
            settledAttempt(target),
            settledAttempt(target, { attemptIndex: 1 }),
          ])
        )
      ),
      {
        message:
          'Invalid --attempt value "3" for --step 0; valid attempts are 1 to 2',
      }
    );
    assert.deepStrictEqual(io.output, []);
    assert.deepStrictEqual(io.errors, []);
  });

  test("says no events matched when --kind or --path filters out an attempt", async () => {
    const key = "release" as WorkflowKey;
    const statuses: string[] = [];
    const originalStatus = CliTerminalFormatter.renderStatusMessage;
    CliTerminalFormatter.renderStatusMessage = ((message) => {
      statuses.push(message);
    }) as typeof originalStatus;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0", kind: ["bash"], path: "src" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([
            settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }),
          ])
        )
      );
    } finally {
      CliTerminalFormatter.renderStatusMessage = originalStatus;
    }
    assert.deepStrictEqual(statuses, [
      "No events in --step 0 matched --kind bash and --path src",
    ]);
  });

  test("classifies script output for --kind with the history search map", async () => {
    const key = "release" as WorkflowKey;
    const scriptAttempt = (
      source: (typeof SCRIPT_OUTPUT_SOURCES)[keyof typeof SCRIPT_OUTPUT_SOURCES]
    ) =>
      settledAttempt(
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          kind: "script",
          output: {
            elapsed: 1,
            isStreaming: false,
            source,
          },
          scriptOutput: {
            command: `${source} command`,
            stdout: `${source} output`,
            stderr: "",
            exitCode: 0,
          },
        }
      );
    const show = async (
      source: (typeof SCRIPT_OUTPUT_SOURCES)[keyof typeof SCRIPT_OUTPUT_SOURCES],
      kind: string
    ): Promise<string[]> => {
      const io = new TestIo();
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0", kind: [kind], json: true },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([scriptAttempt(source)])
        )
      );
      return io.output.map(
        (line) =>
          (JSON.parse(line) as { responseText?: string; message?: string })
            .responseText ?? "no match"
      );
    };
    for (const [source, kind] of Object.entries(SCRIPT_EVENT_KIND_BY_SOURCE)) {
      assert.deepStrictEqual(
        await show(source as keyof typeof SCRIPT_EVENT_KIND_BY_SOURCE, kind),
        [`${source} output`],
        `${source} should be selected by --kind ${kind}`
      );
    }
    assert.deepStrictEqual(
      await show(
        SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP,
        HISTORY_EVENT_KINDS.PRE_CONDITION
      ),
      ["no match"]
    );
    assert.deepStrictEqual(
      await show(
        SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
        HISTORY_EVENT_KINDS.SCRIPT
      ),
      ["no match"]
    );
  });

  test("keeps text excluded by --kind out of every JSON field and filters --path like search", async () => {
    const key = "release" as WorkflowKey;
    const attempt = settledAttempt(
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        prompt: "SECRET PROMPT",
        output: {
          prompt: "SECRET PROMPT",
          response: "SECRET RESPONSE",
          elapsed: 1,
          isStreaming: false,
          structured: structuredEvents([
            { type: "text", data: { text: "SECRET RESPONSE" } },
            {
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              data: { command: "npm test" },
            },
            {
              type: CLI_EVENT_TYPES.FILE_EDIT,
              data: { path: "C:\\repo\\src\\core\\a.ts" },
            },
            { type: CLI_EVENT_TYPES.FILE_EDIT, data: { path: "docs/b.md" } },
          ]),
        },
      }
    );
    const run = async (options: Partial<HistoryShowOptions>) => {
      const io = new TestIo();
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0", json: true, ...options },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([attempt])
        )
      );
      return io.output;
    };

    const [bashOnly] = await run({ kind: ["bash"] });
    assert.doesNotMatch(bashOnly, /SECRET/);
    const parsed = JSON.parse(bashOnly) as {
      output: { structured: { events: Array<{ type: string }> } };
    };
    assert.deepStrictEqual(
      parsed.output.structured.events.map((event) => event.type),
      [CLI_EVENT_TYPES.BASH_COMMAND]
    );

    const [summary] = await run({ kind: ["bash"], summary: true });
    assert.doesNotMatch(summary, /SECRET/);

    const [byPath] = await run({ path: "  SRC/Core " });
    const pathEvents = (
      JSON.parse(byPath) as {
        output: { structured: { events: Array<{ data: { path: string } }> } };
      }
    ).output.structured.events;
    assert.deepStrictEqual(
      pathEvents.map((event) => event.data.path),
      ["C:\\repo\\src\\core\\a.ts"]
    );
    assert.doesNotMatch(byPath, /SECRET/);
  });

  test("bounds everything a paged show emits, events and script output included", async () => {
    const key = "release" as WorkflowKey;
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const hugeCommandOutput = "x".repeat(50_000);
    const aiAttempt = settledAttempt(target, {
      prompt: "P".repeat(10_000),
      output: {
        prompt: "P".repeat(10_000),
        response: "0123456789",
        elapsed: 1,
        isStreaming: false,
        structured: structuredEvents([
          { type: "text", data: { text: "0123456789" } },
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            data: { command: "build", output: hugeCommandOutput },
          },
        ]),
      },
    });
    const deps = (attempt: RunOutputResolverAttemptEvent) =>
      dependencies(
        new TestLineageRepository([key], new Map(), new Map()),
        historyManagerForShow(key),
        new TestRunOutputResolver([attempt])
      );

    // Text: the page replaces the structured events and the prompt preview.
    const chunks: string[] = [];
    let renderedEvents = 0;
    const prompts: string[] = [];
    const originalChunk = CliTerminalFormatter.renderStreamingChunk;
    const originalEvents = CliTerminalFormatter.renderEvents;
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    CliTerminalFormatter.renderStreamingChunk = ((chunk) =>
      chunks.push(chunk)) as typeof originalChunk;
    CliTerminalFormatter.renderEvents = (() => {
      renderedEvents++;
    }) as typeof originalEvents;
    CliTerminalFormatter.renderPromptHeader = ((data) => {
      prompts.push(data.promptText);
    }) as typeof originalHeader;
    const textIo = new TestIo();
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0", tail: "4" },
        textIo,
        deps(aiAttempt)
      );
    } finally {
      CliTerminalFormatter.renderStreamingChunk = originalChunk;
      CliTerminalFormatter.renderEvents = originalEvents;
      CliTerminalFormatter.renderPromptHeader = originalHeader;
    }
    assert.deepStrictEqual(chunks, ["6789"]);
    assert.strictEqual(renderedEvents, 0);
    assert.deepStrictEqual(prompts, [""]);

    // JSON default, summary, and events: one page, a cursor, no events.
    for (const mode of [{}, { summary: true }, { events: true }]) {
      const io = new TestIo();
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0", json: true, limit: "4", ...mode },
        io,
        deps(aiAttempt)
      );
      const total = io.output.join("\n");
      assert.ok(
        total.length < 1_000,
        `${JSON.stringify(mode)} emitted ${total.length} chars`
      );
      assert.strictEqual(io.output.length, 1);
      const record = JSON.parse(io.output[0]) as {
        responseText?: string;
        nextCursor?: string;
        event?: { data: { text: string } };
      };
      assert.strictEqual(record.nextCursor, "4");
      assert.strictEqual(
        record.responseText ?? record.event?.data.text,
        "0123"
      );
    }

    // --kind under paging pages the matching events as text.
    const kindIo = new TestIo();
    await showHistoryCommand(
      {
        workflow: key,
        run: "3",
        step: "0",
        json: true,
        kind: ["bash"],
        limit: "8",
        summary: true,
      },
      kindIo,
      deps(aiAttempt)
    );
    const kindPage = JSON.parse(kindIo.output[0]) as {
      responseText: string;
      nextCursor: string;
    };
    assert.strictEqual(kindPage.responseText, "build\nxx");
    assert.strictEqual(kindPage.nextCursor, "8");

    // Script attempts page their combined stdout and stderr.
    const scriptAttempt = settledAttempt(target, {
      kind: "script",
      output: {
        response: "ignored",
        elapsed: 1,
        isStreaming: false,
        source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
      },
      scriptOutput: {
        command: "run.sh",
        stdout: "y".repeat(20_000),
        stderr: "boom",
        exitCode: 1,
      },
    });
    const scriptIo = new TestIo();
    await showHistoryCommand(
      { workflow: key, run: "3", step: "0", json: true, tail: "6" },
      scriptIo,
      deps(scriptAttempt)
    );
    const scriptRecord = JSON.parse(scriptIo.output[0]) as {
      responseText: string;
      scriptOutput: Record<string, unknown>;
    };
    assert.strictEqual(scriptRecord.responseText, "y\nboom");
    assert.deepStrictEqual(scriptRecord.scriptOutput, {
      command: "run.sh",
      exitCode: 1,
    });
    assert.ok(scriptIo.output[0].length < 1_000);
  });

  test("pages transcript text without duplicating thinking events", async () => {
    const key = "release" as WorkflowKey;
    const attempt = settledAttempt(
      { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      {
        output: {
          response: "stale flattened value",
          elapsed: 1,
          isStreaming: false,
          structured: structuredEvents([
            { type: CLI_EVENT_TYPES.TEXT, data: { text: "answer" } },
            { type: CLI_EVENT_TYPES.THINKING, data: { text: "reasoning" } },
          ]),
        },
      }
    );
    const io = new TestIo();
    await showHistoryCommand(
      { workflow: key, run: "3", step: "0", json: true, summary: true, limit: "200" },
      io,
      dependencies(
        new TestLineageRepository([key], new Map(), new Map()),
        historyManagerForShow(key),
        new TestRunOutputResolver([attempt])
      )
    );
    const record = JSON.parse(io.output[0]) as { responseText: string };
    assert.strictEqual(record.responseText, "answer\n[Thinking]\nreasoning\n[/Thinking]");
    assert.strictEqual(record.responseText.match(/\[Thinking\]/g)?.length, 1);
  });

  test("validates paging selections before writing anything", async () => {
    const key = "release" as WorkflowKey;
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const retried = [
      settledAttempt(target, {
        output: { response: "first", elapsed: 1, isStreaming: false },
      }),
      settledAttempt(target, {
        attemptIndex: 1,
        output: { response: "second", elapsed: 1, isStreaming: false },
      }),
      settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 }),
    ];
    let headers = 0;
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    CliTerminalFormatter.renderPromptHeader = (() => {
      headers++;
    }) as typeof originalHeader;
    try {
      for (const options of [
        { step: "0,1", limit: "100" },
        { step: "0", attempt: "all", tail: "100" },
      ]) {
        const io = new TestIo();
        await assert.rejects(
          showHistoryCommand(
            { workflow: key, run: "3", ...options },
            io,
            dependencies(
              new TestLineageRepository([key], new Map(), new Map()),
              historyManagerForShow(key),
              new TestRunOutputResolver(retried)
            )
          ),
          {
            message:
              "history show: --cursor, --limit, and --tail require exactly one selected attempt",
          }
        );
        assert.deepStrictEqual(io.output, []);
        assert.deepStrictEqual(io.errors, []);
      }
      assert.strictEqual(headers, 0);
    } finally {
      CliTerminalFormatter.renderPromptHeader = originalHeader;
    }

    // Without --attempt, paging a retried step reads its latest attempt.
    const io = new TestIo();
    await showHistoryCommand(
      {
        workflow: key,
        run: "3",
        step: "0",
        json: true,
        summary: true,
        tail: "3",
      },
      io,
      dependencies(
        new TestLineageRepository([key], new Map(), new Map()),
        historyManagerForShow(key),
        new TestRunOutputResolver(retried)
      )
    );
    assert.strictEqual(io.output.length, 1);
    assert.strictEqual(
      (JSON.parse(io.output[0]) as { responseText: string }).responseText,
      "ond"
    );
  });

  test("counts normalized slots for the --max-events hint", async () => {
    const key = "release" as WorkflowKey;
    const io = new TestIo();
    const originalEvents = CliTerminalFormatter.renderHistoryEvents;
    const rendered: number[] = [];
    CliTerminalFormatter.renderHistoryEvents = ((events, _target, maxSlots) => {
      rendered.push(maxSlots ?? events.length);
      return 3;
    }) as typeof originalEvents;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", step: "0", maxEvents: "1" },
        io,
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          new TestRunOutputResolver([
            settledAttempt(
              { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
              {
                output: {
                  response: "r",
                  elapsed: 1,
                  isStreaming: false,
                  structured: structuredEvents([
                    { type: "thinking", data: { text: "a" } },
                    { type: "thinking", data: { text: "b" } },
                    { type: "thinking", data: { text: "c" } },
                  ]),
                },
              }
            ),
          ])
        )
      );
    } finally {
      CliTerminalFormatter.renderHistoryEvents = originalEvents;
    }
    assert.deepStrictEqual(rendered, [1]);
    assert.deepStrictEqual(io.output, [
      "… 2 more event blocks (use --max-events 3 to show all)",
    ]);
  });

  test("resolves latest from the lifecycle stream, reading output once", async () => {
    const key = "release" as WorkflowKey;
    const resolver = new TestRunOutputResolver([
      settledAttempt({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }),
      settledAttempt({ kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 }),
    ]);
    const headers: Array<string | undefined> = [];
    const originalHeader = CliTerminalFormatter.renderPromptHeader;
    CliTerminalFormatter.renderPromptHeader = ((data) => {
      headers.push(data.stepSelector);
    }) as typeof originalHeader;
    try {
      await showHistoryCommand(
        { workflow: key, run: "3", step: "latest" },
        new TestIo(),
        dependencies(
          new TestLineageRepository([key], new Map(), new Map()),
          historyManagerForShow(key),
          resolver
        )
      );
    } finally {
      CliTerminalFormatter.renderPromptHeader = originalHeader;
    }
    assert.strictEqual(resolver.attemptReads, 1);
    assert.strictEqual(resolver.lifecycleReads, 1);
    assert.deepStrictEqual(headers, ["final:2"]);
  });

  test("reports a missing lineage and a draft-only lineage like history runs", async () => {
    const key = "release" as WorkflowKey;
    for (const command of [showHistoryCommand, stepsHistoryCommand]) {
      await assert.rejects(
        command(
          { workflow: "missing" },
          new TestIo(),
          dependencies(
            new TestLineageRepository([key], new Map(), new Map()),
            historyManagerForShow(key),
            new TestRunOutputResolver([])
          )
        ),
        {
          message:
            'Workflow lineage "missing" was not found. Run `ctrlyoke history list` to find a lineage key.',
        }
      );
      await assert.rejects(
        command(
          { workflow: key },
          new TestIo(),
          dependencies(
            new TestLineageRepository([key], new Map(), new Map()),
            new TestHistoryManager(new Map(), new Map()),
            new TestRunOutputResolver([])
          )
        ),
        { message: 'Workflow lineage "release" has no runs yet.' }
      );
    }
  });

  test("sorts history list by latest run before --limit and fails fast on bad flags", async () => {
    const keys = ["a-old", "b-none", "c-new", "d-mid"] as WorkflowKey[];
    const started = new Map<WorkflowKey, number>([
      [keys[0], 1_000],
      [keys[2], 3_000],
      [keys[3], 2_000],
    ]);
    const manager = new TestHistoryManager(
      new Map(
        keys.map((key) => [
          key,
          started.has(key)
            ? {
                ...navigation(`run-${key}` as RunRef),
                startedAt: started.get(key),
              }
            : { runCount: 0 },
        ])
      ),
      new Map()
    );
    const repository = new TestLineageRepository(
      keys,
      new Map(keys.map((key) => [key, descriptor(key)])),
      new Map([
        [keys[0], "Zulu"],
        [keys[1], "Alpha"],
        [keys[2], "Mike"],
        [keys[3], "Bravo"],
      ])
    );
    const list = async (options: HistoryListOptions) => {
      const io = new TestIo();
      await listHistoryCommand(
        { json: true, ...options },
        io,
        dependencies(repository, manager)
      );
      return (JSON.parse(io.output[0]) as Array<{ workflowKey: string }>).map(
        (row) => row.workflowKey
      );
    };
    assert.deepStrictEqual(await list({}), [
      "c-new",
      "d-mid",
      "a-old",
      "b-none",
    ]);
    assert.deepStrictEqual(await list({ limit: "2" }), ["c-new", "d-mid"]);
    assert.deepStrictEqual(await list({ sort: "name" }), [
      "b-none",
      "d-mid",
      "c-new",
      "a-old",
    ]);

    for (const options of [
      { sort: "newest" },
      { state: ["runing"] },
      { since: "yesterday-ish" },
      { limit: "0" },
    ] as HistoryListOptions[]) {
      let bootstrapped = false;
      await assert.rejects(
        listHistoryCommand(options, new TestIo(), {
          bootstrapCliWorkspace: async () => {
            bootstrapped = true;
            throw new Error("the scan must not start");
          },
        }),
        (error: Error) => !/must not start/.test(error.message)
      );
      assert.strictEqual(bootstrapped, false, JSON.stringify(options));
    }
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

  test("reports a failed rebuild instead of completion when search falls back", async () => {
    const io = new TestIo();
    const service = new TestHistorySearchService(
      { ...searchResponse(), indexState: HISTORY_SEARCH_INDEX_STATES.FALLBACK },
      [
        [0, 10],
        [4, 10],
      ]
    );
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
    assert.deepStrictEqual(io.errors, [
      "Rebuilding search index (10 runs)…",
      "Search index rebuild failed; used a disk scan.",
    ]);
  });

  test("throttles TTY progress on the clock and redraws the final count", async () => {
    let now = 0;
    const ticks: Array<[number, number, number]> = [
      // [clock ms, processed, total]
      [0, 0, 10],
      [100, 2, 10],
      [249, 3, 10],
      [250, 4, 10],
      [400, 6, 10],
      [499, 9, 10],
    ];
    const service: HistorySearchCommandService = {
      search: async (_query, _root, onRebuildProgress) => {
        for (const [at, processed, total] of ticks) {
          now = at;
          onRebuildProgress?.(processed, total);
        }
        return searchResponse();
      },
    };
    const io = new TestIo();
    io.isErrTty = true;
    const originalNow = Date.now;
    Date.now = () => now;
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
      "\r\x1b[KRebuilding search index (4/10 runs)…",
      "\r\x1b[KRebuilding search index (9/10 runs)…",
      "\n",
    ]);
  });

  test("still ends the TTY progress line when search throws", async () => {
    const service: HistorySearchCommandService = {
      search: async (_query, _root, onRebuildProgress) => {
        onRebuildProgress?.(1, 10);
        throw new Error("index exploded");
      },
    };
    const io = new TestIo();
    io.isErrTty = true;
    await assert.rejects(
      searchHistoryCommand(
        "EPERM",
        { json: true },
        io,
        dependencies(
          new TestLineageRepository([], new Map(), new Map()),
          new TestHistoryManager(new Map(), new Map()),
          undefined,
          service
        )
      ),
      /index exploded/
    );
    assert.strictEqual(io.progress[io.progress.length - 1], "\n");
    assert.deepStrictEqual(io.errors, []);
    assert.deepStrictEqual(io.output, []);
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
    assert.match(output, /--workflow release --run run-final --step final:1$/m);
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
        matchContext: "Final Step Pass 1",
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


          elapsed: 1,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.TEXT,
                data: { text: `${"x".repeat(MAX_INDEXED_TEXT_LENGTH + 100)}${term}` },
              },
            ],
            metadata: {},
          },
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
