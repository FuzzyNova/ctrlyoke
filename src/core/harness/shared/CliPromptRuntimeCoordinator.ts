import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import type { PromptStep } from "../../../types/CtrlYokeTypes";
import type { FailureKind, HarnessId } from "../../../types/DashboardConstants";
import type { WorkflowWorkingFilePersistence } from "../../../types/WorkflowContextTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { Log } from "../../../utils/Log";

export interface CliPromptRuntimeCoordinatorDeps {
  getIntegrationHarness: () => HarnessId;
  now?: () => number;
}

export class CliPromptRuntimeCoordinator {
  private readonly now: () => number;

  constructor(private readonly deps: CliPromptRuntimeCoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async persistCancelledPromptRuntime(params: {
    prompt: PromptStep;
    executionStartTime: Date;
    extractedSessionId?: string;
    parsedOutput?: UniversalCliOutput;
    failureKind?: FailureKind;
    failureMessage?: string;
    resolvedProperties?: ResolvedProperties;
    workingFilePersistence?: WorkflowWorkingFilePersistence;
  }): Promise<void> {
    if (!params.workingFilePersistence) {
      return;
    }

    const actualHarness =
      params.resolvedProperties?.harness ?? this.deps.getIntegrationHarness();
    const actualModel = params.resolvedProperties?.model ?? "";
    const actualExecutionMode = params.resolvedProperties?.executionMode;
    const actualAgent = params.resolvedProperties?.agent;
    const actualSkills = params.resolvedProperties?.skills;
    const actualSecrets = params.resolvedProperties?.secrets;

    if (!params.prompt._runtime) {
      params.prompt._runtime = {
        startedAt: params.executionStartTime.getTime(),
      };
    } else if (!params.prompt._runtime.startedAt) {
      params.prompt._runtime.startedAt = params.executionStartTime.getTime();
    }

    params.prompt._runtime.harness = actualHarness;
    params.prompt._runtime.model = actualModel;
    params.prompt._runtime.executionMode = actualExecutionMode;
    if (actualAgent) {
      params.prompt._runtime.agent = actualAgent;
    }
    params.prompt._runtime.skills = actualSkills;
    if (actualSecrets !== undefined) {
      params.prompt._runtime.secrets = actualSecrets;
    }

    const sessionId =
      params.extractedSessionId || params.parsedOutput?.metadata.sessionId;
    if (sessionId && !params.prompt._runtime.sessionId) {
      params.prompt._runtime.sessionId = sessionId;
    }

    params.prompt._runtime.failureKind = params.failureKind;
    params.prompt._runtime.failureMessage = params.failureMessage;
    params.prompt._runtime.completedAt = this.now();

    await params.workingFilePersistence.updateWorkingFile();
    Log.debug(
      `💾 Saved cancelled-prompt runtime to working file (sessionId: ${sessionId || "none"})`
    );
  }

  async persistSuccessfulPromptRuntime(params: {
    prompt: PromptStep;
    resolvedProperties?: ResolvedProperties;
    extractedSessionId?: string;
    parsedOutput?: UniversalCliOutput;
    workingFilePersistence?: WorkflowWorkingFilePersistence;
  }): Promise<UniversalCliOutput | undefined> {
    const actualHarness =
      params.resolvedProperties?.harness ?? this.deps.getIntegrationHarness();
    const actualModel = params.resolvedProperties?.model ?? "";
    const actualExecutionMode = params.resolvedProperties?.executionMode;
    const actualAgent = params.resolvedProperties?.agent;
    const actualSkills = params.resolvedProperties?.skills;
    const actualSecrets = params.resolvedProperties?.secrets;

    if (!params.prompt._runtime) {
      params.prompt._runtime = {
        harness: actualHarness,
        model: actualModel,
        executionMode: actualExecutionMode,
        agent: actualAgent,
        skills: actualSkills,
        startedAt: this.now(),
      };
      if (actualSecrets !== undefined) {
        params.prompt._runtime.secrets = actualSecrets;
      }
    } else {
      params.prompt._runtime.harness = actualHarness;
      params.prompt._runtime.model = actualModel;
      params.prompt._runtime.executionMode = actualExecutionMode;
      params.prompt._runtime.agent = actualAgent;
      params.prompt._runtime.skills = actualSkills;
      if (actualSecrets !== undefined) {
        params.prompt._runtime.secrets = actualSecrets;
      }
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

    params.prompt._runtime.failureKind = undefined;
    params.prompt._runtime.failureMessage = undefined;
    params.prompt._runtime.completedAt = this.now();

    if (params.workingFilePersistence) {
      await params.workingFilePersistence.updateWorkingFile();
      Log.debug(
        `💾 Saved runtime metadata to working file (sessionId: ${params.extractedSessionId || "none"})`
      );
    }

    return parsedOutput;
  }
}
