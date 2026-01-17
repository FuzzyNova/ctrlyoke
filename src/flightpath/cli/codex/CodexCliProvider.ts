import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import * as path from "path";
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { CodexResponseParser } from "./CodexResponseParser";
import { CodexNotificationMonitor } from "./CodexNotificationMonitor";
import { CodexToolPermissionMapper } from "./CodexToolPermissionMapper";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { CODEX_CLI_MODELS } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";

const execAsync = promisify(exec);

/**
 * Codex CLI Provider
 *
 * Implements all Codex-specific logic using composition pattern:
 * - TUI patterns and completion detection (escapeIndicator, chromePatterns)
 * - Notify hook configuration for reliable completion detection
 * - JSONL output parsing with event-based streaming
 * - Mode-based permissions (no granular tool patterns)
 * - MCP server configuration with inline TOML format
 *
 * This provider aggregates four specialized components:
 * - CodexResponseParser: Parses JSONL output and statistics
 * - CodexNotificationMonitor: Monitors notify hook notifications
 * - CodexToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration (shared)
 *
 * Codex CLI-specific features:
 * - Uses JSONL output format (multiple {"type": "..."} events)
 * - Notify hook with TOML inline config: notify=['node','path']
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
  readonly config: ProviderConfig = {
    name: "codex",
    displayName: "Codex CLI",
    installHint: "Install via: npm install -g @openai/codex-cli",
    escapeIndicator: "esc to interrupt",
    screenEndPattern: /›\s|\d+%\s+context\s+left/g,
    chromePatterns: [
      // Codex-specific box borders (UI chrome only)
      /^[╭╰]─+[╮╯]$/, // Box top/bottom borders
      />_\s+OpenAI Codex/i, // Header (distinctive marker)
      /^│\s*│$/, // Empty box lines
      /model:.*\/model to change/i, // Model info line (distinctive parts)
      /directory:.*│$/i, // Directory line in box

      // Codex informational messages (UI chrome)
      /^Tip:/i, // Tips (any tip)
      /is deprecated.*Use \[features\]/i, // Deprecation warnings (distinctive parts)
      /^Enable it with/i, // Configuration hints
      /github\.com\/openai\/codex/i, // Documentation links

      // Codex status bar (UI chrome - context percentage and shortcuts)
      /\d+%\s+context\s+left.*\?\s+for shortcuts/i, // Status bar (distinctive parts)
      /^\d+%\s+context\s+left\s*$/i, // Context percentage alone
      /[·•]\s*\?\s*for shortcuts/i, // Status bar fragment (just shortcuts part)

      // Codex prompt indicator when empty (UI chrome)
      /^›\s*$/, // Empty prompt line only

      // Codex approval prompts (UI chrome)
      /Would you like to run the following command\?/i, // Approval question
      /^\s*Reason:/i, // Reason line prefix
      /^›\s+\d+\.\s+Yes, proceed/i, // Option 1 (distinctive part)
      /Yes, and don't ask again for commands that start with/i, // Option 2 (distinctive part)
      /No, and tell Codex what to do differently/i, // Option 3
      /Press enter to confirm or esc to cancel/i, // Confirmation hint

      // Codex separators (UI chrome)
      /^─\s+Worked for \d+s\s+─/i, // Worked for Xs separator

      // Codex spinner/thinking indicator (UI chrome)
      /^•?\s*W(o(r(k(i(n(g)?)?)?)?)?)?\d*\s*$/i, // Working prefixes (W, Wo, Wor, Work, Worki, Workin, Working + numbers)
      /^•?\s*(orking|rking|king|ing|ng|g)\s*$/i, // Working suffixes (fragments from right side)
      /^•?\s*\d+\s*$/i, // Standalone numbers (spinner frame counters)
      /^[•·]\s*$/i, // Standalone bullet points
      /\(.*esc to interr?upt.*\)/i, // Lines with "(esc to interrupt)" or "(Xs • esc to interrupt)" (handles typo "interupt")
      /\d+s\s*[•·]\s*esc to interr?upt/i, // Timer with escape indicator (handles missing opening paren)
    ],
    shouldStreamHeadlessOutput: true,

    // Codex uses notify hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new CodexResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CodexNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CodexToolPermissionMapper();

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
   * - Notify hook settings (interactive mode only)
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
    const resolvedModel = workflowContext?.resolvedProperties?.model;
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
            Log.info("🔧 MCP server config added for dynamic queue extension");
          }
        }
      }
    }

    // Headless mode: add exec command and --json flag
    if (!isInteractive) {
      args.push("exec");
      args.push("--json");
    }

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    args.push("--model", model);

    // Add workspace directories
    if (workspaceRoot) {
      const workspaceDirs = this.getWorkspaceDirs(workspaceRoot);
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Tool permissions (only for headless mode - interactive mode lets user approve interactively)
    if (!isInteractive) {
      const permissionConfig = {
        mode: ConfigurationUtils.getCliToolPermissions(),
        allowedTools: ConfigurationUtils.getCliAllowedTools(),
        deniedTools: ConfigurationUtils.getCliDeniedTools(),
      };

      // Use Codex-specific permission mapper with sandbox/approval settings
      const sandboxMode = ConfigurationUtils.getCodexSandboxMode();
      const approvalPolicy = ConfigurationUtils.getCodexApprovalPolicy();
      const toolPermissionArgs = (
        this.toolPermissionMapper as CodexToolPermissionMapper
      ).buildCodexSpecificArgs(permissionConfig, sandboxMode, approvalPolicy);
      args.push(...toolPermissionArgs);

      // Add additional allowed directories (only in headless mode when not dangerous mode)
      if (permissionConfig.mode !== "dangerouslyAllowAll") {
        const additionalDirs = ConfigurationUtils.getCodexAllowedDirs();
        additionalDirs.forEach((dir: string) => {
          args.push("--add-dir", dir);
        });
      }
    } else {
      // Interactive mode: Configure notify hook for completion detection
      if (workspaceRoot) {
        const scriptPath = path.join(
          context.extensionPath,
          "out",
          "scripts",
          "flightpath-codex-notify.js"
        );
        const notifyDir =
          this.notificationMonitor.getNotificationDirectory(workspaceRoot);

        const hookConfig = this.notificationMonitor.buildHookConfig(
          scriptPath,
          notifyDir,
          workspaceRoot
        );

        // Codex uses --config flag with TOML inline format
        if (hookConfig.type === "toml-inline") {
          args.push("--config", hookConfig.config);
          Log.debug(`🔔 Configured notify hook for completion detection`);
        }
      }
    }

    // Session management - use resolved property if available
    const shouldStartNewSession = resolvedNewChatSession ?? false;
    Log.debug(
      `🔍 Session check (resolved): newChatSession=${resolvedNewChatSession}, shouldStartNewSession=${shouldStartNewSession}, sessionId=${sessionId}`
    );

    if (!shouldStartNewSession && sessionId) {
      // Resume existing session: codex [exec] [--json] ... resume <session-id>
      args.push("resume");
      args.push(sessionId);
      Log.debug(`✅ Added resume subcommand with session: ${sessionId}`);
    } else if (!shouldStartNewSession) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(
        `🆕 Starting new session (resolved shouldStartNewSession=${shouldStartNewSession})`
      );
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods (buildHeadlessArgs, etc.)

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

    return workspaceDirs;
  }

  /**
   * Validate model is supported by Codex CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = ConfigurationUtils.getCodexCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check if model is in the supported list
    if (CODEX_CLI_MODELS.includes(requestedModel as any)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Codex CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);
    vscode.window.showWarningMessage(
      `FlightPath: ${message}\n\nCodex-supported models: ${CODEX_CLI_MODELS.join(", ")}`
    );

    return defaultModel;
  }

  /**
   * Build CLI arguments for headless mode with file reference
   *
   * Codex expects: codex exec [OPTIONS] [PROMPT]
   * The prompt argument must come LAST after all flags/options.
   *
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., ".flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return [...baseArgs, `"${promptFileRef}"`];
  }

  /**
   * Build CLI arguments for headless mode with direct prompt
   *
   * Simple prompts: pass as LAST positional argument.
   * Format: codex exec [OPTIONS] "your question here"
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
    return [...baseArgs, `"${promptText}"`];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string {
    // Filter out headless-only flags for interactive mode
    const interactiveArgs = baseArgs.filter(
      (arg, i, arr) =>
        arg !== "--json" && arg !== "exec" && arr[i - 1] !== "--output-format"
    );

    // Quote arguments that contain special characters (brackets, quotes, etc.)
    const quotedArgs = interactiveArgs.map((arg) => {
      // If arg contains special chars like brackets, spaces, or quotes, wrap in double quotes
      // But escape any internal double quotes first
      if (/[\[\]\s"]/.test(arg)) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    });

    return `${this.config.name} ${quotedArgs.join(" ")}`;
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
   * @returns CLI arguments array with -c flag, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      const tomlConfig = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        mcpServerPath,
        workspaceRoot
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
      await execAsync("codex --version");
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
      const { stdout } = await execAsync("codex --version");
      // Extract version from output like "codex version 0.1.2"
      const match = stdout.match(/codex version ([\d.]+)/i);
      return match ? match[1] : stdout.trim();
    } catch {
      return undefined;
    }
  }
}
