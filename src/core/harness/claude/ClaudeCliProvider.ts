import * as path from "path";
import * as fs from "fs/promises";
import { randomUUID } from "crypto";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import {
  HARNESS_IDS,
  STATUS_LINE_TRACKING_PROVIDERS,
} from "../../../types/DashboardConstants";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { ClaudeNotificationMonitor } from "./ClaudeNotificationMonitor";
import { ClaudeToolPermissionMapper } from "./ClaudeToolPermissionMapper";
import { ClaudeLogParser } from "./ClaudeLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import { getClaudeModelName, MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { CliParseUtils } from "../shared/CliParseUtils";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import {
  StatuslineManager,
  type StatuslineInstallResult,
} from "../shared/StatuslineManager";
import { ClaudeStatuslineSidecar } from "./ClaudeStatuslineSidecar";
import {
  CLAUDE_EVENT_TYPES,
  CLAUDE_HOOK_CONFIG_TYPES,
  CLAUDE_SYSTEM_SUBTYPES,
} from "./ClaudeProtocolConstants";
import type {
  CliExecutionSidecar,
  CliExecutionSidecarDeps,
} from "../shared/interfaces/ICliProvider";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import type { HarnessCapabilityFacts } from "../../../types/CompatibilityTypes";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  HookEvent,
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

const CLAUDE_MCP_FILTERING_CAPABILITY = {
  fidelity: "exact",
  mechanism: "translated-cli",
  verification: {
    kind: "manual",
    reference:
      "dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping",
    basis: "cli-version",
    verifiedVersions: [">=2.1.17"],
  },
} as const;

const CLAUDE_IMAGE_INPUT_CAPABILITY = {
  fidelity: "exact",
  mechanism: "native",
  verification: {
    kind: "manual",
    reference:
      "https://support.claude.com/en/articles/14554922-claude-code-user-faq",
    basis: "cli-version",
    verifiedVersions: [">=2.1.17"],
  },
} as const;

