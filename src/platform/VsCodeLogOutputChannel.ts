import * as vscode from "vscode";
import { configService } from "../config/CtrlYokeConfigService";
import { IS_DEV_MODE } from "../utils/BuildConfig";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log, LogLevel, type LogOutputSink } from "../utils/Log";

/**
 * Wraps the extension's {@link vscode.LogOutputChannel} so that writing to it
 * can never throw.
 *
 * VS Code's shutdown sequence makes that guarantee necessary: it calls the
 * extension's `deactivate()`, disposes `context.subscriptions` *without*
 * awaiting the returned promise, and only then awaits it. Anything that logs
 * from a subscription's `dispose()` or from after `deactivate()`'s first
 * `await` can therefore reach a channel VS Code has already closed, and a
 * closed channel throws `Channel has been closed` from every write — which
 * escapes into, and aborts, whatever cleanup was doing the logging.
 *
 * The first write that fails marks the channel closed; from then on writes are
 * dropped and the file log (written separately by {@link Log}) carries on.
 */
export class SafeLogOutputChannel implements LogOutputSink, vscode.Disposable {
  private channel: vscode.LogOutputChannel | undefined;

  constructor(channel: vscode.LogOutputChannel) {
    this.channel = channel;
  }

  /** The underlying channel, or `undefined` once it is closed. */
  get raw(): vscode.LogOutputChannel | undefined {
    return this.channel;
  }

  /**
   * Write `message` through the channel's method for `level`. Using the
   * level-specific methods rather than appendLine() matters: appendLine()
   * always renders as "[info]" in the Output panel.
   */
  write(level: LogLevel, message: string): void {
    this.use((channel) => {
      switch (level) {
        case LogLevel.TRACE:
          channel.trace(message);
          break;
        case LogLevel.DEBUG:
          channel.debug(message);
          break;
        case LogLevel.WARN:
          channel.warn(message);
          break;
        case LogLevel.ERROR:
          channel.error(message);
          break;
        default:
          channel.info(message);
          break;
      }
    });
  }

  appendLine(message: string): void {
    this.use((channel) => channel.appendLine(message));
  }

  dispose(): void {
    this.use((channel) => channel.dispose());
    this.channel = undefined;
  }

  private use(action: (channel: vscode.LogOutputChannel) => void): void {
    if (!this.channel) {
      return;
    }
    try {
      action(this.channel);
    } catch {
      // Closed underneath us (see class doc) — stop writing to it.
      this.channel = undefined;
    }
  }
}

/**
 * Map VS Code's LogLevel enum to our internal LogLevel.
 * VS Code log levels (ordered least to most verbose): Off, Error, Warning, Info, Debug, Trace.
 */
export function fromVsCodeLogLevel(vsCodeLevel: vscode.LogLevel): LogLevel {
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

let outputChannel: SafeLogOutputChannel | undefined;

/**
 * Create the "ctrlyoke" output channel and initialize {@link Log} with it.
 * Production builds follow the channel's effective log level and the
 * `diagnostics.verboseLogging` setting at runtime.
 *
 * @param workspaceRoot Resolved workspace root (where `.ctrlyoke` lives), or
 *   `undefined` when no folder is open.
 */
export function initializeVsCodeLogging(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined
): void {
  // { log: true } registers this as a LogOutputChannel, which is what makes
  // "ctrlyoke" appear as its own entry in "Developer: Set Log Level..." —
  // a plain createOutputChannel() never shows up there.
  //
  // Deliberately NOT pushed onto context.subscriptions: VS Code disposes
  // those before an async deactivate() finishes, and the extension keeps
  // logging until it does. extension.ts's deactivate() calls Log.dispose()
  // as its very last step instead.
  const channel = vscode.window.createOutputChannel("ctrlyoke", {
    log: true,
  });
  outputChannel = new SafeLogOutputChannel(channel);

  // The channel's effective level is the per-extension override (set via
  // "Developer: Set Log Level..." > ctrlyoke) when present, falling back to
  // the global default — vscode.env.logLevel only ever reflects the global
  // default and would ignore a ctrlyoke-specific override.
  Log.initialize({
    outputSink: outputChannel,
    workspaceRoot,
    logLevel: fromVsCodeLogLevel(channel.logLevel),
  });

  if (IS_DEV_MODE) {
    return;
  }

  context.subscriptions.push(
    channel.onDidChangeLogLevel((level) => {
      Log.setLogLevel(fromVsCodeLogLevel(level));
    })
  );

  // `diagnostics.verboseLogging` lives in .ctrlyoke/settings.json, so follow
  // configService rather than VS Code's own configuration events.
  let diagnosticLogsEnabled = ConfigurationUtils.isDiagnosticLogsEnabled();
  const unsubscribe = configService.subscribe(() => {
    const enabled = ConfigurationUtils.isDiagnosticLogsEnabled();
    if (enabled !== diagnosticLogsEnabled) {
      diagnosticLogsEnabled = enabled;
      Log.setDiagnosticFileLogging(enabled);
    }
  });
  context.subscriptions.push({ dispose: unsubscribe });
}

/** Reveal the "ctrlyoke" output channel, if it is still open. */
export function showLogOutputChannel(): void {
  outputChannel?.raw?.show();
}
