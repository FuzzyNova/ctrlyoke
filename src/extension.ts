import { ensureMinFsThreadpoolSize } from "./utils/ThreadPoolBootstrap";
ensureMinFsThreadpoolSize(64);

import * as vscode from "vscode";
import * as path from "path";
import { WorkflowOrchestrator } from "./core/WorkflowOrchestrator";
import { PromptCompletionProvider } from "./completions/PromptCompletionProvider";
import { PromptPropertyCompletionProvider } from "./completions/PromptPropertyCompletionProvider";
import { PromptLinkProvider } from "./completions/PromptLinkProvider";
import {
  getCompletionCore,
  initializeCompletionHelpers,
} from "./completions/CompletionHelpers";
import { ContextMenuReferenceCommands } from "./completions/ContextMenuReferenceCommands";
import { CtrlYokeWebviewProvider } from "./ui/CtrlYokeWebviewProvider";
import { DashboardApplication } from "./ui/DashboardApplication";
import {
  getVsCodeWorkspaceRoot,
  getVsCodeWorkspaceFolder,
  getVsCodeNamedWorkspaceRoots,
  getVsCodeTrustedWorkspaceRoots,
} from "./platform/VsCodeWorkspaceRoot";
import { ServerTokenStore } from "./platform/ServerTokenStore";
import { VsCodeAdapter } from "./platform/VsCodeAdapter";
import { VsCodeDashboardHostActions } from "./platform/VsCodeDashboardHostActions";
import { VsCodeHostedServerControl } from "./platform/VsCodeHostedServerControl";
import { VsCodeKeyValueStore } from "./platform/VsCodeKeyValueStore";
import { TemplateManager } from "./core/TemplateManager";
import { VsCodeFileWatcherFactory } from "./platform/VsCodeFileWatcher";
import {
  initializeVsCodeLogging,
  showLogOutputChannel,
} from "./platform/VsCodeLogOutputChannel";
import { VsCodeSecretStore } from "./platform/VsCodeSecretStore";
import { OsCredentialStore } from "./platform/OsCredentialStore";
import { FallbackSecretStore } from "./platform/FallbackSecretStore";
import {
  CtrlYokeHostedServer,
  maskHostedServerUrlToken,
} from "./server/CtrlYokeHostedServer";
import {
  GIT_CHANGE_KINDS,
  HOST_KINDS,
  LICENSE_UI,
  MESSAGE_TYPES,
  RUNNER_IDS,
  USER_FEEDBACK_SEVERITY,
  VSCODE_COMMANDS,
  VSCODE_GIT_COMMANDS,
} from "./types/DashboardConstants";
import type { RunnerHostIdentity } from "./types/CtrlYokeTypes";
import {
  getCommitDiff,
  getDiffBetweenRefs,
  getDiffFilesBetweenRefs,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
  getStashFiles,
  listWorktrees,
  repoToplevel,
} from "./utils/GitUtils";
import { initializeModelRegistry } from "./utils/ModelRegistry";
import { TempFileManager } from "./utils/TempFileManager";
import { pathsEqual } from "./utils/PathCasing";
import { IS_DEV_MODE, BUILD_DATE } from "./utils/BuildConfig";
import { disposeTelemetry } from "./utils/TelemetryReporter";
import { initVsCodeTelemetry } from "./platform/VsCodeTelemetry";
import {
  reportExtensionActivationFailed,
  getErrorTypeName,
} from "./utils/TelemetryEvents";
import { Log } from "./utils/Log";
import { secretRedactionService } from "./utils/SecretRedactionService";
import { saveIfDirty } from "./platform/VsCodeDocuments";
import { getErrorMessage } from "./utils/ErrorUtils";
import { findWorkflowFilesInWorkspace } from "./utils/WorkflowFileDiscovery";
import { WorkspaceInitializer } from "./core/orchestration/WorkspaceInitializer";
import { ConfigurationUtils, PATH_CONSTANTS } from "./utils/ConfigurationUtils";
import {
  heapSnapshotThresholdFromEnv,
  MemoryWatchdog,
} from "./utils/MemoryWatchdog";
import {
  initPtyProcessManager,
  setPtyPostMessage,
  getPtyProcessManager,
} from "./core/harness/PtyProcessManager";
import { configService } from "./config/CtrlYokeConfigService";
import {
  createUserConfigBackend,
  createWorkspaceConfigBackend,
} from "./config/FileConfigBackend";
import { NotificationManager } from "./ui/NotificationManager";
import { promptBatchApprovalForPendingWorkspaceExternalRoots } from "./ui/ExternalRootsApproval";
import {
  confirmExternalFileTrustAndOpen,
  type FileOpenTarget,
} from "./ui/ExternalFileTrustPrompt";
import { ScmCommitCommand } from "./scm/ScmCommitCommand";
import { CompositeUserFeedbackSink } from "./core/CompositeUserFeedbackSink";
import { notifyUserFeedback } from "./core/UserFeedbackSink";
import { VsCodeUserFeedbackSink } from "./platform/VsCodeUserFeedbackSink";
import { HostedWebSocketUserFeedbackSink } from "./server/HostedWebSocketUserFeedbackSink";
import {
  ProjectStateRegistry,
  getStateHomeWarning,
} from "./utils/ProjectStateRegistry";
import { ctrlyokeStateHome } from "./utils/ProjectStatePaths";
import { initializeRunHistoryLocation } from "./utils/RunHistoryStoragePolicy";
import { scheduleTrashPurge } from "./core/orchestration/HistoryTrashRepository";
import { LicenseService, LICENSE_TIERS } from "./license/LicenseService";
import { registerNativeOutputCaptureCommand } from "./ui/NativeOutputCaptureCommand";
import { StatusBarManager } from "./ui/StatusBarManager";
import {
  exposeBundledCli,
  noteExtensionInstallation,
  registerInstallCliCommand,
} from "./ui/CtrlyokeCliCommands";

import {
  WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS,
  WorkspaceSettingsTrustPrompter,
} from "./ui/WorkspaceSettingsTrustPrompt";
import { workspaceSettingsTrustStore } from "./config/WorkspaceSettingsTrustStore";

interface ScmSourceControlCommandArgument {
  rootUri?: { fsPath: string };
}

let workflowOrchestrator: WorkflowOrchestrator;
let webviewProvider: CtrlYokeWebviewProvider;
let dashboardApplication: DashboardApplication;
let licenseService: LicenseService;
let hostedServer: CtrlYokeHostedServer | undefined;
let memoryWatchdog: MemoryWatchdog | undefined;
let notificationManager: NotificationManager | undefined;
let workspaceSettingsTrustPrompter: WorkspaceSettingsTrustPrompter | undefined;
// Exempts the running server's own connection token from heuristic secret
// redaction (see secretRedactionService.protectValue) for as long as the
// server is up; cleared on stop/regenerate/deactivate.
let unprotectServerToken: (() => void) | undefined;

// Publisher/name must match package.json; walkthrough id must match contributes.walkthroughs.
const GETTING_STARTED_WALKTHROUGH_ID =
  "fuzzynova.ctrlyoke#ctrlyoke.gettingStarted";
const GETTING_STARTED_SHOWN_KEY = "ctrlyoke.gettingStartedShown";

// Re-run periodically (not just once at activation) so a long-lived VS Code
// session doesn't accumulate orphaned temp/notification files past their 24h
// age threshold for days between restarts.
const TEMP_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Sweep orphaned `.ctrlyoke/temp/` files for the primary workspace root AND
 * every git worktree of that repo. Workflows executed against a managed or
 * named worktree (see WorktreeManager) write their own notification/prompt
 * temp files under `<worktree>/.ctrlyoke/temp/` — a directory tree that is
 * never opened as its own VS Code workspace, so it would otherwise never be
 * swept, and kept/named worktrees can persist indefinitely.
 */
