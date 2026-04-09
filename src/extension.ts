import * as vscode from "vscode";
import * as path from "path";
import { WorkflowOrchestrator } from "./flightpath/WorkflowOrchestrator";
import { PromptCompletionProvider } from "./completions/PromptCompletionProvider";
import { PromptPropertyCompletionProvider } from "./completions/PromptPropertyCompletionProvider";
import { PromptLinkProvider } from "./completions/PromptLinkProvider";
import { initializeCompletionHelpers } from "./completions/CompletionHelpers";
import { FlightPathWebviewProvider } from "./ui/FlightPathWebviewProvider";
import { FlightPathHostedServer } from "./server/FlightPathHostedServer";
import {
  EXECUTION_STATES,
  QUEUE_POSITION,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  type QueuePosition,
} from "./types/DashboardConstants";
import {
  getCommitDiff,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
} from "./utils/GitUtils";
import {
  getQueueStatus,
  appendToQueue,
  readQueueOutput,
} from "./flightpath/QueueOperations";
import { initializeModelRegistry } from "./utils/ModelRegistry";
import { TempFileManager } from "./utils/TempFileManager";
import { IS_DEV_MODE, BUILD_DATE } from "./utils/BuildConfig";
import { Log } from "./utils/Log";
import { saveIfDirty } from "./utils/FileSystemUtils";
import { getErrorMessage } from "./utils/ErrorUtils";
import { WorkspaceInitializer } from "./flightpath/orchestration/WorkspaceInitializer";
import { PATH_CONSTANTS } from "./utils/ConfigurationUtils";
import {
  initPtyProcessManager,
  setPtyPostMessage,
} from "./flightpath/harness/PtyProcessManager";
import { FlightPathMcpServerProvider } from "./ui/FlightPathMcpServerProvider";
import { configService } from "./config/FlightPathConfigService";
import {
  createUserConfigBackend,
  createWorkspaceConfigBackend,
} from "./config/FileConfigBackend";

let workflowOrchestrator: WorkflowOrchestrator;
let webviewProvider: FlightPathWebviewProvider;
let hostedServer: FlightPathHostedServer | undefined;

/**
 * Register Language Model Tools for VS Code Chat integration
 * These tools allow AI agents in VS Code Chat to read queue status and append prompts
 */
