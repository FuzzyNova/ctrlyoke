import * as vscode from "vscode";
import { FlightPathManager } from "./flightpath/FlightPathManager";
import { PromptCompletionProvider } from "./completions/PromptCompletionProvider";
import { Provider } from "./types/FlightPathTypes";
import { FlightPathDashboardProvider } from "./ui/FlightPathDashboardProvider";
import { FlightPathSettingsProvider } from "./ui/FlightPathSettingsProvider";
import { initializeModelRegistry } from "./utils/ModelRegistry";

let flightPathManager: FlightPathManager;
let dashboardProvider: FlightPathDashboardProvider;
let settingsProvider: FlightPathSettingsProvider;

/**
 * Test File Attachment - Test github.copilot.chat.attachFile and attachSelection commands
 */
async function testFileAttachment(): Promise<void> {
  console.log("🧪 Testing File Attachment Commands...");

  try {
    // Step 1: Open Copilot Chat
    console.log("📋 Step 1: Opening Copilot Chat...");
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus"
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 2: Test attachFile with this file
    const thisFileUri = vscode.Uri.file(__filename);
    console.log(`📎 Step 2: Testing attachFile with: ${thisFileUri.fsPath}`);

    try {
      await vscode.commands.executeCommand(
        "github.copilot.chat.attachFile",
        thisFileUri
      );
      console.log("✅ attachFile command executed successfully");
    } catch (error) {
      console.error("❌ attachFile command failed:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 3: Test attachSelection - open a file with a selection
    console.log("📋 Step 3: Testing attachSelection...");

    // Open a file and create a selection
    const doc = await vscode.workspace.openTextDocument(thisFileUri);
    const editor = await vscode.window.showTextDocument(doc);

    // Select lines 10-20
    const startLine = 10;
    const endLine = 20;
    const selection = new vscode.Selection(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, 0)
    );
    editor.selection = selection;

    console.log(`✂️ Selected lines ${startLine}-${endLine}`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Focus back to chat and try attachSelection
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus"
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      await vscode.commands.executeCommand(
        "github.copilot.chat.attachSelection"
      );
      console.log("✅ attachSelection command executed successfully");
    } catch (error) {
      console.error("❌ attachSelection command failed:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 4: Try typing a prompt to see if attachments worked
    console.log("⌨️ Step 4: Typing test prompt...");
    const testPrompt = "Explain what these attachments contain";
    await vscode.commands.executeCommand("type", { text: testPrompt });

    vscode.window
      .showInformationMessage(
        "🧪 File attachment test complete! Check the Copilot Chat to see if files were attached. Review the console for details.",
        "View Console"
      )
      .then((action) => {
        if (action === "View Console") {
          vscode.commands.executeCommand("workbench.action.output.show");
        }
      });

    console.log("✅ Test completed - check chat window for results");
  } catch (error) {
    console.error("❌ File attachment test failed:", error);
    vscode.window.showErrorMessage(`File attachment test failed: ${error}`);
  }
}

/**
 * Test Chat Model Selection - Investigate workbench.action.chat.changeModel
 */
async function testChatModelSelection(): Promise<void> {
  console.log("🧪 Testing Chat Model Selection Command...");

  try {
    // Step 1: Query available language models
    console.log("📋 Step 1: Querying available language models...");
    try {
      const models = await vscode.lm.selectChatModels({
        vendor: "copilot",
      });
      console.log(`✅ Found ${models.length} available models:`);
      models.forEach((model) => {
        console.log(
          `   - ID: ${model.id}, Family: ${model.family}, Vendor: ${model.vendor}`
        );
      });
    } catch (error) {
      console.log("⚠️ Could not query models via API:", error);
    }

    // Step 2: Open Copilot Chat
    console.log("\n📋 Step 2: Opening Copilot Chat...");
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus"
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test different model IDs based on actual available models
    // Format: { vendor: "copilot", family: "model-family", id: "model-id" }
    // ID is just the model name, not "copilot/model-name"
    const testCases = [
      {
        name: "GPT-4o",
        params: [{ vendor: "copilot", family: "gpt-4o", id: "gpt-4o" }],
      },
      {
        name: "GPT-4.1",
        params: [{ vendor: "copilot", family: "gpt-4.1", id: "gpt-4.1" }],
      },
      {
        name: "GPT-5",
        params: [{ vendor: "copilot", family: "gpt-5", id: "gpt-5" }],
      },
      {
        name: "Claude Sonnet 4",
        params: [
          {
            vendor: "copilot",
            family: "claude-sonnet-4",
            id: "claude-sonnet-4",
          },
        ],
      },
      {
        name: "Claude Sonnet 4.5",
        params: [
          {
            vendor: "copilot",
            family: "claude-sonnet-4.5",
            id: "claude-sonnet-4.5",
          },
        ],
      },
      {
        name: "Claude Haiku 4.5",
        params: [
          {
            vendor: "copilot",
            family: "claude-haiku-4.5",
            id: "claude-haiku-4.5",
          },
        ],
      },
      {
        name: "Gemini 2.5 Pro",
        params: [
          {
            vendor: "copilot",
            family: "gemini-2.5-pro",
            id: "gemini-2.5-pro",
          },
        ],
      },
    ];

    for (const testCase of testCases) {
      console.log(`\n🔍 Testing: ${testCase.name}`);
      console.log(`   Parameters: ${JSON.stringify(testCase.params)}`);

      try {
        await vscode.commands.executeCommand(
          "workbench.action.chat.changeModel",
          ...testCase.params
        );
        console.log(`   ✅ Command executed successfully`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.log(`   ❌ Command failed:`, error);
      }
    }

    vscode.window
      .showInformationMessage(
        "🧪 Chat model selection test complete! Check the console for detailed results.",
        "View Console"
      )
      .then((action) => {
        if (action === "View Console") {
          vscode.commands.executeCommand(
            "workbench.action.output.toggleOutput"
          );
        }
      });

    console.log("\n✅ All test cases completed - check results above");
  } catch (error) {
    console.error("❌ Chat model selection test failed:", error);
    vscode.window.showErrorMessage(
      `Chat model selection test failed: ${error}`
    );
  }
}

/**
 * Test Chat Agent Selection Command
 * Investigates workbench.action.chat.openagent to determine if we can programmatically select agents
 */
async function testChatAgentSelection(): Promise<void> {
  console.log("🧪 Testing Chat Agent Selection Command...");

  try {
    // Step 1: Open Copilot Chat
    console.log("\n📋 Step 1: Opening Copilot Chat...");
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus"
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test different commands and parameter formats for agent selection
    const testCases = [
      {
        name: "workbench.action.chat.openagent - String (test-agent-alpha)",
        command: "workbench.action.chat.openagent",
        params: ["test-agent-alpha"],
      },
      {
        name: "workbench.action.chat.openagent - String (test-agent-beta)",
        command: "workbench.action.chat.openagent",
        params: ["test-agent-beta"],
      },
      {
        name: "workbench.action.chat.openagent - No params",
        command: "workbench.action.chat.openagent",
        params: [],
      },
      {
        name: "workbench.action.chat.picker.customagents - No params",
        command: "workbench.action.chat.picker.customagents",
        params: [],
      },
      {
        name: "workbench.action.chat.assignSelectedAgent - String (test-agent-alpha)",
        command: "workbench.action.chat.assignSelectedAgent",
        params: ["test-agent-alpha"],
      },
      {
        name: "workbench.action.chat.toggleAgentMode - No params",
        command: "workbench.action.chat.toggleAgentMode",
        params: [],
      },
    ];

    for (const testCase of testCases) {
      console.log(`\n🔍 Testing: ${testCase.name}`);
      console.log(`   Command: ${testCase.command}`);
      console.log(`   Parameters: ${JSON.stringify(testCase.params)}`);

      try {
        await vscode.commands.executeCommand(
          testCase.command,
          ...testCase.params
        );
        console.log(`   ✅ Command executed successfully (no error thrown)`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.log(`   ❌ Command failed:`, error);
      }
    }

    vscode.window
      .showInformationMessage(
        "🧪 Chat agent selection test complete! Check the console for detailed results.\n\n" +
          "Manual verification needed: Check if the agent was actually selected in the Chat UI.",
        "View Console"
      )
      .then((action) => {
        if (action === "View Console") {
          vscode.commands.executeCommand(
            "workbench.action.output.toggleOutput"
          );
        }
      });

    console.log("\n✅ All test cases completed - check results above");
    console.log(
      "⚠️ IMPORTANT: Manually verify if agent selection occurred in Chat UI"
    );
  } catch (error) {
    console.error("❌ Chat agent selection test failed:", error);
    vscode.window.showErrorMessage(
      `Chat agent selection test failed: ${error}`
    );
  }
}

/**
 * Test Copilot Chat automation feasibility - Testing Editor Chat approach
 */
async function testCopilotAutomation(): Promise<boolean> {
  const testMessage =
    "Hello Copilot! This is an automated test message from FlightPath using editor chat. Please respond with 'Test received' if you can see this.";

  try {
    console.log(
      "🚀 FlightPath: Starting Copilot automation test (Editor Chat approach)..."
    );

    // Get chat window location from settings
    const config = vscode.workspace.getConfiguration("flightpath");
    const chatLocation = config.get<string>("chatWindowLocation", "chatPanel");

    const commandMap: Record<
      string,
      { command: string; label: string; delay: number }
    > = {
      chatPanel: {
        command: "workbench.panel.chat.view.copilot.focus",
        label: "Chat Panel",
        delay: 1000,
      },
      newTab: {
        command: "workbench.action.chat.openInEditor",
        label: "Editor Tab",
        delay: 1500,
      },
      newWindow: {
        command: "workbench.action.chat.openInNewWindow",
        label: "New Window",
        delay: 1500,
      },
    };

    const method = commandMap[chatLocation] || commandMap["chatPanel"];

    console.log(
      `📋 Step 1: Opening Copilot Chat using ${method.label} (configured in settings)...`
    );

    try {
      await vscode.commands.executeCommand(method.command);
      await new Promise((resolve) => setTimeout(resolve, method.delay));
      console.log(`✅ Chat opened in ${method.label}`);
    } catch (error) {
      console.error(`❌ Failed to open chat using ${method.label}:`, error);
      vscode.window.showErrorMessage(
        `Failed to open Copilot Chat using ${method.label}. Error: ${error}`
      );
      return false;
    }

    // Note: Model selection cannot be automated via VS Code commands
    // Users must manually select their desired model before running FlightPath workflows
    console.log(
      "ℹ️ Note: Using currently selected model (model switching cannot be automated)"
    );

    // Step 2: Clear any existing text
    console.log("🧹 Step 2: Clearing existing input...");
    await vscode.commands.executeCommand("editor.action.selectAll");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Step 3: Type the test message
    console.log("⌨️ Step 3: Typing test message...");
    await vscode.commands.executeCommand("type", { text: testMessage });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Step 4: Submit the message
    console.log("📤 Step 4: Submitting message...");
    await vscode.commands.executeCommand("workbench.action.chat.submit");

    // Success!
    console.log("✅ FlightPath: Automation test completed successfully!");

    const response = await vscode.window.showInformationMessage(
      "🎉 FlightPath: Automation test completed! Check the editor or chat panel for the test message. Did it work?",
      "Yes, it worked!",
      "No, it failed",
      "Run again"
    );

    if (response === "Run again") {
      // Re-run the test
      return await testCopilotAutomation();
    } else if (response === "Yes, it worked!") {
      vscode.window.showInformationMessage(
        "🎉 Excellent! FlightPath Copilot automation is feasible. The editor chat approach can be used."
      );
      return true;
    } else {
      vscode.window.showWarningMessage(
        "⚠️ Test may have failed. Check VS Code logs and ensure Copilot Chat is available."
      );
      return false;
    }
  } catch (error) {
    console.error("❌ FlightPath: Automation test failed:", error);

    await vscode.window
      .showErrorMessage(
        `FlightPath Test Failed: ${error}. This may indicate automation won't work in this VS Code version.`,
        "View Error Details"
      )
      .then((selection) => {
        if (selection === "View Error Details") {
          console.error("Full error details:", error);
        }
      });

    return false;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("FlightPath: Extension activating...");

  try {
    // Initialize model registry (queries available Copilot models)
    // Run this early so models are available for IntelliSense
    initializeModelRegistry().catch((err) => {
      console.warn("FlightPath: Model registry initialization failed:", err);
    });

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
    const promptCompletionProvider = new PromptCompletionProvider();
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        [
          { pattern: "**/*.{prompt,flightpath}.json" },
          { pattern: "**/*.prompt.md" },
          { language: "prompt" }, // VS Code's prompt language (used by Copilot)
        ],
        promptCompletionProvider,
        "#" // Trigger on # character
      )
    );
    console.log(
      "FlightPath: Registered completion provider for prompt files (.json, .md, and prompt language)"
    );

    // Register commands
    registerCommands(context);

    console.log("FlightPath: Extension activated successfully!");
    vscode.window.showInformationMessage("FlightPath is ready for takeoff! 🚀");
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

  // Test Copilot Automation command - feasibility test (legacy POC)
  const testCopilotCommand = vscode.commands.registerCommand(
    "flightpath.test.copilotAutomation",
    async () => {
      await testCopilotAutomation();
    }
  );

  // Test File Attachment command - test github.copilot.chat.attachFile/attachSelection
  const testFileAttachmentCommand = vscode.commands.registerCommand(
    "flightpath.test.fileAttachment",
    async () => {
      await testFileAttachment();
    }
  );

  // Test Chat Model Selection command - investigate workbench.action.chat.changeModel
  const testChatModelSelectionCommand = vscode.commands.registerCommand(
    "flightpath.test.chatModelSelection",
    async () => {
      await testChatModelSelection();
    }
  );

  // Test Chat Agent Selection command - investigate workbench.action.chat.assignSelectedAgent
  const testChatAgentSelectionCommand = vscode.commands.registerCommand(
    "flightpath.test.chatAgentSelection",
    async () => {
      await testChatAgentSelection();
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

  /**
   * Helper function to list and display VS Code commands
   */
  async function listAndDisplayCommands(
    title: string,
    filterFn?: (cmd: string) => boolean
  ): Promise<void> {
    const allCommands = await vscode.commands.getCommands(true);
    const filteredCommands = filterFn
      ? allCommands.filter(filterFn).sort()
      : allCommands.sort();

    console.log(`=== ${title.toUpperCase()} ===`);
    console.log(`Found ${filteredCommands.length} commands:\n`);
    filteredCommands.forEach((cmd) => console.log(`  ${cmd}`));

    // Create a document to show the commands
    const doc = await vscode.workspace.openTextDocument({
      content: `FlightPath: ${title} (${filteredCommands.length} found)\n\n${filteredCommands.join("\n")}`,
      language: "plaintext",
    });
    await vscode.window.showTextDocument(doc);
  }

  // List all available chat commands (debugging tool)
  const listChatCommandsCommand = vscode.commands.registerCommand(
    "flightpath.listChatCommands",
    async () => {
      await listAndDisplayCommands(
        "Available Chat Commands",
        (cmd) =>
          cmd.includes("copilot-chat") ||
          cmd.includes("copilot") ||
          cmd.includes("workbench.action.chat") ||
          cmd.includes("github.copilot")
      );
    }
  );

  // List all available VS Code commands (debugging tool)
  const listAllCommandsCommand = vscode.commands.registerCommand(
    "flightpath.listAllCommands",
    async () => {
      await listAndDisplayCommands("All Available VS Code Commands");
    }
  );

  // Create End Condition Script command
  const createEndConditionScriptCommand = vscode.commands.registerCommand(
    "flightpath.createEndConditionScript",
    async () => {
      await flightPathManager.createEndConditionScript();
    }
  );

  // Send to CLI command (context menu)
  const sendToCliCommand = vscode.commands.registerCommand(
    "flightpath.sendToCli",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await flightPathManager.executePromptFile(
          uri.fsPath,
          Provider.CopilotCli
        );
        vscode.window.showInformationMessage(
          "FlightPath workflow started using CLI"
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to execute FlightPath workflow: ${error}`
        );
      }
    }
  );

  // Send to Chat command (context menu)
  const sendToChatCommand = vscode.commands.registerCommand(
    "flightpath.sendToChat",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage(
          "No file selected. Please right-click on a prompt file."
        );
        return;
      }

      try {
        await flightPathManager.executePromptFile(
          uri.fsPath,
          Provider.CopilotChat
        );
        vscode.window.showInformationMessage(
          "FlightPath workflow started using Chat"
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to execute FlightPath workflow: ${error}`
        );
      }
    }
  );

  // Debug: Show current document language ID
  const showLanguageIdCommand = vscode.commands.registerCommand(
    "flightpath.showLanguageId",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const doc = editor.document;
        vscode.window.showInformationMessage(
          `Language ID: ${doc.languageId}\nFile: ${doc.fileName}`,
          { modal: true }
        );
      } else {
        vscode.window.showWarningMessage("No active editor");
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

  // DEBUG: Investigate chat log access (temporary diagnostic command)
  const investigateChatLogsCommand = vscode.commands.registerCommand(
    "flightpath.investigateChatLogs",
    async () => {
      const { runAllInvestigations } = await import(
        "./test/chat-log-investigation"
      );
      await runAllInvestigations(context);
      vscode.window.showInformationMessage(
        "Chat log investigation complete! Check the console for results."
      );
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

  // Add all commands to subscriptions
  context.subscriptions.push(
    takeOffCommand,
    openPanelCommand,
    createPromptFileCommand,
    pauseCommand,
    resumeCommand,
    stopCommand,
    debugStateCommand,
    testCopilotCommand,
    testFileAttachmentCommand,
    testChatModelSelectionCommand,
    testChatAgentSelectionCommand,
    showCopilotStatusCommand,
    testAutomationCommand,
    retryCopilotDetectionCommand,
    listChatCommandsCommand,
    listAllCommandsCommand,
    createEndConditionScriptCommand,
    sendToCliCommand,
    sendToChatCommand,
    showLanguageIdCommand,
    selectPromptFileCommand,
    investigateChatLogsCommand,
    editCurrentPromptFileCommand,
    runCommand,
    showOutputPanelCommand
  );

  console.log("FlightPath: Commands registered successfully");
}

export function deactivate() {
  console.log("FlightPath: Extension deactivating...");

  if (flightPathManager) {
    flightPathManager.dispose();
  }

  console.log("FlightPath: Extension deactivated");
}
