import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import {
  ICliProvider,
  HarnessConfig,
  CLI_VERSION_CHECK_TIMEOUT_MS,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { QwenResponseParser } from "./QwenResponseParser";
import { QwenNotificationMonitor } from "./QwenNotificationMonitor";
import { QwenToolPermissionMapper } from "./QwenToolPermissionMapper";
import { QwenLogParser } from "./QwenLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { SettingsJsonMcpTracker } from "../shared/SettingsJsonMcpTracker";
import { SettingsJsonHooksTracker } from "../shared/SettingsJsonHooksTracker";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  PromptItem,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

/**
 * Qwen Code CLI Harness
 *
 * Implements all Qwen Code-specific logic using composition pattern:
 * - Process exit detection (headless) + log file monitoring (interactive) for completion
 * - Stream-json output parsing with real-time content extraction
 * - Mode-based tool permission conversion (plan, default, auto-edit, yolo)
 * - Session discovery via log file analysis
 *
 * This provider aggregates four specialized components:
 * - QwenResponseParser: Parses stream-json output and tool calls
 * - QwenNotificationMonitor: Monitors process exit and log files
 * - QwenToolPermissionMapper: Converts permissions to CLI arguments
 * - QwenLogParser: Parses log files for sessions and completion
 *
 * Qwen Code CLI features:
 * - Uses stream-json output format (NDJSON - one JSON object per line)
 * - Session ID from system init or result event
 * - Mode-based permissions (--approval-mode, -y for YOLO)
 * - Supports --continue flag for session continuation
 * - Log files in ~/.qwen/projects/<workspace>/chats/<session-id>.jsonl
 *
 * Usage:
 * ```typescript
 * const provider = new QwenCliProvider();
 * const integration = new CliIntegration(provider, platform, registerWithContext);
 * ```
 */
export class QwenCliProvider implements ICliProvider {
  /** Shared singleton tracker for parallel-safe MCP management in .qwen/settings.json */
  private static readonly mcpTracker =
    SettingsJsonMcpTracker.getInstance("qwen");

  /** Shared singleton tracker for parallel-safe hooks management in .qwen/settings.json */
  private static readonly hooksTracker =
    SettingsJsonHooksTracker.getInstance("qwen");

  readonly config: HarnessConfig = {
    name: "qwen",
    displayName: "Qwen Code CLI",
    terminalName: "Qwen Code",
    installHint: "Install via: npm install -g @qwen-code/qwen-code",
    shouldStreamHeadlessOutput: true,

    // Qwen uses log file monitoring for completion detection in interactive mode
    // Process exit is primary for headless mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new QwenResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new QwenNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new QwenToolPermissionMapper();
  readonly logParser = new QwenLogParser();

  /**
   * Build complete CLI arguments array for Qwen Code CLI execution
   *
   * Handles all Qwen-specific arguments including:
   * - Output format (--output-format stream-json for headless)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (--continue for resumption)
   * - Tool permissions (--approval-mode, -y, --allowed-tools, --exclude-tools)
   * - Extra CLI flags from additionalArgs
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param extensionPath Extension installation directory
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for resolved properties
   * @returns Complete CLI arguments array (without prompt - that's handled separately)
   */
  async buildCliArgs(
    _prompt: PromptItem,
    isInteractive: boolean,
    extensionPath: string,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workingFilePath?: string;
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension or user MCP servers are enabled)
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
      Log.debug("🔧 FlightPath MCP config written for Qwen");
    }

    // Parallel workflow isolation: restrict MCP server access so prompts in
    // one workflow can't accidentally use another workflow's servers from the
    // shared .qwen/settings.json.
    if (workspaceRoot) {
      const promptMcpNames = this.getPromptMcpServerNames(
        workflowContext?.resolvedProperties?.mcpServers
      );
      const allowed =
        QwenCliProvider.mcpTracker.getAllowedServerNames(promptMcpNames);
      if (allowed) {
        args.push("--allowed-mcp-server-names", ...allowed);
      }
    }

    // Note: Headless-specific flags (--output-format) are added by
    // buildHeadlessArgs() to ensure correct positioning after the prompt argument.

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.

    // Session management: Resume with explicit session ID
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );
    if (shouldResume) {
      args.push("--continue", sessionId!);
      Log.debug(`✅ Added continue flag: --continue ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(`🆕 Starting new session`);
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    // Tool permissions (headless only) / interactive hook setup
    if (!isInteractive) {
      // Use resolved permissions from workflow context; fall back to global settings
      const toolPermissions =
        workflowContext?.resolvedProperties?.toolPermissions;
      if (toolPermissions === undefined) {
        // No workflow context — fall back to global ConfigurationUtils settings
        const permissionConfig = {
          mode: ConfigurationUtils.getCliToolPermissions(),
          allowedTools: ConfigurationUtils.getCliAllowedTools(),
          deniedTools: ConfigurationUtils.getCliDeniedTools(),
        };
        const toolPermissionArgs =
          this.toolPermissionMapper.buildArgs(permissionConfig);
        args.push(...toolPermissionArgs);
      } else if (toolPermissions !== null) {
        // Resolved non-passthrough permissions from workflow
        const toolPermissionArgs =
          this.toolPermissionMapper.buildArgs(toolPermissions);
        args.push(...toolPermissionArgs);
      }
      // else: toolPermissions === null → passthrough, skip permission flags entirely
    } else {
      // Interactive mode: enable experimental hooks and write Stop hook to .qwen/settings.json
      args.push("--experimental-hooks");
      if (workspaceRoot) {
        const userHooks = workflowContext?.resolvedProperties?.hooks ?? undefined;
        await this.buildInteractiveHookSettings(extensionPath, workspaceRoot, userHooks);
        Log.debug(`🔔 Configured Stop hook for Qwen completion detection`);
      }
    }

    Log.debug(`🔧 Qwen CLI arguments: ${JSON.stringify(args)}`);

    return args;
  }

  /**
   * Extract MCP server names configured for this prompt.
   * Used for `--allowed-mcp-server-names` parallel workflow isolation.
   */
  private getPromptMcpServerNames(
    mcpServers?: Array<string | McpServerConfig> | null
  ): string[] {
    if (!mcpServers) {
      return [];
    }
    return mcpServers.map((s) => (typeof s === "string" ? s : s.id));
  }

  /**
   * Merge FlightPath hooks into .qwen/settings.json and pre-trust them in
   * ~/.qwen/trusted_hooks.json so Qwen doesn't prompt the user for approval.
   *
   * Uses SettingsJsonHooksTracker for parallel-safe ref-counted hook management.
   */
  private async buildInteractiveHookSettings(
    extensionPath: string,
    workspaceRoot: string,
    userHooks?: UserHookConfig[]
  ): Promise<void> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "flightpath-qwen-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    // Build hooks section via the notification monitor (single source of truth).
    // FLIGHTPATH_DIAGNOSTIC_LOGS is injected into the CLI process env at spawn time
    // via CliIntegration (CliProviderUtils.buildProcessEnv default) so hook subprocesses
    // inherit it. Using KEY=VALUE prefix in the command string does not work on Windows.
    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot
    );
    const hooksSection = (
      hookConfig as { type: string; config: { hooks: Record<string, unknown> } }
    ).config.hooks;

    // Convert user hooks to Qwen native format
    const qwenEventMap: Record<string, string> = {
      stop: "Stop",
      sessionStart: "SessionStart",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      userPromptSubmit: "UserPromptSubmit",
    };

    const workflowUserHooks: Record<string, unknown[]> = {};
    if (userHooks) {
      for (const uh of userHooks) {
        const nativeEvent = qwenEventMap[uh.event];
        if (!nativeEvent) continue;
        if (!workflowUserHooks[nativeEvent]) workflowUserHooks[nativeEvent] = [];
        workflowUserHooks[nativeEvent].push({
          hooks: [{ type: "command", command: uh.command }],
        });
      }
    }

    // Register hooks via ref-counted tracker under shared mutex
    await QwenCliProvider.mcpTracker.withLock(async () => {
      await QwenCliProvider.hooksTracker.registerWorkflow(
        workspaceRoot,
        workspaceRoot,
        hooksSection as Record<string, unknown[]>,
        workflowUserHooks
      );
    });

    // Pre-trust the hook command in ~/.qwen/trusted_hooks.json.
    // Key format: "${name}:${command}" where name defaults to "".
    // Must match the command format in buildHookConfig exactly (no quotes — see note there).
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");
    const baseCommand = `node ${normalizedScriptPath} ${normalizedNotifyDir}`;

    const globalQwenDir = path.join(os.homedir(), ".qwen");
    const trustedHooksPath = path.join(globalQwenDir, "trusted_hooks.json");

    let trustedHooks: Record<string, string[]> = {};
    try {
      const content = await fs.readFile(trustedHooksPath, "utf-8");
      trustedHooks = JSON.parse(content);
    } catch {
      // File doesn't exist — start fresh
    }

    if (!trustedHooks[workspaceRoot]) {
      trustedHooks[workspaceRoot] = [];
    }
    const key = `:${baseCommand}`;
    if (!trustedHooks[workspaceRoot].includes(key)) {
      trustedHooks[workspaceRoot].push(key);
    }

    // Also pre-trust user hook commands
    if (userHooks) {
      for (const uh of userHooks) {
        const userKey = `:${uh.command}`;
        if (!trustedHooks[workspaceRoot].includes(userKey)) {
          trustedHooks[workspaceRoot].push(userKey);
        }
      }
    }

    await fs.mkdir(globalQwenDir, { recursive: true });
    await fs.writeFile(
      trustedHooksPath,
      JSON.stringify(trustedHooks, null, 2),
      "utf-8"
    );
  }

  /**
   * Clean up workflow artifacts from .qwen/settings.json.
   *
   * Two independent cleanup steps:
   * 1. MCP servers: unregister via tracker (ref-counted, parallel-safe)
   * 2. Hooks: unregister via tracker (ref-counted, restores baseline on last unregister)
   *
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Unique workflow key for MCP tracker
   */
  async cleanupWorkspaceArtifacts(
    workspaceRoot: string,
    workingFilePath?: string
  ): Promise<void> {
    // Unregister MCP servers (ref-counted — only removes when no other workflow needs them)
    if (workingFilePath) {
      await QwenCliProvider.mcpTracker.unregisterWorkflow(
        workingFilePath,
        workspaceRoot
      );
    }

    // Unregister hooks via ref-counted tracker (serialized to avoid file races)
    await QwenCliProvider.mcpTracker.withLock(async () => {
      await QwenCliProvider.hooksTracker.unregisterWorkflow(
        workspaceRoot,
        workspaceRoot
      );
    });

    // Qwen Code CLI creates settings.json.orig as its own backup when it reads our
    // settings.json. Clean it up since the user didn't have it before we ran.
    const origPath = path.join(workspaceRoot, ".qwen", "settings.json.orig");
    await fs.unlink(origPath).catch(() => {});
  }

  /**
   * Validate model is supported by Qwen CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    const defaultModel = ConfigurationUtils.getQwenCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check for "none" sentinel value (skip --model flag)
    if (requestedModel === "none") {
      return undefined;
    }

    // For now, accept any model string - Qwen CLI will validate
    // Future enhancement: maintain a list of known Qwen models
    return requestedModel;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Qwen CLI expects the prompt as a positional argument.
   * Format: qwen "prompt" --output-format stream-json [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.flightpath/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote special characters
    // --output-format stream-json enables structured JSON output for reliable parsing
    return [`"${prompt}"`, "--output-format", "stream-json", ...baseArgs];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * Qwen interactive mode: qwen "prompt text" [args...] (no --output-format = interactive)
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string {
    return `${this.config.name} -i "${promptText.replace(/"/g, '\\"')}" ${baseArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Qwen Code CLI
   *
   * Qwen accepts @path format for file references (same as Copilot).
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path")
   */
  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration for Qwen Code CLI.
   *
   * Qwen CLI auto-discovers MCP servers from `.qwen/settings.json` in the project root.
   * This method registers servers with the shared SettingsJsonMcpTracker which handles:
   * - Reference counting for parallel workflow safety
   * - Idempotent adds (skip if server already in settings.json)
   * - Cleanup via unregisterWorkflow() in cleanupWorkspaceArtifacts()
   *
   * @returns Empty array (config is auto-discovered from settings.json, no CLI args needed)
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: import("../../../types/FlightPathTypes").McpServerConfig[]
  ): Promise<string[] | null> {
    if (!mcpServerPath && (!userServers || userServers.length === 0)) {
      return null;
    }

    try {
      // Build MCP server entries using shared helper
      const mcpEntries = CliProviderUtils.buildSettingsJsonMcpEntries(
        mcpServerPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv,
        userServers
      );

      // Register with tracker (ref-counted, idempotent adds to settings.json)
      const workflowKey = workingFilePath ?? "default";
      await QwenCliProvider.mcpTracker.registerServers(
        workflowKey,
        workspaceRoot,
        mcpEntries
      );

      Log.debug(`🔧 Qwen MCP servers registered via tracker`);

      // Return empty array — Qwen auto-discovers settings.json, no CLI arg needed
      return [];
    } catch (error) {
      Log.warn(`Failed to register Qwen MCP servers: ${error}`);
      return null;
    }
  }

  /**
   * Return null — MCP config is merged into .qwen/settings.json (not a separate file).
   * Cleanup is handled by cleanupWorkspaceArtifacts() which restores from backup.
   */
  getMcpConfigFilePath(
    _workingFilePath: string | undefined,
    _workspaceRoot: string
  ): null {
    return null;
  }

  /**
   * Check if Qwen Code CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("qwen --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Qwen Code CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("qwen --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
