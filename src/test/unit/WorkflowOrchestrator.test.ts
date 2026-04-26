import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowOrchestrator } from "../../flightpath/WorkflowOrchestrator";
import { MESSAGE_TYPES, PANEL_CLIENT_ID } from "../../types/DashboardConstants";

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
      uri: { fsPath: "C:\\dev\\FlightPath" },
    };
    internal.workspaceSessionManager = {
      getMostRecentWorkingFilePath: async () =>
        "C:\\dev\\FlightPath\\.flightpath\\.queue\\recent.flightpath.json",
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
        "C:\\dev\\FlightPath\\.flightpath\\.queue\\recent.flightpath.json",
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
      uri: { fsPath: "C:\\dev\\FlightPath" },
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
