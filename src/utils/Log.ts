import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { IS_DEV_MODE } from "./BuildConfig";
import { ConfigurationUtils, PATH_CONSTANTS } from "./ConfigurationUtils";
import { getErrorMessage } from "./ErrorUtils";

/**
 * Log levels in order from most verbose (TRACE) to least verbose (ERROR), plus OFF.
 * Matches VS Code's LogLevel ordering: Off, Error, Warning, Info, Debug, Trace.
 *
 * A configured level of X shows all messages at level X and above (less verbose).
 * e.g. LogLevel.INFO shows INFO, WARN, and ERROR — but not DEBUG or TRACE.
 */
export enum LogLevel {
  TRACE = 0, // Most verbose — show all messages
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  OFF = 5, // No logging
}

/** Max age for log files before cleanup removes them (7 days). */
const LOG_CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class Log {
  private static outputChannel: vscode.OutputChannel;
  private static logLevel: LogLevel = LogLevel.INFO;
  private static logFilePath: string | undefined;
  /** True when running as the standalone CLI binary (not VS Code extension). */
  private static cliMode = false;
  /** Log file path used in CLI mode. */
  private static cliLogFilePath: string | undefined;
  /** Cached workspace root for flag file management (VS Code mode only). */
  private static workspaceRoot: string | undefined;

  /**
   * Initialize logging. In dev builds, automatically uses TRACE level and writes
   * log files unconditionally. In production builds, reads from VS Code's log level
   * setting and only writes log files when `ctrlyoke.enableDiagnosticLogs` is true.
   *
   * @param workspaceRoot Resolved workspace root (where `.ctrlyoke` lives), or
   *   `undefined` when no folder is open. Passed in by the extension entry point
   *   so this shared module never depends on the VS Code workspace-resolution
   *   layer; the CLI uses {@link initializeCli} instead.
   */
  static initialize(
    context: vscode.ExtensionContext,
    workspaceRoot?: string
  ): void {
    this.outputChannel = vscode.window.createOutputChannel("ctrlyoke");
    context.subscriptions.push(this.outputChannel);

    this.workspaceRoot = workspaceRoot;

    if (IS_DEV_MODE) {
      // Dev builds: show everything including trace logs.
      this.logLevel = LogLevel.TRACE;
      this.openLogFile();
    } else {
      // Production: respect VS Code's log level setting
      this.logLevel = Log.fromVSCodeLogLevel(vscode.env.logLevel);
      context.subscriptions.push(
        vscode.env.onDidChangeLogLevel((level) => {
          Log.logLevel = Log.fromVSCodeLogLevel(level);
        })
      );

      // Enable/disable file logging based on diagnostic setting.
      const diagnosticLogsEnabled =
        ConfigurationUtils.isDiagnosticLogsEnabled();
      if (diagnosticLogsEnabled) {
        this.openLogFile();
      }

      // React to setting changes at runtime
      context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration("ctrlyoke.enableDiagnosticLogs")) {
            const enabled = ConfigurationUtils.isDiagnosticLogsEnabled();
            if (enabled && !this.logFilePath) {
              this.openLogFile();
            } else if (!enabled) {
              this.logFilePath = undefined;
            }
          }
        })
      );
    }

    this.info("ctrlyoke logging initialized");
  }

  /**
   * Initialize logging for the standalone CLI binary.
   *
   * Must be called early in `runCommand()` before any Log.* calls.
   * Redirects all log output to `.ctrlyoke/logs/ctrlyoke-cli-<timestamp>.log`
   * and suppresses console output so the terminal stays clean for prompt output.
   *
   * @param workspaceDir - Working directory (parent of .ctrlyoke/).
   * @param verbose      - When true, enables DEBUG level; otherwise INFO.
   */
  static initializeCli(workspaceDir: string, verbose = false): void {
    this.cliMode = true;
    this.logLevel = verbose ? LogLevel.DEBUG : LogLevel.INFO;

    const logDir = path.join(
      workspaceDir,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.LOGS_DIR
    );
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.cliLogFilePath = path.join(logDir, `ctrlyoke-cli-${Date.now()}.log`);
      fs.writeFileSync(this.cliLogFilePath, ""); // create / truncate
      this.cleanupOldLogs(logDir);
    } catch {
      // Proceed without file logging if directory creation fails
      this.cliLogFilePath = undefined;
    }
  }

  /**
   * Open a new timestamped log file in .ctrlyoke/logs/.
   * Called on initialization (dev always, prod when diagnostic logging enabled).
   *
   * Bails out silently when .ctrlyoke/ does not yet exist so that file
   * logging never creates the directory scaffold for untrusted workspaces
   * (which would bypass the workspace trust gate).
   */
  private static openLogFile(): void {
    if (!this.workspaceRoot) {
      return;
    }
    const fpDir = path.join(this.workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    // Only write logs if the workspace has already been initialized.
    // Creating .ctrlyoke/logs/ with { recursive: true } would implicitly
    // create .ctrlyoke/ itself, bypassing the workspace trust check.
    if (!fs.existsSync(fpDir)) {
      return;
    }
    const logDir = path.join(fpDir, PATH_CONSTANTS.LOGS_DIR);
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.logFilePath = path.join(logDir, `ctrlyoke-${Date.now()}.log`);
      fs.writeFileSync(this.logFilePath, ""); // truncate on each session start
      this.cleanupOldLogs(logDir);
    } catch {
      this.logFilePath = undefined;
    }
  }

  /**
   * Start writing log output to a file now that the workspace has been
   * initialized (i.e. trust has just been granted and .ctrlyoke/ exists).
   *
   * Called by WorkflowOrchestrator.handleInitializeWorkspace() immediately after
   * WorkspaceInitializer.initializeIfNeeded() creates the directory scaffold.
   * No-op if file logging is already active or diagnostic logs are disabled.
   */
  static enableWorkspaceFileLogging(): void {
    if (this.logFilePath) {
      return; // already logging
    }
    this.openLogFile();
  }

  /**
   * Delete log files older than LOG_CLEANUP_MAX_AGE_MS in the given directory.
   * Best-effort: silently ignores failures.
   */
  private static cleanupOldLogs(logDir: string): void {
    try {
      const files = fs.readdirSync(logDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith("ctrlyoke-") || !file.endsWith(".log")) {
          continue;
        }
        // Skip the single-file hook debug logs — hooks manage those themselves
        if (file.includes("-debug.log")) {
          continue;
        }
        const filePath = path.join(logDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > LOG_CLEANUP_MAX_AGE_MS) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // Ignore per-file errors
        }
      }
    } catch {
      // Ignore cleanup errors entirely
    }
  }

  /**
   * Map VS Code's LogLevel enum to our internal LogLevel.
   * VS Code log levels (ordered least to most verbose): Off, Error, Warning, Info, Debug, Trace.
   */
  private static fromVSCodeLogLevel(vsCodeLevel: vscode.LogLevel): LogLevel {
    switch (vsCodeLevel) {
      case vscode.LogLevel.Off:
        return LogLevel.OFF;
      case vscode.LogLevel.Trace:
        return LogLevel.TRACE;
      case vscode.LogLevel.Debug:
        return LogLevel.DEBUG;
      case vscode.LogLevel.Info:
        return LogLevel.INFO;
      case vscode.LogLevel.Warning:
        return LogLevel.WARN;
      case vscode.LogLevel.Error:
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }

  /**
   * Get the output channel instance.
   * Used by components that need direct access to the output channel.
   */
  static getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      throw new Error(
        "Log.initialize() must be called before accessing output channel"
      );
    }
    return this.outputChannel;
  }

  static trace(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.TRACE) {
      this.writeLog("TRACE", message, ...args);
    }
  }

  static debug(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.DEBUG) {
      this.writeLog("DEBUG", message, ...args);
    }
  }

  static info(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.INFO) {
      this.writeLog("INFO", message, ...args);
    }
  }

  static warn(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.WARN) {
      this.writeLog("WARN", message, ...args);
    }
  }

  static error(message: string, error?: any, ...args: any[]): void {
    if (this.logLevel <= LogLevel.ERROR) {
      if (error) {
        this.writeLog(
          "ERROR",
          `${message}: ${getErrorMessage(error)}`,
          ...args
        );
        if (error instanceof Error && error.stack) {
          this.writeLog("ERROR", `Stack trace: ${error.stack}`);
        }
      } else {
        this.writeLog("ERROR", message, ...args);
      }
    }
  }

  /**
   * Write directly to output channel (without console.log or timestamp).
   * Use for formatted output like logPrompt/logResponse that need custom formatting.
   */
  static appendLine(message: string): void {
    if (this.outputChannel) {
      this.outputChannel.appendLine(message);
    }
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, message + "\n");
      } catch {
        // Ignore file write errors
      }
    }
  }

  private static writeLog(
    level: string,
    message: string,
    ...args: any[]
  ): void {
    const timestamp = new Date().toISOString();
    const formattedMessage =
      args.length > 0 ? `${message} ${JSON.stringify(args)}` : message;
    const logEntry = `[${timestamp}] ${level}: ${formattedMessage}`;

    if (this.cliMode) {
      // CLI binary: write only to the log file — never pollute stdout/stderr.
      if (this.cliLogFilePath) {
        try {
          fs.appendFileSync(this.cliLogFilePath, logEntry + "\n");
        } catch {
          // Ignore file write errors silently in CLI mode
        }
      }
      return;
    }

    // VS Code extension mode: write to output channel and console.
    if (this.outputChannel) {
      this.outputChannel.appendLine(logEntry);
    }

    if (IS_DEV_MODE) {
      // Also log to console for development
      console.log(`ctrlyoke ${logEntry}`);
    }

    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, logEntry + "\n");
      } catch {
        // Ignore file write errors
      }
    }
  }
}
