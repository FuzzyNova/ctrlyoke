import type {
  CliResult,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import {
  FAILURE_KINDS,
  HEADLESS_SOURCE_MODES,
} from "../../../types/DashboardConstants";
import type { FailureKind } from "../../../types/CtrlYokeTypes";
import { Log } from "../../../utils/Log";
import { sanitizeTerminalOutput } from "../../../utils/TerminalOutputSanitizer";
import { CliOutputFormatter } from "./CliOutputFormatter";
import { getTranscriptText } from "../../../utils/StepOutputText";
import { secretRedactionService } from "../../../utils/SecretRedactionService";
import {
  resolveHeadlessSourceMode,
  type HeadlessLogTail,
  type HeadlessProcessResult,
} from "./HeadlessLogTail";
import type { ICliProvider } from "./interfaces/ICliProvider";
import type { BaseCliEvent } from "./interfaces/ILogParser";

/**
 * Tokens that make an stderr line a diagnostic rather than chatter. A line
 * carrying one of these is always kept, whatever else it looks like.
 */
const STDERR_DIAGNOSTIC_TOKEN_PATTERN =
  /\b(?:error|fatal|panic|exception|failed|failure|denied|refused|unauthorized|forbidden|not found|timed out|cannot|unable)\b/iu;

/**
 * stderr lines that report progress rather than a reason for failure.
 *
 * Harness CLIs narrate their own startup on stderr, so a process that was
 * killed (or died before producing any real diagnostic) often leaves *nothing
 * but* chatter there — and using it verbatim produced the failure message
 * "Reading additional input from stdin..." for a process ctrlyoke itself
 * terminated. This stays a denylist on purpose: an unrecognized stderr line is
 * assumed diagnostic and kept, because a bare "Process exited with code 1" is
 * undiagnosable.
 */
const STDERR_NOISE_PATTERNS: readonly RegExp[] = [
  // Codex writes this whenever its stdin is the NUL handle, which is exactly
  // how every headless harness is spawned (`CliProcessManager`'s
  // `stdin: "ignore"` default).
  /^reading additional input from stdin/iu,
  // Generic progress narration: a trailing ellipsis and no diagnostic token.
  /\.\.\.$/u,
];

/** Newest stderr lines kept in a process-exit failure message. */
const STDERR_FAILURE_MAX_LINES = 8;

/** Character cap on the stderr detail carried in a failure message. */
const STDERR_FAILURE_MAX_LENGTH = 600;

export interface CliResponseCollectorDeps {
  provider: Pick<
    ICliProvider,
    | "augmentParsedOutput"
    | "extractSessionIdFromLogs"
    | "extractSessionIdFromStdout"
    | "headlessSource"
    | "parseHeadlessStdout"
    | "logParser"
  >;
  hostCallbacks: {
    logResponse: (response: string, statistics?: string) => void;
    onResponseComplete: () => void;
  };
}

export interface CollectedHeadlessResponse {
  success: boolean;
  parsedOutput: UniversalCliOutput;
  cliResult: CliResult;
  extractedSessionId?: string;
  failureKind?: FailureKind;
  failureMessage?: string;
}

export class CliResponseCollector {
  constructor(private readonly deps: CliResponseCollectorDeps) {}

  async collectHeadlessResponse(
    params: HeadlessProcessResult & {
      promptForSessionLog: string;
      executionStartTime: Date;
      resolvedSessionId?: string;
      label?: string;
      model?: string;
      workspaceRoot?: string;
    }
  ): Promise<CollectedHeadlessResponse> {
    this.deps.provider.logParser?.setCurrentModel?.(params.model ?? "");
    let parsedOutput = this.parseHeadlessOutput(params);

    if (
      parsedOutput.metadata.sessionId === undefined &&
      this.deps.provider.extractSessionIdFromStdout
    ) {
      const sessionId = this.deps.provider.extractSessionIdFromStdout(
        params.stdout
      );
      if (sessionId) {
        parsedOutput = {
          ...parsedOutput,
          metadata: { ...parsedOutput.metadata, sessionId },
        };
      }
    }

    if (
      params.headlessLogTail &&
      this.deps.provider.logParser &&
      parsedOutput.metadata.sessionId === undefined
    ) {
      const sessionId = params.headlessLogTail.getSessionId();
      if (sessionId) {
        parsedOutput = {
          ...parsedOutput,
          metadata: { ...parsedOutput.metadata, sessionId },
        };
      }
    }

    if (this.deps.provider.augmentParsedOutput) {
      parsedOutput = await this.deps.provider.augmentParsedOutput(parsedOutput);
    }
    // Deliberately not redacted here: `parsedOutput`/`responseText` become the
    // harness's canonical response — reused verbatim as `$prior-context`/
    // `$step:N` in a later prompt (see PromptQueue/CliPromptPreparer) and as
    // commit-message text (CommitMessageGenerator). Redacting the harness's
    // own output at this choke point corrupted legitimate values the model
    // needs to see again (e.g. a real token printed while debugging auth
    // code), the same failure mode as redacting the standalone shim's own
    // generated JS. Every genuine output boundary (Log, TimelineRecorder,
    // dashboard/hosted transports, CLI output, Markdown export) redacts
    // independently at its own edge, so removing this pass does not weaken
    // that protection.

    const responseText = getTranscriptText(parsedOutput.events);
    const statistics = CliOutputFormatter.formatStatistics(
      parsedOutput.metadata
    );
    const failure = this.getHeadlessFailure(params, parsedOutput);
    const succeeded = failure === undefined;
    const resultResponse = responseText || failure?.message || "";

    const cliResult: CliResult = {
      success: succeeded,
      statistics,
      exitCode: params.exitCode,
      error: failure?.message,
    };

    let extractedSessionId = parsedOutput.metadata.sessionId;
    if (extractedSessionId) {
      Log.debug(
        `[CliResponseCollector] Session ID from output${params.label || ""}: ${extractedSessionId}`
      );
    } else if (
      succeeded &&
      !params.resolvedSessionId &&
      this.deps.provider.extractSessionIdFromLogs
    ) {
      const logSessionId = await this.deps.provider.extractSessionIdFromLogs(
        params.promptForSessionLog,
        params.executionStartTime,
        params.workspaceRoot
      );
      if (logSessionId) {
        extractedSessionId = logSessionId;
        Log.debug(
          `[CliResponseCollector] Session ID from logs${params.label || ""}: ${logSessionId}`
        );
      }
    }

    this.deps.hostCallbacks.logResponse(resultResponse, statistics);
    this.deps.hostCallbacks.onResponseComplete();

    return {
      success: succeeded,
      parsedOutput,
      cliResult,
      extractedSessionId,
      failureKind: failure?.kind,
      failureMessage: failure?.message,
    };
  }

  private parseHeadlessOutput(params: {
    stdout: string;
    stderr: string;
    exitCode: number;
    headlessLogTail?: HeadlessLogTail;
  }): UniversalCliOutput {
    const logParser = this.deps.provider.logParser;
    if (!logParser) {
      return { events: [], metadata: {} };
    }

    // A tail is only ever constructed for a log-sourced run, so its presence is
    // the runner's already-made decision; otherwise fall back to the provider's
    // declared mode. Never infer stdout mode from parseHeadlessStdout alone —
    // a provider may implement it while pinning headlessSource to "log".
    const mode = params.headlessLogTail
      ? HEADLESS_SOURCE_MODES.LOG
      : resolveHeadlessSourceMode(this.deps.provider);

    if (mode === HEADLESS_SOURCE_MODES.LOG) {
      return logParser.extractResponse(
        params.headlessLogTail?.getEvents() ?? []
      );
    }

    if (
      mode === HEADLESS_SOURCE_MODES.STDOUT &&
      this.deps.provider.parseHeadlessStdout
    ) {
      const events: BaseCliEvent[] = this.deps.provider.parseHeadlessStdout(
        params.stdout
      );
      return logParser.extractResponse(events);
    }

    return { events: [], metadata: {} };
  }

  private getHeadlessFailure(
    params: {
      stdout: string;
      stderr: string;
      exitCode: number;
      terminationSignal?: NodeJS.Signals;
    },
    parsedOutput: UniversalCliOutput
  ): { kind: FailureKind; message: string } | undefined {
    const stderr = sanitizeTerminalOutput(
      secretRedactionService.redactText(params.stderr)
    ).trim();

    // A killed process never reported a reason of its own — the exit code is
    // synthetic and stderr holds only whatever it happened to be narrating.
    // Classifying this as a harness failure invites a retry of something that
    // did not fail on its own terms.
    if (params.terminationSignal) {
      return {
        kind: FAILURE_KINDS.USER_CANCELLED,
        message: `Harness process was terminated (${params.terminationSignal})`,
      };
    }

    if (params.exitCode !== 0) {
      if (stderr) {
        Log.warn(`[CliResponseCollector] Headless stderr:\n${stderr}`);
      }
      const detail = this.summarizeStderr(stderr);
      const parsedError = parsedOutput.metadata.error
        ? sanitizeTerminalOutput(
            secretRedactionService.redactText(parsedOutput.metadata.error)
          ).trim()
        : undefined;
      return {
        kind: FAILURE_KINDS.PROCESS_EXIT,
        message:
          parsedError ||
          detail ||
          `Process exited with code ${params.exitCode}`,
      };
    }

    if (!stderr) {
      return undefined;
    }

    if (params.stdout.trim() || parsedOutput.events.length > 0) {
      return undefined;
    }

    return this.looksLikeCliInvocationError(stderr)
      ? { kind: FAILURE_KINDS.UNKNOWN, message: stderr }
      : undefined;
  }

  /**
   * Reduce stderr to the part that explains a non-zero exit, or nothing.
   *
   * Returning `undefined` is a real answer: the caller then reports the exit
   * code alone, which is more honest than quoting a progress line as the cause
   * of death. The full stderr is logged either way, so nothing is lost for
   * diagnosis.
   */
  private summarizeStderr(stderr: string): string | undefined {
    if (!stderr) {
      return undefined;
    }

    const diagnosticLines = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !this.isStderrNoise(line));

    if (diagnosticLines.length === 0) {
      return undefined;
    }

    const detail = diagnosticLines.slice(-STDERR_FAILURE_MAX_LINES).join("\n");
    return detail.length > STDERR_FAILURE_MAX_LENGTH
      ? `${detail.slice(0, STDERR_FAILURE_MAX_LENGTH)}…`
      : detail;
  }

  private isStderrNoise(line: string): boolean {
    if (STDERR_DIAGNOSTIC_TOKEN_PATTERN.test(line)) {
      return false;
    }
    return STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(line));
  }

  private looksLikeCliInvocationError(stderr: string): boolean {
    return [
      /^error:/imu,
      /\bunknown (?:option|argument|parameter)\b/iu,
      /\bunrecognized (?:option|argument|parameter)\b/iu,
      /\binvalid (?:option|argument|parameter)\b/iu,
      /\bDid you mean\b/iu,
      /\bTry ['"].*--help['"] for more information\./iu,
      /^Usage:/imu,
    ].some((pattern) => pattern.test(stderr));
  }
}
