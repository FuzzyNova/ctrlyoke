/**
 * DevCommands - Development and diagnostic commands
 *
 * This module contains commands that are only registered in development mode.
 * These are useful for:
 * - Testing VS Code API behavior
 * - Discovering available commands and models
 * - Debugging integration issues
 * - Updating model constants and documentation
 *
 * In production builds, this module is not imported and the code is eliminated
 * by esbuild's dead code elimination.
 *
 * Entry point: a single `flightpath.devMenu` command declared in package.json
 * that shows a QuickPick menu listing all dev tools. Individual commands are
 * registered programmatically (no package.json entries) and are accessible
 * from the menu or via executeCommand in tests.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";
import {
  getAvailableModelsSync,
  getCliSupportedModelIdsSync,
} from "../utils/ModelRegistry";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import { MESSAGE_TYPES } from "../types/DashboardConstants";

export type DevDashboardAction =
  | "buildExtension"
  | "buildWebview"
  | "buildAll"
  | "reloadWindow"
  | "restartExtensionHost"
  | "buildExtensionAndReload"
  | "buildWebviewAndReload"
  | "buildAllAndReload"
  | "runTests"
  | "sendTestNotification";

export interface DevDashboardActionOptions {
  context: vscode.ExtensionContext;
  postMessage: (message: unknown) => void;
  sendTestNotification?: () => Promise<void>;
}

export interface DevCommandHandlers {
  sendTestNotification?: () => Promise<void>;
}

let isBuilding = false;

const DEV_RELOAD_WINDOW_COMMAND = "workbench.action.reloadWindow";
const DEV_RESTART_EXTENSION_HOST_COMMAND =
  "workbench.action.restartExtensionHost";

interface DevBuildResult {
  success: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  errorSummary?: string;
}

async function getRestartCommandAvailability(): Promise<{
  reloadWindow: boolean;
  restartExtensionHost: boolean;
}> {
  const commands = await vscode.commands.getCommands(false);
  return {
    reloadWindow: commands.includes(DEV_RELOAD_WINDOW_COMMAND),
    restartExtensionHost: commands.includes(DEV_RESTART_EXTENSION_HOST_COMMAND),
  };
}

function appendBuildLog(stream: "stdout" | "stderr", chunk: string): void {
  const trimmed = chunk.trimEnd();
  if (trimmed.length === 0) {
    return;
  }
  const prefix = stream === "stderr" ? "[dev build stderr]" : "[dev build]";
  Log.info(`${prefix} ${trimmed}`);
}

function summarizeBuildError(stderr: string, stdout: string): string {
  const source = stderr.trim().length > 0 ? stderr : stdout;
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-6).join("\n") || "Build failed.";
}

async function runNpmBuild(
  context: vscode.ExtensionContext,
  scriptName: "compile:extension" | "compile:webview" | "compile" | "test",
  postMessage: (message: unknown) => void
): Promise<DevBuildResult> {
  if (isBuilding) {
    const result: DevBuildResult = {
      success: false,
      exitCode: null,
      signal: null,
      durationMs: 0,
      errorSummary: "A build is already running.",
    };
    postMessage({
      type: MESSAGE_TYPES.DEV_BUILD_COMPLETED,
      ...result,
    });
    return result;
  }

  const startedAt = Date.now();
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const commandLabel = `npm run ${scriptName}`;
  let stdout = "";
  let stderr = "";

  isBuilding = true;
  postMessage({
    type: MESSAGE_TYPES.DEV_BUILD_STARTED,
    script: scriptName,
    command: commandLabel,
  });
  Log.info(`[dev build] Starting ${commandLabel}`);

  return await new Promise<DevBuildResult>((resolve) => {
    const child = spawn(npmCommand, ["run", scriptName], {
      cwd: context.extensionUri.fsPath,
      // On Windows, .cmd files must be launched through the shell (cmd.exe);
      // spawning them directly with shell:false causes EINVAL.
      shell: process.platform === "win32",
      env: process.env,
    });
    let settled = false;

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      appendBuildLog("stdout", chunk);
      postMessage({
        type: MESSAGE_TYPES.DEV_BUILD_OUTPUT,
        stream: "stdout",
        chunk,
      });
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      appendBuildLog("stderr", chunk);
      postMessage({
        type: MESSAGE_TYPES.DEV_BUILD_OUTPUT,
        stream: "stderr",
        chunk,
      });
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      stderr += error.message;
      const durationMs = Date.now() - startedAt;
      const result: DevBuildResult = {
        success: false,
        exitCode: null,
        signal: null,
        durationMs,
        errorSummary: error.message,
      };
      isBuilding = false;
      Log.error(`[dev build] ${commandLabel} failed to start:`, error);
      postMessage({
        type: MESSAGE_TYPES.DEV_BUILD_OUTPUT,
        stream: "stderr",
        chunk: error.message,
      });
      postMessage({
        type: MESSAGE_TYPES.DEV_BUILD_COMPLETED,
        ...result,
      });
      resolve(result);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      const durationMs = Date.now() - startedAt;
      const success = exitCode === 0;
      const result: DevBuildResult = {
        success,
        exitCode,
        signal,
        durationMs,
        ...(success
          ? {}
          : { errorSummary: summarizeBuildError(stderr, stdout) }),
      };
      isBuilding = false;
      if (success) {
        Log.info(`[dev build] ${commandLabel} completed in ${durationMs}ms`);
      } else {
        Log.error(
          `[dev build] ${commandLabel} failed with exit code ${exitCode}`
        );
      }
      postMessage({
        type: MESSAGE_TYPES.DEV_BUILD_COMPLETED,
        ...result,
      });
      resolve(result);
    });
  });
}

async function executeRestartCommand(
  command:
    | typeof DEV_RELOAD_WINDOW_COMMAND
    | typeof DEV_RESTART_EXTENSION_HOST_COMMAND,
  postMessage: (message: unknown) => void
): Promise<void> {
  const availability = await getRestartCommandAvailability();
  const available =
    command === DEV_RELOAD_WINDOW_COMMAND
      ? availability.reloadWindow
      : availability.restartExtensionHost;

  if (!available) {
    postMessage({
      type: MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE,
      command,
      reason: "The VS Code command is not available in this runtime.",
    });
    return;
  }

  postMessage({
    type: MESSAGE_TYPES.DEV_RESTARTING,
    command,
  });
  await vscode.commands.executeCommand(command);
}

export async function handleDevDashboardAction(
  action: DevDashboardAction,
  options: DevDashboardActionOptions
): Promise<void> {
  const { context, postMessage, sendTestNotification } = options;

  if (action === "sendTestNotification") {
    if (!sendTestNotification) {
      postMessage({
        type: MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE,
        command: action,
        reason: "Test notifications are unavailable in this runtime.",
      });
      return;
    }

    await sendTestNotification();
    return;
  }

  if (action === "reloadWindow") {
    await executeRestartCommand(DEV_RELOAD_WINDOW_COMMAND, postMessage);
    return;
  }

  if (action === "restartExtensionHost") {
    await executeRestartCommand(
      DEV_RESTART_EXTENSION_HOST_COMMAND,
      postMessage
    );
    return;
  }

  const scriptName =
    action === "buildExtension" || action === "buildExtensionAndReload"
      ? "compile:extension"
      : action === "buildWebview" || action === "buildWebviewAndReload"
        ? "compile:webview"
        : action === "runTests"
          ? "test"
          : "compile";
  const result = await runNpmBuild(context, scriptName, postMessage);
  if (!result.success) {
    return;
  }

  if (action === "buildWebviewAndReload") {
    await executeRestartCommand(DEV_RELOAD_WINDOW_COMMAND, postMessage);
    return;
  }

  if (action === "buildExtensionAndReload" || action === "buildAllAndReload") {
    await executeRestartCommand(
      DEV_RESTART_EXTENSION_HOST_COMMAND,
      postMessage
    );
  }
}

// ============================================================================
// Test Functions
// ============================================================================

/**
 * Test File Attachment - Test github.copilot.chat.attachFile and attachSelection commands
 */
