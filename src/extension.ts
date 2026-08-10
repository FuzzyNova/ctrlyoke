import * as vscode from "vscode";
import * as path from "path";
import { WorkflowOrchestrator } from "./core/WorkflowOrchestrator";
import { PromptCompletionProvider } from "./completions/PromptCompletionProvider";
import { PromptPropertyCompletionProvider } from "./completions/PromptPropertyCompletionProvider";
import { PromptLinkProvider } from "./completions/PromptLinkProvider";
import { initializeCompletionHelpers } from "./completions/CompletionHelpers";
import { ContextMenuReferenceCommands } from "./completions/ContextMenuReferenceCommands";
import { CtrlYokeWebviewProvider } from "./ui/CtrlYokeWebviewProvider";
import {
  getVsCodeWorkspaceRoot,
  getVsCodeNamedWorkspaceRoots,
} from "./platform/VsCodeWorkspaceRoot";
import { ServerTokenStore } from "./platform/ServerTokenStore";
import { CtrlYokeHostedServer } from "./server/CtrlYokeHostedServer";
import {
  EXECUTION_STATES,
  GIT_CHANGE_KINDS,
  QUEUE_POSITION,
  MESSAGE_TYPES,
  MODEL_OPTION_VALUES,
  PANEL_CLIENT_ID,
  VSCODE_COMMANDS,
  VSCODE_GIT_COMMANDS,
  type QueuePosition,
} from "./types/DashboardConstants";
import {
  getCommitDiff,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
  getStashFiles,
} from "./utils/GitUtils";
import {
  getQueueStatus,
  appendToQueue,
  readQueueOutput,
} from "./core/QueueOperations";
import { initializeModelRegistry } from "./utils/ModelRegistry";
import { TempFileManager } from "./utils/TempFileManager";
import { AntigravityCliProvider } from "./core/harness/antigravity/AntigravityCliProvider";
import { IS_DEV_MODE, BUILD_DATE } from "./utils/BuildConfig";
import { Log } from "./utils/Log";
import { saveIfDirty } from "./utils/FileSystemUtils";
import { getErrorMessage } from "./utils/ErrorUtils";
import { findWorkflowFilesInWorkspace } from "./utils/WorkflowFileDiscovery";
import { WorkspaceInitializer } from "./core/orchestration/WorkspaceInitializer";
import { PATH_CONSTANTS } from "./utils/ConfigurationUtils";
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
import {
  confirmExternalFileTrustAndOpen,
  promptBatchApprovalForPendingWorkspaceExternalRoots,
  type FileOpenTarget,
} from "./ui/ExternalFileTrustPrompt";
import { ScmCommitCommand } from "./scm/ScmCommitCommand";
import { CompositeUserFeedbackSink } from "./core/CompositeUserFeedbackSink";
import { VsCodeUserFeedbackSink } from "./platform/VsCodeUserFeedbackSink";
import { HostedWebSocketUserFeedbackSink } from "./server/HostedWebSocketUserFeedbackSink";

let workflowOrchestrator: WorkflowOrchestrator;
let webviewProvider: CtrlYokeWebviewProvider;
let hostedServer: CtrlYokeHostedServer | undefined;
let notificationManager: NotificationManager | undefined;

/**
 * Register Language Model Tools for VS Code Chat integration
 * These tools allow AI agents in VS Code Chat to read queue status and append prompts
 */
