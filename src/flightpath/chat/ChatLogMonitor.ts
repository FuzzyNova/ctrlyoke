import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Result of waiting for log completion
 */
export interface LogCompletionResult {
  completed: boolean;
  userCancelled: boolean;
  failureReason?: string;
}

/**
 * Monitors Copilot Chat log file for response completion.
 * See flightpath-chat.instructions.md for detection strategy details.
 */
export class ChatLogMonitor {
  private logFilePath: string | undefined;
  private lastReadPosition: number = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Discover and initialize log file path. Returns true if found. */
  async initialize(): Promise<boolean> {
    this.logFilePath = await this.findCopilotLogFile();

    if (this.logFilePath) {
      console.log(`📄 Log: ${this.logFilePath}`);
      try {
        const stats = await fs.promises.stat(this.logFilePath);
        this.lastReadPosition = stats.size;
        return true;
      } catch (error) {
        console.warn("⚠️ Log file stat failed:", error);
      }
    } else {
      console.warn("⚠️ Log file not found - completion detection may fail");
    }
    return false;
  }

  /** Get the discovered log file path */
  getLogFilePath(): string | undefined {
    return this.logFilePath;
  }

  /** Record current log position before sending a prompt */
  async recordPositionBeforeSend(): Promise<void> {
    if (this.logFilePath) {
      try {
        const stats = await fs.promises.stat(this.logFilePath);
        this.lastReadPosition = stats.size;
      } catch (error) {
        console.warn("⚠️ Could not read log position:", error);
      }
    }
  }

  /** Wait for "finish reason: [stop]" in log */
  async waitForCompletion(
    isCancelledFn: () => boolean,
    inactivityTimeoutMs: number = 300000
  ): Promise<LogCompletionResult> {
    if (!this.logFilePath) {
      // Fallback: Try to find log file now
      this.logFilePath = await this.findCopilotLogFile();
      if (!this.logFilePath) {
        console.warn("⚠️ No log file available");
        return {
          completed: false,
          userCancelled: false,
          failureReason: "No log file available for completion detection",
        };
      }
    }

    const pollInterval = 500;
    let lastActivityTime = Date.now();
    let pollCount = 0;

    while (true) {
      pollCount++;

      if (isCancelledFn()) {
        console.log("⚠️ Cancelled");
        return {
          completed: false,
          userCancelled: false,
          failureReason: "Workflow was cancelled",
        };
      }

      const timeSinceLastActivity = Date.now() - lastActivityTime;
      if (timeSinceLastActivity > inactivityTimeoutMs) {
        const timeoutSeconds = Math.round(timeSinceLastActivity / 1000);
        console.warn(`⚠️ Inactivity timeout: ${timeoutSeconds}s`);
        return {
          completed: false,
          userCancelled: false,
          failureReason: `Copilot stopped responding (inactivity timeout after ${timeoutSeconds}s)`,
        };
      }

      // Log progress every 10 seconds
      if (pollCount % 20 === 0) {
        const inactivitySeconds = Math.round(timeSinceLastActivity / 1000);
        console.log(
          `⏳ Monitoring... (${inactivitySeconds}s since activity, poll #${pollCount})`
        );
      }

      try {
        const stats = await fs.promises.stat(this.logFilePath);
        const currentSize = stats.size;

        if (currentSize > this.lastReadPosition) {
          const newContent = await this.readLogContent(
            this.logFilePath,
            this.lastReadPosition,
            currentSize
          );

          this.lastReadPosition = currentSize;
          lastActivityTime = Date.now();

          if (newContent.includes("| cancelled |")) {
            console.warn("⚠️ User cancelled in chat UI");
            return { completed: false, userCancelled: true };
          }

          if (newContent.includes("finish reason: [stop]")) {
            return { completed: true, userCancelled: false };
          }
        }
      } catch (error) {
        console.warn("⚠️ Error reading log:", error);
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /** Get platform-specific VS Code logs directory */
  private getLogBaseDirectory(): string {
    const home = os.homedir();

    if (process.platform === "win32") {
      return path.join(process.env.APPDATA!, "Code", "logs");
    } else if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Code", "logs");
    } else {
      return path.join(home, ".config", "Code", "logs");
    }
  }

  /** Recursively find files matching filename */
  private async findFilesRecursive(
    dir: string,
    filename: string
  ): Promise<Array<{ path: string; mtime: Date }>> {
    const results: Array<{ path: string; mtime: Date }> = [];

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subResults = await this.findFilesRecursive(fullPath, filename);
          results.push(...subResults);
        } else if (entry.name === filename) {
          const stats = await fs.promises.stat(fullPath);
          results.push({ path: fullPath, mtime: stats.mtime });
        }
      }
    } catch {
      // Ignore permission errors
    }

    return results;
  }

  /** Find Copilot Chat log file (derived from logUri, fallback to search) */
  private async findCopilotLogFile(): Promise<string | undefined> {
    const targetFilename = "GitHub Copilot Chat.log";

    const derivedPath = await this.deriveCopilotLogFromLogUri();
    if (derivedPath) {
      console.log(`📄 Log via logUri: ${derivedPath}`);
      return derivedPath;
    }

    console.log("⚠️ logUri derivation failed, searching...");
    const logBaseDir = this.getLogBaseDirectory();
    const allLogs = await this.findFilesRecursive(logBaseDir, targetFilename);

    if (allLogs.length === 0) {
      return undefined;
    }

    allLogs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return allLogs[0].path;
  }

  /** Derive Copilot log path from extension's logUri */
  private async deriveCopilotLogFromLogUri(): Promise<string | undefined> {
    try {
      const extensionLogPath = this.context.logUri.fsPath;
      const exthostDir = path.dirname(extensionLogPath);
      const copilotLogDir = path.join(exthostDir, "GitHub.copilot-chat");
      const copilotLogPath = path.join(
        copilotLogDir,
        "GitHub Copilot Chat.log"
      );

      try {
        await fs.promises.access(copilotLogPath, fs.constants.R_OK);
        return copilotLogPath;
      } catch {
        console.log(`📄 Log not at: ${copilotLogPath}`);
        return undefined;
      }
    } catch (error) {
      console.error("Error deriving log path:", error);
      return undefined;
    }
  }

  /** Read log content between positions */
  private async readLogContent(
    filePath: string,
    startPos: number,
    endPos: number
  ): Promise<string> {
    const fileHandle = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(endPos - startPos);
      await fileHandle.read(buffer, 0, buffer.length, startPos);
      return buffer.toString("utf8");
    } finally {
      await fileHandle.close();
    }
  }
}
