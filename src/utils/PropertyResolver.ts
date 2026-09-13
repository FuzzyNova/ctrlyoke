import {
  EXECUTION_MODES,
  HARNESS_IDS,
  PRIOR_CONTEXT_KEYWORDS,
  type ExecutionMode,
  type HarnessId,
} from "../types/DashboardConstants";
import type {
  ExecutionPropertyDefaults,
  ExecutionResolutionContext,
  ResolvedExecutionTarget,
} from "../types/ExecutionPropertyResolver";
import { resolveExecutionProperties } from "../types/ExecutionPropertyResolver";
import type {
  PriorContext,
  PromptFile,
  PromptStep,
} from "../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import { ConfigurationUtils } from "./ConfigurationUtils";

export type {
  ExecutionPropertyDefaults,
  ExecutionResolutionContext,
  ResolvedExecutionTarget,
} from "../types/ExecutionPropertyResolver";
export type { ResolvedProperties } from "../types/ExecutionPropertyTypes";

export interface PropertyResolverOptions {
  hostCanProvidePty?: boolean;
}

/** VS Code/settings adapter for the platform-neutral execution resolver. */
export class PropertyResolver {
  private static createDefaults(): ExecutionPropertyDefaults {
    const harnessIds = Object.values(HARNESS_IDS) as HarnessId[];
    const modelsByHarness: Partial<Record<HarnessId, string>> = {};
    const additionalArgsByHarness: Partial<Record<HarnessId, string>> = {};
    for (const harness of harnessIds) {
      modelsByHarness[harness] = ConfigurationUtils.getModelForHarness(harness);
      additionalArgsByHarness[harness] =
        ConfigurationUtils.getAdditionalArgsForHarness(harness);
    }

    const priorContext = ConfigurationUtils.getPriorContext();
    return {
      harness: ConfigurationUtils.getIntegrationMode(),
      modelsByHarness,
      additionalArgsByHarness,
      executionMode: ConfigurationUtils.getCliExecutionMode() as ExecutionMode,
      ctrlyokeMcpMode: ConfigurationUtils.getCtrlYokeMcpMode(),
      agent: ConfigurationUtils.getDefaultAgent(),
      skills: ConfigurationUtils.getDefaultSkills(),
      secrets: ConfigurationUtils.getDefaultSecrets(),
      resumeSession: ConfigurationUtils.shouldResumeExistingSession(),
      mcpServers: ConfigurationUtils.getDefaultMcpServers(),
      priorContext:
        priorContext === PRIOR_CONTEXT_KEYWORDS.NONE
          ? undefined
          : (priorContext as PriorContext),
      hooks: undefined,
      sessionId: undefined,
      endCondition: undefined,
      preCondition: undefined,
      toolPermissions: undefined,
      errorBehavior: undefined,
    };
  }

  static createContext(
    options: PropertyResolverOptions = {}
  ): ExecutionResolutionContext {
    return {
      defaults: this.createDefaults(),
      hostCanProvidePty: options.hostCanProvidePty ?? true,
    };
  }

  static resolveTarget(
    prompt: PromptStep,
    workflow: PromptFile,
    options: PropertyResolverOptions = {}
  ): ResolvedExecutionTarget {
    return resolveExecutionProperties(
      prompt,
      workflow,
      this.createContext(options)
    );
  }

  static resolve(
    prompt: PromptStep,
    workflow: PromptFile,
    options: PropertyResolverOptions = {}
  ): ResolvedProperties {
    return this.resolveTarget(prompt, workflow, options).properties;
  }

  static resolveHarnessValue(
    promptHarness?: HarnessId,
    workflowHarness?: HarnessId
  ): HarnessId {
    return (
      promptHarness ??
      workflowHarness ??
      ConfigurationUtils.getIntegrationMode()
    );
  }

  static resolveExecutionMode(
    prompt: Pick<PromptStep, "executionMode">,
    workflow: Pick<PromptFile, "executionMode">,
    options: PropertyResolverOptions = {}
  ): ExecutionMode {
    const defaults = this.createDefaults();
    if (options.hostCanProvidePty === false) {
      return EXECUTION_MODES.HEADLESS;
    }
    return (
      prompt.executionMode ?? workflow.executionMode ?? defaults.executionMode
    );
  }

  static resolveEndCondition(
    prompt: PromptStep,
    workflow: PromptFile
  ): ResolvedProperties["endCondition"] {
    return this.resolve(prompt, workflow).endCondition;
  }
}