async function sweepOrphanedTempFiles(primaryWorkspaceRoot: string) {
  const roots = new Set<string>([primaryWorkspaceRoot]);
  try {
    const gitToplevel = await repoToplevel(primaryWorkspaceRoot);
    if (gitToplevel) {
      const worktrees = await listWorktrees(gitToplevel);
      for (const worktree of worktrees) {
        if (
          ![...roots].some((root) => pathsEqual(root, worktree.worktreePath))
        ) {
          roots.add(worktree.worktreePath);
        }
      }
    }
  } catch (err) {
    Log.trace(
      `[Extension] ctrlyoke: Worktree discovery for temp cleanup failed: ${err}`
    );
  }

  let totalCleaned = 0;
  for (const root of roots) {
    try {
      const count = await new TempFileManager(root).cleanupOrphanedFiles();
      totalCleaned += count;
    } catch (err) {
      Log.warn(`[Extension] ctrlyoke: Temp cleanup failed for ${root}: ${err}`);
    }
  }
  if (totalCleaned > 0) {
    Log.info(
      `[Extension] ctrlyoke: Cleaned up ${totalCleaned} orphaned temp file(s) across ${roots.size} root(s)`
    );
  }
}

function openGettingStartedWalkthrough(): void {
  void vscode.commands.executeCommand(
    "workbench.action.openWalkthrough",
    GETTING_STARTED_WALKTHROUGH_ID
  );
}