function registerLanguageModelTools(context: vscode.ExtensionContext) {
  try {
    // Tool 1: flightpath_queue_status (read operation)
    const queueStatusTool = vscode.lm.registerTool("flightpath_queue_status", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Getting FlightPath queue status...",
        };
      },
      invoke: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        try {
          const promptQueue = workflowOrchestrator.getActivePromptQueue();

          if (!promptQueue) {
            throw new Error("FlightPath queue not initialized");
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

    // Tool 2: flightpath_append_queue (write operation)
    const queueAppendTool = vscode.lm.registerTool("flightpath_append_queue", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Appending prompts to FlightPath queue...",
        };
      },
      invoke: async (parameters: unknown, _token: vscode.CancellationToken) => {
        try {
          const promptQueue = workflowOrchestrator.getActivePromptQueue();

          if (!promptQueue) {
            throw new Error("FlightPath queue not initialized");
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
              promptQueue.getWorkflowFile().finalStep ?? null
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

    // Tool 3: flightpath_capabilities (read harness/model availability)
    const capabilitiesTool = vscode.lm.registerTool("flightpath_capabilities", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Getting FlightPath capabilities...",
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
                    (m: { value: string; label: string }) => m.value !== "none"
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

    // Tool 4: flightpath_read_output (read AI response from completed prompts)
    const readOutputTool = vscode.lm.registerTool("flightpath_read_output", {
      prepareInvocation: async (
        _parameters: unknown,
        _token: vscode.CancellationToken
      ) => {
        return {
          invocationMessage: "Reading FlightPath prompt outputs...",
        };
      },
      invoke: async (parameters: unknown, _token: vscode.CancellationToken) => {
        try {
          const promptQueue = workflowOrchestrator.getActivePromptQueue();

          if (!promptQueue) {
            throw new Error("FlightPath queue not initialized");
          }

          const params = parameters as Record<string, unknown> | null;
          const indices = Array.isArray(params?.indices)
            ? (params!.indices as number[])
            : [];

          const result = readQueueOutput(promptQueue, { indices });

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
      "FlightPath: Registered Language Model Tools (flightpath_queue_status, flightpath_append_queue, flightpath_capabilities, flightpath_read_output)"
    );
  } catch (error) {
    Log.warn(
      "FlightPath: Failed to register Language Model Tools (VS Code API may not be available):",
      error
    );
    // Don't throw - this is optional functionality
  }
}

export async function activate(context: vscode.ExtensionContext) {
  Log.info("FlightPath: Extension activating...");
  if (IS_DEV_MODE) {
    Log.debug(`🔧 Development mode enabled (Build: ${BUILD_DATE})`);
  }

  try {
    // Initialize logging system early (creates output channel)
    Log.initialize(context);
    // Initialize model registry (queries available Copilot models)
    // Run this early so models are available for IntelliSense
    initializeModelRegistry().catch((err) => {
      Log.warn("FlightPath: Model registry initialization failed:", err);
    });

    // Initialize workspace and clean up orphaned temp files
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceRoot = workspaceFolders[0].uri.fsPath;

      // Auto-initialize .flightpath directory on first run
      WorkspaceInitializer.initializeIfNeeded(workspaceRoot)
        .then((isNew) => {
          if (isNew) {
            vscode.window
              .showInformationMessage(
                `FlightPath: Workspace initialized! A ${PATH_CONSTANTS.FLIGHTPATH_DIR}/ directory has been created with your workflows, prompts, and scripts folders.`,
                "Reveal Folder"
              )
              .then((choice) => {
                if (choice === "Reveal Folder") {
                  vscode.commands.executeCommand(
                    "revealFileInOS",
                    vscode.Uri.file(
                      path.join(workspaceRoot, PATH_CONSTANTS.FLIGHTPATH_DIR)
                    )
                  );
                }
              });
          }
        })
        .catch((err) => {
          Log.warn("FlightPath: Workspace initialization failed:", err);
        });

      // Clean up orphaned temp prompt files (from previous sessions)
      const tempMgr = new TempFileManager(workspaceRoot);
      tempMgr.cleanupOrphanedFiles().then((count) => {
        if (count > 0) {
          Log.info(
            `FlightPath: Cleaned up ${count} orphaned temp prompt file(s)`
          );
        }
      });
    }

    // Initialize config service with file-based backends so settings from
    // ~/.flightpath/settings.json and <workspace>/.flightpath/settings.json
    // are resolved by ConfigurationUtils throughout the extension.
    const userConfigBackend = createUserConfigBackend(() => {
      configService.notify();
    });
    configService.setUserBackend(userConfigBackend);
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceConfigBackend = createWorkspaceConfigBackend(
        workspaceFolders[0].uri.fsPath,
        () => {
          configService.notify();
        }
      );
      configService.setWorkspaceBackend(workspaceConfigBackend);
    }

    // Register React webview provider (Phase 4 - unified provider)
    webviewProvider = new FlightPathWebviewProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "flightpath.dashboard",
        webviewProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    Log.debug("FlightPath: React webview provider registered");

    // Initialize PTY process manager (must be after webviewProvider is created)
    const ptyManager = initPtyProcessManager((msg) =>
      webviewProvider.postMessagePublic(msg)
    );
    context.subscriptions.push(ptyManager);
    Log.debug("FlightPath: PTY process manager initialized");

    // Initialize FlightPath orchestrator with React webview provider
    workflowOrchestrator = new WorkflowOrchestrator(context, webviewProvider);

    // Set orchestrator reference in webview provider (for getting current state)
    webviewProvider.setWorkflowOrchestrator(workflowOrchestrator);
    // Give the provider the hub so config-change broadcasts reach browser tabs too
    webviewProvider.setHub(workflowOrchestrator.getDashboardBroadcastHub());

    // Upgrade PTY postMessage to broadcast terminal messages to all connected clients
    // (panel + browser tabs). initPtyProcessManager only had the panel reference; now
    // that the hub exists we redirect through it so browser tabs receive TERMINAL_STARTED,
    // TERMINAL_OUTPUT, and TERMINAL_ENDED in real-time.
    setPtyPostMessage((msg) =>
      workflowOrchestrator.getDashboardBroadcastHub().postMessage(msg)
    );

    // Share OutputHistoryManager with webview provider (single instance)
    webviewProvider.setOutputHistoryManager(
      workflowOrchestrator.getOutputHistoryManager()
    );

    // Register MCP server definition provider for injecting user-defined MCP
    // servers into VS Code's MCP subsystem during Copilot Chat workflow prompts.
    // The "flightpath" built-in server is NOT managed here — LM tools are
    // registered unconditionally via registerLanguageModelTools() above.
    if (typeof vscode.lm.registerMcpServerDefinitionProvider === "function") {
      const mcpProvider = new FlightPathMcpServerProvider();
      context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider(
          "flightpath.workflowMcpProvider",
          mcpProvider
        )
      );
      context.subscriptions.push(mcpProvider);
      workflowOrchestrator.setMcpServerProvider(mcpProvider);
      Log.debug("FlightPath: MCP server definition provider registered");
    }

    // Fire-and-forget: don't block activate() on initialization.
    // This lets VS Code call resolveWebviewView() immediately so the
    // dashboard renders in <1s instead of waiting ~8s for CLI checks.
    // WorkflowOrchestrator.setDashboardReady() handles the race: if READY
    // arrives before init completes, auto-load is deferred until init finishes.
    workflowOrchestrator.initialize().catch((err) => {
      Log.error("Manager initialization failed:", err);
      vscode.window.showErrorMessage(
        `FlightPath: Initialization failed: ${err}`
      );
    });

    // Re-capture theme vars when VS Code theme changes
    context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });
      })
    );

    // Register completion provider for prompt files (JSON, YAML, and Markdown)
    // Two triggers: @ for full file references, # for snippets (line ranges, selections)
    const promptCompletionProvider = new PromptCompletionProvider();
    const promptFilePatterns = [
      { pattern: "**/*.{prompt,flightpath}.json" },
      { pattern: "**/*.flightpath.{yaml,yml}" },
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
    Log.debug(
      "FlightPath: Registered completion provider for prompt files (.json, .yaml, .md, and prompt language) with @, #, and ~ triggers"
    );

    // Register property key completion provider for YAML workflow files.
    // No trigger character — activates on demand to offer prompt item property keys,
    // with context-aware branching based on type: script vs. AI prompt steps.
    const promptPropertyCompletionProvider =
      new PromptPropertyCompletionProvider();
    const yamlWorkflowPatterns = [
      { pattern: "**/*.flightpath.yaml" },
      { pattern: "**/*.flightpath.yml" },
    ];
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        yamlWorkflowPatterns,
        promptPropertyCompletionProvider
        // No trigger character — VS Code invokes on Ctrl+Space or natural typing
      )
    );
    Log.debug(
      "FlightPath: Registered property key completion provider for YAML workflow files"
    );

    // Register link provider for prompt files (enables Ctrl+Click navigation)
    const promptLinkProvider = new PromptLinkProvider();
    context.subscriptions.push(
      vscode.languages.registerDocumentLinkProvider(
        promptFilePatterns,
        promptLinkProvider
      )
    );
    Log.debug("FlightPath: Registered link provider for prompt files");

    // Initialize completion helpers with config watcher
    initializeCompletionHelpers(context);
    Log.debug("FlightPath: Initialized completion helpers with config watcher");

    // Register Language Model Tools (for VS Code Chat integration)
    registerLanguageModelTools(context);

    // Register commands
    registerCommands(context);

    Log.info("FlightPath: Extension activated successfully!");
  } catch (error) {
    Log.error("FlightPath: Failed to activate extension:", error);
    vscode.window.showErrorMessage(`FlightPath: Activation failed: ${error}`);
  }
}

