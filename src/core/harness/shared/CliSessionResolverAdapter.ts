import type { PromptStep } from "../../../types/CtrlYokeTypes";
import type { HarnessId } from "../../../types/DashboardConstants";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import {
  PropertyResolver,
  type ResolvedProperties,
} from "../../../utils/PropertyResolver";
import { SessionResolver } from "../../../utils/SessionResolver";
import { SessionValidator } from "../../../utils/SessionValidator";
import type { ICliProvider } from "./interfaces/ICliProvider";
import { buildSessionResumeWarning } from "./SessionResumeWarning";

export interface CliSessionResolution {
  resolvedProperties?: ResolvedProperties;
  resolvedSessionId?: string;
  warningMessage?: string;
}

export interface CliSessionResolverAdapterDeps {
  getIntegrationHarness: () => HarnessId;
  provider: ICliProvider;
  getWorkspaceRoot: () => string | undefined;
}

export class CliSessionResolverAdapter {
  constructor(private readonly deps: CliSessionResolverAdapterDeps) {}

  async resolve(
    prompt: PromptStep,
    workflowContext?: WorkflowContext
  ): Promise<CliSessionResolution> {
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
    let warningMessage: string | undefined;

    if (resolvedSessionId) {
      const harness =
        resolvedProperties?.harness ?? this.deps.getIntegrationHarness();
      if (!SessionValidator.validate(resolvedSessionId, harness)) {
        warningMessage = buildSessionResumeWarning(
          workflowContext?.promptIndex ?? 0,
          harness,
          "invalid-id"
        );
        resolvedSessionId = undefined;
      } else {
        const probe = this.deps.provider.probeResumableSession;
        const workspaceRoot = this.deps.getWorkspaceRoot();
        if (probe && workspaceRoot) {
          const availability = await probe.call(
            this.deps.provider,
            resolvedSessionId,
            workspaceRoot
          );
          if (availability === "missing") {
            warningMessage = buildSessionResumeWarning(
              workflowContext?.promptIndex ?? 0,
              harness,
              "not-found"
            );
            resolvedSessionId = undefined;
          }
        }
      }
    }

    return {
      resolvedProperties,
      resolvedSessionId,
      warningMessage,
    };
  }
}
