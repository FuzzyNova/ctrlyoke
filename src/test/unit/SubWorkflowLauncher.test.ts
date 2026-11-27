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
  SUB_WORKFLOW_SOURCE_KINDS,
} from "../../types/SubWorkflowTypes";
import type {
  ParsedPromptFile,
  PromptFile,
  QueueState,
  RunRef,
  WorkflowKey,
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
  /** Live `onDidChangeState`/`onDidDispose` subscriptions. */
  stateListeners = 0;
  disposeListeners = 0;

  setStatus(status: QueueState["status"]): void {
    this.status = status;
    this.stateEmitter.fire(this.promptQueue.getState());
  }

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
    if (this.executionGate) await this.executionGate;
    await Promise.resolve();
    if (this.status === EXECUTION_STATES.STOPPED) return;
    if (this.nextScenario === "completed") {
      this.steps[0]._runtime = { startedAt: 1 };
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
    await Promise.resolve();
    if (this.continuationError) throw this.continuationError;
  }

  nextScenario: Scenario = "completed";
  executionGate?: Promise<void>;
  releaseExecution?: () => void;
  async pause(): Promise<void> {}
  async cancelPause(): Promise<void> {}
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
