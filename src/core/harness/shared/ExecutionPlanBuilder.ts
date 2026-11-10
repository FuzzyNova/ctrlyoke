import * as path from "path";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import type { ResolvedProperties } from "../../../utils/SettingsPropertyResolver";
import type { WorkflowStep } from "../../../types/CtrlYokeTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type { ToolPermissionConfig } from "../../../types/ExecutionPropertyTypes";
import { mergeServerDeniedTools } from "../../../types/ToolPermissionUtils";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  EXECUTION_MODES,
  HARNESS_IDS,
  type ExecutionMode,
} from "../../../types/DashboardConstants";
import {
  resolveCliCommand,
  type CliResolvedCommand,
} from "./CliLauncherResolver";
import type {
  IHarnessAdapter,
  HarnessAdapterPreparation,
} from "./interfaces/IHarnessAdapter";
import type {
  PermissionContext,
  ToolPermissionApplication,
} from "./interfaces/IToolPermissionMapper";
import {
  applyPreparedMutations,
  type PreparedMutation,
} from "./interfaces/PreparedMutation";
import type { CliExecutionSession } from "./CliExecutionSession";
import type { HarnessAdapterWorkflowContext } from "./HarnessAdapterUtils";
import { HarnessAdapterUtils } from "./HarnessAdapterUtils";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  EFFECTIVE_SANDBOX_KINDS,
  effectiveSandboxLabel,
} from "../../../types/DashboardConstants";
import { sandboxUnsupportedDiagnostic } from "../../../types/CompatibilityTypes";
import { Log } from "../../../utils/Log";
import { harnessSettingSandbox } from "./SandboxCapabilities";
import type {
  EffectiveSandbox,
  SandboxApplication,
} from "./interfaces/ISandboxMapper";
import { projectStateRoot } from "../../../utils/ProjectStatePaths";
import { runArtifactStem } from "../../../utils/WorkflowPaths";
import {
  needsUserHookLauncher,
  prepareUserHookLaunchers,
} from "./UserHookEnvironment";

export interface ExecutionPlanBuilderDeps {
  readonly provider: IHarnessAdapter;
  readonly getWorkspaceRoot: () => string | undefined;
  readonly getWorkspaceRoots: () => readonly string[];
  readonly getApprovedExternalRoots?: (
    workflowContext?: WorkflowContext
  ) => readonly string[];
  readonly getStateRoot?: () => string;
  readonly getExtensionPath: () => string;
  readonly getExecutionMode: () => ExecutionMode;
  readonly getInstallHookNotificationEvents: (
    hooksDisabled: boolean
  ) => import("../../../types/CtrlYokeTypes").HookEvent[];
  readonly resolveCliCommand?: typeof resolveCliCommand;
}

export interface ExecutionPlan {
  readonly resolvedCommand: CliResolvedCommand;
  /** The complete argv consumed by the resolved launcher, including prompt. */
  readonly args: string[];
  /** Arguments before launcher resolution, useful for preview consumers. */
  readonly cliArgs: string[];
  readonly mutations: PreparedMutation[];
  readonly providerPreparation: HarnessAdapterPreparation;
  readonly permissionApplication: ToolPermissionApplication;
  /** Provider preparation carries the provider-specific MCP application. */
  readonly mcpApplication: HarnessAdapterPreparation;
  readonly effectiveToolPermissions:
    ResolvedProperties["toolPermissions"] | undefined;
  readonly effectiveSandbox?: EffectiveSandbox;
  readonly diagnostics: HarnessAdapterPreparation["diagnostics"];
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
  workflowFile?: HarnessAdapterWorkflowContext["workflowFile"];
};

function asProviderWorkflowContext(
  workflowContext: WorkflowContext | undefined,
  stateRoot: string | undefined
): ProviderWorkflowContext | undefined {
  return workflowContext ? { ...workflowContext, stateRoot } : undefined;
}

function emptyPreparation(): HarnessAdapterPreparation {
  return { cliArgs: [], mutations: [], diagnostics: [] };
}

/**
 * Single source of truth for the argument and deferred-mutation order used by
 * real CLI execution and execution preview.
 */
export class ExecutionPlanBuilder {
  constructor(private readonly deps: ExecutionPlanBuilderDeps) {}

