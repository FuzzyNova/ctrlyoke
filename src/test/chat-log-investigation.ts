/**
 * Investigation: Can we access GitHub Copilot Chat logs or export data?
 *
 * This test file explores different approaches to detect chat completion
 * without relying on tool callbacks and clipboard polling.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

/**
 * Approach 1: Try to call github.copilot.chat.debug.exportPromptLogsAsJson
 * This command exports chat logs as JSON, which we could parse for completion status
 */
export async function testExportPromptLogs(): Promise<void> {
  try {
    console.log(
      "🔍 Testing github.copilot.chat.debug.exportPromptLogsAsJson..."
    );

    // Try to execute the export command
    const result = await vscode.commands.executeCommand(
      "github.copilot.chat.debug.exportPromptLogsAsJson"
    );

    console.log("✅ Export command result:", result);
  } catch (error) {
    console.error("❌ Export command failed:", error);
  }
}

/**
 * Recursively find all files with a specific name in a directory
 */
async function findFilesRecursive(
  dir: string,
  filename: string,
  results: Array<{ path: string; mtime: Date; size: number }> = []
): Promise<Array<{ path: string; mtime: Date; size: number }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        await findFilesRecursive(fullPath, filename, results);
      } else if (entry.isFile() && entry.name === filename) {
        // Found a matching file - get its stats
        try {
          const stats = await fs.stat(fullPath);
          results.push({
            path: fullPath,
            mtime: stats.mtime,
            size: stats.size,
          });
        } catch {
          // Couldn't stat the file
        }
      }
    }
  } catch {
    // Directory not accessible, skip it
  }

  return results;
}

/**
 * Approach 2: Try to find and read GitHub Copilot Chat log files
 * FIXED: Recursively searches for all "GitHub Copilot Chat.log" files
 * and picks the most recently modified one
 */
export async function findCopilotChatLogs(): Promise<{
  logFiles: Array<{ path: string; mtime: Date; size: number }>;
  activeLog?: string;
  logContent?: string;
}> {
  const possibleLogLocations = [
    // Windows: AppData\Roaming\Code\logs
    path.join(os.homedir(), "AppData", "Roaming", "Code", "logs"),
    // macOS: ~/Library/Application Support/Code/logs
    path.join(os.homedir(), "Library", "Application Support", "Code", "logs"),
    // Linux: ~/.config/Code/logs
    path.join(os.homedir(), ".config", "Code", "logs"),
  ];

  let allLogFiles: Array<{ path: string; mtime: Date; size: number }> = [];
  let activeLog: string | undefined;
  let logContent: string | undefined;

  for (const logDir of possibleLogLocations) {
    try {
      const exists = await fs.stat(logDir).catch(() => null);
      if (!exists) continue;

      console.log(`📁 Recursively searching: ${logDir}`);

      // Recursively find ALL "GitHub Copilot Chat.log" files
      const foundLogs = await findFilesRecursive(
        logDir,
        "GitHub Copilot Chat.log"
      );

      allLogFiles.push(...foundLogs);
      console.log(`✅ Found ${foundLogs.length} log files in ${logDir}`);
    } catch (error) {
      console.error(`❌ Error checking ${logDir}:`, error);
    }
  }

  // Find the most recently modified log file
  if (allLogFiles.length > 0) {
    allLogFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    activeLog = allLogFiles[0].path;

    console.log(`\n📊 All found log files (sorted by modification time):`);
    allLogFiles.forEach((log, index) => {
      const marker = index === 0 ? "🔥 ACTIVE" : "  ";
      console.log(
        `${marker} ${log.path}\n     Modified: ${log.mtime.toISOString()}, Size: ${log.size} bytes`
      );
    });
  }

  // Read the active log content
  if (activeLog) {
    try {
      logContent = await fs.readFile(activeLog, "utf-8");
      console.log(
        `\n📖 Read active log: ${activeLog} (${logContent.length} characters)`
      );

      // Show last 10 lines as sample
      const lines = logContent.split("\n").filter((l) => l.trim());
      console.log(`\n📝 Last 10 lines of active log:`);
      lines.slice(-10).forEach((line) => console.log(`   ${line}`));
    } catch (error) {
      console.error(`❌ Failed to read log content:`, error);
    }
  }

  return { logFiles: allLogFiles, activeLog, logContent };
} /**
 * Approach 3: Use VS Code's ExtensionContext.logUri to access our own logs
 * We can't read other extensions' logs, but we can use our own log directory
 */
