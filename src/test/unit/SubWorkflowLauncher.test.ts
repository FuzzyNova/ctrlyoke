import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, test } from "mocha";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { SubWorkflowLauncher } from "../../core/orchestration/SubWorkflowLauncher";
import { TypedEmitter } from "../../utils/TypedEmitter";
import type {
  SubWorkflowInstance,
  SubWorkflowLaunchRequest,
} from "../../types/SubWorkflowTypes";
import {
  isSameSubWorkflowParentLink,
  readSubWorkflowRanWith,
  SUB_WORKFLOW_SOURCE_KINDS,
} from "../../types/SubWorkflowTypes";
import type {
  ParsedPromptFile,
  PromptFile,
  QueueState,
  RunRef,
  WorkflowKey,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
  SUB_WORKFLOW_CANCELLATION_SOURCES,
  WORKTREE_MODES,
} from "../../types/DashboardConstants";

type Scenario =
  | "completed"
  | "mid-run-error"
  | "paused"
  | "startup-error"
  | "stopped"
  | "throw";

class FakeChild implements SubWorkflowInstance {
  readonly id = "child-instance";
  loadResult = true;
  loadError?: Error;
  executeCalls = 0;
  stopCalls = 0;
  status: QueueState["status"] = EXECUTION_STATES.IDLE;
  steps: QueueState["steps"] = [
    { prompt: "child", _runtime: {} } as QueueState["steps"][number],
  ];
  results: QueueState["results"] = [
    {
      prompt: "child",
      status: STEP_STATUS.PENDING,
      timestamp: new Date(0),
    },
  ];
  worktree?: PromptFile & {
    _runtime?: {
      worktree?: {
        schemaVersion: 1;
        mode: typeof WORKTREE_MODES.MANAGED;
        origin: "created";
        branchName: string;
        worktreePath: string;
        executionRoot: string;
        executionCheckoutRoot: string;
        sourceCheckoutRoot: string;
        namedWorkspaceRoots: [];
        baseCommit: string;
        lifecycleOwner: "workflow";
        lifecycleState: "active";
        directoryState: "present";
        branchState: "present";
      };
    };
  };

  private readonly stateEmitter = new TypedEmitter<QueueState>();
  private readonly disposeEmitter = new TypedEmitter<void>();
  private readonly cycleStartEmitter = new TypedEmitter<void>();
  /** Live `onDidChangeState`/`onDidDispose` subscriptions. */
  stateListeners = 0;
  disposeListeners = 0;
  /** Awaited before an execution cycle reports that it started. */
  cycleStartGate?: Promise<void>;
  /** The execution never reaches the point where its cycle starts. */
  skipCycleStart = false;

  private async startCycle(): Promise<void> {
    if (this.skipCycleStart) return;
    if (this.cycleStartGate) await this.cycleStartGate;
    this.cycleStartEmitter.fire();
  }

  onDidStartExecutionCycle(listener: () => void): { dispose(): void } {
    return this.cycleStartEmitter.event(listener);
  }

  setStatus(status: QueueState["status"]): void {
    this.status = status;
    this.stateEmitter.fire(this.promptQueue.getState());
  }

  /** Extra `_runtime` the step records when a completed scenario runs it. */
  completedRuntime: { harness?: string; model?: string } = {};

  /** The child's run file, when a test puts one on disk. */
  workingFilePath?: string;

