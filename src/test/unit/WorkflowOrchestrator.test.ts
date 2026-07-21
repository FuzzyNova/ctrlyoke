import { suite, test } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
} from "../../types/DashboardConstants";

function createOrchestratorHarness() {
  const orchestrator = Object.create(
    WorkflowOrchestrator.prototype
  ) as WorkflowOrchestrator;
  const internal = orchestrator as any;

  internal.dashboardReady = false;
  internal.orchestratorInitialized = false;
  internal.startupAutoLoadTriggered = false;
  internal.viewerRegistry = new Map<string, string | null>();

  let autoLoadCalls = 0;
  internal.triggerAutoLoad = async () => {
    autoLoadCalls += 1;
  };

  return {
    orchestrator,
    internal,
    getAutoLoadCalls: () => autoLoadCalls,
  };
}

suite("WorkflowOrchestrator startup auto-load gating", () => {
  test("triggers startup auto-load immediately when dashboard becomes ready after init", async () => {
    const { orchestrator, internal, getAutoLoadCalls } =
      createOrchestratorHarness();
    internal.orchestratorInitialized = true;

    await orchestrator.setDashboardReady();

    assert.strictEqual(getAutoLoadCalls(), 1);
    assert.strictEqual(internal.dashboardReady, true);
    assert.strictEqual(internal.startupAutoLoadTriggered, true);
  });

  test("defers startup auto-load until init completes if dashboard becomes ready first", async () => {
    const { orchestrator, internal, getAutoLoadCalls } =
      createOrchestratorHarness();

    await orchestrator.setDashboardReady();

    assert.strictEqual(getAutoLoadCalls(), 0);
    assert.strictEqual(internal.dashboardReady, true);
    assert.strictEqual(internal.startupAutoLoadTriggered, false);

    internal.orchestratorInitialized = true;
    await internal.triggerStartupAutoLoadIfReady();

    assert.strictEqual(getAutoLoadCalls(), 1);
    assert.strictEqual(internal.startupAutoLoadTriggered, true);
  });

  test("does not rerun startup auto-load when the dashboard reconnects", async () => {
    const { orchestrator, internal, getAutoLoadCalls } =
      createOrchestratorHarness();
    internal.orchestratorInitialized = true;

    await orchestrator.setDashboardReady();
    await orchestrator.setDashboardReady();

    assert.strictEqual(getAutoLoadCalls(), 1);
    assert.strictEqual(internal.startupAutoLoadTriggered, true);
  });
});

