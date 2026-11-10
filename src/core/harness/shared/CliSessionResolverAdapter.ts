import type { PromptStep } from "../../../types/CtrlYokeTypes";
import {
  SESSION_AVAILABILITY,
  type HarnessId,
  type SessionAvailability,
} from "../../../types/DashboardConstants";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import {
  SettingsPropertyResolver,
  type ResolvedProperties,
} from "../../../utils/SettingsPropertyResolver";
import { SessionResolver } from "../../../utils/SessionResolver";
import { SessionValidator } from "../../../utils/SessionValidator";
import type { IHarnessAdapter } from "./interfaces/IHarnessAdapter";
import { buildSessionResumeWarning } from "./SessionResumeWarning";

export interface CliSessionResolution {
  resolvedProperties?: ResolvedProperties;
  resolvedSessionId?: string;
  /** Candidate ID before invalid or missing sessions fall back to a fresh session. */
  probedSessionId?: string;
  warningMessage?: string;
  sessionAvailability?: SessionAvailability;
}

export interface CliSessionResolverAdapterDeps {
  getIntegrationHarness: () => HarnessId;
  provider: IHarnessAdapter;
  getWorkspaceRoot: () => string | undefined;
}

export class CliSessionResolverAdapter {
  constructor(private readonly deps: CliSessionResolverAdapterDeps) {}

  async resolve(
    prompt: PromptStep,
    workflowContext?: WorkflowContext
  ): Promise<CliSessionResolution> {
    const resolvedProperties = workflowContext?.workflowFile
      ? SettingsPropertyResolver.resolve(prompt, workflowContext.workflowFile, {
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
    let sessionAvailability: CliSessionResolution["sessionAvailability"];
    const probedSessionId = resolvedSessionId;

    if (resolvedSessionId) {
      const harness =
        resolvedProperties?.harness ?? this.deps.getIntegrationHarness();
      if (!SessionValidator.validate(resolvedSessionId, harness)) {
        sessionAvailability = SESSION_AVAILABILITY.MALFORMED;
        warningMessage = buildSessionResumeWarning(
          workflowContext?.promptIndex ?? 0,
          harness,
          SESSION_AVAILABILITY.MALFORMED
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
          if (availability === SESSION_AVAILABILITY.MISSING) {
            sessionAvailability = SESSION_AVAILABILITY.MISSING;
            warningMessage = buildSessionResumeWarning(
              workflowContext?.promptIndex ?? 0,
              harness,
              SESSION_AVAILABILITY.MISSING
            );
            resolvedSessionId = undefined;
          } else {
            sessionAvailability = availability;
          }
        } else {
          sessionAvailability = SESSION_AVAILABILITY.UNKNOWN;
        }
      }
    }

    return {
      resolvedProperties,
      resolvedSessionId,
      ...(probedSessionId ? { probedSessionId } : {}),
      warningMessage,
      ...(sessionAvailability ? { sessionAvailability } : {}),
    };
  }
}
