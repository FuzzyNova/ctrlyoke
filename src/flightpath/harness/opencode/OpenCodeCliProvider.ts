import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { OpenCodeResponseParser } from "./OpenCodeResponseParser";
import { OpenCodeNotificationMonitor } from "./OpenCodeNotificationMonitor";
import { OpenCodeToolPermissionMapper } from "./OpenCodeToolPermissionMapper";
import { OpenCodeLogParser } from "./OpenCodeLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getOpenCodeContextWindowSize } from "../../../utils/ModelRegistry";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import type { PromptItem } from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

/**
 * OpenCode CLI Harness
 *
 * Implements all OpenCode-specific logic using the composition pattern:
 * - Plugin-based completion detection (session.status idle events)
 * - JSONL response parsing (--format json)
 * - Config-file-driven tool permissions (opencode.json)
 * - Multi-provider model support (provider/model format)
 *
 * This provider aggregates four specialized components:
 * - OpenCodeResponseParser: Parses JSONL output and tool calls
 * - OpenCodeNotificationMonitor: Manages plugin-based completion detection
 * - OpenCodeToolPermissionMapper: Returns [] (permissions are config-file driven)
 * - OpenCodeLogParser: Stub implementation (log parsing not yet implemented)
 *
 * Headless execution:
 *   opencode run "prompt" --format json -m provider/model [-s sessionId]
 *
 * Interactive execution (with plugin for completion detection):
 *   opencode --prompt "prompt text" -m provider/model [-s sessionId]
 *   (plugin file written to .opencode/plugin/flightpath-completion-hook.js beforehand)
 *
 * Session management:
 *   -s <sessionId> — resume existing session (both modes)
 *   NOT -c — that's a global "continue last" which is not project-scoped
 *
 * Usage:
 * ```typescript
 * const provider = new OpenCodeCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class OpenCodeCliProvider implements ICliProvider {
  readonly config: HarnessConfig = {
    name: "opencode",
    displayName: "OpenCode CLI",
    terminalName: "OpenCode",
    installHint: "Install via: npm install -g opencode-ai",
    shouldStreamHeadlessOutput: true,

    // OpenCode uses a TypeScript plugin system for interactive completion detection
    usesInteractiveNotificationMonitor: true,
  };

  /** The fully-qualified model ID used for the most-recently started execution (e.g. "anthropic/claude-sonnet-4-6"). */
  private resolvedCurrentModel: string = "anthropic/claude-sonnet-4-6";

  readonly responseParser: IResponseParser = new OpenCodeResponseParser(() =>
    getOpenCodeContextWindowSize(this.resolvedCurrentModel)
  );
  readonly notificationMonitor: INotificationMonitor =
    new OpenCodeNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new OpenCodeToolPermissionMapper();
  readonly logParser = new OpenCodeLogParser(() =>
    getOpenCodeContextWindowSize(this.resolvedCurrentModel)
  );

  /** Path of the plugin file written for the current interactive execution (for cleanup) */
  private pluginFilePath: string | undefined;

  /**
   * Build complete CLI arguments array for OpenCode CLI execution
   *
   * Handles all OpenCode-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Format flag (headless: run --format json)
   * - Model selection (provider/model format, e.g. anthropic/claude-sonnet-4-6)
   * - Session management (-s resume with explicit session ID only)
   * - Interactive plugin file deployment (when isInteractive === true)
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param extensionPath Extension path for accessing scripts/paths
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for MCP configuration
   * @returns Complete CLI arguments array (without prompt — that's handled separately)
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

    // MCP configuration (when dynamic queue extension is enabled)
    const mcpArgs = await CliProviderUtils.buildMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv) =>
        this.getMcpConfigArgs(serverPath, wsRoot, workingFile, additionalEnv)
    );
    if (mcpArgs.length > 0) {
      args.push(...mcpArgs);
      Log.debug("🔧 FlightPath MCP config written for OpenCode");
    }

    // Headless mode: add "run" subcommand and "--format json"
    // These must come BEFORE -m and -s
    if (!isInteractive) {
      args.push("run");
      args.push("--format", "json");
    }

    // Model selection — use resolved property if available
    const model = this.getModel(resolvedModel);
    if (model) {
      this.resolvedCurrentModel = model;
      args.push("-m", model);
    }

    // Session management — resume with explicit session ID only
    // NOTE: We do NOT use -c (continue last session) because:
    // 1. It's global across all projects, not workspace-specific
    // 2. Could accidentally resume a session from a different project
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );

    if (shouldResume) {
      args.push("-s", sessionId!);
      Log.debug(`✅ Added resume flag: -s ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(`🆕 Starting new session`);
    }

    // Interactive mode: deploy the completion detection plugin
    if (isInteractive && workspaceRoot) {
      await this.deployCompletionPlugin(workspaceRoot, extensionPath);
    }

    // Extra CLI flags from additionalArgs (appended before prompt positional arg)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    return args;
  }

  /**
   * Build CLI arguments for headless mode.
   *
   * opencode run "prompt" --format json -m model [-s sessionId]
   *
   * The prompt is passed as a positional argument at the end.
   *
   * @param baseArgs Base arguments array (already includes "run", "--format", "json", "-m", model)
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array with prompt appended
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote spaces/special chars
    return [...baseArgs, `"${prompt}"`];
  }

  /**
   * Build CLI command for interactive TUI mode.
   *
   * opencode --prompt "prompt text" -m model [-s sessionId]
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string {
    return `${this.config.name} --prompt "${promptText.replace(/"/g, '\\"')}" ${baseArgs.join(" ")}`;
  }

  /**
   * Generate MCP server configuration for OpenCode CLI.
   *
   * OpenCode reads MCP config from .opencode/opencode.json in the project root.
   * There is no --mcp-config CLI flag. The file is auto-detected at startup.
   *
   * Written to {workspaceRoot}/.opencode/opencode.json (merged with existing config).
   * Config format (opencode uses "mcp" key with "type": "local"):
   * {
   *   "$schema": "https://opencode.ai/config.json",
   *   "mcp": {
   *     "flightpath": {
   *       "type": "local",
   *       "command": ["node", "/path/to/mcp-server.js"],
   *       "environment": {
   *         "FLIGHTPATH_WORKSPACE": "/workspace",
   *         "FLIGHTPATH_WORKING_FILE": "/path/to/working.json"
   *       }
   *     }
   *   }
   * }
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow
   * @returns Empty array (config file is auto-detected by filename, no CLI args needed)
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>
  ): Promise<string[] | null> {
    try {
      const normalizedServerPath = mcpServerPath.replace(/\\/g, "/");
      const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, "/");

      const env: Record<string, string> = {
        FLIGHTPATH_WORKSPACE: normalizedWorkspaceRoot,
      };
      if (workingFilePath) {
        env["FLIGHTPATH_WORKING_FILE"] = workingFilePath.replace(/\\/g, "/");
      }
      if (additionalEnv) {
        Object.assign(env, additionalEnv);
      }

      const configPath = this.getMcpConfigFilePath(
        workingFilePath,
        workspaceRoot
      )!;
      await fs.promises.mkdir(path.dirname(configPath), { recursive: true });

      // Merge with existing opencode.json to preserve user settings (theme, models, etc.)
      let existingConfig: Record<string, unknown> = {};
      try {
        const existing = await fs.promises.readFile(configPath, "utf-8");
        existingConfig = JSON.parse(existing);
      } catch {
        // No existing config — start fresh
      }

      const config = {
        ...existingConfig,
        $schema: "https://opencode.ai/config.json",
        mcp: {
          ...(existingConfig.mcp as Record<string, unknown> | undefined),
          flightpath: {
            type: "local",
            command: ["node", normalizedServerPath],
            environment: env,
          },
        },
      };

      await fs.promises.writeFile(
        configPath,
        JSON.stringify(config, null, 2),
        "utf-8"
      );

      Log.debug(`🔧 OpenCode MCP config written to: ${configPath}`);

      // Return empty array — opencode auto-discovers the file, no CLI arg needed
      return [];
    } catch (error) {
      Log.warn(`Failed to write OpenCode MCP config: ${error}`);
      return null;
    }
  }

  /**
   * Return the path of the MCP config file written by getMcpConfigArgs.
   * CliIntegration uses this to delete the file after the workflow finishes.
   */
  getMcpConfigFilePath(
    _workingFilePath: string | undefined,
    workspaceRoot: string
  ): string | null {
    // OpenCode auto-discovers only the fixed filename opencode.json.
    // The suffix-based naming used by other providers does not apply here.
    return path.join(workspaceRoot, ".opencode", "opencode.json");
  }

  /**
   * Return additional file paths to delete after workflow cleanup.
   * Used by CliIntegration.cleanupWorkflowArtifacts() to delete the plugin file.
   */
  getAdditionalCleanupFilePaths(workspaceRoot: string): string[] {
    if (this.pluginFilePath) {
      return [this.pluginFilePath];
    }
    // Also include the default plugin path in case it was written by a previous run
    return [
      path.join(
        workspaceRoot,
        ".opencode",
        "plugin",
        "flightpath-completion-hook.js"
      ),
    ];
  }

  /**
   * Check if OpenCode CLI is available on the system
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("opencode --version", { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get OpenCode CLI version string
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("opencode --version", {
        timeout: 5000,
      });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Get the model to use, validating format and applying fallback.
   * OpenCode models use provider/model format (e.g., anthropic/claude-sonnet-4-6).
   */
  private getModel(resolvedModel?: string): string | undefined {
    if (resolvedModel === MODEL_NONE) {
      return undefined;
    }

    // If we have a resolved model in the correct format, use it
    if (resolvedModel?.includes("/")) {
      return resolvedModel;
    }

    // If resolved model is set but wrong format, warn and fall back to configured default
    if (resolvedModel) {
      Log.warn(
        `OpenCode: model "${resolvedModel}" does not use provider/model format. ` +
          `Expected format: provider/model (e.g., anthropic/claude-sonnet-4-6). Using configured default.`
      );
    }

    // Fall back to user-configured default
    const configuredDefault = ConfigurationUtils.getOpenCodeCliModel();
    if (configuredDefault?.includes("/")) {
      return configuredDefault;
    }

    return "anthropic/claude-sonnet-4-6";
  }

  /**
   * Deploy the FlightPath completion plugin to .opencode/plugin/ before launching the TUI.
   *
   * The plugin listens for session.created and session.status idle events,
   * writing notification files for CliIntegration's file-polling completion detection.
   *
   * @param workspaceRoot Workspace root directory
   * @param extensionPath Extension installation path (used to locate the plugin template)
   */
  private async deployCompletionPlugin(
    workspaceRoot: string,
    extensionPath: string
  ): Promise<void> {
    try {
      const pluginDir = path.join(workspaceRoot, ".opencode", "plugin");
      const pluginPath = path.join(pluginDir, "flightpath-completion-hook.js");
      const sourcePath = path.join(
        extensionPath,
        "out",
        "scripts",
        "flightpath-opencode-plugin.js"
      );

      await fs.promises.mkdir(pluginDir, { recursive: true });
      await fs.promises.copyFile(sourcePath, pluginPath);

      this.pluginFilePath = pluginPath;
      Log.debug(`🔌 OpenCode completion plugin deployed to: ${pluginPath}`);
    } catch (error) {
      // Non-fatal: interactive mode will still work, just won't auto-detect completion
      Log.warn(`Failed to deploy OpenCode completion plugin: ${error}`);
    }
  }
}
