import * as assert from "assert";
import { suite, test } from "mocha";
import { SubWorkflowLauncher } from "../../core/orchestration/SubWorkflowLauncher";
import type {
  SubWorkflowInstance,
  SubWorkflowLaunchRequest,
} from "../../types/SubWorkflowTypes";
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

  async executeContinuationAtRun(): Promise<void> {
    this.executeCalls += 1;
    this.status = EXECUTION_STATES.RUNNING;
  }

  nextScenario: Scenario = "completed";
  executionGate?: Promise<void>;
  releaseExecution?: () => void;
  async pause(): Promise<void> {}
  async cancelPause(): Promise<void> {}
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
  };
}

suite("SubWorkflowLauncher", () => {
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