  async plan(
    session: CliExecutionSession,
    options: { allowUnsupportedSandboxPreview?: boolean } = {}
  ): Promise<ExecutionPlan> {
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
    const sandboxRequest = session.resolvedProperties?.sandbox;
    // A `true` inherited from `defaults.sandbox` is skipped on a harness that
    // can't sandbox; one written in the workflow or step refuses to launch.
    // Without the workflow file the request is treated as written (fail closed).
    const authoredWorkflow = session.workflowContext?.workflowFile;
    const requestFromDefaults =
      session.prompt.sandbox === undefined &&
      !!authoredWorkflow &&
      authoredWorkflow.sandbox === undefined;
    const sandboxApplication: SandboxApplication = this.deps.provider
      .sandboxMapper
      ? await this.deps.provider.sandboxMapper.prepare(sandboxRequest, {
          isInteractive,
          writableRoots: workspaceRoot
            ? HarnessAdapterUtils.getWorkspaceDirs(
                workspaceRoot,
                this.deps.getWorkspaceRoots(),
                approvedExternalRoots,
                workflowContext
              )
            : [],
          sandboxMode:
            session.resolvedProperties?.sandboxMode ??
            ConfigurationUtils.getDefaultSandboxMode(),
          requestFromDefaults,
          additionalArgs: session.resolvedProperties?.additionalArgs,
        })
      : sandboxRequest === true
        ? {
            ...harnessSettingSandbox(),
            diagnostics: [
              sandboxUnsupportedDiagnostic({
                harnessId: this.deps.provider.config.harnessId,
                fromDefaults: requestFromDefaults,
              }),
            ],
          }
        : harnessSettingSandbox();
    // An explicit request ctrlyoke cannot honor fails the launch; Dry Run
    // previews it as not sandboxed with the reason instead.
    const sandboxRefusal =
      sandboxApplication.diagnostics.find(
        (item) => item.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
      )?.message ??
      // Settings fragments travel in the hook settings file, which is
      // written under the workspace; without one they would not apply.
      // Only containment is refused; Off then just leaves the harness as is.
      (sandboxApplication.settings && !workspaceRoot && sandboxRequest === true
        ? `${this.deps.provider.config.displayName} sandboxing needs a workspace folder.`
        : undefined);
    if (sandboxRefusal && !options.allowUnsupportedSandboxPreview) {
      throw new Error(sandboxRefusal);
    }
    const settingsUnwritable = !!sandboxApplication.settings && !workspaceRoot;
    const effectiveSandbox: EffectiveSandbox = sandboxRefusal
      ? { kind: EFFECTIVE_SANDBOX_KINDS.OFF, detail: sandboxRefusal }
      : settingsUnwritable
        ? harnessSettingSandbox("no workspace folder for the settings file")
            .effective
        : sandboxApplication.effective;
    const sandboxSettings =
      sandboxRefusal || settingsUnwritable
        ? undefined
        : sandboxApplication.settings;
    if (!sandboxRefusal) {
      baseArgs.push(...sandboxApplication.cliArgs);
    }
    Log.info(
      `[Sandbox] ${effectiveSandboxLabel(effectiveSandbox.kind, effectiveSandbox.detail)}`
    );
    if (
      session.imageFileRefs.length > 0 &&
      this.deps.provider.buildImageAttachmentArgs
    ) {
      baseArgs.push(
        ...this.deps.provider.buildImageAttachmentArgs(
          session.imageFileRefs,
          isInteractive
        )
      );
    }
    const mutations = [...providerPreparation.mutations];
    if (this.deps.provider.setSandboxSpawnEnv) {
      // Reset on every launch so one step's sandbox env never leaks into the next.
      const sandboxEnv = sandboxRefusal ? {} : (sandboxApplication.env ?? {});
      mutations.push({
        description: "Set sandbox process environment",
        apply: async () => this.deps.provider.setSandboxSpawnEnv!(sandboxEnv),
      });
    }
    const hookPreparations: HarnessAdapterPreparation[] = [];
    const tempFilePaths: string[] = [];
    const deferredHookEnvironmentFilePaths: string[] = [];

    if (workspaceRoot) {
      const resolvedHooks = session.workflowContext?.resolvedProperties?.hooks;
      const hooksExplicitlyDisabled = resolvedHooks === null;
      const originalUserHooks = resolvedHooks ?? undefined;
      const userHooks = originalUserHooks ? [...originalUserHooks] : undefined;
      const enabledNotificationHookEvents =
        this.deps.getInstallHookNotificationEvents(hooksExplicitlyDisabled);
      const promptIndex = session.workflowContext?.promptIndex ?? 0;
      const workingFilePath = session.workflowContext?.workingFilePath;
      let hookEnvironmentMutation: PreparedMutation | undefined;

      if (
        userHooks &&
        needsUserHookLauncher(
          originalUserHooks,
          this.deps.provider.config.harnessId
        )
      ) {
        const stateRoot = this.deps.getStateRoot?.() ?? workspaceRoot;
        const hookTempDirectory = path.join(
          projectStateRoot(stateRoot, "user"),
          "temp",
          "hook-environments"
        );
        const hookEnvironment = prepareUserHookLaunchers({
          hooks: userHooks,
          harnessId: this.deps.provider.config.harnessId,
          extensionPath,
          hookTempDirectory,
          promptIndex,
          ...(this.deps.provider.config.harnessId === HARNESS_IDS.QWEN_CLI &&
          workingFilePath
            ? {
                stableFileStem: `${runArtifactStem(workingFilePath)}-${promptIndex}`,
              }
            : {}),
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
              enabledNotificationHookEvents,
              sandboxSettings
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
        : (!hooksExplicitlyDisabled || sandboxSettings !== undefined) &&
            this.deps.provider.planHeadlessUserHookArgs
          ? await this.deps.provider.planHeadlessUserHookArgs(
              extensionPath,
              workspaceRoot,
              promptIndex,
              workingFilePath,
              userHooks,
              enabledNotificationHookEvents,
              sandboxSettings
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
          session.resolvedProperties?.mcpServers,
          this.deps.provider.toolPermissionMapper.normalizeMcpServerId,
          this.deps.provider.toolPermissionMapper.formatMcpToolName
        )
      : session.resolvedProperties?.toolPermissions;
    // The same directories `--add-dir` harnesses receive, minus the launch
    // directory itself (the first entry).
    const externalDirectories = workspaceRoot
      ? HarnessAdapterUtils.getWorkspaceDirs(
          workspaceRoot,
          this.deps.getWorkspaceRoots(),
          approvedExternalRoots,
          workflowContext
        ).slice(1)
      : [];
    const permissionContext: PermissionContext = {
      isInteractive,
      workspaceRoot,
      externalDirectories,
      workingFilePath: session.workflowContext?.workingFilePath,
      environment: HarnessAdapterUtils.buildProcessEnv(),
      additionalArgs: session.resolvedProperties?.additionalArgs,
      mcpServers: session.resolvedProperties?.mcpServers,
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
      effectiveSandbox,
      diagnostics: [
        ...providerPreparation.diagnostics,
        ...sandboxApplication.diagnostics,
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
