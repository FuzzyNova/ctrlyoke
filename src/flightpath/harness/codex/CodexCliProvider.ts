import * as path from "path";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { CodexResponseParser } from "./CodexResponseParser";
import { CodexNotificationMonitor } from "./CodexNotificationMonitor";
import { CodexToolPermissionMapper } from "./CodexToolPermissionMapper";
import { CodexLogParser } from "./CodexLogParser";
import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { createCodexCommandHookGroup } from "../shared/CodexHookUtils";
import { SettingsJsonMcpTracker } from "../shared/SettingsJsonMcpTracker";
import { SettingsJsonHooksTracker } from "../shared/SettingsJsonHooksTracker";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { CODEX_CLI_MODELS, MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import {
  PERMISSION_MODES,
  HARNESS_IDS,
} from "../../../types/DashboardConstants";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  HookEvent,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

/**
 * Codex CLI Harness
 *
 * Implements all Codex-specific logic using composition pattern:
 * - hooks.json monitoring and hooks system for completion detection
 * - JSONL output parsing with event-based streaming
 * - Mode-based permissions (no granular tool patterns)
 * - MCP server configuration with inline TOML format
 *
 * This provider aggregates four specialized components:
 * - CodexResponseParser: Parses JSONL output and statistics
 * - CodexNotificationMonitor: Monitors hook notifications
 * - CodexToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration (shared)
 *
 * Codex CLI-specific features:
 * - Uses JSONL output format (multiple {"type": "..."} events)
 * - Hook-based completion via --enable hooks + .codex/hooks.json
 * - OpenAI token format in usage metadata
 * - Completion detection via {"type": "turn.completed"} events
 * - Supports --resume flag for session continuation
 * - Mode-based permissions (Auto preset flags, --dangerously-bypass-approvals-and-sandbox)
 *
 * Usage:
 * ```typescript
 * const provider = new CodexCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class CodexCliProvider implements ICliProvider {
  private buildToolApprovalOverrideArgs(server: McpServerConfig): string[] {
    if (!Array.isArray(server.autoApprove) || server.autoApprove.length === 0) {
      return [];
    }

    return server.autoApprove.flatMap((toolName) => [
      "-c",
      `mcp_servers.${server.id}.tools.${toolName}.approval_mode='approve'`,
    ]);
  }

  /**
   * Shared singleton tracker for parallel-safe hooks management in .codex/hooks.json.
   * SettingsJsonMcpTracker("codex") is used solely as a mutex provider — Codex does
   * not write MCP config to settings files, but we need a lock to serialize
   * concurrent read-modify-write operations on hooks.json.
   */
  private static readonly hooksTracker =
    SettingsJsonHooksTracker.getInstance("codex");
  private static readonly lockProvider =
    SettingsJsonMcpTracker.getInstance("codex");

  readonly config: HarnessConfig = {
    name: "codex",
    harnessId: HARNESS_IDS.CODEX_CLI,
    displayName: "Codex CLI",
    terminalName: "Codex",
    installHint: "Install via: npm install -g @openai/codex-cli",
    shouldStreamHeadlessOutput: true,

    // Codex uses hooks system for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new CodexResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CodexNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CodexToolPermissionMapper();
  readonly logParser = new CodexLogParser();

  /**
   * Build complete CLI arguments array for Codex CLI execution
   *
   * Handles all Codex-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Exec mode and output format (--json for headless)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (resume subcommand with session ID)
   * - Tool permissions (sandbox mode, approval policy, Auto preset flags)
   * - Hook settings (interactive mode only: --enable hooks + .codex/hooks.json)
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
    _prompt: PromptStep,
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
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // No provider-specific agent flags needed.
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension is enabled)
    const mcpArgs = await CliProviderUtils.buildMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.getMcpConfigArgs(
          serverPath,
          wsRoot,
          workingFile,
          additionalEnv,
          userServers
        )
    );
    if (mcpArgs.length > 0) {
      args.push(...mcpArgs);
      Log.debug("🔧 MCP server config added for dynamic queue extension");
    }

    // Headless mode: add exec command and --json flag
    if (!isInteractive) {
      args.push("exec");
      args.push("--json");
      args.push("--skip-git-repo-check"); // Allow headless/CI use outside git repos
    }

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Add workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(workspaceRoot);
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    // Hook setup (interactive notification hooks) is dispatched by
    // CliIntegration.runExecutionSession() via buildNotificationHookArgs() — not here.
    // buildNotificationHookArgs() returns ["--enable", "hooks"] for interactive mode.

    // Session management
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );

    if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else if (!shouldResume) {
      Log.debug(`🆕 Starting new session`);
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods (buildHeadlessArgs, etc.).
    // Note: "resume <session-id>" is NOT added here — it must appear AFTER all global
    // flags (hooks, permissions). See buildCliSuffix().

    return args;
  }

  /**
   * Append "resume <session-id>" as the final args in the assembled command.
   *
   * Codex's "resume" is a CLI subcommand (not a flag), so it must come AFTER all global
   * flags such as "--enable hooks" and "-c hooks.state=...". Placing it before those flags
   * causes Codex to parse them as subcommand args rather than global config, which breaks
   * hook trust-state injection and causes hash validation failures for resume sessions.
   */
  buildCliSuffix(
    sessionId: string | undefined,
    workflowContext?: {
      resolvedProperties?: { resumeSession?: boolean };
    }
  ): string[] {
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      Log.debug(`✅ Appending resume subcommand with session: ${sessionId}`);
      return ["resume", sessionId!];
    }
    return [];
  }

  /**
   * Set up FlightPath notification hooks (SessionStart + Stop + user hooks) for interactive mode.
   * Writes hooks to .codex/hooks.json and enables the Codex hook system.
   *
   * Uses SettingsJsonHooksTracker for parallel-safe ref-counted hook management.
   * Codex tracks trust in hooks.state. New or modified unmanaged hooks need
   * review before they can run, even when the hooks feature is enabled.
   *
   * @returns ["--enable", "hooks"] — required for Codex to activate its hook system
   */
  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    const hookEvents = [
      ...new Set<HookEvent>([
        "sessionStart",
        "stop",
        ...enabledNotificationHookEvents,
      ]),
    ];
    const trustArgs = await this.writeCodexHooks(
      extensionPath,
      workspaceRoot,
      workflowKey,
      userHooks,
      hookEvents
    );
    Log.debug(
      `🔔 Configured SessionStart + Stop hooks for Codex completion detection`
    );
    return ["--enable", "hooks", ...trustArgs];
  }

  /**
   * Set up user-only hooks for headless execution.
   * No FlightPath notification hooks are included since headless uses process-exit for completion.
   * Returns ["--enable", "hooks"] so Codex activates its hook system.
   */
  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    const flightpathHooksSection =
      enabledNotificationHookEvents.length > 0
        ? (() => {
            const hookConfig = this.notificationMonitor.buildHookConfig(
              path.join(
                extensionPath,
                "out",
                "scripts",
                "flightpath-codex-notify.js"
              ),
              this.notificationMonitor.getNotificationDirectory(workspaceRoot),
              workspaceRoot,
              userHooks,
              enabledNotificationHookEvents
            );
            if (hookConfig.type !== "json") {
              throw new Error("Unexpected hook config type for Codex CLI");
            }
            return (
              hookConfig.config as Record<string, Record<string, unknown[]>>
            ).hooks;
          })()
        : {};
    const workflowUserHooks = this.buildUserHooksSection(
      userHooks,
      enabledNotificationHookEvents
    );
    let trustArgs: string[] = [];
    await CodexCliProvider.lockProvider.withLock(async () => {
      await CodexCliProvider.hooksTracker.registerWorkflow(
        workflowKey,
        workspaceRoot,
        flightpathHooksSection,
        workflowUserHooks
      );
      trustArgs = SettingsJsonHooksTracker.serializeCodexInlineTrustOverride(
        CodexCliProvider.hooksTracker.getCodexTrustState(workspaceRoot)
      );
    });
    Log.debug(`🔔 Configured user hooks for Codex headless mode`);
    return ["--enable", "hooks", ...trustArgs];
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   * Uses Codex-specific permission mapper with sandbox/approval settings.
   *
   * Note: --ask-for-approval / -a is only valid in interactive mode (not `codex exec`).
   * isInteractive is forwarded to the mapper so it can omit unsupported flags.
   */
  buildPermissionArgs(
    toolPermissions: ToolPermissionConfig | null | undefined,
    isInteractive?: boolean
  ): string[] {
    if (toolPermissions === null) {
      // none mode — skip permission flags entirely
      return [];
    }
    const sandboxMode = ConfigurationUtils.getCodexSandboxMode();
    const approvalPolicy = ConfigurationUtils.getCodexApprovalPolicy();
    const args: string[] = [];
    const config = toolPermissions ?? {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    const permissionArgs = (
      this.toolPermissionMapper as CodexToolPermissionMapper
    ).buildCodexSpecificArgs(
      config,
      sandboxMode,
      approvalPolicy,
      isInteractive
    );
    args.push(...permissionArgs);
    // Add additional allowed directories when not in dangerous mode
    if (config.mode !== PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      const additionalDirs = ConfigurationUtils.getCliAllowedDirs();
      additionalDirs.forEach((dir: string) => {
        args.push("--add-dir", dir);
      });
    }
    return args;
  }

  /**
   * Write FlightPath hooks into .codex/hooks.json for completion detection.
   * Shared implementation for buildNotificationHookArgs.
   */
  private async writeCodexHooks(
    extensionPath: string,
    workspaceRoot: string,
    workflowKey: string,
    userHooks?: UserHookConfig[],
    flightpathEvents?: HookEvent[]
  ): Promise<string[]> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "flightpath-codex-notify.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    // Build hooks section via the notification monitor (single source of truth).
    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot,
      userHooks,
      flightpathEvents
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected hook config type for Codex CLI");
    }

    const flightpathHooksSection = (
      hookConfig.config as Record<string, unknown>
    )["hooks"] as Record<string, unknown[]>;

    const workflowUserHooks = this.buildUserHooksSection(
      userHooks,
      flightpathEvents
    );

    // Register hooks via ref-counted tracker under lock
    let trustArgs: string[] = [];
    await CodexCliProvider.lockProvider.withLock(async () => {
      await CodexCliProvider.hooksTracker.registerWorkflow(
        workflowKey,
        workspaceRoot,
        flightpathHooksSection,
        workflowUserHooks
      );
      trustArgs = SettingsJsonHooksTracker.serializeCodexInlineTrustOverride(
        CodexCliProvider.hooksTracker.getCodexTrustState(workspaceRoot)
      );
    });

    return trustArgs;
  }

  /**
   * Augment headless parsed output with accurate token usage from the session log.
   *
   * The Codex JSONL stdout (`turn.completed` usage) only reports cumulative totals
   * across all sessions — it does not reflect context window usage for the current
   * session alone (see openai/codex#5276). The session log (`event_msg:token_count`)
   * contains per-turn `last_token_usage` that accurately represents what the model
   * consumed in this session's context window.
   *
   * This method locates the session log by the session ID already extracted from
   * stdout, reads the token data from it, and replaces the metadata.usage block
   * with the more accurate log-sourced values.
   */
  async augmentParsedOutput(
    output: UniversalCliOutput
  ): Promise<UniversalCliOutput> {
    const sessionId = output.metadata?.sessionId as string | undefined;
    if (!sessionId) {
      return output;
    }

    const logPath = this.logParser.findLogFileBySessionId(sessionId);
    if (!logPath) {
      Log.debug(
        `[CodexCliProvider] No session log found for token augmentation (session: ${sessionId})`
      );
      return output;
    }

    const tokenUsage = CodexLogParser.extractTokenUsageFromLogFile(logPath);
    if (!tokenUsage) {
      return output;
    }

    Log.debug(
      `[CodexCliProvider] Token usage from log: ` +
        `${tokenUsage.inputTokens} in / ${tokenUsage.outputTokens} out, ` +
        `context window used: ${tokenUsage.contextWindowUsedTokens ?? "unknown"}`
    );

    return {
      ...output,
      metadata: {
        ...output.metadata,
        usage: {
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.totalTokens,
          cachedInputTokens: tokenUsage.cachedInputTokens,
          reasoningOutputTokens: tokenUsage.reasoningOutputTokens,
          contextWindowUsedTokens: tokenUsage.contextWindowUsedTokens,
          contextWindowSize: tokenUsage.contextWindowSize,
        },
      },
    };
  }

  /**
   * Clean up .codex/hooks.json entries written by this workflow.
   *
   * Unregisters via ref-counted tracker — restores baseline only when
   * the last active workflow unregisters.
   */
  async cleanupWorkspaceArtifacts(
    workspaceRoot: string,
    workingFilePath?: string
  ): Promise<void> {
    const hookKey = workingFilePath ?? workspaceRoot;
    await CodexCliProvider.lockProvider.withLock(async () => {
      await CodexCliProvider.hooksTracker.unregisterWorkflow(
        hookKey,
        workspaceRoot
      );
    });
  }

  /**
   * Convert FlightPath user hooks to the Codex hooks.json section format.
   * Codex uses matcher-based entries: { matcher: "", hooks: [{type, command}] }
   */
  private buildUserHooksSection(
    userHooks?: UserHookConfig[],
    wrappedFlightpathEvents: HookEvent[] = []
  ): Record<string, unknown[]> {
    const codexEventMap: Record<string, string> = {
      stop: "Stop",
      sessionStart: "SessionStart",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      userPromptSubmit: "UserPromptSubmit",
      // Decision hook: Codex pipes the payload on stdin and reads stdout as the
      // allow/deny decision. Registered as a direct hook entry so Codex handles
      // the stdin/stdout contract natively.
      permissionRequest: "PermissionRequest",
    };
    const section: Record<string, unknown[]> = {};
    for (const uh of userHooks ?? []) {
      if (
        uh.event === "permissionRequest" &&
        wrappedFlightpathEvents.includes("permissionRequest")
      ) {
        continue;
      }
      const nativeEvent = codexEventMap[uh.event];
      if (!nativeEvent) continue;
      if (!section[nativeEvent]) section[nativeEvent] = [];
      section[nativeEvent].push(
        createCodexCommandHookGroup(nativeEvent, uh.command)
      );
    }
    return section;
  }

  /**
   * Validate model is supported by Codex CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    const defaultModel = ConfigurationUtils.getCodexCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    if (requestedModel === MODEL_NONE) {
      return undefined;
    }

    // Check if model is in the supported list
    if (CODEX_CLI_MODELS.includes(requestedModel as any)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Codex CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);

    return defaultModel;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Codex expects: codex exec [OPTIONS] [PROMPT]
   * The prompt argument must come LAST after all flags/options.
   *
   * Handles both direct prompts and file references (e.g., ".flightpath/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    return [...baseArgs, prompt];
  }

  /**
   * Build CLI arguments for interactive TUI mode
   *
   * Codex interactive mode: codex "prompt text" [args...] (no exec = interactive)
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
   * Format a file path reference for Codex CLI
   *
   * Codex does NOT support @ symbol file references - it interprets them literally.
   * Returns the file path without the @ prefix.
   *
   * @param relativeFilePath Relative file path
   * @returns File path without @ prefix (e.g., ".flightpath/temp/prompt.md")
   */
  formatFileReference(relativeFilePath: string): string {
    // Codex CLI doesn't support @ prefix - just return the path as-is
    return relativeFilePath;
  }

  /**
   * Generate MCP server configuration arguments for Codex CLI
   *
   * Codex CLI uses repeated -c/--config overrides in inline TOML format.
   * Supports the built-in FlightPath server and user-defined stdio servers.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets FLIGHTPATH_WORKING_FILE)
   * @returns CLI arguments array with -c flag, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<string[] | null> {
    if (!mcpServerPath && (!userServers || userServers.length === 0)) {
      return null;
    }

    try {
      const configArgs: string[] = [];

      if (mcpServerPath) {
        configArgs.push(
          "-c",
          CliMcpConfigGenerator.generateInlineTomlConfig(
            "flightpath",
            mcpServerPath,
            workspaceRoot,
            workingFilePath,
            additionalEnv
          )
        );

        configArgs.push(
          "-c",
          "mcp_servers.flightpath.default_tools_approval_mode='approve'"
        );
      }

      for (const server of userServers ?? []) {
        if (server.url && server.transport === "sse") {
          Log.warn(
            `⚠️ Codex CLI does not support SSE MCP server "${server.id}". Skipping.`
          );
          continue;
        }

        if (!server.url && !server.command) {
          Log.warn(
            `⚠️ Codex CLI MCP server "${server.id}" is missing a command or URL. Skipping.`
          );
          continue;
        }

        if (server.url) {
          configArgs.push(
            "-c",
            CliMcpConfigGenerator.generateInlineTomlRemoteServerConfig(
              server.id,
              server.url,
              server.headers,
              {
                defaultToolsApprovalMode:
                  server.autoApprove === true ? "approve" : undefined,
                disabledTools: server.deniedTools,
              }
            )
          );
        } else {
          const normalizedArgs = server.args?.map((arg) =>
            arg.replace(/\\/g, "/")
          );
          const normalizedEnv = Object.fromEntries(
            Object.entries(server.env ?? {}).map(([key, value]) => [
              key,
              value.replace(/\\/g, "/"),
            ])
          );

          configArgs.push(
            "-c",
            CliMcpConfigGenerator.generateInlineTomlStdioServerConfig(
              server.id,
              server.command!,
              normalizedArgs,
              normalizedEnv,
              {
                defaultToolsApprovalMode:
                  server.autoApprove === true ? "approve" : undefined,
                disabledTools: server.deniedTools,
              }
            )
          );
        }

        configArgs.push(...this.buildToolApprovalOverrideArgs(server));
      }

      if (configArgs.length > 0) {
        Log.debug(
          `🔧 Codex MCP config overrides added for ${configArgs.length / 2} server(s)`
        );
      }

      return configArgs.length > 0 ? configArgs : null;
    } catch (error) {
      Log.error("Failed to generate MCP config for Codex CLI", error);
      return null;
    }
  }

  /**
   * Check if Codex CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability("codex --version");
  }

  /**
   * Get Codex CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion("codex --version", {
      parseVersion: (stdout) => {
        // Extract version from output like "codex version 0.1.2"
        const match = stdout.match(/codex version ([\d.]+)/i);
        return match ? match[1] : stdout;
      },
    });
  }
}
