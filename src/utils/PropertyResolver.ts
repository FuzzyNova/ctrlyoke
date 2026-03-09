import {
  PromptFile,
  PromptItem,
  Harness,
  EndCondition,
  PriorContext,
} from "../types/FlightPathTypes";
import { ConfigurationUtils } from "./ConfigurationUtils";

/**
 * Resolved execution properties with all optionals filled in.
 * All properties are required after resolution.
 */
export interface ResolvedProperties {
  /** Harness/framework for execution (always resolved) */
  harness: Harness;

  /** AI model to use (always resolved) */
  model: string;

  /** Custom agent file (.agent.md) - undefined if not specified */
  agent?: string;

  /** Skills to attach - undefined if not specified */
  skills?: string[];

  /** Resume existing chat session (always resolved, defaults to setting) */
  resumeSession: boolean;

  /** Allow dynamic queue extension (always resolved, defaults to false) */
  allowDynamicExtension: boolean;

  /** Session ID for resuming - undefined if not specified */
  sessionId?: string | number;

  /** End condition validation - undefined if not specified */
  endCondition?: EndCondition;

  /** Controls injection of prior prompt outputs - undefined means no injection */
  priorContext?: PriorContext;

  /** Extra CLI flags appended to FlightPath's standard argument set - undefined if not specified */
  additionalArgs?: string;
}

/**
 * Property resolution utility with three-tier precedence:
 * 1. Prompt-level properties (highest priority)
 * 2. Workflow-level properties (middle priority)
 * 3. VS Code settings (lowest priority/fallback)
 *
 * This class ensures consistent property resolution across all workflow execution,
 * allowing workflows to be self-contained with their own defaults while still
 * respecting user preferences when not explicitly overridden.
 *
 * @example
 * ```typescript
 * const resolved = PropertyResolver.resolve(prompt, workflow);
 * // resolved.harness is guaranteed to be defined (from prompt, workflow, or settings)
 * // resolved.model is guaranteed to be defined (harness-specific default)
 * // resolved.agent may be undefined (no fallback)
 * ```
 */
export class PropertyResolver {
  /**
   * Resolve all execution properties for a prompt.
   *
   * Applies three-tier precedence for each property:
   * - Prompt property if defined (highest priority)
   * - Workflow property if defined (middle priority)
   * - VS Code global setting (lowest priority/fallback)
   *
   * @param prompt The prompt to resolve properties for
   * @param workflow The parent workflow file (may contain workflow-level defaults)
   * @returns Fully resolved properties with all required fields populated
   */
  static resolve(prompt: PromptItem, workflow: PromptFile): ResolvedProperties {
    const harness = this.resolveHarness(prompt, workflow);
    const model = this.resolveModel(prompt, workflow, harness);

    return {
      harness,
      model,
      agent: this.resolveAgent(prompt, workflow),
      skills: this.resolveSkills(prompt, workflow),
      resumeSession: this.resolveResumeSession(prompt, workflow),
      allowDynamicExtension: this.resolveAllowDynamicExtension(
        prompt,
        workflow
      ),
      sessionId: this.resolveSessionId(prompt, workflow),
      endCondition: this.resolveEndCondition(prompt, workflow),
      priorContext: this.resolvePriorContext(prompt, workflow),
      additionalArgs: this.resolveAdditionalArgs(prompt, workflow, harness),
    };
  }

  /**
   * Resolve harness with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.harness)
   * 2. Workflow-level default (workflow.harness)
   * 3. VS Code setting (flightpath.harness)
   *
   * @param prompt The prompt to resolve harness for
   * @param workflow The parent workflow file
   * @returns Resolved harness (always defined, guaranteed fallback to settings)
   */
  private static resolveHarness(
    prompt: PromptItem,
    workflow: PromptFile
  ): Harness {
    // 1. Prompt-level override (highest priority)
    if (prompt.harness !== undefined) {
      return prompt.harness;
    }

    // 2. Workflow-level default
    if (workflow.harness !== undefined) {
      return workflow.harness;
    }

    // 3. VS Code setting fallback (lowest priority)
    return ConfigurationUtils.getIntegrationMode();
  }