suite("WorkflowOrchestrator handleClientReady", () => {
  test("keeps client run views independent from the execution target", () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    const workflowKey = "demo" as never;
    const executingRun = "run-2026-07-20T10-30-00-000Z" as never;
    const viewedRun = "run-2026-07-20T09-30-00-000Z" as never;

    internal.viewAddressRegistry = new Map([
      ["client-a", { workflowKey, kind: "run", runRef: executingRun }],
      ["client-b", { workflowKey, kind: "run", runRef: viewedRun }],
    ]);
    internal.instances = new Map([
      [
        "execution-instance",
        {
          getQueueState: () => ({ workflowKey, runRef: executingRun }),
          getExecutionRunRef: () => executingRun,
        },
      ],
    ]);
    internal.cliSessions = new Map();

    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey,
      kind: "run",
      runRef: executingRun,
    });
    assert.deepStrictEqual(orchestrator.getViewAddress("client-b"), {
      workflowKey,
      kind: "run",
      runRef: viewedRun,
    });
    assert.strictEqual(internal.findExecutionRunRef(workflowKey), executingRun);
  });

  test("deleting a viewed run falls every affected client back deterministically", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-delete-multiclient-")
    );
    let history: OutputHistoryManager | undefined;
    try {
      const fileManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "one" }],
        getCurrentIndex: () => 0,
        getStatus: () => EXECUTION_STATES.IDLE,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Delete clients",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await fileManager.createWorkingFile(
        "delete-clients",
        [{ prompt: "one" }],
        workspace,
        "Delete clients"
      );
      const older = await fileManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now() - 1_000
      );
      history = new OutputHistoryManager(workspace);
      await history.initializeRunAt(
        workflowKey,
        older.runRef,
        older.runDir,
        older.runId,
        Date.now() - 1_000
      );
      await history.finalizeRun(
        history.getHistoryFilePath(workflowKey, older.runRef),
        EXECUTION_STATES.COMPLETED,
        1
      );
      const newer = await WorkingFileManager.seedNewRun(
        workspace,
        workflowKey,
        older.runRef
      );
      await history.initializeRunAt(
        workflowKey,
        newer.runRef,
        newer.runDir,
        newer.runId,
        newer.startedAt
      );
      await history.finalizeRun(
        history.getHistoryFilePath(workflowKey, newer.runRef),
        EXECUTION_STATES.COMPLETED,
        1
      );

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.instances = new Map();
      internal.cliSessions = new Map();
      internal.viewAddressRegistry = new Map([
        [PANEL_CLIENT_ID, { workflowKey, kind: "run", runRef: newer.runRef }],
        ["browser:delete", { workflowKey, kind: "run", runRef: newer.runRef }],
        ["browser:older", { workflowKey, kind: "run", runRef: older.runRef }],
      ]);
      const refreshed: Array<{ clientId: string; address: unknown }> = [];
      internal.viewMessageSinks = new Map([
        ["browser:delete", () => undefined],
        ["browser:older", () => undefined],
      ]);
      internal.loadRunViewForClient = async (
        address: unknown,
        _send: unknown,
        clientId: string
      ) => {
        refreshed.push({ clientId, address });
        internal.viewAddressRegistry.set(clientId, address);
      };

      await orchestrator.deleteRunAtAddress(
        { workflowKey, runRef: newer.runRef },
        () => undefined,
        PANEL_CLIENT_ID
      );

      const fallback = { workflowKey, kind: "run", runRef: older.runRef };
      assert.deepStrictEqual(
        orchestrator.getViewAddress(PANEL_CLIENT_ID),
        fallback
      );
      assert.deepStrictEqual(
        orchestrator.getViewAddress("browser:delete"),
        fallback
      );
      assert.deepStrictEqual(
        orchestrator.getViewAddress("browser:older"),
        fallback
      );
      assert.deepStrictEqual(
        refreshed.map(({ clientId }) => clientId).sort(),
        [PANEL_CLIENT_ID, "browser:delete", "browser:older"].sort()
      );
    } finally {
      await history?.flushPendingIndexRefresh();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("loads the current most-recent working file for a first-time browser client", async () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;

    internal.viewerRegistry = new Map<string, string | null>();
    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.currentWorkspaceFolder = {
      uri: { fsPath: "C:\\dev\\ctrlyoke" },
    };
    internal.workspaceSessionManager = {
      getMostRecentWorkingFilePath: async () =>
        "C:\\dev\\ctrlyoke\\.ctrlyoke\\.working\\recent.ctrlyoke.json",
    };

    let loaded: { filePath: string; clientId: string } | undefined;
    internal.loadWorkflowForClient = async (
      filePath: string,
      _send: (msg: unknown) => void,
      clientId: string
    ) => {
      loaded = { filePath, clientId };
    };
    internal.getWorkflowSummaries = () => [];

    const sent: unknown[] = [];
    await orchestrator.handleClientReady("browser:1", (msg) => sent.push(msg));

    assert.deepStrictEqual(loaded, {
      filePath: "C:\\dev\\ctrlyoke\\.ctrlyoke\\.working\\recent.ctrlyoke.json",
      clientId: "browser:1",
    });
    assert.deepStrictEqual(sent, [
      { type: MESSAGE_TYPES.WORKFLOWS_LIST, workflows: [] },
    ]);
  });

  test("falls back to the panel's viewed workflow when no recent working file exists", async () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;

    internal.viewerRegistry = new Map<string, string | null>([
      [PANEL_CLIENT_ID, "panel-workflow-id"],
    ]);
    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.currentWorkspaceFolder = {
      uri: { fsPath: "C:\\dev\\ctrlyoke" },
    };
    internal.workspaceSessionManager = {
      getMostRecentWorkingFilePath: async () => undefined,
    };
    internal.getWorkflowSummaries = () => [];

    let replayed: { workflowId: string; clientId: string } | undefined;
    internal.replayWorkflowStateTo = async (
      workflowId: string,
      _send: (msg: unknown) => void,
      clientId: string
    ) => {
      replayed = { workflowId, clientId };
    };

    const sent: unknown[] = [];
    await orchestrator.handleClientReady("browser:2", (msg) => sent.push(msg));

    assert.deepStrictEqual(replayed, {
      workflowId: "panel-workflow-id",
      clientId: "browser:2",
    });
    assert.deepStrictEqual(sent, [
      { type: MESSAGE_TYPES.WORKFLOWS_LIST, workflows: [] },
    ]);
  });
});

