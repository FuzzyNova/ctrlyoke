import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { GeminiResponseParser } from "./GeminiResponseParser";
import { GeminiNotificationMonitor } from "./GeminiNotificationMonitor";
import { GeminiToolPermissionMapper } from "./GeminiToolPermissionMapper";
import { GeminiLogParser } from "./GeminiLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getGeminiModelName, MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { SettingsJsonMcpTracker } from "../shared/SettingsJsonMcpTracker";
import { SettingsJsonHooksTracker } from "../shared/SettingsJsonHooksTracker";
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
 * Gemini CLI Harness
 *
 * Implements Gemini-specific logic:
 * - Process-exit completion detection (headless)
 * - Stream-json output parsing
 * - Tool permission mapping (mode-based)
 * - Session ID extraction from init events
 */
export class GeminiCliProvider implements ICliProvider {
  /** Shared singleton tracker for parallel-safe MCP management in .gemini/settings.json */
  private static readonly mcpTracker =
    SettingsJsonMcpTracker.getInstance("gemini");

  /** Shared singleton tracker for parallel-safe hooks management in .gemini/settings.json */
  private static readonly hooksTracker =
    SettingsJsonHooksTracker.getInstance("gemini");

  readonly config: HarnessConfig = {
    name: "gemini",
    harnessId: HARNESS_IDS.GEMINI_CLI,
    displayName: "Gemini CLI",
    terminalName: "Gemini",
    installHint: "Install via: npm install -g @google/gemini-cli",
    shouldStreamHeadlessOutput: true,
    // Gemini uses AfterAgent hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new GeminiResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new GeminiNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new GeminiToolPermissionMapper();
  readonly logParser = new GeminiLogParser();

  async buildCliArgs(
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
    }
  ): Promise<string[]> {
    const args: string[] = [];

    const resolvedModel = workflowContext?.resolvedProperties?.model;
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
      Log.debug("🔧 FlightPath MCP config written for Gemini");
    }

    // Parallel workflow isolation: restrict MCP server access so prompts in
    // one workflow can't accidentally use another workflow's servers from the
    // shared .gemini/settings.json.
    if (workspaceRoot) {
      const promptMcpNames = this.getPromptMcpServerNames(
        workflowContext?.resolvedProperties?.mcpServers
      );
      const allowed =
        GeminiCliProvider.mcpTracker.getAllowedServerNames(promptMcpNames);
      if (allowed) {
        args.push("--allowed-mcp-server-names", ...allowed);
      }
    }

    // Model selection
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Session management
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    if (shouldResume) {
      args.push("--session-id", sessionId!);
    }

    // Extra CLI flags
    const additionalArgs = workflowContext?.resolvedProperties?.additionalArgs;
    if (additionalArgs) {
      const tokens = parseArgString(additionalArgs);
      args.push(...tokens);
    }

