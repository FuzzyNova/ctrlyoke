import * as vscode from "vscode";
import { FlightPathManager } from "./flightpath/FlightPathManager";
import { PromptCompletionProvider } from "./completions/PromptCompletionProvider";
import { PromptLinkProvider } from "./completions/PromptLinkProvider";
import { FlightPathDashboardProvider } from "./ui/FlightPathDashboardProvider";
import { FlightPathSettingsProvider } from "./ui/FlightPathSettingsProvider";
import { initializeModelRegistry } from "./utils/ModelRegistry";
import { TempFileManager } from "./utils/TempFileManager";
import { IS_DEV_MODE, BUILD_DATE } from "./utils/BuildConfig";
import { Log, LogLevel } from "./utils/Log";

let flightPathManager: FlightPathManager;
let dashboardProvider: FlightPathDashboardProvider;
let settingsProvider: FlightPathSettingsProvider;

export async function activate(context: vscode.ExtensionContext) {
  console.log("FlightPath: Extension activating...");
  if (IS_DEV_MODE) {
    console.log(`🔧 Development mode enabled (Build: ${BUILD_DATE})`);
  }

  try {
    // Initialize logging system early (creates output channel)
    Log.initialize(context, LogLevel.DEBUG);
    // Initialize model registry (queries available Copilot models)
    // Run this early so models are available for IntelliSense
    initializeModelRegistry().catch((err) => {
      console.warn("FlightPath: Model registry initialization failed:", err);
    });

    // Clean up orphaned temp prompt files (from previous sessions)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const tempMgr = new TempFileManager(workspaceRoot);
      tempMgr.cleanupOrphanedFiles().then((count) => {
        if (count > 0) {
          console.log(
            `FlightPath: Cleaned up ${count} orphaned temp prompt file(s)`
          );
        }
      });
    }

    // Register dashboard provider
    dashboardProvider = new FlightPathDashboardProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "flightpath.dashboard",
        dashboardProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    console.log("FlightPath: Dashboard provider registered");

    // Register settings provider
    settingsProvider = new FlightPathSettingsProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "flightpath.settings",
        settingsProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    console.log("FlightPath: Settings provider registered");

    // Initialize FlightPath manager with dashboard provider
    flightPathManager = new FlightPathManager(context, dashboardProvider);

    // Set manager reference in dashboard (for getting current state)
    dashboardProvider.setFlightPathManager(flightPathManager);

    await flightPathManager.initialize();

    // Register completion provider for prompt JSON and Markdown files
    // Two triggers: @ for full file references, # for snippets (line ranges, selections)
    const promptCompletionProvider = new PromptCompletionProvider();
    const promptFilePatterns = [
      { pattern: "**/*.{prompt,flightpath}.json" },
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
    console.log(
      "FlightPath: Registered completion provider for prompt files (.json, .md, and prompt language) with @ and # triggers"
    );

    // Register link provider for prompt files (enables Ctrl+Click navigation)
    const promptLinkProvider = new PromptLinkProvider();
    context.subscriptions.push(
      vscode.languages.registerDocumentLinkProvider(
        promptFilePatterns,
        promptLinkProvider
      )
    );
    console.log("FlightPath: Registered link provider for prompt files");

    // Register commands
    registerCommands(context);

    console.log("FlightPath: Extension activated successfully!");
  } catch (error) {
    console.error("FlightPath: Failed to activate extension:", error);
    vscode.window.showErrorMessage(`FlightPath: Activation failed: ${error}`);
  }
}

