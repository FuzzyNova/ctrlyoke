import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import type { WorkflowOrchestratorDependencies } from "../../core/WorkflowOrchestrator";
import type {
  Disposable,
  DisposableRegistry,
  FileWatcher,
  FileWatcherFactory,
  KeyValueStore,
} from "../../core/HostPorts";
import type {
  UserFeedback,
  UserFeedbackSink,
} from "../../core/UserFeedbackSink";
import type { QueueState } from "../../types/CtrlYokeTypes";
import type { RunnerHostIdentity } from "../../types/CtrlYokeTypes";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import { ExternalExecutionResolver } from "../../core/orchestration/ExternalExecutionResolver";
import { TypedEmitter } from "../../utils/TypedEmitter";
import { WebviewUserInteractionPort } from "../../ui/WebviewUserInteractionPort";
import { initPtyProcessManager } from "../../core/harness/PtyProcessManager";
import { MockPlatform } from "../helpers/mockHarness";
import {
  ACTION_TYPES,
  EXTERNAL_EXECUTION_REASONS,
  EXTERNAL_EXECUTION_RESOLUTION_KINDS,
  EXECUTION_STATES,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  QUEUE_POSITION,
  RUNNER_IDS,
  VSCODE_CONTEXT_KEYS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";

const NOOP_DISPOSABLE: Disposable = { dispose: () => {} };

class TestFileWatcher implements FileWatcher {
  onDidCreate(_listener: (filePath: string) => void): Disposable {
    return NOOP_DISPOSABLE;
  }

  onDidChange(_listener: (filePath: string) => void): Disposable {
    return NOOP_DISPOSABLE;
  }

  onDidDelete(_listener: (filePath: string) => void): Disposable {
    return NOOP_DISPOSABLE;
  }

  dispose(): void {}
}

class TestFileWatcherFactory implements FileWatcherFactory {
  create(_basePath: string, _glob: string): FileWatcher {
    return new TestFileWatcher();
  }
}

class TestDisposableRegistry implements DisposableRegistry {
  add(_disposable: Disposable): void {}
}

class TestWorkspaceState implements KeyValueStore {
  async update(_key: string, _value: unknown): Promise<void> {}
}

class TestUserFeedbackSink implements UserFeedbackSink {
  readonly messages: UserFeedback[] = [];

  notify(message: UserFeedback): void {
    this.messages.push(message);
  }
}

const TEST_RUNNER_HOST_IDENTITY: RunnerHostIdentity = {
  runner: RUNNER_IDS.VSCODE,
  hostInstanceId: "workflow-orchestrator-test",
  pid: process.pid,
};

suite("WorkflowOrchestrator unseen failed runs", () => {
  test("opening a missing failed run acknowledges it without changing the view", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    internal.openPanel = async () => undefined;
    const currentAddress = {
      workflowKey: "current-lineage" as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    };
    internal.viewAddressRegistry = new Map([[PANEL_CLIENT_ID, currentAddress]]);
    const failedSummary = {
      id: "failed-instance",
      workflowKey: "missing-lineage" as never,
      runRef: "missing-run" as never,
      workflowName: "Missing",
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 0,
      totalSteps: 1,
      finalStepRunning: false,
    };
    internal.observeWorkflowActivity(failedSummary);
    internal.observeWorkflowActivity({
      ...failedSummary,
      executionState: EXECUTION_STATES.ERROR,
    });

    await orchestrator.openUnseenFailedRun();

    assert.deepStrictEqual(
      internal.getWorkflowActivityTracker().buildSummary([]).unseenFailures,
      []
    );
    assert.deepStrictEqual(
      internal.viewAddressRegistry.get(PANEL_CLIENT_ID),
      currentAddress
    );
  });
});

function createTestOrchestrator(
  overrides: Partial<WorkflowOrchestratorDependencies> = {}
): WorkflowOrchestrator {
  const orchestrator = new WorkflowOrchestrator({
    platform: new MockPlatform(os.tmpdir()),
    workspaceFolderPathResolver: () => undefined,
    userFeedbackSink: new TestUserFeedbackSink(),
    runnerHostIdentity: TEST_RUNNER_HOST_IDENTITY,
    fileWatcherFactory: new TestFileWatcherFactory(),
    disposableRegistry: new TestDisposableRegistry(),
    workspaceState: new TestWorkspaceState(),
    ...overrides,
  });
  // The orchestrator's own constructor already wires a hosted registry, so
  // these façade tests exercise the same construction seam production uses.
  // The lazy collaborators are cleared so they rebuild against whatever fields
  // an individual test overrides after construction.
  const internal = orchestrator as unknown as {
    runViewPublisherInstance?: unknown;
    runLifecycleServiceInstance?: unknown;
  };
  internal.runViewPublisherInstance = undefined;
  internal.runLifecycleServiceInstance = undefined;
  return orchestrator;
}

function createEmptyExternalRunWatchCoordinator() {
  return {
    getEntry: () => undefined,
    hasSession: () => false,
    ensureExternalRunWatchSession: async () => false,
    resolveExternalExecutionForPath: async () => ({
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL,
      reason: EXTERNAL_EXECUTION_REASONS.TERMINAL_RUN,
    }),
    shouldDeclineUntrackedOwnership: () => false,
    getActivationWorktreeOwnership: () => undefined,
  };
}

function createOrchestratorHarness() {
  const orchestrator = createTestOrchestrator();
  const internal = orchestrator as any;

  internal.dashboardReady = false;
  internal.orchestratorInitialized = false;
  internal.startupAutoLoadTriggered = false;
  internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
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
  const orchestrator = createTestOrchestrator();
  const internal = orchestrator as any;
  const boundKey = "bound" as never;

  internal.currentWorkspaceFolderPath = path.join("/", "ws");
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
  internal.externalRunWatchCoordinator =
    createEmptyExternalRunWatchCoordinator();
  internal.viewerRegistry = new Map([["client-a", "instance-bound"]]);
  internal.viewAddressRegistry = new Map();
  internal.viewMessageSinks = new Map();
  internal.lineageBindingClients = new Set<string>();
  internal.lineageExecutionOwners = new Map<
    string,
    { instanceId: string; promoted: boolean }
  >();

  const replays: string[] = [];
  const replayOptions: unknown[] = [];
  const freshLoads: string[] = [];
  const freshLoadOptions: unknown[] = [];
  internal.replayWorkflowStateTo = async (
    workflowId: string,
    _send: unknown,
    _clientId: unknown,
    options: unknown
  ) => {
    replays.push(workflowId);
    replayOptions.push(options);
  };
  internal.loadFreshInstanceAndReplay = async (
    filePath: string,
    _clientId: unknown,
    _send: unknown,
    options: unknown
  ) => {
    freshLoads.push(filePath);
    freshLoadOptions.push(options);
  };

  return {
    orchestrator,
    internal,
    boundKey,
    replays,
    replayOptions,
    freshLoads,
    freshLoadOptions,
  };
}

suite("WorkflowOrchestrator steer dispatch", () => {
  test("resolves the workflow instance and delegates the session and text", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const calls: unknown[] = [];
    internal.instances = new Map([
      [
        "workflow-1",
        {
          sendSteerMessage: async (...args: unknown[]) => {
            calls.push(args);
          },
        },
      ],
    ]);
    internal.retiredInstances = new Map();

    await orchestrator.sendSteerMessage(
      "workflow-1",
      "session-1",
      "steer text"
    );

    assert.deepStrictEqual(calls, [["session-1", "steer text"]]);
  });
});

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

  suite("WorkflowOrchestrator workflow-root approval", () => {
    const originalPending =
      ConfigurationUtils.getPendingWorkflowExternalFileRoots;

    teardown(() => {
      ConfigurationUtils.getPendingWorkflowExternalFileRoots = originalPending;
    });

    function createApprovalHarness() {
      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      const sent: unknown[] = [];
      const requests: unknown[] = [];
      const port = new WebviewUserInteractionPort(
        (message) => requests.push(message),
        () => true
      );
      const instance = {
        id: "workflow-instance",
        promptQueue: {
          getWorkflowFile: () => ({
            trustedExternalRoots: ["C:\\external"],
          }),
        },
        getCurrentPromptFilePath: () => "C:\\workspace\\workflow.ctrlyoke.json",
        getQueueState: () => ({ status: "idle" }),
      };
      internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
      internal.currentWorkspaceFolderPath = "C:\\workspace";
      internal.workspaceTrustPredicate = () => true;
      internal.viewerRegistry = new Map([["browser:1", "workflow-instance"]]);
      internal.instances = new Map([["workflow-instance", instance]]);
      internal.retiredInstances = new Map();
      return { orchestrator, internal, port, sent, requests };
    }

    test("prompts only the active workflow client and publishes its pending state", async () => {
      const { orchestrator, port, sent, requests } = createApprovalHarness();
      ConfigurationUtils.getPendingWorkflowExternalFileRoots = () => [
        "C:\\external",
      ];

      const pendingPromise =
        orchestrator.approvePendingWorkflowExternalRootsForClient(
          "browser:1",
          (message) => sent.push(message),
          port
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const request = requests[0] as { request: { id: string } };
      port.handleResponse(request.request.id, undefined);
      const pending = await pendingPromise;

      assert.deepStrictEqual(pending, ["C:\\external"]);
      assert.strictEqual(requests.length, 1);
      assert.deepStrictEqual(sent, [
        {
          type: MESSAGE_TYPES.WORKFLOW_EXTERNAL_ROOTS_APPROVAL_REQUIRED,
          workflowId: "workflow-instance",
          pendingRoots: ["C:\\external"],
        },
      ]);
    });

    test("does not prompt when the host reports an untrusted workspace", async () => {
      const { orchestrator, internal, port, requests } =
        createApprovalHarness();
      internal.workspaceTrustPredicate = () => false;
      ConfigurationUtils.getPendingWorkflowExternalFileRoots = () => [
        "C:\\external",
      ];

      const pending =
        await orchestrator.approvePendingWorkflowExternalRootsForClient(
          "browser:1",
          undefined,
          port
        );

      assert.deepStrictEqual(pending, ["C:\\external"]);
      assert.strictEqual(requests.length, 0);
    });

    test("blocks the panel Run path while workflow roots remain pending", async () => {
      const { orchestrator, internal } = createApprovalHarness();
      const feedback: string[] = [];
      let executed = false;
      internal.viewerRegistry = new Map([
        [PANEL_CLIENT_ID, "workflow-instance"],
      ]);
      internal.userFeedbackSink = {
        notify: ({ message }: { message: string }) => feedback.push(message),
      };
      internal.instances.get("workflow-instance").executeLoadedPromptFile =
        async () => {
          executed = true;
        };
      ConfigurationUtils.getPendingWorkflowExternalFileRoots = () => [
        "C:\\external",
      ];

      await orchestrator.executeWorkflow();

      assert.strictEqual(executed, false);
      assert.strictEqual(feedback.length, 1);
      assert.match(feedback[0], /require approval before running/);
    });
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

  test("records the panel's hydrated view so a deferred auto-load can detect a move", async () => {
    const { orchestrator, internal } = createOrchestratorHarness();
    internal.viewerRegistry.set(PANEL_CLIENT_ID, "startup-hydrated");

    await orchestrator.setDashboardReady();

    assert.strictEqual(internal.startupPanelViewedId, "startup-hydrated");
  });

  test("re-records the hydrated view on later pre-settle READY messages", async () => {
    // The panel sends three READYs during boot and the first can land before
    // handleClientReady finished hydrating the persisted view. A stale null
    // snapshot would read as "the user moved the view" on a healthy startup.
    const { orchestrator, internal } = createOrchestratorHarness();

    await orchestrator.setDashboardReady();
    assert.strictEqual(internal.startupPanelViewedId, null);

    internal.viewerRegistry.set(PANEL_CLIENT_ID, "startup-hydrated");
    await orchestrator.setDashboardReady();

    assert.strictEqual(internal.startupPanelViewedId, "startup-hydrated");
  });

  test("freezes the hydrated view once startup has settled", async () => {
    const { orchestrator, internal } = createOrchestratorHarness();
    internal.viewerRegistry.set(PANEL_CLIENT_ID, "startup-hydrated");
    internal._autoLoadHasSettled = true;
    internal.startupPanelViewedId = "startup-hydrated";

    // A post-startup reconnect while the user views something else must not
    // rewrite the snapshot — triggerAutoLoad never runs again anyway.
    internal.viewerRegistry.set(PANEL_CLIENT_ID, "user-selected");
    await orchestrator.setDashboardReady();

    assert.strictEqual(internal.startupPanelViewedId, "startup-hydrated");
  });
});

suite("WorkflowOrchestrator SESSION_RESTORED revision forwarding", () => {
  test("replays a lineage-less instance as a replacement, not a replay", async () => {
    const replayCalls: Array<{ asReplacement?: boolean } | undefined> = [];
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const instance = {
      getSummary: () => ({ workingFilePath: null }),
      // A brand-new workflow: no workflowKey, so nothing publishes an address
      // before the SESSION_RESTORED that follows.
      getQueueState: () => ({ workflowKey: undefined, runRef: undefined }),
      replayFullStateTo: (
        _sink: unknown,
        options?: { asReplacement?: boolean }
      ) => replayCalls.push(options),
    };
    internal.instances = new Map([["inst-new", instance]]);
    internal.retiredInstances = new Map();
    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();
    internal.getActiveTerminalWorkflowRefs = () => [];
    internal.setViewedWorkflowId = () => {};
    internal.loadRunViewForClient = async () => {
      assert.fail("a lineage-less instance has no address to load");
    };

    await orchestrator.replayWorkflowStateTo("inst-new", () => {}, "panel", {
      skipTerminalReplay: true,
    });

    assert.deepStrictEqual(replayCalls, [{ asReplacement: true }]);
  });
});

suite("WorkflowOrchestrator active queue context key", () => {
  test("sets and clears the queue context key as the active queue changes", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const queueState = (stepCount: number): QueueState => ({
      status: EXECUTION_STATES.IDLE,
      stopped: false,
      totalPausedDuration: 0,
      currentIndex: 0,
      steps: Array.from({ length: stepCount }, (_, index) => ({
        prompt: `step ${index}`,
      })),
      parallelGroups: [],
      results: [],
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      definitionRevision: 1,
    });

    let activeState = queueState(0);
    const activeInstance = {
      id: "active-instance",
      getQueueState: () => activeState,
    };
    const queuedInstance = {
      id: "queued-instance",
      getQueueState: () => queueState(1),
    };
    const emptyInstance = {
      id: "empty-instance",
      getQueueState: () => queueState(0),
    };

    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.viewerRegistry = new Map([[PANEL_CLIENT_ID, activeInstance.id]]);
    internal.instances = new Map([
      [activeInstance.id, activeInstance],
      [queuedInstance.id, queuedInstance],
      [emptyInstance.id, emptyInstance],
    ]);
    internal.retiredInstances = new Map();
    internal.activeQueueStateChangedEmitter = new TypedEmitter<
      QueueState | undefined
    >();

    const originalExecuteCommand = vscode.commands.executeCommand;
    const updates: Array<{ key: string; value: boolean }> = [];
    internal.statusBarSink = {
      updateStatusBar: () => undefined,
      setHasQueuedStepsContext: (hasQueuedSteps: boolean) => {
        updates.push({
          key: VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS,
          value: hasQueuedSteps,
        });
      },
    };
    vscode.commands.executeCommand = (async (
      command: string,
      ...args: unknown[]
    ) => {
      if (command === "setContext") {
        updates.push({ key: String(args[0]), value: Boolean(args[1]) });
      }
      return undefined;
    }) as typeof vscode.commands.executeCommand;

    try {
      const disposable = orchestrator.registerActiveQueueContextKey();
      assert.deepStrictEqual(updates, [
        { key: VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS, value: false },
      ]);

      activeState = queueState(1);
      internal.activeQueueStateChangedEmitter.fire(activeState);
      activeState = queueState(0);
      internal.activeQueueStateChangedEmitter.fire(activeState);
      internal.setViewedWorkflowId(PANEL_CLIENT_ID, queuedInstance.id);
      internal.setViewedWorkflowId(PANEL_CLIENT_ID, emptyInstance.id);

      assert.deepStrictEqual(
        updates.map(({ key, value }) => ({ key, value })),
        [
          { key: VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS, value: false },
          { key: VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS, value: true },
          { key: VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS, value: false },
          { key: VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS, value: true },
          { key: VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS, value: false },
        ]
      );
      disposable.dispose();
    } finally {
      vscode.commands.executeCommand = originalExecuteCommand;
    }
  });
});