suite("WorkflowOrchestrator draft mutation preparation", () => {
  test("forks only the requesting client's promoted run view and leaves execution/source untouched", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-draft-view-")
    );
    try {
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "source", _runtime: { startedAt: 1 } }],
        getCurrentIndex: () => 1,
        getStatus: () => EXECUTION_STATES.COMPLETED,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Source",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await sourceManager.createWorkingFile(
        "source",
        [{ prompt: "source", _runtime: { startedAt: 1 } }],
        workspace,
        "Source"
      );
      const promoted = await sourceManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      const sourceBefore = await fs.readFile(promoted.workingFilePath, "utf8");

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.viewerRegistry = new Map([
        ["client-a", "source-instance"],
        ["client-b", "execution-instance"],
      ]);
      internal.viewAddressRegistry = new Map([
        ["client-a", { workflowKey, kind: "run", runRef: promoted.runRef }],
        ["client-b", { workflowKey, kind: "run", runRef: promoted.runRef }],
      ]);
      internal.viewMessageSinks = new Map();
      internal.instances = new Map([
        [
          "execution-instance",
          {
            getQueueState: () => ({ workflowKey, runRef: promoted.runRef }),
            getExecutionRunRef: () => promoted.runRef,
          },
        ],
      ]);
      internal.retiredInstances = new Map();
      internal.cliSessions = new Map();

      let loadedFor: string | undefined;
      internal.loadFreshInstanceAndReplay = async (
        draftPath: string,
        clientId: string
      ) => {
        loadedFor = clientId;
        assert.match(draftPath, /draft[\\/]workflow\.ctrlyoke\.json$/);
        internal.viewerRegistry.set(clientId, "draft-instance");
        internal.instances.set("draft-instance", {
          expectDefinitionRevision: () => undefined,
        });
      };
      internal.loadRunViewForClient = async (
        address: unknown,
        _send: unknown,
        clientId: string
      ) => {
        internal.viewAddressRegistry.set(clientId, address);
      };

      await orchestrator.prepareDefinitionMutation(
        {
          address: { workflowKey, kind: "run", runRef: promoted.runRef },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: 2,
        },
        () => undefined,
        "client-a"
      );

      assert.strictEqual(loadedFor, "client-a");
      assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
        workflowKey,
        kind: "draft",
      });
      assert.deepStrictEqual(orchestrator.getViewAddress("client-b"), {
        workflowKey,
        kind: "run",
        runRef: promoted.runRef,
      });
      assert.strictEqual(
        internal.findExecutionRunRef(workflowKey),
        promoted.runRef
      );
      assert.strictEqual(
        await fs.readFile(promoted.workingFilePath, "utf8"),
        sourceBefore
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator active workflow helpers", () => {
  test("getRunningWorkflows includes pausing workflows", () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;

    const running = {
      getQueueState: () => ({ status: EXECUTION_STATES.RUNNING }),
    };
    const pausing = {
      getQueueState: () => ({ status: EXECUTION_STATES.PAUSING }),
    };
    const paused = {
      getQueueState: () => ({ status: EXECUTION_STATES.PAUSED }),
    };

    internal.instances = new Map<string, any>([
      ["running", running],
      ["pausing", pausing],
      ["paused", paused],
    ]);

    assert.deepStrictEqual(orchestrator.getRunningWorkflows(), [
      running,
      pausing,
    ]);
  });
});

