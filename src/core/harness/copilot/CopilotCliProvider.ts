import * as path from "path";
import * as fs from "fs/promises";
import { randomUUID } from "crypto";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import {
  HARNESS_IDS,
  HEADLESS_SOURCE_MODES,
  PERSISTENT_VALUE_INSTALL_RESULT_KINDS,
  STATUS_LINE_HARNESS_IDS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../../types/DashboardConstants";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import { CopilotNotificationMonitor } from "./CopilotNotificationMonitor";
import { CopilotToolPermissionMapper } from "./CopilotToolPermissionMapper";
import { CopilotLogParser } from "./CopilotLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import {
  isCliModelSupported,
  isRegistryInitialized,
} from "../../../utils/ModelRegistry";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import {
  CliProviderUtils,
  hasCtrlYokeServer,
} from "../shared/CliProviderUtils";
import { CliParseUtils } from "../shared/CliParseUtils";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import {
  StatuslineManager,
  type StatuslineInstallResult,
} from "../shared/StatuslineManager";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import type { HarnessCapabilityFacts } from "../../../types/CompatibilityTypes";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  HookEvent,
  PromptFile,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import {
  applyPreparedMutations,
  type CliProviderPreparation,
  type PreparedMutation,
} from "../shared/interfaces/PreparedMutation";
import { COPILOT_EVENT_TYPES } from "./CopilotProtocolConstants";

const COPILOT_MCP_FILTERING_CAPABILITY = {
  fidelity: "exact",
  mechanism: "translated-cli",
  verification: {
    kind: "manual",
    reference:
      "dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping",
    basis: "cli-version",
    verifiedVersions: [">=0.0.384"],
  },
} as const;

const COPILOT_IMAGE_INPUT_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: {
    kind: "manual",
    reference:
      "https://docs.github.com/en/copilot/github-copilot-in-the-cli/using-github-copilot-in-the-cli#adding-files-to-your-prompt",
    basis: "cli-version",
    verifiedVersions: [">=0.0.384"],
  },
} as const;

