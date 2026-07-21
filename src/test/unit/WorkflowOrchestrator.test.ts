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
  QUEUE_POSITION,
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

/**
 * A client already bound to instance "instance-bound" of lineage "bound",
 * with the replay and fresh-instance seams recorded instead of executed.
 */
function createLineageBindingHarness() {
  const orchestrator = Object.create(
    WorkflowOrchestrator.prototype
  ) as WorkflowOrchestrator;
  const internal = orchestrator as any;
  const boundKey = "bound" as never;

  internal.currentWorkspaceFolder = { uri: { fsPath: path.join("/", "ws") } };
  internal.instances = new Map<string, unknown>([
    [
      "instance-bound",
      {
        id: "instance-bound",
        getQueueState: () => ({ workflowKey: boundKey }),
      },
    ],
  ]);
  internal.retiredInstances = new Map<string, unknown>();
  internal.cliSessions = new Map<string, unknown>();
  internal.viewerRegistry = new Map([["client-a", "instance-bound"]]);
  internal.viewAddressRegistry = new Map();
  internal.viewMessageSinks = new Map();
  internal.lineageBindingClients = new Set<string>();

  const replays: string[] = [];
  const freshLoads: string[] = [];
  internal.replayWorkflowStateTo = async (workflowId: string) => {
    replays.push(workflowId);
  };
  internal.loadFreshInstanceAndReplay = async (filePath: string) => {
    freshLoads.push(filePath);
  };

  return { orchestrator, internal, boundKey, replays, freshLoads };
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

  test("registers the client's view sink so draft viewers follow their promoted run", async () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    const workflowKey = "demo" as never;
    const runRef = "run-2026-07-20T10-30-00-000Z" as never;

    internal.viewerRegistry = new Map();
    internal.viewAddressRegistry = new Map();
    internal.viewMessageSinks = new Map();

    // A client that never explicitly loaded a run view still has to be
    // reachable, otherwise it never learns its draft was promoted to a run.
    const send = () => undefined;
    orchestrator.registerClient("client-a", send);
    internal.viewerRegistry.set("client-a", "instance-1");
    internal.viewAddressRegistry.set("client-a", {
      workflowKey,
      kind: "draft",
    });

    const loaded: unknown[] = [];
    internal.loadRunViewForClient = async (address: unknown) => {
      loaded.push(address);
    };
    internal.syncExecutingRunViews({
      id: "instance-1",
      getQueueState: () => ({ workflowKey, runRef }),
    });

    assert.deepStrictEqual(loaded, [{ workflowKey, kind: "run", runRef }]);
  });

  test("binds a switching client to the addressed lineage's resident instance", async () => {
    const { internal, replays } = createLineageBindingHarness();
    const other = "other" as never;

    internal.instances.set("instance-other", {
      id: "instance-other",
      getQueueState: () => ({ workflowKey: other }),
    });

    await internal.bindClientToAddressedLineage(
      { workflowKey: other, kind: "draft" },
      () => undefined,
      "client-a"
    );

    // Without this the client keeps editing/running/terminalling the workflow
    // it was bound to before the switch.
    assert.deepStrictEqual(replays, ["instance-other"]);
  });

  test("leaves the binding alone when the address is another run of the same lineage", async () => {
    const { internal, replays } = createLineageBindingHarness();

    await internal.bindClientToAddressedLineage(
      {
        workflowKey: "bound" as never,
        kind: "run",
        runRef: "run-2026-07-19T10-30-00-000Z" as never,
      },
      () => undefined,
      "client-a"
    );

    assert.deepStrictEqual(replays, []);
  });

  test("prefers a live instance over a retired duplicate of the same lineage", async () => {
    const { internal, replays } = createLineageBindingHarness();
    const other = "other" as never;

    internal.retiredInstances.set("instance-retired", {
      id: "instance-retired",
      getQueueState: () => ({ workflowKey: other }),
    });
    internal.instances.set("instance-live", {
      id: "instance-live",
      getQueueState: () => ({ workflowKey: other }),
    });

    await internal.bindClientToAddressedLineage(
      { workflowKey: other, kind: "draft" },
      () => undefined,
      "client-a"
    );

    assert.deepStrictEqual(replays, ["instance-live"]);
  });

  test("materializes an addressed instance only when the lineage has none resident", async () => {
    const { internal, freshLoads } = createLineageBindingHarness();
    const other = "other" as never;
    const runRef = "run-2026-07-21T10-30-00-000Z" as never;

    await internal.bindClientToAddressedLineage(
      { workflowKey: other, kind: "run", runRef },
      () => undefined,
      "client-a"
    );

    assert.strictEqual(freshLoads.length, 1);
    assert.ok(
      freshLoads[0].endsWith(
        path.join(other, runRef, "workflow.ctrlyoke.json")
      ),
      `unexpected addressed file path: ${freshLoads[0]}`
    );
  });

  test("does not re-enter while the replay loads its own run view", async () => {
    const { internal, replays } = createLineageBindingHarness();
    const other = "other" as never;
    const address = { workflowKey: other, kind: "draft" as const };

    internal.instances.set("instance-other", {
      id: "instance-other",
      getQueueState: () => ({ workflowKey: other }),
    });
    // replayWorkflowStateTo loads a run view, which re-enters the binder. A
    // definition with no workflowKey would otherwise never satisfy
    // the already-bound check and would recurse forever.
    internal.replayWorkflowStateTo = async (workflowId: string) => {
      replays.push(workflowId);
      await internal.bindClientToAddressedLineage(
        address,
        () => undefined,
        "client-a"
      );
    };

    await internal.bindClientToAddressedLineage(
      address,
      () => undefined,
      "client-a"
    );

    assert.deepStrictEqual(replays, ["instance-other"]);
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

  test("loads the current most-recent run file for a first-time browser client", async () => {
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
        "C:\\dev\\ctrlyoke\\.ctrlyoke\\.runs\\recent-2026-07-20T10-30-00\\run-2026-07-20T10-31-00-000Z\\workflow.ctrlyoke.json",
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
      filePath:
        "C:\\dev\\ctrlyoke\\.ctrlyoke\\.runs\\recent-2026-07-20T10-30-00\\run-2026-07-20T10-31-00-000Z\\workflow.ctrlyoke.json",
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

  test("loads the addressed run view before replaying live output to a reconnecting client", async () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    const workflowId = "workflow-live";
    const workflowKey = "live-lineage" as never;
    const runRef = "run-2026-07-21T12-00-00-000Z" as never;
    const operations: string[] = [];

    internal.viewerRegistry = new Map<string, string | null>();
    internal.viewAddressRegistry = new Map();
    internal.instances = new Map([
      [
        workflowId,
        {
          getSummary: () => ({ workingFilePath: "C:\\workflow.json" }),
          getQueueState: () => ({ workflowKey, runRef }),
          replayFullStateTo: () => operations.push("live-output"),
          replayRunHistoryTo: async () => operations.push("run-history"),
          replayOutputHistoryTo: async () => operations.push("output-history"),
        },
      ],
    ]);
    internal.retiredInstances = new Map();
    internal.cliSessions = new Map();
    internal.getActiveTerminalWorkflowRefs = () => [];
    internal.loadRunViewForClient = async (
      address: unknown,
      _send: (message: unknown) => void,
      clientId: string
    ) => {
      assert.strictEqual(
        internal.viewerRegistry.get(clientId),
        workflowId,
        "the client must be bound before addressed loading awaits"
      );
      assert.deepStrictEqual(address, { workflowKey, kind: "run", runRef });
      operations.push("run-view");
    };

    await orchestrator.replayWorkflowStateTo(
      workflowId,
      () => undefined,
      "browser:reconnect",
      { skipTerminalReplay: true }
    );

    assert.deepStrictEqual(operations, [
      "run-view",
      "live-output",
      "run-history",
      "output-history",
    ]);
  });
});

suite("WorkflowOrchestrator draft mutation preparation", () => {
  test("validates a promoted run's edit in place, primes the live instance's revision guard, and never forks a draft", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-edit-")
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
      const repository = new WorkflowLineageRepository();
      const descriptor = await repository.readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.lineageRepository = repository;
      internal.viewerRegistry = new Map([
        ["client-a", "source-instance"],
        ["client-b", "execution-instance"],
      ]);
      internal.viewAddressRegistry = new Map([
        ["client-a", { workflowKey, kind: "run", runRef: promoted.runRef }],
        ["client-b", { workflowKey, kind: "run", runRef: promoted.runRef }],
      ]);
      internal.viewMessageSinks = new Map();
      let primedRevision: number | undefined;
      internal.instances = new Map([
        [
          "execution-instance",
          {
            getQueueState: () => ({ workflowKey, runRef: promoted.runRef }),
            getExecutionRunRef: () => promoted.runRef,
            expectDefinitionRevision: (revision: number) => {
              primedRevision = revision;
            },
          },
        ],
      ]);
      internal.retiredInstances = new Map();
      internal.cliSessions = new Map();
      internal.loadFreshInstanceAndReplay = async () => {
        throw new Error("An idle run edit must not fork a draft");
      };

      await orchestrator.prepareDefinitionMutation(
        {
          address: { workflowKey, kind: "run", runRef: promoted.runRef },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        "client-a"
      );

      assert.strictEqual(primedRevision, 1);
      assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
        workflowKey,
        kind: "run",
        runRef: promoted.runRef,
      });
      assert.deepStrictEqual(orchestrator.getViewAddress("client-b"), {
        workflowKey,
        kind: "run",
        runRef: promoted.runRef,
      });
      assert.strictEqual(
        await fs.readFile(promoted.workingFilePath, "utf8"),
        sourceBefore
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("keeps workflow property edits on the actively executing run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-properties-")
    );
    try {
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "source" }],
        getCurrentIndex: () => 0,
        getStatus: () => EXECUTION_STATES.RUNNING,
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
        [{ prompt: "source" }],
        workspace,
        "Source"
      );
      const promoted = await sourceManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      const repository = new WorkflowLineageRepository();
      const descriptor = await repository.readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      let expectedRevision: number | undefined;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.lineageRepository = repository;
      internal.viewerRegistry = new Map([["client-a", "execution-instance"]]);
      internal.viewAddressRegistry = new Map([
        ["client-a", { workflowKey, kind: "run", runRef: promoted.runRef }],
      ]);
      internal.instances = new Map([
        [
          "execution-instance",
          {
            getQueueState: () => ({
              workflowKey,
              runRef: promoted.runRef,
            }),
            getExecutionRunRef: () => promoted.runRef,
            expectDefinitionRevision: (revision: number) => {
              expectedRevision = revision;
            },
          },
        ],
      ]);
      internal.retiredInstances = new Map();
      internal.cliSessions = new Map();
      internal.loadFreshInstanceAndReplay = () => {
        throw new Error("An executing run must not fork a draft for settings");
      };

      await orchestrator.prepareWorkflowPropertiesMutation(
        {
          address: { workflowKey, kind: "run", runRef: promoted.runRef },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        "client-a"
      );

      assert.strictEqual(expectedRevision, 1);
      assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
        workflowKey,
        kind: "run",
        runRef: promoted.runRef,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator run-addressed step edits", () => {
  test("edits an idle run's steps directly on disk when no live instance owns it, without creating a draft", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-static-edit-")
    );
    try {
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [
          { prompt: "keep", _runtime: { startedAt: 1 } },
          { prompt: "delete-me", _runtime: { startedAt: 2 } },
        ],
        getCurrentIndex: () => 2,
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
        [{ prompt: "keep" }, { prompt: "delete-me" }],
        workspace,
        "Source"
      );
      const promoted = await sourceManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      const repository = new WorkflowLineageRepository();
      const descriptor = await repository.readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.lineageRepository = repository;
      internal.instances = new Map();
      internal.retiredInstances = new Map();
      internal.cliSessions = new Map();
      internal.viewAddressRegistry = new Map([
        ["client-a", { workflowKey, kind: "run", runRef: promoted.runRef }],
      ]);
      internal.viewMessageSinks = new Map([["client-a", () => undefined]]);

      await orchestrator.deletePromptFromQueue(
        {
          address: { workflowKey, kind: "run", runRef: promoted.runRef },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        1,
        "client-a"
      );

      const written = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf8")
      );
      assert.strictEqual(written.steps.length, 1);
      assert.strictEqual(written.steps[0].prompt, "keep");
      assert.strictEqual(written.definitionRevision, 2);

      const draftExists = await fs
        .access(
          path.join(
            workspace,
            ".ctrlyoke",
            ".runs",
            workflowKey,
            "draft",
            "workflow.ctrlyoke.json"
          )
        )
        .then(() => true)
        .catch(() => false);
      assert.strictEqual(draftExists, false);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("routes to the run's own live instance, not the client's unrelated bound instance", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-live-edit-")
    );
    try {
      const wf1 =
        "wf-1" as unknown as import("../../types/CtrlYokeTypes").WorkflowKey;
      const run1 =
        "run-1" as unknown as import("../../types/CtrlYokeTypes").RunRef;
      const wf2 =
        "wf-2" as unknown as import("../../types/CtrlYokeTypes").WorkflowKey;
      const run2 =
        "run-2" as unknown as import("../../types/CtrlYokeTypes").RunRef;

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.viewerRegistry = new Map([["client-a", "unrelated-instance"]]);
      internal.viewAddressRegistry = new Map([
        ["client-a", { workflowKey: wf1, kind: "run", runRef: run1 }],
      ]);
      internal.viewMessageSinks = new Map();

      const deletedFrom: string[] = [];
      const runOwningInstance = {
        getQueueState: () => ({ workflowKey: wf1, runRef: run1 }),
        deletePromptFromQueue: async () => {
          deletedFrom.push("run-owning-instance");
        },
      };
      const unrelatedInstance = {
        getQueueState: () => ({ workflowKey: wf2, runRef: run2 }),
        deletePromptFromQueue: async () => {
          deletedFrom.push("unrelated-instance");
        },
      };
      internal.instances = new Map([
        ["run-owning-instance", runOwningInstance],
        ["unrelated-instance", unrelatedInstance],
      ]);
      internal.retiredInstances = new Map();
      internal.cliSessions = new Map();

      await orchestrator.deletePromptFromQueue(
        {
          address: { workflowKey: wf1, kind: "run", runRef: run1 },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: 1,
        },
        0,
        "client-a"
      );

      assert.deepStrictEqual(deletedFrom, ["run-owning-instance"]);
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
    internal.retiredInstances = new Map();
    internal.cliSessions = new Map();
    internal.viewerRegistry = new Map();
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

      assert.deepStrictEqual(executed?.slice(0, 3), [
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

  test("re-run closes the source terminal and switches the initiating client before execution", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-rerun-switch-")
    );
    try {
      const source = await createRun(workspace);
      const descriptor = await new WorkflowLineageRepository().readDescriptor(
        workspace,
        source.workflowKey
      );
      const { orchestrator, internal } = createHarness(
        workspace,
        source.workflowKey,
        source.runRef
      );
      let sourceCloseCalls = 0;
      const sourceInstance = {
        id: "source-instance",
        getQueueState: () => ({
          workflowKey: source.workflowKey,
          runRef: source.runRef,
        }),
        closeRetainedTerminalsForFreshRun: async () => {
          sourceCloseCalls += 1;
        },
      };
      internal.retiredInstances.set(sourceInstance.id, sourceInstance);
      internal.viewerRegistry.set(PANEL_CLIENT_ID, sourceInstance.id);
      internal.viewMessageSinks.set(PANEL_CLIENT_ID, () => undefined);

      const replayed: string[] = [];
      internal.replayWorkflowStateTo = async (instanceId: string) => {
        replayed.push(instanceId);
      };
      let preparedRunRef: string | undefined;
      const executionInstance = {
        id: "seeded-instance",
        getQueueState: () => ({
          workflowKey: source.workflowKey,
          runRef: preparedRunRef,
        }),
        executeSeededRun: async (
          seeded: { runRef: string },
          _workflowKey: string,
          _harness: unknown,
          onPrepared: () => Promise<void>
        ) => {
          preparedRunRef = seeded.runRef;
          await onPrepared();
        },
      };
      internal.buildWorkflowInstance = () => executionInstance;

      const result = await orchestrator.seedAndExecuteAtRun(
        { workflowKey: source.workflowKey, runRef: source.runRef },
        1,
        descriptor.revision,
        PANEL_CLIENT_ID
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(sourceCloseCalls, 1);
      assert.strictEqual(preparedRunRef, result.runRef);
      assert.deepStrictEqual(replayed, [executionInstance.id]);
      assert.strictEqual(
        internal.retiredInstances.get(executionInstance.id),
        executionInstance,
        "the prepared run must be addressable during the client switch"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("same-run continuation reuses the retired run owner and switches before executing", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-continue-owner-")
    );
    try {
      const run = await createRun(workspace);
      const descriptor = await new WorkflowLineageRepository().readDescriptor(
        workspace,
        run.workflowKey
      );
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let executionArgs: unknown[] | undefined;
      const resident = {
        id: "retired-run-owner",
        getQueueState: () => ({
          workflowKey: run.workflowKey,
          runRef: run.runRef,
        }),
        executeContinuationAtRun: async (...args: unknown[]) => {
          executionArgs = args;
          await (args[3] as () => Promise<void>)();
        },
      };
      internal.retiredInstances.set(resident.id, resident);
      internal.viewerRegistry.set(PANEL_CLIENT_ID, resident.id);
      internal.viewMessageSinks.set(PANEL_CLIENT_ID, () => undefined);
      internal.buildWorkflowInstance = () => {
        throw new Error("must reuse the exact resident run owner");
      };
      const replayed: string[] = [];
      internal.replayWorkflowStateTo = async (instanceId: string) => {
        replayed.push(instanceId);
      };

      await orchestrator.appendAndContinueAtRun(
        { workflowKey: run.workflowKey, runRef: run.runRef },
        [{ prompt: "continued tail" }],
        1,
        descriptor.revision,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(executionArgs?.slice(0, 3), [
        run.workflowKey,
        run.runRef,
        2,
      ]);
      assert.deepStrictEqual(replayed, [resident.id]);
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

  test("appendFromFileForClient with a run-kind mutation parses the file and continues the addressed run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-append-file-run-")
    );
    try {
      const run = await createRun(workspace);
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let parsedPath: string | undefined;
      internal.promptFileParser = {
        parsePromptFile: async (filePath: string) => {
          parsedPath = filePath;
          return { steps: [{ prompt: "from file" }] };
        },
      };
      let executed: [string, string, number] | undefined;
      internal.buildWorkflowInstance = () => ({
        executeContinuationAtRun: async (...args: [string, string, number]) => {
          executed = args;
        },
      });
      const descriptor = await internal.lineageRepository.readDescriptor(
        workspace,
        run.workflowKey
      );

      await orchestrator.appendFromFileForClient(
        {
          address: {
            workflowKey: run.workflowKey,
            kind: "run",
            runRef: run.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        "/fake/prompts.ctrlyoke.yaml",
        PANEL_CLIENT_ID
      );

      assert.strictEqual(parsedPath, "/fake/prompts.ctrlyoke.yaml");
      assert.deepStrictEqual(executed?.slice(0, 3), [
        run.workflowKey,
        run.runRef,
        2,
      ]);
      const written = JSON.parse(
        await fs.readFile(run.workingFilePath, "utf8")
      );
      assert.strictEqual(written.steps.length, 2);
      assert.strictEqual(written.steps[1].prompt, "from file");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("appendFromFileForClient with no mutation keeps the legacy instance-bound queue-only append", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-append-file-legacy-")
    );
    try {
      const run = await createRun(workspace);
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let parseCalled = false;
      internal.promptFileParser = {
        parsePromptFile: async () => {
          parseCalled = true;
          return { steps: [{ prompt: "should not be used" }] };
        },
      };
      let appended: [string, string | undefined] | undefined;
      const legacyInstance = {
        appendFromFile: async (filePath: string, position?: string) => {
          appended = [filePath, position];
        },
      };
      internal.viewerRegistry = new Map([[PANEL_CLIENT_ID, "legacy-instance"]]);
      internal.instances = new Map([["legacy-instance", legacyInstance]]);
      internal.retiredInstances = new Map();

      await orchestrator.appendFromFileForClient(
        undefined,
        "/fake/legacy.ctrlyoke.yaml",
        PANEL_CLIENT_ID,
        QUEUE_POSITION.END
      );

      assert.strictEqual(parseCalled, false);
      assert.deepStrictEqual(appended, [
        "/fake/legacy.ctrlyoke.yaml",
        QUEUE_POSITION.END,
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator client view addressing", () => {
  test("adopts an instance's own lineage for the clients bound to it", () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    const previousKey = "previous-lineage" as never;
    const newKey = "new-lineage" as never;

    internal.viewerRegistry = new Map([
      ["client-a", "new-instance"],
      ["client-b", "other-instance"],
    ]);
    internal.viewAddressRegistry = new Map([
      ["client-a", { workflowKey: previousKey, kind: "draft" }],
      ["client-b", { workflowKey: previousKey, kind: "draft" }],
    ]);

    internal.adoptInstanceLineageAddress(
      { id: "new-instance" },
      {
        workflowKey: newKey,
      }
    );

    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey: newKey,
      kind: "draft",
    });
    assert.deepStrictEqual(orchestrator.getViewAddress("client-b"), {
      workflowKey: previousKey,
      kind: "draft",
    });
  });

  test("addresses a promoted run rather than the lineage draft", () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    const workflowKey = "promoted-lineage" as never;
    const runRef = "run-2026-07-21T10-00-00-000Z" as never;

    internal.viewerRegistry = new Map([["client-a", "instance"]]);
    internal.viewAddressRegistry = new Map([
      ["client-a", { workflowKey, kind: "draft" }],
    ]);

    internal.adoptInstanceLineageAddress(
      { id: "instance" },
      {
        workflowKey,
        runRef,
      }
    );

    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey,
      kind: "run",
      runRef,
    });
  });

  test("drops the previous lineage's address when a client switches to a blank workflow", () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;

    internal.viewerRegistry = new Map([["client-a", "old-instance"]]);
    internal.viewAddressRegistry = new Map([
      ["client-a", { workflowKey: "old-lineage" as never, kind: "draft" }],
    ]);
    internal.instances = new Map([
      ["blank-instance", { getQueueState: () => ({}) }],
    ]);
    internal.retiredInstances = new Map();

    internal.setViewedWorkflowId("client-a", "blank-instance");

    assert.strictEqual(orchestrator.getViewAddress("client-a"), null);
  });

  test("reports the on-disk revisions a client's next mutation must carry", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-view-identity-")
    );
    try {
      const fileManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [],
        getCurrentIndex: () => 0,
        getStatus: () => EXECUTION_STATES.IDLE,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Identity",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey, workingFilePath } =
        await fileManager.createWorkingFile(
          "identity",
          [{ prompt: "one" }],
          workspace,
          "Identity"
        );
      const draft = JSON.parse(await fs.readFile(workingFilePath, "utf8"));
      draft.definitionRevision = 7;
      await fs.writeFile(workingFilePath, JSON.stringify(draft));

      const repository = new WorkflowLineageRepository();
      const descriptor = await repository.readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      const internal = orchestrator as any;
      internal.currentWorkspaceFolder = { uri: { fsPath: workspace } };
      internal.lineageRepository = repository;
      internal.viewAddressRegistry = new Map([
        ["client-a", { workflowKey, kind: "draft" }],
      ]);

      const identity = await orchestrator.getViewIdentity("client-a");

      assert.deepStrictEqual(identity, {
        type: MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY,
        address: { workflowKey, kind: "draft" },
        definitionRevision: 7,
        descriptorRevision: descriptor.revision,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("hands the revisions a write produced to every viewer of that address", async () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    const identity = {
      type: MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY,
      address: { workflowKey: "wf-1", kind: "draft" },
      definitionRevision: 4,
      descriptorRevision: 2,
    };
    internal.getViewIdentity = async () => identity;
    internal.viewAddressRegistry = new Map([
      ["writer", { workflowKey: "wf-1", kind: "draft" }],
      ["same-address", { workflowKey: "wf-1", kind: "draft" }],
      ["other-workflow", { workflowKey: "wf-2", kind: "draft" }],
      ["other-run", { workflowKey: "wf-1", kind: "run", runRef: "run-1" }],
    ]);
    const received: Record<string, unknown[]> = {
      writer: [],
      "same-address": [],
      "other-workflow": [],
      "other-run": [],
    };
    internal.viewMessageSinks = new Map(
      Object.keys(received).map((clientId) => [
        clientId,
        (message: unknown) => received[clientId].push(message),
      ])
    );

    const published = await orchestrator.publishViewIdentityToViewers("writer");

    assert.strictEqual(published, identity);
    assert.deepStrictEqual(received["same-address"], [identity]);
    // The acting client is served by its own scoped channel, and clients on a
    // different address keep the revisions their own address published.
    assert.deepStrictEqual(received["writer"], []);
    assert.deepStrictEqual(received["other-workflow"], []);
    assert.deepStrictEqual(received["other-run"], []);
  });

  test("has no identity to publish before a client's workflow has a lineage", async () => {
    const orchestrator = Object.create(
      WorkflowOrchestrator.prototype
    ) as WorkflowOrchestrator;
    const internal = orchestrator as any;
    internal.currentWorkspaceFolder = { uri: { fsPath: os.tmpdir() } };
    internal.viewAddressRegistry = new Map([["client-a", null]]);

    assert.strictEqual(await orchestrator.getViewIdentity("client-a"), null);
  });
});
