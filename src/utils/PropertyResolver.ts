import {
  PromptFile,
  PromptStep,
  Harness,
  EndCondition,
  PriorContext,
  McpServerConfig,
  ToolPermissionsOverride,
  UserHookConfig,
  HookEvent,
} from "../types/FlightPathTypes";
import { ToolPermissionConfig } from "../flightpath/harness/shared/interfaces/IToolPermissionMapper";
import { ConfigurationUtils } from "./ConfigurationUtils";
import {
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
} from "../types/DashboardConstants";

/**
 * Resolved execution properties with all optionals filled in.
 * All properties are required after resolution.
 */
export interface ResolvedProperties {
  /** Harness/framework for execution (always resolved) */
  harness: Harness;

  /** AI model to use (always resolved) */
  model: string;

  /** Custom agent file (.agent.md) - undefined if not specified or explicitly disabled */
  agent?: string;

  /** Skills to attach - undefined if not specified or explicitly disabled */
  skills?: string[];

  /** Resume existing chat session (always resolved, defaults to setting) */
  resumeSession: boolean;

  /**
   * MCP servers to attach (resolved from prompt > workflow > settings).
   * null = explicitly disabled, undefined should not occur after resolution.
   */
  mcpServers: (string | McpServerConfig)[] | null;

  /**
   * User-defined hooks (resolved with per-event override semantics).
   * null = explicitly disabled, undefined should not occur after resolution.
   */
  hooks: UserHookConfig[] | null;

  /** Session ID for resuming - undefined if not specified */
  sessionId?: string | number;

  /** End condition validation - undefined if not specified */
  endCondition?: EndCondition;

  /** Controls injection of prior prompt outputs - undefined means no injection */
  priorContext?: PriorContext;

  /** Extra CLI flags appended to FlightPath's standard argument set - undefined if not specified */
  additionalArgs?: string;

