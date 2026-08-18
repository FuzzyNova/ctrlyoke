import {
  analyzeCompatibility,
  type CompatibilityExecutionTarget,
} from "../types/CompatibilityAnalyzer";
import type {
  CompatibilityDiagnostic,
  HarnessCapabilityRegistrySnapshot,
} from "../types/CompatibilityTypes";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "../types/CompatibilityTypes";
import {
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  FINAL_STEP_PHASES,
  PREVIEW_PERMISSION_ACTIONS,
  PREVIEW_MUTATION_SCOPES,
  PREVIEW_PERMISSION_RULE_STATUSES,
  PREVIEW_PROPERTY_SOURCES,
  PREVIEW_SCOPES,
  PREVIEW_STEP_TYPES,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  WORKTREE_MODES,
  type HarnessId,
  type PreviewPermissionAction,
  type PreviewPropertySource,
} from "../types/DashboardConstants";
import * as path from "path";
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
import type {
  ExecutionPreviewScope,
  ManagedMcpServer,
} from "../types/WebviewMessageTypes";
import { isScriptStep, type DynamicQueueConfig } from "../types/CtrlYokeTypes";
import type {
  ExecutionPropertyDefaults,
  ResolvedExecutionTarget,
} from "../types/ExecutionPropertyResolver";
import { resolveExecutionProperties } from "../types/ExecutionPropertyResolver";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import {
  type CommandPreview,
  type CommandDisplayShell,
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
  type WorktreeExecutionPreview,
} from "../types/ExecutionPreviewTypes";
import { renderCommandForDisplay } from "../types/CommandDisplayFormatter";
import {
  redactExecutionPreview,
  redactPreviewText,
} from "../types/PreviewRedactor";
import { VarSubstitutor } from "../utils/VarSubstitutor";
import { McpServerNormalizer } from "../utils/McpServerNormalizer";
import { McpRegistryFileManager } from "../utils/McpRegistryFileManager";
import { SessionValidator } from "../utils/SessionValidator";
import { CliPromptPreparer } from "./harness/shared/CliPromptPreparer";
import { CliExecutionSession } from "./harness/shared/CliExecutionSession";
import {
  ExecutionPlanBuilder,
  type ExecutionPlan,
} from "./harness/shared/ExecutionPlanBuilder";
import type { ICliProvider } from "./harness/shared/interfaces/ICliProvider";
import type { PreparedMutation } from "./harness/shared/interfaces/PreparedMutation";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import { PromptFileResolver } from "./PromptFileResolver";
import { resolveWorktreeSelection } from "../utils/WorktreeResolution";
import {
  evaluateWorkspaceEligibility,
  previewWorktreePlacement,
} from "../utils/WorktreeUtils";
import { WorktreeManager } from "./orchestration/WorktreeManager";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import type { SecretStore } from "../platform/SecretStore";
import {
  findMissingSecretNames,
} from "../utils/SecretResolver";
import { getEffectiveSecretGrants } from "../utils/SecretReferenceParser";

/** The already-wired shared planners for one CLI harness. */
export interface ExecutionPreviewHarness {
  readonly provider: ICliProvider;
  readonly promptPreparer: CliPromptPreparer;
  readonly executionPlanBuilder: ExecutionPlanBuilder;
}

