import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { CopilotResponseParser } from "./CopilotResponseParser";
import { CopilotNotificationMonitor } from "./CopilotNotificationMonitor";
import { CopilotToolPermissionMapper } from "./CopilotToolPermissionMapper";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import {
  getCliSupportedModelIds,
  isCliModelSupported,
} from "../../../utils/ModelRegistry";
import { Log } from "../../../utils/Log";

const execAsync = promisify(exec);

/**
 * Copilot CLI Provider
 *
 * Implements all Copilot-specific logic using composition pattern:
 * - TUI patterns and completion detection (escapeIndicator, chromePatterns)
 * - sessionEnd hook configuration for reliable completion detection
 * - Plain text output parsing with stderr statistics
 * - Tool permission conversion with read-only tool filtering
 * - MCP server configuration with "local" type and tools field
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
  readonly config: ProviderConfig = {
    name: "copilot",
    displayName: "GitHub Copilot CLI",
    installHint: "Install via: npm install -g @github/copilot",
    escapeIndicator: "Esc to cancel",
    screenEndPattern: /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi,
    chromePatterns: [
      // Copilot-specific box drawing and separators (UI chrome only)
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing characters (8+ in a row = UI chrome)
      /^[─═]{50,}$/, // Very long horizontal separators (50+ = UI chrome)
      /^│\s*│$/, // Empty box sides

      // Copilot welcome and version info (UI chrome)
      /^Welcome to GitHub Copilot CLI/i, // Welcome header
      /Version.*·.*Commit/i, // Version line (distinctive parts)
      /check for mistakes/i, // Description line (distinctive ending)

      // Copilot status bullets (UI chrome, very specific text)
      /^●\s+Logged in as user:/i, // Login status
      /^●\s+Connected to.*MCP Server/i, // Connection status
      /^●\s+Model changed to:/i, // Model change notification

      // Copilot spinner/thinking indicator (UI chrome - just the spinner character alone)
      /^\s*[·∙◉◎●]\s*$/, // Spinner alone (U+00B7 middle dot, U+2219 bullet operator, or filled circles)

      // Copilot spinner with status text and cancel hint (UI chrome)
      // Allow optional leading whitespace (left after zero-width char stripping)
      // Note: Only filters lines that are JUST chrome (no content before the spinner)
      /^\s*[·∙◉◎●]\s+.*\(Esc to cancel/i, // Pure chrome: "∙ Thinking (Esc to cancel)"

      // Copilot status bar (UI chrome - path + branch + model display)
      /\[⎇\s+\w+\*?\].*gpt-.*\(\d+x\)/i, // Look for distinctive parts: branch indicator, model, and multiplier

      // Copilot bottom navigation bar (already in screenEndPattern, but keep for safety)
      /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand/i, // Bottom status bar
      /·\s*Ctrl\+t\s+Show\s+reasoning/i, // Bottom actions: "· Ctrl+t Show reasoning"
      /·\s*Ctrl\+d\s+Enqueue/i, // Bottom actions: "· Ctrl+d Enqueue"

      // Copilot prompt hints (UI chrome)
      /Enter @ to mention files/i, // Prompt hint (distinctive part)
      /^>\s*$/, // Empty prompt line

      // Copilot approval prompts (UI chrome)
      /^Do you want to run this command\?/i, // Approval question
      /Confirm with number keys.*Cancel with Esc/i, // Confirmation hint
      /^❯\s*\d+\./, // Selected option indicator (any option)
      /No, and tell Copilot what to do differently/i, // Option text
    ],
    shouldStreamHeadlessOutput: true,

    // Copilot uses sessionEnd hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new CopilotResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CopilotNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CopilotToolPermissionMapper();

  /** Log directory for session ID tracking */
  private logDirectory?: string;

  constructor() {
    this.initializeLogDirectory();
  }

  /**
   * Initialize log directory for session ID tracking.
   * Uses configured directory or falls back to OS temp directory + FlightPath subdirectory.
   */
  private initializeLogDirectory(): void {
    const configuredDir = ConfigurationUtils.getCopilotCliLogDir();

    if (configuredDir) {
      this.logDirectory = configuredDir;
    } else {
      // Fallback: Create FlightPath-specific log directory in OS temp folder
      // Cross-platform: works on Windows (C:\Users\{user}\AppData\Local\Temp), macOS/Linux (/tmp)
      this.logDirectory = path.join(os.tmpdir(), "flightpath-copilot-logs");
    }
    Log.info(`📁 Copilot log directory: ${this.logDirectory}`);
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
    const resolvedNewChatSession =
      workflowContext?.resolvedProperties?.newChatSession;

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

    // Logging configuration
    if (this.logDirectory) {
      args.push("--log-dir", this.logDirectory);
    }
    const logLevel = ConfigurationUtils.getCopilotCliLogLevel();
    if (logLevel !== "default") {
      args.push("--log-level", logLevel);
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
    const shouldStartNewSession = resolvedNewChatSession ?? false;
    Log.debug(
      `🔍 Session check (resolved): newChatSession=${resolvedNewChatSession}, shouldStartNewSession=${shouldStartNewSession}, sessionId=${sessionId}`
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
   * Extract session ID from Copilot CLI process log files.
   *
   * New log format (as of CLI v0.0.377+): process-{timestamp}-{pid}.log
   * Session ID appears in log lines: "Flushed X events to session {GUID}"
   * Requires --log-level debug or higher to capture session ID.
   * Returns the session ID from the most recently modified log file.
   *
   * @returns Session ID if found, undefined otherwise
   */
  async extractSessionIdFromLogs(): Promise<string | undefined> {
    if (!this.logDirectory) {
      return undefined;
    }

    try {
      // Ensure log directory exists
      await fs.mkdir(this.logDirectory, { recursive: true });

      // Read all files in log directory
      const files = await fs.readdir(this.logDirectory);

      // Filter for process log files (process-{timestamp}-{pid}.log)
      const processFiles = files.filter((file) =>
        file.match(/^process-\d+-\d+\.log$/i)
      );

      if (processFiles.length === 0) {
        return undefined;
      }

      // Get file stats to find most recent
      const fileStats = await Promise.all(
        processFiles.map(async (file) => {
          const filePath = path.join(this.logDirectory!, file);
          const stats = await fs.stat(filePath);
          return { file, filePath, mtime: stats.mtime };
        })
      );

      // Sort by modification time (most recent first)
      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Read the most recent log file and search for session ID
      const logContent = await fs.readFile(fileStats[0].filePath, "utf-8");

      // Pattern: "Flushed X events to session {GUID}"
      // Example: "2026-01-12T20:11:10.385Z [DEBUG] Flushed 3 events to session 4f59192e-65ed-4fdb-aed7-ce69a263dd7b"
      const match = logContent.match(
        /Flushed \d+ events to session ([a-f0-9-]+)/i
      );

      if (match && match[1]) {
        return match[1];
      }

      return undefined;
    } catch (error) {
      Log.error("❌ Failed to extract session ID from logs", error);
      return undefined;
    }
  }

  /**   * Build CLI arguments for headless mode with file reference
   *
   * Copilot requires --prompt flag to specify file references.
   * Format: copilot --prompt "@path/to/file" [other args]
   *
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return ["--prompt", `"${promptFileRef}"`, ...baseArgs];
  }

  /**
   * Build CLI arguments for headless mode with direct prompt
   *
   * Simple prompts: pass directly with --prompt flag.
   * Format: copilot --prompt "your question here" [other args]
   *
   * @param baseArgs Base arguments array
   * @param promptText Prompt text
   * @returns Complete arguments array
   */
  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    // Note: Quotes handle spaces and special chars
    return ["--prompt", `"${promptText}"`, ...baseArgs];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string {
    return `${this.config.name} ${baseArgs.join(" ")}`;
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