/**
 * Copilot CLI Harness
 *
 * Implements all Copilot-specific logic using composition pattern:
 * - Log file monitoring and sessionEnd hook for completion detection
 * - JSONL output adaptation in headless mode (--output-format json)
 * - Tool permission conversion with read-only tool filtering
 * - MCP server configuration with "local" type and tools field
 * - Session ID from result.sessionId in JSON output; log file discovery as fallback
 *
 * This provider aggregates four specialized components:
 * - CopilotNotificationMonitor: Monitors sessionEnd hook notifications
 * - CopilotToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration files (shared)
 *
 * Usage:
 * ```typescript
 * const provider = new CopilotCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class CopilotCliProvider implements ICliProvider {
  private static readonly CLI_COMMAND = "copilot";
  static readonly CLI_VERSION_COMMAND = `${CopilotCliProvider.CLI_COMMAND} --version`;
  static readonly CLI_HELP_COMMAND = `${CopilotCliProvider.CLI_COMMAND} --help`;

  private static readonly statuslineManager = StatuslineManager.forProvider(
    STATUS_LINE_HARNESS_IDS.COPILOT
  );

  readonly config: HarnessConfig = {
    name: "copilot",
    harnessId: HARNESS_IDS.COPILOT_CLI,
    displayName: "GitHub Copilot CLI",
    terminalName: "Copilot",
    installHint: "Install via: npm install -g @github/copilot",
    shouldStreamHeadlessOutput: true,

    // Copilot uses sessionEnd hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,

    // Headless mode uses --output-format json, so output is structured events (not raw text).
    rawTextOutput: false,
  };

  readonly notificationMonitor: INotificationMonitor =
    new CopilotNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CopilotToolPermissionMapper();
  get capabilities(): HarnessCapabilityFacts {
    return {
      permissions: this.toolPermissionMapper.capabilities,
      hooks: CopilotNotificationMonitor.CAPABILITIES,
      mcp: {
        perServerToolFiltering: COPILOT_MCP_FILTERING_CAPABILITY,
      },
      promptInputs: { images: COPILOT_IMAGE_INPUT_CAPABILITY },
    };
  }
  readonly logParser = new CopilotLogParser();
  readonly headlessSource = HEADLESS_SOURCE_MODES.STDOUT;

  /** Convert Copilot's JSONL stdout into the event vocabulary of CopilotLogParser. */
  parseHeadlessStdout(stdout: string): BaseCliEvent[] {
    return CliParseUtils.parseJsonLines(stdout) as BaseCliEvent[];
  }

  /** Extract the session ID carried by Copilot's final result event. */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const result = CliParseUtils.parseJsonLines(chunk).find(
      (event) =>
        event.type === COPILOT_EVENT_TYPES.RESULT &&
        typeof event.sessionId === "string"
    );
    return result?.sessionId as string | undefined;
  }

  /** Hook files created for both interactive and headless mode (cleaned up after workflow). */
  private hookFilePaths: string[] = [];
  /** Path to temporary .gitignore written in .github/hooks/ to hide ctrlyoke files from git. */
  private hooksDirGitignorePath: string | undefined;
  private enablePromptModeRepoHooksForHeadlessRun = false;
  /**
   * Per-invocation path for Copilot's OpenTelemetry file exporter, generated fresh in
   * buildCliArgs() each prompt. Feeds live context-window tracking (see CopilotLogParser's
   * OTel section) since Copilot CLI 1.0.x removed every other per-turn context signal.
   */
  private otelFilePath: string | undefined;
  private statusLineToken: string | undefined;
  private readonly statusLineSnapshotPaths = new Set<string>();
  private statusLineDirectory: string | undefined;
  private statusLineWorkspaceRoot: string | undefined;
  private statusLineEnabledForPrompt = false;
  private statuslineInstallResult: StatuslineInstallResult | undefined;

  consumeStatuslineInstallResult(): StatuslineInstallResult | undefined {
    const result = this.statuslineInstallResult;
    this.statuslineInstallResult = undefined;
    return result;
  }

  constructor() {
    // No initialization needed
  }

  /**
   * Build complete CLI arguments array for Copilot CLI execution
   *
   * Handles all Copilot-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Tool permissions (--allow-all-tools, --allow-tool, --deny-tool)
   * - Path permissions (--allow-all-paths)
   * - Logging configuration (--log-dir, --log-level)
   * - Workspace directories (--add-dir)
   * - Model selection (--model)
   * - Session management (--resume)
   * - sessionEnd hook (interactive mode only)
   *
   * Note: --output-format json is added by buildHeadlessArgs(), not here.
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param context Extension context for accessing scripts/paths
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for MCP configuration
   * @returns Complete CLI arguments array (without prompt - that's handled separately)
   */
  async buildCliArgs(
    prompt: PromptStep,
    isInteractive: boolean,
    extensionPath: string,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: WorkflowStep[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workingFilePath?: string;
      stateRoot?: string;
      secretEnvironment?: Readonly<Record<string, string>>;
      workflowFile?: Pick<PromptFile, "trustedExternalRoots">;
    },
    workspaceRoots?: readonly string[],
    approvedExternalRoots?: readonly string[]
  ): Promise<string[]> {
    const preparation = await this.planCliArgs(
      prompt,
      isInteractive,
      extensionPath,
      workspaceRoot,
      sessionId,
      workflowContext,
      workspaceRoots,
      approvedExternalRoots
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planCliArgs(
    _prompt: PromptStep,
    _isInteractive: boolean,
    extensionPath: string,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: WorkflowStep[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workingFilePath?: string;
      stateRoot?: string;
      secretEnvironment?: Readonly<Record<string, string>>;
      workflowFile?: Pick<PromptFile, "trustedExternalRoots">;
    },
    workspaceRoots?: readonly string[],
    approvedExternalRoots?: readonly string[]
  ): Promise<CliProviderPreparation> {
    const statusLineToken = randomUUID();
    // Generate a fresh per-invocation OTel export path (or clear it) every prompt.
    // Must run unconditionally — the parser/provider instances are reused across
    // prompts, so a stale path from a previous invocation must never leak forward.
    const otelFilePath = workspaceRoot
      ? path.join(
          workspaceRoot,
          PATH_CONSTANTS.CTRLYOKE_DIR,
          PATH_CONSTANTS.TEMP_DIR,
          CopilotCliProvider.buildOtelFileName(
            workflowContext?.promptIndex ?? 0,
            workflowContext?.workingFilePath
          )
        )
      : undefined;
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    // This ensures workflow-level defaults are respected
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension is enabled)
    const mcpPreparation = await CliProviderUtils.planMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.planMcpConfigArgs(
          serverPath,
          wsRoot,
          workingFile,
          additionalEnv,
          userServers,
          workflowContext?.stateRoot,
          workflowContext?.secretEnvironment
        )
    );
    if (
      mcpPreparation.cliArgs.length > 0 ||
      mcpPreparation.mutations.length > 0
    ) {
      args.push(...mcpPreparation.cliArgs);
      // Auto-approve ctrlyoke MCP tools only when the ctrlyoke server is included
      if (
        workflowContext?.resolvedProperties &&
        hasCtrlYokeServer(workflowContext.resolvedProperties)
      ) {
        args.push("--allow-tool", "ctrlyoke");
        Log.debug("[CopilotCliProvider] ctrlyoke MCP tools auto-approved");
      }

      // Auto-approve user-defined MCP server tools based on autoApprove config
      const mcpServers = workflowContext?.resolvedProperties?.mcpServers ?? [];
      for (const server of mcpServers) {
        if (typeof server === "object" && server.autoApprove) {
          if (server.autoApprove === true) {
            // Approve all tools from this server
            args.push("--allow-tool", server.id);
            Log.debug(
              `[CopilotCliProvider] Auto-approved all tools from MCP server: ${server.id}`
            );
          } else if (Array.isArray(server.autoApprove)) {
            // Approve specific tool patterns
            for (const pattern of server.autoApprove) {
              args.push("--allow-tool", pattern);
            }
            Log.debug(
              `[CopilotCliProvider] Auto-approved ${server.autoApprove.length} tool pattern(s) from MCP server: ${server.id}`
            );
          }
        }
      }
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(
        `[CopilotCliProvider] Extra CLI args applied (${appendTokens.length} tokens)`
      );
    }

    // Hook setup (interactive notification hooks + headless user hooks) is dispatched
    // by CliIntegration.runExecutionSession() via buildNotificationHookArgs() /
    // buildHeadlessUserHookArgs() — not here in buildCliArgs().
    // Permission preparation is similarly dispatched by CliIntegration — not here.

    // Workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(
        workspaceRoot,
        workspaceRoots,
        approvedExternalRoots,
        workflowContext
      );
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Model selection with validation - use resolved property if available
    const model = await this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.
    // No --agent CLI flag needed; this works with all providers (Copilot, Claude, Codex).

    // Session resumption
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      args.push("--resume", sessionId!);
      Log.info(`[CopilotCliProvider] Resuming session: ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.warn(
        "[CopilotCliProvider] Resume requested but no session ID available"
      );
    } else {
      Log.info("[CopilotCliProvider] Starting new session");
    }

    Log.trace(`[CopilotCliProvider] CLI arguments: ${JSON.stringify(args)}`);

    return {
      cliArgs: args,
      mutations: [
        {
          description: "Prepare Copilot statusline tracking",
          apply: async () => {
            this.statusLineToken = statusLineToken;
            this.statusLineDirectory = undefined;
            this.statusLineWorkspaceRoot = undefined;
            this.statusLineEnabledForPrompt = false;
            this.statuslineInstallResult = undefined;
            if (
              workspaceRoot &&
              ConfigurationUtils.getStatusLineHarnessSettings(
                STATUS_LINE_HARNESS_IDS.COPILOT
              ).enabled
            ) {
              this.statuslineInstallResult = await this.registerStatusLine(
                extensionPath,
                workspaceRoot
              );
            }
          },
        },
        {
          description: "Prepare Copilot prompt runtime state",
          apply: async () => {
            this.enablePromptModeRepoHooksForHeadlessRun = false;
            this.otelFilePath = otelFilePath;
            this.logParser.setOtelFilePath(otelFilePath);
          },
        },
        ...mcpPreparation.mutations,
      ],
      diagnostics: mcpPreparation.diagnostics,
    };
  }

  /**
   * Validate model is supported by Copilot CLI, fallback to default if not.
   * Lazily initializes the model registry if needed (e.g. CLI mode where
   * initializeModelRegistry() is never called during extension activation).
   */
  private async validateAndGetModel(requestedModel?: string): Promise<string> {
    const defaultModel = ConfigurationUtils.getCopilotCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    if (requestedModel === MODEL_NONE) {
      return "";
    }

    // Planning must remain side-effect free. The registry is normally loaded
    // during extension startup; when it is not, preserve the requested model
    // rather than spawning a discovery command while assembling a plan.
    if (!isRegistryInitialized()) {
      return requestedModel;
    }

    // Check if model is supported by CLI (using dynamically discovered models)
    if (isCliModelSupported(requestedModel)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Copilot CLI. Using default: ${defaultModel}`;
    Log.warn(`[CopilotCliProvider] ${message}`);

    return defaultModel;
  }

  /**
   * Set up ctrlyoke notification hooks (sessionEnd + user hooks) for interactive mode.
   *
   * Creates a uniquely-named hook file per prompt in `.github/hooks/` so that
   * parallel workflows don't interfere with each other. Copilot auto-discovers
   * all JSON files in the hooks directory, so each prompt's file is loaded
   * independently — no merging or ref-counting needed.
   *
   * @returns CLI arguments array (empty — Copilot auto-discovers hooks from .github/hooks/)
   */
  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planNotificationHookArgs(
      extensionPath,
      workspaceRoot,
      promptIndex,
      workingFilePath,
      userHooks,
      enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);
    const hookScriptPath = path.join(
      extensionPath,
      "out/scripts/ctrlyoke-copilot-hook.js"
    );
    const hookConfig = this.notificationMonitor.buildHookConfig(
      hookScriptPath,
      notifyDir,
      workspaceRoot,
      userHooks,
      [
        ...new Set<HookEvent>([
          "sessionStart",
          "stop",
          ...enabledNotificationHookEvents,
        ]),
      ]
    );
    const hookFileName = CopilotCliProvider.buildHookFileName(
      promptIndex,
      workingFilePath
    );
    const hookPath = this.getHookFilePath(workspaceRoot, hookFileName);
    return {
      cliArgs: [],
      mutations: [
        this.createHookMutation(
          workspaceRoot,
          hookPath,
          JSON.stringify((hookConfig as { config?: object }).config, null, 2),
          "Write Copilot notification hook"
        ),
      ],
      diagnostics: [],
    };
  }

  /**
   * Create a hook file with only user-defined hooks for headless execution.
   * No ctrlyoke notification hooks are needed since headless uses process-exit for completion.
   *
   * @returns CLI arguments array (empty — Copilot auto-discovers hooks from .github/hooks/)
   */
  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planHeadlessUserHookArgs(
      extensionPath,
      workspaceRoot,
      promptIndex,
      workingFilePath,
      userHooks,
      enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
    const hasUserHooks = userHooks && userHooks.length > 0;
    const hasPromptModeHooks =
      !!hasUserHooks || enabledNotificationHookEvents.length > 0;
    if (!hasUserHooks && enabledNotificationHookEvents.length === 0) {
      return {
        cliArgs: [],
        mutations: [this.createHeadlessHookStateMutation(hasPromptModeHooks)],
        diagnostics: [],
      };
    }
    const config =
      enabledNotificationHookEvents.length > 0
        ? this.notificationMonitor.buildHookConfig(
            path.join(
              extensionPath,
              "out",
              "scripts",
              "ctrlyoke-copilot-hook.js"
            ),
            this.notificationMonitor.getNotificationDirectory(workspaceRoot),
            workspaceRoot,
            userHooks,
            enabledNotificationHookEvents
          )
        : {
            type: "json",
            config: CopilotNotificationMonitor.buildUserOnlyConfig(
              userHooks ?? []
            ),
          };
    const hookFileName = CopilotCliProvider.buildHookFileName(
      promptIndex,
      workingFilePath
    );
    const hookPath = this.getHookFilePath(workspaceRoot, hookFileName);
    return {
      cliArgs: [],
      mutations: [
        this.createHeadlessHookStateMutation(hasPromptModeHooks),
        this.createHookMutation(
          workspaceRoot,
          hookPath,
          JSON.stringify((config as { config?: object }).config, null, 2),
          "Write Copilot headless hook"
        ),
      ],
      diagnostics: [],
    };
  }

  private getHookFilePath(workspaceRoot: string, hookFileName: string): string {
    return path.join(workspaceRoot, ".github", "hooks", hookFileName);
  }

  private createHeadlessHookStateMutation(enabled: boolean): PreparedMutation {
    return {
      description: "Set Copilot headless repository-hook mode",
      apply: async () => {
        this.enablePromptModeRepoHooksForHeadlessRun = enabled;
      },
    };
  }

  private createHookMutation(
    workspaceRoot: string,
    hookPath: string,
    content: string,
    description: string
  ): PreparedMutation {
    const hookFileName = path.basename(hookPath);
    return {
      path: hookPath,
      intendedContent: content,
      // Copilot discovers each per-prompt hook file independently; this is
      // not a partial merge into an existing settings file.
      ownedKeys: [],
      description,
      apply: async () => {
        await this.createHookFile(
          { type: "json", config: JSON.parse(content) },
          workspaceRoot,
          hookFileName
        );
      },
      restore: async () => {
        await fs.unlink(hookPath).catch(() => undefined);
      },
    };
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = this.enablePromptModeRepoHooksForHeadlessRun
      ? { GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: "true" }
      : {};
    return {
      ...env,
      ...this.buildOtelSpawnEnv(),
      ...this.buildStatusLineSpawnEnv(),
    };
  }

  /**
   * Redirect Copilot's OpenTelemetry file exporter to this invocation's dedicated path.
   *
   * Overriding this is necessary, not optional: some environments already have
   * COPILOT_OTEL_FILE_EXPORTER_PATH set globally (observed pointed at the Windows null
   * device, `\\.\nul`), which silently discards the only live context-window signal
   * Copilot CLI 1.0.x still exposes. Explicitly setting both vars here ensures ctrlyoke
   * always gets the data regardless of what the user's shell environment does.
   */
  private buildOtelSpawnEnv(): NodeJS.ProcessEnv {
    if (!this.otelFilePath) {
      return {};
    }
    return {
      COPILOT_OTEL_ENABLED: "true",
      COPILOT_OTEL_FILE_EXPORTER_PATH: this.otelFilePath,
    };
  }

  /**
   * Interactive spawn env: base process env plus the OTel export path override.
   * Copilot has no other reason to need env overrides in interactive mode today,
   * unlike Claude's CLAUDECODE removal — this exists solely to carry the OTel vars.
   */
  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...CliProviderUtils.buildProcessEnv(),
      ...this.buildOtelSpawnEnv(),
      ...this.buildStatusLineSpawnEnv(),
    };
  }

  private async registerStatusLine(
    extensionPath: string,
    workspaceRoot: string
  ): Promise<StatuslineInstallResult> {
    const scriptPath =
      await CopilotCliProvider.statuslineManager.resolveScriptPath(
        extensionPath
      );
    if (!scriptPath) {
      Log.warn(
        `[CopilotCliProvider] Skipping Copilot statusline: no statusline script under ${extensionPath}`
      );
      return { kind: "no-op", captured: false };
    }
    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      ""
    ).trim();
    const snapshotDirectory = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR
    );
    const snapshotPath = path.join(
      snapshotDirectory,
      `copilot-statusline-${this.statusLineToken}.json`
    );
    this.statusLineSnapshotPaths.add(snapshotPath);

    try {
      const result = await CopilotCliProvider.statuslineManager.install(
        workspaceRoot,
        command
      );
      if (result.kind !== PERSISTENT_VALUE_INSTALL_RESULT_KINDS.DECLINED) {
        this.statusLineDirectory = snapshotDirectory;
        this.statusLineWorkspaceRoot = workspaceRoot;
        this.statusLineEnabledForPrompt = true;
      }
      return result;
    } catch (error) {
      Log.warn(
        `[CopilotCliProvider] Failed to register Copilot statusline: ${error}`
      );
      return { kind: "no-op", captured: false };
    }
  }

  private buildStatusLineSpawnEnv(): NodeJS.ProcessEnv {
    if (
      !this.statusLineEnabledForPrompt ||
      !this.statusLineToken ||
      !this.statusLineDirectory
    ) {
      return {};
    }

    return {
      CTRLYOKE_COPILOT_STATUSLINE_TOKEN: this.statusLineToken,
      CTRLYOKE_COPILOT_STATUSLINE_DIR: this.statusLineDirectory,
      ...(this.statusLineWorkspaceRoot
        ? { CTRLYOKE_STATUSLINE_WORKSPACE_ROOT: this.statusLineWorkspaceRoot }
        : {}),
    };
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const config =
      ConfigurationUtils.resolveSpawnToolPermissions(toolPermissions);
    if (config === null) {
      return { cliArgs: [], diagnostics: [] };
    }
    return this.toolPermissionMapper.prepare(config, context);
  }

  /**
   * Delete hook files written for the previous prompt before building hooks for the next.
   * Prevents .github/hooks/ from accumulating files across prompts — Copilot CLI reads
   * every JSON file in that directory, so leftover files would cause previous-prompt
   * hooks to fire during subsequent prompts.
   */
  async cleanupPreviousPromptHooks(_workspaceRoot: string): Promise<void> {
    for (const hookPath of this.hookFilePaths) {
      await fs.unlink(hookPath).catch(() => {});
    }
    this.hookFilePaths = [];
  }

  /**
   * Return additional file paths to delete after workflow cleanup.
   *
   * Includes all per-prompt hook files created during this workflow's
   * interactive and headless sessions, plus this invocation's Copilot OTel
   * telemetry file (see buildOtelSpawnEnv()).
   *
   * Note: the .gitignore is NOT deleted here. Deletion is deferred to
   * cleanupWorkspaceArtifacts() so we can check whether concurrent workflows
   * still have hook files on disk before removing it.
   */
  getAdditionalCleanupFilePaths(workspaceRoot: string): string[] {
    return [
      ...this.hookFilePaths,
      ...this.statusLineSnapshotPaths,
      ...(this.otelFilePath ? [this.otelFilePath] : []),
      // Defensive: some environments have COPILOT_OTEL_FILE_EXPORTER_PATH set globally
      // to the relative path "NUL" (observed pointed at the Windows null device via
      // \\.\nul). buildOtelSpawnEnv() always overrides this for our own spawns, but
      // clean up the stray file anyway in case anything ever bypasses that override —
      // when CWD is the workspace root, "NUL" resolves to a real file, not the device.
      path.join(workspaceRoot, "NUL"),
    ];
  }

  /**
   * Delete the temporary .gitignore if no concurrent workflows still have
   * ctrlyoke hook files on disk. Called after getAdditionalCleanupFilePaths()
   * has already removed this workflow's own hook files.
   *
   * Does not rely on hooksDirGitignorePath being set: even when a concurrent
   * workflow wrote the gitignore (so this instance never set hooksDirGitignorePath),
   * we still clean it up if it's ours and the directory is now empty.
   */
  async cleanupWorkspaceArtifacts(workspaceRoot: string): Promise<void> {
    const hookDir = path.join(workspaceRoot, ".github", "hooks");
    try {
      const files = await fs.readdir(hookDir);
      const hasOtherHookFiles = files.some(
        (f) => f.startsWith("ctrlyoke-") && f.endsWith(".json")
      );
      if (hasOtherHookFiles) {
        return; // Concurrent workflow still active — leave gitignore in place
      }
      // No ctrlyoke hook files remain. Delete the gitignore only if it's ours.
      if (files.includes(".gitignore")) {
        const gitignorePath =
          this.hooksDirGitignorePath ?? path.join(hookDir, ".gitignore");
        await this.deleteCtrlYokeGitignore(gitignorePath);
      }
      this.hooksDirGitignorePath = undefined;
    } catch {
      // Directory doesn't exist — nothing to clean up
      this.hooksDirGitignorePath = undefined;
    }
  }

  /**
   * Delete a .gitignore only if it was written by ctrlyoke (identified by
   * our magic header comment). Leaves user-owned gitignore files untouched.
   */
  private async deleteCtrlYokeGitignore(gitignorePath: string): Promise<void> {
    try {
      const content = await fs.readFile(gitignorePath, "utf-8");
      if (content.startsWith("# ctrlyoke temp files")) {
        await fs.unlink(gitignorePath).catch(() => {});
      }
    } catch {
      // File doesn't exist or unreadable — nothing to do
    }
  }

  /**
   * Create a per-prompt hook file for Copilot in .github/hooks/.
   */
  private async createHookFile(
    hookConfig: any,
    workspaceRoot: string,
    hookFileName: string
  ): Promise<void> {
    try {
      const hookDir = path.join(workspaceRoot, ".github", "hooks");

      // Security: Validate that the resolved hook path stays within the workspace root.
      const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
      const resolvedHookDir = path.resolve(hookDir);
      if (!resolvedHookDir.startsWith(normalizedWorkspaceRoot)) {
        Log.error(
          `[CopilotCliProvider] Security: Hook directory "${resolvedHookDir}" is outside workspace root "${normalizedWorkspaceRoot}"`
        );
        return;
      }

      await fs.mkdir(hookDir, { recursive: true });
      await this.writeHookDirGitignore(hookDir);

      const hookPath = path.join(hookDir, hookFileName);
      await fs.writeFile(
        hookPath,
        JSON.stringify(hookConfig.config, null, 2),
        "utf-8"
      );

      this.hookFilePaths.push(hookPath);
      Log.debug(`[CopilotCliProvider] Created hook file: ${hookPath}`);
    } catch (error) {
      Log.warn(`[CopilotCliProvider] Failed to create hook file: ${error}`);
    }
  }

  /**
   * Write a temporary .gitignore to .github/hooks/ to prevent ctrlyoke hook files
   * from appearing as untracked in git. The .gitignore hides itself too so git never
   * sees either file. No-op if a .gitignore already exists there (user-owned file).
   */
  private async writeHookDirGitignore(hookDir: string): Promise<void> {
    if (this.hooksDirGitignorePath) {
      return; // Already written for this workflow
    }
    const gitignorePath = path.join(hookDir, ".gitignore");
    try {
      await fs.access(gitignorePath);
      return; // Existing .gitignore — leave it alone
    } catch {
      // File doesn't exist — write it
    }
    const content = [
      "# ctrlyoke temp files (auto-managed, do not commit)",
      "ctrlyoke-*.json",
      ".gitignore",
      "",
    ].join("\n");
    await fs.writeFile(gitignorePath, content, "utf-8").catch(() => {});
    this.hooksDirGitignorePath = gitignorePath;
  }

  /**
   * Build a unique hook filename for a prompt.
   *
   * Format: `ctrlyoke-<stem>-p<promptIndex>.json`
   * where stem is derived from the working file basename (already contains a
   * timestamp and workflow name), or falls back to a timestamp.
   *
   * Examples:
   * - `ctrlyoke-1774891046-my-workflow-p0.json`
   * - `ctrlyoke-1774891046-my-workflow-p1.json`
   * - `ctrlyoke-1774891200-p0.json` (fallback when no workingFilePath)
   */
  private static buildHookFileName(
    promptIndex: number,
    workingFilePath?: string
  ): string {
    let stem: string;
    if (workingFilePath) {
      // Working file is like "1774891046-my-workflow.ctrlyoke.json"
      // Strip extensions to get "1774891046-my-workflow"
      stem = path.basename(workingFilePath).replace(/\.ctrlyoke\.json$/i, "");
    } else {
      stem = String(Date.now());
    }
    // Sanitize: keep alphanumeric, hyphens, underscores only
    const safeStem = stem.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    return `ctrlyoke-${safeStem}-p${promptIndex}.json`;
  }

  /**
   * Build a unique OTel export filename for a prompt, mirroring buildHookFileName()'s
   * naming convention (same collision profile — accepted there already).
   *
   * Format: `ctrlyoke-otel-<stem>-p<promptIndex>.jsonl`
   */
  private static buildOtelFileName(
    promptIndex: number,
    workingFilePath?: string
  ): string {
    let stem: string;
    if (workingFilePath) {
      stem = path.basename(workingFilePath).replace(/\.ctrlyoke\.json$/i, "");
    } else {
      stem = String(Date.now());
    }
    const safeStem = stem.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    return `ctrlyoke-otel-${safeStem}-p${promptIndex}.jsonl`;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Copilot requires --prompt flag to specify prompts.
   * Format: copilot --output-format json --prompt "..." [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.ctrlyoke/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // --output-format json enables structured JSONL output for reliable response/session parsing.
    return ["--output-format", "json", "--prompt", prompt, ...baseArgs];
  }

  /**
   * Build CLI arguments for interactive TUI mode
   *
   * Copilot interactive mode: copilot -i "prompt text" [args...]
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return ["-i", promptText, ...baseArgs];
  }

  /**
   * Generate MCP server configuration arguments for Copilot CLI
   *
   * Copilot CLI uses --additional-mcp-config @<file> format.
   * Config file format: JSON with "type": "local"/"http"/"sse" and "tools" field.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets CTRLYOKE_WORKING_FILE)
   * @returns CLI arguments array with --additional-mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    stateRoot?: string,
    secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<string[] | null> {
    const preparation = await this.planMcpConfigArgs(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers,
      stateRoot,
      secretEnvironment
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs.length > 0 ? preparation.cliArgs : null;
  }

  async planMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    stateRoot?: string,
    secretEnvironment?: Readonly<Record<string, string>>
  ): Promise<CliProviderPreparation> {
    try {
      // Generate MCP config JSON using shared utility
      // Copilot CLI requires "type": "local" and "tools" field for ctrlyoke server;
      // user servers need "type": "local"/"http"/"sse" and "tools": ["*"]
      const copilotUserServerConfig = {
        stdioType: "local",
        remoteTypeMap: { "streamable-http": "http", sse: "sse" },
        tools: ["*"] as string[],
      };
      const secretOptions = CliProviderUtils.createMcpSecretConfigOptions(
        (name) => `\${${name}}`,
        secretEnvironment
      );
      let configJson: string;
      if (mcpServerPath && userServers && userServers.length > 0) {
        configJson = CliMcpConfigGenerator.generateJsonConfigWithUserServers(
          mcpServerPath,
          workspaceRoot,
          userServers,
          { type: "local", tools: ["*"] },
          workingFilePath,
          additionalEnv,
          copilotUserServerConfig,
          stateRoot,
          secretOptions
        );
      } else if (mcpServerPath) {
        configJson = CliMcpConfigGenerator.generateJsonConfig(
          mcpServerPath,
          workspaceRoot,
          { type: "local", tools: ["*"] },
          workingFilePath,
          additionalEnv,
          stateRoot,
          secretOptions
        );
      } else if (userServers && userServers.length > 0) {
        configJson = CliMcpConfigGenerator.generateUserServersOnlyConfig(
          userServers,
          copilotUserServerConfig,
          secretOptions
        );
      } else {
        return { cliArgs: [], mutations: [], diagnostics: [] };
      }

      // Write to temp directory — use unique name per execution to avoid parallel workflow collisions
      const configPath = this.getMcpConfigFilePath(
        workingFilePath,
        workspaceRoot
      )!;
      return {
        cliArgs: ["--additional-mcp-config", `@${configPath}`],
        mutations: [
          CliMcpConfigGenerator.createFileMutation(
            configPath,
            configJson,
            "Write Copilot MCP configuration"
          ),
        ],
        diagnostics: [],
      };
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }
  }

  /**
   * Return the path of the MCP config file this provider writes.
   * Used by CliIntegration to delete the file after the workflow finishes.
   */
  getMcpConfigFilePath(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): string {
    return CliMcpConfigGenerator.getConfigFilePath(
      workingFilePath,
      workspaceRoot,
      "mcp-config"
    );
  }

  /**
   * Check if Copilot CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability(
      CopilotCliProvider.CLI_VERSION_COMMAND,
      {
        retryWindowsFileLockErrors: true,
      }
    );
  }

  /**
   * Get Copilot CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion(
      CopilotCliProvider.CLI_VERSION_COMMAND,
      {
        retryWindowsFileLockErrors: true,
      }
    );
  }

  /**
   * Extract session ID from session log files by matching prompt text.
   *
   * Fallback method used when the session ID is not available from hook notifications.
   * With the current Copilot hook format, session IDs are provided via sessionStart
   * notifications, making this a true fallback (e.g., hooks not configured or timed out).
   *
   * Uses prompt-text matching (via discoverSessionLog) to find the correct
   * session log among potentially many concurrent sessions, then extracts
   * the session ID from the session.start event.
   *
   * @param promptText The prompt text that was sent (matched against user.message events)
   * @param startTime When execution started (filters to recently modified logs)
   * @returns Session ID (UUID) if found, undefined otherwise
   *
   * @remarks
   * **Why prompt matching instead of most-recent:**
   * Multiple Copilot CLI sessions may run concurrently. Grabbing the most
   * recently modified log would be a race condition. Instead, we match the
   * actual prompt text in the log's user.message event to find the correct session.
   *
   * **Discovery algorithm (delegated to CopilotLogParser.discoverSessionLog):**
   * 1. Find recently modified entries in `~/.copilot/session-state/`
   * 2. Read first 10 events from each candidate
   * 3. Match user.message content against first 100 chars of promptText
   * 4. Return the matching session's log path
   * 5. Extract session ID from session.start event
   */
  /**
   * Augment JSON-mode headless output with context window data from Copilot log files.
   *
   * Copilot's --output-format json stdout contains per-turn output and cache
   * token details; cumulative input-token totals still come from OTel when it
   * is available.
   * Fallback sources are tried in order:
   *
   * 1. **OpenTelemetry chat spans** (this invocation's `otelFilePath`, see `buildOtelSpawnEnv()`)
   *    By the time headless collection runs, the process has already exited, so the file
   *    is complete — one poll picks up every span written this invocation. Most reliable:
   *    carries exact `gen_ai.usage.input_tokens` per turn, unlike the tiers below.
   *
   * 2. **Persisted session context events**
   *    Legacy session.truncation events carry both usage and the exact limit.
   *
   * 3. **session.shutdown's currentTokens** (same events.jsonl)
   *    Current Copilot versions persist the used-token count at process exit but not the
   *    effective limit. Preserve that numerator without inventing a model-based denominator.
   *
   * 4. **CompactionProcessor lines** (`~/.copilot/logs/process-*.log`)
   *    Legacy per-turn utilization line; observed to no longer fire reliably on
   *    current Copilot CLI versions, kept as a last-resort fallback.
   *
   * This is the permanent architecture — OTel is a third artifact, separate from both
   * stdout and the session log, and remains the source for context-window data.
   */
  async augmentParsedOutput(
    output: UniversalCliOutput
  ): Promise<UniversalCliOutput> {
    await this.logParser.pollOtelContextWindow();
    const otelUsage = this.logParser.getFinalOtelUsage();
    let enrichedOutput = output;
    if (otelUsage) {
      const hasExactContext =
        otelUsage.contextWindowUsedTokens !== undefined &&
        otelUsage.contextWindowSize !== undefined;
      const contextSummary = hasExactContext
        ? `, context ${otelUsage.contextWindowUsedTokens}/${otelUsage.contextWindowSize}`
        : "";
      Log.debug(
        `[CopilotCliProvider] Token usage from OTel: ${otelUsage.inputTokens} input/${otelUsage.outputTokens} output/${otelUsage.cachedInputTokens ?? 0} cached/${otelUsage.cacheCreatedTokens ?? 0} cache-created${contextSummary}`
      );
      const cachedInputTokens =
        output.metadata.usage?.cachedInputTokens ?? otelUsage.cachedInputTokens;
      const cacheCreatedTokens =
        output.metadata.usage?.cacheCreatedTokens ??
        otelUsage.cacheCreatedTokens;
      enrichedOutput = {
        ...output,
        metadata: {
          ...output.metadata,
          usage: {
            ...output.metadata.usage,
            inputTokens: otelUsage.inputTokens,
            outputTokens: otelUsage.outputTokens,
            totalTokens: otelUsage.totalTokens,
            // Headless JSON token_details is canonical when present. OTel is
            // the fallback for interactive-only attempts or missing fields.
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
            ...(cacheCreatedTokens !== undefined ? { cacheCreatedTokens } : {}),
            ...(hasExactContext
              ? {
                  contextWindowUsedTokens: otelUsage.contextWindowUsedTokens,
                  contextWindowSize: otelUsage.contextWindowSize,
                }
              : {}),
            totalConfidence: TOKEN_TOTAL_CONFIDENCE.ACCUMULATED,
          },
        },
      };
      if (hasExactContext) {
        return enrichedOutput;
      }
    }

    const sessionId = enrichedOutput.metadata.sessionId;
    if (!sessionId) {
      Log.debug(
        `[CopilotCliProvider] augmentParsedOutput: no sessionId in parsed metadata`
      );
      return enrichedOutput;
    }

    const contextData =
      await CopilotLogParser.extractContextDataFromLog(sessionId);
    const outputTokens = enrichedOutput.metadata.usage?.outputTokens ?? 0;

    if (contextData) {
      const { currentTokens, tokenLimit } = contextData;
      Log.debug(
        `[CopilotCliProvider] Context window from session log: ${currentTokens}/${tokenLimit ?? "unknown"} tokens`
      );
      return {
        ...enrichedOutput,
        metadata: {
          ...enrichedOutput.metadata,
          usage: {
            ...enrichedOutput.metadata.usage,
            inputTokens: currentTokens,
            outputTokens,
            contextWindowUsedTokens: currentTokens,
            ...(tokenLimit !== undefined
              ? { contextWindowSize: tokenLimit }
              : {}),
          },
        },
      };
    }

    // Final legacy fallback for versions that still write CompactionProcessor lines.
    const processCtx =
      await this.logParser.extractContextFromProcessLog(sessionId);
    if (!processCtx) {
      Log.debug(
        `[CopilotCliProvider] No context window data available for session ${sessionId}`
      );
      return enrichedOutput;
    }

    Log.debug(
      `[CopilotCliProvider] Context window from process log: ${processCtx.used}/${processCtx.size} tokens`
    );
    return {
      ...enrichedOutput,
      metadata: {
        ...enrichedOutput.metadata,
        usage: {
          ...enrichedOutput.metadata.usage,
          inputTokens: processCtx.used,
          outputTokens,
          contextWindowUsedTokens: processCtx.used,
          contextWindowSize: processCtx.size,
        },
      },
    };
  }

  async extractSessionIdFromLogs(
    promptText: string,
    startTime: Date
  ): Promise<string | undefined> {
    const logPath = await this.logParser.discoverSessionLog(
      promptText,
      startTime
    );
    if (!logPath) {
      Log.debug(
        "[CopilotCliProvider] Could not discover session log for prompt"
      );
      return undefined;
    }

    // Extract session ID from first event (stateless read, safe after monitoring)
    const sessionId = await this.logParser.extractSessionIdFromLogPath(logPath);
    return sessionId ?? undefined;
  }
}