export async function activate(context: vscode.ExtensionContext) {
  Log.info("[Extension] ctrlyoke: Extension activating...");
  if (IS_DEV_MODE) {
    Log.debug(`[Extension] Development mode enabled (Build: ${BUILD_DATE})`);
  }

  initVsCodeTelemetry();

  const runnerHostIdentity: RunnerHostIdentity = {
    runner: RUNNER_IDS.VSCODE,
    hostInstanceId: crypto.randomUUID(),
    pid: process.pid,
  };
  const platform = new VsCodeAdapter(context);

  try {
    // Initialize config service with file-based backends BEFORE
    // initializeVsCodeLogging() so isDiagnosticLogsEnabled() reads the correct
    // user/workspace value when deciding whether to open the log file.
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const userConfigBackend = createUserConfigBackend();
    configService.setUserBackend(userConfigBackend);
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceConfigBackend = createWorkspaceConfigBackend(
        getVsCodeWorkspaceRoot()
      );
      configService.setWorkspaceBackend(workspaceConfigBackend);
    }
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        if (vscode.workspace.workspaceFolders?.length) {
          void webviewProvider
            .awaitPanelReady()
            .then(() =>
              promptBatchApprovalForPendingWorkspaceExternalRoots(
                getVsCodeWorkspaceRoot(),
                webviewProvider.getUserInteractionPort(),
                undefined,
                () => vscode.workspace.isTrusted
              )
            )
            .catch((error) => {
              Log.warn(
                `[Extension] ctrlyoke: Workspace external-root approval failed: ${getErrorMessage(error)}`
              );
            });
        }
      })
    );

    // Initialize logging system early (creates output channel)
    initializeVsCodeLogging(
      context,
      workspaceFolders?.length ? getVsCodeWorkspaceRoot() : undefined
    );
    // Samples heap growth into the session log. The one-time heap snapshot is
    // opt-in (CTRLYOKE_HEAP_SNAPSHOT_MB) and only written while a session log
    // file exists (dev or verbose logging).
    memoryWatchdog = new MemoryWatchdog({
      snapshotThresholdBytes: heapSnapshotThresholdFromEnv(),
      getSnapshotDirectory: () => {
        const logFilePath = Log.getLogFilePath();
        return logFilePath ? path.dirname(logFilePath) : undefined;
      },
    });
    memoryWatchdog.start();

    // Bundled CLI on PATH for integrated terminals and, before any harness
    // can spawn, for the processes the orchestrator launches.
    exposeBundledCli(context);

    // License state is extension-host-owned so commands and the status bar
    // share one service instance and update immediately after activation.
    // Deliberately NOT VsCodeAdapter.getSecretStore(): a license is bound to
    // the machine, not to one --user-data-dir/profile, so it prefers the OS
    // credential store (shared by every VS Code profile, the dev host, the
    // CLI, and the future standalone server — see
    // dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md) and falls back to
    // VS Code's own per-profile secret storage only where the OS store is
    // unreachable (e.g. a remote/Codespaces extension host with no local
    // keyring). Other secret consumers (managed workflow secrets, server
    // tokens) keep VsCodeAdapter's profile-scoped store unchanged.
    licenseService = new LicenseService(
      new FallbackSecretStore(
        new OsCredentialStore(),
        new VsCodeSecretStore(context.secrets),
        (error) =>
          Log.warn(
            `[Extension] ctrlyoke: OS credential store unavailable for license storage, falling back to VS Code secret storage: ${error.message}`
          )
      ),
      { trialState: context.globalState }
    );
    context.subscriptions.push(licenseService);
    void licenseService.refresh();

    // Freeze storage placement before any history consumer is initialized.
    const runHistoryLocation = configService.get("storage").runHistoryLocation;
    initializeRunHistoryLocation(runHistoryLocation);
    const resolvedStateRoot = workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;
    const gitToplevel = resolvedStateRoot
      ? await repoToplevel(resolvedStateRoot)
      : null;
    const stateHomeWarning = getStateHomeWarning(
      ctrlyokeStateHome(),
      resolvedStateRoot ? [resolvedStateRoot] : [],
      gitToplevel ? [gitToplevel] : []
    );
    if (stateHomeWarning) {
      Log.warn(`[Extension] ctrlyoke: ${stateHomeWarning}`);
    }
    if (resolvedStateRoot) {
      await new ProjectStateRegistry().initialize(
        resolvedStateRoot,
        gitToplevel ?? undefined
      );
    }

    // Initialize model registry (queries available Copilot models)
    // Run this early so models are available for IntelliSense
    initializeModelRegistry().catch((err) => {
      Log.warn(
        "[Extension] ctrlyoke: Model registry initialization failed:",
        err
      );
    });

    // Initialize workspace and clean up orphaned temp files.
    // If ctrlyoke has not yet been initialized in this workspace, defer
    // initialization until the user approves via the "Initialize ctrlyoke"
    // prompt in the dashboard.
    let pendingInitWorkspaceRoot: string | undefined;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceRoot = getVsCodeWorkspaceRoot();

      if (WorkspaceInitializer.isInitialized(workspaceRoot)) {
        // Already initialized — idempotently ensure scaffold is up to date
        WorkspaceInitializer.initializeIfNeeded(workspaceRoot).catch((err) => {
          Log.warn(
            "[Extension] ctrlyoke: Workspace initialization failed:",
            err
          );
        });

        // Clean up orphaned temp prompt files (from previous sessions), across
        // the primary workspace root and any git worktrees of it, and keep
        // sweeping periodically for the rest of this VS Code session.
        void sweepOrphanedTempFiles(workspaceRoot);
        const tempCleanupTimer = setInterval(() => {
          void sweepOrphanedTempFiles(workspaceRoot);
        }, TEMP_CLEANUP_INTERVAL_MS);
        context.subscriptions.push({
          dispose: () => clearInterval(tempCleanupTimer),
        });

        // Recently deleted run history expires after storage.trashRetentionDays.
        context.subscriptions.push(
          scheduleTrashPurge(workspaceRoot, () =>
            ConfigurationUtils.getTrashRetentionDays()
          )
        );
      } else {
        // Not yet initialized — remember the root so we can set the pending
        // flag on the orchestrator once it is created below.
        pendingInitWorkspaceRoot = workspaceRoot;
      }
    }

    // Register React webview provider (Phase 4 - unified provider)
    const vscodeUserFeedbackSink = new VsCodeUserFeedbackSink();
    const dashboardHostActions = new VsCodeDashboardHostActions();
    const fileWatcherFactory = new VsCodeFileWatcherFactory();
    const templateManager = new TemplateManager(
      context.extensionPath,
      () => getVsCodeWorkspaceFolder()?.uri.fsPath,
      platform
    );
    const webviewHostDependencies = {
      actions: dashboardHostActions,
      serverControl: new VsCodeHostedServerControl(),
      getWorkspaceRoot: () =>
        vscode.workspace.workspaceFolders?.length
          ? getVsCodeWorkspaceRoot()
          : undefined,
      getTrustedRoots: getVsCodeTrustedWorkspaceRoots,
      fileWatcherFactory,
      completionCore: getCompletionCore(),
      getNamedRoots: () => {
        const roots = getVsCodeNamedWorkspaceRoots();
        if (roots.length === 0) return [];
        const workspaceRoot = getVsCodeWorkspaceRoot();
        const primary = roots.find((root) => root.fsPath === workspaceRoot);
        return [
          {
            name: primary?.name ?? path.basename(workspaceRoot),
            fsPath: workspaceRoot,
          },
          ...roots.filter((root) => root.fsPath !== workspaceRoot),
        ];
      },
    };
    dashboardApplication = new DashboardApplication({
      templateManager,
      postMessage: (message) => webviewProvider.postMessage(message),
      isPanelReady: () => webviewProvider.isPanelReady(),
      resolveImageWebviewUri: (absolutePath) =>
        webviewProvider.resolveImageWebviewUri(absolutePath),
      getServerUrl: () => webviewProvider.getRunningServerUrl(),
      getAvailableIps: () => webviewProvider.getRunningServerAvailableIps(),
      getPortFallback: () => webviewProvider.getRunningServerPortFallback(),
      getBindAddressFallback: () =>
        webviewProvider.getRunningServerBindAddressFallback(),
      keyValueStore: new VsCodeKeyValueStore(context.workspaceState),
      secretStore: platform.getSecretStore(),
      getWorkspaceRoot: webviewHostDependencies.getWorkspaceRoot,
      getSecretWorkspaceRoot: getVsCodeWorkspaceRoot,
      getNamedRoots: webviewHostDependencies.getNamedRoots,
      getTrustedRoots: getVsCodeTrustedWorkspaceRoots,
      actions: dashboardHostActions,
      serverControl: webviewHostDependencies.serverControl,
      nativeFeedbackSink: vscodeUserFeedbackSink,
      licenseService,
      hostDependencies: {
        fileWatcherFactory,
        completionCore: getCompletionCore(),
      },
      onPanelReady: (pageLoadId) =>
        webviewProvider.handlePanelReady(pageLoadId),
      handleClearWorkflow: () => webviewProvider.handleClearWorkflow(),
      updateWorkflowName: (name) => webviewProvider.updateWorkflowName(name),
      handleDevAction: (action, post) =>
        webviewProvider.handleDevAction(action, post),
      sendDevStatus: (post) => webviewProvider.sendDevStatus(post),
      handleUxSnapshot: (payload, root, post) =>
        webviewProvider.handleUxSnapshot(payload, root, post),
      getDevStatus: () => webviewProvider.getDevStatus(),
      notifyActiveWorkflowChanged: (workflowId) =>
        webviewProvider.notifyActiveWorkflowChanged(workflowId),
    });
    webviewProvider = new CtrlYokeWebviewProvider(
      context,
      dashboardApplication
    );
    dashboardApplication.start();
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "ctrlyoke.dashboard",
        webviewProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    Log.debug("[Extension] ctrlyoke: React webview provider registered");
    void noteExtensionInstallation(context, async () => {
      await webviewProvider.awaitPanelReady();
      return webviewProvider.getUserInteractionPort();
    });
    if (workspaceFolders && workspaceFolders.length > 0) {
      void webviewProvider
        .awaitPanelReady()
        .then(() =>
          promptBatchApprovalForPendingWorkspaceExternalRoots(
            getVsCodeWorkspaceRoot(),
            webviewProvider.getUserInteractionPort(),
            undefined,
            () => vscode.workspace.isTrusted
          )
        )
        .catch((error) => {
          Log.warn(
            `[Extension] ctrlyoke: Workspace external-root approval failed: ${getErrorMessage(error)}`
          );
        });
    }

    // Workspace settings that pick a program to run (shell, hooks, MCP
    // servers, harness flags, default scripts) are withheld until approved.
    // Ask once the dashboard can show the prompt, again when VS Code grants
    // workspace trust, and whenever a settings read meets a new value.
    const trustPrompter = new WorkspaceSettingsTrustPrompter(
      () =>
        vscode.workspace.workspaceFolders?.length
          ? getVsCodeWorkspaceRoot()
          : undefined,
      async () => {
        await webviewProvider.awaitPanelReady();
        return webviewProvider.getUserInteractionPort();
      },
      () => vscode.workspace.isTrusted
    );
    workspaceSettingsTrustPrompter = trustPrompter;
    const promptForWorkspaceSettingsTrust = (): void => {
      void trustPrompter.prompt().catch((error) => {
        Log.warn(
          `[Extension] ctrlyoke: Workspace settings approval failed: ${getErrorMessage(error)}`
        );
      });
    };
    promptForWorkspaceSettingsTrust();
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(
        promptForWorkspaceSettingsTrust
      ),
      {
        dispose: workspaceSettingsTrustStore.onUndecided(
          promptForWorkspaceSettingsTrust
        ),
      }
    );

    // Initialize PTY process manager (must be after webviewProvider is created).
    // The globalState-backed persistence seeds the cold-start fallback size so new
    // PTYs spawn near the real xterm width (instead of the 220-col default) even on
    // the first run after a restart — see PtyProcessManager.clientSpawnDimensions.
    const TERMINAL_SPAWN_DIMENSIONS_KEY = "ctrlyoke.terminalSpawnDimensions";
    const ptyManager = initPtyProcessManager(
      (msg) => webviewProvider.postMessagePublic(msg),
      {
        loadDimensions: () =>
          context.globalState.get<{ cols: number; rows: number }>(
            TERMINAL_SPAWN_DIMENSIONS_KEY
          ),
        saveDimensions: (dims) =>
          void context.globalState.update(TERMINAL_SPAWN_DIMENSIONS_KEY, dims),
      }
    );
    context.subscriptions.push(ptyManager);
    Log.debug("[Extension] ctrlyoke: PTY process manager initialized");

    // Initialize ctrlyoke orchestrator with React webview provider
    const browserUserFeedbackSink = new HostedWebSocketUserFeedbackSink(
      (message) => hostedServer?.broadcastUserFeedback(message)
    );
    const userFeedbackSink = new CompositeUserFeedbackSink([
      vscodeUserFeedbackSink,
      browserUserFeedbackSink,
    ]);
    // The orchestrator only ever calls the StatusBarSink surface, so disposal
    // stays with the composition root that constructed the implementation.
    const statusBarSink = new StatusBarManager(context, licenseService);
    context.subscriptions.push(statusBarSink);
    workflowOrchestrator = new WorkflowOrchestrator({
      platform,
      dashboardHostActions,
      workspaceFolderPathResolver: () => getVsCodeWorkspaceFolder()?.uri.fsPath,
      dashboardProvider: dashboardApplication,
      userFeedbackSink,
      runnerHostIdentity,
      fileWatcherFactory,
      statusBarSink,
      disposableRegistry: {
        add: (disposable) => context.subscriptions.push(disposable),
      },
      workspaceState: new VsCodeKeyValueStore(context.workspaceState),
      isWorkspaceTrusted: () => vscode.workspace.isTrusted,
      userInteractionPort: webviewProvider.getUserInteractionPort(),
    });

    // If ctrlyoke has not yet been initialized in this workspace, gate startup
    // behind an init prompt. Must be set before initialize() so the check is in
    // place when READY arrives.
    if (pendingInitWorkspaceRoot) {
      workflowOrchestrator.setWorkspaceInitPending(pendingInitWorkspaceRoot);
    }

    // Set orchestrator reference in webview provider (for getting current state)
    webviewProvider.setWorkflowOrchestrator(workflowOrchestrator);
    // Give the provider the hub so config-change broadcasts reach browser tabs too
    webviewProvider.setHub(workflowOrchestrator.getDashboardBroadcastHub());

    // Upgrade PTY postMessage to broadcast terminal messages to all connected clients
    // (panel + browser tabs). initPtyProcessManager only had the panel reference; now
    // that the hub exists we redirect through it so browser tabs receive TERMINAL_STARTED,
    // TERMINAL_OUTPUT, and TERMINAL_ENDED in real-time.
    //
    // This is also the single chokepoint for every PTY lifecycle message, so we use
    // it to keep the global active-terminal set in sync: whenever a session starts or
    // ends we re-broadcast which workflows have running terminals. That drives the
    // dropdown terminal icon for all workflows on every client, not just the one each
    // client happens to be viewing.
    setPtyPostMessage((msg) => {
      workflowOrchestrator.getDashboardBroadcastHub().postMessage(msg);
      const msgType = (msg as { type?: string } | null)?.type;
      if (
        msgType === MESSAGE_TYPES.TERMINAL_STARTED ||
        msgType === MESSAGE_TYPES.TERMINAL_ENDED
      ) {
        workflowOrchestrator.broadcastActiveTerminalWorkflows();
      }
    });

    // Register notification manager as a dashboard client so it observes
    // workflow state transitions and fires VS Code toasts as configured.
    notificationManager = new NotificationManager(() => workflowOrchestrator);
    workflowOrchestrator
      .getDashboardBroadcastHub()
      .addClient(notificationManager);

    // Share OutputHistoryManager with webview provider (single instance)
    webviewProvider.setOutputHistoryManager(
      workflowOrchestrator.getOutputHistoryManager()
    );

    // Fire-and-forget: don't block activate() on initialization.
    // This lets VS Code call resolveWebviewView() immediately so the
    // dashboard renders in <1s instead of waiting ~8s for CLI checks.
    // WorkflowOrchestrator.setDashboardReady() handles the race: if READY
    // arrives before init completes, auto-load is deferred until init finishes.
    workflowOrchestrator.initialize().catch((err) => {
      Log.error("[Extension] Manager initialization failed:", err);
      vscode.window.showErrorMessage(`ctrlyoke: Initialization failed: ${err}`);
    });

    // Re-capture theme vars when VS Code theme changes
    context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });
      })
    );

    // React to runtime workspace-folder changes. The resolved `.ctrlyoke`
    // root is window-stable: the orchestrator, history, settings, and session
    // stack are all built against it at activation. The *first* folder change
    // restarts the extension host (VS Code does not fire this event in that
    // case), so this handler only ever sees non-first changes. When the
    // resolved root is unchanged (the common case — a sibling folder was
    // added/removed) we no-op; when it changed (e.g. the resolver was falling
    // back to folder [0] and [0] was removed) we offer a window reload rather
    // than hot-swapping the singleton stack mid-session.
    let resolvedWorkspaceRoot = workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const nextRoot = vscode.workspace.workspaceFolders?.length
          ? getVsCodeWorkspaceRoot()
          : undefined;
        if (nextRoot === resolvedWorkspaceRoot) {
          return;
        }
        const previousRoot = resolvedWorkspaceRoot;
        resolvedWorkspaceRoot = nextRoot;
        Log.warn(
          `[Extension] ctrlyoke: Resolved workspace root changed from "${previousRoot}" to "${nextRoot}". A window reload is required to relocate .ctrlyoke.`
        );
        vscode.window
          .showWarningMessage(
            "ctrlyoke: The workspace root changed. Reload the window to relocate the .ctrlyoke directory.",
            "Reload Window"
          )
          .then((choice) => {
            if (choice === "Reload Window") {
              vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          });
      })
    );

    // Register completion provider for prompt files (JSON, YAML, and Markdown)
    // Two triggers: @ for full file references, # for snippets (line ranges, selections)
    const promptCompletionProvider = new PromptCompletionProvider(() =>
      webviewProvider.getSecretRegistryService()
    );
    const promptFilePatterns = [
      { pattern: "**/*.{prompt,ctrlyoke}.json" },
      { pattern: "**/*.ctrlyoke.{yaml,yml}" },
      { pattern: "**/*.prompt.md" },
      { language: "prompt" }, // VS Code's prompt language (used by Copilot)
    ];

    // Register @ trigger for full file references (CLI-native syntax)
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        promptFilePatterns,
        promptCompletionProvider,
        "@" // Trigger on @ character for full file references
      )
    );

    // Register ! trigger for secret-name references. The registry supplies
    // names only; managed values never enter the completion payload.
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        promptFilePatterns,
        promptCompletionProvider,
        "!"
      )
    );

    // Register # trigger for snippet references (line ranges, selections)
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        promptFilePatterns,
        promptCompletionProvider,
        "#" // Trigger on # character for snippets
      )
    );

    // Register ~ trigger for git change context (diff, staged, stash, commits)
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        promptFilePatterns,
        promptCompletionProvider,
        "~" // Trigger on ~ character for git change references
      )
    );

    // Register $ trigger for inline prior-context references
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        promptFilePatterns,
        promptCompletionProvider,
        "$" // Trigger on $ character for prior-context references
      )
    );
    Log.debug(
      "[Extension] ctrlyoke: Registered completion provider for prompt files (.json, .yaml, .md, and prompt language) with @, #, ~, $, and ! triggers"
    );

    // Register property key completion provider for YAML workflow files.
    // No trigger character — activates on demand to offer prompt item property keys,
    // with context-aware branching based on type: script vs. AI prompt steps.
    const promptPropertyCompletionProvider =
      new PromptPropertyCompletionProvider();
    const yamlWorkflowPatterns = [
      { pattern: "**/*.ctrlyoke.yaml" },
      { pattern: "**/*.ctrlyoke.yml" },
    ];
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        yamlWorkflowPatterns,
        promptPropertyCompletionProvider
        // No trigger character — VS Code invokes on Ctrl+Space or natural typing
      )
    );
    Log.debug(
      "[Extension] ctrlyoke: Registered property key completion provider for YAML workflow files"
    );

    // Register link provider for prompt files (enables Ctrl+Click navigation)
    const promptLinkProvider = new PromptLinkProvider();
    context.subscriptions.push(
      vscode.languages.registerDocumentLinkProvider(
        promptFilePatterns,
        promptLinkProvider
      )
    );
    Log.debug(
      "[Extension] ctrlyoke: Registered link provider for prompt files"
    );

    // Initialize completion helpers with config watcher
    initializeCompletionHelpers(context);
    Log.debug(
      "[Extension] ctrlyoke: Initialized completion helpers with config watcher"
    );

    // Register commands
    registerCommands(context, runnerHostIdentity, platform);

    // Show the Getting Started walkthrough once, on first activation after install.
    if (!context.globalState.get<boolean>(GETTING_STARTED_SHOWN_KEY)) {
      openGettingStartedWalkthrough();
      void context.globalState.update(GETTING_STARTED_SHOWN_KEY, true);
    }

    Log.info("[Extension] ctrlyoke: Extension activated successfully!");
  } catch (error) {
    Log.error("[Extension] ctrlyoke: Failed to activate extension:", error);
    vscode.window.showErrorMessage(`ctrlyoke: Activation failed: ${error}`);
    reportExtensionActivationFailed(getErrorTypeName(error));
  }
}