suite("WorkflowOrchestrator promoteInstanceToLive", () => {
  // Regression: a multi-step run that briefly hits a terminal state gets retired
  // (moved to retiredInstances), then re-registered as RUNNING on the next step.
  // The re-registration must remove the retired copy so the instance is never in
  // both maps — otherwise the still-running workflow looks "retired" to
  // setViewedWorkflowId/unregisterClient, which can dispose it mid-run.
  test("removes the retired copy when an instance is promoted back to live", () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;

    const instance = { id: "wf-1" };
    internal.instances = new Map<string, any>();
    internal.retiredInstances = new Map<string, any>([["wf-1", instance]]);

    const wasRetired = internal.promoteInstanceToLive(instance);

    assert.strictEqual(wasRetired, true);
    assert.strictEqual(internal.instances.get("wf-1"), instance);
    assert.strictEqual(
      internal.retiredInstances.has("wf-1"),
      false,
      "instance must not remain in retiredInstances after promotion"
    );
  });

  test("reports no stale entry when promoting a never-retired instance", () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;

    const instance = { id: "wf-2" };
    internal.instances = new Map<string, any>();
    internal.retiredInstances = new Map<string, any>();

    const wasRetired = internal.promoteInstanceToLive(instance);

    assert.strictEqual(wasRetired, false);
    assert.strictEqual(internal.instances.get("wf-2"), instance);
  });
});

suite("WorkflowOrchestrator loadWorkflowForClient path matching", () => {
  // Regression: navigation routes are forward-slash normalized, but instance
  // summaries carry native paths (backslashes on Windows). A LOAD_WORKFLOW for
  // a running workflow must resolve to its live instance instead of building a
  // fresh instance from disk (which restores as STOPPED).
  test("matches a live instance whose working file path uses native separators", async () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;

    const nativePath =
      "c:\\dev\\ctrlyoke\\.ctrlyoke\\.runs\\wf\\run-2026-01-01T00-00-00-000Z\\workflow.ctrlyoke.json";
    const routePath =
      "c:/dev/ctrlyoke/.ctrlyoke/.runs/wf/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json";

    const liveInstance = {
      id: "live-1",
      getSummary: () => ({ workingFilePath: nativePath }),
    };

    internal.cliSessions = new Map();
    internal.instances = new Map<string, any>([["live-1", liveInstance]]);
    internal.retiredInstances = new Map<string, any>();
    internal.ensureCliWatchSession = async () => false;

    let viewed: { clientId: string; workflowId: string } | undefined;
    internal.setViewedWorkflowId = (clientId: string, workflowId: string) => {
      viewed = { clientId, workflowId };
    };

    let freshLoaded = false;
    internal.loadFreshInstanceAndReplay = async () => {
      freshLoaded = true;
    };

    let replayedId: string | undefined;
    internal.replayWorkflowStateTo = async (workflowId: string) => {
      replayedId = workflowId;
    };

    await orchestrator.loadWorkflowForClient(
      routePath,
      () => {},
      PANEL_CLIENT_ID
    );

    assert.strictEqual(freshLoaded, false, "must not build a fresh instance");
    assert.deepStrictEqual(viewed, {
      clientId: PANEL_CLIENT_ID,
      workflowId: "live-1",
    });
    assert.strictEqual(replayedId, "live-1");
  });
});