  readonly promptQueue = {
    getState: (): QueueState => ({
      status: this.status,
      stopped: false,
      totalPausedDuration: 0,
      currentIndex: 0,
      parallelGroups: [],
      completedIndices: new Set(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      definitionRevision: 0,
      workflowKey: "child-key" as WorkflowKey,
      runRef: "run-child" as RunRef,
      ...(this.workingFilePath !== undefined
        ? { workingFilePath: this.workingFilePath }
        : {}),
      results: this.results,
      steps: this.steps,
    }),
    onDidChangeState: (listener: (state: QueueState) => void) => {
      this.stateListeners += 1;
      const subscription = this.stateEmitter.event(listener);
      return {
        dispose: () => {
          this.stateListeners -= 1;
          subscription.dispose();
        },
      };
    },
    getWorkflowFile: () => this.worktree ?? ({ steps: [] } as PromptFile),
  };

  fileLoadArgs?: Parameters<SubWorkflowInstance["loadPromptFile"]>;
  async loadPromptFile(
    ...args: Parameters<SubWorkflowInstance["loadPromptFile"]>
  ): Promise<boolean> {
    this.fileLoadArgs = args;
    if (this.loadError) throw this.loadError;
    return this.loadResult;
  }

  memoryLoadOptions?: Parameters<
    SubWorkflowInstance["loadFromMemoryOrThrow"]
  >[2];
  async loadFromMemoryOrThrow(
    ...args: Parameters<SubWorkflowInstance["loadFromMemoryOrThrow"]>
  ): Promise<string> {
    this.memoryLoadOptions = args[2];
    if (this.loadError) throw this.loadError;
    return "memory";
  }

  async executeLoadedPromptFile(): Promise<void> {
    this.executeCalls += 1;
    await this.startCycle();
    if (this.executionGate) await this.executionGate;
    await Promise.resolve();
    if (this.status === EXECUTION_STATES.STOPPED) return;
    if (this.nextScenario === "completed") {
      this.steps[0]._runtime = { startedAt: 1, ...this.completedRuntime };
      this.status = EXECUTION_STATES.COMPLETED;
      this.results[0].status = STEP_STATUS.COMPLETED;
    } else if (this.nextScenario === "mid-run-error") {
      this.steps[0]._runtime = { startedAt: 1 };
      this.status = EXECUTION_STATES.ERROR;
      this.results[0].status = STEP_STATUS.FAILED;
    } else if (this.nextScenario === "paused") {
      this.steps[0]._runtime = { startedAt: 1 };
      this.status = EXECUTION_STATES.PAUSED;
    } else if (this.nextScenario === "startup-error") {
      this.status = EXECUTION_STATES.ERROR;
    } else if (this.nextScenario === "throw") {
      throw new Error("unexpected execution failure");
    }
  }

  continuationError?: Error;
  continuationOptions?: Parameters<
    SubWorkflowInstance["executeContinuationAtRun"]
  >[4];
  async executeContinuationAtRun(
    ...args: Parameters<SubWorkflowInstance["executeContinuationAtRun"]>
  ): Promise<void> {
    this.continuationOptions = args[4];
    this.executeCalls += 1;
    this.status = EXECUTION_STATES.RUNNING;
    await this.startCycle();
    await Promise.resolve();
    if (this.continuationError) throw this.continuationError;
  }

  nextScenario: Scenario = "completed";
  executionGate?: Promise<void>;
  releaseExecution?: () => void;
  pauseCalls = 0;
  cancelPauseCalls = 0;
  async pause(): Promise<void> {
    this.pauseCalls += 1;
  }
  async cancelPause(): Promise<void> {
    this.cancelPauseCalls += 1;
  }
  resumeCalls = 0;
  /** Holds a resumed run open, as a real resume awaits the remaining run. */
  resumeGate?: Promise<void>;
  resumeError?: Error;
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeError) {
      await Promise.resolve();
      throw this.resumeError;
    }
    this.setStatus(EXECUTION_STATES.RUNNING);
    await this.resumeGate;
    this.results[0].status = STEP_STATUS.COMPLETED;
    this.setStatus(EXECUTION_STATES.COMPLETED);
  }
  async whenExecutionSettled(): Promise<void> {}
  onDidDispose(listener: () => void): { dispose(): void } {
    this.disposeListeners += 1;
    const subscription = this.disposeEmitter.event(listener);
    return {
      dispose: () => {
        this.disposeListeners -= 1;
        subscription.dispose();
      },
    };
  }
  dispose(): void {
    this.disposeEmitter.fire();
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.status = EXECUTION_STATES.STOPPED;
  }
}

class FakeFactory {
  readonly child = new FakeChild();
  options?: {
    concurrent: boolean;
    ancestorPaths: readonly string[];
    delegationChain: readonly string[];
  };
  create = (options: {
    concurrent: boolean;
    ancestorPaths: readonly string[];
    delegationChain: readonly string[];
  }): SubWorkflowInstance => {
    this.options = options;
    return this.child;
  };
}

function request(): SubWorkflowLaunchRequest {
  return {
    source: { kind: "file", resolvedPath: "/tmp/child.ctrlyoke.yaml" },
    ancestorPaths: ["/tmp/root.ctrlyoke.yaml", "/tmp/child.ctrlyoke.yaml"],
    parent: {
      workflowKey: "parent-key" as WorkflowKey,
      runRef: "run-parent" as RunRef,
      phase: "queue",
      stepId: "step-1",
    },
    parentExecution: { executionRoot: "/tmp", executionCheckoutRoot: "/tmp" },
    delegationChain: [],
    stateRoot: "/tmp/state",
    concurrent: false,
  };
}