function registerCommands(
  context: vscode.ExtensionContext,
  runnerHostIdentity: RunnerHostIdentity,
  platform: VsCodeAdapter
) {
  const reportCommandError = (message: string): void => {
    notifyUserFeedback(
      workflowOrchestrator.getUserFeedbackSink(),
      USER_FEEDBACK_SEVERITY.ERROR,
      message
    );
  };
  const getWorkspaceRoot = () =>
    vscode.workspace.workspaceFolders?.length ? getVsCodeWorkspaceRoot() : "";
  const contextMenuReferenceCommands = new ContextMenuReferenceCommands(
    webviewProvider,
    getWorkspaceRoot,
    undefined,
    async () => {
      await vscode.commands.executeCommand("ctrlyoke.openPanel");
      await webviewProvider.awaitPanelReady();
      return webviewProvider.getUserInteractionPort();
    }
  );

  const resolveOutputCaptureCommand = registerNativeOutputCaptureCommand(
    getWorkspaceRoot,
    (message) =>
      notifyUserFeedback(
        workflowOrchestrator.getUserFeedbackSink(),
        USER_FEEDBACK_SEVERITY.ERROR,
        message
      )
  );

  context.subscriptions.push(
    workflowOrchestrator.registerActiveQueueContextKey()
  );

  // Open Panel command
  const openPanelCommand = vscode.commands.registerCommand(
    "ctrlyoke.openPanel",
    async () => {
      await workflowOrchestrator.openPanel();
    }
  );

  // Status bar click while a run that failed this session is still unseen
  const openUnseenFailedRunCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.OPEN_UNSEEN_FAILED_RUN,
    async () => {
      await workflowOrchestrator.openUnseenFailedRun();
    }
  );

  // Status bar click while the default harness is unavailable
  const retryHarnessDetectionCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.RETRY_HARNESS_DETECTION,
    async () => {
      await workflowOrchestrator.retryHarnessDetection();
    }
  );

  const openSecretsSettingsCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.OPEN_SECRETS_SETTINGS,
    async () => {
      await workflowOrchestrator.openPanel();
      webviewProvider.openGlobalSettingsTab("secrets");
    }
  );

  const reviewWorkspaceSettingsTrustCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.REVIEW_WORKSPACE_SETTINGS_TRUST,
    async () => {
      const reportInfo = (message: string): void =>
        notifyUserFeedback(
          workflowOrchestrator.getUserFeedbackSink(),
          USER_FEEDBACK_SEVERITY.INFO,
          message
        );
      if (!vscode.workspace.workspaceFolders?.length) {
        reportInfo("Open a workspace folder to review its settings.");
        return;
      }
      if (!vscode.workspace.isTrusted) {
        reportInfo(
          "Trust this workspace in VS Code first; its ctrlyoke settings are not read until then."
        );
        return;
      }
      await workflowOrchestrator.openPanel();
      const result = await workspaceSettingsTrustPrompter?.prompt({
        includeDecided: true,
      });
      if (
        result === WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.NOTHING_TO_REVIEW
      ) {
        reportInfo(
          "This workspace's settings don't choose any programs to run."
        );
      }
    }
  );

  // Show Getting Started walkthrough command (manual reopen affordance)
  const showGettingStartedCommand = vscode.commands.registerCommand(
    "ctrlyoke.showGettingStarted",
    () => {
      openGettingStartedWalkthrough();
    }
  );

  const openLicensePanel = async () => {
    await workflowOrchestrator.openPanel();
    await webviewProvider.awaitPanelReady();
    webviewProvider.openGlobalSettingsTab("license");
  };

  const activateProCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.ACTIVATE_PRO,
    openLicensePanel
  );

  const activateOfflineProCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.ACTIVATE_OFFLINE_PRO,
    async () => {
      // Intentionally no isPro() precheck: this command is how a Pro/
      // Enterprise customer's offline license file gets imported in the
      // first place, so gating it on isPro() would make it impossible to
      // ever use for a first-time air-gapped activation. importLicenseFile()
      // itself is the source of truth for whether the imported file grants
      // Pro (see PRO_LICENSE_PLAN.md §1.5, §1.8).
      try {
        const files = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: "Import Pro License File",
          filters: {
            "ctrlyoke License": ["license", "txt", "json", "lic"],
            "All Files": ["*"],
          },
        });
        if (!files?.[0]) {
          return;
        }
        const blob = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(files[0])
        );
        if (!blob) {
          return;
        }

        const entitlement = await licenseService.importLicenseFile(blob);
        if (entitlement.tier !== LICENSE_TIERS.PRO) {
          notifyUserFeedback(
            workflowOrchestrator.getUserFeedbackSink(),
            USER_FEEDBACK_SEVERITY.ERROR,
            "ctrlyoke: The offline license file could not be imported."
          );
          return;
        }
        notifyUserFeedback(
          workflowOrchestrator.getUserFeedbackSink(),
          USER_FEEDBACK_SEVERITY.SUCCESS,
          "ctrlyoke: Offline Pro license activated successfully."
        );
      } catch (error) {
        notifyUserFeedback(
          workflowOrchestrator.getUserFeedbackSink(),
          USER_FEEDBACK_SEVERITY.ERROR,
          `ctrlyoke: Offline license activation failed — ${getErrorMessage(error)}`
        );
      }
    }
  );

  const deactivateProCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.DEACTIVATE_PRO,
    openLicensePanel
  );

  const manageLicenseCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.MANAGE_LICENSE,
    openLicensePanel
  );

  // Pause execution command
  const pauseCommand = vscode.commands.registerCommand(
    "ctrlyoke.pause",
    async () => {
      await workflowOrchestrator.pause();
    }
  );

  // Resume execution command
  const resumeCommand = vscode.commands.registerCommand(
    "ctrlyoke.resume",
    async () => {
      await workflowOrchestrator.resume();
    }
  );

  // Stop execution command
  const stopCommand = vscode.commands.registerCommand(
    "ctrlyoke.stop",
    async () => {
      await workflowOrchestrator.stop();
    }
  );

  // New Workflow command (opens modal in dashboard)
  const newWorkflowCommand = vscode.commands.registerCommand(
    "ctrlyoke.newWorkflow",
    async () => {
      // Focus the dashboard panel first
      await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
      // Then open the modal
      await webviewProvider.openNewWorkflowModal();
    }
  );

  // Create New Template command (opens the dashboard's inline form)
  const createNewTemplateCommand = vscode.commands.registerCommand(
    "ctrlyoke.createNewTemplate",
    async () => {
      await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
      await webviewProvider.openNewWorkflowModal({
        openCreateTemplateForm: true,
      });
    }
  );

  // Queue with ctrlyoke command (context menu) - appends prompts to end of queue
  const queueFromContextCommand = vscode.commands.registerCommand(
    "ctrlyoke.queueFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage("No file selected");
        return;
      }
      await saveIfDirty(uri.fsPath, workflowOrchestrator.getUserFeedbackSink());
      await workflowOrchestrator.appendFromFile(uri.fsPath, "end");
    }
  );

  // Queue Next With ctrlyoke command (context menu) - appends prompts after current position
  const queueNextFromContextCommand = vscode.commands.registerCommand(
    "ctrlyoke.queueNextFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage("No file selected");
        return;
      }
      await saveIfDirty(uri.fsPath, workflowOrchestrator.getUserFeedbackSink());
      await workflowOrchestrator.appendFromFile(uri.fsPath, "next");
    }
  );

  // Run with ctrlyoke command (context menu) - runs using current harness
  const runFromContextCommand = vscode.commands.registerCommand(
    "ctrlyoke.runFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await saveIfDirty(
          uri.fsPath,
          workflowOrchestrator.getUserFeedbackSink()
        );
        await workflowOrchestrator.executePromptFile(uri.fsPath);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to execute ctrlyoke workflow: ${error}`
        );
      }
    }
  );

  // Load in ctrlyoke command (context menu) - loads without executing
  const loadFromContextCommand = vscode.commands.registerCommand(
    "ctrlyoke.loadFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await saveIfDirty(
          uri.fsPath,
          workflowOrchestrator.getUserFeedbackSink()
        );
        await workflowOrchestrator.loadPromptFile(uri.fsPath);
        // Open the ctrlyoke panel to show the loaded file
        await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to load ctrlyoke prompt file: ${error}`
        );
      }
    }
  );

  const pickWorkflowFile = async (
    placeHolder: string
  ): Promise<string | undefined> => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace folder open");
      return undefined;
    }

    const promptFiles = findWorkflowFilesInWorkspace(getVsCodeWorkspaceRoot());

    if (promptFiles.length === 0) {
      vscode.window.showWarningMessage("No prompt files found in workspace");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      promptFiles.map((file) => ({
        label: file.relativePath,
        filePath: file.path,
      })),
      { placeHolder }
    );

    return selected?.filePath;
  };

  // Select Prompt File command (for dashboard)
  const selectPromptFileCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.SELECT_PROMPT_FILE,
    async () => {
      const selectedPath = await pickWorkflowFile(
        "Select a prompt file to load"
      );

      if (selectedPath) {
        await workflowOrchestrator.loadPromptFile(selectedPath);
      }
    }
  );

  // Append Prompt File command (for dashboard Append button)
  const appendFromDashboardCommand = vscode.commands.registerCommand(
    "ctrlyoke.appendFromDashboard",
    async () => {
      const selectedPath = await pickWorkflowFile(
        "Select a prompt file to append to queue"
      );

      if (selectedPath) {
        // Append to end of queue (dashboard button always uses "end" position)
        await workflowOrchestrator.appendFromFile(selectedPath, "end");
      }
    }
  );

  // Resume Session command - shows list of previous sessions from run storage
  const resumeSessionCommand = vscode.commands.registerCommand(
    "ctrlyoke.resumeSession",
    async () => {
      try {
        const sessions = await workflowOrchestrator.listResumableSessions();
        if (sessions.length === 0) {
          return;
        }

        const selected = await vscode.window.showQuickPick(sessions, {
          placeHolder: "Select a session to resume",
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (selected) {
          await workflowOrchestrator.resumeSessionFromWorkingFile(
            selected.filePath
          );
        }
      } catch (error) {
        Log.error(
          "[Extension] ctrlyoke: Failed to resume session:",
          error as Error
        );
        notifyUserFeedback(
          workflowOrchestrator.getUserFeedbackSink(),
          USER_FEEDBACK_SEVERITY.ERROR,
          `Failed to resume session: ${getErrorMessage(error)}`
        );
      }
    }
  );

  // Edit Current Prompt File command (for dashboard)
  const editCurrentPromptFileCommand = vscode.commands.registerCommand(
    "ctrlyoke.editCurrentPromptFile",
    async () => {
      await workflowOrchestrator.openCurrentPromptFile();
    }
  );

  // Run command (for dashboard) - executes currently loaded file
  const runCommand = vscode.commands.registerCommand(
    "ctrlyoke.run",
    async () => {
      // Execute the currently loaded prompt file
      await workflowOrchestrator.executeLoadedPromptFile();
    }
  );

  // Show Output Panel command
  const showOutputPanelCommand = vscode.commands.registerCommand(
    "ctrlyoke.showOutputPanel",
    () => {
      showLogOutputChannel();
    }
  );

  // Clear Workflow command (keyboard shortcut: Ctrl+Shift+N when ctrlyoke panel focused)
  const clearWorkflowCommand = vscode.commands.registerCommand(
    "ctrlyoke.clearWorkflow",
    () => {
      webviewProvider.handleClearWorkflow();
    }
  );

  // Open File with Selection command (for clickable links in prompt files)
  const openFileWithSelectionCommand = vscode.commands.registerCommand(
    "ctrlyoke.openFileWithSelection",
    async (args: { uri: string; startLine: number; endLine: number }) => {
      try {
        const fileUri = vscode.Uri.parse(args.uri);
        const document = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(document);

        // Select the line range (convert to 0-based)
        const selection = new vscode.Range(
          args.startLine - 1,
          0,
          args.endLine - 1,
          Number.MAX_SAFE_INTEGER
        );

        editor.selection = new vscode.Selection(selection.start, selection.end);
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to open file: ${getErrorMessage(error)}`
        );
      }
    }
  );

  // Confirm External File Trust command — shared "Trust Parent Folder" /
  // Cancel flow for file links (editor Ctrl+click and dashboard output
  // links) that resolve outside the workspace and outside every currently
  // trusted external root. See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
  const confirmExternalFileTrustCommand = vscode.commands.registerCommand(
    "ctrlyoke.confirmExternalFileTrust",
    async (target: FileOpenTarget) => {
      await vscode.commands.executeCommand("ctrlyoke.openPanel");
      await webviewProvider.awaitPanelReady();
      await confirmExternalFileTrustAndOpen(target, {
        port: webviewProvider.getUserInteractionPort(),
        workspaceRoot: getWorkspaceRoot(),
        workflowSourcePath: target.workflowSourcePath,
      });
    }
  );

  // Open Git Change command — opens a git change (diff/staged/stash:N/<hash>) in
  // VS Code's native diff UI: the multi-file commit viewer for a hash, the changes
  // views for working-tree/staged, and the generic multi-file diff editor for a
  // stash (built from per-file git URIs). Any failure (e.g. Git extension disabled)
  // falls back to a generated diff document.
  const openGitChangeCommand = vscode.commands.registerCommand(
    "ctrlyoke.openGitChange",
    async (args: { ref: string; workspaceRoot?: string }) => {
      const workspaceRoot =
        args.workspaceRoot ??
        (vscode.workspace.workspaceFolders?.length
          ? getVsCodeWorkspaceRoot()
          : undefined);
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("ctrlyoke: No workspace folder open.");
        return;
      }

      const repoUri = vscode.Uri.file(workspaceRoot);
      const ref = args.ref.toLowerCase();
      const stashIndex = ref.startsWith(`${GIT_CHANGE_KINDS.STASH}:`)
        ? parseInt(ref.slice(GIT_CHANGE_KINDS.STASH.length + 1), 10)
        : null;

      // Fallback: render the unified diff text in an untitled `diff` document.
      const openGeneratedDiff = async (): Promise<void> => {
        let content: string;
        if (ref === GIT_CHANGE_KINDS.DIFF) {
          content =
            (await getWorkingTreeDiff(workspaceRoot)).trim() ||
            "No uncommitted changes in working tree.";
        } else if (ref === GIT_CHANGE_KINDS.STAGED) {
          content =
            (await getStagedDiff(workspaceRoot)).trim() || "No staged changes.";
        } else if (stashIndex !== null) {
          content = await getStashDiff(workspaceRoot, stashIndex);
        } else {
          content = await getCommitDiff(workspaceRoot, args.ref);
        }
        const doc = await vscode.workspace.openTextDocument({
          content,
          language: "diff",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      };

      // Stash: no built-in command opens a specific stash by index, so build the
      // native multi-file diff editor ourselves via `vscode.changes` + the git
      // extension's `toGitUri` (stash@{N}^ vs stash@{N} per changed file).
      const openNativeStashDiff = async (index: number): Promise<void> => {
        const gitApi = vscode.extensions
          .getExtension<{
            getAPI(version: 1): {
              toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
            };
          }>("vscode.git")
          ?.exports.getAPI(1);
        const files = gitApi ? await getStashFiles(workspaceRoot, index) : [];
        if (!gitApi || files.length === 0) {
          // No git API, or nothing tracked in the stash — the generated diff
          // still surfaces untracked-only stashes as text.
          await openGeneratedDiff();
          return;
        }
        const stashRef = `stash@{${index}}`;
        const resources = files.map((rel) => {
          const fileUri = vscode.Uri.joinPath(repoUri, rel);
          return [
            fileUri,
            gitApi.toGitUri(fileUri, `${stashRef}^`),
            gitApi.toGitUri(fileUri, stashRef),
          ];
        });
        await vscode.commands.executeCommand(
          VSCODE_GIT_COMMANDS.CHANGES,
          `Git Stash #${index}`,
          resources
        );
      };

      try {
        if (ref === GIT_CHANGE_KINDS.DIFF) {
          await vscode.commands.executeCommand(
            VSCODE_GIT_COMMANDS.VIEW_CHANGES,
            repoUri
          );
        } else if (ref === GIT_CHANGE_KINDS.STAGED) {
          await vscode.commands.executeCommand(
            VSCODE_GIT_COMMANDS.VIEW_STAGED_CHANGES,
            repoUri
          );
        } else if (stashIndex !== null) {
          await openNativeStashDiff(stashIndex);
        } else {
          // Commit hash → native multi-file commit viewer. `git.viewCommit`
          // resolves its first arg to a repository, then opens the commit.
          await vscode.commands.executeCommand(
            VSCODE_GIT_COMMANDS.VIEW_COMMIT,
            repoUri,
            args.ref
          );
        }
      } catch (error) {
        // Native command unavailable (older VS Code / Git extension disabled) —
        // fall back to the generated diff document.
        try {
          await openGeneratedDiff();
        } catch (fallbackError) {
          vscode.window.showErrorMessage(
            `ctrlyoke: Failed to open git change: ${getErrorMessage(fallbackError)}`
          );
        }
      }
    }
  );

  const openWorktreeCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.OPEN_WORKTREE,
    async (args: { worktreePath?: string }) => {
      const worktreePath = args?.worktreePath;
      if (!worktreePath || !path.isAbsolute(worktreePath)) {
        reportCommandError(
          "ctrlyoke: The recorded worktree path is unavailable."
        );
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(worktreePath),
        true
      );
    }
  );

  const viewWorktreeDiffCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.VIEW_WORKTREE_DIFF,
    async (args: {
      sourceCheckoutRoot?: string;
      baseCommit?: string;
      branchName?: string;
    }) => {
      const sourceCheckoutRoot = args?.sourceCheckoutRoot;
      const baseCommit = args?.baseCommit;
      const branchName = args?.branchName;
      if (
        !sourceCheckoutRoot ||
        !path.isAbsolute(sourceCheckoutRoot) ||
        !baseCommit ||
        !branchName
      ) {
        reportCommandError(
          "ctrlyoke: The recorded worktree diff information is unavailable."
        );
        return;
      }

      const repoUri = vscode.Uri.file(sourceCheckoutRoot);
      const targetRef = `refs/heads/${branchName}`;
      const openGeneratedDiff = async (): Promise<void> => {
        const content =
          (
            await getDiffBetweenRefs(sourceCheckoutRoot, baseCommit, targetRef)
          ).trim() || "No changes between the recorded base and branch.";
        const document = await vscode.workspace.openTextDocument({
          content,
          language: "diff",
        });
        await vscode.window.showTextDocument(document, { preview: true });
      };

      try {
        const files = await getDiffFilesBetweenRefs(
          sourceCheckoutRoot,
          baseCommit,
          targetRef
        );
        const gitApi = vscode.extensions
          .getExtension<{
            getAPI(version: 1): {
              toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
            };
          }>("vscode.git")
          ?.exports.getAPI(1);
        if (!gitApi || files.length === 0) {
          await openGeneratedDiff();
          return;
        }

        const resources = files.map((relativePath) => {
          const fileUri = vscode.Uri.joinPath(repoUri, relativePath);
          return [
            fileUri,
            gitApi.toGitUri(fileUri, baseCommit),
            gitApi.toGitUri(fileUri, targetRef),
          ];
        });
        await vscode.commands.executeCommand(
          VSCODE_GIT_COMMANDS.CHANGES,
          `Managed branch diff: ${branchName}`,
          resources
        );
      } catch (error) {
        try {
          await openGeneratedDiff();
        } catch (fallbackError) {
          reportCommandError(
            `ctrlyoke: Failed to open worktree diff: ${getErrorMessage(
              fallbackError
            )}`
          );
        }
      }
    }
  );

  const mergeWorktreeCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.MERGE_WORKTREE,
    async (args: { address?: { workflowKey?: string; runRef?: string } }) => {
      const address = args?.address;
      if (!address?.workflowKey || !address.runRef) {
        reportCommandError(
          "ctrlyoke: The managed worktree merge target is unavailable."
        );
        return;
      }
      try {
        await workflowOrchestrator.mergeManagedWorktreeAtRun(
          address as Parameters<
            typeof workflowOrchestrator.mergeManagedWorktreeAtRun
          >[0]
        );
      } catch (error) {
        reportCommandError(
          `ctrlyoke: Managed worktree merge failed: ${getErrorMessage(error)}`
        );
      }
    }
  );

  const addFileToPromptEditorCommand = vscode.commands.registerCommand(
    "ctrlyoke.addFileToPromptEditor",
    async (uri: vscode.Uri) => {
      if (uri) {
        await saveIfDirty(
          uri.fsPath,
          workflowOrchestrator.getUserFeedbackSink()
        );
      }
      await contextMenuReferenceCommands.addFileToPromptEditor(uri);
    }
  );

  const addDirectoryToPromptEditorCommand = vscode.commands.registerCommand(
    "ctrlyoke.addDirectoryToPromptEditor",
    async (uri: vscode.Uri) => {
      await contextMenuReferenceCommands.addDirectoryToPromptEditor(uri);
    }
  );

  const addSelectionToPromptEditorCommand = vscode.commands.registerCommand(
    "ctrlyoke.addSelectionToPromptEditor",
    async (uri: vscode.Uri) => {
      if (uri) {
        await saveIfDirty(
          uri.fsPath,
          workflowOrchestrator.getUserFeedbackSink()
        );
      }
      await contextMenuReferenceCommands.addSelectionToPromptEditor(uri);
    }
  );

  const addSymbolToPromptEditorCommand = vscode.commands.registerCommand(
    "ctrlyoke.addSymbolToPromptEditor",
    async (uri: vscode.Uri, lineNumber?: number) => {
      if (uri) {
        await saveIfDirty(
          uri.fsPath,
          workflowOrchestrator.getUserFeedbackSink()
        );
      }
      await contextMenuReferenceCommands.addSymbolToPromptEditor(
        uri,
        lineNumber
      );
    }
  );

  const addOutputSelectionToPromptEditorCommand =
    vscode.commands.registerCommand(
      "ctrlyoke.addOutputSelectionToPromptEditor",
      async (uri?: vscode.Uri) => {
        await contextMenuReferenceCommands.addOutputSelectionToPromptEditor(
          uri
        );
      }
    );

  const addOutputChannelToPromptEditorCommand = vscode.commands.registerCommand(
    "ctrlyoke.addOutputChannelToPromptEditor",
    async (uri?: vscode.Uri) => {
      await contextMenuReferenceCommands.addOutputChannelToPromptEditor(uri);
    }
  );

  const addScmResourcesToPromptEditorCommand = vscode.commands.registerCommand(
    "ctrlyoke.addScmResourcesToPromptEditor",
    async (...args: unknown[]) => {
      await contextMenuReferenceCommands.addScmResourcesToPromptEditor(...args);
    }
  );

  const addTimelineCommitToPromptEditorCommand =
    vscode.commands.registerCommand(
      "ctrlyoke.addTimelineCommitToPromptEditor",
      async (item: unknown) => {
        await contextMenuReferenceCommands.addTimelineCommitToPromptEditor(
          item
        );
      }
    );

  const searchHistoryCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.SEARCH_HISTORY,
    async () => {
      await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
      webviewProvider.postMessage({
        type: MESSAGE_TYPES.OPEN_HISTORY_SEARCH,
      });
    }
  );

  // Generate Commit Message command (SCM panel button)
  const scmCommitCommand = new ScmCommitCommand(
    {
      createWorkflowInstance: () =>
        workflowOrchestrator.createExternalWorkflowInstance(),
    },
    runnerHostIdentity
  );
  const generateCommitMessageCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.GENERATE_COMMIT_MESSAGE,
    (sourceControl?: ScmSourceControlCommandArgument) =>
      scmCommitCommand.execute(context, sourceControl?.rootUri?.fsPath)
  );
  const cancelCommitMessageGenerationCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.CANCEL_COMMIT_MESSAGE_GENERATION,
    () => scmCommitCommand.cancel()
  );

  // Initialize Workspace command (manual reinit for existing users)
  const initWorkspaceCommand = vscode.commands.registerCommand(
    "ctrlyoke.initWorkspace",
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage(
          "ctrlyoke: No workspace folder open. Open a folder first."
        );
        return;
      }
      try {
        await WorkspaceInitializer.reinitialize(getVsCodeWorkspaceRoot());
        vscode.window.showInformationMessage(
          `ctrlyoke: Workspace initialized — ${PATH_CONSTANTS.CTRLYOKE_DIR}/ and its .gitignore are up to date.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `ctrlyoke: Workspace initialization failed: ${err}`
        );
      }
    }
  );

  // Server commands
  const enableServerCommand = vscode.commands.registerCommand(
    "ctrlyoke.enableServer",
    async () => {
      if (hostedServer) return;
      const hub = workflowOrchestrator.getDashboardBroadcastHub();
      const port = configService.getAll().server.port;
      const workspaceRoot = getVsCodeWorkspaceRoot();
      const namedWorkspaceRoots = getVsCodeNamedWorkspaceRoots();
      const token = await new ServerTokenStore(
        platform.getSecretStore()
      ).getOrCreate();
      unprotectServerToken?.();
      unprotectServerToken = secretRedactionService.protectValue(token);
      const bindAddress =
        configService.get("server")?.bindAddress ?? "127.0.0.1";
      const fallbackPorts = configService.get("server")?.fallbackPorts ?? [];
      const tlsCfg = configService.get("server")?.tls;
      const tlsConfig =
        tlsCfg?.enabled && tlsCfg.certPath && tlsCfg.keyPath
          ? { certPath: tlsCfg.certPath, keyPath: tlsCfg.keyPath }
          : undefined;
      const showRemoteAccessUpsell = () => {
        const message = `ctrlyoke: ${LICENSE_UI.REMOTE_ACCESS_UPSELL}`;
        notifyUserFeedback(
          workflowOrchestrator.getUserFeedbackSink(),
          USER_FEEDBACK_SEVERITY.WARNING,
          message,
          LICENSE_UI.PRICING_URL
        );
      };
      try {
        hostedServer = new CtrlYokeHostedServer({
          hub,
          endpoint: dashboardApplication,
          getOrchestrator: () => workflowOrchestrator,
          port,
          workspaceRoot,
          namedWorkspaceRoots,
          token,
          bindAddress,
          tls: tlsConfig,
          onSiblingServerDetected: (existingServerUrl) =>
            notifyUserFeedback(
              workflowOrchestrator.getUserFeedbackSink(),
              USER_FEEDBACK_SEVERITY.WARNING,
              `ctrlyoke: A sibling ctrlyoke server is already running for this workspace at ${existingServerUrl}. This window is starting its own server on a different port.`
            ),
          remoteAccess: {
            isAllowed: () => licenseService.hasRemoteAccess(),
            onBlocked: showRemoteAccessUpsell,
          },
          runnerHostIdentity,
          fallbackPorts,
          hostKind: HOST_KINDS.VSCODE,
        });
      } catch (err) {
        unprotectServerToken?.();
        unprotectServerToken = undefined;
        vscode.window.showErrorMessage(
          `ctrlyoke: Failed to start server — ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      let url: string;
      try {
        const serverUrl = await hostedServer.listen();
        if (!serverUrl) {
          hostedServer.dispose();
          hostedServer = undefined;
          unprotectServerToken?.();
          unprotectServerToken = undefined;
          return;
        }
        url = serverUrl;
      } catch (err) {
        hostedServer = undefined;
        unprotectServerToken?.();
        unprotectServerToken = undefined;
        vscode.window.showErrorMessage(
          `ctrlyoke: Failed to bind server — ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      const availableIps = hostedServer.getAvailableIps();
      const portFallback = hostedServer.getPortFallbackInfo() ?? undefined;
      const bindAddressFallback =
        hostedServer.getBindAddressFallbackInfo() ?? undefined;
      webviewProvider.setRunningServerUrl(
        url,
        availableIps,
        portFallback,
        bindAddressFallback
      );
      webviewProvider.postMessage({
        type: MESSAGE_TYPES.SERVER_STARTED,
        url,
        availableIps,
        ...(portFallback ? { portFallback } : {}),
        ...(bindAddressFallback ? { bindAddressFallback } : {}),
      });
      webviewProvider.setThemeVarsCapturedCallback((vars) =>
        hostedServer?.updateThemeVars(vars)
      );
      webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });
      Log.info(
        `[Extension] ctrlyoke: Hosted server started at ${maskHostedServerUrlToken(url)}`
      );
      if (portFallback) {
        Log.warn(
          `[Extension] ctrlyoke: Port ${portFallback.requestedPort} was already in use — server started on port ${portFallback.actualPort} instead.`
        );
        notifyUserFeedback(
          workflowOrchestrator.getUserFeedbackSink(),
          USER_FEEDBACK_SEVERITY.WARNING,
          `ctrlyoke: Port ${portFallback.requestedPort} was already in use by another process. The server started on port ${portFallback.actualPort} instead — restart the server to try binding to ${portFallback.requestedPort} again.`
        );
      }
    }
  );

  const disableServerCommand = vscode.commands.registerCommand(
    "ctrlyoke.disableServer",
    () => {
      hostedServer?.dispose();
      hostedServer = undefined;
      unprotectServerToken?.();
      unprotectServerToken = undefined;
      webviewProvider.setRunningServerUrl(undefined);
      webviewProvider.setThemeVarsCapturedCallback(undefined);
      webviewProvider.postMessage({ type: MESSAGE_TYPES.SERVER_STOPPED });
      Log.info("[Extension] ctrlyoke: Hosted server stopped");
    }
  );

  const regenerateServerTokenCommand = vscode.commands.registerCommand(
    "ctrlyoke.regenerateServerToken",
    async () => {
      await new ServerTokenStore(platform.getSecretStore()).regenerate();
      webviewProvider.postMessage({
        type: MESSAGE_TYPES.SERVER_TOKEN_REGENERATED,
      });
      Log.info("[Extension] ctrlyoke: Server token regenerated");
    }
  );

  const refreshHarnessUsageCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.REFRESH_HARNESS_USAGE,
    async () => {
      await workflowOrchestrator.refreshHarnessUsage();
    }
  );

  const refreshWorkspaceStatsCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.REFRESH_WORKSPACE_STATS,
    async () => {
      await workflowOrchestrator.refreshWorkspaceStats();
    }
  );

  const manageWorktreesCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.MANAGE_WORKTREES,
    async () => {
      await vscode.commands.executeCommand("ctrlyoke.openPanel");
    }
  );

  const openWorktreeOwnerCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.OPEN_WORKTREE_OWNER,
    async (args: { stateRoot?: string }) => {
      if (!args?.stateRoot || !path.isAbsolute(args.stateRoot)) {
        reportCommandError(
          "ctrlyoke: The owning workspace path is unavailable."
        );
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(args.stateRoot),
        true
      );
    }
  );

  // Add all production commands to subscriptions
  context.subscriptions.push(
    openPanelCommand,
    openUnseenFailedRunCommand,
    retryHarnessDetectionCommand,
    openSecretsSettingsCommand,
    reviewWorkspaceSettingsTrustCommand,
    showGettingStartedCommand,
    registerInstallCliCommand(context),
    activateProCommand,
    activateOfflineProCommand,
    deactivateProCommand,
    manageLicenseCommand,
    pauseCommand,
    resumeCommand,
    stopCommand,
    newWorkflowCommand,
    createNewTemplateCommand,
    runFromContextCommand,
    queueFromContextCommand,
    queueNextFromContextCommand,
    loadFromContextCommand,
    selectPromptFileCommand,
    appendFromDashboardCommand,
    resumeSessionCommand,
    editCurrentPromptFileCommand,
    runCommand,
    showOutputPanelCommand,
    openFileWithSelectionCommand,
    confirmExternalFileTrustCommand,
    clearWorkflowCommand,
    openGitChangeCommand,
    openWorktreeCommand,
    viewWorktreeDiffCommand,
    mergeWorktreeCommand,
    manageWorktreesCommand,
    openWorktreeOwnerCommand,
    addFileToPromptEditorCommand,
    addDirectoryToPromptEditorCommand,
    addSelectionToPromptEditorCommand,
    addSymbolToPromptEditorCommand,
    addOutputSelectionToPromptEditorCommand,
    addOutputChannelToPromptEditorCommand,
    addScmResourcesToPromptEditorCommand,
    addTimelineCommitToPromptEditorCommand,
    searchHistoryCommand,
    initWorkspaceCommand,
    enableServerCommand,
    disableServerCommand,
    regenerateServerTokenCommand,
    refreshHarnessUsageCommand,
    refreshWorkspaceStatsCommand,
    generateCommitMessageCommand,
    cancelCommitMessageGenerationCommand,
    resolveOutputCaptureCommand
  );

  // Auto-start hosted server if enabled in config (must be after command registration)
  if (configService.get("server")?.autoStart) {
    void vscode.commands.executeCommand("ctrlyoke.enableServer");
  }

  // Register development commands (only in dev mode)
  if (IS_DEV_MODE) {
    const { registerDevCommands } = require("./dev/DevCommands");
    registerDevCommands(context, {
      sendTestNotification: async () => {
        notificationManager?.sendTestNotification();
        await hostedServer?.sendTestNotification();
      },
    });
  }

  Log.debug("[Extension] ctrlyoke: Commands registered successfully");
}

export async function deactivate(): Promise<void> {
  Log.debug("[Extension] ctrlyoke: Extension deactivating...");

  try {
    // Run concurrently: the Ctrl+C sweep tells every AI CLI session to stop while
    // workflow instances cancel and flush their durable state. Sequencing these
    // would put the full settle window in front of the terminal shutdown for no
    // benefit — each signals a different layer of the same exit.
    await Promise.all([
      getPtyProcessManager()?.gracefulShutdownAllAiCliSessions(),
      workflowOrchestrator?.shutdown(),
    ]);

    hostedServer?.dispose();
    hostedServer = undefined;
    unprotectServerToken?.();
    unprotectServerToken = undefined;

    if (workflowOrchestrator) {
      workflowOrchestrator.dispose();
    }

    disposeTelemetry();
    memoryWatchdog?.dispose();
    memoryWatchdog = undefined;

    Log.debug("[Extension] ctrlyoke: Extension deactivated");
  } finally {
    // Last, and not via context.subscriptions: VS Code disposes those as soon
    // as this function hits its first await, so everything above would
    // otherwise be logging to a closed channel.
    Log.dispose();
  }
}
