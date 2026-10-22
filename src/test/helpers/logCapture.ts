import { Log, LogLevel, type LogOutputSink } from "../../utils/Log";

export interface CapturedLogLine {
  readonly level: LogLevel;
  readonly message: string;
}

class RecordingLogSink implements LogOutputSink {
  readonly lines: CapturedLogLine[] = [];
  write(level: LogLevel, message: string): void {
    this.lines.push({ level, message });
  }
  appendLine(message: string): void {
    this.lines.push({ level: LogLevel.INFO, message });
  }
  dispose(): void {}
}

/**
 * Route `Log` output to an in-memory list at TRACE level. `Log` is a
 * process-wide static, so call `restore()` in `teardown` to put the real sink,
 * level and mode back for the rest of the shard. CLI mode is switched off
 * while capturing: an earlier test in the shard may have left it on, and CLI
 * mode writes only to its log file, never to the sink.
 */
export function captureLog(): {
  readonly lines: CapturedLogLine[];
  restore(): void;
} {
  const internal = Log as unknown as {
    outputSink: LogOutputSink | undefined;
    logLevel: LogLevel;
    cliMode: boolean;
  };
  const savedSink = internal.outputSink;
  const savedLevel = internal.logLevel;
  const savedCliMode = internal.cliMode;
  const sink = new RecordingLogSink();
  internal.outputSink = sink;
  internal.logLevel = LogLevel.TRACE;
  internal.cliMode = false;
  return {
    lines: sink.lines,
    restore: () => {
      internal.outputSink = savedSink;
      internal.logLevel = savedLevel;
      internal.cliMode = savedCliMode;
    },
  };
}