export async function getOwnLogDirectory(
  context: vscode.ExtensionContext
): Promise<string> {
  // VS Code provides a dedicated log directory for each extension
  const logUri = context.logUri;
  console.log(`📁 FlightPath log directory: ${logUri.fsPath}`);

  // Ensure directory exists
  try {
    await vscode.workspace.fs.createDirectory(logUri);
  } catch (error) {
    // Already exists
  }

  return logUri.fsPath;
}

/**
 * Approach 4: Monitor chat sessions using Chat Participant API
 * Check if we can register a chat participant to observe Copilot responses
 */
export async function investigateChatParticipantAPI(): Promise<void> {
  console.log("🔍 Investigating Chat Participant API...");

  // Check if vscode.chat API is available
  if (!vscode.chat) {
    console.log("❌ Chat API not available in this VS Code version");
    return;
  }

  console.log("✅ Chat API is available");

  // The Chat API allows extensions to register chat participants,
  // but it doesn't provide a way to intercept or monitor other participants' responses
  // This approach won't work for detecting Copilot completion
}

/**
 * Approach 5: Check available Copilot commands
 * See what diagnostic/debug commands are available
 */
export async function listCopilotCommands(): Promise<string[]> {
  const allCommands = await vscode.commands.getCommands();
  const copilotCommands = allCommands.filter(
    (cmd) => cmd.includes("copilot") || cmd.includes("github")
  );

  console.log(`📋 Found ${copilotCommands.length} Copilot-related commands`);
  copilotCommands.forEach((cmd) => console.log(`  - ${cmd}`));

  return copilotCommands;
}

/**
 * Test function to run all investigations
 */
export async function runAllInvestigations(
  context: vscode.ExtensionContext
): Promise<void> {
  console.log("🚀 Starting Copilot Chat log investigation...\n");

  // 1. List available commands
  console.log("\n=== Approach 1: Available Commands ===");
  await listCopilotCommands();

  // 2. Try export command
  console.log("\n=== Approach 2: Export Prompt Logs ===");
  await testExportPromptLogs();

  // 3. Find log files (IMPROVED - searches all windows)
  console.log("\n=== Approach 3: Find Log Files ===");
  const { logFiles, activeLog, logContent } = await findCopilotChatLogs();
  console.log(`Found ${logFiles.length} log files total`);
  if (activeLog) {
    console.log(`Active log (most recent): ${activeLog}`);
  }

  // 4. Check our own log directory
  console.log("\n=== Approach 4: Own Log Directory ===");
  const ourLogDir = await getOwnLogDirectory(context);
  console.log(`Our log directory: ${ourLogDir}`);

  // 5. Check Chat API
  console.log("\n=== Approach 5: Chat Participant API ===");
  await investigateChatParticipantAPI();

  // 6. ANALYZE LOG CONTENT for completion detection
  console.log("\n=== Approach 6: Analyze Log Content ===");
  if (logContent) {
    analyzeLogForCompletionPatterns(logContent);
  } else {
    console.log("❌ No log content available for analysis");
  }

  console.log("\n✅ Investigation complete!");
}

/**
 * Analyze log content to identify patterns for completion detection
 */
function analyzeLogForCompletionPatterns(logContent: string): void {
  console.log("🔍 Analyzing log patterns...");

  const lines = logContent.split("\n");
  console.log(`📊 Total log lines: ${lines.length}`);

  // Look for request/response patterns
  const requestLines = lines.filter((line) => line.includes("ccreq:"));
  const successLines = lines.filter((line) => line.includes("success"));
  const finishLines = lines.filter((line) => line.includes("finish reason:"));
  const completionLines = lines.filter((line) =>
    line.includes("request done:")
  );

  console.log(`📝 Pattern analysis:`);
  console.log(`  - Lines with 'ccreq:': ${requestLines.length}`);
  console.log(`  - Lines with 'success': ${successLines.length}`);
  console.log(`  - Lines with 'finish reason:': ${finishLines.length}`);
  console.log(`  - Lines with 'request done:': ${completionLines.length}`);

  // Show examples of completion markers
  if (finishLines.length > 0) {
    console.log(`\n✅ FOUND COMPLETION MARKER PATTERN:`);
    console.log(`   Example: ${finishLines[finishLines.length - 1]}`);
  }

  if (completionLines.length > 0) {
    console.log(`\n✅ FOUND REQUEST COMPLETION PATTERN:`);
    console.log(`   Example: ${completionLines[completionLines.length - 1]}`);
  }

  // Look for the latest activity timestamp
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    const timestampMatch = lastLine.match(
      /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/
    );
    if (timestampMatch) {
      console.log(`\n⏰ Latest activity: ${timestampMatch[1]}`);
    }
  }

  console.log(
    `\n💡 RECOMMENDATION: Monitor log file for 'finish reason: [stop]' or 'request done:' patterns`
  );
}
