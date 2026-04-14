import type {
  CliResult,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import { Log } from "../../../utils/Log";
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

    const cliResult: CliResult = {
      success: params.exitCode === 0,
      response: responseText,
      statistics,
      exitCode: params.exitCode,
      error: params.exitCode !== 0 ? params.stderr : undefined,
    };

    let extractedSessionId = parsedOutput.metadata.sessionId;
    if (extractedSessionId) {
      Log.debug(
        `📝 Session ID from output${params.label || ""}: ${extractedSessionId}`
      );
    } else if (
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

    this.deps.hostCallbacks.logResponse(responseText, statistics);
    this.deps.hostCallbacks.onResponseComplete(responseText);

    return {
      success: params.exitCode === 0,
      parsedOutput,
      cliResult,
      extractedSessionId,
    };
  }
}
