import type { PromptStep } from "../../../types/CtrlYokeTypes";
import type { HarnessId } from "../../../types/DashboardConstants";
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
  getIntegrationHarness: () => HarnessId;
}

export class CliSessionResolverAdapter {
  constructor(private readonly deps: CliSessionResolverAdapterDeps) {}

  resolve(
    prompt: PromptStep,
    workflowContext?: WorkflowContext
  ): CliSessionResolution {
    const resolvedProperties = workflowContext?.workflowFile
      ? PropertyResolver.resolve(prompt, workflowContext.workflowFile, {
          hostCanProvidePty: workflowContext.hostCanProvidePty,
        })
      : workflowContext?.resolvedProperties;

    let resolvedSessionId =
      workflowContext?.preflightSession !== undefined
        ? workflowContext.preflightSession.sessionId
        : SessionResolver.resolveWithProperties(
            prompt,
            workflowContext?.promptIndex ?? 0,
            workflowContext?.allPrompts ?? [prompt],
            resolvedProperties,
            workflowContext?.finalStepSessionId,
            workflowContext?.groupStartBoundary
          );

    if (resolvedSessionId) {
      const harness =
        resolvedProperties?.harness ?? this.deps.getIntegrationHarness();
      if (!SessionValidator.validate(resolvedSessionId, harness)) {
        Log.info("[CliSessionResolverAdapter] Starting new session due to invalid session ID format");
        resolvedSessionId = undefined;
      }
    }

    return {
      resolvedProperties,
      resolvedSessionId,
    };
  }
}
