import {
  analyzeCompatibility,
  type CompatibilityExecutionTarget,
} from "../types/CompatibilityAnalyzer";
import type {
  CompatibilityDiagnostic,
  HarnessCapabilityRegistrySnapshot,
} from "../types/CompatibilityTypes";
import {
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  FINAL_STEP_PHASES,
  PREVIEW_PERMISSION_ACTIONS,
  PREVIEW_PERMISSION_RULE_STATUSES,
  PREVIEW_PROPERTY_SOURCES,
  PREVIEW_SCOPES,
  PREVIEW_STEP_TYPES,
  type HarnessId,
  type PreviewPermissionAction,
  type PreviewPropertySource,
} from "../types/DashboardConstants";
import type {
  EndCondition,
  ErrorBehavior,
  McpServerConfig,
  PreCondition,
  PromptFile,
  PromptStep,
  ScriptStep,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import { isScriptStep, type DynamicQueueConfig } from "../types/CtrlYokeTypes";
import type {
  ExecutionPropertyDefaults,
  ResolvedExecutionTarget,
} from "../types/ExecutionPropertyResolver";
import { resolveExecutionProperties } from "../types/ExecutionPropertyResolver";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import {
  type CommandPreview,
  type ConditionDefinitionPreview,
  type ConditionPreview,
  type ExecutionLimitsPreview,
  type HookPreview,
  type McpApplicationPreview,
  type McpServerPreview,
  type PermissionApplicationPreview,
  type PermissionRulePreview,
  type RetryPreview,
  type StepExecutionPreview,
  type VariableResolutionPreview,
  type WorkflowExecutionPreview,
  type WorkflowPreviewSummary,
  type WorkspaceMutationPreview,
} from "../types/ExecutionPreviewTypes";
import {
  redactExecutionPreview,
  redactPreviewText,
} from "../types/PreviewRedactor";
import { VarSubstitutor } from "../utils/VarSubstitutor";
import { SessionValidator } from "../utils/SessionValidator";
import { CliPromptPreparer } from "./harness/shared/CliPromptPreparer";
import { CliExecutionSession } from "./harness/shared/CliExecutionSession";
import {
  ExecutionPlanBuilder,
  type ExecutionPlan,
} from "./harness/shared/ExecutionPlanBuilder";
import { escapeCmdArgument } from "./harness/shared/WindowsCmdEscaping";
import type { ICliProvider } from "./harness/shared/interfaces/ICliProvider";

export type ExecutionPreviewScope =
  | { kind: typeof PREVIEW_SCOPES.WORKFLOW }
  | { kind: typeof PREVIEW_SCOPES.STEP; stepIndex: number };

/** The already-wired shared planners for one CLI harness. */
export interface ExecutionPreviewHarness {
  readonly provider: ICliProvider;
  readonly promptPreparer: CliPromptPreparer;
  readonly executionPlanBuilder: ExecutionPlanBuilder;
}

export interface ExecutionPreviewServiceOptions {
  readonly defaults: ExecutionPropertyDefaults;
  readonly capabilities: HarnessCapabilityRegistrySnapshot;
  readonly getHarness: (
    harnessId: HarnessId
  ) => ExecutionPreviewHarness | Promise<ExecutionPreviewHarness>;
  readonly workspaceRoot?: string;
  readonly workspaceRoots?: readonly string[];
  readonly extensionPath: string;
  readonly hostCanProvidePty: boolean;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly dynamicQueueConfig?: DynamicQueueConfig;
  readonly enabledHookNotificationEvents?: readonly import("../types/CtrlYokeTypes").HookEvent[];
  readonly resolvePriorContextItems?: (
    contexts: readonly import("../types/CtrlYokeTypes").PriorContext[],
    allPrompts: readonly WorkflowStep[],
    promptIndex: number
  ) => Promise<import("../core/HarnessIntegration").PriorContextItem[]>;
}

export interface ExecutionPreviewRequest {
  readonly workflow: PromptFile;
  readonly scope?: ExecutionPreviewScope;
  readonly workflowName?: string;
  readonly sourcePath?: string;
  readonly workingFilePath?: string;
  readonly definitionRevision?: number | string;
  /** Higher-precedence variables, such as CLI --var values. */
  readonly variables?: Record<string, string>;
}

interface PreviewStepTarget {
  readonly step: WorkflowStep;
  readonly stepIndex: number;
  readonly isFinalStep: boolean;
}

const DEFAULT_SCOPE: ExecutionPreviewScope = { kind: PREVIEW_SCOPES.WORKFLOW };

/**
 * Assemble the complete, side-effect-free execution snapshot.
 *
 * This class deliberately receives the same prompt preparer and plan builder
 * instances used by live CLI integrations. It owns DTO assembly only; it does
 * not resolve availability, open sessions, run conditions, or apply mutations.
 */
export class ExecutionPreviewService {
  constructor(private readonly options: ExecutionPreviewServiceOptions) {}

  async build(
    request: ExecutionPreviewRequest
  ): Promise<WorkflowExecutionPreview> {
    const preview = await this.buildUnredacted(request);
    return redactExecutionPreview(preview);
  }

  preview(request: ExecutionPreviewRequest): Promise<WorkflowExecutionPreview> {
    return this.build(request);
  }

  private async buildUnredacted(
    request: ExecutionPreviewRequest
  ): Promise<WorkflowExecutionPreview> {
    const scope = request.scope ?? DEFAULT_SCOPE;
    const variables = {
      ...(request.workflow.vars ?? {}),
      ...(request.variables ?? {}),
    };
    const workflow = request.workflow;
    const preparedSteps =
      workflow.steps?.map((step) => this.substituteStep(step, variables)) ?? [];
    const preparedFinalStep = workflow.finalStep
      ? this.substituteStep(workflow.finalStep, variables)
      : undefined;
    const allPreparedSteps = [
      ...preparedSteps,
      ...(preparedFinalStep ? [preparedFinalStep] : []),
    ];
    const preparedWorkflow: PromptFile = {
      ...workflow,
      steps: preparedSteps,
      ...(preparedFinalStep ? { finalStep: preparedFinalStep } : {}),
    };
    const targets = this.selectTargets(preparedWorkflow, scope);

    const resolvedTargets = new Map<number, ResolvedExecutionTarget>();
    for (const target of targets) {
      if (isScriptStep(target.step)) {
        continue;
      }
      resolvedTargets.set(
        target.stepIndex,
        resolveExecutionProperties(target.step, preparedWorkflow, {
          defaults: this.options.defaults,
          hostCanProvidePty: this.options.hostCanProvidePty,
        })
      );
    }

    const compatibilityTargets: CompatibilityExecutionTarget[] = targets
      .filter((target) => !isScriptStep(target.step))
      .map((target) => ({
        consumer: target.isFinalStep
          ? { kind: FINAL_STEP_PHASES.FINAL_STEP }
          : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: target.stepIndex },
        resolved: resolvedTargets.get(target.stepIndex)!,
      }));
    const compatibilityDiagnostics = analyzeCompatibility({
      workflow: preparedWorkflow,
      executionTargets: compatibilityTargets,
      capabilities: this.options.capabilities,
      workspace: { workspaceRoot: this.options.workspaceRoot },
    });

    const steps: StepExecutionPreview[] = [];
    for (const target of targets) {
      steps.push(
        await this.buildStepPreview(
          target,
          preparedWorkflow,
          allPreparedSteps,
          variables,
          request,
          resolvedTargets.get(target.stepIndex),
          compatibilityDiagnostics
        )
      );
    }

    const limits = this.buildLimits(steps.length);
    const diagnostics = [
      ...compatibilityDiagnostics,
      ...steps.flatMap((step) => step.diagnostics),
    ];
    const workflowSummary: WorkflowPreviewSummary = {
      name:
        request.workflowName ??
        this.getWorkflowName(workflow) ??
        "Unnamed workflow",
      stepCount: steps.length,
      ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
      ...(request.definitionRevision !== undefined
        ? { definitionRevision: String(request.definitionRevision) }
        : {}),
      harnessIds: [
        ...new Set(steps.map((step) => step.resolvedProperties.harnessId)),
      ],
      totalByteCount: steps.reduce(
        (total, step) => total + (step.prompt?.totalByteCount ?? 0),
        0
      ),
      totalTokenEstimate: steps.reduce(
        (total, step) =>
          total +
          (step.prompt?.sections.reduce(
            (sectionTotal, section) =>
              sectionTotal + (section.tokenEstimate ?? 0),
            0
          ) ?? 0),
        0
      ),
      workspaceMutationCount: steps.reduce(
        (total, step) => total + step.workspaceMutations.length,
        0
      ),
    };

    for (const step of steps) {
      step.resolvedProperties.limits = limits;
    }
    return {
      workflow: workflowSummary,
      steps,
      diagnostics: this.dedupeDiagnostics(diagnostics),
    };
  }

  private async buildStepPreview(
    target: PreviewStepTarget,
    workflow: PromptFile,
    allSteps: WorkflowStep[],
    variables: Record<string, string>,
    request: ExecutionPreviewRequest,
    resolvedTarget: ResolvedExecutionTarget | undefined,
    compatibilityDiagnostics: readonly CompatibilityDiagnostic[]
  ): Promise<StepExecutionPreview> {
    const step = target.step;
    const promptStep = isScriptStep(step) ? this.scriptAsPrompt(step) : step;
    const targetResolution =
      resolvedTarget ??
      resolveExecutionProperties(promptStep, workflow, {
        defaults: this.options.defaults,
        hostCanProvidePty: this.options.hostCanProvidePty,
      });
    const properties = VarSubstitutor.applyToResolvedProperties(
      targetResolution.properties,
      variables
    );
    const harness = await this.options.getHarness(properties.harness);
    const resolvedSessionId = isScriptStep(step)
      ? undefined
      : this.resolveSessionId(target.stepIndex, allSteps, properties);
    const conditionPreview = this.buildConditions(
      properties.preCondition,
      properties.endCondition,
      properties.errorBehavior
    );
    const resolvedProperties = this.toResolvedPropertiesPreview(
      properties,
      targetResolution,
      conditionPreview,
      Boolean(resolvedSessionId)
    );
    const variablesPreview = this.buildVariablesPreview(variables, request);
    const diagnostics = this.stepDiagnostics(target, compatibilityDiagnostics);

    if (isScriptStep(step)) {
      const scriptCommand = this.buildScriptCommand(step);
      return {
        stepIndex: target.stepIndex,
        ...(step.name ? { stepName: step.name } : {}),
        type: PREVIEW_STEP_TYPES.SCRIPT,
        resolvedProperties,
        command: scriptCommand,
        workspaceMutations: [],
        variables: variablesPreview,
        conditions: conditionPreview,
        diagnostics,
      };
    }

    const prompt = { ...step };
    const workflowContext = {
      promptIndex: target.stepIndex,
      allPrompts: allSteps,
      filePath: request.sourcePath,
      workflowName: request.workflowName,
      workingFilePath: request.workingFilePath,
      resolvedProperties: properties,
      workflowFile: workflow,
      hostCanProvidePty: this.options.hostCanProvidePty,
      ...(this.options.resolvePriorContextItems
        ? { resolvePriorContextItems: this.options.resolvePriorContextItems }
        : {}),
    };
    const session = new CliExecutionSession({
      prompt,
      workflowContext,
      resolvedProperties: properties,
      resolvedSessionId,
    });
    const promptPlan = await harness.promptPreparer.planPrompt(
      prompt,
      workflowContext,
      properties,
      resolvedSessionId
    );
    session.preparePrompt(
      promptPlan.promptWithInstruction,
      promptPlan.tempFilePaths
    );
    const executionPlan = await harness.executionPlanBuilder.plan(session);
    const command = this.toCommandPreview(
      executionPlan,
      harness.provider,
      properties
    );
    const permissionApplication = this.toPermissionPreview(
      executionPlan,
      properties,
      diagnostics
    );
    const mcpApplication = this.toMcpPreview(properties, executionPlan);
    const workspaceMutations = this.toWorkspaceMutations(executionPlan);
    return {
      stepIndex: target.stepIndex,
      ...(step.name ? { stepName: step.name } : {}),
      type: PREVIEW_STEP_TYPES.PROMPT,
      resolvedProperties,
      prompt: promptPlan.promptPreview,
      command,
      permissionApplication,
      mcpApplication,
      workspaceMutations,
      variables: variablesPreview,
      conditions: conditionPreview,
      diagnostics: this.dedupeDiagnostics([
        ...promptPlan.diagnostics,
        ...executionPlan.diagnostics,
        ...diagnostics,
      ]),
    };
  }

  private selectTargets(
    workflow: PromptFile,
    scope: ExecutionPreviewScope
  ): PreviewStepTarget[] {
    const queue = (workflow.steps ?? []).map((step, stepIndex) => ({
      step,
      stepIndex,
      isFinalStep: false,
    }));
    const finalStep = workflow.finalStep
      ? [
          {
            step: workflow.finalStep,
            stepIndex: queue.length,
            isFinalStep: true,
          },
        ]
      : [];
    if (scope.kind === PREVIEW_SCOPES.WORKFLOW) {
      return [...queue, ...finalStep].filter(
        (target) => target.step.enabled !== false
      );
    }
    if (!Number.isInteger(scope.stepIndex) || scope.stepIndex < 0) {
      throw new Error(
        `Invalid execution preview step index: ${scope.stepIndex}`
      );
    }
    const target = [...queue, ...finalStep].find(
      (candidate) => candidate.stepIndex === scope.stepIndex
    );
    if (!target) {
      throw new Error(
        `Execution preview step index is out of range: ${scope.stepIndex}`
      );
    }
    return target.step.enabled === false ? [] : [target];
  }

  private substituteStep(
    step: WorkflowStep,
    variables: Record<string, string>
  ): WorkflowStep {
    if (isScriptStep(step)) {
      return {
        ...step,
        script: VarSubstitutor.substitute(step.script, variables),
      };
    }
    return {
      ...step,
      prompt: VarSubstitutor.applyToPromptText(step.prompt, variables),
    };
  }

  private scriptAsPrompt(step: ScriptStep): PromptStep {
    return {
      prompt: "",
      ...(step.executionMode !== undefined
        ? { executionMode: step.executionMode }
        : {}),
      ...(step.errorBehavior !== undefined
        ? { errorBehavior: step.errorBehavior }
        : {}),
    };
  }

  private resolveSessionId(
    stepIndex: number,
    allSteps: WorkflowStep[],
    properties: ResolvedProperties
  ): string | undefined {
    if (!properties.resumeSession || properties.sessionId === undefined) {
      if (!properties.resumeSession) return undefined;
      for (let index = stepIndex - 1; index >= 0; index -= 1) {
        const previous = allSteps[index];
        const sessionId = previous?._runtime?.sessionId;
        if (
          typeof sessionId === "string" &&
          previous?._runtime?.harness === properties.harness &&
          SessionValidator.validate(sessionId, properties.harness)
        ) {
          return sessionId;
        }
      }
      return undefined;
    }
    if (typeof properties.sessionId === "number") {
      const referenced =
        allSteps[properties.sessionId - 1]?._runtime?.sessionId;
      return typeof referenced === "string" &&
        SessionValidator.validate(referenced, properties.harness)
        ? referenced
        : undefined;
    }
    return SessionValidator.validate(properties.sessionId, properties.harness)
      ? properties.sessionId
      : undefined;
  }

  private toResolvedPropertiesPreview(
    properties: ResolvedProperties,
    target: ResolvedExecutionTarget,
    conditions: ConditionPreview,
    sessionPresent: boolean
  ) {
    const version =
      this.options.capabilities.harnesses[properties.harness]?.version;
    const permission = properties.toolPermissions;
    const hooks: HookPreview[] = (properties.hooks ?? []).map((hook) => ({
      event: hook.event,
      command: hook.command,
      redactions: [],
      inlineConfigFragment: JSON.stringify(hook),
      inlineConfigRedactions: [],
    }));
    return {
      harnessId: properties.harness,
      ...(version ? { harnessVersion: version } : {}),
      ...(properties.model ? { model: properties.model } : {}),
      executionMode: properties.executionMode,
      continuationMode: properties.resumeSession ? "resume" : "new-session",
      session: {
        present: sessionPresent,
        resolutionSource: this.toPropertySource(target.sources.sessionId),
      },
      ...(properties.agent ? { agent: properties.agent } : {}),
      skills: [...(properties.skills ?? [])],
      mcpServerIds: (properties.mcpServers ?? []).map((server) =>
        typeof server === "string" ? server : server.id
      ),
      hooks,
      permissions: {
        ...(permission?.mode ? { mode: permission.mode } : {}),
        allowedRules: [...(permission?.allowedTools ?? [])],
        deniedRules: [...(permission?.deniedTools ?? [])],
      },
      limits: this.buildLimits(0),
      conditions,
      propertySources: Object.fromEntries(
        Object.entries(target.sources).map(([key, source]) => [
          key,
          this.toPropertySource(source),
        ])
      ),
    };
  }

  private toCommandPreview(
    plan: ExecutionPlan,
    provider: ICliProvider,
    properties: ResolvedProperties
  ): CommandPreview {
    const args = [...plan.args];
    const mcpSecrets = (properties.mcpServers ?? [])
      .filter((server): server is McpServerConfig => typeof server !== "string")
      .flatMap((server) => [
        ...Object.values(server.env ?? {}),
        ...Object.values(server.headers ?? {}),
      ]);
    const redactedArgs = args.map(
      (arg) => redactPreviewText(arg, [], mcpSecrets).text
    );
    const executable = plan.resolvedCommand.command;
    const platform = this.options.platform ?? process.platform;
    const displayCommand = renderPreviewCommand(
      executable,
      redactedArgs,
      platform,
      plan.resolvedCommand.requiresShellVerbatimArgs
    );
    const environmentKeys = new Set<string>([
      ...Object.keys(
        properties.executionMode === "interactive"
          ? (provider.getInteractiveSpawnEnv?.() ?? {})
          : (provider.getHeadlessSpawnEnv?.() ?? {})
      ),
    ]);
    return {
      executable,
      args: redactedArgs,
      displayCommand,
      cwd: this.options.cwd ?? this.options.workspaceRoot ?? process.cwd(),
      environmentKeys: [...environmentKeys],
    };
  }

  private toPermissionPreview(
    plan: ExecutionPlan,
    properties: ResolvedProperties,
    stepDiagnostics: readonly CompatibilityDiagnostic[]
  ): PermissionApplicationPreview {
    const effective =
      plan.effectiveToolPermissions ?? properties.toolPermissions;
    const rules: PermissionRulePreview[] = [];
    for (const rule of effective?.allowedTools ?? []) {
      rules.push(
        this.toPermissionRule(
          PREVIEW_PERMISSION_ACTIONS.ALLOW,
          rule,
          plan.diagnostics
        )
      );
    }
    for (const rule of effective?.deniedTools ?? []) {
      rules.push(
        this.toPermissionRule(
          PREVIEW_PERMISSION_ACTIONS.DENY,
          rule,
          plan.diagnostics
        )
      );
    }
    return {
      ...(effective?.mode ? { effectiveMode: effective.mode } : {}),
      rules,
      nativeArguments: [...plan.permissionApplication.cliArgs],
      ...(plan.permissionApplication.workspaceMutation
        ? {
            workspaceMutation: this.toWorkspaceMutation(
              plan.permissionApplication.workspaceMutation
            ),
          }
        : {}),
      diagnostics: this.dedupeDiagnostics([
        ...plan.permissionApplication.diagnostics,
        ...stepDiagnostics,
      ]),
    };
  }

  private toPermissionRule(
    action: PreviewPermissionAction,
    rule: string,
    diagnostics: readonly CompatibilityDiagnostic[]
  ): PermissionRulePreview {
    const relevant = diagnostics.find(
      (diagnostic) =>
        diagnostic.capability ===
        (action === PREVIEW_PERMISSION_ACTIONS.ALLOW
          ? "allowedTools"
          : "deniedTools")
    );
    const status = relevant
      ? relevant.code.toLowerCase().includes("unsupported") ||
        relevant.code.toLowerCase().includes("notenforced")
        ? PREVIEW_PERMISSION_RULE_STATUSES.IGNORED
        : relevant.code.toLowerCase().includes("partial")
          ? PREVIEW_PERMISSION_RULE_STATUSES.PARTIAL
          : PREVIEW_PERMISSION_RULE_STATUSES.UNVERIFIED
      : PREVIEW_PERMISSION_RULE_STATUSES.APPLIED;
    return {
      action,
      rule,
      status,
      ...(status === PREVIEW_PERMISSION_RULE_STATUSES.APPLIED
        ? { nativeRule: rule }
        : { reason: relevant?.message }),
    };
  }

  private toMcpPreview(
    properties: ResolvedProperties,
    plan: ExecutionPlan
  ): McpApplicationPreview {
    const servers: McpServerPreview[] = (properties.mcpServers ?? []).map(
      (server) => {
        if (typeof server === "string") {
          return {
            id: server,
            transport: "named",
            toolFilters: [],
            environmentKeys: [],
          };
        }
        const toolFilters = [
          ...(server.autoApprove === true
            ? ["*"]
            : Array.isArray(server.autoApprove)
              ? server.autoApprove
              : []),
          ...(server.deniedTools ?? []).map((tool) => `!${tool}`),
        ];
        return {
          id: server.id,
          transport: server.command
            ? "stdio"
            : (server.transport ?? "streamable-http"),
          toolFilters,
          environmentKeys: Object.keys(server.env ?? {}),
          inlineConfigFragment: JSON.stringify({
            id: server.id,
            transport: server.command
              ? "stdio"
              : (server.transport ?? "streamable-http"),
            toolFilters,
            environmentKeys: Object.keys(server.env ?? {}),
          }),
          inlineConfigRedactions: [],
        };
      }
    );
    const hasMcp = servers.length > 0;
    const args = plan.providerPreparation.cliArgs;
    const injectionMethod = !hasMcp
      ? "none"
      : args.includes("--mcp-config")
        ? "cli-argument"
        : args.includes("-c")
          ? "inline-cli-config"
          : plan.mutations.some((mutation) =>
                mutation.description?.toLowerCase().includes("opencode")
              )
            ? "process-environment"
            : "provider-native";
    return { injectionMethod, servers };
  }

  private toWorkspaceMutations(
    plan: ExecutionPlan
  ): WorkspaceMutationPreview[] {
    return plan.mutations.map((mutation) => this.toWorkspaceMutation(mutation));
  }

  private toWorkspaceMutation(mutation: {
    path?: string;
    intendedContent?: string;
    description?: string;
  }): WorkspaceMutationPreview {
    const pathValue = mutation.path ?? "(process-local)";
    const isProcessLocal = !mutation.path;
    return {
      path: pathValue,
      ownedKeys: mutation.intendedContent
        ? this.extractOwnedKeys(mutation.intendedContent)
        : [],
      operation: isProcessLocal ? "process-local" : "write-or-update",
      warning: isProcessLocal
        ? (mutation.description ??
          "Process-local preparation; no workspace file is written.")
        : `Workspace-wide side effect: ${mutation.description ?? "the harness configuration will be updated"}.`,
    };
  }

  private extractOwnedKeys(content: string): string[] {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.keys(parsed as Record<string, unknown>);
      }
    } catch {
      // TOML and other provider formats are handled by the conservative matcher.
    }
    return [
      ...content.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]/gm),
    ].map((match) => match[1]);
  }

  private buildVariablesPreview(
    variables: Record<string, string>,
    request: ExecutionPreviewRequest
  ): VariableResolutionPreview[] {
    return Object.entries(variables).map(([name, value]) => ({
      name,
      source:
        request.variables && name in request.variables
          ? PREVIEW_PROPERTY_SOURCES.PROMPT
          : PREVIEW_PROPERTY_SOURCES.WORKFLOW,
      value,
      redactions: [],
    }));
  }

  private buildConditions(
    pre: PreCondition | undefined,
    end: EndCondition | undefined,
    errorBehavior: ErrorBehavior | undefined
  ): ConditionPreview {
    const retry: RetryPreview = {
      maxAttempts: end?.maxRetries === -1 ? -1 : (end?.maxRetries ?? 0) + 1,
      ...(end?.timeout !== undefined ? { backoffSeconds: 0 } : {}),
    };
    return {
      pre: [this.toConditionDefinition("pre", pre)],
      end: [this.toConditionDefinition("end", end)],
      retry,
      ...(errorBehavior
        ? { errorBehavior: this.describeErrorBehavior(errorBehavior) }
        : {}),
    };
  }

  private toConditionDefinition(
    kind: "pre" | "end",
    condition: PreCondition | EndCondition | undefined
  ): ConditionDefinitionPreview {
    if (!condition) return { kind, configured: false };
    const scriptPath =
      condition.script.split(/[\\/]/).pop() || condition.script;
    return {
      kind,
      configured: true,
      scriptPath,
      description: [
        `compare=${condition.compareSource ?? COMPARE_SOURCES.AUTO}`,
        condition.returns !== undefined
          ? `returns=${condition.returns}`
          : undefined,
        condition.timeout !== undefined
          ? `timeout=${condition.timeout}s`
          : undefined,
        kind === "pre"
          ? `onPass=${condition.onPass ?? CONDITION_ACTIONS.CONTINUE}`
          : `onPass=${condition.onPass ?? CONDITION_ACTIONS.CONTINUE}`,
        `onFail=${condition.onFail ?? (kind === "pre" ? CONDITION_ACTIONS.SKIP_PROMPT : CONDITION_ACTIONS.STOP_WORKFLOW)}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(", "),
    };
  }

  private describeErrorBehavior(errorBehavior: ErrorBehavior): string {
    return [
      `onError=${errorBehavior.onError}`,
      errorBehavior.maxRetries !== undefined
        ? `maxRetries=${errorBehavior.maxRetries}`
        : undefined,
      errorBehavior.retryDelayMs !== undefined
        ? `retryDelayMs=${errorBehavior.retryDelayMs}`
        : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(", ");
  }

  private buildScriptCommand(step: ScriptStep): CommandPreview {
    const executable =
      (this.options.platform ?? process.platform) === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");
    const args =
      (this.options.platform ?? process.platform) === "win32"
        ? ["/d", "/s", "/c", step.script]
        : ["-c", step.script];
    const displayCommand =
      (this.options.platform ?? process.platform) === "win32"
        ? [executable, ...args].join(" ")
        : [executable, ...args].map(shellEscapePosix).join(" ");
    return {
      executable,
      args,
      displayCommand,
      cwd: this.options.cwd ?? this.options.workspaceRoot ?? process.cwd(),
      environmentKeys: [],
    };
  }

  private buildLimits(stepCount: number): ExecutionLimitsPreview {
    const config = this.options.dynamicQueueConfig;
    const violations: string[] = [];
    if (
      config &&
      !config.unlimitedMode &&
      config.maxQueueSize > 0 &&
      stepCount > config.maxQueueSize
    ) {
      violations.push(
        `Queue size ${stepCount} exceeds limit ${config.maxQueueSize}`
      );
    }
    return {
      ...(config && !config.unlimitedMode && config.maxQueueSize > 0
        ? { maxQueueSteps: config.maxQueueSize }
        : {}),
      ...(config &&
      !config.unlimitedMode &&
      config.maxWorkflowExecutionTime !== -1
        ? { maxExecutionSeconds: config.maxWorkflowExecutionTime }
        : {}),
      violations,
    };
  }

  private stepDiagnostics(
    target: PreviewStepTarget,
    diagnostics: readonly CompatibilityDiagnostic[]
  ): CompatibilityDiagnostic[] {
    return diagnostics.filter((diagnostic) =>
      target.isFinalStep
        ? diagnostic.consumer?.kind === FINAL_STEP_PHASES.FINAL_STEP
        : diagnostic.consumer?.kind === FINAL_STEP_PHASES.QUEUE &&
          diagnostic.consumer.stepIndex === target.stepIndex
    );
  }

  private dedupeDiagnostics(
    diagnostics: readonly CompatibilityDiagnostic[]
  ): CompatibilityDiagnostic[] {
    const seen = new Set<string>();
    return diagnostics.filter((diagnostic) => {
      const key = JSON.stringify([
        diagnostic.code,
        diagnostic.consumer,
        diagnostic.propertyPointer,
        diagnostic.harnessId,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private toPropertySource(source: string | undefined): PreviewPropertySource {
    switch (source) {
      case "prompt":
        return PREVIEW_PROPERTY_SOURCES.PROMPT;
      case "workflow":
        return PREVIEW_PROPERTY_SOURCES.WORKFLOW;
      default:
        return PREVIEW_PROPERTY_SOURCES.GLOBAL_DEFAULT;
    }
  }

  private getWorkflowName(workflow: PromptFile): string | undefined {
    return "workflowName" in workflow &&
      typeof workflow.workflowName === "string"
      ? workflow.workflowName
      : undefined;
  }
}

export function renderPreviewCommand(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  requiresShellVerbatimArgs = false
): string {
  if (platform === "win32") {
    if (requiresShellVerbatimArgs) {
      return [executable, ...args].join(" ");
    }
    return [executable, ...args]
      .map((value) => escapeCmdArgument(value, false))
      .join(" ");
  }
  return [executable, ...args].map(shellEscapePosix).join(" ");
}

function shellEscapePosix(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