suite("WorkflowOrchestrator addressed start position", () => {
  test("rewinds an explicit historical run without touching the descriptor's latest run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-addressed-rewind-")
    );
    let history: OutputHistoryManager | undefined;
    try {
      const sourceAccess = {
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "prefix" }, { prompt: "suffix" }],
        getCurrentIndex: () => 2,
        getStatus: () => EXECUTION_STATES.COMPLETED,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Addressed",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      };
      const sourceManager = new WorkingFileManager(sourceAccess);
      const { workflowKey } = await sourceManager.createWorkingFile(
        "addressed",
        sourceAccess.getSteps(),
        workspace,
        "Addressed"
      );
      const historical = await sourceManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      history = new OutputHistoryManager(workspace);
      await history.initializeRunAt(
        workflowKey,
        historical.runRef,
        historical.runDir,
        historical.runId,
        Date.now()
      );
      const latest = await WorkingFileManager.seedNewRun(
        workspace,
        workflowKey,
        historical.runRef
      );
      const latestBefore = await fs.readFile(latest.workingFilePath, "utf8");

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.instances = new Map();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          { workflowKey, kind: "run", runRef: historical.runRef },
        ],
        [
          "browser:rewind",
          { workflowKey, kind: "run", runRef: historical.runRef },
        ],
      ]);
      internal.viewMessageSinks = new Map([
        [PANEL_CLIENT_ID, () => undefined],
        ["browser:rewind", () => undefined],
      ]);
      internal.lineageRepository = new WorkflowLineageRepository();

      const result = await orchestrator.setStartPositionAtRun(
        { workflowKey, runRef: historical.runRef },
        1,
        1,
        3,
        PANEL_CLIENT_ID
      );

      assert.strictEqual(result.kind, "rewind");
      assert.strictEqual(
        await fs.readFile(latest.workingFilePath, "utf8"),
        latestBefore
      );
      const rewound = JSON.parse(
        await fs.readFile(historical.workingFilePath, "utf8")
      );
      assert.strictEqual(rewound._runtime.pendingRewind.fromStepIndex, 1);
      assert.strictEqual(rewound.steps[1]._runtime, undefined);
      const events = (
        await fs.readFile(path.join(historical.runDir, "events.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepStrictEqual(events[0].payload.definition.rewindBoundary, 1);
      assert.strictEqual(events[0].payload.definitionRevision, 2);
    } finally {
      await history?.flushPendingIndexRefresh();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator explicit append and continue", () => {
  async function createRun(workspace: string): Promise<{
    workflowKey: import("../../types/CtrlYokeTypes").WorkflowKey;
    runRef: import("../../types/CtrlYokeTypes").RunRef;
    workingFilePath: string;
  }> {
    const manager = new WorkingFileManager({
      getWorkingFilePath: () => undefined,
      getSteps: () => [{ prompt: "prefix" }],
      getCurrentIndex: () => 1,
      getStatus: () => EXECUTION_STATES.COMPLETED,
      getDefinitionRevision: () => 1,
      setDefinitionRevision: () => undefined,
      getWorkflowName: () => "Continuation",
      mergeDiskSteps: () => [],
      emitStateChange: () => undefined,
      getFinalStepRuntime: () => undefined,
      updateWorkflowProperty: () => undefined,
    });
    const { workflowKey } = await manager.createWorkingFile(
      "continuation",
      [{ prompt: "prefix" }],
      workspace,
      "Continuation"
    );
    const promoted = await manager.promoteToNewRun(
      workspace,
      workflowKey,
      Date.now()
    );
    return { workflowKey, ...promoted };
  }

  function createHarness(
    workspace: string,
    workflowKey: import("../../types/CtrlYokeTypes").WorkflowKey,
    runRef: import("../../types/CtrlYokeTypes").RunRef,
    instance?: any
  ): { orchestrator: WorkflowOrchestrator; internal: any } {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
    internal.instances = new Map(instance ? [["active", instance]] : []);
    internal.viewAddressRegistry = new Map([
      [PANEL_CLIENT_ID, { workflowKey, kind: "run", runRef }],
    ]);
    internal.viewMessageSinks = new Map();
    internal.lineageRepository = new WorkflowLineageRepository();
    internal.invalidateRunViews = async () => undefined;
    return { orchestrator, internal };
  }

  test("targets a historical run explicitly rather than mutating the latest run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-explicit-append-")
    );
    try {
      const historical = await createRun(workspace);
      const latest = await WorkingFileManager.seedNewRun(
        workspace,
        historical.workflowKey,
        historical.runRef
      );
      const latestBefore = await fs.readFile(latest.workingFilePath, "utf8");
      const { orchestrator, internal } = createHarness(
        workspace,
        historical.workflowKey,
        historical.runRef
      );
      let executed: [string, string, number] | undefined;
      internal.buildWorkflowInstance = () => ({
        executeContinuationAtRun: async (...args: [string, string, number]) => {
          executed = args;
        },
      });

      await orchestrator.appendAndContinueAtRun(
        { workflowKey: historical.workflowKey, runRef: historical.runRef },
        [{ prompt: "tail" }],
        1,
        3,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(executed, [
        historical.workflowKey,
        historical.runRef,
        2,
      ]);
      assert.strictEqual(
        await fs.readFile(latest.workingFilePath, "utf8"),
        latestBefore
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("permits paused continuation only when the live owner targets the same run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-paused-continue-")
    );
    try {
      const run = await createRun(workspace);
      const paused = {
        getQueueState: () => ({
          workflowKey: run.workflowKey,
          status: EXECUTION_STATES.PAUSED,
        }),
        getExecutionRunRef: () => run.runRef,
        executeContinuationAtRun: async () => undefined,
      };
      const file = JSON.parse(await fs.readFile(run.workingFilePath, "utf8"));
      file._runtime.executionState = EXECUTION_STATES.PAUSED;
      await fs.writeFile(run.workingFilePath, JSON.stringify(file), "utf8");
      const { orchestrator } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef,
        paused
      );

      await assert.doesNotReject(() =>
        orchestrator.continueAtRun(
          { workflowKey: run.workflowKey, runRef: run.runRef },
          1,
          2,
          PANEL_CLIENT_ID
        )
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a continuation while another run in the lineage owns execution", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-busy-continue-")
    );
    try {
      const run = await createRun(workspace);
      const busy = {
        getQueueState: () => ({
          workflowKey: run.workflowKey,
          status: EXECUTION_STATES.PAUSED,
        }),
        getExecutionRunRef: () => "run-other",
      };
      const { orchestrator } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef,
        busy
      );
      await assert.rejects(
        () =>
          orchestrator.continueAtRun(
            { workflowKey: run.workflowKey, runRef: run.runRef },
            1,
            2,
            PANEL_CLIENT_ID
          ),
        /Another run in this workflow lineage is executing/
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("allows an interrupted running file to be rebound only through explicit continuation", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-crash-continue-")
    );
    try {
      const run = await createRun(workspace);
      const file = JSON.parse(await fs.readFile(run.workingFilePath, "utf8"));
      file._runtime.executionState = EXECUTION_STATES.RUNNING;
      await fs.writeFile(run.workingFilePath, JSON.stringify(file), "utf8");
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let called = false;
      internal.buildWorkflowInstance = () => ({
        executeContinuationAtRun: async () => {
          called = true;
        },
      });

      await orchestrator.continueAtRun(
        { workflowKey: run.workflowKey, runRef: run.runRef },
        1,
        2,
        PANEL_CLIENT_ID
      );
      assert.strictEqual(called, true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