    // Hook setup (interactive notification hooks + headless user hooks) is dispatched
    // by CliIntegration.runExecutionSession() via buildNotificationHookArgs() /
    // buildHeadlessUserHookArgs() — not here in buildCliArgs().
    // Permission args are similarly dispatched via buildPermissionArgs() — not here.

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
   * Set up FlightPath notification hooks (AfterAgent + user hooks) for interactive mode.
   * Merges hooks into .gemini/settings.json and pre-trusts them in trusted_hooks.json.
   * Returns [] — Gemini auto-discovers hooks from settings.json (no CLI args needed).
   */
  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "flightpath-gemini-hook.js"
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
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected hook config type for Gemini CLI");
    }
    const flightpathHooksSection = (
      hookConfig.config as Record<string, unknown>
    )["hooks"] as Record<string, unknown[]>;

    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");
    const hookKey = `:node "${normalizedScriptPath}" "${normalizedNotifyDir}"`;

    const workflowKey = workingFilePath ?? workspaceRoot;
    await this.registerHooksInSettings(
      workspaceRoot,
      workflowKey,
      flightpathHooksSection,
      hookKey,
      userHooks
    );
    Log.debug(`🔔 Configured AfterAgent hook for Gemini completion detection`);
    return [];
  }

  /**
   * Set up user-only hooks for headless execution.
   * No FlightPath notification hooks are included since headless uses process-exit for completion.
   * Returns [] — Gemini auto-discovers hooks from settings.json (no CLI args needed).
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
                "flightpath-gemini-hook.js"
              ),
              this.notificationMonitor.getNotificationDirectory(workspaceRoot),
              workspaceRoot,
              userHooks,
              enabledNotificationHookEvents
            );
            if (hookConfig.type !== "json") {
              throw new Error("Unexpected hook config type for Gemini CLI");
            }
            return (
              hookConfig.config as Record<string, Record<string, unknown[]>>
            ).hooks;
          })()
        : {};
    await this.registerHooksInSettings(
      workspaceRoot,
      workflowKey,
      flightpathHooksSection,
      undefined,
      userHooks
    );
    Log.debug(`🔔 Configured user hooks for Gemini headless mode`);
    return [];
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   */
  buildPermissionArgs(
    toolPermissions: ToolPermissionConfig | null | undefined
  ): string[] {
    if (toolPermissions === null) {
      // none mode — skip permission flags entirely
      return [];
    }
    const config = toolPermissions ?? {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.toolPermissionMapper.buildArgs(config);
  }

  /**
   * Shared helper: merge hooks into .gemini/settings.json and pre-trust them.
   *
   * Uses SettingsJsonHooksTracker for parallel-safe ref-counted hook management.
   * Pass an empty flightpathHooksSection + undefined hookKey for headless (user-only) mode.
   */
  private async registerHooksInSettings(
    workspaceRoot: string,
    workflowKey: string,
    flightpathHooksSection: Record<string, unknown[]>,
    flightpathHookKey: string | undefined,
    userHooks: UserHookConfig[] | undefined
  ): Promise<void> {
    const geminiEventMap: Record<string, string> = {
      stop: "AfterAgent",
      sessionStart: "SessionStart",
    };

    const workflowUserHooks: Record<string, unknown[]> = {};
    if (userHooks) {
      for (const uh of userHooks) {
        const nativeEvent = geminiEventMap[uh.event];
        if (!nativeEvent) continue;
        if (!workflowUserHooks[nativeEvent])
          workflowUserHooks[nativeEvent] = [];
        workflowUserHooks[nativeEvent].push({
          hooks: [{ type: "command", command: uh.command }],
        });
      }
    }

    await GeminiCliProvider.mcpTracker.withLock(async () => {
      await GeminiCliProvider.hooksTracker.registerWorkflow(
        workflowKey,
        workspaceRoot,
        flightpathHooksSection,
        workflowUserHooks
      );
    });

    // Pre-trust hook commands in ~/.gemini/trusted_hooks.json
    const globalGeminiDir = path.join(os.homedir(), ".gemini");
    const trustedHooksPath = path.join(globalGeminiDir, "trusted_hooks.json");

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
    if (
      flightpathHookKey &&
      !trustedHooks[workspaceRoot].includes(flightpathHookKey)
    ) {
      trustedHooks[workspaceRoot].push(flightpathHookKey);
    }

    if (userHooks) {
      for (const uh of userHooks) {
        const userKey = `:${uh.command}`;
        if (!trustedHooks[workspaceRoot].includes(userKey)) {
          trustedHooks[workspaceRoot].push(userKey);
        }
      }
    }

    await fs.mkdir(globalGeminiDir, { recursive: true });
    await fs.writeFile(
      trustedHooksPath,
      JSON.stringify(trustedHooks, null, 2),
      "utf-8"
    );
  }

  /**
   * Clean up workflow artifacts from .gemini/settings.json.
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
      await GeminiCliProvider.mcpTracker.unregisterWorkflow(
        workingFilePath,
        workspaceRoot
      );
    }

    // Unregister hooks via ref-counted tracker (serialized to avoid file races)
    const hookKey = workingFilePath ?? workspaceRoot;
    await GeminiCliProvider.mcpTracker.withLock(async () => {
      await GeminiCliProvider.hooksTracker.unregisterWorkflow(
        hookKey,
        workspaceRoot
      );
    });
  }

  private validateAndGetModel(requestedModel?: string): string | undefined {
    if (requestedModel === MODEL_NONE) {
      return undefined;
    }
    return getGeminiModelName(requestedModel || "gemini-2.5-pro");
  }

  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote spaces/special chars
    const quotedPrompt = `"${prompt.replace(/"/g, '\\"')}"`;
    return [
      "--prompt",
      quotedPrompt,
      "--output-format",
      "stream-json",
      ...baseArgs,
    ];
  }

  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string {
    return `gemini --prompt-interactive "${promptText.replace(/"/g, '\\"')}" ${baseArgs.join(" ")}`;
  }

  /**
   * Generate MCP server configuration for Gemini CLI.
   *
   * Gemini CLI auto-discovers MCP servers from `.gemini/settings.json` in the project root.
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
    userServers?: McpServerConfig[]
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
      await GeminiCliProvider.mcpTracker.registerServers(
        workflowKey,
        workspaceRoot,
        mcpEntries
      );

      Log.debug(`🔧 Gemini MCP servers registered via tracker`);

      // Return empty array — Gemini auto-discovers settings.json, no CLI arg needed
      return [];
    } catch (error) {
      Log.warn(`Failed to register Gemini MCP servers: ${error}`);
      return null;
    }
  }

  /**
   * Return null — MCP config is merged into .gemini/settings.json (not a separate file).
   * Cleanup is handled by cleanupWorkspaceArtifacts() which restores from backup.
   */
  getMcpConfigFilePath(
    _workingFilePath: string | undefined,
    _workspaceRoot: string
  ): null {
    return null;
  }

  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability("gemini --version");
  }

  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion("gemini --version");
  }
}
