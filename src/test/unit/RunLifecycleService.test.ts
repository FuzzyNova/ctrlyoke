import { suite, test } from "mocha";
import * as assert from "assert";
import type {
  QueueState,
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
  WorkflowViewAddress,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  WORKTREE_EDIT_KINDS,
  type HarnessId,
} from "../../types/DashboardConstants";
import {
  RunLifecycleService,
  type RunLifecycleInstancePort,
  type RunLifecycleRegistryPort,
  type RunLifecycleServiceHost,
  type RunLifecycleViewPort,
} from "../../core/orchestration/RunLifecycleService";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import type {
  UserFeedback,
  UserFeedbackSink,
} from "../../core/UserFeedbackSink";

const workflowKey = "lifecycle-test" as WorkflowKey;
const runRef = "run-2026-09-17T00-00-00-000Z" as RunRef;

function queueState(
  status: QueueState["status"],
  targetRunRef: RunRef = runRef
): QueueState {
  return {
    status,
    stopped: false,
    totalPausedDuration: 0,
    currentIndex: 0,
    steps: [],
    parallelGroups: [],
    results: [],
    completedIndices: new Set(),
    totalExecutionTime: 0,
    queueExtensions: 0,
    workflowKey,
    runRef: targetRunRef,
    definitionRevision: 1,
  };
}

class FakeInstance implements RunLifecycleInstancePort {
  readonly id = "fake-instance";
  constructor(private readonly state: QueueState) {}

  getQueueState(): QueueState {
    return this.state;
  }

  getExecutionRunRef(): RunRef | undefined {
    return this.state.runRef;
  }

  ownsRunnerLock(): boolean {
    return false;
  }

  clearPendingRewind(): void {}

  async resyncWorkingFileFromDisk(): Promise<void> {}

  async beginPendingRewind(): Promise<{
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return { definitionRevision: 1, descriptorRevision: 1 };
  }

  async closeRetainedTerminalsForFreshRun(): Promise<void> {}

  async executeSeededRun(
    _seeded: Parameters<RunLifecycleInstancePort["executeSeededRun"]>[0],
    _workflowKey: WorkflowKey,
    _harnessOverride?: HarnessId,
    _onPrepared?: () => Promise<void>
  ): Promise<void> {}

  async executeContinuationAtRun(
    _workflowKey: WorkflowKey,
    _runRef: RunRef,
    _expectedDefinitionRevision: number,
    _onPrepared?: () => Promise<void>
  ): Promise<void> {}

  async executeLoadedPromptFile(
    _modeOverride?: HarnessId,
    _continueFromCurrent?: boolean,
    _preinitializedHistoryFilePath?: string,
    _prePromotedFreshStart?: boolean,
    _onPrepared?: () => Promise<void>
  ): Promise<void> {}

  readonly draftStartPositions: number[] = [];

  async setDraftStartPosition(toIndex: number): Promise<void> {
    this.draftStartPositions.push(toIndex);
  }
}

class FakeRegistry implements RunLifecycleRegistryPort {
  readonly instances = new Map<string, RunLifecycleInstancePort>();
  readonly retiredInstances = new Map<string, RunLifecycleInstancePort>();
  readonly viewAddresses = new Map<string, WorkflowViewAddress | null>();
  readonly viewSinks = new Map<string, (message: unknown) => void>();
  readonly executionOwners = new Map<
    WorkflowKey,
    { instanceId: string; promoted: boolean }
  >();
  viewedInstance: RunLifecycleInstancePort | undefined;

  getInstances(): Map<string, RunLifecycleInstancePort> {
    return this.instances;
  }

  getRetiredInstances(): Map<string, RunLifecycleInstancePort> {
    return this.retiredInstances;
  }

  getViewAddressRegistry(): Map<string, WorkflowViewAddress | null> {
    return this.viewAddresses;
  }

  getViewMessageSinks(): Map<string, (message: unknown) => void> {
    return this.viewSinks;
  }

  getLineageExecutionOwners(): Map<
    WorkflowKey,
    { instanceId: string; promoted: boolean }
  > {
    return this.executionOwners;
  }

  getInstanceForClient(): RunLifecycleInstancePort {
    if (!this.viewedInstance) throw new Error("missing fake client instance");
    return this.viewedInstance;
  }

  setViewedWorkflowId(): void {}
}

class FakeViews implements RunLifecycleViewPort {
  address: WorkflowViewAddress | null = {
    workflowKey,
    kind: "run",
    runRef,
  };

  getViewAddress(): WorkflowViewAddress | null {
    return this.address;
  }

  readonly invalidatedDrafts: WorkflowKey[] = [];