suite("WorkflowOrchestrator session command facade", () => {
  test("reports the no-workspace early exit without discovering sessions", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const feedback: Array<{ message: string }> = [];
    let discovered = false;

    internal.userFeedbackSink = {
      notify: (message: { message: string }) => feedback.push(message),
    };
    internal.workspaceSessionManager = {
      discoverSessions: async () => {
        discovered = true;
        return [];
      },
    };

    const sessions = await orchestrator.listResumableSessions();

    assert.deepStrictEqual(sessions, []);
    assert.strictEqual(discovered, false);
    assert.deepStrictEqual(
      feedback.map(({ message }) => message),
      ["No workspace folder open"]
    );
  });

  test("returns the session metadata produced by the session manager", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const sessions = [
      {
        label: "✓ workflow",
        description: "1/1 completed",
        detail: "Started: now",
        filePath: "/workspace/.ctrlyoke/.runs/workflow/run/workflow.json",
      },
    ];
    let requestedRoot: string | undefined;

    internal.currentWorkspaceFolderPath = "/workspace";
    internal.workspaceSessionManager = {
      discoverSessions: async (workspaceRoot: string) => {
        requestedRoot = workspaceRoot;
        return sessions;
      },
    };

    assert.deepStrictEqual(
      await orchestrator.listResumableSessions(),
      sessions
    );
    assert.strictEqual(requestedRoot, "/workspace");
  });

  test("restores the selected working file before focusing the dashboard", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const calls: string[] = [];
    const filePath = "/workspace/.ctrlyoke/.runs/workflow/run/workflow.json";

    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.storedPanelSend = undefined;
    internal.createWorkflowForClient = async (
      _send: unknown,
      clientId: string
    ) => {
      calls.push(`create:${clientId}`);
    };
    internal.getActiveInstance = () => ({
      restoreWorkflowFromWorkingFile: async (selectedPath: string) => {
        calls.push(`restore:${selectedPath}`);
      },
    });
    internal.platform = {
      focusDashboard: () => calls.push("focus"),
    };

    await orchestrator.resumeSessionFromWorkingFile(filePath);

    assert.deepStrictEqual(calls, [
      `create:${PANEL_CLIENT_ID}`,
      `restore:${filePath}`,
      "focus",
    ]);
  });
});

suite("WorkflowOrchestrator duplicate workflow policy", () => {
  test("reuses a running instance without prompting for a conflicting choice", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const existing = {
      id: "existing-instance",
      filePath: "workflow.ctrlyoke.yaml",
      getQueueState: () => ({ status: EXECUTION_STATES.RUNNING }),
    };
    const replayed: string[] = [];

    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.instances = new Map([[existing.id, existing]]);
    internal.retiredInstances = new Map();
    internal.getViewedWorkflowId = () => undefined;
    internal.storedPanelSend = undefined;
    internal.replayWorkflowStateTo = async (workflowId: string) => {
      replayed.push(workflowId);
    };

    const result = await internal.createWorkflow(existing.filePath);

    assert.strictEqual(result, existing);
    assert.deepStrictEqual(replayed, [existing.id]);
  });
});

/**
 * The startup auto-load is deferred behind `initialize()`, which on a real
 * workspace can take 15s+ (six harness version probes, model discovery, prompt
 * file scan). It resolves its target through `getActiveInstance()` — whatever
 * the panel views *now* — so if anything moved the view during that window the
 * recent session gets loaded into the user's workflow, replacing its steps and
 * name and rebinding the view to the recent lineage's older instance.
 */
