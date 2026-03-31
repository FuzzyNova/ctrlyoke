import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import type { Harness, PromptItem } from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

interface WorkingFilePersistence {
  updateWorkingFile(): Promise<void>;
}

interface CliPromptRuntimeCoordinatorLogger {
  debug(message: string): void;
}

export interface CliPromptRuntimeCoordinatorDeps {
  getIntegrationHarness: () => Harness;
  logger: CliPromptRuntimeCoordinatorLogger;
  now?: () => number;
}

export class CliPromptRuntimeCoordinator {
  private readonly now: () => number;

  constructor(private readonly deps: CliPromptRuntimeCoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async persistCancelledPromptRuntime(params: {
    prompt: PromptItem;
    executionStartTime: Date;
    extractedSessionId?: string;
    promptQueue?: WorkingFilePersistence;
  }): Promise<void> {
    if (!params.promptQueue) {
      return;
    }

    if (!params.prompt._runtime) {
      params.prompt._runtime = {
        startedAt: params.executionStartTime.getTime(),
      };
    } else if (!params.prompt._runtime.startedAt) {
      params.prompt._runtime.startedAt = params.executionStartTime.getTime();
    }

    if (params.extractedSessionId && !params.prompt._runtime.sessionId) {
      params.prompt._runtime.sessionId = params.extractedSessionId;
    }

    await params.promptQueue.updateWorkingFile();
    this.deps.logger.debug(
      `💾 Saved cancelled-prompt runtime to working file (sessionId: ${params.extractedSessionId || "none"})`
    );
  }

  async persistSuccessfulPromptRuntime(params: {
    prompt: PromptItem;
    resolvedProperties?: ResolvedProperties;
    extractedSessionId?: string;
    parsedOutput?: UniversalCliOutput;
    promptQueue?: WorkingFilePersistence;
  }): Promise<UniversalCliOutput | undefined> {
    const actualHarness =
      params.resolvedProperties?.harness ?? this.deps.getIntegrationHarness();
    const actualModel = params.resolvedProperties?.model ?? "";
    const actualAgent = params.resolvedProperties?.agent;

    if (!params.prompt._runtime) {
      params.prompt._runtime = {
        harness: actualHarness,
        model: actualModel,
        agent: actualAgent,
        startedAt: this.now(),
      };
    } else {
      params.prompt._runtime.harness = actualHarness;
      params.prompt._runtime.model = actualModel;
      params.prompt._runtime.agent = actualAgent;
    }

    let parsedOutput = params.parsedOutput;

    if (params.extractedSessionId) {
      params.prompt._runtime.sessionId = params.extractedSessionId;

      if (parsedOutput && !parsedOutput.metadata.sessionId) {
        parsedOutput = {
          ...parsedOutput,
          metadata: {
            ...parsedOutput.metadata,
            sessionId: params.extractedSessionId,
          },
        };
      }
    }

    params.prompt._runtime.completedAt = this.now();

    if (params.promptQueue) {
      await params.promptQueue.updateWorkingFile();
      this.deps.logger.debug(
        `💾 Saved runtime metadata to working file (sessionId: ${params.extractedSessionId || "none"})`
      );
    }

    return parsedOutput;
  }
}