function registerLanguageModelTools(context: vscode.ExtensionContext) {
  try {
    // Tool 1: ctrlyoke_queue_status (read operation)
    const queueStatusTool = vscode.lm.registerTool("ctrlyoke_queue_status", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Getting ctrlyoke queue status...",
        };
      },
      invoke: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        try {
          const promptQueue = workflowOrchestrator.getActivePromptQueue();

          if (!promptQueue) {
            throw new Error("ctrlyoke queue not initialized");
          }

          const queue = workflowOrchestrator.getQueueState(PANEL_CLIENT_ID);
          const status = getQueueStatus(promptQueue, queue.workingFilePath);

          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(status, null, 2)),
          ]);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Error: ${errorMsg}`),
          ]);
        }
      },
    });

    // Tool 2: ctrlyoke_append_queue (write operation)
    const queueAppendTool = vscode.lm.registerTool("ctrlyoke_append_queue", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Appending prompts to ctrlyoke queue...",
        };
      },
      invoke: async (parameters: unknown, _token: vscode.CancellationToken) => {
        try {
          const promptQueue = workflowOrchestrator.getActivePromptQueue();

          if (!promptQueue) {
            throw new Error("ctrlyoke queue not initialized");
          }

          // Validate parameters shape
          const params = parameters as Record<string, unknown> | null;
          if (!params || typeof params !== "object") {
            throw new Error("Invalid parameters: expected an object");
          }

          const request = {
            steps: (Array.isArray(params.steps) ? params.steps : []) as Array<{
              prompt: string;
              model?: string;
              harness?: string;
              resumeSession?: boolean;
              sessionId?: number;
            }>,
            position: (typeof params.position === "string"
              ? params.position
              : QUEUE_POSITION.END) as QueuePosition,
            source: (typeof params.source === "string"
              ? params.source
              : "VS Code Chat") as string,
          };

          const result = await appendToQueue(promptQueue, request);

          // Update dashboard with extended prompts
          if (webviewProvider) {
            const updatedState = promptQueue.getState();
            webviewProvider.updateStepsExtended(
              updatedState.steps,
              promptQueue.getWorkflowFile().finalStep ?? null,
              undefined,
              updatedState.definitionRevision
            );
            webviewProvider.updateProgress(
              updatedState.currentIndex,
              updatedState.steps.length
            );
          }

          // If queue was completed, resume execution
          const queueState = promptQueue.getState();
          if (queueState.status === EXECUTION_STATES.COMPLETED) {
            await workflowOrchestrator.executeLoadedPromptFile(undefined, true);
          }

          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
          ]);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Error: ${errorMsg}`),
          ]);
        }
      },
    });

    // Tool 3: ctrlyoke_capabilities (read harness/model availability)
    const capabilitiesTool = vscode.lm.registerTool("ctrlyoke_capabilities", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Getting ctrlyoke capabilities...",
        };
      },
      invoke: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        try {
          const settingsSync = webviewProvider.getSettingsSync();
          const modelOptions = settingsSync.buildModelOptions();
          const harnessStatus = settingsSync.getHarnessStatus();

          const harnesses = Object.keys(harnessStatus)
            .filter((id) => harnessStatus[id].available)
            .map((id) => {
              const options = modelOptions[id] ?? [];
              return {
                id,
                available: true,
                models: options
                  .filter(
                    (m: { value: string; label: string }) =>
                      m.value !== MODEL_OPTION_VALUES.NONE
                  )
                  .map((m: { value: string; label: string }) => m.value),
              };
            });

          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              JSON.stringify({ generatedAt: Date.now(), harnesses }, null, 2)
            ),
          ]);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Error: ${errorMsg}`),
          ]);
        }
      },
    });

    // Tool 4: ctrlyoke_read_output (read AI response from completed prompts)
    const readOutputTool = vscode.lm.registerTool("ctrlyoke_read_output", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Reading ctrlyoke prompt outputs...",
        };
      },
      invoke: async (parameters: unknown, _token: vscode.CancellationToken) => {
        try {
          const promptQueue = workflowOrchestrator.getActivePromptQueue();

          if (!promptQueue) {
            throw new Error("ctrlyoke queue not initialized");
          }

          const params = parameters as Record<string, unknown> | null;
          const indices = Array.isArray(params?.indices)
            ? (params!.indices as number[])
            : [];

          const state = promptQueue.getState();
          const outputHistoryManager =
            workflowOrchestrator.getOutputHistoryManager();
          const result = await readQueueOutput(
            promptQueue,
            { indices },
            state.workflowKey && state.runRef
              ? {
                  manifestPath: outputHistoryManager.getHistoryFilePath(
                    state.workflowKey,
                    state.runRef
                  ),
                  resolver: outputHistoryManager.getRunOutputResolver(),
                }
              : undefined
          );

          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
          ]);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Error: ${errorMsg}`),
          ]);
        }
      },
    });

    context.subscriptions.push(
      queueStatusTool,
      queueAppendTool,
      capabilitiesTool,
      readOutputTool
    );
    Log.debug(
      "ctrlyoke: Registered Language Model Tools (ctrlyoke_queue_status, ctrlyoke_append_queue, ctrlyoke_capabilities, ctrlyoke_read_output)"
    );
  } catch (error) {
    Log.warn(
      "ctrlyoke: Failed to register Language Model Tools (VS Code API may not be available):",
      error
    );
    // Don't throw - this is optional functionality
  }
}