suite("WorkflowOrchestrator triggerAutoLoad view-ownership", () => {
  const RECENT_WORKING_FILE = path.join(
    os.tmpdir(),
    "ctrlyoke-ws",
    "recent-working-file.json"
  );

  let originalShouldAutoLoad: () => boolean;

  setup(() => {
    originalShouldAutoLoad = ConfigurationUtils.shouldAutoLoadRecentSession;
    ConfigurationUtils.shouldAutoLoadRecentSession = () => true;
  });

  teardown(() => {
    ConfigurationUtils.shouldAutoLoadRecentSession = originalShouldAutoLoad;
  });

  interface AutoLoadHarnessOptions {
    panelViewedId: string | null;
    startupPanelViewedId: string | null;
    workspacePath?: string;
    workingFilePath?: string;
    recentWorkingFilePath?: string;
    findsRecentSession?: boolean;
  }

  function createAutoLoadHarness(options: AutoLoadHarnessOptions) {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    const autoLoadedInto: string[] = [];
    const autoLoadedPaths: string[] = [];
    let recentSessionScans = 0;
    let postAutoLoadCallbacks = 0;
    let startupBroadcasts = 0;
    let settledWith: string | null | undefined;

    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.currentWorkspaceFolderPath =
      options.workspacePath ?? path.join(os.tmpdir(), "ctrlyoke-ws");
    internal.runnerHostIdentity = {
      runner: RUNNER_IDS.VSCODE,
      hostInstanceId: "observer-host",
      pid: process.pid,
    };
    internal.externalRunWatchCoordinator = {
      ...createEmptyExternalRunWatchCoordinator(),
      resolveExternalExecutionForPath: (
        workingFilePath: string,
        workspaceRoot: string
      ) =>
        new ExternalExecutionResolver(
          workspaceRoot,
          internal.runnerHostIdentity
        ).resolve(workingFilePath),
      shouldDeclineUntrackedOwnership: (
        _workingFilePath: string,
        resolution: {
          kind: string;
          reason?: string;
        }
      ) =>
        resolution.kind === EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL &&
        (resolution.reason === EXTERNAL_EXECUTION_REASONS.SELF_OWNED ||
          resolution.reason === EXTERNAL_EXECUTION_REASONS.INDETERMINATE_OWNER),
    };
    internal.startupPanelViewedId = options.startupPanelViewedId;
    internal.viewerRegistry = new Map<string, string | null>([
      [PANEL_CLIENT_ID, options.panelViewedId],
    ]);
    internal.viewAddressRegistry = new Map();
    internal.retiredInstances = new Map<string, unknown>();
    internal.instances = new Map<string, unknown>();
    if (options.panelViewedId) {
      internal.instances.set(options.panelViewedId, {
        id: options.panelViewedId,
        getSummary: () => ({ workingFilePath: options.workingFilePath }),
        autoLoadFromWorkingFile: async (workingFilePath: string) => {
          autoLoadedInto.push(options.panelViewedId!);
          autoLoadedPaths.push(workingFilePath);
        },
      });
    }

    internal.workspaceSessionManager = {
      autoLoadRecentSession: async (
        _root: string,
        onLoad: (workingFilePath: string) => Promise<void>
      ) => {
        recentSessionScans += 1;
        if (options.findsRecentSession !== false) {
          await onLoad(options.recentWorkingFilePath ?? RECENT_WORKING_FILE);
        }
      },
    };
    // Leaving storedPanelSend unset skips the replay seam; this suite is about
    // which instance the auto-load targets, not about message delivery.
    internal.storedPanelSend = undefined;
    internal.panelStartupReplayedWorkflowId = null;
    internal.dashboardReadyAt = Date.now();
    internal.storedPostAutoLoadCallback = async () => {
      postAutoLoadCallbacks += 1;
    };
    internal.resolveStartupAutoLoad = (id: string | null) => {
      settledWith = id;
    };
    internal.dashboardBroadcastHub = {
      notifyStartupComplete: () => {
        startupBroadcasts += 1;
      },
    };

    return {
      orchestrator,
      internal,
      autoLoadedInto,
      autoLoadedPaths,
      getRecentSessionScans: () => recentSessionScans,
      getPostAutoLoadCallbacks: () => postAutoLoadCallbacks,
      getStartupBroadcasts: () => startupBroadcasts,
      getSettledWith: () => settledWith,
    };
  }

  test("skips the recent-session load when the panel view moved during startup", async () => {
    // A brand-new workflow has no working file until the user types, so the
    // pre-existing workingFilePath guard falls through in exactly this case.
    const harness = createAutoLoadHarness({
      panelViewedId: "user-created",
      startupPanelViewedId: "startup-hydrated",
    });

    await (harness.internal as any).triggerAutoLoad();

    assert.strictEqual(
      harness.getRecentSessionScans(),
      0,
      "must not scan for a recent session once the user owns the view"
    );
    assert.deepStrictEqual(
      harness.autoLoadedInto,
      [],
      "must not load the recent session into the user's own instance"
    );
    assert.strictEqual(
      harness.getSettledWith(),
      "user-created",
      "browser clients must replay the workflow the user actually has open"
    );
  });

  test("loads the recent session when the panel view is still the hydrated one", async () => {
    const harness = createAutoLoadHarness({
      panelViewedId: "startup-hydrated",
      startupPanelViewedId: "startup-hydrated",
    });

    await (harness.internal as any).triggerAutoLoad();

    assert.strictEqual(harness.getRecentSessionScans(), 1);
    assert.deepStrictEqual(harness.autoLoadedInto, ["startup-hydrated"]);
    assert.deepStrictEqual(harness.autoLoadedPaths, [RECENT_WORKING_FILE]);
    assert.strictEqual(harness.getSettledWith(), "startup-hydrated");
  });

  test("keeps the panel's persisted workflow without scanning for a recent session", async () => {
    const harness = createAutoLoadHarness({
      panelViewedId: "startup-hydrated",
      startupPanelViewedId: "startup-hydrated",
      workingFilePath: RECENT_WORKING_FILE,
    });

    await (harness.internal as any).triggerAutoLoad();

    assert.strictEqual(harness.getRecentSessionScans(), 0);
    assert.deepStrictEqual(harness.autoLoadedInto, []);
    assert.strictEqual(harness.getSettledWith(), "startup-hydrated");
  });

  test("always settles startup and runs the follow-up on every exit path", async () => {
    // WORKFLOW_LOADED (emitted by the follow-up) is what re-enables editing, so
    // a path that settled without it left the properties panel dead with no
    // second chance.
    const cases: Array<{ name: string; options: AutoLoadHarnessOptions }> = [
      {
        name: "view moved",
        options: {
          panelViewedId: "user-created",
          startupPanelViewedId: "startup-hydrated",
        },
      },
      {
        name: "no recent session found",
        options: {
          panelViewedId: "startup-hydrated",
          startupPanelViewedId: "startup-hydrated",
          findsRecentSession: false,
        },
      },
      {
        name: "recent session loaded",
        options: {
          panelViewedId: "startup-hydrated",
          startupPanelViewedId: "startup-hydrated",
        },
      },
      {
        name: "persisted workflow kept",
        options: {
          panelViewedId: "startup-hydrated",
          startupPanelViewedId: "startup-hydrated",
          workingFilePath: RECENT_WORKING_FILE,
        },
      },
    ];

    for (const { name, options } of cases) {
      const harness = createAutoLoadHarness(options);

      await (harness.internal as any).triggerAutoLoad();

      assert.strictEqual(
        harness.getPostAutoLoadCallbacks(),
        1,
        `${name}: post-auto-load follow-up must fire exactly once`
      );
      assert.strictEqual(
        harness.internal.storedPostAutoLoadCallback,
        undefined,
        `${name}: follow-up must be cleared so it cannot fire twice`
      );
      assert.strictEqual(
        harness.getStartupBroadcasts(),
        1,
        `${name}: STARTUP_COMPLETE must be broadcast exactly once`
      );
      assert.strictEqual(
        harness.internal._autoLoadHasSettled,
        true,
        `${name}: startup must be marked settled`
      );
    }
  });

  test("still settles startup when the follow-up throws", async () => {
    const harness = createAutoLoadHarness({
      panelViewedId: "startup-hydrated",
      startupPanelViewedId: "startup-hydrated",
    });
    harness.internal.storedPostAutoLoadCallback = async () => {
      throw new Error("properties send failed");
    };

    await (harness.internal as any).triggerAutoLoad();

    assert.strictEqual(harness.getStartupBroadcasts(), 1);
    assert.strictEqual(harness.internal._autoLoadHasSettled, true);
  });

  test("does not adopt a self-owned active lock without a local execution", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-self-owned-auto-load-")
    );
    const workflowKey = "self-owned-auto-load" as never;
    const runRef = "run-2026-08-28T00-00-00-000Z" as never;
    const workingFilePath = WorkflowPaths.runFilePath(
      workspace,
      workflowKey,
      runRef
    );
    const now = Date.now();
    try {
      await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          workflowName: "self-owned",
          startedAt: now,
          steps: [{ prompt: "live" }],
          _runtime: {
            currentIndex: 0,
            executionState: EXECUTION_STATES.RUNNING,
          },
        }),
        "utf8"
      );
      await fs.writeFile(
        WorkflowLockManager.getLockPath(workspace, workflowKey),
        JSON.stringify({
          schemaVersion: 2,
          workflowKey,
          runRef,
          runner: RUNNER_IDS.VSCODE,
          pid: process.pid,
          ownerToken: "self-owner",
          hostInstanceId: "observer-host",
          executionInstanceId: "self-execution",
          startedAt: now,
          lastHeartbeat: now,
        }),
        "utf8"
      );

      const harness = createAutoLoadHarness({
        panelViewedId: "startup-hydrated",
        startupPanelViewedId: "startup-hydrated",
        workspacePath: workspace,
        recentWorkingFilePath: workingFilePath,
      });

      await (harness.internal as any).triggerAutoLoad();

      assert.deepStrictEqual(harness.autoLoadedPaths, []);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator handleClientReady", () => {
  async function writeRunTimeline(
    workspace: string,
    workflowKey: import("../../types/CtrlYokeTypes").WorkflowKey,
    runRef: import("../../types/CtrlYokeTypes").RunRef,
    executionState: string
  ): Promise<void> {
    const runDir = WorkflowPaths.runDir(workspace, workflowKey, runRef);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      WorkflowPaths.manifestPath(workspace, workflowKey, runRef),
      JSON.stringify({
        schemaVersion: 1,
        storageKind: "timeline",
        workflowId: workflowKey,
        runId: 1,
        startedAt: Date.now(),
        executionState,
        definitionRevision: 1,
      })
    );
    await fs.writeFile(
      WorkflowPaths.eventsPath(workspace, workflowKey, runRef),
      ""
    );
  }

  test("announces a replay boundary before restoring a retained preferred view", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const clientId = "browser:mobile";
    const workflowId = "workflow-output-pane";
    const workflowKey = "output-pane-rendering-overlay" as never;
    const runRef = "run-2026-08-05T23-41-43-745Z" as never;
    const address = { workflowKey, kind: "run" as const, runRef };
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preferred-view-")
    );
    const runFilePath = WorkflowPaths.runFilePath(
      workspace,
      workflowKey,
      runRef
    );
    await fs.mkdir(path.dirname(runFilePath), { recursive: true });
    await fs.writeFile(
      runFilePath,
      JSON.stringify({
        workflowName: "Output pane rendering overlay",
        definitionRevision: 1,
        steps: [{ prompt: "current" }],
      })
    );
    await writeRunTimeline(workspace, workflowKey, runRef, "running");
    const instance = {
      id: workflowId,
      getSummary: () => ({ workingFilePath: "C:\\workflow.json" }),
      getQueueState: () => ({
        workflowKey,
        runRef,
        status: EXECUTION_STATES.RUNNING,
      }),
      getExecutionRunRef: () => runRef,
      replayBufferedOutputTo: () => undefined,
      getActiveStepIndices: () => [],
      getRunViewLiveState: () => ({
        executionState: EXECUTION_STATES.RUNNING,
        currentIndex: 0,
        steps: [{ prompt: "current" }],
        results: [],
        parallelGroups: [],
        finalStep: null,
        finalStepRuntime: undefined,
        workflowProperties: {},
        schemaWarnings: [],
      }),
    };

    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.currentWorkspaceFolderPath = workspace;
    internal.viewerRegistry = new Map([[clientId, workflowId]]);
    internal.viewAddressRegistry = new Map([[clientId, address]]);
    internal.viewMessageSinks = new Map();
    internal.instances = new Map([[workflowId, instance]]);
    internal.retiredInstances = new Map();
    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();
    internal.lineageRepository = {
      readDescriptor: async () => ({ revision: 1, lastModifiedAt: 1 }),
    };
    internal.getActiveTerminalWorkflowRefs = () => [];
    internal.readAddressedRunView = async () => ({
      workingFile: {
        workflowName: "Output pane rendering overlay",
        definitionRevision: 1,
        steps: [{ prompt: "current" }],
      },
      history: null,
      runSummaries: [],
      workflowProperties: {},
      descriptorRevision: 1,
    });
    internal.getWorkflowSummaries = () => [];

    const sent: Array<{ type?: string; workflowId?: string }> = [];
    await orchestrator.handleClientReady(
      clientId,
      (message) => sent.push(message as { type?: string; workflowId?: string }),
      { preferredViewAddress: address }
    );

    const announcementIndex = sent.findIndex(
      (message) => message.type === MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED
    );
    const snapshotIndex = sent.findIndex(
      (message) => message.type === MESSAGE_TYPES.RUN_VIEW_LOADED
    );
    assert.ok(announcementIndex >= 0);
    assert.strictEqual(sent[announcementIndex]?.workflowId, workflowId);
    assert.ok(snapshotIndex > announcementIndex);
    assert.strictEqual(
      (sent[snapshotIndex] as { runDirectory?: string }).runDirectory,
      WorkflowPaths.runDir(
        internal.currentWorkspaceFolderPath,
        workflowKey,
        runRef
      )
    );
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("keeps client run views independent from the execution target", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowKey = "demo" as never;
    const executingRun = "run-2026-07-20T10-30-00-000Z" as never;
    const viewedRun = "run-2026-07-20T09-30-00-000Z" as never;

    internal.viewAddressRegistry = new Map([
      [
        "client-a",
        {
          workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: executingRun,
        },
      ],
      [
        "client-b",
        {
          workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: viewedRun,
        },
      ],
    ]);
    internal.instances = new Map([
      [
        "execution-instance",
        {
          getQueueState: () => ({
            workflowKey,
            runRef: executingRun,
            status: EXECUTION_STATES.RUNNING,
          }),
          getExecutionRunRef: () => executingRun,
        },
      ],
    ]);
    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();

    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: executingRun,
    });
    assert.deepStrictEqual(orchestrator.getViewAddress("client-b"), {
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: viewedRun,
    });
    assert.strictEqual(internal.findExecutionRunRef(workflowKey), executingRun);
  });

  test("does not treat an idle resident instance as a lineage execution owner", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowKey = "demo" as never;
    const restoredRun = "run-2026-06-08T21-27-08-408Z" as never;

    internal.instances = new Map([
      [
        "restored-instance",
        {
          getQueueState: () => ({
            workflowKey,
            runRef: restoredRun,
            status: EXECUTION_STATES.IDLE,
          }),
          getExecutionRunRef: () => restoredRun,
        },
      ],
    ]);
    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();

    assert.strictEqual(internal.findExecutionRunRef(workflowKey), undefined);
  });

  test("registers the client's view sink so draft viewers follow their promoted run", async () => {
    const orchestrator = createTestOrchestrator();
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
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });

    const loaded: unknown[] = [];
    internal.publishRunViewToClients = async (
      address: unknown,
      targets: Array<{ clientId: string }>
    ) => {
      loaded.push({ address, clients: targets.map((t) => t.clientId) });
    };
    internal.syncExecutingRunViews({
      id: "instance-1",
      getQueueState: () => ({ workflowKey, runRef }),
    });

    assert.deepStrictEqual(loaded, [
      {
        address: { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef },
        clients: ["client-a"],
      },
    ]);
  });

  test("binds a switching client to the addressed lineage's resident instance", async () => {
    const { internal, replays, replayOptions } = createLineageBindingHarness();
    const other = "other" as never;

    internal.instances.set("instance-other", {
      id: "instance-other",
      getQueueState: () => ({ workflowKey: other }),
    });

    await internal.runViewPublisher.bindClientToAddressedLineage(
      { workflowKey: other, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      () => undefined,
      "client-a"
    );

    // Without this the client keeps editing/running/terminalling the workflow
    // it was bound to before the switch. The caller sends one exact snapshot
    // and overlays only buffered runtime output, so binding itself remains
    // side-effect free beyond updating the client-to-instance registry.
    assert.strictEqual(
      internal.viewerRegistry.get("client-a"),
      "instance-other"
    );
    assert.deepStrictEqual(replays, []);
    assert.deepStrictEqual(replayOptions, []);
  });

  test("leaves the binding alone when the address is another run of the same lineage", async () => {
    const { internal, replays } = createLineageBindingHarness();

    await internal.runViewPublisher.bindClientToAddressedLineage(
      {
        workflowKey: "bound" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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

    await internal.runViewPublisher.bindClientToAddressedLineage(
      { workflowKey: other, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      () => undefined,
      "client-a"
    );

    assert.strictEqual(
      internal.viewerRegistry.get("client-a"),
      "instance-live"
    );
    assert.deepStrictEqual(replays, []);
  });

  /*
  const { internal, replays } = createLineageBindingHarness();
  const other = "other" as never;
  const historicalRun = "run-2026-07-24T04-48-38-282Z" as never;
  const liveRun = "run-2026-07-24T16-44-11-345Z" as never;

  // Reproduce a completed older run lingering before the newer run's
  // terminal-owning instance in insertion order.
  internal.retiredInstances.set("instance-historical", {
    id: "instance-historical",
    getQueueState: () => ({
      workflowKey: other,
      runRef: historicalRun,
    }),
  });
  internal.retiredInstances.set("instance-terminal-owner", {
    id: "instance-terminal-owner",
    getQueueState: () => ({
      workflowKey: other,
      runRef: liveRun,
    }),
  });
  internal.getActiveTerminalWorkflowRefs = () => [
    {
      workflowId: "instance-terminal-owner",
      workflowKey: other,
      runRef: liveRun,
    },
  ];

  await internal.runViewPublisher.bindClientToAddressedLineage(
    {
      workflowKey: other,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: historicalRun,
    },
    () => undefined,
    "client-a"
  );

  assert.strictEqual(
    internal.viewerRegistry.get("client-a"),
    "instance-terminal-owner",
    "historical snapshots must retain the lineage's live TerminalView"
  );
  assert.deepStrictEqual(replays, []);
}); */

  /*
  const { internal, boundKey } = createLineageBindingHarness();
  const historicalRun = "run-2026-07-24T04-48-38-282Z" as never;
  const liveRun = "run-2026-07-24T16-44-11-345Z" as never;

  const staleBound = internal.instances.get("instance-bound");
  internal.instances.delete("instance-bound");
  internal.retiredInstances.set("instance-bound", {
    ...staleBound,
    getQueueState: () => ({
      workflowKey: boundKey,
      runRef: historicalRun,
    }),
  });
  internal.retiredInstances.set("instance-terminal-owner", {
    id: "instance-terminal-owner",
    getQueueState: () => ({
      workflowKey: boundKey,
      runRef: liveRun,
    }),
  });
  internal.getActiveTerminalWorkflowRefs = () => [
    {
      workflowId: "instance-terminal-owner",
      workflowKey: boundKey,
      runRef: liveRun,
    },
  ];

  await internal.runViewPublisher.bindClientToAddressedLineage(
    {
      workflowKey: boundKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: historicalRun,
    },
    () => undefined,
    "client-a"
  );

  assert.strictEqual(
    internal.viewerRegistry.get("client-a"),
    "instance-terminal-owner"
  );
}); */

  test("keeps a re-running client on the prepared instance while the old run's PTY dies", async () => {
    const { internal, boundKey } = createLineageBindingHarness();
    const outgoingRun = "run-2026-07-24T18-55-53-230Z" as never;
    const seededRun = "run-2026-07-25T01-26-33-951Z" as never;

    // Re-run of a completed run: the outgoing instance retired but still owns
    // the ai-cli PTY being gracefully killed, and the seeded instance is parked
    // in retiredInstances until its RUNNING transition promotes it.
    internal.instances.delete("instance-bound");
    internal.retiredInstances.set("instance-outgoing", {
      id: "instance-outgoing",
      getQueueState: () => ({ workflowKey: boundKey, runRef: outgoingRun }),
    });
    internal.retiredInstances.set("instance-seeded", {
      id: "instance-seeded",
      getQueueState: () => ({ workflowKey: boundKey, runRef: seededRun }),
    });
    internal.lineageExecutionOwners.set(boundKey, {
      instanceId: "instance-seeded",
      promoted: false,
    });
    internal.viewerRegistry.set("client-a", "instance-seeded");
    internal.getActiveTerminalWorkflowRefs = () => [
      {
        workflowId: "instance-outgoing",
        workflowKey: boundKey,
        runRef: outgoingRun,
      },
    ];

    await internal.runViewPublisher.bindClientToAddressedLineage(
      {
        workflowKey: boundKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: seededRun,
      },
      () => undefined,
      "client-a"
    );

    assert.strictEqual(
      internal.viewerRegistry.get("client-a"),
      "instance-seeded",
      "the run-view load inside the switch must not hand the client back to the run it just re-ran"
    );
  });

  test("claims the lineage for the instance prepared to execute it", async () => {
    const { internal, boundKey } = createLineageBindingHarness();
    const outgoingRun = "run-2026-07-24T18-55-53-230Z" as never;
    const seededRun = "run-2026-07-25T01-26-33-951Z" as never;

    internal.instances.delete("instance-bound");
    internal.retiredInstances.set("instance-outgoing", {
      id: "instance-outgoing",
      getQueueState: () => ({ workflowKey: boundKey, runRef: outgoingRun }),
    });
    internal.getActiveTerminalWorkflowRefs = () => [
      {
        workflowId: "instance-outgoing",
        workflowKey: boundKey,
        runRef: outgoingRun,
      },
    ];
    const prepared = {
      id: "instance-seeded",
      getQueueState: () => ({ workflowKey: boundKey, runRef: seededRun }),
    };

    await internal.switchClientToPreparedExecution(prepared, "client-a");

    assert.deepStrictEqual(internal.lineageExecutionOwners.get(boundKey), {
      instanceId: "instance-seeded",
      promoted: false,
    });
    assert.strictEqual(
      internal.workflowInstanceRegistry.findInstanceForLineage(boundKey),
      prepared,
      "the prepared instance must outrank the outgoing run's terminal owner"
    );
  });

  // Re-run's outgoing instance is retired (it had reached a terminal state), but
  // running a never-executed run from a client that is *browsing* the lineage
  // leaves the outgoing instance live and idle. Residency alone then hands the
  // client straight back to it, and every message from the run it just started
  // is dropped as belonging to a non-active workflow.
  test("keeps the client on the prepared instance when the outgoing one is live and idle", async () => {
    const { internal, boundKey } = createLineageBindingHarness();
    const browsedRun = "run-2026-07-27T03-06-48-798Z" as never;
    const startedRun = "run-2026-07-27T03-06-41-976Z" as never;

    internal.instances.delete("instance-bound");
    internal.instances.set("instance-browsing", {
      id: "instance-browsing",
      getQueueState: () => ({
        workflowKey: boundKey,
        runRef: browsedRun,
        status: EXECUTION_STATES.IDLE,
      }),
    });
    internal.viewerRegistry.set("client-a", "instance-browsing");
    const prepared = {
      id: "instance-starting",
      getQueueState: () => ({
        workflowKey: boundKey,
        runRef: startedRun,
        status: EXECUTION_STATES.IDLE,
      }),
    };

    await internal.switchClientToPreparedExecution(prepared, "client-a");
    // The nested bind that `replayWorkflowStateTo` performs via its own
    // `loadRunViewForClient` — the step that used to revert the binding.
    await internal.runViewPublisher.bindClientToAddressedLineage(
      {
        workflowKey: boundKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: startedRun,
      },
      () => undefined,
      "client-a"
    );

    assert.strictEqual(
      internal.viewerRegistry.get("client-a"),
      "instance-starting",
      "a live idle instance of the same lineage must not outrank the one prepared to execute it"
    );
  });

  test("prefers the executing instance over an earlier-registered live one", () => {
    const { internal, boundKey } = createLineageBindingHarness();

    internal.instances.delete("instance-bound");
    // Insertion order matters: the idle instance is registered first, so a
    // plain "first live match" resolves to it even after the run starts.
    internal.instances.set("instance-idle", {
      id: "instance-idle",
      getQueueState: () => ({
        workflowKey: boundKey,
        status: EXECUTION_STATES.IDLE,
      }),
    });
    const executing = {
      id: "instance-executing",
      getQueueState: () => ({
        workflowKey: boundKey,
        status: EXECUTION_STATES.RUNNING,
      }),
    };
    internal.instances.set("instance-executing", executing);

    assert.strictEqual(
      internal.workflowInstanceRegistry.findInstanceForLineage(boundKey),
      executing
    );
  });

  // Nothing deletes `lineageExecutionOwners` entries, so the rank they confer
  // has to expire on its own once the execution they describe is over.
  test("ignores a prepared-execution claim whose run already finished", () => {
    const { internal, boundKey } = createLineageBindingHarness();

    internal.instances.delete("instance-bound");
    const live = {
      id: "instance-live",
      getQueueState: () => ({
        workflowKey: boundKey,
        status: EXECUTION_STATES.IDLE,
      }),
    };
    internal.instances.set("instance-live", live);
    internal.retiredInstances.set("instance-finished", {
      id: "instance-finished",
      getQueueState: () => ({
        workflowKey: boundKey,
        status: EXECUTION_STATES.COMPLETED,
      }),
    });
    internal.lineageExecutionOwners.set(boundKey, {
      instanceId: "instance-finished",
      promoted: true,
    });

    assert.strictEqual(
      internal.workflowInstanceRegistry.findInstanceForLineage(boundKey),
      live
    );
  });

  // The bug this reproduces: continuing an already-completed run reuses that
  // run's own retired instance, whose status is still COMPLETED (left over
  // from the run just finished) right up until the continuation's own RUNNING
  // transition — which happens *after* this claim is set. A live idle instance
  // of the same lineage (e.g. one the client had drifted onto while browsing)
  // must not steal residency back during that window just because the claimed
  // instance's status happens to read as terminal.
  test("keeps a not-yet-promoted claim pinned even though its instance's status is still terminal from its own previous run", () => {
    const { internal, boundKey } = createLineageBindingHarness();

    internal.instances.delete("instance-bound");
    const liveIdle = {
      id: "instance-live-idle",
      getQueueState: () => ({
        workflowKey: boundKey,
        status: EXECUTION_STATES.IDLE,
      }),
    };
    internal.instances.set("instance-live-idle", liveIdle);
    const continuing = {
      id: "instance-continuing",
      getQueueState: () => ({
        workflowKey: boundKey,
        status: EXECUTION_STATES.COMPLETED,
      }),
    };
    internal.retiredInstances.set("instance-continuing", continuing);
    internal.lineageExecutionOwners.set(boundKey, {
      instanceId: "instance-continuing",
      promoted: false,
    });

    assert.strictEqual(
      internal.workflowInstanceRegistry.findInstanceForLineage(boundKey),
      continuing
    );
  });

  test("materializes an addressed instance only when the lineage has none resident", async () => {
    const { internal, freshLoads, freshLoadOptions } =
      createLineageBindingHarness();
    const other = "other" as never;
    const runRef = "run-2026-07-21T10-30-00-000Z" as never;

    await internal.runViewPublisher.bindClientToAddressedLineage(
      { workflowKey: other, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef },
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
    assert.deepStrictEqual(freshLoadOptions, [{ skipReplay: true }]);
  });

  test("does not rebind when the client already owns the target lineage", async () => {
    const { internal, replays } = createLineageBindingHarness();
    const other = "other" as never;
    const address = { workflowKey: other, kind: "draft" as const };

    internal.instances.set("instance-other", {
      id: "instance-other",
      getQueueState: () => ({ workflowKey: other }),
    });
    await internal.runViewPublisher.bindClientToAddressedLineage(
      address,
      () => undefined,
      "client-a"
    );
    await internal.runViewPublisher.bindClientToAddressedLineage(
      address,
      () => undefined,
      "client-a"
    );

    assert.strictEqual(
      internal.viewerRegistry.get("client-a"),
      "instance-other"
    );
    assert.deepStrictEqual(replays, []);
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

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: newer.runRef,
          },
        ],
        [
          "browser:delete",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: newer.runRef,
          },
        ],
        [
          "browser:older",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: older.runRef,
          },
        ],
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
      const feedbackCalls: Array<{ severity: string; message: string }> = [];
      internal.userFeedbackSink = {
        notify: (feedback: { severity: string; message: string }) =>
          feedbackCalls.push(feedback),
      };

      await orchestrator.deleteRunAtAddress(
        { workflowKey, runRef: newer.runRef },
        () => undefined,
        PANEL_CLIENT_ID
      );

      // Every displaced client shares one lineage-wide fallback, so the
      // deleted-run toast fires once, not once per client.
      assert.strictEqual(feedbackCalls.length, 1);
      assert.strictEqual(feedbackCalls[0].severity, "info");
      assert.strictEqual(
        feedbackCalls[0].message,
        `Run ${newer.runId} was deleted — you're now viewing Run ${older.runId}.`
      );

      const fallback = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: older.runRef,
      };
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

  test("deleteRunAtAddress deletes a run the requesting client is not currently viewing", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-delete-non-viewed-")
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
        getWorkflowName: () => "Delete non-viewed",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await fileManager.createWorkingFile(
        "delete-non-viewed",
        [{ prompt: "one" }],
        workspace,
        "Delete non-viewed"
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

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      // The requester (the run-navigation panel's client) is viewing an
      // unrelated lineage, not this one at all — proving delete no longer
      // requires the target to be the client's own viewed run.
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          {
            workflowKey: "other-lineage" as never,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          },
        ],
      ]);
      internal.viewMessageSinks = new Map();
      internal.lineageRepository = {
        readDescriptor: async () => ({ revision: 1, lastModifiedAt: 123 }),
      };
      const failedSummary = {
        id: "failed-instance",
        workflowKey,
        runRef: older.runRef,
        workflowName: "Delete non-viewed",
        executionState: EXECUTION_STATES.RUNNING,
        currentStep: 0,
        totalSteps: 1,
        finalStepRunning: false,
      };
      internal.observeWorkflowActivity(failedSummary);
      internal.observeWorkflowActivity({
        ...failedSummary,
        executionState: EXECUTION_STATES.ERROR,
      });
      assert.strictEqual(
        internal.getWorkflowActivityTracker().getOldestUnseenFailure()?.runRef,
        older.runRef
      );
      const pushed: Array<{ type?: string; runSummaries?: unknown[] }> = [];
      const feedbackCalls: Array<{ severity: string; message: string }> = [];
      internal.userFeedbackSink = {
        notify: (feedback: { severity: string; message: string }) =>
          feedbackCalls.push(feedback),
      };

      await orchestrator.deleteRunAtAddress(
        { workflowKey, runRef: older.runRef },
        (message) => pushed.push(message as { type?: string }),
        PANEL_CLIENT_ID
      );

      const remaining = await history.getRunSummaries(workflowKey);
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].runRef, newer.runRef);
      assert.deepStrictEqual(
        internal.getWorkflowActivityTracker().buildSummary([]).unseenFailures,
        []
      );

      // The requester is told the run went to Recently deleted (its Undo
      // toast) and, not being a registered viewer of this lineage, gets only
      // the manifest-only push — never a full RUN_VIEW_LOADED snapshot.
      assert.deepStrictEqual(
        pushed.map((message) => message.type),
        [MESSAGE_TYPES.HISTORY_TRASHED, MESSAGE_TYPES.RUN_SUMMARIES_LOADED]
      );
      assert.strictEqual(pushed[1].runSummaries?.length, 1);

      // Nobody was actually looking at the deleted run, so the toast must
      // stay silent.
      assert.strictEqual(feedbackCalls.length, 0);
    } finally {
      await history?.flushPendingIndexRefresh();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("deleteAllRunsForLineage deletes every non-executing run and leaves the executing run untouched", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-delete-all-runs-")
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
        getWorkflowName: () => "Delete all runs",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await fileManager.createWorkingFile(
        "delete-all-runs",
        [{ prompt: "one" }],
        workspace,
        "Delete all runs"
      );
      const first = await fileManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now() - 2_000
      );
      history = new OutputHistoryManager(workspace);
      await history.initializeRunAt(
        workflowKey,
        first.runRef,
        first.runDir,
        first.runId,
        Date.now() - 2_000
      );
      await history.finalizeRun(
        history.getHistoryFilePath(workflowKey, first.runRef),
        EXECUTION_STATES.COMPLETED,
        1
      );
      // Seeded for immediate execution, so its manifest opens RUNNING — the
      // seed-then-execute window where the manifest is the only record naming
      // the run as live. The executing run must survive the bulk delete.
      const second = await WorkingFileManager.seedNewRun(
        workspace,
        workflowKey,
        first.runRef,
        {},
        undefined,
        undefined,
        EXECUTION_STATES.RUNNING
      );
      await history.initializeRunAt(
        workflowKey,
        second.runRef,
        second.runDir,
        second.runId,
        second.startedAt
      );

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map([
        [
          "instance-1",
          {
            getQueueState: () => ({ workflowKey, runRef: second.runRef }),
            getExecutionRunRef: () => second.runRef,
          },
        ],
      ]);
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: first.runRef,
          },
        ],
      ]);
      const refreshed: Array<{ clientId: string; address: unknown }> = [];
      internal.viewMessageSinks = new Map();
      internal.loadRunViewForClient = async (
        address: unknown,
        _send: unknown,
        clientId: string
      ) => {
        refreshed.push({ clientId, address });
        internal.viewAddressRegistry.set(clientId, address);
      };

      await orchestrator.deleteAllRunsForLineage(
        workflowKey,
        () => undefined,
        PANEL_CLIENT_ID
      );

      const remaining = await history.getRunsForWorkflow(workflowKey);
      assert.deepStrictEqual(remaining, [second.runRef]);
      // The client viewing the now-deleted first run falls back to the
      // surviving (executing) run.
      assert.deepStrictEqual(refreshed, [
        {
          clientId: PANEL_CLIENT_ID,
          address: {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: second.runRef,
          },
        },
      ]);
    } finally {
      await history?.flushPendingIndexRefresh();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("loads the current most-recent run file for a first-time browser client", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    internal.viewerRegistry = new Map<string, string | null>();
    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.currentWorkspaceFolderPath = "C:\\dev\\ctrlyoke";
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
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    internal.viewerRegistry = new Map<string, string | null>([
      [PANEL_CLIENT_ID, "panel-workflow-id"],
    ]);
    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.currentWorkspaceFolderPath = "C:\\dev\\ctrlyoke";
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
    const orchestrator = createTestOrchestrator();
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
          replayFullStateTo: () => operations.push("session-restored"),
        },
      ],
    ]);
    internal.retiredInstances = new Map();
    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();
    internal.getActiveTerminalWorkflowRefs = () => [];
    internal.loadRunViewForClient = async (
      address: unknown,
      _send: (message: unknown) => void,
      clientId: string,
      _requestId: string | undefined,
      _definitionRollback: unknown,
      _announceReplayBoundary: boolean,
      skipTerminalReplay: boolean
    ) => {
      assert.strictEqual(skipTerminalReplay, true);
      assert.strictEqual(
        internal.viewerRegistry.get(clientId),
        workflowId,
        "the client must be bound before addressed loading awaits"
      );
      assert.deepStrictEqual(address, {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      });
      operations.push("run-view");
    };

    await orchestrator.replayWorkflowStateTo(
      workflowId,
      () => undefined,
      "browser:reconnect",
      { skipTerminalReplay: true }
    );

    assert.deepStrictEqual(operations, ["run-view"]);
  });

  test("loadRunSummariesForClient sends a request-correlated summary snapshot without binding a client view", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-summaries-")
    );
    try {
      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      const workflowKey = "summaries-lineage" as never;
      const sent: Array<{ type?: string }> = [];
      let bindCalls = 0;
      let resolveCalls = 0;

      internal.currentWorkspaceFolderPath = workspace;
      internal.viewAddressRegistry = new Map();
      internal.viewMessageSinks = new Map();
      internal.resolveAddressFilePath = () => {
        resolveCalls += 1;
        return "";
      };
      internal.findExecutionRunRef = () => undefined;
      internal.lineageRepository = {
        readDescriptor: async () => ({
          revision: 4,
          lastModifiedAt: 1_753_000_000_000,
        }),
      };
      internal.runViewPublisher.bindClientToAddressedLineage = async () => {
        bindCalls += 1;
        return null;
      };

      await orchestrator.loadRunSummariesForClient(
        workflowKey,
        (message) => sent.push(message as { type?: string }),
        "run-summaries-request-1"
      );

      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0], {
        type: MESSAGE_TYPES.RUN_SUMMARIES_LOADED,
        requestId: "run-summaries-request-1",
        workflowKey,
        descriptorRevision: 4,
        lastModifiedAt: 1_753_000_000_000,
        runSummaries: [],
        executionRunRef: undefined,
      });
      assert.strictEqual(
        bindCalls,
        0,
        "must not bind the client to the lineage — that would switch its view"
      );
      assert.strictEqual(
        resolveCalls,
        0,
        "must not load a working file for the lineage"
      );
      assert.strictEqual(internal.viewAddressRegistry.size, 0);
      assert.strictEqual(internal.viewMessageSinks.size, 0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("a lineage bind uses only the addressed run-view sender", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowId = "workflow-live";
    const workflowKey = "live-lineage" as never;
    const runRef = "run-2026-07-21T12-00-00-000Z" as never;
    const operations: string[] = [];
    const sent: unknown[] = [];

    internal.viewerRegistry = new Map<string, string | null>();
    internal.viewAddressRegistry = new Map();
    internal.instances = new Map([
      [
        workflowId,
        {
          getSummary: () => ({ workingFilePath: "C:\\workflow.json" }),
          getQueueState: () => ({ workflowKey, runRef }),
          replayFullStateTo: () => {
            sent.push({ type: MESSAGE_TYPES.SESSION_RESTORED });
          },
        },
      ],
    ]);
    internal.retiredInstances = new Map();
    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();
    internal.getActiveTerminalWorkflowRefs = () => [];
    internal.loadRunViewForClient = async () => {
      operations.push("run-view");
    };
    await orchestrator.replayWorkflowStateTo(
      workflowId,
      (msg) => sent.push(msg),
      "browser:reconnect",
      { skipTerminalReplay: true }
    );

    assert.deepStrictEqual(operations, ["run-view"]);
    assert.ok(
      !sent.some((msg) => {
        const type = (msg as { type?: string }).type;
        return (
          type === MESSAGE_TYPES.SESSION_RESTORED ||
          type === MESSAGE_TYPES.OUTPUT_HISTORY_LOADED ||
          type === MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY
        );
      }),
      "the addressed run-view path owns the lineage snapshot and identity"
    );
  });
});