function registerCommands(context: vscode.ExtensionContext) {
  // Take Off command - main execution command
  const takeOffCommand = vscode.commands.registerCommand(
    "flightpath.takeOff",
    async () => {
      await flightPathManager.takeOff();
    }
  );

  // Open Panel command
  const openPanelCommand = vscode.commands.registerCommand(
    "flightpath.openPanel",
    async () => {
      await flightPathManager.openPanel();
    }
  );

  // Create Prompt File command
  const createPromptFileCommand = vscode.commands.registerCommand(
    "flightpath.createPromptFile",
    async () => {
      await flightPathManager.createPromptFile();
    }
  );

  // Pause execution command
  const pauseCommand = vscode.commands.registerCommand(
    "flightpath.pause",
    () => {
      flightPathManager.pause();
    }
  );

  // Resume execution command
  const resumeCommand = vscode.commands.registerCommand(
    "flightpath.resume",
    async () => {
      await flightPathManager.resume();
    }
  );

  // Stop execution command
  const stopCommand = vscode.commands.registerCommand(
    "flightpath.stop",
    async () => {
      await flightPathManager.stop();
    }
  );

  // Debug command to show current state
  const debugStateCommand = vscode.commands.registerCommand(
    "flightpath.debugState",
    () => {
      const state = flightPathManager.getQueueState();
      const stateInfo = `FlightPath Debug State:
                            Status: ${state.status}
                            Current Index: ${state.currentIndex}
                            Total Prompts: ${state.prompts.length}
                            Results: ${state.results.length}`;

      vscode.window.showInformationMessage(stateInfo, { modal: true });
    }
  );

  // Show Copilot Status command
  const showCopilotStatusCommand = vscode.commands.registerCommand(
    "flightpath.showCopilotStatus",
    () => {
      const status = flightPathManager.getCopilotStatus();
      const capabilities = flightPathManager.getCopilotCapabilities();

      const statusMessage = `FlightPath Copilot Integration Status:

${status.message}

Capabilities:
• Direct Automation (PROVEN): ${capabilities.hasDirectAutomation ? "✅" : "❌"}
• Zero-Interaction Support: ${capabilities.supportsZeroInteraction ? "✅" : "❌"}

Current Strategy: ${status.strategy}

Note: FlightPath uses a single proven strategy. When direct automation 
is unavailable, you'll receive clear error messages with troubleshooting steps.`;

      vscode.window
        .showInformationMessage(
          statusMessage,
          { modal: true },
          "Test Automation",
          "Close"
        )
        .then((action) => {
          if (action === "Test Automation") {
            vscode.commands.executeCommand("flightpath.testAutomation");
          }
        });
    }
  );

  // Test Automation command (integrated version)
  const testAutomationCommand = vscode.commands.registerCommand(
    "flightpath.testAutomation",
    async () => {
      const result = await flightPathManager.testCopilotAutomation();
      if (result) {
        vscode.window.showInformationMessage(
          "✅ FlightPath: Automation test passed!"
        );
      } else {
        vscode.window.showWarningMessage(
          "⚠️ FlightPath: Automation test failed. Check Copilot Chat availability."
        );
      }
    }
  );

  // Retry Copilot Detection command
  const retryCopilotDetectionCommand = vscode.commands.registerCommand(
    "flightpath.retryCopilotDetection",
    async () => {
      await flightPathManager.retryCopilotDetection();
    }
  );

  // Create End Condition Script command
  const createEndConditionScriptCommand = vscode.commands.registerCommand(
    "flightpath.createEndConditionScript",
    async () => {
      await flightPathManager.createEndConditionScript();
    }
  );

  // Import FlightPath Agents command
  const importAgentsCommand = vscode.commands.registerCommand(
    "flightpath.importAgents",
    async () => {
      await flightPathManager.importAgents();
    }
  );

  // Import Workflow Templates command
  const importWorkflowTemplatesCommand = vscode.commands.registerCommand(
    "flightpath.importWorkflowTemplates",
    async () => {
      await flightPathManager.importWorkflowTemplates();
    }
  );

  // New Workflow command (opens modal in dashboard)
  const newWorkflowCommand = vscode.commands.registerCommand(
    "flightpath.newWorkflow",
    async () => {
      // Focus the dashboard panel first
      await vscode.commands.executeCommand("flightpath.dashboard.focus");
      // Then open the modal
      dashboardProvider.openNewWorkflowModal();
    }
  );

  // Create New Template command (QuickPick flow)
  const createNewTemplateCommand = vscode.commands.registerCommand(
    "flightpath.createNewTemplate",
    async () => {
      await flightPathManager.createNewTemplate();
    }
  );

  // Run with FlightPath command (context menu) - runs using current provider
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
        // executePromptFile without provider override uses the current settings provider
        await flightPathManager.executePromptFile(uri.fsPath);
        vscode.window.showInformationMessage("FlightPath workflow completed");
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
        await flightPathManager.loadPromptFile(uri.fsPath);
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
        "**/*.{prompt.json,flightpath.json,prompt.md}",
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
        await flightPathManager.loadPromptFile(selected.uri.fsPath);
      }
    }
  );

  // Edit Current Prompt File command (for dashboard)
  const editCurrentPromptFileCommand = vscode.commands.registerCommand(
    "flightpath.editCurrentPromptFile",
    async () => {
      await flightPathManager.openCurrentPromptFile();
    }
  );

  // Run command (for dashboard) - executes currently loaded file
  const runCommand = vscode.commands.registerCommand(
    "flightpath.run",
    async () => {
      // Execute the currently loaded prompt file
      await flightPathManager.executeLoadedPromptFile();
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
      await flightPathManager.createDraftPrompt();
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
          `Failed to open file: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Add all production commands to subscriptions
  context.subscriptions.push(
    takeOffCommand,
    openPanelCommand,
    createPromptFileCommand,
    pauseCommand,
    resumeCommand,
    stopCommand,
    debugStateCommand,
    showCopilotStatusCommand,
    testAutomationCommand,
    retryCopilotDetectionCommand,
    createEndConditionScriptCommand,
    importAgentsCommand,
    importWorkflowTemplatesCommand,
    newWorkflowCommand,
    createNewTemplateCommand,
    runFromContextCommand,
    loadFromContextCommand,
    selectPromptFileCommand,
    editCurrentPromptFileCommand,
    runCommand,
    showOutputPanelCommand,
    createDraftPromptCommand,
    openFileWithSelectionCommand
  );

  // Register development commands (only in dev mode)
  if (IS_DEV_MODE) {
    const { registerDevCommands } = require("./dev/DevCommands");
    registerDevCommands(context);
  }

  console.log("FlightPath: Commands registered successfully");
}

export function deactivate() {
  console.log("FlightPath: Extension deactivating...");

  if (flightPathManager) {
    flightPathManager.dispose();
  }

  console.log("FlightPath: Extension deactivated");
}
