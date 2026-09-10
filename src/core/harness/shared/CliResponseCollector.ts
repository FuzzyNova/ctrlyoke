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
import { extractTextFromEvents } from "./CliResponseTextExtractor";
import { secretRedactionService } from "../../../utils/SecretRedactionService";
import {
  resolveHeadlessSourceMode,
  type HeadlessLogTail,
} from "./HeadlessLogTail";
import type { ICliProvider } from "./interfaces/ICliProvider";
import type { BaseCliEvent } from "./interfaces/ILogParser";

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
    onResponseComplete: (response: string) => void;
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

  async collectHeadlessResponse(params: {
    stdout: string;
    stderr: string;
    exitCode: number;
    promptForSessionLog: string;
    executionStartTime: Date;
    resolvedSessionId?: string;
    label?: string;
    model?: string;
    workspaceRoot?: string;
    headlessLogTail?: HeadlessLogTail;
  }): Promise<CollectedHeadlessResponse> {
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

    const responseText = extractTextFromEvents(parsedOutput);
    const statistics = CliOutputFormatter.formatStatistics(
      parsedOutput.metadata
    );
    const failure = this.getHeadlessFailure(params, parsedOutput);
    const succeeded = failure === undefined;
    const resultResponse = responseText || failure?.message || "";

    const cliResult: CliResult = {
      success: succeeded,
      response: resultResponse,
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
    this.deps.hostCallbacks.onResponseComplete(resultResponse);

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
    params: { stdout: string; stderr: string; exitCode: number },
    parsedOutput: UniversalCliOutput
  ): { kind: FailureKind; message: string } | undefined {
    const stderr = sanitizeTerminalOutput(
      secretRedactionService.redactText(params.stderr)
    ).trim();

    if (params.exitCode !== 0) {
      return {
        kind: FAILURE_KINDS.PROCESS_EXIT,
        message: stderr || `Process exited with code ${params.exitCode}`,
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