  /** Tool permission config - null means none (no permission flags injected) */
  toolPermissions: ToolPermissionConfig | null;
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
  static resolve(prompt: PromptStep, workflow: PromptFile): ResolvedProperties {
    const harness = this.resolveHarness(prompt, workflow);
    const model = this.resolveModel(prompt, workflow, harness);

    return {
      harness,
      model,
      agent: this.resolveAgent(prompt, workflow),
      skills: this.resolveSkills(prompt, workflow),
      resumeSession: this.resolveResumeSession(prompt, workflow),
      mcpServers: this.resolveMcpServers(prompt, workflow),
      hooks: this.resolveHooks(prompt, workflow),
      sessionId: this.resolveSessionId(prompt, workflow),
      endCondition: this.resolveEndCondition(prompt, workflow),
      priorContext: this.resolvePriorContext(prompt, workflow),
      additionalArgs: this.resolveAdditionalArgs(prompt, workflow, harness),
      toolPermissions: this.resolveToolPermissions(prompt, workflow),
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
    prompt: PromptStep,
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
    prompt: PromptStep,
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
   * Note: Both null and empty string are treated as explicit "no agent" and stop
   * further resolution. The resolved value remains undefined because downstream
   * integrations only need to know whether an agent should be applied.
   *
   * @param prompt The prompt to resolve agent for
   * @param workflow The parent workflow file
   * @returns Resolved agent filename or undefined
   */
  private static resolveAgent(
    prompt: PromptStep,
    workflow: PromptFile
  ): string | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.agent !== undefined) {
      return prompt.agent || undefined;
    }

    // 2. Workflow-level default
    if (workflow.agent !== undefined) {
      return workflow.agent || undefined;
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
   * Null and empty arrays are treated as explicit "no skills" and stop further
   * resolution, while the resolved value remains undefined.
   *
   * @param prompt The prompt to resolve skills for
   * @param workflow The parent workflow file
   * @returns Resolved skills array or undefined
   */
  private static resolveSkills(
    prompt: PromptStep,
    workflow: PromptFile
  ): string[] | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.skills !== undefined) {
      return Array.isArray(prompt.skills) && prompt.skills.length > 0
        ? prompt.skills
        : undefined;
    }

    // 2. Workflow-level default
    if (workflow.skills !== undefined) {
      return Array.isArray(workflow.skills) && workflow.skills.length > 0
        ? workflow.skills
        : undefined;
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
    prompt: PromptStep,
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
   * Resolve hooks with per-event override semantics.
   * Prompt-level hooks override workflow hooks per-event (not wholesale).
   * Events not mentioned at prompt level inherit from workflow level.
   */
  private static resolveHooks(
    promptStep: PromptStep,
    workflowFile: PromptFile
  ): UserHookConfig[] | null {
    // Explicit null at prompt level → no hooks for this prompt
    if (promptStep.hooks === null) return null;

    // Explicit null at workflow level (no prompt override) → no hooks
    if (promptStep.hooks === undefined && workflowFile.hooks === null)
      return null;

    // workflowFile.hooks is never undefined here (seeded by populateSettingsDefaults)
    const workflowHooks = workflowFile.hooks ?? [];

    // No prompt-level override → return workflow hooks
    if (promptStep.hooks === undefined || promptStep.hooks.length === 0) {
      return workflowHooks;
    }

    // Prompt has hooks → per-event override against workflow level
    const eventMap = new Map<HookEvent, UserHookConfig[]>();

    // Base: workflow-level hooks
    for (const hook of workflowHooks) {
      if (!eventMap.has(hook.event)) eventMap.set(hook.event, []);
      eventMap.get(hook.event)!.push(hook);
    }

    // Override: prompt-level hooks replace workflow hooks per event
    const promptEvents = new Set(promptStep.hooks.map((h) => h.event));
    for (const event of promptEvents) {
      eventMap.set(
        event,
        promptStep.hooks.filter((h) => h.event === event)
      );
    }

    return [...eventMap.values()].flat();
  }

  /**
   * Resolve mcpServers with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.mcpServers)
   *    - Array: use these servers
   *    - null: explicitly disabled — no servers
   *    - undefined: fall through to next tier
   * 2. Workflow-level default (workflow.mcpServers)
   *    - Array: use these servers
   *    - null: explicitly disabled — no servers
   *    - undefined: fall through to next tier
   * 3. VS Code setting (flightpath.mcpServers)
   *
   * @param prompt The prompt to resolve mcpServers for
   * @param workflow The parent workflow file
   * @returns Resolved mcpServers array or null
   */
  private static resolveMcpServers(
    prompt: PromptStep,
    workflow: PromptFile
  ): (string | McpServerConfig)[] | null {
    // 1. Prompt-level override (highest priority)
    if (prompt.mcpServers !== undefined) {
      return prompt.mcpServers;
    }

    // 2. Workflow-level default
    if (workflow.mcpServers !== undefined) {
      return workflow.mcpServers;
    }

    // 3. VS Code setting fallback (lowest priority)
    return ConfigurationUtils.getDefaultMcpServers();
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
    prompt: PromptStep,
    workflow: PromptFile
  ): string | number | undefined {
    // 1. Prompt-level override (non-empty) — always takes precedence.
    if (prompt.sessionId !== undefined && prompt.sessionId !== "") {
      return prompt.sessionId;
    }

    // 2. Empty-string at the prompt level — only blocks inheritance when the prompt is
    // also explicitly overriding resumeSession (i.e., it owns the resume tier).
    // If resumeSession falls through to the workflow, so should the sessionId.
    if (prompt.sessionId === "" && prompt.resumeSession !== undefined) {
      return undefined;
    }

    // 3. Workflow-level default (reached when prompt.sessionId is undefined, or when
    // prompt.sessionId is "" but prompt does not override resumeSession).
    // Empty string is treated as "not set" — the working file writes "" as the default
    // when no sessionId is specified, and that should fall through to auto-resume logic.
    if (workflow.sessionId !== undefined && workflow.sessionId !== "") {
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
    prompt: PromptStep,
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
    prompt: PromptStep,
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
    return globalDefault !== PRIOR_CONTEXT_KEYWORDS.NONE
      ? (globalDefault as PriorContext)
      : undefined;
  }

  /**
   * Resolve additionalArgs with three-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.additionalArgs)
   *    - string: Use these args (highest priority)
   *    - null: Explicitly disabled — stop here, return undefined (no args)
   *    - undefined: Fall through to next tier
   * 2. Workflow-level default (workflow.additionalArgs)
   *    - string: Use these args
   *    - null: Explicitly disabled — stop here, return undefined
   *    - undefined: Fall through to next tier
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
    prompt: PromptStep,
    workflow: PromptFile,
    harness: Harness
  ): string | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.additionalArgs !== undefined) {
      // null means "explicitly disabled" — stop resolution, return undefined (no args)
      if (prompt.additionalArgs === null || prompt.additionalArgs === "") {
        return undefined;
      }
      return prompt.additionalArgs;
    }

    // 2. Workflow-level default
    if (workflow.additionalArgs !== undefined) {
      // null means "explicitly disabled" — stop resolution, return undefined
      if (workflow.additionalArgs === null || workflow.additionalArgs === "") {
        return undefined;
      }
      return workflow.additionalArgs;
    }

    // 3. VS Code setting fallback (harness-specific)
    const globalAdditionalArgs =
      ConfigurationUtils.getAdditionalArgsForHarness(harness);
    return globalAdditionalArgs || undefined;
  }

  /**
   * Resolve tool permissions with two-tier precedence.
   *
   * Precedence order:
   * 1. Prompt-level override (prompt.toolPermissions)
   *    - Object: Use these permissions
   *    - null: None — no permission flags injected
   *    - undefined: Fall through to workflow
   * 2. Workflow-level default (workflow.toolPermissions)
   * 3. No fallback — returns null (none)
   *
   * Note: This is a two-tier resolver. VS Code settings are NOT consulted at runtime.
   * They are seeded into working files on creation via populateSettingsDefaults().
   *
   * @param prompt The prompt to resolve permissions for
   * @param workflow The parent workflow file
   * @returns Resolved ToolPermissionConfig, or null for none
   */
  private static resolveToolPermissions(
    prompt: PromptStep,
    workflow: PromptFile
  ): ToolPermissionConfig | null {
    // Prompt takes precedence; use explicit undefined check — null is meaningful ("none")
    const effective: ToolPermissionsOverride | null | undefined =
      prompt.toolPermissions !== undefined
        ? prompt.toolPermissions
        : workflow.toolPermissions;

    // null, undefined, or { mode: "none" } → inject no flags
    if (
      effective === null ||
      effective === undefined ||
      effective.mode === PERMISSION_MODES.NONE
    ) {
      return null;
    }

    return {
      mode: effective.mode ?? PERMISSION_MODES.ALLOW_ALL,
      allowedTools: effective.allowedTools ?? [],
      deniedTools: effective.deniedTools ?? [],
    };
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