/**
 * Claude CLI Harness
 *
 * Implements all Claude-specific logic using composition pattern:
 * - Log file monitoring and Stop hook for completion detection
 * - Stream-json stdout adaptation for the shared Claude log event mapper
 * - Tool permission conversion with Anthropic tool name format (Bash, Write)
 * - MCP server configuration with "type": "stdio"
 * - Session discovery via log file analysis
 *
 * This provider aggregates four specialized components:
 * - ClaudeNotificationMonitor: Monitors Stop hook notifications
 * - ClaudeToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration files (shared)
 *
 * Usage:
 * ```typescript
 * const provider = new ClaudeCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class ClaudeCliProvider implements ICliProvider {
  private static readonly CLI_COMMAND = "claude";
  static readonly CLI_VERSION_COMMAND = `${ClaudeCliProvider.CLI_COMMAND} --version`;
  static readonly CLI_HELP_COMMAND = `${ClaudeCliProvider.CLI_COMMAND} --help`;

  private static readonly statuslineManager = StatuslineManager.forProvider(
    STATUS_LINE_TRACKING_PROVIDERS.CLAUDE
  );

  /** Tracks per-prompt hook settings files for cleanup */
  private hookSettingsPaths: string[] = [];
  private readonly statusLineSnapshotPaths = new Set<string>();
  private statusLineToken: string | undefined;
  private statusLineDirectory: string | undefined;
  private statusLineWorkspaceRoot: string | undefined;
  private statusLineEnabledForPrompt = false;
  private statusLineSidecar: ClaudeStatuslineSidecar | undefined;
  private statuslineInstallResult: StatuslineInstallResult | undefined;

  consumeStatuslineInstallResult(): StatuslineInstallResult | undefined {
    const result = this.statuslineInstallResult;
    this.statuslineInstallResult = undefined;
    return result;
  }

  shouldRetainWorkflowArtifactsForReuse(): boolean {
    // Injected turns do not rebuild CLI arguments. Keep the prompt-scoped
    // --settings file and statusline lease alive with the reusable PTY because
    // Claude hot-reloads settings in running sessions; restoring the user
    // settings file would otherwise reload after the --settings file is gone
    // and silently remove both completion hooks and statusline reporting.
    return true;
  }

  readonly config: HarnessConfig = {
    name: "claude",
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    displayName: "Claude Code CLI",
    terminalName: "Claude",
    installHint: "Install via: npm install -g @anthropic-ai/claude-code",
    shouldStreamHeadlessOutput: true,

    // Claude uses Stop hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly notificationMonitor: INotificationMonitor =
    new ClaudeNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new ClaudeToolPermissionMapper();
  get capabilities(): HarnessCapabilityFacts {
    return {
      permissions: this.toolPermissionMapper.capabilities,
      hooks: ClaudeNotificationMonitor.CAPABILITIES,
      mcp: {
        perServerToolFiltering: CLAUDE_MCP_FILTERING_CAPABILITY,
      },
      promptInputs: { images: CLAUDE_IMAGE_INPUT_CAPABILITY },
    };
  }
  readonly logParser = new ClaudeLogParser();
  readonly headlessSource = "stdout" as const;

  /**
   * Adapt Claude's stream-json stdout to the event vocabulary consumed by
   * ClaudeLogParser. The log parser remains the only event mapper.
   */
  parseHeadlessStdout(stdout: string): BaseCliEvent[] {
    const { objects } = CliParseUtils.extractJsonObjectsFromStream(stdout);

    return objects.map((event) => {
      const normalized = { ...event };

      if (typeof event.session_id === "string") {
        normalized.sessionId = event.session_id;
      }
      if (event.tool_use_result !== undefined) {
        normalized.toolUseResult = event.tool_use_result;
      }

      return normalized as BaseCliEvent;
    });
  }

  /** Extract the session ID from Claude's system/init event. */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const { objects } = CliParseUtils.extractJsonObjectsFromStream(chunk);
    const initEvent = objects.find(
      (event) =>
        event.type === CLAUDE_EVENT_TYPES.SYSTEM &&
        event.subtype === CLAUDE_SYSTEM_SUBTYPES.INIT &&
        typeof event.session_id === "string"
    );
    return initEvent?.session_id as string | undefined;
  }

  /**
   * Build complete CLI arguments array for Claude CLI execution
   *
   * Handles all Claude-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Print mode and output format (-p, --output-format stream-json, --verbose)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (-r resume with explicit session ID only, no -c flag)
   * - Tool permissions (headless mode only)
   * - Stop hook settings (interactive mode only)
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
    },
    workspaceRoots?: readonly string[],
    approvedExternalRoots?: readonly string[]
  ): Promise<CliProviderPreparation> {
    const args: string[] = [];
    const statusLineToken = randomUUID();

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
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
      // Claude uses mcp__servername pattern to match all tools from a server
      const mcpServersResolved =
        workflowContext?.resolvedProperties?.mcpServers ?? [];
      if (mcpServersResolved.includes("ctrlyoke")) {
        args.push("--allowed-tools", "mcp__ctrlyoke");
        Log.debug("🔧 ctrlyoke MCP tools auto-approved");
      }

      // Auto-approve user-defined MCP server tools based on autoApprove config
      const mcpServers = workflowContext?.resolvedProperties?.mcpServers ?? [];
      for (const server of mcpServers) {
        if (typeof server === "object" && server.autoApprove) {
          if (server.autoApprove === true) {
            // Approve all tools from this server
            args.push("--allowed-tools", `mcp__${server.id}`);
            Log.debug(
              `🔧 Auto-approved all tools from MCP server: ${server.id}`
            );
          } else if (Array.isArray(server.autoApprove)) {
            // Approve specific tool patterns
            for (const pattern of server.autoApprove) {
              args.push("--allowed-tools", `mcp__${server.id}__${pattern}`);
            }
            Log.debug(
              `🔧 Auto-approved ${server.autoApprove.length} tool pattern(s) from MCP server: ${server.id}`
            );
          }
        }
      }
    }

    // Note: Headless-specific flags (-p, --output-format, --verbose) are added by
    // buildHeadlessArgs() to ensure correct positioning after the prompt argument.
    // Don't add them here to avoid duplication.

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.
    // This fixes the previously broken Claude CLI --agent flag (GitHub issue #9930).

    // Add workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(
        workspaceRoot,
        workspaceRoots,
        approvedExternalRoots
      );
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Session management: Resume with explicit session ID only
    // NOTE: We don't use the `-c` flag (continue most recent session) because:
    // 1. It's global across all projects, not workspace-specific
    // 2. Could accidentally resume a session from a different project
    // 3. No guarantee which session it will resume if user has multiple Claude instances
    // Instead, we only resume when resumeSession is true AND we have an explicit session ID.
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      args.push("-r", sessionId!);
      Log.info(`Resuming session: ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.warn("Resume requested but no session ID available");
    } else {
      Log.info("Starting new session");
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args).
    // IMPORTANT: Must come before tool permissions — Claude's --disallowedTools is variadic
    // and will consume any flags that follow it.
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    // Hook setup (interactive notification hooks + headless user hooks) is dispatched
    // by CliIntegration.runExecutionSession() via buildNotificationHookArgs() /
    // buildHeadlessUserHookArgs() — not here in buildCliArgs().
    // NOTE: For headless Claude, CliIntegration prepends hook args to baseArgs so that
    // --settings appears before --disallowedTools (which is variadic and would consume it).
    // Permission preparation is similarly dispatched by CliIntegration — not here.
    // IMPORTANT: CliIntegration appends permission args last, so --disallowedTools (variadic)
    // is always the final group of flags and cannot accidentally consume other flags.

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods

    return {
      cliArgs: args,
      mutations: [
        {
          description: "Prepare Claude statusline usage tracking",
          apply: async () => {
            this.statusLineSidecar?.stop();
            this.statusLineSidecar = undefined;
            this.statusLineToken = statusLineToken;
            this.statusLineDirectory = undefined;
            this.statusLineWorkspaceRoot = undefined;
            this.statusLineEnabledForPrompt = false;
            this.statuslineInstallResult = undefined;
            if (
              workspaceRoot &&
              ConfigurationUtils.getStatusLineTrackingSettings(
                STATUS_LINE_TRACKING_PROVIDERS.CLAUDE
              ).enabled
            ) {
              this.statuslineInstallResult = await this.registerStatusLine(
                extensionPath,
                workspaceRoot,
                workflowContext?.workingFilePath ?? workspaceRoot
              );
            }
          },
        },
        ...mcpPreparation.mutations,
      ],
      diagnostics: mcpPreparation.diagnostics,
    };
  }

  startExecutionSidecar(
    deps: CliExecutionSidecarDeps
  ): CliExecutionSidecar | undefined {
    if (
      !this.statusLineEnabledForPrompt ||
      !this.statusLineToken ||
      !this.statusLineDirectory
    ) {
      return undefined;
    }
    this.statusLineSidecar = new ClaudeStatuslineSidecar({
      snapshotPath: path.join(
        this.statusLineDirectory,
        `claude-statusline-${this.statusLineToken}.json`
      ),
      onProviderUsageUpdate: deps.onProviderUsageUpdate,
    });
    return this.statusLineSidecar;
  }

  getLatestStatuslineSnapshot() {
    return this.statusLineSidecar?.getLatestSnapshot();
  }

  /**
   * Validate model is supported by Claude CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    const defaultModel = ConfigurationUtils.getClaudeCliModel();

    if (!requestedModel) {
      // Return full model name for default
      const fullName = getClaudeModelName(defaultModel);
      return fullName || defaultModel;
    }

    if (requestedModel === MODEL_NONE) {
      return undefined;
    }

    // Try to look up the model in our comprehensive map
    const fullModelName = getClaudeModelName(requestedModel);
    if (fullModelName) {
      return fullModelName;
    }

    // Model not recognized - warn user and fallback
    const supportedFormats =
      "aliases (sonnet, opus, haiku), generic names (claude-sonnet-4.5), or full names";
    const message = `Model "${requestedModel}" not recognized for Claude CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);
    Log.warn(`   Accepted formats: ${supportedFormats}`);

    const defaultFullName = getClaudeModelName(defaultModel);
    return defaultFullName || defaultModel;
  }

  /**
   * Set up ctrlyoke notification hooks (Stop hook + user hooks) for interactive mode.
   * Writes hook settings to a temp file and returns ["--settings", path] for Claude CLI.
   * Uses unique filenames per prompt to avoid parallel workflow collisions.
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
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-claude-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);
    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
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
    if (hookConfig.type !== CLAUDE_HOOK_CONFIG_TYPES.JSON_STRING) {
      throw new Error("Unexpected hook config type for Claude CLI");
    }
    const hookFileName = ClaudeCliProvider.buildHookSettingsFileName(
      promptIndex,
      workingFilePath
    );
    const settingsPath = this.getHookSettingsPath(workspaceRoot, hookFileName);
    return {
      cliArgs: ["--settings", settingsPath],
      mutations: [
        this.createHookSettingsMutation(
          settingsPath,
          hookConfig.config,
          "Write Claude notification hook settings"
        ),
      ],
      diagnostics: [],
    };
  }

  /**
   * Build a unique hook settings filename for a prompt.
   *
   * Format: `claude-hook-settings-<stem>-p<promptIndex>.json`
   * Follows the same pattern as CopilotCliProvider.buildHookFileName().
   */
  private static buildHookSettingsFileName(
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
    return `claude-hook-settings-${safeStem}-p${promptIndex}.json`;
  }

  /**
   * Set up user-only hooks for headless execution.
   * No ctrlyoke notification hooks are included since headless uses process-exit for completion.
   * Returns ["--settings", path] — CliIntegration prepends this to baseArgs so it appears
   * before --disallowedTools (which is variadic and would consume later flags).
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
    const settingsJson =
      enabledNotificationHookEvents.length > 0
        ? (() => {
            const hookConfig = this.notificationMonitor.buildHookConfig(
              path.join(
                extensionPath,
                "out",
                "scripts",
                "ctrlyoke-claude-hook.js"
              ),
              this.notificationMonitor.getNotificationDirectory(workspaceRoot),
              workspaceRoot,
              userHooks,
              enabledNotificationHookEvents
            );
            if (hookConfig.type !== CLAUDE_HOOK_CONFIG_TYPES.JSON_STRING) {
              throw new Error("Unexpected hook config type for Claude CLI");
            }
            return hookConfig.config;
          })()
        : ClaudeNotificationMonitor.buildUserOnlyConfig(userHooks ?? []);
    const hookFileName = ClaudeCliProvider.buildHookSettingsFileName(
      promptIndex,
      workingFilePath
    );
    const settingsPath = this.getHookSettingsPath(workspaceRoot, hookFileName);
    return {
      cliArgs: ["--settings", settingsPath],
      mutations: [
        this.createHookSettingsMutation(
          settingsPath,
          settingsJson,
          "Write Claude headless hook settings"
        ),
      ],
      diagnostics: [],
    };
  }

  private getHookSettingsPath(
    workspaceRoot: string,
    hookFileName: string
  ): string {
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      hookFileName
    );
  }

  private createHookSettingsMutation(
    settingsPath: string,
    content: string,
    description: string
  ): PreparedMutation {
    return {
      path: settingsPath,
      intendedContent: content,
      description,
      apply: async () => {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, content, "utf-8");
        this.hookSettingsPaths.push(settingsPath);
        Log.debug(`🔔 Configured Claude hook settings`);
      },
      restore: async () => {
        await fs.unlink(settingsPath).catch(() => undefined);
      },
    };
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   * Permission args are appended last so --disallowedTools (variadic) is always final.
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (toolPermissions === null) {
      return { cliArgs: [], diagnostics: [] };
    }
    const config = toolPermissions ?? {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.toolPermissionMapper.prepare(config, context);
  }

  /**
   * Delete hook settings files written for the previous prompt before building hooks for the next.
   * Prevents .ctrlyoke/temp/ from accumulating per-prompt settings files across a workflow.
   * Claude reads only the specific --settings file passed per prompt, so old files don't affect
   * behavior, but cleaning them avoids temp dir clutter between prompts.
   */
  async cleanupPreviousPromptHooks(_workspaceRoot: string): Promise<void> {
    for (const settingsPath of this.hookSettingsPaths) {
      await fs.unlink(settingsPath).catch(() => {});
    }
    this.hookSettingsPaths = [];
  }

  /**
   * Return additional file paths to delete after workflow cleanup.
   * Includes all per-prompt hook settings files created during interactive and headless sessions.
   */
  getAdditionalCleanupFilePaths(_workspaceRoot: string): string[] {
    return [...this.hookSettingsPaths, ...this.statusLineSnapshotPaths];
  }

  async cleanupWorkspaceArtifacts(
    _workspaceRoot: string,
    _workingFilePath?: string
  ): Promise<void> {
    this.statusLineSidecar?.stop();
    this.statusLineSidecar = undefined;
    for (const snapshotPath of this.statusLineSnapshotPaths) {
      await fs.unlink(snapshotPath).catch(() => undefined);
    }
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Claude CLI expects the prompt as the FIRST positional argument (right after command name).
   * This is critical because variadic flags like --disallowedTools will consume any args after them.
   *
   * Format: claude "prompt" -p --output-format stream-json --verbose [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.ctrlyoke/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    return [
      prompt,
      "-p", // Print mode (non-interactive)
      "--output-format",
      "stream-json", // JSON streaming for parsing
      "--verbose", // Include detailed information
      ...baseArgs,
    ];
  }

  /**
   * Build CLI arguments for interactive TUI mode
   *
   * Claude interactive mode: claude "prompt text" [args...] (no -p flag = interactive)
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return [promptText, ...baseArgs];
  }

  /**
   * Generate MCP server configuration arguments for Claude CLI
   *
   * Claude CLI uses --mcp-config <file> format.
   * Config file format: JSON with "type": "stdio".
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets CTRLYOKE_WORKING_FILE)
   * @returns CLI arguments array with --mcp-config, or null if MCP not supported
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
      // Claude CLI requires "type": "stdio"
      const secretOptions = CliProviderUtils.createMcpSecretConfigOptions(
        (name) => `\${${name}}`,
        secretEnvironment
      );
      let configJson: string;
      if (mcpServerPath && userServers && userServers.length > 0) {
        // ctrlyoke server + user-defined servers
        configJson = CliMcpConfigGenerator.generateJsonConfigWithUserServers(
          mcpServerPath,
          workspaceRoot,
          userServers,
          { type: "stdio" },
          workingFilePath,
          additionalEnv,
          undefined,
          stateRoot,
          secretOptions
        );
      } else if (mcpServerPath) {
        // ctrlyoke server only
        configJson = CliMcpConfigGenerator.generateJsonConfig(
          mcpServerPath,
          workspaceRoot,
          { type: "stdio" },
          workingFilePath,
          additionalEnv,
          stateRoot,
          secretOptions
        );
      } else if (userServers && userServers.length > 0) {
        // User-defined servers only (no ctrlyoke server)
        configJson = CliMcpConfigGenerator.generateUserServersOnlyConfig(
          userServers,
          undefined,
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
        cliArgs: ["--mcp-config", configPath],
        mutations: [
          CliMcpConfigGenerator.createFileMutation(
            configPath,
            configJson,
            "Write Claude MCP configuration"
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
      "mcp-config-claude"
    );
  }

  /**
   * Unset CLAUDECODE so Claude CLI doesn't refuse to start inside an active session.
   */
  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    const env = {
      ...CliProviderUtils.buildProcessEnv(),
      ...this.buildStatusLineSpawnEnv(),
    };
    delete env.CLAUDECODE;
    return env;
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    return this.buildStatusLineSpawnEnv();
  }

  private async registerStatusLine(
    extensionPath: string,
    workspaceRoot: string,
    _workflowKey: string
  ): Promise<StatuslineInstallResult> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-claude-statusline.js"
    );
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
      `claude-statusline-${this.statusLineToken}.json`
    );
    this.statusLineSnapshotPaths.add(snapshotPath);

    try {
      const result = await ClaudeCliProvider.statuslineManager.install(
        workspaceRoot,
        command
      );
      this.statusLineDirectory = snapshotDirectory;
      this.statusLineWorkspaceRoot = workspaceRoot;
      this.statusLineEnabledForPrompt = true;
      return result;
    } catch (error) {
      // A statusline failure must never prevent Claude itself from running.
      Log.warn(`Failed to register Claude statusline: ${error}`);
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
    const env: NodeJS.ProcessEnv = {
      CTRLYOKE_CLAUDE_STATUSLINE_TOKEN: this.statusLineToken,
      CTRLYOKE_CLAUDE_STATUSLINE_DIR: this.statusLineDirectory,
      ...(this.statusLineWorkspaceRoot
        ? { CTRLYOKE_STATUSLINE_WORKSPACE_ROOT: this.statusLineWorkspaceRoot }
        : {}),
    };
    return env;
  }

  /**
   * Check if Claude CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability(
      ClaudeCliProvider.CLI_VERSION_COMMAND
    );
  }

  /**
   * Get Claude CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion(
      ClaudeCliProvider.CLI_VERSION_COMMAND
    );
  }

  /**
   * Check if error is a Claude CLI invalid session error.
   *
   * This classifies a process-spawn error so the runner can retry without
   * the resume flag; it is intentionally a provider concern, not output
   * parsing.
   */
  isRecoverableSessionError(error: unknown): boolean {
    const message = getErrorMessage(error);
    return (
      message.includes("--resume requires a valid session ID") ||
      message.includes("Session IDs must be in UUID format") ||
      message.includes("No conversation found with session ID")
    );
  }
}