// Publisher/name must match package.json; walkthrough id must match contributes.walkthroughs.
const GETTING_STARTED_WALKTHROUGH_ID =
  "fuzzynova.ctrlyoke#ctrlyoke.gettingStarted";
const GETTING_STARTED_SHOWN_KEY = "ctrlyoke.gettingStartedShown";

function openGettingStartedWalkthrough(): void {
  void vscode.commands.executeCommand(
    "workbench.action.openWalkthrough",
    GETTING_STARTED_WALKTHROUGH_ID
  );
}

export async function activate(context: vscode.ExtensionContext) {
  Log.info("ctrlyoke: Extension activating...");
  if (IS_DEV_MODE) {
    Log.debug(`🔧 Development mode enabled (Build: ${BUILD_DATE})`);
  }

  try {
    // Initialize config service with file-based backends BEFORE Log.initialize()
    // so isDiagnosticLogsEnabled() reads the correct user/workspace value when
    // deciding whether to open the log file.
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const userConfigBackend = createUserConfigBackend();
    configService.setUserBackend(userConfigBackend);
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceConfigBackend = createWorkspaceConfigBackend(
        getVsCodeWorkspaceRoot()
      );
      configService.setWorkspaceBackend(workspaceConfigBackend);

      // Batch-approve any workspace-configured external file roots that
      // haven't been reviewed yet (no-op if there are none, or the
      // workspace isn't trusted — retried below via onDidGrantWorkspaceTrust).
      // See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
      void promptBatchApprovalForPendingWorkspaceExternalRoots(
        getVsCodeWorkspaceRoot()
      );
    }
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        if (vscode.workspace.workspaceFolders?.length) {
          void promptBatchApprovalForPendingWorkspaceExternalRoots(
            getVsCodeWorkspaceRoot()
          );
        }
      })
    );

    // Initialize logging system early (creates output channel)
    Log.initialize(
      context,
      workspaceFolders?.length ? getVsCodeWorkspaceRoot() : undefined
    );
    // Initialize model registry (queries available Copilot models)
    // Run this early so models are available for IntelliSense
    initializeModelRegistry().catch((err) => {
      Log.warn("ctrlyoke: Model registry initialization failed:", err);
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
        WorkspaceInitializer.initializeIfNeeded(workspaceRoot)
          .then((isNew) => {
            if (isNew) {
              vscode.window
                .showInformationMessage(
                  `ctrlyoke: Workspace initialized! A ${PATH_CONSTANTS.CTRLYOKE_DIR}/ directory has been created for your workflows, prompts, and scripts.`,
                  "Reveal Folder"
                )
                .then((choice) => {
                  if (choice === "Reveal Folder") {
                    vscode.commands.executeCommand(
                      "revealFileInOS",
                      vscode.Uri.file(
                        path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR)
                      )
                    );
                  }
                });
            }
          })
          .catch((err) => {
            Log.warn("ctrlyoke: Workspace initialization failed:", err);
          });

        // Clean up orphaned temp prompt files (from previous sessions)
        const tempMgr = new TempFileManager(workspaceRoot);
        tempMgr.cleanupOrphanedFiles().then((count) => {
          if (count > 0) {
            Log.info(
              `ctrlyoke: Cleaned up ${count} orphaned temp prompt file(s)`
            );
          }
        });

        // Restore agy's statusline if a previous ctrlyoke process died holding
        // the lease. The lease prunes dead owners on its own register/
        // unregister paths too; this just recovers sooner than the next run.
        AntigravityCliProvider.pruneOrphanedStatusLine(workspaceRoot).catch(
          (err) => {
            Log.warn("ctrlyoke: Antigravity statusline cleanup failed:", err);
          }
        );
      } else {
        // Not yet initialized — remember the root so we can set the pending
        // flag on the orchestrator once it is created below.
        pendingInitWorkspaceRoot = workspaceRoot;
      }
    }

    // Register React webview provider (Phase 4 - unified provider)
    webviewProvider = new CtrlYokeWebviewProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "ctrlyoke.dashboard",
        webviewProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    Log.debug("ctrlyoke: React webview provider registered");

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
    Log.debug("ctrlyoke: PTY process manager initialized");

    // Initialize ctrlyoke orchestrator with React webview provider
    const browserUserFeedbackSink = new HostedWebSocketUserFeedbackSink(
      (message) => hostedServer?.broadcastUserFeedback(message)
    );
    const userFeedbackSink = new CompositeUserFeedbackSink([
      new VsCodeUserFeedbackSink(),
      browserUserFeedbackSink,
    ]);
    workflowOrchestrator = new WorkflowOrchestrator(
      context,
      webviewProvider,
      userFeedbackSink
    );

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
      Log.error("Manager initialization failed:", err);
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
          `ctrlyoke: Resolved workspace root changed from "${previousRoot}" to "${nextRoot}". A window reload is required to relocate .ctrlyoke.`
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
    const promptCompletionProvider = new PromptCompletionProvider();
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
      "ctrlyoke: Registered completion provider for prompt files (.json, .yaml, .md, and prompt language) with @, #, ~, and $ triggers"
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
      "ctrlyoke: Registered property key completion provider for YAML workflow files"
    );

    // Register link provider for prompt files (enables Ctrl+Click navigation)
    const promptLinkProvider = new PromptLinkProvider();
    context.subscriptions.push(
      vscode.languages.registerDocumentLinkProvider(
        promptFilePatterns,
        promptLinkProvider
      )
    );
    Log.debug("ctrlyoke: Registered link provider for prompt files");

    // Initialize completion helpers with config watcher
    initializeCompletionHelpers(context);
    Log.debug("ctrlyoke: Initialized completion helpers with config watcher");

    // Register Language Model Tools (for VS Code Chat integration)
    registerLanguageModelTools(context);

    // Register commands
    registerCommands(context);

    // Show the Getting Started walkthrough once, on first activation after install.
    if (!context.globalState.get<boolean>(GETTING_STARTED_SHOWN_KEY)) {
      openGettingStartedWalkthrough();
      void context.globalState.update(GETTING_STARTED_SHOWN_KEY, true);
    }

    Log.info("ctrlyoke: Extension activated successfully!");
  } catch (error) {
    Log.error("ctrlyoke: Failed to activate extension:", error);
    vscode.window.showErrorMessage(`ctrlyoke: Activation failed: ${error}`);
  }
}