suite("SubWorkflowLauncher", () => {
  test("loads a group preflight's parse and forwards concurrent to the factory", async () => {
    const factory = new FakeFactory();
    const parsed = { steps: [{ prompt: "child" }] } as ParsedPromptFile;
    const launcher = new SubWorkflowLauncher(factory.create);
    const handle = await launcher.launch({
      ...request(),
      source: {
        kind: SUB_WORKFLOW_SOURCE_KINDS.FILE,
        resolvedPath: "/tmp/child.ctrlyoke.yaml",
        parsed,
      },
      concurrent: true,
    });
    await handle.done;
    assert.equal(factory.options?.concurrent, true);
    assert.strictEqual(
      factory.child.fileLoadArgs?.[0],
      "/tmp/child.ctrlyoke.yaml"
    );
    assert.strictEqual(factory.child.fileLoadArgs?.[1], parsed);
  });

  test("parses the file itself when no preflight parse is supplied", async () => {
    const factory = new FakeFactory();
    const launcher = new SubWorkflowLauncher(factory.create);
    await (
      await launcher.launch(request())
    ).done;
    assert.strictEqual(factory.child.fileLoadArgs?.[1], undefined);
  });

  test("runs parent dirty-check only for a fresh child with worktree enabled", async () => {
    const factory = new FakeFactory();
    let checks = 0;
    factory.child.worktree = { steps: [], worktree: true } as PromptFile;
    const launchRequest = request();
    launchRequest.parentExecution.prepareWorktreeChild = async () => {
      checks += 1;
    };
    await new SubWorkflowLauncher(factory.create).launch(launchRequest);
    assert.strictEqual(checks, 1);

    factory.child.worktree = { steps: [], worktree: false } as PromptFile;
    await new SubWorkflowLauncher(factory.create).launch(launchRequest);
    assert.strictEqual(checks, 1);
  });

  test("reports a parent dirty-check rejection as failedToStart", async () => {
    const factory = new FakeFactory();
    factory.child.worktree = { steps: [], worktree: true } as PromptFile;
    const launchRequest = request();
    launchRequest.parentExecution.prepareWorktreeChild = async () => {
      throw new Error("dirty parent");
    };
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      launchRequest
    );
    assert.deepStrictEqual(await handle.done, {
      status: PROMPT_TERMINAL_STATUS.FAILED,
      failedToStart: true,
      failureMessage: "dirty parent",
      worktree: undefined,
    });
    assert.strictEqual(factory.child.executeCalls, 0);
  });

  test("compares parent links by fields regardless of key order", () => {
    const expected = request().parent;
    const reordered = {
      stepId: "step-1",
      phase: "queue",
      runRef: "run-parent" as RunRef,
      workflowKey: "parent-key" as WorkflowKey,
    } as const;
    assert.strictEqual(isSameSubWorkflowParentLink(reordered, expected), true);
    assert.strictEqual(
      isSameSubWorkflowParentLink(
        { ...expected, runRef: "other-run" as RunRef },
        expected
      ),
      false
    );
  });

  test("maps a completed child and projects its worktree", async () => {
    const factory = new FakeFactory();
    factory.child.worktree = {
      steps: [],
      _runtime: {
        worktree: {
          schemaVersion: 1,
          mode: WORKTREE_MODES.MANAGED,
          origin: "created",
          branchName: "child-branch",
          worktreePath: "/tmp/worktree",
          executionRoot: "/tmp/worktree",
          executionCheckoutRoot: "/tmp/worktree",
          sourceCheckoutRoot: "/tmp/source",
          namedWorkspaceRoots: [],
          baseCommit: "abc",
          lifecycleOwner: "workflow",
          lifecycleState: "active",
          directoryState: "present",
          branchState: "present",
        },
      },
    };
    const launcher = new SubWorkflowLauncher(factory.create);
    const handle = await launcher.launch(request());
    assert.equal(handle.workflowKey, "child-key");
    assert.deepEqual(await handle.done, {
      status: PROMPT_TERMINAL_STATUS.COMPLETED,
      worktree: {
        mode: WORKTREE_MODES.MANAGED,
        branchName: "child-branch",
        baseCommit: "abc",
        finalBranchTip: undefined,
        changedFileCount: undefined,
        landingOutcome: undefined,
        mergeOutcome: undefined,
        conflictFiles: undefined,
      },
    });
    assert.equal(factory.options?.concurrent, false);
    assert.deepEqual(factory.options?.ancestorPaths, [
      "/tmp/root.ctrlyoke.yaml",
      "/tmp/child.ctrlyoke.yaml",
    ]);
  });

  test("projects the worktree from the child's run file, which the queue never holds in memory", async () => {
    const directory = makeTempDir("ctrlyoke-launcher-worktree-");
    try {
      const factory = new FakeFactory();
      factory.child.workingFilePath = path.join(
        directory,
        "workflow.ctrlyoke.json"
      );
      await fs.writeFile(
        factory.child.workingFilePath,
        JSON.stringify({
          steps: [{ type: "script", script: "true" }],
          _runtime: {
            currentIndex: 1,
            executionState: EXECUTION_STATES.COMPLETED,
            worktree: {
              schemaVersion: 1,
              mode: WORKTREE_MODES.MANAGED,
              origin: "created",
              branchName: "ctrlyoke/lane/run-1",
              worktreePath: "/tmp/worktree",
              executionRoot: "/tmp/worktree",
              executionCheckoutRoot: "/tmp/worktree",
              sourceCheckoutRoot: "/tmp/source",
              namedWorkspaceRoots: [],
              baseCommit: "abc",
              finalBranchTip: "def",
              changedFileCount: 1,
              landingOutcome: "landed",
              lifecycleOwner: "ctrlyoke",
              lifecycleState: "settled",
              directoryState: "removed",
              branchState: "present",
              updatedAt: 1,
            },
          },
        })
      );
      const launcher = new SubWorkflowLauncher(factory.create);

      const result = await (await launcher.launch(request())).done;

      assert.deepStrictEqual(result.worktree, {
        mode: WORKTREE_MODES.MANAGED,
        branchName: "ctrlyoke/lane/run-1",
        baseCommit: "abc",
        finalBranchTip: "def",
        changedFileCount: 1,
        landingOutcome: "landed",
        mergeOutcome: undefined,
        conflictFiles: undefined,
      });
    } finally {
      removeTempDir(directory);
    }
  });

  test("records what the child's last started prompt step ran with, from its run file", async () => {
    const directory = makeTempDir("ctrlyoke-launcher-ran-with-");
    try {
      const factory = new FakeFactory();
      factory.child.workingFilePath = path.join(
        directory,
        "workflow.ctrlyoke.json"
      );
      await fs.writeFile(
        factory.child.workingFilePath,
        JSON.stringify({
          steps: [
            {
              prompt: "plan",
              _runtime: { harness: "codex-cli", model: "gpt-early" },
            },
            {
              prompt: "build",
              _runtime: { harness: "claude-cli", model: "opus" },
            },
            { type: "script", script: "true", _runtime: {} },
            // Never started: not what the child ran with.
            { prompt: "skipped", _runtime: {} },
          ],
          _runtime: {
            currentIndex: 4,
            executionState: EXECUTION_STATES.COMPLETED,
          },
        })
      );

      const result = await (
        await new SubWorkflowLauncher(factory.create).launch(request())
      ).done;

      assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.COMPLETED);
      assert.deepStrictEqual(result.ranWith, {
        harness: "claude-cli",
        model: "opus",
      });
    } finally {
      removeTempDir(directory);
    }
  });

  test("falls back to the in-memory steps for what the child ran with when its run file cannot be read", async () => {
    const factory = new FakeFactory();
    factory.child.workingFilePath = "/tmp/missing/workflow.ctrlyoke.json";
    factory.child.completedRuntime = { harness: "claude-cli" };
    const launcher = new SubWorkflowLauncher(
      factory.create,
      undefined,
      async () => {
        throw new Error("ENOENT");
      }
    );

    const result = await (await launcher.launch(request())).done;

    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.COMPLETED);
    assert.deepStrictEqual(result.ranWith, { harness: "claude-cli" });
  });

  test("falls back to the in-memory steps when the run file records no started prompt step", async () => {
    const factory = new FakeFactory();
    factory.child.workingFilePath = "/tmp/unstarted/workflow.ctrlyoke.json";
    factory.child.completedRuntime = { harness: "claude-cli" };
    const launcher = new SubWorkflowLauncher(
      factory.create,
      undefined,
      async () =>
        ({
          steps: [{ prompt: "lane", _runtime: {} }],
          _runtime: { currentIndex: 0 },
        }) as unknown as WorkingFile
    );

    const result = await (await launcher.launch(request())).done;

    assert.deepStrictEqual(result.ranWith, { harness: "claude-cli" });
  });

  test("drops an unknown harness id a run file records", async () => {
    const factory = new FakeFactory();
    factory.child.workingFilePath = "/tmp/tampered/workflow.ctrlyoke.json";
    const launcher = new SubWorkflowLauncher(
      factory.create,
      undefined,
      async () =>
        ({
          steps: [
            {
              prompt: "earlier",
              _runtime: { harness: "codex-cli", model: "gpt" },
            },
            {
              prompt: "tampered",
              _runtime: { harness: "not-a-harness", model: "opus" },
            },
          ],
          _runtime: { currentIndex: 2 },
        }) as unknown as WorkingFile
    );

    const result = await (await launcher.launch(request())).done;

    // The step naming an unknown harness does not count as started.
    assert.deepStrictEqual(result.ranWith, {
      harness: "codex-cli",
      model: "gpt",
    });
  });

  test("a reattached COMPLETED child whose run path cannot be built settles COMPLETED", async () => {
    const stateRoot = makeTempDir("ctrlyoke-launcher-bad-ref-");
    try {
      const launcher = new SubWorkflowLauncher(new FakeFactory().create);

      assert.deepStrictEqual(
        await launcher.readCompletedChild({
          stateRoot,
          workflowKey: "child-key" as WorkflowKey,
          runRef: "../escape" as RunRef,
        }),
        { status: PROMPT_TERMINAL_STATUS.COMPLETED }
      );
    } finally {
      removeTempDir(stateRoot);
    }
  });

  test("readSubWorkflowRanWith keeps only a known harness id and a string model", () => {
    assert.deepStrictEqual(
      readSubWorkflowRanWith({ harness: "claude-cli", model: "opus" }),
      { harness: "claude-cli", model: "opus" }
    );
    assert.deepStrictEqual(
      readSubWorkflowRanWith({ harness: "rogue-cli", model: "opus" }),
      { model: "opus" }
    );
    assert.strictEqual(
      readSubWorkflowRanWith({ harness: "rogue-cli", model: 3 }),
      undefined
    );
    assert.strictEqual(readSubWorkflowRanWith("claude-cli"), undefined);
    assert.strictEqual(readSubWorkflowRanWith(null), undefined);
  });

  test("reads a reattached COMPLETED child's worktree and ran-with from its run file", async () => {
    const stateRoot = makeTempDir("ctrlyoke-launcher-completed-");
    try {
      const workflowKey = "child-key" as WorkflowKey;
      const runRef = WorkflowPaths.formatRunRef(Date.UTC(2026, 10, 27, 12));
      const runFile = WorkflowPaths.runFilePath(stateRoot, workflowKey, runRef);
      await fs.mkdir(path.dirname(runFile), { recursive: true });
      await fs.writeFile(
        runFile,
        JSON.stringify({
          steps: [
            {
              prompt: "lane",
              _runtime: { harness: "claude-cli", model: "opus" },
            },
          ],
          _runtime: {
            currentIndex: 1,
            executionState: EXECUTION_STATES.COMPLETED,
            worktree: {
              schemaVersion: 1,
              mode: WORKTREE_MODES.MANAGED,
              origin: "created",
              branchName: "ctrlyoke/lane/run-1",
              worktreePath: "/tmp/worktree",
              executionRoot: "/tmp/worktree",
              executionCheckoutRoot: "/tmp/worktree",
              sourceCheckoutRoot: "/tmp/source",
              namedWorkspaceRoots: [],
              baseCommit: "abc",
              finalBranchTip: "def",
              mergeOutcome: "merged",
              lifecycleOwner: "ctrlyoke",
              lifecycleState: "settled",
              directoryState: "removed",
              branchState: "present",
              updatedAt: 1,
            },
          },
        })
      );
      const factory = new FakeFactory();
      const launcher = new SubWorkflowLauncher(factory.create);

      const result = await launcher.readCompletedChild({
        stateRoot,
        workflowKey,
        runRef,
      });

      assert.deepStrictEqual(result, {
        status: PROMPT_TERMINAL_STATUS.COMPLETED,
        worktree: {
          mode: WORKTREE_MODES.MANAGED,
          branchName: "ctrlyoke/lane/run-1",
          baseCommit: "abc",
          finalBranchTip: "def",
          changedFileCount: undefined,
          landingOutcome: undefined,
          mergeOutcome: "merged",
          conflictFiles: undefined,
        },
        ranWith: { harness: "claude-cli", model: "opus" },
      });
      // Reading a settled child creates no instance.
      assert.strictEqual(factory.options, undefined);

      // An unreadable run file still settles the step COMPLETED.
      assert.deepStrictEqual(
        await launcher.readCompletedChild({
          stateRoot,
          workflowKey,
          runRef: WorkflowPaths.formatRunRef(Date.UTC(2026, 10, 27, 13)),
        }),
        { status: PROMPT_TERMINAL_STATUS.COMPLETED }
      );
    } finally {
      removeTempDir(stateRoot);
    }
  });

  test("a stop while the settled child's run file is read does not stop the finished child", async () => {
    const factory = new FakeFactory();
    factory.child.workingFilePath = "/tmp/held/workflow.ctrlyoke.json";
    let signalReading!: () => void;
    const reading = new Promise<void>((resolve) => (signalReading = resolve));
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const launcher = new SubWorkflowLauncher(
      factory.create,
      undefined,
      async () => {
        signalReading();
        await readGate;
        return { steps: [], startedAt: 0, definitionRevision: 1 };
      }
    );
    const handle = await launcher.launch(request());

    await reading;
    await handle.stop();
    await handle.pause();
    await handle.cancelPause();
    releaseRead();

    assert.strictEqual(
      (await handle.done).status,
      PROMPT_TERMINAL_STATUS.COMPLETED
    );
    assert.strictEqual(factory.child.stopCalls, 0);
    assert.strictEqual(factory.child.pauseCalls, 0);
    assert.strictEqual(factory.child.cancelPauseCalls, 0);
    assert.strictEqual(factory.child.status, EXECUTION_STATES.COMPLETED);
  });

  test("falls back to the in-memory worktree when the child's run file is missing or corrupt", async () => {
    const directory = makeTempDir("ctrlyoke-launcher-fallback-");
    try {
      const runFiles = {
        missing: path.join(directory, "missing", "workflow.ctrlyoke.json"),
        corrupt: path.join(directory, "workflow.ctrlyoke.json"),
      };
      await fs.writeFile(runFiles.corrupt, "{ not json");
      for (const workingFilePath of Object.values(runFiles)) {
        const factory = new FakeFactory();
        factory.child.workingFilePath = workingFilePath;
        factory.child.worktree = {
          steps: [],
          _runtime: {
            worktree: {
              schemaVersion: 1,
              mode: WORKTREE_MODES.MANAGED,
              origin: "created",
              branchName: "in-memory-branch",
              worktreePath: "/tmp/worktree",
              executionRoot: "/tmp/worktree",
              executionCheckoutRoot: "/tmp/worktree",
              sourceCheckoutRoot: "/tmp/source",
              namedWorkspaceRoots: [],
              baseCommit: "abc",
              lifecycleOwner: "workflow",
              lifecycleState: "active",
              directoryState: "present",
              branchState: "present",
            },
          },
        };

        const result = await (
          await new SubWorkflowLauncher(factory.create).launch(request())
        ).done;

        assert.deepStrictEqual(
          result,
          {
            status: PROMPT_TERMINAL_STATUS.COMPLETED,
            worktree: {
              mode: WORKTREE_MODES.MANAGED,
              branchName: "in-memory-branch",
              baseCommit: "abc",
              finalBranchTip: undefined,
              changedFileCount: undefined,
              landingOutcome: undefined,
              mergeOutcome: undefined,
              conflictFiles: undefined,
            },
          },
          workingFilePath
        );
      }
    } finally {
      removeTempDir(directory);
    }
  });

  test("marks a child that fails mid-run as started", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "mid-run-error";
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    const result = await handle.done;
    assert.equal(result.status, PROMPT_TERMINAL_STATUS.FAILED);
    assert.equal(result.failedToStart, false);
  });

  test("marks startup failure as failed to start", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "startup-error";
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    const result = await handle.done;
    assert.equal(result.status, PROMPT_TERMINAL_STATUS.FAILED);
    assert.equal(result.failedToStart, true);
  });

  test("settles a thrown load error without executing", async () => {
    const factory = new FakeFactory();
    factory.child.loadError = new Error("invalid child document");
    const launchRequest = request();
    launchRequest.source = {
      kind: "inline",
      definition: { steps: [] },
      displayName: "inline child",
      parentDefinition: {},
    };
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      launchRequest
    );
    const result = await handle.done;
    assert.equal(result.failedToStart, true);
    assert.equal(result.failureMessage, "invalid child document");
    assert.equal(factory.child.executeCalls, 0);
  });

  test("hands an inline child its parent definition on launch and on reattach", async () => {
    const parentDefinition = {
      sourceDefinitionPath: "/repo/flows/parent.ctrlyoke.yaml",
      sourceCheckoutRoot: "/repo",
    };
    const inlineSource = {
      kind: "inline" as const,
      definition: { steps: [{ prompt: "child" }] },
      displayName: "inline child",
      parentDefinition,
    };
    const factory = new FakeFactory();
    await (
      await new SubWorkflowLauncher(factory.create).launch({
        ...request(),
        source: inlineSource,
      })
    ).done;
    assert.deepStrictEqual(
      factory.child.memoryLoadOptions?.parentDefinition,
      parentDefinition
    );

    const stateRoot = makeTempDir("ctrlyoke-launcher-inline-resume-");
    try {
      const childRunRef = WorkflowPaths.formatRunRef(Date.UTC(2026, 10, 27));
      const launchRequest = { ...request(), stateRoot, source: inlineSource };
      const childRunDir = WorkflowPaths.runDir(
        stateRoot,
        "child-key" as WorkflowKey,
        childRunRef
      );
      await fs.mkdir(childRunDir, { recursive: true });
      await new TimelineRecorder().initializeRunAt(
        childRunDir,
        "child-key",
        1,
        Date.now(),
        EXECUTION_STATES.STOPPED,
        1,
        undefined,
        launchRequest.parent
      );
      const resumeFactory = new FakeFactory();
      resumeFactory.child.continuationError = new Error("stop here");
      await (
        await new SubWorkflowLauncher(resumeFactory.create).launch({
          ...launchRequest,
          resumeChildRun: {
            workflowKey: "child-key" as WorkflowKey,
            runRef: childRunRef,
          },
        })
      ).done;
      assert.deepStrictEqual(
        resumeFactory.child.continuationOptions?.parentDefinition,
        parentDefinition
      );
    } finally {
      await fs.rm(path.dirname(WorkflowPaths.runsRoot(stateRoot)), {
        recursive: true,
        force: true,
      });
      removeTempDir(stateRoot);
    }
  });

  test("classifies stop through the handle as parent cancellation", async () => {
    const factory = new FakeFactory();
    factory.child.executionGate = new Promise<void>((resolve) => {
      factory.child.releaseExecution = resolve;
    });
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    await handle.stop();
    factory.child.releaseExecution?.();
    const result = await handle.done;
    assert.equal(result.status, PROMPT_TERMINAL_STATUS.CANCELLED);
    assert.equal(result.cancelledBy, SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT);
    assert.equal(factory.child.stopCalls, 1);
  });

  test("classifies a child initiated stop as child cancellation", async () => {
    const factory = new FakeFactory();
    factory.child.status = EXECUTION_STATES.STOPPED;
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    const result = await handle.done;
    assert.equal(result.cancelledBy, SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD);
  });

  test("settles a continuation whose execution rejects as FAILED with the error", async () => {
    const stateRoot = makeTempDir("ctrlyoke-launcher-resume-");
    try {
      const childRunRef = WorkflowPaths.formatRunRef(Date.UTC(2026, 10, 26));
      const launchRequest = { ...request(), stateRoot };
      const childRunDir = WorkflowPaths.runDir(
        stateRoot,
        "child-key" as WorkflowKey,
        childRunRef
      );
      await fs.mkdir(childRunDir, { recursive: true });
      await new TimelineRecorder().initializeRunAt(
        childRunDir,
        "child-key",
        1,
        Date.now(),
        EXECUTION_STATES.STOPPED,
        1,
        undefined,
        launchRequest.parent
      );
      const factory = new FakeFactory();
      factory.child.continuationError = new Error("continuation exploded");
      const handle = await new SubWorkflowLauncher(factory.create).launch({
        ...launchRequest,
        resumeChildRun: {
          workflowKey: "child-key" as WorkflowKey,
          runRef: childRunRef,
        },
      });
      const result = await handle.done;
      assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.FAILED);
      assert.strictEqual(result.failureMessage, "continuation exploded");
      assert.strictEqual(factory.child.executeCalls, 1);
    } finally {
      await fs.rm(path.dirname(WorkflowPaths.runsRoot(stateRoot)), {
        recursive: true,
        force: true,
      });
      removeTempDir(stateRoot);
    }
  });

  /** Resolves true when `promise` settles before a macrotask runs. */
  async function settlesPromptly(promise: Promise<unknown>): Promise<boolean> {
    return Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
  }

  test("resuming a PAUSED child returns without awaiting its remaining run", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "paused";
    let releaseResume!: () => void;
    factory.child.resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    assert.strictEqual(
      await settlesPromptly(handle.cancelPause()),
      true,
      "cancelPause returned before the child's run ended"
    );
    assert.strictEqual(factory.child.resumeCalls, 1);
    assert.strictEqual(factory.child.status, EXECUTION_STATES.RUNNING);
    assert.strictEqual(await settlesPromptly(handle.done), false);

    releaseResume();
    const result = await handle.done;
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.COMPLETED);
    assert.strictEqual(factory.child.stateListeners, 0);
    assert.strictEqual(factory.child.disposeListeners, 0);
  });

  test("a PAUSED child whose resume rejects settles done FAILED with the error", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "paused";
    factory.child.resumeError = new Error("resume exploded");
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    await handle.cancelPause();
    const result = await handle.done;
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.FAILED);
    assert.strictEqual(result.failureMessage, "resume exploded");
    assert.strictEqual(factory.child.stateListeners, 0);
  });

  test("a PAUSED child that is disposed settles done CANCELLED and unsubscribes", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "paused";
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    assert.strictEqual(await settlesPromptly(handle.done), false);
    assert.strictEqual(factory.child.stateListeners, 1);

    factory.child.dispose();
    const result = await handle.done;
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.CANCELLED);
    assert.strictEqual(
      result.cancelledBy,
      SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD
    );
    assert.strictEqual(factory.child.stateListeners, 0);
    assert.strictEqual(factory.child.disposeListeners, 0);
  });

  test("a resume racing the settle check waits for the resumed run", async () => {
    const factory = new FakeFactory();
    let releaseResume!: () => void;
    factory.child.resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    // The first cycle ends paused, and a resume lands before the launcher
    // inspects the state: it reads RUNNING, never PAUSED.
    factory.child.executeLoadedPromptFile = async () => {
      factory.child.executeCalls += 1;
      factory.child.steps[0]._runtime = { startedAt: 1 };
      factory.child.status = EXECUTION_STATES.PAUSED;
      void factory.child.resume();
    };
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    assert.strictEqual(await settlesPromptly(handle.done), false);
    releaseResume();
    const result = await handle.done;
    assert.strictEqual(
      result.status,
      PROMPT_TERMINAL_STATUS.COMPLETED,
      JSON.stringify(result)
    );
  });

  test("a child disposed before its paused cycle is collected settles done CANCELLED", async () => {
    const factory = new FakeFactory();
    // The dispose lands before the launcher sees the cycle end paused, so a
    // listener subscribed only for the settle wait would never hear it.
    factory.child.executeLoadedPromptFile = async () => {
      factory.child.executeCalls += 1;
      factory.child.steps[0]._runtime = { startedAt: 1 };
      factory.child.status = EXECUTION_STATES.PAUSED;
      factory.child.dispose();
    };
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    assert.strictEqual(await settlesPromptly(handle.done), true);
    const result = await handle.done;
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.CANCELLED);
    assert.strictEqual(factory.child.stateListeners, 0);
    assert.strictEqual(factory.child.disposeListeners, 0);
  });

  test("a running child that is disposed is stopped, and done settles CANCELLED once its run ends", async () => {
    const factory = new FakeFactory();
    factory.child.executionGate = new Promise<void>((resolve) => {
      factory.child.releaseExecution = resolve;
    });
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    factory.child.setStatus(EXECUTION_STATES.RUNNING);
    factory.child.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(factory.child.stopCalls, 1);
    // No executor outlives its instance: `done` waits for the run to end.
    assert.strictEqual(await settlesPromptly(handle.done), false);
    factory.child.releaseExecution?.();
    assert.deepStrictEqual(await handle.done, {
      status: PROMPT_TERMINAL_STATUS.CANCELLED,
      cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
      worktree: undefined,
    });
    assert.strictEqual(factory.child.disposeListeners, 0);
  });

  test("a child disposed before its cycle starts is stopped when it starts", async () => {
    const factory = new FakeFactory();
    let startCycle!: () => void;
    factory.child.cycleStartGate = new Promise<void>((resolve) => {
      startCycle = resolve;
    });
    // A D6 continuation shows its restored STOPPED state while it loads.
    factory.child.status = EXECUTION_STATES.STOPPED;
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    await handle.pause();
    factory.child.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(factory.child.stopCalls, 0, "not before it starts");
    assert.strictEqual(await settlesPromptly(handle.done), false);
    startCycle();
    const result = await handle.done;
    assert.strictEqual(factory.child.stopCalls, 1);
    assert.strictEqual(factory.child.pauseCalls, 0, "the stop supersedes");
    assert.deepStrictEqual(result, {
      status: PROMPT_TERMINAL_STATUS.CANCELLED,
      cancelledBy: SUB_WORKFLOW_CANCELLATION_SOURCES.CHILD,
      worktree: undefined,
    });
  });

  test("a paused child that is disposed is not stopped", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "paused";
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    factory.child.dispose();
    const result = await handle.done;
    assert.strictEqual(factory.child.stopCalls, 0);
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.CANCELLED);
    assert.strictEqual(factory.child.status, EXECUTION_STATES.PAUSED);
  });

  test("releases its child to the host once done settles, or when its launch fails", async () => {
    const released: SubWorkflowInstance[] = [];
    const factory = new FakeFactory();
    factory.child.executionGate = new Promise<void>((resolve) => {
      factory.child.releaseExecution = resolve;
    });
    const launcher = new SubWorkflowLauncher(factory.create, (child) =>
      released.push(child)
    );
    const handle = await launcher.launch(request());
    assert.deepStrictEqual(released, []);
    factory.child.releaseExecution?.();
    await handle.done;
    assert.deepStrictEqual(released, [factory.child]);

    const failing = new FakeFactory();
    failing.child.loadResult = false;
    const failedReleases: SubWorkflowInstance[] = [];
    const failed = await new SubWorkflowLauncher(failing.create, (child) =>
      failedReleases.push(child)
    ).launch(request());
    assert.strictEqual((await failed.done).failedToStart, true);
    assert.deepStrictEqual(failedReleases, [failing.child]);
  });

  test("a child that completes and is then disposed still settles COMPLETED", async () => {
    const factory = new FakeFactory();
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    const result = await handle.done;
    factory.child.dispose();
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.COMPLETED);
  });

  test("holds stop, pause and cancelPause until the child's execution cycle starts", async () => {
    const factory = new FakeFactory();
    let startCycle!: () => void;
    factory.child.cycleStartGate = new Promise<void>((resolve) => {
      startCycle = resolve;
    });
    factory.child.status = EXECUTION_STATES.STOPPED;
    factory.child.nextScenario = "paused";
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );

    await handle.pause();
    await handle.cancelPause();
    await handle.pause();
    assert.strictEqual(factory.child.pauseCalls, 0);
    assert.strictEqual(factory.child.cancelPauseCalls, 0);
    assert.strictEqual(factory.child.resumeCalls, 0);

    factory.child.status = EXECUTION_STATES.RUNNING;
    startCycle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(factory.child.pauseCalls, 1, "held pause forwarded");
    assert.strictEqual(factory.child.cancelPauseCalls, 0);
    assert.strictEqual(factory.child.resumeCalls, 0);
    factory.child.dispose();
    await handle.done;
  });

  test("a stop held before the cycle starts is the only control replayed", async () => {
    const factory = new FakeFactory();
    let startCycle!: () => void;
    factory.child.cycleStartGate = new Promise<void>((resolve) => {
      startCycle = resolve;
    });
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    await handle.pause();
    await handle.stop();
    assert.strictEqual(factory.child.stopCalls, 0);
    startCycle();
    const result = await handle.done;
    assert.strictEqual(factory.child.stopCalls, 1);
    assert.strictEqual(factory.child.pauseCalls, 0);
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.CANCELLED);
    assert.strictEqual(
      result.cancelledBy,
      SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT
    );
  });

  test("a stop held for a cycle that never starts settles done CANCELLED by the parent", async () => {
    const factory = new FakeFactory();
    factory.child.skipCycleStart = true;
    factory.child.nextScenario = "startup-error";
    factory.child.executionGate = new Promise<void>((resolve) => {
      factory.child.releaseExecution = resolve;
    });
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    await handle.stop();
    factory.child.releaseExecution?.();
    const result = await handle.done;
    assert.strictEqual(factory.child.stopCalls, 0);
    assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.CANCELLED);
    assert.strictEqual(
      result.cancelledBy,
      SUB_WORKFLOW_CANCELLATION_SOURCES.PARENT
    );
  });

  test("ignores controls once the child has settled", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "stopped";
    factory.child.status = EXECUTION_STATES.STOPPED;
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    await handle.done;
    // The parent's own stop, which follows the CANCELLED step it settles.
    await handle.stop();
    await handle.pause();
    await handle.cancelPause();
    assert.strictEqual(factory.child.stopCalls, 0);
    assert.strictEqual(factory.child.pauseCalls, 0);
    assert.strictEqual(factory.child.cancelPauseCalls, 0);
  });

  test("never rejects done when execution unexpectedly throws", async () => {
    const factory = new FakeFactory();
    factory.child.nextScenario = "throw";
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    const result = await handle.done;
    assert.equal(result.status, PROMPT_TERMINAL_STATUS.FAILED);
    assert.equal(result.failureMessage, "unexpected execution failure");
  });
});