export interface ExecutionPreviewServiceOptions {
  readonly defaults: ExecutionPropertyDefaults;
  readonly capabilities: HarnessCapabilityRegistrySnapshot;
  /**
   * Resolves the shared planning helpers for one harness. When the workflow
   * is worktree-configured and a planned execution directory is knowable
   * (see {@link WorktreeManager.previewExecutionWorkspace}), the resolved
   * `executionWorkspace` is passed so the caller can build/select an
   * integration whose prompt preparation reflects the worktree's remapped
   * roots instead of the ordinary source-checkout workspace — otherwise the
   * preview's attachments/`--add-dir` cannot match what a worktree run will
   * actually do.
   */
  readonly getHarness: (
    harnessId: HarnessId,
    executionWorkspace?: ExecutionWorkspace
  ) => ExecutionPreviewHarness | Promise<ExecutionPreviewHarness>;
  readonly workspaceRoot?: string;
  readonly workspaceRoots?: readonly string[];
  readonly approvedExternalRoots?: readonly string[];
  readonly namedWorkspaceRoots?: readonly ResolverWorkspaceFolder[];
  /** Reject workflow-relative refs when the authored definition is outside the source checkout. */
  readonly allowWorkflowRelativeReferences?: boolean;
  readonly extensionPath: string;
  readonly hostCanProvidePty: boolean;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly dynamicQueueConfig?: DynamicQueueConfig;
  readonly secretStore?: SecretStore;
  readonly environment?: NodeJS.ProcessEnv;
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
  /** Authored source definition used as the semantic base for prompt-file refs. */
  readonly sourceDefinitionPath?: string;
  /** Execution-side semantic definition path; persistence continues to use the field above. */
  readonly executionSourceDefinitionPath?: string;
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
  private readonly promptFileResolver: PromptFileResolver;
  private readonly worktreeManager = new WorktreeManager();

  constructor(private readonly options: ExecutionPreviewServiceOptions) {
    this.promptFileResolver = new PromptFileResolver({
      workspaceRoot: options.workspaceRoot,
      namedRoots: options.namedWorkspaceRoots ?? [],
      trustedRoots: options.workspaceRoots?.length
        ? options.workspaceRoots
        : undefined,
      approvedExternalRoots: options.approvedExternalRoots,
      allowWorkflowRelativeReferences: options.allowWorkflowRelativeReferences,
    });
  }

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
    const semanticSourceDefinitionPath =
      "executionSourceDefinitionPath" in request
        ? request.executionSourceDefinitionPath
        : request.sourceDefinitionPath;
    const preparedSteps = await Promise.all(
      workflow.steps?.map((step) =>
        this.substituteStep(step, variables, semanticSourceDefinitionPath)
      ) ?? []
    );
    const preparedFinalStep = workflow.finalStep
      ? await this.substituteStep(
          workflow.finalStep,
          variables,
          semanticSourceDefinitionPath
        )
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
    const managedMcpServers = await new McpRegistryFileManager(
      this.options.workspaceRoot
    ).readAll();

