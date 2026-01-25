import {
  PromptFile,
  PromptItem,
  Provider,
  EndCondition,
} from "../types/FlightPathTypes";
import { ConfigurationUtils } from "./ConfigurationUtils";

/**
 * Resolved execution properties with all optionals filled in.
 * All properties are required after resolution.
 */
export interface ResolvedProperties {
  /** AI provider for execution (always resolved) */
  provider: Provider;

  /** AI model to use (always resolved) */
  model: string;

  /** Custom agent file (.agent.md) - undefined if not specified */
  agent?: string;

  /** Resume existing chat session (always resolved, defaults to setting) */
  resumeSession: boolean;

  /** Allow dynamic queue extension (always resolved, defaults to false) */
  allowDynamicExtension: boolean;

  /** Session ID for resuming - undefined if not specified */
  sessionId?: string | number;

  /** End condition validation - undefined if not specified */
  endCondition?: EndCondition;
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
 * // resolved.provider is guaranteed to be defined (from prompt, workflow, or settings)
 * // resolved.model is guaranteed to be defined (provider-specific default)
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
    const provider = this.resolveProvider(prompt, workflow);
    const model = this.resolveModel(prompt, workflow, provider);

    return {
      provider,
      model,
      agent: this.resolveAgent(prompt, workflow),
      resumeSession: this.resolveResumeSession(prompt, workflow),
      allowDynamicExtension: this.resolveAllowDynamicExtension(
        prompt,
        workflow
      ),
      sessionId: this.resolveSessionId(prompt, workflow),
      endCondition: this.resolveEndCondition(prompt, workflow),
    };
  }

  /**
   * Resolve provider with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.provider)
   * 2. Workflow-level default (workflow.provider)
   * 3. VS Code setting (flightpath.provider)
   *
   * @param prompt The prompt to resolve provider for
   * @param workflow The parent workflow file
   * @returns Resolved provider (always defined, guaranteed fallback to settings)
   */
  private static resolveProvider(
    prompt: PromptItem,
    workflow: PromptFile
  ): Provider {
    // 1. Prompt-level override (highest priority)
    if (prompt.provider !== undefined) {
      return prompt.provider;
    }

    // 2. Workflow-level default
    if (workflow.provider !== undefined) {
      return workflow.provider;
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
   * 3. VS Code setting (provider-specific: copilotCliModel, claudeCliModel, etc.)
   *
   * @param prompt The prompt to resolve model for
   * @param workflow The parent workflow file
   * @param provider The resolved provider (needed for provider-specific model defaults)
   * @returns Resolved model (always defined, guaranteed fallback to provider-specific setting)
   */
  private static resolveModel(
    prompt: PromptItem,
    workflow: PromptFile,
    provider: Provider
  ): string {
    // 1. Prompt-level override (highest priority)
    if (prompt.model !== undefined) {
      return prompt.model;
    }

    // 2. Workflow-level default
    if (workflow.model !== undefined) {
      return workflow.model;
    }

    // 3. VS Code setting fallback (provider-specific)
    return this.getModelForProvider(provider);
  }

  /**
   * Resolve agent with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.agent)
   * 2. Workflow-level default (workflow.agent)
   * 3. VS Code setting (flightpath.customAgent)
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
    const globalAgent = ConfigurationUtils.getCustomAgent();
    return globalAgent || undefined; // Convert empty string to undefined
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
   * 3. Default to false (no VS Code setting for this property)
   *
   * Note: Dynamic extension must be explicitly enabled at prompt or workflow level.
   * Unlike other properties, there is no global VS Code setting fallback.
   *
   * @param prompt The prompt to resolve allowDynamicExtension for
   * @param workflow The parent workflow file
   * @returns Resolved allowDynamicExtension flag (defaults to false)
   */
  private static resolveAllowDynamicExtension(
    prompt: PromptItem,
    workflow: PromptFile
  ): boolean {
    // Allow if ANY source enables it (prompt, workflow, or VS Code setting)
    const globalEnabled = ConfigurationUtils.getDynamicQueueConfig().enabled;
    return Boolean(
      prompt.allowDynamicExtension ||
      workflow.allowDynamicExtension ||
      globalEnabled
    );
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
   * Get the default model for a specific provider.
   * Maps to provider-specific VS Code settings.
   *
   * @param provider The provider to get the default model for
   * @returns Provider-specific default model
   */
  private static getModelForProvider(provider: Provider): string {
    switch (provider) {
      case Provider.CopilotCli:
        return ConfigurationUtils.getCliModel();
      case Provider.CopilotChat:
        return ConfigurationUtils.getCopilotChatModel();
      case Provider.ClaudeCli:
        return ConfigurationUtils.getClaudeCliModel();
      case Provider.CodexCli:
        return ConfigurationUtils.getCodexCliModel();
      default:
        // Fallback to Copilot CLI model (should never happen with typed Provider enum)
        return ConfigurationUtils.getCliModel();
    }
  }
}
