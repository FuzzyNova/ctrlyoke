import * as vscode from "vscode";
import { FlightPathManager } from "./flightpath/FlightPathManager";

let flightPathManager: FlightPathManager;

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

    // Show initial message
    await vscode.window.showInformationMessage(
      "FlightPath Test: Testing New Window approach. Watch for a chat to open in a new window!"
    );

    // Strategy 1: Try opening chat in new window
    console.log("📋 Step 1: Opening Copilot Chat in New Window...");

    try {
      await vscode.commands.executeCommand(
        "workbench.action.chat.openInNewWindow"
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log("✅ Chat opened in new window");
    } catch (newWindowError) {
      console.warn(
        "⚠️ workbench.action.chat.openInNewWindow failed, trying editor approach:",
        newWindowError
      );

      // Fallback: Try opening in editor tab
      try {
        await vscode.commands.executeCommand(
          "workbench.action.chat.openInEditor"
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
        console.log("✅ Chat opened in editor tab instead");
      } catch (editorError) {
        console.warn(
          "⚠️ workbench.action.chat.openInEditor also failed, using panel approach:",
          editorError
        );

        // Final fallback: Use the original panel approach
        await vscode.commands.executeCommand(
          "workbench.panel.chat.view.copilot.focus"
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log("✅ Falling back to panel approach");
      }
    }

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
    // Initialize FlightPath manager
    flightPathManager = new FlightPathManager(context);
    await flightPathManager.initialize();

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
  const stopCommand = vscode.commands.registerCommand("flightpath.stop", () => {
    flightPathManager.stop();
  });

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
    showCopilotStatusCommand,
    testAutomationCommand,
    retryCopilotDetectionCommand
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
