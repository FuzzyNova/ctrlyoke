import type { Harness, PromptStep } from "../../../types/FlightPathTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import {
  PropertyResolver,
  type ResolvedProperties,
} from "../../../utils/PropertyResolver";
import { Log } from "../../../utils/Log";
import { SessionResolver } from "../../../utils/SessionResolver";
import { SessionValidator } from "../../../utils/SessionValidator";

export interface CliSessionResolution {
  resolvedProperties?: ResolvedProperties;
  resolvedSessionId?: string;
}

export interface CliSessionResolverAdapterDeps {
  getIntegrationHarness: () => Harness;
}

export class CliSessionResolverAdapter {
  constructor(private readonly deps: CliSessionResolverAdapterDeps) {}

  resolve(
    prompt: PromptStep,
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
        Log.info(
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
