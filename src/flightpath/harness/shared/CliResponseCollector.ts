import type {
  CliResult,
  OutputMetadata,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import type { IResponseParser } from "./interfaces/IResponseParser";

interface CliResponseCollectorLogger {
  debug(message: string): void;
}

export interface CliResponseCollectorDeps {
  responseParser: IResponseParser;
  augmentParsedOutput?: (
    output: UniversalCliOutput
  ) => Promise<UniversalCliOutput>;
  extractSessionIdFromLogs?: (
    promptText: string,
    startTime: Date
  ) => Promise<string | undefined>;
  extractTextFromEvents: (output: UniversalCliOutput) => string;
  formatStatistics: (metadata: OutputMetadata) => string;
  logResponse: (response: string, statistics?: string) => void;
  onResponseComplete: (response: string) => void;
  logger: CliResponseCollectorLogger;
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
    let parsedOutput = this.deps.responseParser.parse(
      params.stdout,
      params.stderr,
      params.exitCode
    );

    if (this.deps.augmentParsedOutput) {
      parsedOutput = await this.deps.augmentParsedOutput(parsedOutput);
    }

    const responseText = this.deps.extractTextFromEvents(parsedOutput);
    const statistics = this.deps.formatStatistics(parsedOutput.metadata);

    const cliResult: CliResult = {
      success: params.exitCode === 0,
      response: responseText,
      statistics,
      exitCode: params.exitCode,
      error: params.exitCode !== 0 ? params.stderr : undefined,
    };

    let extractedSessionId = parsedOutput.metadata.sessionId;
    if (extractedSessionId) {
      this.deps.logger.debug(
        `📝 Session ID from output${params.label || ""}: ${extractedSessionId}`
      );
    } else if (
      !params.resolvedSessionId &&
      this.deps.extractSessionIdFromLogs
    ) {
      const logSessionId = await this.deps.extractSessionIdFromLogs(
        params.promptForSessionLog,
        params.executionStartTime
      );
      if (logSessionId) {
        extractedSessionId = logSessionId;
        this.deps.logger.debug(
          `📝 Session ID from logs${params.label || ""}: ${logSessionId}`
        );
      }
    }

    this.deps.logResponse(responseText, statistics);
    this.deps.onResponseComplete(responseText);

    return {
      success: params.exitCode === 0,
      parsedOutput,
      cliResult,
      extractedSessionId,
    };
  }
}