  /**
   * Resolve model with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.model)
   * 2. Workflow-level default (workflow.model)
   * 3. VS Code setting (harness-specific: copilotCliModel, claudeCliModel, etc.)
   *
   * @param prompt The prompt to resolve model for
   * @param workflow The parent workflow file
   * @param harness The resolved harness (needed for harness-specific model defaults)
   * @returns Resolved model (always defined, guaranteed fallback to harness-specific setting)
   */
  private static resolveModel(
    prompt: PromptItem,
    workflow: PromptFile,
    harness: Harness
  ): string {
    // 1. Prompt-level override (highest priority)
    if (prompt.model !== undefined) {
      return prompt.model;
    }

    // 2. Workflow-level default
    if (workflow.model !== undefined) {
      return workflow.model;
    }

    // 3. VS Code setting fallback (harness-specific)
    return this.getModelForHarness(harness);
  }

  /**
   * Resolve agent with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.agent)
   * 2. Workflow-level default (workflow.agent)
   * 3. VS Code setting (flightpath.defaultAgent)
   *
   * Note: Returns undefined if no agent is specified at any level.
   *
   * @param prompt The prompt to resolve agent for
   * @param workflow The parent workflow file
   * @returns Resolved agent filename or undefined
   */
  private static resolveAgent(
    prompt: PromptItem,
    workflow: PromptFile
  ): string | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.agent !== undefined) {
      return prompt.agent;
    }

    // 2. Workflow-level default
    if (workflow.agent !== undefined) {
      return workflow.agent;
    }

    // 3. VS Code setting fallback
    const globalAgent = ConfigurationUtils.getDefaultAgent();
    return globalAgent || undefined; // Convert empty string to undefined
  }

  /**
   * Resolve skills with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.skills) - takes precedence, no merging
   * 2. Workflow-level default (workflow.skills)
   * 3. VS Code setting (flightpath.defaultSkills)
   *
   * Note: Prompt-level skills REPLACE workflow-level skills (prompt wins entirely).
   *
   * @param prompt The prompt to resolve skills for
   * @param workflow The parent workflow file
   * @returns Resolved skills array or undefined
   */
  private static resolveSkills(
    prompt: PromptItem,
    workflow: PromptFile
  ): string[] | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.skills !== undefined) {
      return prompt.skills.length > 0 ? prompt.skills : undefined;
    }

    // 2. Workflow-level default
    if (workflow.skills !== undefined && workflow.skills.length > 0) {
      return workflow.skills;
    }

    // 3. VS Code setting fallback
    const globalSkills = ConfigurationUtils.getDefaultSkills();
    return globalSkills.length > 0 ? globalSkills : undefined;
  }

  /**
   * Resolve resumeSession with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.resumeSession)
   * 2. Workflow-level default (workflow.resumeSession)
   * 3. VS Code setting (flightpath.resumeExistingSession)
   *
   * @param prompt The prompt to resolve resumeSession for
   * @param workflow The parent workflow file
   * @returns Resolved resumeSession flag (always defined, defaults to setting)
   */
  private static resolveResumeSession(
    prompt: PromptItem,
    workflow: PromptFile
  ): boolean {
    // 1. Prompt-level override (highest priority)
    if (prompt.resumeSession !== undefined) {
      return prompt.resumeSession;
    }

    // 2. Workflow-level default
    if (workflow.resumeSession !== undefined) {
      return workflow.resumeSession;
    }

    // 3. VS Code setting fallback
    return ConfigurationUtils.shouldResumeExistingSession();
  }

  /**
   * Resolve allowDynamicExtension with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.allowDynamicExtension)
   * 2. Workflow-level default (workflow.allowDynamicExtension)
   * 3. VS Code setting (flightpath.enableDynamicQueue)
   *
   * @param prompt The prompt to resolve allowDynamicExtension for
   * @param workflow The parent workflow file
   * @returns Resolved allowDynamicExtension flag (defaults to VS Code setting)
   */
  private static resolveAllowDynamicExtension(
    prompt: PromptItem,
    workflow: PromptFile
  ): boolean {
    // 1. Prompt-level override (highest priority)
    if (prompt.allowDynamicExtension !== undefined) {
      return prompt.allowDynamicExtension;
    }

    // 2. Workflow-level default
    if (workflow.allowDynamicExtension !== undefined) {
      return workflow.allowDynamicExtension;
    }

    // 3. VS Code setting fallback (lowest priority)
    return ConfigurationUtils.getDynamicQueueConfig().enabled;
  }

  /**
   * Resolve sessionId with two-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.sessionId)
   * 2. Workflow-level default (workflow.sessionId)
   * 3. No fallback (returns undefined if not specified)
   *
   * Note: Session IDs are NOT inherited from VS Code settings.
   * They must be explicitly defined at the prompt or workflow level.
   *
   * @param prompt The prompt to resolve sessionId for
   * @param workflow The parent workflow file
   * @returns Resolved sessionId (string | number) or undefined
   */
  private static resolveSessionId(
    prompt: PromptItem,
    workflow: PromptFile
  ): string | number | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.sessionId !== undefined) {
      return prompt.sessionId;
    }

    // 2. Workflow-level default
    if (workflow.sessionId !== undefined) {
      return workflow.sessionId;
    }

    // 3. No fallback (undefined if not specified)
    return undefined;
  }

  /**
   * Resolve end condition with two-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.endCondition)
   *    - Object: Use this end condition (override workflow)
   *    - null: Explicitly disable end condition (even if workflow has one)
   *    - undefined: Inherit from workflow
   * 2. Workflow-level default (workflow.endCondition)
   * 3. No fallback - returns undefined
   *
   * Note: End conditions are NOT inherited from VS Code settings.
   * They must be explicitly defined at the prompt or workflow level.
   * Use null at prompt level to explicitly disable a workflow-level end condition.
   *
   * @param prompt The prompt to resolve end condition for
   * @param workflow The parent workflow file
   * @returns Resolved end condition or undefined
   */
  static resolveEndCondition(
    prompt: PromptItem,
    workflow: PromptFile
  ): EndCondition | undefined {
    // 1. Prompt-level override (highest priority)
    // Check for property existence, not just truthiness, to distinguish null from undefined
    if (Object.prototype.hasOwnProperty.call(prompt, "endCondition")) {
      const promptEndCondition = prompt.endCondition;
      // null means "explicitly disabled" - return undefined to skip validation
      if (promptEndCondition === null) {
        return undefined;
      }
      // Object means "override workflow" - use prompt's end condition
      return promptEndCondition;
    }

    // 2. Workflow-level default
    if (workflow.endCondition !== undefined && workflow.endCondition !== null) {
      return workflow.endCondition;
    }

    // 3. No fallback - end conditions are explicit
    return undefined;
  }

  /**
   * Resolve priorContext with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.priorContext)
   * 2. Workflow-level default (workflow.priorContext)
   * 3. VS Code setting (flightpath.priorContext)
   *
   * @param prompt The prompt to resolve priorContext for
   * @param workflow The parent workflow file
   * @returns Resolved PriorContext or undefined
   */
  private static resolvePriorContext(
    prompt: PromptItem,
    workflow: PromptFile
  ): PriorContext | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.priorContext !== undefined) {
      return prompt.priorContext;
    }

    // 2. Workflow-level default
    if (workflow.priorContext !== undefined) {
      return workflow.priorContext;
    }

    // 3. VS Code setting fallback
    const globalDefault = ConfigurationUtils.getPriorContext();
    return globalDefault !== "none"
      ? (globalDefault as PriorContext)
      : undefined;
  }

  /**
   * Resolve additionalArgs with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.additionalArgs)
   * 2. Workflow-level default (workflow.additionalArgs)
   * 3. VS Code setting for the resolved harness (flightpath.<harness>AdditionalArgs)
   *
   * Empty string at any level is treated as "not set" — falls through to the next tier.
   *
   * @param prompt The prompt to resolve additionalArgs for
   * @param workflow The parent workflow file
   * @param harness The resolved harness (used to pick the correct VS Code setting)
   * @returns Resolved additionalArgs string or undefined
   */
  private static resolveAdditionalArgs(
    prompt: PromptItem,
    workflow: PromptFile,
    harness: Harness
  ): string | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.additionalArgs !== undefined && prompt.additionalArgs !== "") {
      return prompt.additionalArgs;
    }

    // 2. Workflow-level default
    if (
      workflow.additionalArgs !== undefined &&
      workflow.additionalArgs !== ""
    ) {
      return workflow.additionalArgs;
    }

    // 3. VS Code setting fallback (harness-specific)
    const globalAdditionalArgs =
      ConfigurationUtils.getAdditionalArgsForHarness(harness);
    return globalAdditionalArgs || undefined;
  }

  /**
   * Get the default model for a specific harness.
   * Maps to harness-specific VS Code settings.
   *
   * @param harness The harness to get the default model for
   * @returns Harness-specific default model
   */
  private static getModelForHarness(harness: Harness): string {
    return ConfigurationUtils.getModelForHarness(harness);
  }
}
