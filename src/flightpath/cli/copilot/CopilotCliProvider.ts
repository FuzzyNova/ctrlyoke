import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { CopilotResponseParser } from "./CopilotResponseParser";
import { CopilotNotificationMonitor } from "./CopilotNotificationMonitor";
import { CopilotToolPermissionMapper } from "./CopilotToolPermissionMapper";
import { CopilotLogParser } from "./CopilotLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import {
  getCliSupportedModelIds,
  isCliModelSupported,
} from "../../../utils/ModelRegistry";
import { Log } from "../../../utils/Log";

const execAsync = promisify(exec);

/**
 * Copilot CLI Harness
 *
 * Implements all Copilot-specific logic using composition pattern:
 * - Log file monitoring and sessionEnd hook for completion detection
 * - Plain text output parsing with stderr statistics
 * - Tool permission conversion with read-only tool filtering
 * - MCP server configuration with "local" type and tools field
 * - Session discovery via prompt matching in event logs
 *
 * This provider aggregates four specialized components:
 * - CopilotResponseParser: Parses plain text output and statistics
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
  readonly config: HarnessConfig = {
    name: "copilot",
    displayName: "GitHub Copilot CLI",
    installHint: "Install via: npm install -g @github/copilot",
    shouldStreamHeadlessOutput: true,

    // Copilot uses sessionEnd hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new CopilotResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CopilotNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CopilotToolPermissionMapper();
  readonly logParser = new CopilotLogParser();

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
   * - Agent handling (--agent)
   * - Session management (--resume)
   * - sessionEnd hook (interactive mode only)
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
    prompt: any,
    isInteractive: boolean,
    context: vscode.ExtensionContext,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: any[];
      filePath?: string;
      resolvedProperties?: any; // ResolvedProperties from PropertyResolver
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    // This ensures workflow-level defaults are respected
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedAgent = workflowContext?.resolvedProperties?.agent;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension is enabled)
    if (workflowContext && workspaceRoot) {
      const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
      const allowDynamicExtension =
        workflowContext?.resolvedProperties?.allowDynamicExtension ??
        dynamicQueueConfig.enabled;

      if (allowDynamicExtension) {
        const {
          shouldInjectExtensionInstructions,
        } = require("../../../utils/PromptIdentity");
        const shouldInject = shouldInjectExtensionInstructions(
          prompt,
          workflowContext.promptIndex,
          workflowContext.allPrompts,
          dynamicQueueConfig.dynamicExtensionOnLastPrompt,
          allowDynamicExtension
        );

        if (shouldInject) {
          const mcpServerPath = context.asAbsolutePath("out/mcp-server.js");
          const mcpArgs = await this.getMcpConfigArgs(
            mcpServerPath,
            workspaceRoot
          );
          if (mcpArgs) {
            args.push(...mcpArgs);
            // Auto-approve FlightPath MCP tools (FlightPath is the orchestrator)
            args.push("--allow-tool", "flightpath");
            Log.info(
              "🔧 MCP server config added for dynamic queue extension (FlightPath tools auto-approved)"
            );
          }
        }
      }
    }

    // Tool permissions (only for headless mode - interactive mode lets user approve interactively)
    if (!isInteractive) {
      const permissionConfig = {
        mode: ConfigurationUtils.getCliToolPermissions(),
        allowedTools: ConfigurationUtils.getCliAllowedTools(),
        deniedTools: ConfigurationUtils.getCliDeniedTools(),
      };
      const toolPermissionArgs =
        this.toolPermissionMapper.buildArgs(permissionConfig);
      args.push(...toolPermissionArgs);
    } else {
      // Interactive mode: Configure sessionEnd hook for completion detection
      if (workspaceRoot) {
        const hookArgs = this.buildSessionEndHookArgs(context, workspaceRoot);
        args.push(...hookArgs);
        Log.debug(`🔔 Configured sessionEnd hook for completion detection`);
      }
    }

    // Path permissions
    if (ConfigurationUtils.shouldAllowAllPaths()) {
      args.push("--allow-all-paths");
    }

    // Workspace directories
    if (workspaceRoot) {
      const workspaceDirs = this.getWorkspaceDirs(workspaceRoot);
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling - use resolved property if available
    if (resolvedAgent) {
      const agentName = resolvedAgent.endsWith(".agent")
        ? resolvedAgent
        : `${resolvedAgent}.agent`;
      args.push("--agent", agentName);
      Log.info(`🤖 Using agent: ${agentName}`);
    }

    // Session resumption - use resolved property if available
    const shouldStartNewSession = !(resolvedResumeSession ?? false);
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, shouldStartNewSession=${shouldStartNewSession}, sessionId=${sessionId}`
    );
    if (!shouldStartNewSession && sessionId) {
      args.push("--resume", sessionId);
      Log.debug(`✅ Added resume flag: --resume ${sessionId}`);
    } else if (shouldStartNewSession) {
      Log.debug(
        `🆕 Starting new session (resolved shouldStartNewSession=${shouldStartNewSession})`
      );
    }

    Log.debug(`🔧 CLI arguments: ${JSON.stringify(args)}`);

    return args;
  }

  /**
   * Get workspace directories for --add-dir arguments
   */
  private getWorkspaceDirs(workspaceRoot: string): string[] {
    const workspaceDirs: string[] = [];

    // Add primary workspace folder
    if (vscode.workspace.workspaceFolders) {
      vscode.workspace.workspaceFolders.forEach((folder) => {
        workspaceDirs.push(folder.uri.fsPath);
      });
    }

    // Add configured allowed directories
    const allowedDirs = ConfigurationUtils.getCliAllowedDirs();
    allowedDirs.forEach((dir: string) => {
      const absolutePath = path.isAbsolute(dir)
        ? dir
        : path.join(workspaceRoot, dir);
      if (!workspaceDirs.includes(absolutePath)) {
        workspaceDirs.push(absolutePath);
      }
    });

    return workspaceDirs;
  }

  /**
   * Validate model is supported by Copilot CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = ConfigurationUtils.getCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check if model is supported by CLI (using dynamically discovered models)
    if (isCliModelSupported(requestedModel)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const supportedModels = getCliSupportedModelIds();
    const message = `Model "${requestedModel}" not supported by Copilot CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);

    vscode.window.showWarningMessage(
      `FlightPath: ${message}\n\nCLI-supported models: ${supportedModels.join(", ")}`
    );

    return defaultModel;
  }

  /**
   * Build sessionEnd hook arguments for interactive mode.
   * Returns CLI arguments to configure the hook.
   *
   * @param context Extension context for accessing hook script path
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array
   */
  private buildSessionEndHookArgs(
    context: vscode.ExtensionContext,
    workspaceRoot: string
  ): string[] {
    // Get notification directory from notification monitor
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    // Get hook script path from extension
    const hookScriptPath = context.asAbsolutePath(
      "out/scripts/flightpath-copilot-hook.js"
    );

    // Build hook config using notification monitor
    const hookConfig = this.notificationMonitor.buildHookConfig(
      hookScriptPath,
      notifyDir,
      workspaceRoot
    );

    // For Copilot, the hook config is written to .github/hooks/flightpath.json
    // However, we can also pass inline JSON via --hook argument if supported
    // For now, we'll create the hook file and let Copilot discover it automatically

    // Create the hook file
    this.createHookFile(hookConfig, workspaceRoot);

    // No additional CLI args needed - Copilot auto-discovers hooks in .github/hooks/
    return [];
  }

  /**
   * Create the sessionEnd hook file for Copilot
   */
  private async createHookFile(
    hookConfig: any,
    workspaceRoot: string
  ): Promise<void> {
    try {
      const hookDir = path.join(workspaceRoot, ".github", "hooks");
      await fs.mkdir(hookDir, { recursive: true });

      const hookPath = path.join(hookDir, "flightpath.json");
      await fs.writeFile(
        hookPath,
        JSON.stringify(hookConfig.config, null, 2),
        "utf-8"
      );

      Log.debug(`📁 Created hook file: ${hookPath}`);
    } catch (error) {
      Log.warn(`⚠️ Failed to create hook file: ${error}`);
    }
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Copilot requires --prompt flag to specify prompts.
   * Format: copilot --prompt "..." [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.flightpath/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return ["--prompt", `"${prompt}"`, ...baseArgs];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * Copilot interactive mode: copilot -i "prompt text" [args...]
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
   * Format a file path reference for Copilot CLI
   *
   * Copilot uses @ prefix for file references.
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path/to/file.ts")
   */
  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration arguments for Copilot CLI
   *
   * Copilot CLI uses --additional-mcp-config @<file> format.
   * Config file format: JSON with "type": "local" and "tools" field.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array with --additional-mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      // Generate MCP config JSON using shared utility
      // Copilot CLI requires "type": "local" and "tools" field
      const configJson = CliMcpConfigGenerator.generateJsonConfig(
        mcpServerPath,
        workspaceRoot,
        { type: "local", tools: ["*"] }
      );

      // Write to temp directory
      const tempDir = path.join(workspaceRoot, ".flightpath", "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const configPath = path.join(tempDir, "mcp-config.json");
      await fs.writeFile(configPath, configJson, "utf-8");

      // Return --additional-mcp-config @file argument
      return ["--additional-mcp-config", `@${configPath}`];
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return null;
    }
  }

  /**
   * Check if Copilot CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("copilot --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Copilot CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("copilot --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
