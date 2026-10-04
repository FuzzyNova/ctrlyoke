import * as fs from "fs";
import * as path from "path";
import { IS_DEV_MODE } from "./BuildConfig";
import { ConfigurationUtils, PATH_CONSTANTS } from "./ConfigurationUtils";
import { getErrorMessage } from "./ErrorUtils";
import { secretRedactionService } from "./SecretRedactionService";

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

/**
 * Display label for each {@link LogLevel}, used for the on-disk/CLI log
 * prefix. `writeLog()` itself dispatches on the `LogLevel` enum value, not
 * the label — this is only looked up when a message is actually rendered.
 */
const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.TRACE]: "TRACE",
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.OFF]: "OFF",
};

/**
 * Host destination for log lines, such as the VS Code extension's output
 * channel (`src/platform/VsCodeLogOutputChannel.ts`). Implementations must
 * never throw: logging runs inside cleanup paths that a throw would abort.
 */
export interface LogOutputSink {
  /** Write a message at `level`; the sink adds its own timestamp/level. */
  write(level: LogLevel, message: string): void;
  /** Write a pre-formatted line verbatim. */
  appendLine(message: string): void;
  dispose(): void;
}

/** Host-supplied settings for {@link Log.initialize}. */
export interface LogInitializeOptions {
  readonly outputSink: LogOutputSink;
  /**
   * Resolved workspace root (where `.ctrlyoke` lives), or `undefined` when no
   * folder is open.
   */
  readonly workspaceRoot?: string;
  /** Initial level for production builds; dev builds always use TRACE. */
  readonly logLevel: LogLevel;
}

/**
 * Host-neutral logger. This module must stay free of `vscode` imports: it is
 * loaded by the standalone CLI, which runs in plain Node. Each host pushes its
 * output sink and level/setting changes in from its composition root.
 */
export class Log {
  private static outputSink: LogOutputSink | undefined;
  private static logLevel: LogLevel = LogLevel.INFO;
  private static logFilePath: string | undefined;
  /** True when running as the standalone CLI binary (not VS Code extension). */
  private static cliMode = false;
  /** Log file path used in CLI mode. */
  private static cliLogFilePath: string | undefined;
  /** Cached workspace root for flag file management (VS Code mode only). */
  private static workspaceRoot: string | undefined;

  /**
   * Initialize host logging. In dev builds, automatically uses TRACE level and
   * writes log files unconditionally. In production builds, uses the
   * host-supplied level and only writes log files when
   * `diagnostics.verboseLogging` is true. The CLI uses {@link initializeCli}
   * instead.
   */
  static initialize(options: LogInitializeOptions): void {
    this.outputSink?.dispose();
    this.outputSink = options.outputSink;
    this.workspaceRoot = options.workspaceRoot;

    if (IS_DEV_MODE) {
      // Dev builds: show everything including trace logs.
      this.logLevel = LogLevel.TRACE;
      this.openLogFile();
    } else {
      this.logLevel = options.logLevel;
      if (ConfigurationUtils.isDiagnosticLogsEnabled()) {
        this.openLogFile();
      }
    }

    this.info("ctrlyoke logging initialized");
  }

  /** Apply a host log-level change (e.g. "Developer: Set Log Level..."). */
  static setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Start or stop the workspace log file after `diagnostics.verboseLogging`
   * changes at runtime.
   */
  static setDiagnosticFileLogging(enabled: boolean): void {
    if (enabled && !this.logFilePath) {
      this.openLogFile();
    } else if (!enabled) {
      this.logFilePath = undefined;
    }
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
   * @param existingLogFilePath - Reuse an already-open workspace log file when
   *   a worker needs to write into the extension host's log.
   */
  static initializeCli(
    workspaceDir: string,
    verbose = false,
    existingLogFilePath?: string
  ): void {
    this.cliMode = true;
    this.logLevel = verbose ? LogLevel.DEBUG : LogLevel.INFO;

    if (existingLogFilePath) {
      this.cliLogFilePath = existingLogFilePath;
      return;
    }

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

  /** Return the active workspace log path for worker-side log forwarding. */
  static getLogFilePath(): string | undefined {
    return this.logFilePath;
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
   * Close the output sink. Called last in the extension's `deactivate()`,
   * after every other shutdown step has had its chance to log. Later calls to
   * the logging methods still reach the log file; only the sink is gone.
   */
  static dispose(): void {
    this.outputSink?.dispose();
    this.outputSink = undefined;
  }

  static trace(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.TRACE) {
      this.writeLog(LogLevel.TRACE, message, ...args);
    }
  }

  static debug(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.DEBUG) {
      this.writeLog(LogLevel.DEBUG, message, ...args);
    }
  }

  static info(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.INFO) {
      this.writeLog(LogLevel.INFO, message, ...args);
    }
  }

  static warn(message: string, ...args: any[]): void {
    if (this.logLevel <= LogLevel.WARN) {
      this.writeLog(LogLevel.WARN, message, ...args);
    }
  }

  static error(message: string, error?: any, ...args: any[]): void {
    if (this.logLevel <= LogLevel.ERROR) {
      if (error) {
        this.writeLog(
          LogLevel.ERROR,
          `${message}: ${getErrorMessage(error)}`,
          ...args
        );
        if (error instanceof Error && error.stack) {
          this.writeLog(LogLevel.ERROR, `Stack trace: ${error.stack}`);
        }
      } else {
        this.writeLog(LogLevel.ERROR, message, ...args);
      }
    }
  }

  /**
   * Write directly to output channel (without console.log or timestamp).
   * Use for formatted output like logPrompt/logResponse that need custom formatting.
   */
  static appendLine(message: string): void {
    message = secretRedactionService.redactText(message);
    this.outputSink?.appendLine(message);
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, message + "\n");
      } catch {
        // Ignore file write errors
      }
    }
  }

  private static writeLog(
    level: LogLevel,
    message: string,
    ...args: any[]
  ): void {
    const timestamp = new Date().toISOString();
    const formattedMessage = secretRedactionService.redactText(
      args.length > 0 ? `${message} ${JSON.stringify(args)}` : message
    );
    // Manual timestamp/level prefix — only needed where VS Code's
    // LogOutputChannel isn't doing that decoration itself (file/CLI output).
    const logEntry = `[${timestamp}] ${LOG_LEVEL_LABELS[level]}: ${formattedMessage}`;

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

    // Host sink: pass the unprefixed message and level. The VS Code channel
    // decorates lines itself; adding our prefix too is what produced the
    // double timestamp/level lines in the Output panel.
    this.outputSink?.write(level, formattedMessage);

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
