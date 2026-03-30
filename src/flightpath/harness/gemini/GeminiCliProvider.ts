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
  PromptItem,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

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
      // Interactive mode: write AfterAgent hook to .gemini/settings.json
      if (workspaceRoot) {
        const userHooks = workflowContext?.resolvedProperties?.hooks ?? undefined;
        await this.buildInteractiveHookSettings(extensionPath, workspaceRoot, userHooks);
        Log.debug(
          `🔔 Configured AfterAgent hook for Gemini completion detection`
        );
      }
    }

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
   * Merge FlightPath hooks into .gemini/settings.json and pre-trust them in
   * ~/.gemini/trusted_hooks.json so Gemini doesn't prompt the user for approval.
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
      "flightpath-gemini-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected hook config type for Gemini CLI");
    }

    const flightpathHooksSection = (
      hookConfig.config as Record<string, unknown>
    )["hooks"] as Record<string, unknown[]>;

    // Convert user hooks to Gemini native format
    const geminiEventMap: Record<string, string> = {
      stop: "AfterAgent",
      sessionStart: "SessionStart",
    };

    const workflowUserHooks: Record<string, unknown[]> = {};
    if (userHooks) {
      for (const uh of userHooks) {
        const nativeEvent = geminiEventMap[uh.event];
        if (!nativeEvent) continue;
        if (!workflowUserHooks[nativeEvent]) workflowUserHooks[nativeEvent] = [];
        workflowUserHooks[nativeEvent].push({
          hooks: [{ type: "command", command: uh.command }],
        });
      }
    }

    // Register hooks via ref-counted tracker under shared mutex
    await GeminiCliProvider.mcpTracker.withLock(async () => {
      await GeminiCliProvider.hooksTracker.registerWorkflow(
        workspaceRoot,
        workspaceRoot,
        flightpathHooksSection,
        workflowUserHooks
      );
    });

    // Pre-trust the hook commands in ~/.gemini/trusted_hooks.json
    // Key format: "${name}:${command}" where name defaults to ""
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");
    const hookCommand = `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`;
    const hookKey = `:${hookCommand}`;

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
    if (!trustedHooks[workspaceRoot].includes(hookKey)) {
      trustedHooks[workspaceRoot].push(hookKey);
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
    await GeminiCliProvider.mcpTracker.withLock(async () => {
      await GeminiCliProvider.hooksTracker.unregisterWorkflow(
        workspaceRoot,
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
    try {
      await execAsync("gemini --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("gemini --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