async function testFileAttachment(): Promise<void> {
  Log.info("🧪 Testing File Attachment Commands...");

  try {
    // Step 1: Open Copilot Chat
    Log.info("📋 Step 1: Opening Copilot Chat...");
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus"
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 2: Test attachFile with this file
    const thisFileUri = vscode.Uri.file(__filename);
    Log.info(`📎 Step 2: Testing attachFile with: ${thisFileUri.fsPath}`);

    try {
      await vscode.commands.executeCommand(
        "github.copilot.chat.attachFile",
        thisFileUri
      );
      Log.info("✅ attachFile command executed successfully");
    } catch (error) {
      Log.error("❌ attachFile command failed:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 3: Test attachSelection - open a file with a selection
    Log.info("📋 Step 3: Testing attachSelection...");

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

    Log.info(`✂️ Selected lines ${startLine}-${endLine}`);
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
      Log.info("✅ attachSelection command executed successfully");
    } catch (error) {
      Log.error("❌ attachSelection command failed:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 4: Try typing a prompt to see if attachments worked
    Log.info("⌨️ Step 4: Typing test prompt...");
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

    Log.info("✅ Test completed - check chat window for results");
  } catch (error) {
    Log.error("❌ File attachment test failed:", error);
    vscode.window.showErrorMessage(`File attachment test failed: ${error}`);
  }
}

/**
 * Test Chat Model Selection - Investigate workbench.action.chat.changeModel
 */
async function testChatModelSelection(): Promise<void> {
  Log.info("🧪 Testing Chat Model Selection Command...");

  try {
    // Step 1: Query available language models
    Log.info("📋 Step 1: Querying available language models...");
    try {
      const models = await vscode.lm.selectChatModels({
        vendor: "copilot",
      });
      Log.info(`✅ Found ${models.length} available models:`);
      models.forEach((model) => {
        Log.info(
          `   - ID: ${model.id}, Family: ${model.family}, Vendor: ${model.vendor}`
        );
      });
    } catch (error) {
      Log.info("⚠️ Could not query models via API:", error);
    }

    // Step 2: Open Copilot Chat
    Log.info("\n📋 Step 2: Opening Copilot Chat...");
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus"
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test different model IDs based on actual available models
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
      Log.info(`\n🔍 Testing: ${testCase.name}`);
      Log.info(`   Parameters: ${JSON.stringify(testCase.params)}`);

      try {
        await vscode.commands.executeCommand(
          "workbench.action.chat.changeModel",
          ...testCase.params
        );
        Log.info(`   ✅ Command executed successfully`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        Log.info(`   ❌ Command failed:`, error);
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

    Log.info("\n✅ All test cases completed - check results above");
  } catch (error) {
    Log.error("❌ Chat model selection test failed:", error);
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
  Log.info("🧪 Testing Chat Agent Selection Command...");

  try {
    // Step 1: Open Copilot Chat
    Log.info("\n📋 Step 1: Opening Copilot Chat...");
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
      Log.info(`\n🔍 Testing: ${testCase.name}`);
      Log.info(`   Command: ${testCase.command}`);
      Log.info(`   Parameters: ${JSON.stringify(testCase.params)}`);

      try {
        await vscode.commands.executeCommand(
          testCase.command,
          ...testCase.params
        );
        Log.info(`   ✅ Command executed successfully (no error thrown)`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        Log.info(`   ❌ Command failed:`, error);
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

    Log.info("\n✅ All test cases completed - check results above");
    Log.info(
      "⚠️ IMPORTANT: Manually verify if agent selection occurred in Chat UI"
    );
  } catch (error) {
    Log.error("❌ Chat agent selection test failed:", error);
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
    Log.info(
      "🚀 FlightPath: Starting Copilot automation test (Editor Chat approach)..."
    );

    // Get chat window location from settings
    const chatLocation = ConfigurationUtils.getChatWindowLocation();

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

    Log.info(
      `📋 Step 1: Opening Copilot Chat using ${method.label} (configured in settings)...`
    );

    try {
      await vscode.commands.executeCommand(method.command);
      await new Promise((resolve) => setTimeout(resolve, method.delay));
      Log.info(`✅ Chat opened in ${method.label}`);
    } catch (error) {
      Log.error(`❌ Failed to open chat using ${method.label}:`, error);
      vscode.window.showErrorMessage(
        `Failed to open Copilot Chat using ${method.label}. Error: ${error}`
      );
      return false;
    }

    // Note: Model selection cannot be automated via VS Code commands
    Log.info(
      "ℹ️ Note: Using currently selected model (model switching cannot be automated)"
    );

    // Step 2: Clear any existing text
    Log.info("🧹 Step 2: Clearing existing input...");
    await vscode.commands.executeCommand("editor.action.selectAll");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Step 3: Type the test message
    Log.info("⌨️ Step 3: Typing test message...");
    await vscode.commands.executeCommand("type", { text: testMessage });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Step 4: Submit the message
    Log.info("📤 Step 4: Submitting message...");
    await vscode.commands.executeCommand("workbench.action.chat.submit");

    // Success!
    Log.info("✅ FlightPath: Automation test completed successfully!");

    const response = await vscode.window.showInformationMessage(
      "🎉 FlightPath: Automation test completed! Check the editor or chat panel for the test message. Did it work?",
      "Yes, it worked!",
      "No, it failed",
      "Run again"
    );

    if (response === "Run again") {
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
    Log.error("❌ FlightPath: Automation test failed:", error);

    await vscode.window
      .showErrorMessage(
        `FlightPath Test Failed: ${error}. This may indicate automation won't work in this VS Code version.`,
        "View Error Details"
      )
      .then((selection) => {
        if (selection === "View Error Details") {
          Log.error("Full error details:", error);
        }
      });

    return false;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Helper function to list and display VS Code commands
 * @param title Title for the command list
 * @param filterFn Optional filter function to select specific commands
 * @param outputFilePath Optional file path to save the output (relative to workspace root)
 */
async function listAndDisplayCommands(
  title: string,
  filterFn?: (cmd: string) => boolean,
  outputFilePath?: string
): Promise<void> {
  const allCommands = await vscode.commands.getCommands(true);
  const filteredCommands = filterFn
    ? allCommands.filter(filterFn).sort()
    : allCommands.sort();

  Log.info(`=== ${title.toUpperCase()} ===`);
  Log.info(`Found ${filteredCommands.length} commands:\n`);
  filteredCommands.forEach((cmd) => Log.info(`  ${cmd}`));

  // Generate markdown content
  const timestamp = new Date().toISOString();
  const content = `# ${title}

**Generated:** ${timestamp}  
**Total Commands:** ${filteredCommands.length}

---

${filteredCommands.map((cmd) => `- \`${cmd}\``).join("\n")}
`;

  if (outputFilePath) {
    // Save to file
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }

    const fullPath = path.join(workspaceFolders[0].uri.fsPath, outputFilePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      fs.writeFileSync(fullPath, content, "utf8");
      Log.info(`✅ Saved to ${fullPath}`);

      // Open the file
      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(
        `Saved ${filteredCommands.length} commands to ${outputFilePath}`
      );
    } catch (error) {
      Log.error(`❌ Failed to save to ${fullPath}:`, error);
      vscode.window.showErrorMessage(`Failed to save commands: ${error}`);
    }
  } else {
    // Create a temporary document to show the commands
    const doc = await vscode.workspace.openTextDocument({
      content: `FlightPath: ${title} (${filteredCommands.length} found)\n\n${filteredCommands.join("\n")}`,
      language: "plaintext",
    });
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * Export discovered models to a JSON file for use by sync-models.mjs
 *
 * This allows updating ModelConstants.ts without manual copy-paste:
 * 1. Run extension (F5)
 * 2. Run "FlightPath: Export Discovered Models" command
 * 3. Run: npm run sync-models -- --import
 */
async function exportDiscoveredModels(): Promise<void> {
  Log.info("📤 Exporting discovered models...");

  // Get models from registry
  const chatModels = getAvailableModelsSync();
  const cliModelIds = getCliSupportedModelIdsSync();

  if (chatModels.length === 0) {
    vscode.window.showWarningMessage(
      "No models discovered yet. Wait for extension to initialize or run 'FlightPath: Retry Copilot Detection'."
    );
    return;
  }

  // Build export object
  const exportData = {
    exportedAt: new Date().toISOString(),
    source: "vscode.lm.selectChatModels({ vendor: 'copilot' })",
    chatModels: chatModels.map((m) => ({
      id: m.id,
      family: m.family,
      vendor: m.vendor,
      cliSupported: m.cliSupported,
    })),
    cliModelIds: cliModelIds,
    // Just the IDs for easy reference
    chatModelIds: chatModels.map((m) => m.id),
  };

  // Find workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  const outputPath = path.join(
    workspaceFolders[0].uri.fsPath,
    "scripts",
    "discovered-models.json"
  );

  try {
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2) + "\n");
    Log.info(`✅ Exported ${chatModels.length} models to ${outputPath}`);

    const action = await vscode.window.showInformationMessage(
      `Exported ${chatModels.length} chat models and ${cliModelIds.length} CLI models to scripts/discovered-models.json`,
      "Open File",
      "Run Sync"
    );

    if (action === "Open File") {
      const doc = await vscode.workspace.openTextDocument(outputPath);
      await vscode.window.showTextDocument(doc);
    } else if (action === "Run Sync") {
      // Open terminal and run sync command
      const terminal = vscode.window.createTerminal("FlightPath Sync");
      terminal.show();
      terminal.sendText("npm run sync-models -- --import");
    }
  } catch (error) {
    Log.error("❌ Failed to export models:", error);
    vscode.window.showErrorMessage(`Failed to export models: ${error}`);
  }
}

/**
 * Dump all --vscode-* CSS variables injected by VS Code into a webview.
 *
 * Opens a minimal WebviewPanel, reads every --vscode-* CSS custom property
 * from getComputedStyle(document.documentElement), then writes the result to
 * dev/reference/vscode-css-vars.json so we can inspect which variables are
 * actually available (and what their values are) in the active theme.
 *
 * Usage: run "FlightPath: Dump CSS Variables" from the command palette (dev only).
 */
async function dumpVsCodeCssVariables(
  context: vscode.ExtensionContext
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "flightpath.cssVarDump",
    "Dumping CSS Vars…",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [] }
  );

  // Generate a nonce for the inline script
  const nonce = crypto.randomBytes(16).toString("hex");

  panel.webview.html = /* html */ `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}';">
</head>
<body>
  <p>Reading CSS variables…</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const styles = getComputedStyle(document.documentElement);
    const vars = {};
    for (const prop of styles) {
      if (prop.startsWith('--vscode-')) {
        vars[prop] = styles.getPropertyValue(prop).trim();
      }
    }
    vscode.postMessage({ type: 'cssVars', count: Object.keys(vars).length, vars });
  </script>
</body>
</html>`;

  // Wait for the webview to post back the variables
  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.type !== "cssVars") {
        return;
      }

      panel.dispose();

      const outputPath = path.join(
        workspaceFolders[0].uri.fsPath,
        "dev",
        "reference",
        "vscode-css-vars.json"
      );

      const output = {
        generatedAt: new Date().toISOString(),
        count: message.count,
        vars: Object.fromEntries(
          Object.entries(message.vars as Record<string, string>).sort(
            ([a], [b]) => a.localeCompare(b)
          )
        ),
      };

      try {
        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
        Log.info(`✅ Dumped ${message.count} CSS variables to ${outputPath}`);

        const action = await vscode.window.showInformationMessage(
          `Dumped ${message.count} --vscode-* CSS variables to ${outputPath}`,
          "Open File"
        );
        if (action === "Open File") {
          const doc = await vscode.workspace.openTextDocument(outputPath);
          await vscode.window.showTextDocument(doc);
        }
      } catch (error) {
        Log.error("❌ Failed to write CSS vars file:", error);
        vscode.window.showErrorMessage(`Failed to write CSS vars: ${error}`);
      }
    },
    undefined,
    context.subscriptions
  );
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register all development-only commands
 *
 * This function is only called in development mode (IS_DEV_MODE = true).
 * In production builds, this code is eliminated by esbuild's dead code removal.
 *
 * @param context Extension context for registering disposables
 */
export function registerDevCommands(
  context: vscode.ExtensionContext,
  handlers: DevCommandHandlers = {}
): void {
  Log.info("🔧 FlightPath: Registering development commands...");

  // Set context key so the devMenu command is visible in the command palette
  vscode.commands.executeCommand("setContext", "flightpath.devMode", true);

  // ── Individual dev commands ──────────────────────────────────────────────
  // These are registered programmatically (no package.json entries required).
  // They are accessible via the devMenu QuickPick or executeCommand in tests.

  // Test Copilot Automation command - feasibility test (legacy POC)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flightpath.test.copilotAutomation",
      async () => {
        await testCopilotAutomation();
      }
    )
  );

  // Test File Attachment command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flightpath.test.fileAttachment",
      async () => {
        await testFileAttachment();
      }
    )
  );

  // Test Chat Model Selection command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flightpath.test.chatModelSelection",
      async () => {
        await testChatModelSelection();
      }
    )
  );

  // Test Chat Agent Selection command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flightpath.test.chatAgentSelection",
      async () => {
        await testChatAgentSelection();
      }
    )
  );

  // List all available chat commands (debugging tool)
  context.subscriptions.push(
    vscode.commands.registerCommand("flightpath.listChatCommands", async () => {
      await listAndDisplayCommands(
        "Available Chat Commands",
        (cmd) =>
          cmd.includes("copilot-chat") ||
          cmd.includes("copilot") ||
          cmd.includes("workbench.action.chat") ||
          cmd.includes("github.copilot"),
        "dev/reference/CHAT_COMMANDS.md"
      );
    })
  );

  // List all available VS Code commands (debugging tool)
  context.subscriptions.push(
    vscode.commands.registerCommand("flightpath.listAllCommands", async () => {
      await listAndDisplayCommands(
        "All Available VS Code Commands",
        undefined,
        "dev/reference/VSCODE_COMMANDS.md"
      );
    })
  );

  // Debug: Show current document language ID
  context.subscriptions.push(
    vscode.commands.registerCommand("flightpath.showLanguageId", () => {
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
    })
  );

  // Export Discovered Models command (for sync-models.mjs)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flightpath.exportDiscoveredModels",
      async () => {
        await exportDiscoveredModels();
      }
    )
  );

  // Dump all --vscode-* CSS variables from active theme to a JSON file
  context.subscriptions.push(
    vscode.commands.registerCommand("flightpath.dumpCssVars", async () => {
      await dumpVsCodeCssVariables(context);
    })
  );

  if (handlers.sendTestNotification) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "flightpath.dev.sendTestNotification",
        async () => {
          await handlers.sendTestNotification?.();
        }
      )
    );
  }

  // ── Dev menu (single palette-visible entry) ─────────────────────────────
  // Shows a QuickPick that dispatches to any of the individual dev commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("flightpath.devMenu", async () => {
      const items: Array<{
        label: string;
        description: string;
        command: string;
      }> = [
        {
          label: "$(beaker) Test Copilot Automation",
          description: "Feasibility test for chat automation (legacy POC)",
          command: "flightpath.test.copilotAutomation",
        },
        {
          label: "$(paperclip) Test File Attachment",
          description: "Test github.copilot.chat.attachFile command",
          command: "flightpath.test.fileAttachment",
        },
        {
          label: "$(symbol-enum) Test Chat Model Selection",
          description: "Test workbench.action.chat.changeModel",
          command: "flightpath.test.chatModelSelection",
        },
        {
          label: "$(hubot) Test Chat Agent Selection",
          description: "Test programmatic agent selection",
          command: "flightpath.test.chatAgentSelection",
        },
        {
          label: "$(list-filter) List Chat Commands",
          description:
            "Dump Copilot/chat commands → dev/reference/CHAT_COMMANDS.md",
          command: "flightpath.listChatCommands",
        },
        {
          label: "$(list-unordered) List All VS Code Commands",
          description: "Dump all commands → dev/reference/VSCODE_COMMANDS.md",
          command: "flightpath.listAllCommands",
        },
        {
          label: "$(symbol-text) Show Language ID",
          description: "Show language ID of the active editor document",
          command: "flightpath.showLanguageId",
        },
        {
          label: "$(export) Export Discovered Models",
          description:
            "Write discovered models to scripts/discovered-models.json",
          command: "flightpath.exportDiscoveredModels",
        },
        {
          label: "$(symbol-color) Dump CSS Variables",
          description:
            "Write all --vscode-* CSS vars → dev/reference/vscode-css-vars.json",
          command: "flightpath.dumpCssVars",
        },
        ...(handlers.sendTestNotification
          ? [
              {
                label: "$(bell) Send Test Notification",
                description:
                  "Trigger a browser/push + VS Code notification test event",
                command: "flightpath.dev.sendTestNotification",
              },
            ]
          : []),
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title: "FlightPath Developer Tools",
        placeHolder: "Select a dev tool to run…",
        matchOnDescription: true,
      });

      if (picked) {
        await vscode.commands.executeCommand(picked.command);
      }
    })
  );

  Log.info("🔧 FlightPath: Development commands registered");
}
