import type { Harness, PromptItem } from "../../../types/FlightPathTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import {
  PropertyResolver,
  type ResolvedProperties,
} from "../../../utils/PropertyResolver";
import { SessionResolver } from "../../../utils/SessionResolver";
import { SessionValidator } from "../../../utils/SessionValidator";

interface CliSessionResolverAdapterLogger {
  info(message: string): void;
}

export interface CliSessionResolution {
  resolvedProperties?: ResolvedProperties;
  resolvedSessionId?: string;
}

export interface CliSessionResolverAdapterDeps {
  getIntegrationHarness: () => Harness;
  logger: CliSessionResolverAdapterLogger;
}

export class CliSessionResolverAdapter {
  constructor(private readonly deps: CliSessionResolverAdapterDeps) {}

  resolve(
    prompt: PromptItem,
    workflowContext?: WorkflowContext
  ): CliSessionResolution {
    const resolvedProperties = workflowContext?.workflowFile
      ? PropertyResolver.resolve(prompt, workflowContext.workflowFile)
      : workflowContext?.resolvedProperties;

    let resolvedSessionId = SessionResolver.resolve(
      prompt,
      workflowContext?.promptIndex ?? 0,
      workflowContext?.allPrompts ?? [prompt],
      workflowContext?.workflowFile,
      workflowContext?.finalPromptSessionId
    );

    if (resolvedSessionId) {
      const harness =
        resolvedProperties?.harness ?? this.deps.getIntegrationHarness();
      if (!SessionValidator.validate(resolvedSessionId, harness)) {
        this.deps.logger.info(
          "🔄 Starting new session due to invalid session ID format"
        );
        resolvedSessionId = undefined;
      }
    }

    return {
      resolvedProperties,
      resolvedSessionId,
    };
  }
}
