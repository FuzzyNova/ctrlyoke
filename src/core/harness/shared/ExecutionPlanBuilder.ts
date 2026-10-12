import * as path from "path";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import type { WorkflowStep } from "../../../types/CtrlYokeTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type { ToolPermissionConfig } from "../../../types/ExecutionPropertyTypes";
import { mergeServerDeniedTools } from "../../../types/ToolPermissionUtils";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  EXECUTION_MODES,
  type ExecutionMode,
} from "../../../types/DashboardConstants";
import {
  resolveCliCommand,
  type CliResolvedCommand,
} from "./CliLauncherResolver";
import type {
  ICliProvider,
  CliProviderPreparation,
} from "./interfaces/ICliProvider";
import type {
  PermissionContext,
  ToolPermissionApplication,
} from "./interfaces/IToolPermissionMapper";
import {
  applyPreparedMutations,
  type PreparedMutation,
} from "./interfaces/PreparedMutation";
import type { CliExecutionSession } from "./CliExecutionSession";
import type { CliProviderWorkflowContext } from "./CliProviderUtils";
import { CliProviderUtils } from "./CliProviderUtils";
import { projectStateRoot } from "../../../utils/ProjectStatePaths";
import {
  hasUserHookEnvironment,
  prepareUserHookEnvironments,
} from "./UserHookEnvironment";

export interface ExecutionPlanBuilderDeps {
  readonly provider: ICliProvider;
  readonly getWorkspaceRoot: () => string | undefined;
  readonly getWorkspaceRoots: () => readonly string[];
  readonly getApprovedExternalRoots?: (
    workflowContext?: WorkflowContext
  ) => readonly string[];
  readonly getStateRoot?: () => string;
  readonly getExtensionPath: () => string;
  readonly getExecutionMode: () => ExecutionMode;
  readonly getEnabledHookNotificationEvents: () => import("../../../types/CtrlYokeTypes").HookEvent[];
  readonly resolveCliCommand?: typeof resolveCliCommand;
}

export interface ExecutionPlan {
  readonly resolvedCommand: CliResolvedCommand;
  /** The complete argv consumed by the resolved launcher, including prompt. */
  readonly args: string[];
  /** Arguments before launcher resolution, useful for preview consumers. */
  readonly cliArgs: string[];
  readonly mutations: PreparedMutation[];
  readonly providerPreparation: CliProviderPreparation;
  readonly permissionApplication: ToolPermissionApplication;
  /** Provider preparation carries the provider-specific MCP application. */
  readonly mcpApplication: CliProviderPreparation;
  readonly effectiveToolPermissions:
    ResolvedProperties["toolPermissions"] | undefined;
  readonly diagnostics: CliProviderPreparation["diagnostics"];
  readonly tempFilePaths: string[];
  /** Hook environment files stay available for the lifetime of their hook config. */
  readonly deferredHookEnvironmentFilePaths: string[];
}

type ProviderWorkflowContext = {
  promptIndex: number;
  allPrompts: WorkflowStep[];
  filePath?: string;
  resolvedProperties?: ResolvedProperties;
  workingFilePath?: string;
  stateRoot?: string;
  secretEnvironment?: Readonly<Record<string, string>>;
  workflowFile?: CliProviderWorkflowContext["workflowFile"];
};

function asProviderWorkflowContext(
  workflowContext: WorkflowContext | undefined,
  stateRoot: string | undefined
): ProviderWorkflowContext | undefined {
  return workflowContext ? { ...workflowContext, stateRoot } : undefined;
}

function emptyPreparation(): CliProviderPreparation {
  return { cliArgs: [], mutations: [], diagnostics: [] };
}

/**
 * Single source of truth for the argument and deferred-mutation order used by
 * real CLI execution and execution preview.
 */
export class ExecutionPlanBuilder {
  constructor(private readonly deps: ExecutionPlanBuilderDeps) {}