function registerCommands(context: vscode.ExtensionContext) {
  // Open Panel command
  const openPanelCommand = vscode.commands.registerCommand(
    "flightpath.openPanel",
    async () => {
      await workflowOrchestrator.openPanel();
    }
  );

  // Create Prompt File command
  const createPromptFileCommand = vscode.commands.registerCommand(
    "flightpath.createPromptFile",
    async () => {
      await workflowOrchestrator.createPromptFile();
    }
  );

  // Pause execution command
  const pauseCommand = vscode.commands.registerCommand(
    "flightpath.pause",
    async () => {
      await workflowOrchestrator.pause();
    }
  );

  // Resume execution command
  const resumeCommand = vscode.commands.registerCommand(
    "flightpath.resume",
    async () => {
      await workflowOrchestrator.resume();
    }
  );

  // Stop execution command
  const stopCommand = vscode.commands.registerCommand(
    "flightpath.stop",
    async () => {
      await workflowOrchestrator.stop();
    }
  );

  // Create End Condition Script command
  const createEndConditionScriptCommand = vscode.commands.registerCommand(
    "flightpath.createEndConditionScript",
    async () => {
      await workflowOrchestrator.createEndConditionScript();
    }
  );

  // Import FlightPath Agents command
  const importAgentsCommand = vscode.commands.registerCommand(
    "flightpath.importAgents",
    async () => {
      await workflowOrchestrator.importAgents();
    }
  );

  // Import Workflow Templates command
  const importWorkflowTemplatesCommand = vscode.commands.registerCommand(
    "flightpath.importWorkflowTemplates",
    async () => {
      await workflowOrchestrator.importWorkflowTemplates();
    }
  );

  // New Workflow command (opens modal in dashboard)
  const newWorkflowCommand = vscode.commands.registerCommand(
    "flightpath.newWorkflow",
    async () => {
      // Focus the dashboard panel first
      await vscode.commands.executeCommand("flightpath.dashboard.focus");
      // Then open the modal
      webviewProvider.openNewWorkflowModal();
    }
  );

  // Create New Template command (QuickPick flow)
  const createNewTemplateCommand = vscode.commands.registerCommand(
    "flightpath.createNewTemplate",
    async () => {
      await workflowOrchestrator.createNewTemplate();
    }
  );

  // Queue with FlightPath command (context menu) - appends prompts to end of queue
  const queueFromContextCommand = vscode.commands.registerCommand(
    "flightpath.queueFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage("No file selected");
        return;
      }
      await saveIfDirty(uri.fsPath);
      await workflowOrchestrator.appendFromFile(uri.fsPath, "end");
    }
  );

  // Queue Next With FlightPath command (context menu) - appends prompts after current position
  const queueNextFromContextCommand = vscode.commands.registerCommand(
    "flightpath.queueNextFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage("No file selected");
        return;
      }
      await saveIfDirty(uri.fsPath);
      await workflowOrchestrator.appendFromFile(uri.fsPath, "next");
    }
  );

  // Run with FlightPath command (context menu) - runs using current harness
  const runFromContextCommand = vscode.commands.registerCommand(
    "flightpath.runFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await saveIfDirty(uri.fsPath);
        await workflowOrchestrator.executePromptFile(uri.fsPath);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to execute FlightPath workflow: ${error}`
        );
      }
    }
  );

  // Load in FlightPath command (context menu) - loads without executing
  const loadFromContextCommand = vscode.commands.registerCommand(
    "flightpath.loadFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await saveIfDirty(uri.fsPath);
        await workflowOrchestrator.loadPromptFile(uri.fsPath);
        // Open the FlightPath panel to show the loaded file
        await vscode.commands.executeCommand("flightpath.dashboard.focus");
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to load FlightPath prompt file: ${error}`
        );
      }
    }
  );

  // Select Prompt File command (for dashboard)
  const selectPromptFileCommand = vscode.commands.registerCommand(
    "flightpath.selectPromptFile",
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }

      // Find all prompt files in the workspace
      const promptFiles = await vscode.workspace.findFiles(
        "**/*.{flightpath.json,flightpath.yaml,flightpath.yml,prompt.md}",
        "**/node_modules/**"
      );

      if (promptFiles.length === 0) {
        vscode.window.showWarningMessage("No prompt files found in workspace");
        return;
      }

      // Show quick pick
      const items = promptFiles.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        uri: uri,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a prompt file to load",
      });

      if (selected) {
        // Load the file into the dashboard (don't execute)
        await workflowOrchestrator.loadPromptFile(selected.uri.fsPath);
      }
    }
  );

  // Append Prompt File command (for dashboard Append button)
  const appendFromDashboardCommand = vscode.commands.registerCommand(
    "flightpath.appendFromDashboard",
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }

      // Find all prompt files in the workspace
      const promptFiles = await vscode.workspace.findFiles(
        "**/*.{flightpath.json,flightpath.yaml,flightpath.yml,prompt.md}",
        "**/node_modules/**"
      );

      if (promptFiles.length === 0) {
        vscode.window.showWarningMessage("No prompt files found in workspace");
        return;
      }

      // Show quick pick
      const items = promptFiles.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        uri: uri,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a prompt file to append to queue",
      });

      if (selected) {
        // Append to end of queue (dashboard button always uses "end" position)
        await workflowOrchestrator.appendFromFile(selected.uri.fsPath, "end");
      }
    }
  );

  // Resume Session command - shows list of previous sessions from .flightpath/.queue
  const resumeSessionCommand = vscode.commands.registerCommand(
    "flightpath.resumeSession",
    async () => {
      await workflowOrchestrator.resumeSession();
    }
  );

  // Edit Current Prompt File command (for dashboard)
  const editCurrentPromptFileCommand = vscode.commands.registerCommand(
    "flightpath.editCurrentPromptFile",
    async () => {
      await workflowOrchestrator.openCurrentPromptFile();
    }
  );

  // Run command (for dashboard) - executes currently loaded file
  const runCommand = vscode.commands.registerCommand(
    "flightpath.run",
    async () => {
      // Execute the currently loaded prompt file
      await workflowOrchestrator.executeLoadedPromptFile();
    }
  );

  // Show Output Panel command
  const showOutputPanelCommand = vscode.commands.registerCommand(
    "flightpath.showOutputPanel",
    () => {
      vscode.commands.executeCommand("workbench.action.output.show");
    }
  );

  // Create Draft Prompt command (for dashboard New button)
  const createDraftPromptCommand = vscode.commands.registerCommand(
    "flightpath.createDraftPrompt",
    async () => {
      await workflowOrchestrator.createDraftPrompt();
    }
  );

  // Clear Workflow command (keyboard shortcut: Ctrl+Shift+N when FlightPath panel focused)
  const clearWorkflowCommand = vscode.commands.registerCommand(
    "flightpath.clearWorkflow",
    () => {
      webviewProvider.handleClearWorkflow();
    }
  );

  // Open File with Selection command (for clickable links in prompt files)
  const openFileWithSelectionCommand = vscode.commands.registerCommand(
    "flightpath.openFileWithSelection",
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

  // Open Git Change command — opens a git diff (diff/staged/stash:N/<hash>) in a new untitled editor
  const openGitChangeCommand = vscode.commands.registerCommand(
    "flightpath.openGitChange",
    async (args: { ref: string; workspaceRoot?: string }) => {
      try {
        const workspaceRoot =
          args.workspaceRoot ??
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          vscode.window.showErrorMessage(
            "FlightPath: No workspace folder open."
          );
          return;
        }

        let content: string;
        const ref = args.ref.toLowerCase();

        if (ref === "diff") {
          content = await getWorkingTreeDiff(workspaceRoot);
          if (!content.trim()) {
            content = "No uncommitted changes in working tree.";
          }
        } else if (ref === "staged") {
          content = await getStagedDiff(workspaceRoot);
          if (!content.trim()) {
            content = "No staged changes.";
          }
        } else if (ref.startsWith("stash:")) {
          const index = parseInt(ref.slice(6), 10);
          content = await getStashDiff(workspaceRoot, index);
        } else {
          // Treat as commit hash
          content = await getCommitDiff(workspaceRoot, args.ref);
        }

        const doc = await vscode.workspace.openTextDocument({
          content,
          language: "diff",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (error) {
        vscode.window.showErrorMessage(
          `FlightPath: Failed to open git change: ${getErrorMessage(error)}`
        );
      }
    }
  );

  // Initialize Workspace command (manual reinit for existing users)
  const initWorkspaceCommand = vscode.commands.registerCommand(
    "flightpath.initWorkspace",
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage(
          "FlightPath: No workspace folder open. Open a folder first."
        );
        return;
      }
      try {
        await WorkspaceInitializer.reinitialize(workspaceFolders[0].uri.fsPath);
        vscode.window.showInformationMessage(
          `FlightPath: Workspace initialized — ${PATH_CONSTANTS.FLIGHTPATH_DIR}/ directories and .gitignore are up to date.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `FlightPath: Workspace initialization failed: ${err}`
        );
      }
    }
  );

  // Server commands
  const enableServerCommand = vscode.commands.registerCommand(
    "flightpath.enableServer",
    () => {
      if (hostedServer) return;
      const hub = workflowOrchestrator.getDashboardBroadcastHub();
      const port = configService.get("server")?.port ?? 3000;
      hostedServer = new FlightPathHostedServer(hub, webviewProvider, port);
      const url = hostedServer.listen();
      webviewProvider.setRunningServerUrl(url);
      webviewProvider.postMessage({ type: MESSAGE_TYPES.SERVER_STARTED, url });
      webviewProvider.setThemeVarsCapturedCallback((vars) =>
        hostedServer?.updateThemeVars(vars)
      );
      webviewProvider.postMessage({ type: MESSAGE_TYPES.CAPTURE_THEME_VARS });
      Log.info(`FlightPath: Hosted server started at ${url}`);
    }
  );

  const disableServerCommand = vscode.commands.registerCommand(
    "flightpath.disableServer",
    () => {
      hostedServer?.dispose();
      hostedServer = undefined;
      webviewProvider.setRunningServerUrl(undefined);
      webviewProvider.setThemeVarsCapturedCallback(undefined);
      webviewProvider.postMessage({ type: MESSAGE_TYPES.SERVER_STOPPED });
      Log.info("FlightPath: Hosted server stopped");
    }
  );

  // Add all production commands to subscriptions
  context.subscriptions.push(
    openPanelCommand,
    createPromptFileCommand,
    pauseCommand,
    resumeCommand,
    stopCommand,
    createEndConditionScriptCommand,
    importAgentsCommand,
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
    createDraftPromptCommand,
    openFileWithSelectionCommand,
    clearWorkflowCommand,
    openGitChangeCommand,
    initWorkspaceCommand,
    enableServerCommand,
    disableServerCommand
  );

  // Auto-start hosted server if enabled in config (must be after command registration)
  if (configService.get("server")?.enabled) {
    void vscode.commands.executeCommand("flightpath.enableServer");
  }

  // Register development commands (only in dev mode)
  if (IS_DEV_MODE) {
    const { registerDevCommands } = require("./dev/DevCommands");
    registerDevCommands(context);
  }

  Log.debug("FlightPath: Commands registered successfully");
}

export function deactivate() {
  Log.debug("FlightPath: Extension deactivating...");

  hostedServer?.dispose();
  hostedServer = undefined;

  if (workflowOrchestrator) {
    workflowOrchestrator.dispose();
  }

  Log.debug("FlightPath: Extension deactivated");
}
