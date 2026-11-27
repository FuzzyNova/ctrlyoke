import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, test } from "mocha";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { SubWorkflowLauncher } from "../../core/orchestration/SubWorkflowLauncher";
import type {
  SubWorkflowInstance,
  SubWorkflowLaunchRequest,
} from "../../types/SubWorkflowTypes";
import { isSameSubWorkflowParentLink } from "../../types/SubWorkflowTypes";
import type {
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
  "completed" | "mid-run-error" | "startup-error" | "stopped" | "throw";

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
    onDidChangeState: () => ({ dispose: () => {} }),
    getWorkflowFile: () => this.worktree ?? ({ steps: [] } as PromptFile),
  };

  async loadPromptFile(): Promise<boolean> {
    if (this.loadError) throw this.loadError;
    return this.loadResult;
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
    } else if (this.nextScenario === "startup-error") {
      this.status = EXECUTION_STATES.ERROR;
    } else if (this.nextScenario === "throw") {
      throw new Error("unexpected execution failure");
    }
  }

  continuationError?: Error;
  async executeContinuationAtRun(): Promise<void> {
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
  async resume(): Promise<void> {}
  async whenExecutionSettled(): Promise<void> {}
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
  };
}

suite("SubWorkflowLauncher", () => {
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
    const handle = await new SubWorkflowLauncher(factory.create).launch(
      request()
    );
    const result = await handle.done;
    assert.equal(result.failedToStart, true);
    assert.equal(result.failureMessage, "invalid child document");
    assert.equal(factory.child.executeCalls, 0);
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
