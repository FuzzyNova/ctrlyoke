import type {
  CliResult,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import { Log } from "../../../utils/Log";
import { sanitizeTerminalOutput } from "../../../utils/TerminalOutputSanitizer";
import { CliOutputFormatter } from "./CliOutputFormatter";
import { extractTextFromEvents } from "./CliResponseTextExtractor";
import type { ICliProvider } from "./interfaces/ICliProvider";

export interface CliResponseCollectorDeps {
  provider: Pick<
    ICliProvider,
    "responseParser" | "augmentParsedOutput" | "extractSessionIdFromLogs"
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
  }): Promise<CollectedHeadlessResponse> {
    let parsedOutput = this.deps.provider.responseParser.parse(
      params.stdout,
      params.stderr,
      params.exitCode
    );

    if (this.deps.provider.augmentParsedOutput) {
      parsedOutput = await this.deps.provider.augmentParsedOutput(parsedOutput);
    }

    const responseText = extractTextFromEvents(parsedOutput);
    const statistics = CliOutputFormatter.formatStatistics(
      parsedOutput.metadata
    );
    const failureReason = this.getHeadlessFailureReason(params, parsedOutput);
    const succeeded = failureReason === undefined;
    const resultResponse = responseText || failureReason || "";

    const cliResult: CliResult = {
      success: succeeded,
      response: resultResponse,
      statistics,
      exitCode: params.exitCode,
      error: failureReason,
    };

    let extractedSessionId = parsedOutput.metadata.sessionId;
    if (extractedSessionId) {
      Log.debug(
        `📝 Session ID from output${params.label || ""}: ${extractedSessionId}`
      );
    } else if (
      succeeded &&
      !params.resolvedSessionId &&
      this.deps.provider.extractSessionIdFromLogs
    ) {
      const logSessionId = await this.deps.provider.extractSessionIdFromLogs(
        params.promptForSessionLog,
        params.executionStartTime
      );
      if (logSessionId) {
        extractedSessionId = logSessionId;
        Log.debug(
          `📝 Session ID from logs${params.label || ""}: ${logSessionId}`
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
    };
  }

  private getHeadlessFailureReason(
    params: { stdout: string; stderr: string; exitCode: number },
    parsedOutput: UniversalCliOutput
  ): string | undefined {
    const stderr = sanitizeTerminalOutput(params.stderr).trim();

    if (params.exitCode !== 0) {
      return stderr || `Process exited with code ${params.exitCode}`;
    }

    if (!stderr) {
      return undefined;
    }

    if (params.stdout.trim() || parsedOutput.events.length > 0) {
      return undefined;
    }

    return this.looksLikeCliInvocationError(stderr) ? stderr : undefined;
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
