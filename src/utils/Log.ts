import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { IS_DEV_MODE } from "./BuildConfig";

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

export class Log {
  private static outputChannel: vscode.OutputChannel;
  private static logLevel: LogLevel = LogLevel.INFO;
  private static logFilePath: string | undefined;
  /** True when running as the standalone CLI binary (not VS Code extension). */
  private static cliMode = false;
  /** Log file path used in CLI mode. */
  private static cliLogFilePath: string | undefined;

  /**
   * Initialize logging. In dev builds, automatically uses TRACE level.
   * In production builds, reads from VS Code's log level setting and listens for changes.
   * The logLevel parameter is ignored in VS Code context (use vscode.env.logLevel instead).
   */
  static initialize(
    context: vscode.ExtensionContext,
    _logLevel?: LogLevel
  ): void {
    this.outputChannel = vscode.window.createOutputChannel("FlightPath");
    context.subscriptions.push(this.outputChannel);

    if (IS_DEV_MODE) {
      // Dev builds: show everything including trace logs
      this.logLevel = LogLevel.TRACE;

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        const logDir = path.join(workspaceRoot, ".flightpath", "logs");
        fs.mkdirSync(logDir, { recursive: true });
        this.logFilePath = path.join(logDir, `flightpath-${Date.now()}.log`);
        fs.writeFileSync(this.logFilePath, ""); // truncate on each session start
      }
    } else {
      // Production: respect VS Code's log level setting
      this.logLevel = Log.fromVSCodeLogLevel(vscode.env.logLevel);
      context.subscriptions.push(
        vscode.env.onDidChangeLogLevel((level) => {
          Log.logLevel = Log.fromVSCodeLogLevel(level);
        })
      );
    }

    this.info("FlightPath logging initialized");
  }

  /**
   * Initialize logging for the standalone CLI binary.
   *
   * Must be called early in `runCommand()` before any Log.* calls.
   * Redirects all log output to `.flightpath/logs/flightpath-<timestamp>.log`
   * and suppresses console output so the terminal stays clean for prompt output.
   *
   * @param workspaceDir - Working directory (parent of .flightpath/).
   * @param verbose      - When true, enables DEBUG level; otherwise INFO.
   */
  static initializeCli(workspaceDir: string, verbose = false): void {
    this.cliMode = true;
    this.logLevel = verbose ? LogLevel.DEBUG : LogLevel.INFO;

    const logDir = path.join(workspaceDir, ".flightpath", "logs");
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.cliLogFilePath = path.join(logDir, `flightpath-${Date.now()}.log`);
      fs.writeFileSync(this.cliLogFilePath, ""); // create / truncate
    } catch {
      // Proceed without file logging if directory creation fails
      this.cliLogFilePath = undefined;
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
          `${message}: ${error instanceof Error ? error.message : String(error)}`,
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

  static show(): void {
    if (this.outputChannel) {
      this.outputChannel.show();
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
    if (IS_DEV_MODE && this.logFilePath) {
      fs.appendFileSync(this.logFilePath, message + "\n");
    }
  }

  /**
   * Write directly to output channel without newline (without console.log or timestamp).
   * Use for streaming output that needs to preserve formatting.
   */
  static append(message: string): void {
    if (this.outputChannel) {
      this.outputChannel.append(message);
    }
    if (IS_DEV_MODE && this.logFilePath) {
      fs.appendFileSync(this.logFilePath, message);
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
      console.log(`FlightPath ${logEntry}`);

      if (this.logFilePath) {
        fs.appendFileSync(this.logFilePath, logEntry + "\n");
      }
    }
  }
}
