import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import {
  ICliProvider,
  HarnessConfig,
  CLI_VERSION_CHECK_TIMEOUT_MS,
} from "../shared/interfaces/ICliProvider";
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
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { SettingsJsonMcpTracker } from "../shared/SettingsJsonMcpTracker";
import { SettingsJsonHooksTracker } from "../shared/SettingsJsonHooksTracker";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { CODEX_CLI_MODELS, MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";
import { parseArgString } from "../../../utils/CliArgParser";
import type { PromptStep, WorkflowStep, UserHookConfig } from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

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
 * - Hook-based completion via --enable codex_hooks + .codex/hooks.json
 * - OpenAI token format in usage metadata
 * - Completion detection via {"type": "turn.completed"} events
 * - Supports --resume flag for session continuation
 * - Mode-based permissions (--full-auto, --dangerously-bypass-approvals-and-sandbox)
 *
 * Usage:
 * ```typescript
 * const provider = new CodexCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class CodexCliProvider implements ICliProvider {
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
   * - Tool permissions (sandbox mode, approval policy, --full-auto)
   * - Hook settings (interactive mode only: --enable codex_hooks + .codex/hooks.json)
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
    // buildNotificationHookArgs() returns ["--enable", "codex_hooks"] for interactive mode.

    // Session management
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );

    if (shouldResume) {
      // Resume existing session: codex [exec] [--json] ... resume <session-id>
      args.push("resume");
      args.push(sessionId!);
      Log.debug(`✅ Added resume subcommand with session: ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(`🆕 Starting new session`);
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods (buildHeadlessArgs, etc.)

    return args;
  }

  /**
   * Set up FlightPath notification hooks (SessionStart + Stop + user hooks) for interactive mode.
   * Writes hooks to .codex/hooks.json and enables the Codex hook system.
   *
   * Uses SettingsJsonHooksTracker for parallel-safe ref-counted hook management.
   * Unlike Qwen/Gemini, Codex has no trusted_hooks.json — hooks run without
   * any trust prompt when codex_hooks is enabled.
   *
   * @returns ["--enable", "codex_hooks"] — required for Codex to activate its hook system
   */
  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    await this.writeCodexHooks(extensionPath, workspaceRoot, workflowKey, userHooks);
    Log.debug(
      `🔔 Configured SessionStart + Stop hooks for Codex completion detection`
    );
    return ["--enable", "codex_hooks"];
  }

  /**
   * Set up user-only hooks for headless execution.
   * No FlightPath notification hooks are included since headless uses process-exit for completion.
   * Returns ["--enable", "codex_hooks"] so Codex activates its hook system.
   */
  async buildHeadlessUserHookArgs(
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[]
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    const workflowUserHooks = this.buildUserHooksSection(userHooks);
    await CodexCliProvider.lockProvider.withLock(async () => {
      await CodexCliProvider.hooksTracker.registerWorkflow(
        workflowKey,
        workspaceRoot,
        {},
        workflowUserHooks
      );
    });
    Log.debug(`🔔 Configured user hooks for Codex headless mode`);
    return ["--enable", "codex_hooks"];
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   * Uses Codex-specific permission mapper with sandbox/approval settings.
   */
  buildPermissionArgs(
    toolPermissions: ToolPermissionConfig | null | undefined
  ): string[] {
    if (toolPermissions === null) {
      // none mode — skip permission flags entirely
      return [];
    }
    const sandboxMode = ConfigurationUtils.getCodexSandboxMode();
    const approvalPolicy = ConfigurationUtils.getCodexApprovalPolicy();
    const args: string[] = [];
    const config =
      toolPermissions ?? {
        mode: ConfigurationUtils.getCliToolPermissions(),
        allowedTools: ConfigurationUtils.getCliAllowedTools(),
        deniedTools: ConfigurationUtils.getCliDeniedTools(),
      };
    const permissionArgs = (
      this.toolPermissionMapper as CodexToolPermissionMapper
    ).buildCodexSpecificArgs(config, sandboxMode, approvalPolicy);
    args.push(...permissionArgs);
    // Add additional allowed directories when not in dangerous mode
    if (config.mode !== PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      const additionalDirs = ConfigurationUtils.getCodexAllowedDirs();
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
    userHooks?: UserHookConfig[]
  ): Promise<void> {
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
      workspaceRoot
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected hook config type for Codex CLI");
    }

    const flightpathHooksSection = (
      hookConfig.config as Record<string, unknown>
    )["hooks"] as Record<string, unknown[]>;

    const workflowUserHooks = this.buildUserHooksSection(userHooks);

    // Register hooks via ref-counted tracker under lock
    await CodexCliProvider.lockProvider.withLock(async () => {
      await CodexCliProvider.hooksTracker.registerWorkflow(
        workflowKey,
        workspaceRoot,
        flightpathHooksSection,
        workflowUserHooks
      );
    });
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
    userHooks?: UserHookConfig[]
  ): Record<string, unknown[]> {
    const codexEventMap: Record<string, string> = {
      stop: "Stop",
      sessionStart: "SessionStart",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      userPromptSubmit: "UserPromptSubmit",
    };
    const section: Record<string, unknown[]> = {};
    for (const uh of userHooks ?? []) {
      const nativeEvent = codexEventMap[uh.event];
      if (!nativeEvent) continue;
      if (!section[nativeEvent]) section[nativeEvent] = [];
      section[nativeEvent].push({
        matcher: "",
        hooks: [{ type: "command", command: uh.command }],
      });
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
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote special characters
    return [...baseArgs, `"${prompt}"`];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * Codex interactive mode: codex "prompt text" [args...] (no exec = interactive)
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string {
    // Quote arguments that contain special characters (brackets, spaces, or quotes)
    const quotedArgs = baseArgs.map((arg) => {
      if (/[\[\]\s"]/.test(arg)) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    });

    return `${this.config.name} "${promptText.replace(/"/g, '\\"')}" ${quotedArgs.join(" ")}`;
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
   * Codex CLI uses -c 'mcp_servers.flightpath={...}' inline TOML format.
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
    _userServers?: import("../../../types/FlightPathTypes").McpServerConfig[]
  ): Promise<string[] | null> {
    // Codex uses inline TOML format which only supports the FlightPath server
    if (!mcpServerPath) {
      return null;
    }
    try {
      const tomlConfig = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        mcpServerPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv
      );
      return ["-c", tomlConfig];
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
    try {
      await execAsync("codex --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Codex CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("codex --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
      // Extract version from output like "codex version 0.1.2"
      const match = stdout.match(/codex version ([\d.]+)/i);
      return match ? match[1] : stdout.trim();
    } catch {
      return undefined;
    }
  }
}
