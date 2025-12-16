import * as vscode from "vscode";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Log {
  private static outputChannel: vscode.OutputChannel;
  private static logLevel: LogLevel = LogLevel.INFO;

  static initialize(
    context: vscode.ExtensionContext,
    logLevel: LogLevel = LogLevel.INFO
  ): void {
    this.outputChannel = vscode.window.createOutputChannel("FlightPath");
    this.logLevel = logLevel;
    context.subscriptions.push(this.outputChannel);

    this.info("FlightPath logging initialized");
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
  }

  /**
   * Write directly to output channel without newline (without console.log or timestamp).
   * Use for streaming output that needs to preserve formatting.
   */
  static append(message: string): void {
    if (this.outputChannel) {
      this.outputChannel.append(message);
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

    // Write to output channel
    if (this.outputChannel) {
      this.outputChannel.appendLine(logEntry);
    }

    // Also log to console for development
    console.log(`FlightPath ${logEntry}`);
  }
}
