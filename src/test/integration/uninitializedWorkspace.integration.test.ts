import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import { TemplateManager } from "../../core/TemplateManager";
import type { KeyValueStore } from "../../core/HostPorts";
import type { UserFeedbackSink } from "../../core/UserFeedbackSink";
import { DashboardApplication } from "../../ui/DashboardApplication";
import { NodeFileWatcherFactory } from "../../platform/NodeFileWatcher";
import { NodeDashboardHostActions } from "../../platform/NodeDashboardHostActions";
import { MemorySecretStore } from "../../platform/SecretStore";
import {
  HARNESS_IDS,
  MESSAGE_TYPES,
  RUNNER_IDS,
} from "../../types/DashboardConstants";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { MockPlatform } from "../helpers/mockHarness";

class MemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class SilentUserFeedbackSink implements UserFeedbackSink {
  notify(): void {}
}

/** Lets fire-and-forget startup writes (watch sessions, capability refreshes) land. */
const STRAY_WRITE_SETTLE_MS = 250;

/**
 * A folder ctrlyoke has never seen must stay untouched while the dashboard
 * shows "Initialize ctrlyoke here?". `.ctrlyoke/` is not just clutter: its
 * mere existence makes `WorkspaceInitializer.isInitialized` true, so a single
 * stray write silently opts the folder in on every later activation.
 *
 * This composes the same orchestrator + dashboard stack `extension.ts` does,
 * with startup gated exactly as it gates an uninitialized folder.
 */
suite("Uninitialized workspace startup", function () {
  // Startup probes every installed harness CLI, which is slow on a busy host.
  this.timeout(60_000);

  let tempRoot: string;
  let workspaceRoot: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let dashboard: DashboardApplication | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-uninitialized-")
    );
    // Not a Git repository, so execution-root-scoped storage (the
    // coordination board) falls back to `<root>/.ctrlyoke/`.
    workspaceRoot = path.join(tempRoot, "Tracing");
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "# Notes\n");
  });

  teardown(async () => {
    orchestrator?.dispose();
    orchestrator = undefined;
    dashboard?.dispose();
    dashboard = undefined;
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 30,
      retryDelay: 100,
    });
  });

  function composeStack(posted: unknown[]): {
    orchestrator: WorkflowOrchestrator;
    dashboard: DashboardApplication;
  } {
    const platform = new MockPlatform(workspaceRoot);
    const actions = new NodeDashboardHostActions();
    const fileWatcherFactory = new NodeFileWatcherFactory();
    const workspaceState = new MemoryKeyValueStore();
    const app = new DashboardApplication({
      templateManager: new TemplateManager(
        path.resolve(__dirname, "../../.."),
        () => workspaceRoot,
        platform,
        () => undefined
      ),
      postMessage: (message) => posted.push(message),
      isPanelReady: () => true,
      resolveImageWebviewUri: () => undefined,
      getServerUrl: () => undefined,
      getAvailableIps: () => [],
      getPortFallback: () => undefined,
      getBindAddressFallback: () => undefined,
      keyValueStore: workspaceState,
      secretStore: new MemorySecretStore(),
      getWorkspaceRoot: () => workspaceRoot,
      getNamedRoots: () => [
        { name: path.basename(workspaceRoot), fsPath: workspaceRoot },
      ],
      getTrustedRoots: () => [workspaceRoot],
      actions,
      hostDependencies: { fileWatcherFactory },
      onPanelReady: () => true,
      handleClearWorkflow: async () => undefined,
      updateWorkflowName: () => undefined,
      getDevStatus: async () => undefined,
      notifyActiveWorkflowChanged: () => undefined,
    });
    const workflowOrchestrator = new WorkflowOrchestrator({
      platform,
      dashboardHostActions: actions,
      workspaceFolderPathResolver: () => workspaceRoot,
      dashboardProvider: app,
      userFeedbackSink: new SilentUserFeedbackSink(),
      runnerHostIdentity: {
        runner: RUNNER_IDS.VSCODE,
        hostInstanceId: randomUUID(),
        pid: process.pid,
      },
      fileWatcherFactory,
      disposableRegistry: { add: () => undefined },
      workspaceState,
      isWorkspaceTrusted: () => true,
      userInteractionPort: app.interactionPort,
    });
    // extension.ts sets this before initialize(), for any folder where
    // WorkspaceInitializer.isInitialized() is false.
    workflowOrchestrator.setWorkspaceInitPending(workspaceRoot);
    app.setWorkflowOrchestrator(workflowOrchestrator);
    app.setHub(workflowOrchestrator.getDashboardBroadcastHub());
    workflowOrchestrator.getDashboardBroadcastHub().addClient(app);
    app.start();
    return { orchestrator: workflowOrchestrator, dashboard: app };
  }

  async function listCtrlyokeDir(): Promise<string[] | undefined> {
    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    try {
      return await fs.readdir(ctrlyokeDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  test("creates no .ctrlyoke directory until the user initializes", async () => {
    const posted: unknown[] = [];
    ({ orchestrator, dashboard } = composeStack(posted));

    await orchestrator.setDashboardReady();
    await orchestrator.initialize();
    assert.ok(
      posted.some(
        (message) =>
          (message as { type?: string }).type ===
          MESSAGE_TYPES.WORKSPACE_INIT_REQUIRED
      ),
      "startup should be waiting on the Initialize prompt"
    );

    // Drive each startup writer that has created `.ctrlyoke/` in an
    // uninitialized folder, rather than relying on startup timing to reach it:
    // the dashboard's coordination board read, and the capabilities.json
    // refresh that harness detection and model discovery trigger.
    await orchestrator.getCoordinationScopeSnapshot();
    dashboard.settingsSync.notifyHarnessAvailability(HARNESS_IDS.CODEX_CLI, {
      available: true,
      installCommand: "",
    });
    dashboard.settingsSync.sendModelOptionsUpdate();
    await dashboard.settingsSync.refreshCapabilitiesFile();
    await new Promise((resolve) => setTimeout(resolve, STRAY_WRITE_SETTLE_MS));

    const created = await listCtrlyokeDir();
    assert.strictEqual(
      created,
      undefined,
      `.ctrlyoke/ was created before initialization, containing: ${JSON.stringify(created)}`
    );

    await dashboard.routeClientMessage(
      { type: MESSAGE_TYPES.INITIALIZE_WORKSPACE },
      (message) => posted.push(message)
    );

    const initialized = (await listCtrlyokeDir()) ?? [];
    assert.ok(initialized.includes(".gitignore"), JSON.stringify(initialized));
    // Startup skipped the capabilities file; approving initialization must
    // still leave the external MCP server one to read.
    assert.ok(
      initialized.includes(PATH_CONSTANTS.CAPABILITIES_FILE),
      JSON.stringify(initialized)
    );
  });
});