  async loadRunViewForClient(): Promise<void> {}
  async publishRunRevisionsToViewers(): Promise<void> {}
  async invalidateRunViews(): Promise<void> {}
  async invalidateDraftViews(key: WorkflowKey): Promise<void> {
    this.invalidatedDrafts.push(key);
  }
  async pushRunSummariesRefreshIfNotAlreadyViewing(): Promise<void> {}
}

class FakeFeedbackSink implements UserFeedbackSink {
  notify(_message: UserFeedback): void {}
}

class FakeLineageRepository extends WorkflowLineageRepository {
  constructor(private readonly descriptor: WorkflowLineageDescriptor) {
    super();
  }

  override async readDescriptor(): Promise<WorkflowLineageDescriptor> {
    return this.descriptor;
  }
}

function descriptor(
  pendingEdit?: WorkflowLineageDescriptor["pendingEdit"]
): WorkflowLineageDescriptor {
  return {
    schemaVersion: 1,
    workflowKey,
    workflowName: "Lifecycle test",
    isFavorite: false,
    createdAt: 0,
    lastModifiedAt: 0,
    nextRunId: 2,
    revision: 1,
    ...(pendingEdit ? { pendingEdit } : {}),
  };
}

function createHost(
  registry: FakeRegistry,
  views: FakeViews,
  lineage: WorkflowLineageRepository
): RunLifecycleServiceHost {
  const instance = new FakeInstance(queueState(EXECUTION_STATES.IDLE));
  registry.viewedInstance = instance;
  return {
    registry,
    views,
    panelClientId: "panel",
    getWorkspaceRoot: () => "C:\\lifecycle-test",
    getLineageRepository: () => lineage,
    getRunnerHostIdentity: () => ({
      runner: "vscode",
      hostInstanceId: "test-host",
      pid: process.pid,
    }),
    getUserFeedbackSink: () => new FakeFeedbackSink(),
    getInstanceForClient: () => instance,
    getStoredPanelSend: () => undefined,
    assertNoPendingWorkflowExternalRoots: async () => undefined,
    buildWorkflowInstance: () => instance,
    replayWorkflowStateTo: async () => undefined,
    getExternalExecutionRunRef: () => undefined,
  };
}

suite("RunLifecycleService continuation validation", () => {
  test("rejects an address that is no longer the client's viewed run", async () => {
    const registry = new FakeRegistry();
    const views = new FakeViews();
    views.address = null;
    const service = new RunLifecycleService(
      createHost(registry, views, new FakeLineageRepository(descriptor()))
    );

    await assert.rejects(
      () =>
        service.validateExplicitContinuationTarget(
          { workflowKey, runRef },
          1,
          1,
          "panel"
        ),
      /Continuation no longer targets this client's viewed run/
    );
  });

  test("rejects a stale descriptor revision before reading run ownership", async () => {
    const registry = new FakeRegistry();
    const views = new FakeViews();
    const current = descriptor();
    current.revision = 2;
    const service = new RunLifecycleService(
      createHost(registry, views, new FakeLineageRepository(current))
    );

    await assert.rejects(
      () =>
        service.validateExplicitContinuationTarget(
          { workflowKey, runRef },
          1,
          1,
          "panel"
        ),
      /Descriptor revision conflict: expected 1, found 2/
    );
  });

  test("rejects a different pending continuation", async () => {
    const registry = new FakeRegistry();
    const views = new FakeViews();
    const pending = {
      kind: WORKTREE_EDIT_KINDS.REWIND,
      runRef: "run-other" as RunRef,
      fromStepIndex: 1,
      baseDefinitionRevision: 1,
    };
    const service = new RunLifecycleService(
      createHost(
        registry,
        views,
        new FakeLineageRepository(descriptor(pending))
      )
    );

    await assert.rejects(
      () =>
        service.validateExplicitContinuationTarget(
          { workflowKey, runRef },
          1,
          1,
          "panel"
        ),
      /This workflow has a draft or pending continuation/
    );
  });

  test("rejects when another resident run owns the lineage", async () => {
    const registry = new FakeRegistry();
    const views = new FakeViews();
    registry.instances.set(
      "other",
      new FakeInstance(
        queueState(EXECUTION_STATES.PAUSED, "run-other" as RunRef)
      )
    );
    const service = new RunLifecycleService(
      createHost(registry, views, new FakeLineageRepository(descriptor()))
    );

    await assert.rejects(
      () =>
        service.validateExplicitContinuationTarget(
          { workflowKey, runRef },
          1,
          1,
          "panel"
        ),
      /Another run in this workflow lineage is executing/
    );
  });
});
