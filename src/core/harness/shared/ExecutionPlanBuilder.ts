import * as path from "path";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import type { WorkflowStep } from "../../../types/CtrlYokeTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import { mergeServerDeniedTools } from "../../../types/ToolPermissionUtils";
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

export interface ExecutionPlanBuilderDeps {
  readonly provider: ICliProvider;
  readonly getWorkspaceRoot: () => string | undefined;
  readonly getWorkspaceRoots: () => readonly string[];
  readonly getExtensionPath: () => string;
  readonly getExecutionMode: () => "interactive" | "headless";
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
    | ResolvedProperties["toolPermissions"]
    | undefined;
  readonly diagnostics: CliProviderPreparation["diagnostics"];
}

type ProviderWorkflowContext = {
  promptIndex: number;
  allPrompts: WorkflowStep[];
  filePath?: string;
  resolvedProperties?: ResolvedProperties;
  workingFilePath?: string;
};

function asProviderWorkflowContext(
  workflowContext: WorkflowContext | undefined
): ProviderWorkflowContext | undefined {
  return workflowContext;
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
        this.deps.getExecutionMode()) === "interactive";
    const workspaceRoot = this.deps.getWorkspaceRoot();
    const extensionPath = this.deps.getExtensionPath();
    const workflowContext = asProviderWorkflowContext(session.workflowContext);

    const providerPreparation = this.deps.provider.planCliArgs
      ? await this.deps.provider.planCliArgs(
          session.prompt,
          isInteractive,
          extensionPath,
          workspaceRoot,
          session.resolvedSessionId,
          workflowContext,
          this.deps.getWorkspaceRoots()
        )
      : {
          cliArgs: await this.deps.provider.buildCliArgs(
            session.prompt,
            isInteractive,
            extensionPath,
            workspaceRoot,
            session.resolvedSessionId,
            workflowContext,
            this.deps.getWorkspaceRoots()
          ),
          mutations: [],
          diagnostics: [],
        };
    const baseArgs = [...providerPreparation.cliArgs];
    const mutations = [...providerPreparation.mutations];
    const hookPreparations: CliProviderPreparation[] = [];

    if (workspaceRoot) {
      const resolvedHooks = session.workflowContext?.resolvedProperties?.hooks;
      const hooksExplicitlyDisabled = resolvedHooks === null;
      const userHooks = resolvedHooks ?? undefined;
      const enabledNotificationHookEvents = hooksExplicitlyDisabled
        ? []
        : this.deps.getEnabledHookNotificationEvents();
      const promptIndex = session.workflowContext?.promptIndex ?? 0;
      const workingFilePath = session.workflowContext?.workingFilePath;

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

    const effectiveToolPermissions = mergeServerDeniedTools(
      session.resolvedProperties?.toolPermissions,
      session.resolvedProperties?.mcpServers
    );
    const permissionContext: PermissionContext = {
      isInteractive,
      workspaceRoot,
      workingFilePath: session.workflowContext?.workingFilePath,
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
        : effectiveToolPermissions === null ||
            typeof this.deps.provider.toolPermissionMapper.prepare !==
              "function"
          ? { cliArgs: [], diagnostics: [] }
          : await this.deps.provider.toolPermissionMapper.prepare(
              effectiveToolPermissions ?? {
                mode: ConfigurationUtils.getCliToolPermissions(),
                allowedTools: ConfigurationUtils.getCliAllowedTools(),
                deniedTools: ConfigurationUtils.getCliDeniedTools(),
              },
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
    };
  }

  async apply(plan: ExecutionPlan): Promise<void> {
    await applyPreparedMutations(plan.mutations);
  }
}