function registerCommands(context: vscode.ExtensionContext) {
  const contextMenuReferenceCommands = new ContextMenuReferenceCommands(
    webviewProvider
  );

  // Open Panel command
  const openPanelCommand = vscode.commands.registerCommand(
    "ctrlyoke.openPanel",
    async () => {
      await workflowOrchestrator.openPanel();
    }
  );

  // Show Getting Started walkthrough command (manual reopen affordance)
  const showGettingStartedCommand = vscode.commands.registerCommand(
    "ctrlyoke.showGettingStarted",
    () => {
      openGettingStartedWalkthrough();
    }
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

  // Create End Condition Script command
  const createEndConditionScriptCommand = vscode.commands.registerCommand(
    "ctrlyoke.createEndConditionScript",
    async () => {
      await workflowOrchestrator.createEndConditionScript();
    }
  );

  // Import Workflow Templates command
  const importWorkflowTemplatesCommand = vscode.commands.registerCommand(
    "ctrlyoke.importWorkflowTemplates",
    async () => {
      await workflowOrchestrator.importWorkflowTemplates();
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

  // Create New Template command (QuickPick flow)
  const createNewTemplateCommand = vscode.commands.registerCommand(
    "ctrlyoke.createNewTemplate",
    async () => {
      await workflowOrchestrator.createNewTemplate();
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
    "ctrlyoke.selectPromptFile",
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

  // Resume Session command - shows list of previous sessions from .ctrlyoke/.runs
  const resumeSessionCommand = vscode.commands.registerCommand(
    "ctrlyoke.resumeSession",
    async () => {
      await workflowOrchestrator.resumeSession();
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
      Log.getOutputChannel().show();
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
      await confirmExternalFileTrustAndOpen(target);
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
  const scmCommitCommand = new ScmCommitCommand();
  const generateCommitMessageCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.GENERATE_COMMIT_MESSAGE,
    () => scmCommitCommand.execute(context)
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
      const port = configService.get("server")?.port ?? 3000;
      const workspaceRoot = getVsCodeWorkspaceRoot();
      const namedWorkspaceRoots = getVsCodeNamedWorkspaceRoots();
      const token = await new ServerTokenStore(context.secrets).getOrCreate();
      const bindAddress =
        configService.get("server")?.bindAddress ?? "127.0.0.1";
      const tlsCfg = configService.get("server")?.tls;
      const tlsConfig =
        tlsCfg?.enabled && tlsCfg.certPath && tlsCfg.keyPath
          ? { certPath: tlsCfg.certPath, keyPath: tlsCfg.keyPath }
          : undefined;
      try {
        hostedServer = new CtrlYokeHostedServer(
          hub,
          webviewProvider,
          () => workflowOrchestrator,
          port,
          workspaceRoot,
          namedWorkspaceRoots,
          token,
          bindAddress,
          tlsConfig
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `ctrlyoke: Failed to start server — ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      let url: string;
      try {
        url = await hostedServer.listen();
      } catch (err) {
        hostedServer = undefined;
        vscode.window.showErrorMessage(
          `ctrlyoke: Failed to bind server — ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      const availableIps = hostedServer.getAvailableIps();
      webviewProvider.setRunningServerUrl(url, availableIps);
      webviewProvider.postMessage({
        type: MESSAGE_TYPES.SERVER_STARTED,
        url,
        availableIps,
      });
      webviewProvider.setThemeVarsCapturedCallback((vars) =>
        hostedServer?.updateThemeVars(vars)
      );
      webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });
      Log.info(`ctrlyoke: Hosted server started at ${url}`);
    }
  );

  const disableServerCommand = vscode.commands.registerCommand(
    "ctrlyoke.disableServer",
    () => {
      hostedServer?.dispose();
      hostedServer = undefined;
      webviewProvider.setRunningServerUrl(undefined);
      webviewProvider.setThemeVarsCapturedCallback(undefined);
      webviewProvider.postMessage({ type: MESSAGE_TYPES.SERVER_STOPPED });
      Log.info("ctrlyoke: Hosted server stopped");
    }
  );

  const regenerateServerTokenCommand = vscode.commands.registerCommand(
    "ctrlyoke.regenerateServerToken",
    async () => {
      await new ServerTokenStore(context.secrets).regenerate();
      webviewProvider.postMessage({
        type: MESSAGE_TYPES.SERVER_TOKEN_REGENERATED,
      });
      Log.info("ctrlyoke: Server token regenerated");
    }
  );

  const refreshHarnessUsageCommand = vscode.commands.registerCommand(
    VSCODE_COMMANDS.REFRESH_HARNESS_USAGE,
    async () => {
      await workflowOrchestrator.refreshHarnessUsage();
    }
  );

  // Add all production commands to subscriptions
  context.subscriptions.push(
    openPanelCommand,
    showGettingStartedCommand,
    pauseCommand,
    resumeCommand,
    stopCommand,
    createEndConditionScriptCommand,
    importWorkflowTemplatesCommand,
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
    addFileToPromptEditorCommand,
    addDirectoryToPromptEditorCommand,
    addSelectionToPromptEditorCommand,
    addSymbolToPromptEditorCommand,
    addScmResourcesToPromptEditorCommand,
    addTimelineCommitToPromptEditorCommand,
    searchHistoryCommand,
    initWorkspaceCommand,
    enableServerCommand,
    disableServerCommand,
    regenerateServerTokenCommand,
    refreshHarnessUsageCommand,
    generateCommitMessageCommand,
    cancelCommitMessageGenerationCommand
  );

  // Auto-start hosted server if enabled in config (must be after command registration)
  if (configService.get("server")?.enabled) {
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

  Log.debug("ctrlyoke: Commands registered successfully");
}

export async function deactivate(): Promise<void> {
  Log.debug("ctrlyoke: Extension deactivating...");

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

  if (workflowOrchestrator) {
    workflowOrchestrator.dispose();
  }

  Log.debug("ctrlyoke: Extension deactivated");
}
