import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
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
        "C:\\dev\\ctrlyoke\\.ctrlyoke\\.queue\\recent.flightpath.json",
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
        "C:\\dev\\ctrlyoke\\.ctrlyoke\\.queue\\recent.flightpath.json",
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
      "c:\\dev\\ctrlyoke\\.ctrlyoke\\.queue\\wf.flightpath.json";
    const routePath = "c:/dev/ctrlyoke/.ctrlyoke/.queue/wf.flightpath.json";

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
