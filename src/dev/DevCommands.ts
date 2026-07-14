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
 * Entry point: a single `ctrlyoke.devMenu` command declared in package.json
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
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import { getVsCodeWorkspaceRoot } from "../platform/VsCodeWorkspaceRoot";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import { getErrorMessage } from "../utils/ErrorUtils";

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

    const fullPath = path.join(getVsCodeWorkspaceRoot(), outputFilePath);
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
      content: `ctrlyoke: ${title} (${filteredCommands.length} found)\n\n${filteredCommands.join("\n")}`,
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
 * 2. Run "ctrlyoke: Export Discovered Models" command
 * 3. Run: npm run sync-models -- --import
 */
async function exportDiscoveredModels(): Promise<void> {
  Log.info("📤 Exporting discovered models...");

  // Get models from registry
  const chatModels = getAvailableModelsSync();
  const cliModelIds = getCliSupportedModelIdsSync();

  if (chatModels.length === 0) {
    vscode.window.showWarningMessage(
      "No models discovered yet. Wait for extension to initialize or run 'ctrlyoke: Retry Copilot Detection'."
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
    getVsCodeWorkspaceRoot(),
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
      const terminal = vscode.window.createTerminal("ctrlyoke Sync");
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
 * Usage: run "ctrlyoke: Dump CSS Variables" from the command palette (dev only).
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
    "ctrlyoke.cssVarDump",
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
        getVsCodeWorkspaceRoot(),
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
// UX Snapshot Capture (dev only)
// ============================================================================

export interface UxSnapshotWriteResult {
  /** Workspace-relative path of the written markdown file (success). */
  path?: string;
  /** Error message (failure). */
  error?: string;
}

/**
 * Persist a captured UX snapshot to `.ctrlyoke/snapshots/`.
 *
 * Host-agnostic: the caller supplies `workspaceRoot` (VS Code workspace root
 * for the panel, the hosted server's `workspaceRoot` for a phone/browser
 * client) so this same write logic serves both transports. Lives in
 * DevCommands.ts so it is dead-code-eliminated from production builds.
 *
 * @param markdown Self-describing text dump (HTML + computed + matched rules).
 * @param png Reserved for a future visual companion — accepted but not written in v1.
 * @param workspaceRoot Absolute path of the workspace to write under.
 * @returns The workspace-relative file path on success, or an error message.
 */
export async function writeUxSnapshot(
  markdown: string,
  png: string | undefined,
  workspaceRoot: string
): Promise<UxSnapshotWriteResult> {
  // png is intentionally unused in v1 — the visual companion is a deferred
  // follow-up. Referencing it here keeps the signature stable for that work.
  void png;

  if (!workspaceRoot) {
    return { error: "No workspace is open to save the snapshot into." };
  }
  if (typeof markdown !== "string" || markdown.length === 0) {
    return { error: "Snapshot was empty; nothing to save." };
  }

  try {
    const snapshotsDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.SNAPSHOTS_DIR
    );
    await fs.promises.mkdir(snapshotsDir, { recursive: true });

    const fileName = `ux-snapshot-${Date.now()}.md`;
    const fullPath = path.join(snapshotsDir, fileName);
    await fs.promises.writeFile(fullPath, markdown, "utf8");

    const relativePath = path
      .relative(workspaceRoot, fullPath)
      .split(path.sep)
      .join("/");
    Log.info(`📸 ctrlyoke: Wrote UX snapshot to ${fullPath}`);
    return { path: relativePath };
  } catch (error) {
    const message = getErrorMessage(error);
    Log.error("❌ Failed to write UX snapshot:", message);
    return { error: message };
  }
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
  Log.info("🔧 ctrlyoke: Registering development commands...");

  // Set context key so the devMenu command is visible in the command palette
  vscode.commands.executeCommand("setContext", "ctrlyoke.devMode", true);

  // ── Individual dev commands ──────────────────────────────────────────────
  // These are registered programmatically (no package.json entries required).
  // They are accessible via the devMenu QuickPick or executeCommand in tests.

  // List all available VS Code commands (debugging tool)
  context.subscriptions.push(
    vscode.commands.registerCommand("ctrlyoke.listAllCommands", async () => {
      await listAndDisplayCommands(
        "All Available VS Code Commands",
        undefined,
        "dev/reference/VSCODE_COMMANDS.md"
      );
    })
  );

  // Debug: Show current document language ID
  context.subscriptions.push(
    vscode.commands.registerCommand("ctrlyoke.showLanguageId", () => {
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
      "ctrlyoke.exportDiscoveredModels",
      async () => {
        await exportDiscoveredModels();
      }
    )
  );

  // Dump all --vscode-* CSS variables from active theme to a JSON file
  context.subscriptions.push(
    vscode.commands.registerCommand("ctrlyoke.dumpCssVars", async () => {
      await dumpVsCodeCssVariables(context);
    })
  );

  if (handlers.sendTestNotification) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "ctrlyoke.dev.sendTestNotification",
        async () => {
          await handlers.sendTestNotification?.();
        }
      )
    );
  }

  // ── Dev menu (single palette-visible entry) ─────────────────────────────
  // Shows a QuickPick that dispatches to any of the individual dev commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("ctrlyoke.devMenu", async () => {
      const items: Array<{
        label: string;
        description: string;
        command: string;
      }> = [
        {
          label: "$(list-unordered) List All VS Code Commands",
          description: "Dump all commands → dev/reference/VSCODE_COMMANDS.md",
          command: "ctrlyoke.listAllCommands",
        },
        {
          label: "$(symbol-text) Show Language ID",
          description: "Show language ID of the active editor document",
          command: "ctrlyoke.showLanguageId",
        },
        {
          label: "$(export) Export Discovered Models",
          description:
            "Write discovered models to scripts/discovered-models.json",
          command: "ctrlyoke.exportDiscoveredModels",
        },
        {
          label: "$(symbol-color) Dump CSS Variables",
          description:
            "Write all --vscode-* CSS vars → dev/reference/vscode-css-vars.json",
          command: "ctrlyoke.dumpCssVars",
        },
        ...(handlers.sendTestNotification
          ? [
              {
                label: "$(bell) Send Test Notification",
                description:
                  "Trigger a browser/push + VS Code notification test event",
                command: "ctrlyoke.dev.sendTestNotification",
              },
            ]
          : []),
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title: "ctrlyoke Developer Tools",
        placeHolder: "Select a dev tool to run…",
        matchOnDescription: true,
      });

      if (picked) {
        await vscode.commands.executeCommand(picked.command);
      }
    })
  );

  Log.info("🔧 ctrlyoke: Development commands registered");
}