suite("WorkflowOrchestrator draft mutation preparation", () => {
  test("reconciles a client's own addressed definition revision before the deep guard", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-ledger-orchestrator-")
    );
    try {
      const workflowKey =
        "ledger-workflow" as import("../../types/CtrlYokeTypes").WorkflowKey;
      const runRef = "run-1" as import("../../types/CtrlYokeTypes").RunRef;
      const address = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      } as const;
      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      let primedRevision: number | undefined;
      internal.currentWorkspaceFolderPath = workspace;
      internal.viewerRegistry = new Map([["client-a", "ledger-instance"]]);
      internal.viewAddressRegistry = new Map([["client-a", address]]);
      internal.viewMessageSinks = new Map();
      internal.instances = new Map([
        [
          "ledger-instance",
          {
            getQueueState: () => ({
              workflowKey,
              runRef,
              status: EXECUTION_STATES.RUNNING,
              definitionRevision: 4,
            }),
            getExecutionRunRef: () => runRef,
            ownsRunnerLock: () => true,
            expectDefinitionRevision: (revision: number) => {
              primedRevision = revision;
            },
          },
        ],
      ]);
      internal.retiredInstances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.definitionAuthorLedger.recordDefinition(address, "client-a", 4);

      const mutation = {
        address,
        expectedDefinitionRevision: 3,
        expectedDescriptorRevision: 1,
      };
      await orchestrator.prepareDefinitionMutation(mutation, "client-a");

      assert.strictEqual(mutation.expectedDefinitionRevision, 4);
      assert.strictEqual(primedRevision, 4);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

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

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.lineageRepository = repository;
      internal.viewerRegistry = new Map([
        ["client-a", "source-instance"],
        ["client-b", "execution-instance"],
      ]);
      internal.viewAddressRegistry = new Map([
        [
          "client-a",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
        ],
        [
          "client-b",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
        ],
      ]);
      internal.viewMessageSinks = new Map();
      let primedRevision: number | undefined;
      internal.instances = new Map([
        [
          "execution-instance",
          {
            getQueueState: () => ({ workflowKey, runRef: promoted.runRef }),
            getExecutionRunRef: () => promoted.runRef,
            ownsRunnerLock: () => false,
            expectDefinitionRevision: (revision: number) => {
              primedRevision = revision;
            },
          },
        ],
      ]);
      internal.retiredInstances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.loadFreshInstanceAndReplay = async () => {
        throw new Error("An idle run edit must not fork a draft");
      };

      await orchestrator.prepareDefinitionMutation(
        {
          address: {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        "client-a"
      );

      assert.strictEqual(primedRevision, 1);
      assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: promoted.runRef,
      });
      assert.deepStrictEqual(orchestrator.getViewAddress("client-b"), {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      let expectedRevision: number | undefined;
      internal.currentWorkspaceFolderPath = workspace;
      internal.lineageRepository = repository;
      internal.viewerRegistry = new Map([["client-a", "execution-instance"]]);
      internal.viewAddressRegistry = new Map([
        [
          "client-a",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
        ],
      ]);
      internal.instances = new Map([
        [
          "execution-instance",
          {
            getQueueState: () => ({
              workflowKey,
              runRef: promoted.runRef,
              status: EXECUTION_STATES.RUNNING,
              definitionRevision: 1,
            }),
            getExecutionRunRef: () => promoted.runRef,
            ownsRunnerLock: () => true,
            expectDefinitionRevision: (revision: number) => {
              expectedRevision = revision;
            },
          },
        ],
      ]);
      internal.retiredInstances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.loadFreshInstanceAndReplay = () => {
        throw new Error("An executing run must not fork a draft for settings");
      };

      await orchestrator.prepareWorkflowPropertiesMutation(
        {
          address: {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        "client-a"
      );

      assert.strictEqual(expectedRevision, 1);
      assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: promoted.runRef,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("keeps completed-run property edits on the resident instance while its inject PTY retains the lock", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-retained-run-properties-")
    );
    const ownerToken = WorkflowLockManager.generateOwnerToken();
    let workflowKey:
      import("../../types/CtrlYokeTypes").WorkflowKey | undefined;
    try {
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "source" }],
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
      const created = await sourceManager.createWorkingFile(
        "source",
        [{ prompt: "source" }],
        workspace,
        "Source"
      );
      workflowKey = created.workflowKey;
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
      await WorkflowLockManager.acquireLock(workspace, workflowKey, {
        schemaVersion: 2,
        workflowKey,
        runRef: promoted.runRef,
        runner: RUNNER_IDS.VSCODE,
        pid: process.pid,
        ownerToken,
        hostInstanceId: "retained-host",
        executionInstanceId: "retained-instance",
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      let primedRevision: number | undefined;
      const retained = {
        id: "retained-instance",
        getQueueState: () => ({
          workflowKey,
          runRef: promoted.runRef,
          status: EXECUTION_STATES.COMPLETED,
          definitionRevision: 1,
        }),
        getExecutionRunRef: () => promoted.runRef,
        ownsRunnerLock: () => true,
        expectDefinitionRevision: (revision: number) => {
          primedRevision = revision;
        },
      };
      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.lineageRepository = repository;
      internal.viewerRegistry = new Map([["client-a", retained.id]]);
      internal.viewAddressRegistry = new Map([
        [
          "client-a",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
        ],
      ]);
      internal.instances = new Map();
      internal.retiredInstances = new Map([[retained.id, retained]]);
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();

      await orchestrator.prepareWorkflowPropertiesMutation(
        {
          address: {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        "client-a"
      );

      assert.strictEqual(primedRevision, 1);
    } finally {
      if (workflowKey) {
        await WorkflowLockManager.releaseLock(
          workspace,
          workflowKey,
          ownerToken
        );
      }
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator run-addressed step edits", () => {
  test("changes completed step colors in place at index 0 and nonzero indexes", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-color-edit-")
    );
    try {
      const runtime = [
        { startedAt: 1, completedAt: 2 },
        { startedAt: 3, completedAt: 4 },
      ];
      const steps = [
        { prompt: "first", color: "#111111", _runtime: runtime[0] },
        { prompt: "second", color: "#222222", _runtime: runtime[1] },
      ];
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => steps,
        getCurrentIndex: () => steps.length,
        getStatus: () => EXECUTION_STATES.COMPLETED,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Color edit",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await sourceManager.createWorkingFile(
        "color-edit",
        steps,
        workspace,
        "Color edit"
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
      const messages: unknown[] = [];
      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.lineageRepository = repository;
      internal.instances = new Map();
      internal.retiredInstances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.viewAddressRegistry = new Map([
        [
          "client-a",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
        ],
      ]);
      internal.viewMessageSinks = new Map([
        ["client-a", (message: unknown) => messages.push(message)],
      ]);

      let expectedDefinitionRevision = 1;
      for (const [index, expectedRuntime, color] of [
        [0, runtime[0], "#abcdef"],
        [1, runtime[1], "#fedcba"],
      ] as const) {
        await orchestrator.updateStepColorInQueue(
          {
            address: {
              workflowKey,
              kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
              runRef: promoted.runRef,
            },
            expectedDefinitionRevision,
            expectedDescriptorRevision: descriptor.revision,
          },
          [index],
          color,
          "client-a"
        );

        const written = JSON.parse(
          await fs.readFile(promoted.workingFilePath, "utf8")
        );
        assert.strictEqual(written.steps[index].color, color);
        assert.deepStrictEqual(written.steps[index]._runtime, {
          ...expectedRuntime,
          stepId: written.steps[index]._runtime.stepId,
        });
        assert.strictEqual(written._runtime?.pendingRewind, undefined);
        const pendingRewindExists = await fs
          .access(
            WorkflowPaths.pendingRewindBaseFilePath(
              workspace,
              workflowKey,
              promoted.runRef
            )
          )
          .then(() => true)
          .catch(() => false);
        assert.strictEqual(pendingRewindExists, false);
        expectedDefinitionRevision = written.definitionRevision;
      }

      assert.ok(
        messages.some(
          (message) =>
            (message as { type?: string }).type ===
            MESSAGE_TYPES.STEP_COLOR_UPDATED
        )
      );
      assert.ok(
        messages.every(
          (message) =>
            (message as { type?: string }).type !==
            MESSAGE_TYPES.RUN_VIEW_LOADED
        )
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("edits an idle run's steps directly on disk when no live instance owns it, without creating a draft", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-static-edit-")
    );
    try {
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "keep" }, { prompt: "delete-me" }],
        getCurrentIndex: () => 0,
        getStatus: () => EXECUTION_STATES.IDLE,
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

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.lineageRepository = repository;
      internal.instances = new Map();
      internal.retiredInstances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.viewAddressRegistry = new Map([
        [
          "client-a",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
        ],
      ]);
      internal.viewMessageSinks = new Map([["client-a", () => undefined]]);

      await orchestrator.deletePromptFromQueue(
        {
          address: {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        [1],
        "client-a"
      );

      const written = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf8")
      );
      assert.strictEqual(written.steps.length, 1);
      assert.strictEqual(written.steps[0].prompt, "keep");
      assert.strictEqual(written.definitionRevision, 2);

      const draftExists = await fs
        .access(WorkflowPaths.draftFilePath(workspace, workflowKey))
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

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.viewerRegistry = new Map([["client-a", "unrelated-instance"]]);
      internal.viewAddressRegistry = new Map([
        [
          "client-a",
          {
            workflowKey: wf1,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: run1,
          },
        ],
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
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();

      await orchestrator.deletePromptFromQueue(
        {
          address: {
            workflowKey: wf1,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: run1,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: 1,
        },
        [0],
        "client-a"
      );

      assert.deepStrictEqual(deletedFrom, ["run-owning-instance"]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowInstanceRegistry promoteInstanceToLive", () => {
  // Regression: a multi-step run that briefly hits a terminal state gets retired
  // (moved to retiredInstances), then re-registered as RUNNING on the next step.
  // The re-registration must remove the retired copy so the instance is never in
  // both maps — otherwise the still-running workflow looks "retired" to
  // setViewedWorkflowId/unregisterClient, which can dispose it mid-run.
  test("removes the retired copy when an instance is promoted back to live", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    const instance = { id: "wf-1" };
    internal.instances = new Map<string, any>();
    internal.retiredInstances = new Map<string, any>([["wf-1", instance]]);

    const wasRetired =
      internal.workflowInstanceRegistry.promoteInstanceToLive(instance);

    assert.strictEqual(wasRetired, true);
    assert.strictEqual(internal.instances.get("wf-1"), instance);
    assert.strictEqual(
      internal.retiredInstances.has("wf-1"),
      false,
      "instance must not remain in retiredInstances after promotion"
    );
  });

  test("reports no stale entry when promoting a never-retired instance", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    const instance = { id: "wf-2" };
    internal.instances = new Map<string, any>();
    internal.retiredInstances = new Map<string, any>();

    const wasRetired =
      internal.workflowInstanceRegistry.promoteInstanceToLive(instance);

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
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    const nativePath =
      "c:\\dev\\ctrlyoke\\.ctrlyoke\\.runs\\wf\\run-2026-01-01T00-00-00-000Z\\workflow.ctrlyoke.json";
    const routePath =
      "c:/dev/ctrlyoke/.ctrlyoke/.runs/wf/run-2026-01-01T00-00-00-000Z/workflow.ctrlyoke.json";

    const liveInstance = {
      id: "live-1",
      getSummary: () => ({ workingFilePath: nativePath }),
    };

    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();
    internal.instances = new Map<string, any>([["live-1", liveInstance]]);
    internal.retiredInstances = new Map<string, any>();
    internal.ensureExternalRunWatchSession = async () => false;
    // liveInstance is a minimal double (id + getSummary only) predating the
    // workflow external-roots approval flow, and setViewedWorkflowId below is
    // stubbed rather than real, so the registry-backed resolution behind
    // approvePendingWorkflowExternalRootsForClient has nothing to resolve
    // against. Stub it out the same way the "checks workflow roots when
    // reloading a retired active working file" fixture does — this test is
    // only about path-matching, not roots approval.
    internal.approvePendingWorkflowExternalRootsForClient = async () => [];

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

suite("WorkflowOrchestrator addressed write revision publishing", () => {
  // The client echoes `definitionRevision` on its next mutation *and* on every
  // run-start action, so it is unusable until the write's new revision reaches
  // it. Sequencing that behind `invalidateRunViews` made the wait as long as a
  // lineage-wide summary scan (over four seconds on a large history), and a
  // Continue pressed inside that window was rejected as a revision conflict
  // and only worked on a second press.
  test("publishes a run-addressed write's revisions to viewers before its snapshot invalidation", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-write-revisions-")
    );
    try {
      const sourceAccess = {
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "prefix" }, { prompt: "suffix" }],
        getCurrentIndex: () => 2,
        getStatus: () => EXECUTION_STATES.ERROR,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Published",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      };
      const sourceManager = new WorkingFileManager(sourceAccess);
      const { workflowKey } = await sourceManager.createWorkingFile(
        "published",
        sourceAccess.getSteps(),
        workspace,
        "Published"
      );
      const run = await sourceManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      const address = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: run.runRef,
      };

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.retiredInstances = new Map();
      internal.lineageRepository = new WorkflowLineageRepository();
      internal.viewAddressRegistry = new Map([
        [PANEL_CLIENT_ID, address],
        ["browser:watcher", address],
      ]);
      const operations: string[] = [];
      const identities: unknown[] = [];
      const recordIdentity = (clientId: string) => (message: unknown) => {
        operations.push(`identity:${clientId}`);
        identities.push(message);
      };
      internal.viewMessageSinks = new Map([
        [PANEL_CLIENT_ID, recordIdentity(PANEL_CLIENT_ID)],
        ["browser:watcher", recordIdentity("browser:watcher")],
      ]);
      internal.invalidateRunViews = async () => {
        operations.push("snapshot");
      };

      await orchestrator.updateFinalStepInQueue(
        {
          address,
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: 1,
        } as never,
        { prompt: "wrap up" } as never,
        undefined,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(operations, [
        `identity:${PANEL_CLIENT_ID}`,
        "identity:browser:watcher",
        "snapshot",
      ]);
      // Every viewer of the written address is armed, not just the actor: the
      // revision a write supersedes is per-address, not per-client.
      for (const identity of identities) {
        assert.deepStrictEqual(
          (identity as { type: string; definitionRevision: number }).type,
          MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY
        );
        assert.strictEqual(
          (identity as { definitionRevision: number }).definitionRevision,
          2
        );
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  // Setting a start position is the most common prelude to pressing Continue,
  // and `RunLifecycleService.validateExplicitContinuationTarget` checks both
  // revisions the rewind just moved.
  test("publishes a rewind's revisions before its snapshot invalidation", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-rewind-revisions-")
    );
    let history: OutputHistoryManager | undefined;
    try {
      const sourceAccess = {
        getWorkingFilePath: () => undefined,
        getSteps: () => [
          { prompt: "prefix", _runtime: { startedAt: 1, completedAt: 2 } },
          { prompt: "suffix", _runtime: { startedAt: 3, completedAt: 4 } },
        ],
        getCurrentIndex: () => 2,
        getStatus: () => EXECUTION_STATES.ERROR,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Rewound",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      };
      const sourceManager = new WorkingFileManager(sourceAccess);
      const { workflowKey } = await sourceManager.createWorkingFile(
        "rewound",
        sourceAccess.getSteps(),
        workspace,
        "Rewound"
      );
      const run = await sourceManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      history = new OutputHistoryManager(workspace);
      await history.initializeRunAt(
        workflowKey,
        run.runRef,
        run.runDir,
        run.runId,
        Date.now()
      );
      const address = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: run.runRef,
      };

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.retiredInstances = new Map();
      internal.lineageRepository = new WorkflowLineageRepository();
      internal.viewAddressRegistry = new Map([[PANEL_CLIENT_ID, address]]);
      const operations: string[] = [];
      const identities: Array<{ definitionRevision: number }> = [];
      internal.viewMessageSinks = new Map([
        [
          PANEL_CLIENT_ID,
          (message: { definitionRevision: number }) => {
            operations.push("identity");
            identities.push(message);
          },
        ],
      ]);
      internal.invalidateRunViews = async () => {
        operations.push("snapshot");
      };

      const result = await orchestrator.setStartPositionAtRun(
        { workflowKey, runRef: run.runRef },
        1,
        1,
        await new WorkflowLineageRepository()
          .readDescriptor(workspace, workflowKey)
          .then((descriptor) => descriptor.revision),
        PANEL_CLIENT_ID
      );

      assert.strictEqual(result.kind, "rewind");
      assert.deepStrictEqual(operations, ["identity", "snapshot"]);
      assert.strictEqual(
        identities[0]?.definitionRevision,
        result.definitionRevision
      );
    } finally {
      await history?.flushPendingIndexRefresh();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator addressed start position", () => {
  test("seeding at index 0 moves the initiating client onto the fork and reports the descriptor's real revision", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-addressed-seed-")
    );
    try {
      const sourceAccess = {
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "prefix" }, { prompt: "suffix" }],
        getCurrentIndex: () => 2,
        getStatus: () => EXECUTION_STATES.ERROR,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Seeded",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      };
      const sourceManager = new WorkingFileManager(sourceAccess);
      const { workflowKey } = await sourceManager.createWorkingFile(
        "seeded",
        sourceAccess.getSteps(),
        workspace,
        "Seeded"
      );
      const source = await sourceManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      const lineageRepository = new WorkflowLineageRepository();
      const before = await lineageRepository.readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: source.runRef,
          },
        ],
      ]);
      internal.viewMessageSinks = new Map([[PANEL_CLIENT_ID, () => undefined]]);
      internal.lineageRepository = lineageRepository;
      const loaded: Array<{ address: any; clientId: string }> = [];
      internal.loadRunViewForClient = async (
        address: any,
        _send: unknown,
        clientId: string
      ) => {
        loaded.push({ address, clientId });
        internal.viewAddressRegistry.set(clientId, address);
      };
      const invalidated: Array<[string, string]> = [];
      internal.invalidateRunViews = async (key: string, runRef: string) => {
        invalidated.push([key, runRef]);
      };

      const result = await orchestrator.setStartPositionAtRun(
        { workflowKey, runRef: source.runRef },
        0,
        1,
        before.revision,
        PANEL_CLIENT_ID
      );

      assert.strictEqual(result.kind, "seeded");
      if (result.kind !== "seeded") return;

      // The regression: the seed advances the descriptor revision, and the
      // client was left echoing the pre-seed pair — so a second Set Start
      // Position failed with "Descriptor revision conflict".
      const after = await lineageRepository.readDescriptor(
        workspace,
        workflowKey
      );
      assert.strictEqual(result.descriptorRevision, after.revision);
      assert.strictEqual(result.definitionRevision, 1);
      assert.notStrictEqual(result.runRef, source.runRef);

      assert.deepStrictEqual(loaded, [
        {
          address: {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: result.runRef,
          },
          clientId: PANEL_CLIENT_ID,
        },
      ]);
      assert.deepStrictEqual(
        internal.viewAddressRegistry.get(PANEL_CLIENT_ID),
        {
          workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: result.runRef,
        }
      );
      // Clients left on the source run hold the same superseded revision.
      assert.deepStrictEqual(invalidated, [[workflowKey, source.runRef]]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

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

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: historical.runRef,
          },
        ],
        [
          "browser:rewind",
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: historical.runRef,
          },
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
      assert.ok(rewound.steps[1]._runtime?.stepId);
      assert.strictEqual(
        Object.keys(rewound.steps[1]._runtime ?? {}).length,
        1
      );
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

  test("editing a completed suffix rewinds before editing and discard restores the completed head", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-completed-edit-rewind-")
    );
    let history: OutputHistoryManager | undefined;
    try {
      const completedSteps = [
        {
          prompt: "completed prefix",
          _runtime: { startedAt: 1, completedAt: 2 },
        },
        {
          prompt: "completed suffix",
          _runtime: { startedAt: 3, completedAt: 4 },
        },
      ];
      const draftManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => completedSteps,
        getCurrentIndex: () => completedSteps.length,
        getStatus: () => EXECUTION_STATES.COMPLETED,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Completed edit",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await draftManager.createWorkingFile(
        "completed-edit",
        completedSteps,
        workspace,
        "Completed edit"
      );
      const promoted = await draftManager.promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      history = new OutputHistoryManager(workspace);
      await history.initializeRunAt(
        workflowKey,
        promoted.runRef,
        promoted.runDir,
        promoted.runId,
        Date.now()
      );
      const descriptorBefore =
        await new WorkflowLineageRepository().readDescriptor(
          workspace,
          workflowKey
        );
      const completedHead = await fs.readFile(promoted.workingFilePath);

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.retiredInstances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
        ],
      ]);
      internal.viewMessageSinks = new Map();
      internal.lineageRepository = new WorkflowLineageRepository();

      await orchestrator.updateCompletedPromptInQueue(
        {
          address: {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: promoted.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptorBefore.revision,
        },
        1,
        "edited suffix",
        {},
        undefined,
        undefined,
        PANEL_CLIENT_ID
      );

      const edited = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf8")
      );
      const descriptorAfter =
        await new WorkflowLineageRepository().readDescriptor(
          workspace,
          workflowKey
        );
      assert.strictEqual(edited.definitionRevision, 3);
      // Only the rewind (beginPendingRewind) bumps the descriptor — the
      // subsequent step edit is an ordinary run-content write and no longer
      // touches it.
      assert.strictEqual(
        descriptorAfter.revision,
        descriptorBefore.revision + 1
      );
      assert.strictEqual(edited._runtime.pendingRewind.fromStepIndex, 1);
      assert.strictEqual(edited._runtime.currentIndex, 1);
      assert.ok(edited.steps[0]._runtime?.completedAt);
      assert.strictEqual(edited.steps[1].prompt, "edited suffix");
      assert.ok(edited.steps[1]._runtime?.stepId);
      assert.strictEqual(Object.keys(edited.steps[1]._runtime ?? {}).length, 1);
      assert.deepStrictEqual(
        await fs.readFile(
          WorkflowPaths.pendingRewindBaseFilePath(
            workspace,
            workflowKey,
            promoted.runRef
          )
        ),
        completedHead,
        "Discard must retain the exact pre-edit completed definition"
      );

      const discarded = await WorkingFileManager.discardPendingRewind(
        workspace,
        workflowKey,
        promoted.runRef,
        edited.definitionRevision,
        descriptorAfter.revision,
        true
      );
      assert.strictEqual(discarded.discarded, true);
      assert.deepStrictEqual(
        await fs.readFile(promoted.workingFilePath),
        completedHead
      );
    } finally {
      await history?.flushPendingIndexRefresh();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("a never-run draft's start position edits the draft in place instead of seeding a run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-addressed-draft-start-position-")
    );
    try {
      const draftSteps = [
        { prompt: "step one" },
        { prompt: "step two" },
        { prompt: "step three" },
      ];
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => draftSteps,
        getCurrentIndex: () => 0,
        getStatus: () => EXECUTION_STATES.IDLE,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Draft Start Position",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await sourceManager.createWorkingFile(
        "draft-start-position",
        draftSteps,
        workspace,
        "Draft Start Position"
      );
      const lineageRepository = new WorkflowLineageRepository();
      const before = await lineageRepository.readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
        ],
      ]);
      internal.viewMessageSinks = new Map([[PANEL_CLIENT_ID, () => undefined]]);
      internal.lineageRepository = lineageRepository;
      const applied: number[] = [];
      internal.getInstanceForClient = () => ({
        getQueueState: () => ({ workflowKey }),
        setDraftStartPosition: async (toIndex: number) => {
          applied.push(toIndex);
        },
      });
      const invalidatedDrafts: string[] = [];
      internal.invalidateDraftViews = async (key: string) => {
        invalidatedDrafts.push(key);
      };

      await orchestrator.setStartPositionAtDraft(
        { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
        2,
        1,
        before.revision,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(applied, [2]);
      assert.deepStrictEqual(invalidatedDrafts, [workflowKey]);

      // No run was minted and the client stays on the draft — repositioning is
      // an edit, so repeating it cannot accumulate throwaway runs.
      const after = await lineageRepository.readDescriptor(
        workspace,
        workflowKey
      );
      assert.strictEqual(after.revision, before.revision);
      assert.strictEqual(after.nextRunId, before.nextRunId);
      assert.strictEqual(after.latestRunRef, undefined);
      await fs.access(WorkflowPaths.draftFilePath(workspace, workflowKey));
      assert.deepStrictEqual(
        internal.viewAddressRegistry.get(PANEL_CLIENT_ID),
        { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a draft start position against a superseded descriptor revision", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-addressed-draft-start-position-stale-")
    );
    try {
      const draftSteps = [{ prompt: "only step" }, { prompt: "second step" }];
      const sourceManager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => draftSteps,
        getCurrentIndex: () => 0,
        getStatus: () => EXECUTION_STATES.IDLE,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Draft Stale",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await sourceManager.createWorkingFile(
        "draft-stale",
        draftSteps,
        workspace,
        "Draft Stale"
      );
      const lineageRepository = new WorkflowLineageRepository();
      const current = await lineageRepository.readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
        ],
      ]);
      internal.viewMessageSinks = new Map([[PANEL_CLIENT_ID, () => undefined]]);
      internal.lineageRepository = lineageRepository;
      let applied = false;
      internal.getInstanceForClient = () => ({
        getQueueState: () => ({ workflowKey }),
        setDraftStartPosition: async () => {
          applied = true;
        },
      });

      await assert.rejects(
        orchestrator.setStartPositionAtDraft(
          { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
          1,
          1,
          current.revision + 1,
          PANEL_CLIENT_ID
        )
      );
      assert.strictEqual(applied, false);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

// "New Run (Don't Start)" and step-1 "Set start position" both prepare an
// unstarted run; neither may strand an existing unstarted run by copying it.
suite("WorkflowOrchestrator prepare new run", () => {
  async function createCompletedRun(workspace: string) {
    const steps = [
      { prompt: "first", _runtime: { startedAt: 1, completedAt: 2 } },
      { prompt: "second", _runtime: { startedAt: 3, completedAt: 4 } },
    ];
    const sourceAccess = {
      getWorkingFilePath: () => undefined,
      getSteps: () => steps,
      getCurrentIndex: () => 2,
      getStatus: () => EXECUTION_STATES.COMPLETED,
      getDefinitionRevision: () => 1,
      setDefinitionRevision: () => undefined,
      getWorkflowName: () => "Prepared",
      mergeDiskSteps: () => [],
      emitStateChange: () => undefined,
      getFinalStepRuntime: () => undefined,
      updateWorkflowProperty: () => undefined,
    };
    const manager = new WorkingFileManager(sourceAccess);
    const { workflowKey } = await manager.createWorkingFile(
      "prepared",
      steps,
      workspace,
      "Prepared"
    );
    const run = await manager.promoteToNewRun(
      workspace,
      workflowKey,
      Date.now()
    );
    return { workflowKey, runRef: run.runRef };
  }

  function wireOrchestrator(
    workspace: string,
    viewed: { workflowKey: string; runRef: string }
  ) {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    internal.currentWorkspaceFolderPath = workspace;
    internal.instances = new Map();
    internal.retiredInstances = new Map();
    internal.lineageRepository = new WorkflowLineageRepository();
    internal.viewAddressRegistry = new Map([
      [PANEL_CLIENT_ID, { ...viewed, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN }],
    ]);
    internal.viewMessageSinks = new Map([[PANEL_CLIENT_ID, () => undefined]]);
    const loaded: string[] = [];
    internal.loadRunViewForClient = async (
      address: any,
      _send: unknown,
      clientId: string
    ) => {
      loaded.push(address.runRef);
      internal.viewAddressRegistry.set(clientId, address);
    };
    internal.invalidateRunViews = async () => undefined;
    return { orchestrator, internal, loaded };
  }

  async function listRuns(
    workspace: string,
    source: { workflowKey: string; runRef: string }
  ) {
    const lineageDir = path.dirname(
      WorkflowPaths.runDir(
        workspace,
        source.workflowKey as never,
        source.runRef as never
      )
    );
    return (await fs.readdir(lineageDir)).filter((entry) =>
      entry.startsWith("run-")
    );
  }

  test("seeds an idle, unstarted run from a completed run and switches the client to it", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prepare-run-")
    );
    try {
      const source = await createCompletedRun(workspace);
      const { orchestrator, loaded } = wireOrchestrator(workspace, source);

      const result = await orchestrator.prepareNewRun(
        {
          workflowKey: source.workflowKey as never,
          runRef: source.runRef as never,
        },
        PANEL_CLIENT_ID
      );

      assert.strictEqual(result.reused, false);
      assert.notStrictEqual(result.runRef, source.runRef);
      assert.deepStrictEqual(loaded, [result.runRef]);
      const seeded = JSON.parse(
        await fs.readFile(
          WorkflowPaths.runFilePath(
            workspace,
            source.workflowKey as never,
            result.runRef
          ),
          "utf8"
        )
      );
      assert.strictEqual(seeded._runtime.executionState, EXECUTION_STATES.IDLE);
      assert.strictEqual(seeded._runtime.currentIndex, 0);
      // Identity survives the seed; execution evidence does not.
      for (const step of seeded.steps) {
        assert.ok(step._runtime?.stepId);
        assert.strictEqual(step._runtime.startedAt, undefined);
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("reopens an unstarted run instead of copying it", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prepare-reuse-")
    );
    try {
      const source = await createCompletedRun(workspace);
      const unstarted = await WorkingFileManager.seedNewRun(
        workspace,
        source.workflowKey as never,
        source.runRef as never,
        {},
        new WorkflowLineageRepository()
      );
      const { orchestrator, loaded } = wireOrchestrator(workspace, source);
      const runsBefore = await listRuns(workspace, source);

      const result = await orchestrator.prepareNewRun(
        {
          workflowKey: source.workflowKey as never,
          runRef: unstarted.runRef,
        },
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(result, {
        runRef: unstarted.runRef,
        reused: true,
      });
      assert.deepStrictEqual(loaded, [unstarted.runRef]);
      assert.deepStrictEqual(await listRuns(workspace, source), runsBefore);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("set start position 0 on an unstarted run keeps that run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prepare-start0-")
    );
    try {
      const source = await createCompletedRun(workspace);
      const lineageRepository = new WorkflowLineageRepository();
      const unstarted = await WorkingFileManager.seedNewRun(
        workspace,
        source.workflowKey as never,
        source.runRef as never,
        {},
        lineageRepository
      );
      const { orchestrator } = wireOrchestrator(workspace, {
        workflowKey: source.workflowKey,
        runRef: unstarted.runRef,
      });
      const descriptor = await lineageRepository.readDescriptor(
        workspace,
        source.workflowKey as never
      );
      const runsBefore = await listRuns(workspace, source);

      const result = await orchestrator.setStartPositionAtRun(
        {
          workflowKey: source.workflowKey as never,
          runRef: unstarted.runRef,
        },
        0,
        1,
        descriptor.revision,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(result, {
        kind: "seeded",
        runRef: unstarted.runRef,
        definitionRevision: 1,
        descriptorRevision: descriptor.revision,
      });
      assert.deepStrictEqual(await listRuns(workspace, source), runsBefore);
    } finally {
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
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    internal.currentWorkspaceFolderPath = workspace;
    internal.instances = new Map(instance ? [["active", instance]] : []);
    internal.retiredInstances = new Map();
    internal.externalRunWatchCoordinator =
      createEmptyExternalRunWatchCoordinator();
    internal.viewerRegistry = new Map();
    internal.viewAddressRegistry = new Map([
      [
        PANEL_CLIENT_ID,
        { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef },
      ],
    ]);
    internal.viewMessageSinks = new Map();
    internal.lineageRepository = new WorkflowLineageRepository();
    internal.invalidateRunViews = async () => undefined;
    // This suite's instance doubles (sourceInstance/resident/executionInstance/etc.)
    // are narrow fakes scoped to each test's own assertions; none implement the
    // full WorkflowInstance surface the external-roots approval guard reads
    // (promptQueue, getCurrentPromptFilePath). Roots approval itself is covered
    // separately by the dedicated "WorkflowOrchestrator workflow-root approval"
    // suite, so stub the guard here rather than growing every double.
    internal.assertNoPendingWorkflowExternalRoots = async () => undefined;
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

  test("prompt-editor run submission addressed at an older run continues that run, not the instance's run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-ephemeral-addressed-")
    );
    try {
      const historical = await createRun(workspace);
      const latest = await WorkingFileManager.seedNewRun(
        workspace,
        historical.workflowKey,
        historical.runRef
      );
      const latestBefore = await fs.readFile(latest.workingFilePath, "utf8");
      const boundInstance = {
        id: "bound-latest",
        getQueueState: () => ({
          workflowKey: historical.workflowKey,
          runRef: latest.runRef,
        }),
        executeEphemeralPrompt: async () => {
          throw new Error("must not append through the instance's loaded run");
        },
      };
      const { orchestrator, internal } = createHarness(
        workspace,
        historical.workflowKey,
        historical.runRef,
        boundInstance
      );
      internal.viewerRegistry.set(PANEL_CLIENT_ID, "active");
      let executed: [string, string, number] | undefined;
      internal.buildWorkflowInstance = () => ({
        id: "continuation-owner",
        executeContinuationAtRun: async (...args: [string, string, number]) => {
          executed = args;
        },
      });

      await orchestrator.executeEphemeralPrompt(
        "appended tail",
        {},
        ACTION_TYPES.RUN,
        undefined,
        PANEL_CLIENT_ID,
        {
          address: {
            workflowKey: historical.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: historical.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: 3,
        }
      );

      assert.deepStrictEqual(executed?.slice(0, 3), [
        historical.workflowKey,
        historical.runRef,
        2,
      ]);
      const appended = JSON.parse(
        await fs.readFile(historical.workingFilePath, "utf8")
      );
      assert.strictEqual(appended.steps.length, 2);
      assert.strictEqual(appended.steps[1].prompt, "appended tail");
      assert.strictEqual(
        await fs.readFile(latest.workingFilePath, "utf8"),
        latestBefore
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("prompt-editor queue submission addressed at an older run appends to its head without executing", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-ephemeral-queue-")
    );
    try {
      const historical = await createRun(workspace);
      const latest = await WorkingFileManager.seedNewRun(
        workspace,
        historical.workflowKey,
        historical.runRef
      );
      const latestBefore = await fs.readFile(latest.workingFilePath, "utf8");
      const descriptor = await new WorkflowLineageRepository().readDescriptor(
        workspace,
        historical.workflowKey
      );
      const boundInstance = {
        id: "bound-latest",
        getQueueState: () => ({
          workflowKey: historical.workflowKey,
          runRef: latest.runRef,
        }),
        executeEphemeralPrompt: async () => {
          throw new Error("must not append through the instance's loaded run");
        },
      };
      const { orchestrator, internal } = createHarness(
        workspace,
        historical.workflowKey,
        historical.runRef,
        boundInstance
      );
      internal.viewerRegistry.set(PANEL_CLIENT_ID, "active");
      internal.buildWorkflowInstance = () => {
        throw new Error("queueing a step must not execute the run");
      };

      await orchestrator.executeEphemeralPrompt(
        "queued tail",
        {},
        ACTION_TYPES.QUEUE,
        undefined,
        PANEL_CLIENT_ID,
        {
          address: {
            workflowKey: historical.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: historical.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        }
      );

      const appended = JSON.parse(
        await fs.readFile(historical.workingFilePath, "utf8")
      );
      assert.strictEqual(appended.steps.length, 2);
      assert.strictEqual(appended.steps[1].prompt, "queued tail");
      assert.strictEqual(appended.definitionRevision, 2);
      assert.strictEqual(
        await fs.readFile(latest.workingFilePath, "utf8"),
        latestBefore
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("prompt-editor submission whose addressed run the instance owns keeps the instance-bound path", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-ephemeral-owned-")
    );
    try {
      const run = await createRun(workspace);
      let instanceAppend: unknown[] | undefined;
      const boundInstance = {
        id: "bound-owner",
        getQueueState: () => ({
          workflowKey: run.workflowKey,
          runRef: run.runRef,
        }),
        getSummary: () => ({
          totalSteps: 1,
          executionState: EXECUTION_STATES.COMPLETED,
        }),
        executeEphemeralPrompt: async (...args: unknown[]) => {
          instanceAppend = args;
        },
      };
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef,
        boundInstance
      );
      internal.viewerRegistry.set(PANEL_CLIENT_ID, "active");
      internal.buildWorkflowInstance = () => {
        throw new Error("owned-run submissions must reuse the bound instance");
      };

      await orchestrator.executeEphemeralPrompt(
        "same run",
        {},
        ACTION_TYPES.RUN,
        undefined,
        PANEL_CLIENT_ID,
        {
          address: {
            workflowKey: run.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: run.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: 2,
        }
      );

      assert.deepStrictEqual(instanceAppend, [
        "same run",
        {},
        ACTION_TYPES.RUN,
        undefined,
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("starts a new workflow for one client without touching the source instance", async () => {
    const sourceInstance = {
      id: "source-instance",
      getQueueState: () => ({ status: EXECUTION_STATES.RUNNING }),
      getSummary: () => ({
        executionState: EXECUTION_STATES.RUNNING,
        workflowName: "Source workflow",
      }),
    };
    const { orchestrator, internal } = createHarness(
      path.join(os.tmpdir(), "ctrlyoke-new-workflow-test"),
      "source-key" as never,
      "source-run" as never,
      sourceInstance
    );
    internal.instances.delete("active");
    internal.instances.set(sourceInstance.id, sourceInstance);
    const clientId = "browser:new-workflow";
    internal.viewerRegistry.set(clientId, sourceInstance.id);
    const events: string[] = [];
    const sent: unknown[] = [];
    let initialized: unknown[] | undefined;
    let startedWith: unknown;
    const newInstance = {
      id: "new-instance",
      initializeEphemeralPrompt: async (...args: unknown[]) => {
        events.push("seed");
        initialized = args;
        return "claude-cli";
      },
      executeLoadedPromptFile: async (harness: unknown) => {
        events.push("execute");
        startedWith = harness;
      },
      getSummary: () => ({ workflowName: "Spin-off" }),
      getQueueState: () => ({ status: EXECUTION_STATES.IDLE }),
    };
    // Instance construction is owned by the registry, so that is the seam a
    // test must replace to hand back a double.
    internal.workflowInstanceRegistry.buildWorkflowInstanceForHost = () => {
      events.push("register");
      return newInstance;
    };
    internal.replayWorkflowStateTo = async (
      workflowId: string,
      _send: unknown,
      replayClientId: string
    ) => {
      events.push("replay");
      assert.strictEqual(workflowId, newInstance.id);
      assert.strictEqual(replayClientId, clientId);
      assert.strictEqual(internal.viewerRegistry.get(clientId), newInstance.id);
    };

    const ptyManager = initPtyProcessManager(() => undefined);
    try {
      const explicitProperties = {
        harness: "claude-cli",
        model: "model-from-draft",
      };
      await orchestrator.runInNewWorkflowForClient(
        "spin-off prompt",
        explicitProperties,
        "Spin-off",
        (message) => sent.push(message),
        clientId
      );

      assert.deepStrictEqual(events, ["register", "seed", "replay", "execute"]);
      assert.deepStrictEqual(initialized, [
        "spin-off prompt",
        explicitProperties,
        "Spin-off",
      ]);
      assert.strictEqual(startedWith, "claude-cli");
      assert.strictEqual(sent.length, 0);
      assert.strictEqual(
        ptyManager.getExpectedController(newInstance.id),
        clientId
      );
      assert.strictEqual(
        internal.instances.get(sourceInstance.id),
        sourceInstance
      );
      assert.strictEqual(
        sourceInstance.getSummary().executionState,
        EXECUTION_STATES.RUNNING
      );
      assert.strictEqual(internal.instances.get(newInstance.id), newInstance);
    } finally {
      ptyManager.dispose();
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

  test("running a draft moves the initiating client onto the promoted run before execution finishes", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-execute-draft-")
    );
    try {
      const manager = new WorkingFileManager({
        getWorkingFilePath: () => undefined,
        getSteps: () => [{ prompt: "step one" }],
        getCurrentIndex: () => 0,
        getStatus: () => EXECUTION_STATES.IDLE,
        getDefinitionRevision: () => 1,
        setDefinitionRevision: () => undefined,
        getWorkflowName: () => "Draft run",
        mergeDiskSteps: () => [],
        emitStateChange: () => undefined,
        getFinalStepRuntime: () => undefined,
        updateWorkflowProperty: () => undefined,
      });
      const { workflowKey } = await manager.createWorkingFile(
        "draft-run",
        [{ prompt: "step one" }],
        workspace,
        "Draft run"
      );
      const descriptor = await new WorkflowLineageRepository().readDescriptor(
        workspace,
        workflowKey
      );

      const orchestrator = createTestOrchestrator();
      const internal = orchestrator as any;
      internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
      internal.currentWorkspaceFolderPath = workspace;
      internal.instances = new Map();
      internal.retiredInstances = new Map();
      internal.externalRunWatchCoordinator =
        createEmptyExternalRunWatchCoordinator();
      internal.viewAddressRegistry = new Map([
        [
          PANEL_CLIENT_ID,
          { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
        ],
      ]);
      internal.viewMessageSinks = new Map();
      internal.lineageRepository = new WorkflowLineageRepository();
      // fakeInstance below is a narrow double for the execution/address-switch
      // behavior this test covers; it doesn't implement the WorkflowInstance
      // surface the external-roots approval guard reads. That's covered
      // separately by the dedicated "WorkflowOrchestrator workflow-root
      // approval" suite, so stub the guard here.
      internal.assertNoPendingWorkflowExternalRoots = async () => undefined;

      // Execution never resolves until the test releases it — proves
      // executeDraftAtAddress resolves once the client is switched onto the
      // promoted run's address, not once the whole run finishes.
      const promotedRunRef = "run-2026-08-14T00-00-00-000Z" as never;
      let releaseExecution!: () => void;
      const executionGate = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      const fakeInstance = {
        getQueueState: () => ({ workflowKey, runRef: promotedRunRef }),
        executeLoadedPromptFile: async (
          _mode: unknown,
          _continueFromCurrent: unknown,
          _preinitializedHistoryFilePath: unknown,
          _prePromotedFreshStart: unknown,
          onPrepared?: () => Promise<void>
        ) => {
          await onPrepared?.();
          await executionGate;
        },
      };
      internal.getInstanceForClient = () => fakeInstance;

      await orchestrator.executeDraftAtAddress(
        { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
        1,
        descriptor.revision,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(
        internal.viewAddressRegistry.get(PANEL_CLIENT_ID),
        {
          workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: promotedRunRef,
        }
      );

      releaseExecution();
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
        clearPendingRewind: () => undefined,
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

  test("continues a run whose lock is retained by a resident instance in a spent state", async () => {
    // A named-worktree run that errored while retaining its injectable PTY
    // (`preserveWorktreeReservation` in `WorkflowInstance`) stays resident and
    // keeps the runner lock, but its queue status is a terminal, non-owner
    // state (ERROR). The owner-state-filtered lookup misses it, so the
    // self-owned-active-lock branch must fall back to `findResidentInstanceForRun`
    // instead of treating this as an untracked invariant violation.
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-retained-lock-continue-")
    );
    try {
      const run = await createRun(workspace);
      await fs.writeFile(
        WorkflowLockManager.getLockPath(workspace, run.workflowKey),
        JSON.stringify({
          schemaVersion: 2,
          workflowKey: run.workflowKey,
          runRef: run.runRef,
          runner: RUNNER_IDS.VSCODE,
          pid: process.pid,
          ownerToken: "retained-owner",
          hostInstanceId: "test-host",
          executionInstanceId: "retained-instance",
          startedAt: Date.now(),
          lastHeartbeat: Date.now(),
        }),
        "utf8"
      );
      let continued = false;
      const retained = {
        id: "retained-worktree-owner",
        getQueueState: () => ({
          workflowKey: run.workflowKey,
          runRef: run.runRef,
          status: EXECUTION_STATES.ERROR,
        }),
        getExecutionRunRef: () => run.runRef,
        ownsRunnerLock: () => true,
        clearPendingRewind: () => undefined,
        executeContinuationAtRun: async () => {
          continued = true;
        },
      };
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef,
        retained
      );
      internal.runnerHostIdentity = {
        runner: RUNNER_IDS.VSCODE,
        hostInstanceId: "test-host",
        pid: process.pid,
      };

      await orchestrator.continueAtRun(
        { workflowKey: run.workflowKey, runRef: run.runRef },
        1,
        2,
        PANEL_CLIENT_ID
      );

      assert.strictEqual(continued, true);
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
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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

  test("run-addressed property update pushes properties to run viewers instead of a full snapshot", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prop-invalidate-")
    );
    try {
      const run = await createRun(workspace);
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let snapshotInvalidations = 0;
      internal.invalidateRunViews = async () => {
        snapshotInvalidations += 1;
      };
      const received: any[] = [];
      internal.viewMessageSinks = new Map([
        [PANEL_CLIENT_ID, (message: unknown) => received.push(message)],
      ]);
      const descriptor = await internal.lineageRepository.readDescriptor(
        workspace,
        run.workflowKey
      );

      const result = await orchestrator.updateWorkingFileProperties(
        {
          address: {
            workflowKey: run.workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: run.runRef,
          },
          expectedDefinitionRevision: 1,
          expectedDescriptorRevision: descriptor.revision,
        },
        { model: "test-model" },
        {},
        PANEL_CLIENT_ID
      );

      assert.strictEqual(result?.appliedKeys.includes("model"), true);
      // A property-only write must not replay the full run snapshot — the
      // webview treats RUN_VIEW_LOADED as a workflow load and redraws the
      // entire output pane.
      assert.strictEqual(snapshotInvalidations, 0);
      assert.strictEqual(
        received.some(
          (message) => message.type === MESSAGE_TYPES.RUN_VIEW_LOADED
        ),
        false
      );
      const propertyPushes = received.filter(
        (message) => message.type === MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE
      );
      assert.strictEqual(propertyPushes.length, 1);
      assert.strictEqual(
        propertyPushes[0].workflowProperties.model,
        "test-model"
      );
      // The push carries properties only, never definition steps.
      assert.strictEqual(propertyPushes[0].workflowProperties.steps, undefined);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  async function createTwoStepRun(workspace: string): Promise<{
    workflowKey: import("../../types/CtrlYokeTypes").WorkflowKey;
    runRef: import("../../types/CtrlYokeTypes").RunRef;
    workingFilePath: string;
  }> {
    const steps = [{ prompt: "prefix" }, { prompt: "suffix" }];
    const manager = new WorkingFileManager({
      getWorkingFilePath: () => undefined,
      getSteps: () => steps,
      getCurrentIndex: () => 2,
      getStatus: () => EXECUTION_STATES.COMPLETED,
      getDefinitionRevision: () => 1,
      setDefinitionRevision: () => undefined,
      getWorkflowName: () => "Rewind",
      mergeDiskSteps: () => [],
      emitStateChange: () => undefined,
      getFinalStepRuntime: () => undefined,
      updateWorkflowProperty: () => undefined,
    });
    const { workflowKey } = await manager.createWorkingFile(
      "rewind",
      steps,
      workspace,
      "Rewind"
    );
    const promoted = await manager.promoteToNewRun(
      workspace,
      workflowKey,
      Date.now()
    );
    return { workflowKey, ...promoted };
  }

  test("discard invalidation identifies the intentional definition rollback", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-discard-rewind-")
    );
    try {
      const run = await createTwoStepRun(workspace);
      const rewind = await WorkingFileManager.beginPendingRewind(
        workspace,
        run.workflowKey,
        run.runRef,
        1,
        1,
        (
          await new WorkflowLineageRepository().readDescriptor(
            workspace,
            run.workflowKey
          )
        ).revision
      );
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let residentResyncs = 0;
      const resident = {
        id: "resident-run-instance",
        getQueueState: () => ({
          workflowKey: run.workflowKey,
          runRef: run.runRef,
        }),
        resyncWorkingFileFromDisk: async () => {
          residentResyncs += 1;
        },
      };
      internal.instances.set(resident.id, resident);
      let invalidation: unknown[] | undefined;
      internal.invalidateRunViews = async (...args: unknown[]) => {
        invalidation = args;
      };

      const discarded = await orchestrator.discardContinuationAtRun(
        { workflowKey: run.workflowKey, runRef: run.runRef },
        rewind.definitionRevision,
        rewind.descriptorRevision,
        false,
        PANEL_CLIENT_ID
      );

      assert.strictEqual(discarded.discarded, true);
      assert.strictEqual(residentResyncs, 1);
      assert.deepStrictEqual(invalidation, [
        run.workflowKey,
        run.runRef,
        {
          fromRevision: rewind.definitionRevision,
          restoredRevision: 1,
          descriptorRevision: rewind.descriptorRevision + 1,
        },
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("continuing a run with a pending rewind commits the rewind instead of rejecting it", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-continue-rewind-")
    );
    try {
      const run = await createTwoStepRun(workspace);
      const rewind = await WorkingFileManager.beginPendingRewind(
        workspace,
        run.workflowKey,
        run.runRef,
        1,
        1,
        (
          await new WorkflowLineageRepository().readDescriptor(
            workspace,
            run.workflowKey
          )
        ).revision
      );
      const pending = await new WorkflowLineageRepository().readDescriptor(
        workspace,
        run.workflowKey
      );
      assert.strictEqual(pending.pendingEdit?.kind, "rewind");

      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let executed: [string, string, number] | undefined;
      internal.buildWorkflowInstance = () => ({
        executeContinuationAtRun: async (...args: [string, string, number]) => {
          executed = args;
        },
      });

      await orchestrator.continueAtRun(
        { workflowKey: run.workflowKey, runRef: run.runRef },
        rewind.definitionRevision,
        rewind.descriptorRevision,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(executed?.slice(0, 3), [
        run.workflowKey,
        run.runRef,
        rewind.definitionRevision,
      ]);
      const after = await new WorkflowLineageRepository().readDescriptor(
        workspace,
        run.workflowKey
      );
      assert.strictEqual(
        after.pendingEdit,
        undefined,
        "continuation must clear the pending rewind marker"
      );
      const workingFile = JSON.parse(
        await fs.readFile(run.workingFilePath, "utf8")
      );
      assert.strictEqual(
        workingFile._runtime?.pendingRewind,
        undefined,
        "continuation must strip the runtime rewind marker"
      );
      assert.strictEqual(
        workingFile.definitionRevision,
        rewind.definitionRevision,
        "committing a rewind must not change the definition revision"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  /** A rewind whose descriptor edit was committed but whose run-file flag was written back. */
  async function createOrphanedRewind(workspace: string) {
    const run = await createTwoStepRun(workspace);
    const lineage = new WorkflowLineageRepository();
    const rewind = await WorkingFileManager.beginPendingRewind(
      workspace,
      run.workflowKey,
      run.runRef,
      1,
      1,
      (await lineage.readDescriptor(workspace, run.workflowKey)).revision
    );
    const committed = await WorkingFileManager.commitPendingRewind(
      workspace,
      run.workflowKey,
      run.runRef,
      rewind.definitionRevision,
      rewind.descriptorRevision
    );
    const workingFile = JSON.parse(
      await fs.readFile(run.workingFilePath, "utf8")
    );
    workingFile._runtime = {
      ...workingFile._runtime,
      pendingRewind: {
        fromStepIndex: 1,
        baseDefinitionRevision: rewind.definitionRevision,
      },
    };
    await fs.writeFile(run.workingFilePath, JSON.stringify(workingFile));
    return { run, committed };
  }

  test("continuing clears a run-file pendingRewind the descriptor no longer backs", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-continue-orphan-rewind-")
    );
    try {
      const { run, committed } = await createOrphanedRewind(workspace);
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef
      );
      let executed = false;
      internal.buildWorkflowInstance = () => ({
        executeContinuationAtRun: async () => {
          executed = true;
        },
      });

      await orchestrator.continueAtRun(
        { workflowKey: run.workflowKey, runRef: run.runRef },
        committed.definitionRevision,
        committed.descriptorRevision,
        PANEL_CLIENT_ID
      );

      assert.strictEqual(executed, true);
      const workingFile = JSON.parse(
        await fs.readFile(run.workingFilePath, "utf8")
      );
      assert.strictEqual(
        workingFile._runtime?.pendingRewind,
        undefined,
        "an orphaned flag must not survive a continuation"
      );
      assert.strictEqual(
        workingFile.definitionRevision,
        committed.definitionRevision
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("continuing drops the in-memory pending rewind from every resident instance bound to the run", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-continue-clears-memory-")
    );
    try {
      const run = await createTwoStepRun(workspace);
      const rewind = await WorkingFileManager.beginPendingRewind(
        workspace,
        run.workflowKey,
        run.runRef,
        1,
        1,
        (
          await new WorkflowLineageRepository().readDescriptor(
            workspace,
            run.workflowKey
          )
        ).revision
      );
      const cleared: string[] = [];
      const resident = (id: string, runRef = run.runRef) => ({
        id,
        getQueueState: () => ({
          status: EXECUTION_STATES.IDLE,
          workflowKey: run.workflowKey,
          runRef,
        }),
        getExecutionRunRef: () => undefined,
        clearPendingRewind: () => {
          cleared.push(id);
        },
        executeContinuationAtRun: async () => undefined,
      });
      const { orchestrator, internal } = createHarness(
        workspace,
        run.workflowKey,
        run.runRef,
        resident("live")
      );
      internal.retiredInstances = new Map([
        ["retired", resident("retired")],
        ["other-run", resident("other-run", "run-other" as never)],
      ]);

      await orchestrator.continueAtRun(
        { workflowKey: run.workflowKey, runRef: run.runRef },
        rewind.definitionRevision,
        rewind.descriptorRevision,
        PANEL_CLIENT_ID
      );

      assert.deepStrictEqual(cleared, ["live", "retired"]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

suite("WorkflowOrchestrator client view addressing", () => {
  test("adopts an instance's own lineage for the clients bound to it", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const previousKey = "previous-lineage" as never;
    const newKey = "new-lineage" as never;

    internal.viewerRegistry = new Map([
      ["client-a", "new-instance"],
      ["client-b", "other-instance"],
    ]);
    internal.viewAddressRegistry = new Map([
      [
        "client-a",
        { workflowKey: previousKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      ],
      [
        "client-b",
        { workflowKey: previousKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      ],
    ]);

    internal.workflowInstanceRegistry.adoptInstanceLineageAddress(
      { id: "new-instance" },
      {
        workflowKey: newKey,
      }
    );

    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey: newKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });
    assert.deepStrictEqual(orchestrator.getViewAddress("client-b"), {
      workflowKey: previousKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });
  });

  // Regression: `promoteToNewRun` sets the queue's RunRef and emits *while the
  // queue is still idle*, so this adoption always runs before the RUNNING
  // transition that calls `syncExecutingRunViews`. Silently repointing the
  // draft holder here therefore consumed the only evidence that client had not
  // been shown the run, and the sync — whose guard is `kind === "draft"` —
  // became unreachable: every promotion in nine sessions of logs pushed zero
  // run views, leaving the dashboard offering "Run draft" for a finished run.
  test("leaves a promoted lineage's draft holder addressable for the run-view push", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowKey = "promoted-lineage" as never;
    const runRef = "run-2026-07-21T10-00-00-000Z" as never;

    internal.viewerRegistry = new Map([["client-a", "instance"]]);
    internal.viewAddressRegistry = new Map([
      ["client-a", { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT }],
    ]);

    internal.workflowInstanceRegistry.adoptInstanceLineageAddress(
      { id: "instance" },
      { workflowKey, runRef }
    );

    assert.deepStrictEqual(
      orchestrator.getViewAddress("client-a"),
      { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
      "the draft address must survive adoption so syncExecutingRunViews can recognise this client"
    );
  });

  test("keeps a client reading an older run of the promoted lineage on that run", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowKey = "promoted-lineage" as never;
    const olderRun = "run-2026-07-21T09-00-00-000Z" as never;
    const newRun = "run-2026-07-21T10-00-00-000Z" as never;

    internal.viewerRegistry = new Map([["reader", "instance"]]);
    internal.viewAddressRegistry = new Map([
      [
        "reader",
        { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef: olderRun },
      ],
    ]);

    internal.workflowInstanceRegistry.adoptInstanceLineageAddress(
      { id: "instance" },
      { workflowKey, runRef: newRun }
    );

    assert.deepStrictEqual(
      orchestrator.getViewAddress("reader"),
      { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef: olderRun },
      "only the run's initiator follows a promotion; a history reader keeps its view"
    );
  });

  // The whole promotion sequence, in the order the instance emits it: the
  // RunRef lands on an idle queue (adoption), then the queue goes RUNNING
  // (sync). Asserting the two together is what the separate unit tests missed.
  test("publishes the promoted run to the draft holder across the full emit sequence", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowKey = "promoted-lineage" as never;
    const runRef = "run-2026-07-21T10-00-00-000Z" as never;
    const instance = {
      id: "instance",
      getQueueState: () => ({ workflowKey, runRef }),
    };

    internal.viewerRegistry = new Map([["client-a", "instance"]]);
    internal.viewAddressRegistry = new Map([
      ["client-a", { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT }],
    ]);
    internal.viewMessageSinks = new Map([["client-a", () => undefined]]);
    const loaded: unknown[] = [];
    internal.publishRunViewToClients = async (address: unknown) => {
      loaded.push(address);
    };

    internal.workflowInstanceRegistry.adoptInstanceLineageAddress(instance, {
      workflowKey,
      runRef,
    });
    internal.syncExecutingRunViews(instance);
    // RUNNING is emitted many times per run; only the first may publish.
    internal.syncExecutingRunViews(instance);

    assert.deepStrictEqual(loaded, [
      { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef },
    ]);
    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef,
    });
  });

  test("moves a sink-less draft holder off the deleted draft even though it cannot be shown the run", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowKey = "promoted-lineage" as never;
    const runRef = "run-2026-07-21T10-00-00-000Z" as never;

    internal.viewerRegistry = new Map([["client-a", "instance"]]);
    internal.viewAddressRegistry = new Map([
      ["client-a", { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT }],
    ]);
    internal.viewMessageSinks = new Map();
    internal.publishRunViewToClients = async () => {
      assert.fail("a client with no sink cannot be published to");
    };

    internal.syncExecutingRunViews({
      id: "instance",
      getQueueState: () => ({ workflowKey, runRef }),
    });

    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef,
    });
  });

  // Driven through the instance's real `onDidChangeState` listener, because the
  // defect this guards is in the *wiring*: a run start that throws after its
  // promotion published the run (harness unavailable, lock contention, timeline
  // init) never reaches RUNNING, and the draft those clients address was
  // deleted by that promotion. Syncing only on RUNNING stranded them on a file
  // that no longer exists while their definition sat in the promoted run.
  test("lands a draft holder on the promoted run when the start fails before RUNNING", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    const workflowKey = "failed-start-lineage" as never;
    const runRef = "run-2026-07-30T14-00-00-000Z" as never;

    internal.platform = new MockPlatform(os.tmpdir());
    internal.currentWorkspaceFolderPath = os.tmpdir();
    internal.instances = new Map();
    internal.retiredInstances = new Map();
    internal.viewerRegistry = new Map();
    internal.viewAddressRegistry = new Map();
    internal.viewMessageSinks = new Map();
    internal.externallyCreatedInstanceIds = new Set<string>();
    internal.announcedExternalWorkflowIds = new Set<string>();
    // A real instance broadcasts state through the hub as an IDashboardSink;
    // this test is about view addressing, so every notification is a no-op.
    internal.dashboardBroadcastHub = new Proxy(
      {},
      { get: () => () => undefined }
    );
    internal.resolveDetectorIntegration = () => ({});
    internal.propagateWorkflowNameToIntegrations = () => undefined;
    internal.updateStatusBar = () => undefined;

    const instance = internal.buildWorkflowInstance();
    internal.viewerRegistry.set("client-a", instance.id);
    internal.viewAddressRegistry.set("client-a", {
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });
    internal.viewMessageSinks.set("client-a", () => undefined);
    const loaded: unknown[] = [];
    internal.publishRunViewToClients = async (address: unknown) => {
      loaded.push(address);
    };

    // The promotion published its run, then the start threw: the queue carries
    // the new RunRef and the runtime reports ERROR without ever having run.
    const queue = instance.promptQueue as any;
    queue.state.workflowKey = workflowKey;
    queue.state.runRef = runRef;
    (instance as any).workflowRuntime.fail();
    queue.emitStateChange();

    assert.deepStrictEqual(
      loaded,
      [{ workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef }],
      "the failed start's run must be published to the stranded draft holder"
    );
    assert.deepStrictEqual(orchestrator.getViewAddress("client-a"), {
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef,
    });
  });

  // Guards the commit-message-generation background-run fix: an externally
  // created instance (createExternalWorkflowInstance) must still be announced
  // to the dashboard once it starts running — so it shows up in the Running
  // list — without ever being adopted as the panel's viewed workflow, and
  // without disturbing whatever the panel was already viewing.
  test("announces an externally-created instance without adopting it as the panel's view", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    internal.platform = new MockPlatform(os.tmpdir());
    internal.currentWorkspaceFolderPath = os.tmpdir();
    internal.instances = new Map();
    internal.retiredInstances = new Map();
    internal.PANEL_CLIENT_ID = PANEL_CLIENT_ID;
    internal.viewerRegistry = new Map([[PANEL_CLIENT_ID, "panel-instance"]]);
    internal.viewAddressRegistry = new Map();
    internal.viewMessageSinks = new Map();
    internal.externallyCreatedInstanceIds = new Set<string>();
    internal.announcedExternalWorkflowIds = new Set<string>();

    const addedSummaries: unknown[] = [];
    internal.dashboardBroadcastHub = new Proxy(
      {},
      {
        get: (_target: unknown, prop: string) => {
          if (prop === "notifyWorkflowAdded") {
            return (summary: unknown) => addedSummaries.push(summary);
          }
          return () => undefined;
        },
      }
    );
    internal.resolveDetectorIntegration = () => ({});
    internal.propagateWorkflowNameToIntegrations = () => undefined;
    internal.updateStatusBar = () => undefined;

    const instance: any = internal.createExternalWorkflowInstance();
    assert.ok(
      internal.externallyCreatedInstanceIds.has(instance.id),
      "the instance must be marked as externally created"
    );
    assert.strictEqual(
      internal.instances.get(instance.id),
      instance,
      "the instance must already be registered before its prompt loads"
    );

    // Simulate the instance reaching RUNNING, as executeLoadedPromptFile()
    // would after the caller's prompt finishes loading.
    instance.promptQueue.state.workflowKey = "commit-message-generation";
    instance.workflowRuntime.startExecution();
    instance.promptQueue.emitStateChange();

    assert.strictEqual(
      addedSummaries.length,
      1,
      "a background instance must still be announced to the dashboard exactly once"
    );
    assert.strictEqual(
      internal.getViewedWorkflowId(PANEL_CLIENT_ID),
      "panel-instance",
      "the panel's viewed workflow must not change for a background instance"
    );

    // A second RUNNING/PAUSED transition must not re-announce it.
    instance.workflowRuntime.pause();
    instance.promptQueue.emitStateChange();
    assert.strictEqual(
      addedSummaries.length,
      1,
      "the one-shot announce guard must prevent a duplicate notifyWorkflowAdded"
    );
  });

  test("drops the previous lineage's address when a client switches to a blank workflow", () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;

    internal.viewerRegistry = new Map([["client-a", "old-instance"]]);
    internal.viewAddressRegistry = new Map([
      [
        "client-a",
        {
          workflowKey: "old-lineage" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
      ],
    ]);
    internal.instances = new Map([
      ["blank-instance", { getQueueState: () => ({}) }],
    ]);
    internal.retiredInstances = new Map();

    internal.setViewedWorkflowId("client-a", "blank-instance");

    assert.strictEqual(orchestrator.getViewAddress("client-a"), null);
  });

  test("has no identity to publish before a client's workflow has a lineage", async () => {
    const orchestrator = createTestOrchestrator();
    const internal = orchestrator as any;
    internal.currentWorkspaceFolderPath = os.tmpdir();
    internal.viewAddressRegistry = new Map([["client-a", null]]);

    assert.strictEqual(await orchestrator.getViewIdentity("client-a"), null);
  });
});