    const resolvedTargets = new Map<number, ResolvedExecutionTarget>();
    const mcpNormalizationDiagnostics = new Map<
      number,
      readonly CompatibilityDiagnostic[]
    >();
    for (const target of targets) {
      if (isScriptStep(target.step)) {
        continue;
      }
      const resolution = resolveExecutionProperties(
        target.step,
        preparedWorkflow,
        {
          defaults: this.options.defaults,
          hostCanProvidePty: this.options.hostCanProvidePty,
        }
      );
      const normalized = await McpServerNormalizer.applyWithDiagnostics(
        resolution.properties,
        managedMcpServers,
        target.step.prompt
      );
      mcpNormalizationDiagnostics.set(target.stepIndex, normalized.diagnostics);
      resolvedTargets.set(target.stepIndex, {
        ...resolution,
        properties: normalized.properties,
      });
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

    const { dto: worktreePreview, executionWorkspace: worktreeExecutionWorkspace } =
      await this.buildWorktreePreview(preparedWorkflow);

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
          managedMcpServers,
          compatibilityDiagnostics,
          mcpNormalizationDiagnostics.get(target.stepIndex) ?? [],
          worktreePreview,
          worktreeExecutionWorkspace
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
      ...(worktreePreview ? { worktree: worktreePreview } : {}),
    };
  }

  private async buildStepPreview(
    target: PreviewStepTarget,
    workflow: PromptFile,
    allSteps: WorkflowStep[],
    variables: Record<string, string>,
    request: ExecutionPreviewRequest,
    resolvedTarget: ResolvedExecutionTarget | undefined,
    managedMcpServers: readonly ManagedMcpServer[],
    compatibilityDiagnostics: readonly CompatibilityDiagnostic[],
    mcpNormalizationDiagnostics: readonly CompatibilityDiagnostic[],
    worktreePreview: WorktreeExecutionPreview | undefined,
    worktreeExecutionWorkspace: ExecutionWorkspace | undefined
  ): Promise<StepExecutionPreview> {
    const step = target.step;
    const promptStep = isScriptStep(step) ? this.scriptAsPrompt(step) : step;
    const targetResolution =
      resolvedTarget ??
      resolveExecutionProperties(promptStep, workflow, {
        defaults: this.options.defaults,
        hostCanProvidePty: this.options.hostCanProvidePty,
      });
    const properties = await McpServerNormalizer.apply(
      VarSubstitutor.applyToResolvedProperties(
        targetResolution.properties,
        variables
      ),
      managedMcpServers,
      promptStep.prompt
    );
    const secretNames = getEffectiveSecretGrants(promptStep, properties.secrets);
    const missingSecretNames = await findMissingSecretNames(secretNames, {
      workspaceRoot: this.options.workspaceRoot ?? "",
      secretStore: this.options.secretStore,
      environment: this.options.environment,
    });
    const secretDiagnostics: CompatibilityDiagnostic[] = missingSecretNames.map(
      (name) => ({
        code: COMPATIBILITY_DIAGNOSTIC_CODES.SECRETS_UNRESOLVED,
        severity: "error",
        harnessId: properties.harness,
        capability: "secrets",
        state: {
          fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
          mechanism: CAPABILITY_MECHANISMS.NONE,
          verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
        },
        message: `Secret "${name}" is missing for this step. Set it in the managed secret store or provide it through the host environment.`,
        remediation: "Resolve the secret before running this workflow.",
      })
    );
    const harness = await this.options.getHarness(
      properties.harness,
      worktreeExecutionWorkspace
    );
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
      Boolean(resolvedSessionId),
      secretNames
    );
    const variablesPreview = this.buildVariablesPreview(variables, request);
    const diagnostics = [
      ...this.stepDiagnostics(target, compatibilityDiagnostics),
      ...mcpNormalizationDiagnostics,
      ...secretDiagnostics,
    ];

    if (isScriptStep(step)) {
      const scriptCommand = this.buildScriptCommand(step, worktreePreview);
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

    if (!step.prompt.trim()) {
      throw new Error("Prompt is empty after resolving its prompt file");
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
      properties,
      worktreePreview
    );
    const permissionApplication = this.toPermissionPreview(
      executionPlan,
      properties,
      diagnostics
    );
    const mcpApplication = this.toMcpPreview(properties, executionPlan);
    const workspaceMutations = [
      ...promptPlan.mutations.map((mutation) =>
        this.toWorkspaceMutation(mutation)
      ),
      ...this.toWorkspaceMutations(executionPlan),
    ];
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
    variables: Record<string, string>,
    sourceDefinitionPath?: string
  ): Promise<WorkflowStep> {
    if (isScriptStep(step)) {
      return Promise.resolve({
        ...step,
        script: VarSubstitutor.substitute(step.script, variables),
      });
    }
    const substituted = VarSubstitutor.applyToPromptText(
      step.prompt,
      variables
    );
    return this.promptFileResolver
      .resolvePromptValue(substituted, sourceDefinitionPath)
      .then((prompt) => ({ ...step, prompt }));
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
    sessionPresent: boolean,
    secretNames: readonly string[]
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
      secrets: [...secretNames],
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

  /**
   * Read-only preview of the workflow's worktree configuration and, where
   * knowable without a real run identity, the directory it will execute in
   * plus the remapped `ExecutionWorkspace` prompt preparation should use for
   * that directory. Never creates a branch, worktree, or directory —
   * dry-run/preview only.
   *
   * The `executionWorkspace` result matters beyond the displayed command: a
   * worktree run's reference resolution (`@file`, `#selection`, `--add-dir`)
   * is scoped to the *execution* root, not the source checkout. Without this
   * remap, the preview would build attachments/`--add-dir` against the
   * source checkout and silently diverge from what the actual worktree run
   * does — see `WORKTREE_SUPPORT_PLAN.md`'s execution-workspace root split.
   * `executionWorkspace` is only populated when `plannedDirectory` is known
   * (always true for named mode; never for managed mode, whose directory
   * depends on a `RunRef` a dry run never allocates).
   */
  private async buildWorktreePreview(workflow: PromptFile): Promise<{
    dto?: WorktreeExecutionPreview;
    executionWorkspace?: ExecutionWorkspace;
  }> {
    const selection = resolveWorktreeSelection(
      workflow.worktree,
      ConfigurationUtils.getDefaultWorktree()
    );
    if (!selection.config || selection.config.mode === WORKTREE_MODES.NONE) {
      return {};
    }
    const { mode, branch, base } = selection.config;
    const workspaceRoot = this.options.workspaceRoot;
    const eligibility = await evaluateWorkspaceEligibility(
      this.options.namedWorkspaceRoots ?? []
    );
    if (!eligibility.eligible || !workspaceRoot) {
      return {
        dto: {
          mode,
          origin: selection.origin,
          branch,
          base,
          eligible: false,
          eligibilityReason:
            eligibility.reason ??
            "No workspace root is available to place a worktree.",
          plannedDirectoryIsExact: false,
        },
      };
    }

    const placement =
      mode === WORKTREE_MODES.MANAGED
        ? await previewWorktreePlacement({
            sourceCheckoutRoot: workspaceRoot,
            mode: "managed",
          })
        : branch
          ? await previewWorktreePlacement({
              sourceCheckoutRoot: workspaceRoot,
              mode: "named",
              branch,
            })
          : {
              isExact: false,
              notice: "Named worktree mode requires a branch.",
            };

    const executionWorkspace = placement.directory
      ? await this.worktreeManager.previewExecutionWorkspace(
          workspaceRoot,
          placement.directory,
          {
            stateRoot: workspaceRoot,
            namedWorkspaceRoots: this.options.namedWorkspaceRoots ?? [],
            workspaceRoots: this.options.workspaceRoots,
            approvedExternalRoots: this.options.approvedExternalRoots,
          }
        )
      : undefined;

    return {
      dto: {
        mode,
        origin: selection.origin,
        branch,
        base,
        eligible: true,
        plannedDirectory: placement.directory,
        plannedDirectoryIsExact: placement.isExact,
        plannedDirectoryNotice: placement.notice,
      },
      executionWorkspace,
    };
  }

  private toCommandPreview(
    plan: ExecutionPlan,
    provider: ICliProvider,
    properties: ResolvedProperties,
    worktreePreview: WorktreeExecutionPreview | undefined
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
    const requiresShellVerbatimArgs =
      plan.resolvedCommand.requiresShellVerbatimArgs ?? false;
    const displayShell: CommandDisplayShell = requiresShellVerbatimArgs
      ? "cmd"
      : defaultCommandDisplayShell(platform);
    const displayCommand = renderCommandForDisplay(
      executable,
      redactedArgs,
      displayShell,
      { requiresShellVerbatimArgs }
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
      displayShell,
      requiresShellVerbatimArgs,
      cwd: this.resolveCwd(worktreePreview),
      environmentKeys: [...environmentKeys],
    };
  }

  /** The default cwd, or the worktree's planned directory when one is known. */
  private resolveCwd(
    worktreePreview: WorktreeExecutionPreview | undefined
  ): string {
    return (
      worktreePreview?.plannedDirectory ??
      this.options.cwd ??
      this.options.workspaceRoot ??
      process.cwd()
    );
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

  private toWorkspaceMutation(
    mutation: PreparedMutation
  ): WorkspaceMutationPreview {
    const tempRoot = this.options.workspaceRoot
      ? this.normalizeComparisonPath(
          path.resolve(
            this.options.workspaceRoot,
            PATH_CONSTANTS.CTRLYOKE_DIR,
            PATH_CONSTANTS.TEMP_DIR
          )
        )
      : undefined;
    const mutationPath = mutation.path
      ? this.normalizeComparisonPath(path.resolve(mutation.path))
      : undefined;
    const relativePath =
      tempRoot && mutationPath
        ? path.relative(tempRoot, mutationPath)
        : undefined;
    const isRunLocal =
      !mutationPath ||
      (relativePath !== undefined &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath));
    const scope = isRunLocal
      ? PREVIEW_MUTATION_SCOPES.RUN_LOCAL
      : PREVIEW_MUTATION_SCOPES.SHARED;
    return {
      ...(mutation.path ? { path: mutation.path } : {}),
      scope,
      ownedKeys:
        mutation.ownedKeys ??
        (mutation.intendedContent
          ? this.extractOwnedKeys(mutation.intendedContent)
          : []),
      operation: mutation.path ? "write-or-update" : "process-local",
      ...(scope === PREVIEW_MUTATION_SCOPES.SHARED
        ? {
            warning: `Workspace-wide side effect: ${mutation.description ?? "the harness configuration will be updated"}.`,
          }
        : {}),
    };
  }

  private normalizeComparisonPath(value: string): string {
    return process.platform === "win32" ? value.toLowerCase() : value;
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

  private buildScriptCommand(
    step: ScriptStep,
    worktreePreview: WorktreeExecutionPreview | undefined
  ): CommandPreview {
    const isWindows = (this.options.platform ?? process.platform) === "win32";
    const executable = isWindows
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");
    const args = isWindows
      ? ["/d", "/s", "/c", step.script]
      : ["-c", step.script];
    // The whole script text is one verbatim argument to the shell
    // interpreter, not a per-arg-quoted command line, on either platform —
    // there is no other dialect to toggle to.
    const displayShell: CommandDisplayShell = isWindows ? "cmd" : "posix";
    const displayCommand = renderCommandForDisplay(
      executable,
      args,
      displayShell,
      { requiresShellVerbatimArgs: isWindows }
    );
    return {
      executable,
      args,
      displayCommand,
      displayShell,
      requiresShellVerbatimArgs: isWindows,
      cwd: this.resolveCwd(worktreePreview),
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

  /**
   * Collapse diagnostics that state the same fact in the same words while
   * retaining distinct authored locations. Analyzer diagnostics carry the
   * RFC 6901 pointer needed by the editor; a provider mapper's equivalent
   * location-less diagnostic is suppressed when that richer fact exists.
   */
  private dedupeDiagnostics(
    diagnostics: readonly CompatibilityDiagnostic[]
  ): CompatibilityDiagnostic[] {
    const baseKey = (diagnostic: CompatibilityDiagnostic): string =>
      JSON.stringify([
        diagnostic.code,
        diagnostic.harnessId,
        diagnostic.capability,
        diagnostic.message,
      ]);
    const locatedKeys = new Set(
      diagnostics
        .filter((diagnostic) => diagnostic.propertyPointer)
        .map(baseKey)
    );
    const seen = new Set<string>();
    return diagnostics.filter((diagnostic) => {
      const key = baseKey(diagnostic);
      if (!diagnostic.propertyPointer && locatedKeys.has(key)) return false;
      const locationKey = diagnostic.propertyPointer
        ? `${key}:${diagnostic.propertyPointer}`
        : key;
      if (seen.has(locationKey)) return false;
      seen.add(locationKey);
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

/** PowerShell is the default shell for this audience's terminals (VS Code
 * integrated terminal, Windows Terminal) — cmd.exe stays available as an
 * explicit dashboard toggle, not the default rendering. */
export function defaultCommandDisplayShell(
  platform: NodeJS.Platform
): CommandDisplayShell {
  return platform === "win32" ? "powershell" : "posix";
}