  async plan(session: CliExecutionSession): Promise<ExecutionPlan> {
    const isInteractive =
      (session.resolvedProperties?.executionMode ??
        this.deps.getExecutionMode()) === EXECUTION_MODES.INTERACTIVE;
    const workspaceRoot = this.deps.getWorkspaceRoot();
    const extensionPath = this.deps.getExtensionPath();
    const workflowContext = asProviderWorkflowContext(
      session.workflowContext,
      this.deps.getStateRoot?.()
    );
    const approvedExternalRoots =
      this.deps.getApprovedExternalRoots?.(workflowContext) ?? [];

    const providerPreparation = this.deps.provider.planCliArgs
      ? await this.deps.provider.planCliArgs(
          session.prompt,
          isInteractive,
          extensionPath,
          workspaceRoot,
          session.resolvedSessionId,
          workflowContext,
          this.deps.getWorkspaceRoots(),
          approvedExternalRoots
        )
      : {
          cliArgs: await this.deps.provider.buildCliArgs(
            session.prompt,
            isInteractive,
            extensionPath,
            workspaceRoot,
            session.resolvedSessionId,
            workflowContext,
            this.deps.getWorkspaceRoots(),
            approvedExternalRoots
          ),
          mutations: [],
          diagnostics: [],
        };
    const baseArgs = [...providerPreparation.cliArgs];
    if (
      session.imageFileRefs.length > 0 &&
      this.deps.provider.buildImageAttachmentArgs
    ) {
      baseArgs.push(
        ...this.deps.provider.buildImageAttachmentArgs(session.imageFileRefs)
      );
    }
    const mutations = [...providerPreparation.mutations];
    const hookPreparations: CliProviderPreparation[] = [];
    const tempFilePaths: string[] = [];
    const deferredHookEnvironmentFilePaths: string[] = [];

    if (workspaceRoot) {
      const resolvedHooks = session.workflowContext?.resolvedProperties?.hooks;
      const hooksExplicitlyDisabled = resolvedHooks === null;
      const originalUserHooks = resolvedHooks ?? undefined;
      const userHooks = originalUserHooks
        ? [...originalUserHooks]
        : undefined;
      const enabledNotificationHookEvents = hooksExplicitlyDisabled
        ? []
        : this.deps.getEnabledHookNotificationEvents();
      const promptIndex = session.workflowContext?.promptIndex ?? 0;
      const workingFilePath = session.workflowContext?.workingFilePath;
      let hookEnvironmentMutation: PreparedMutation | undefined;

      if (userHooks && hasUserHookEnvironment(originalUserHooks)) {
        const stateRoot = this.deps.getStateRoot?.() ?? workspaceRoot;
        const hookTempDirectory = path.join(
          projectStateRoot(stateRoot, "user"),
          "temp",
          "hook-environments"
        );
        const hookEnvironment = prepareUserHookEnvironments({
          hooks: userHooks,
          harnessId: this.deps.provider.config.harnessId,
          extensionPath,
          hookTempDirectory,
          promptIndex,
        });
        userHooks.splice(0, userHooks.length, ...(hookEnvironment.hooks ?? []));
        if (hookEnvironment.tempFilePath) {
          deferredHookEnvironmentFilePaths.push(hookEnvironment.tempFilePath);
        }
        hookEnvironmentMutation = hookEnvironment.mutation;
      }

      if (
        !hooksExplicitlyDisabled &&
        this.deps.provider.cleanupPreviousPromptHooks
      ) {
        mutations.push({
          path: path.join(
            workspaceRoot,
            PATH_CONSTANTS.CTRLYOKE_DIR,
            PATH_CONSTANTS.TEMP_DIR
          ),
          description: "Remove previous prompt hook artifacts",
          apply: async () =>
            this.deps.provider.cleanupPreviousPromptHooks!(workspaceRoot),
        });
      }
      if (hookEnvironmentMutation) {
        mutations.push(hookEnvironmentMutation);
      }

      const hookPreparation = isInteractive
        ? this.deps.provider.planNotificationHookArgs
          ? await this.deps.provider.planNotificationHookArgs(
              extensionPath,
              workspaceRoot,
              promptIndex,
              workingFilePath,
              userHooks,
              enabledNotificationHookEvents
            )
          : this.deps.provider.buildNotificationHookArgs
            ? {
                cliArgs: await this.deps.provider.buildNotificationHookArgs(
                  extensionPath,
                  workspaceRoot,
                  promptIndex,
                  workingFilePath,
                  userHooks,
                  enabledNotificationHookEvents
                ),
                mutations: [],
                diagnostics: [],
              }
            : emptyPreparation()
        : !hooksExplicitlyDisabled &&
            this.deps.provider.planHeadlessUserHookArgs
          ? await this.deps.provider.planHeadlessUserHookArgs(
              extensionPath,
              workspaceRoot,
              promptIndex,
              workingFilePath,
              userHooks,
              enabledNotificationHookEvents
            )
          : !hooksExplicitlyDisabled &&
              this.deps.provider.buildHeadlessUserHookArgs
            ? {
                cliArgs: await this.deps.provider.buildHeadlessUserHookArgs(
                  extensionPath,
                  workspaceRoot,
                  promptIndex,
                  workingFilePath,
                  userHooks,
                  enabledNotificationHookEvents
                ),
                mutations: [],
                diagnostics: [],
              }
            : emptyPreparation();

      if (isInteractive) {
        baseArgs.push(...hookPreparation.cliArgs);
      } else {
        baseArgs.unshift(...hookPreparation.cliArgs);
      }
      mutations.push(...hookPreparation.mutations);
      hookPreparations.push(hookPreparation);
    }

    const mcpFiltering =
      this.deps.provider.capabilities?.mcp?.perServerToolFiltering;
    const translatesServerDenials =
      mcpFiltering?.fidelity === CAPABILITY_FIDELITIES.EXACT &&
      mcpFiltering.mechanism === CAPABILITY_MECHANISMS.TRANSLATED_CLI;
    const effectiveToolPermissions = translatesServerDenials
      ? mergeServerDeniedTools(
          session.resolvedProperties?.toolPermissions,
          session.resolvedProperties?.mcpServers
        )
      : session.resolvedProperties?.toolPermissions;
    const permissionContext: PermissionContext = {
      isInteractive,
      workspaceRoot,
      workingFilePath: session.workflowContext?.workingFilePath,
      environment: CliProviderUtils.buildProcessEnv(),
    };
    const permissionApplication: ToolPermissionApplication = this.deps.provider
      .planToolPermissions
      ? await this.deps.provider.planToolPermissions(
          effectiveToolPermissions,
          permissionContext
        )
      : this.deps.provider.prepareToolPermissions
        ? await this.deps.provider.prepareToolPermissions(
            effectiveToolPermissions,
            permissionContext
          )
        : await this.prepareWithMapper(
            effectiveToolPermissions,
            permissionContext
          );

    if (permissionApplication.workspaceMutation) {
      mutations.push(permissionApplication.workspaceMutation);
    }
    mutations.push(...(permissionApplication.mutations ?? []));
    baseArgs.push(...permissionApplication.cliArgs);

    const suffixArgs =
      this.deps.provider.buildCliSuffix?.(
        session.resolvedSessionId,
        workflowContext
      ) ?? [];
    baseArgs.push(...suffixArgs);

    const completeArgs = isInteractive
      ? this.deps.provider.buildInteractiveArgs(
          [...baseArgs],
          session.promptArgument
        )
      : this.deps.provider.buildHeadlessArgs(
          [...baseArgs],
          session.promptArgument
        );
    const resolveCommand = this.deps.resolveCliCommand ?? resolveCliCommand;
    const resolvedCommand = await resolveCommand(
      this.deps.provider.config.name,
      completeArgs
    );

    return {
      resolvedCommand,
      args: [...resolvedCommand.args],
      cliArgs: completeArgs,
      mutations,
      providerPreparation,
      permissionApplication,
      mcpApplication: providerPreparation,
      effectiveToolPermissions,
      diagnostics: [
        ...providerPreparation.diagnostics,
        ...hookPreparations.flatMap((application) => application.diagnostics),
        ...permissionApplication.diagnostics,
      ],
      tempFilePaths,
      deferredHookEnvironmentFilePaths,
    };
  }

  async apply(plan: ExecutionPlan): Promise<void> {
    await applyPreparedMutations(plan.mutations);
  }

  /** Fallback for providers without their own permission preparation hook. */
  private async prepareWithMapper(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const config =
      ConfigurationUtils.resolveSpawnToolPermissions(toolPermissions);
    const mapper = this.deps.provider.toolPermissionMapper;
    return config === null || typeof mapper.prepare !== "function"
      ? { cliArgs: [], diagnostics: [] }
      : mapper.prepare(config, context);
  }
}
