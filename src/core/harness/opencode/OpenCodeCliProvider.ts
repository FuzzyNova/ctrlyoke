import * as path from "path";
import * as fs from "fs";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { OpenCodeResponseParser } from "./OpenCodeResponseParser";
import { OpenCodeNotificationMonitor } from "./OpenCodeNotificationMonitor";
import { OpenCodeToolPermissionMapper } from "./OpenCodeToolPermissionMapper";
import { OpenCodeLogParser } from "./OpenCodeLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { configService } from "../../../config/CtrlYokeConfigService";
import { getOpenCodeContextWindowSize } from "../../../utils/ModelRegistry";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

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
 *   (plugin file written to .opencode/plugin/ctrlyoke-completion-hook.js beforehand)
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
    harnessId: HARNESS_IDS.OPENCODE_CLI,
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
  readonly notificationMonitor = new OpenCodeNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new OpenCodeToolPermissionMapper();
  readonly logParser = new OpenCodeLogParser(() =>
    getOpenCodeContextWindowSize(this.resolvedCurrentModel)
  );

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
      Log.debug("🔧 ctrlyoke MCP config written for OpenCode");
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

    // Deploy the completion plugin for interactive mode (always) and for
    // headless mode when user hooks are configured. In headless mode the plugin
    // fires user hook commands via native OpenCode events; CTRLYOKE_NOTIFY_DIR
    // is only set in interactive mode so notification file writing is skipped.
    const userHooks = workflowContext?.resolvedProperties?.hooks ?? undefined;
    const hasUserHooks = (userHooks?.length ?? 0) > 0;
    const enabledHookNotificationEvents = Object.values(
      configService.getAll().notifications.events.hookEvents
    ).some(Boolean);
    if (
      workspaceRoot &&
      (isInteractive || hasUserHooks || enabledHookNotificationEvents)
    ) {
      await this.deployCompletionPlugin(
        workspaceRoot,
        extensionPath,
        userHooks
      );
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
    return [...baseArgs, prompt];
  }

  /**
   * Build CLI arguments for interactive TUI mode.
   *
   * opencode --prompt "prompt text" -m model [-s sessionId]
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return ["--prompt", promptText, ...baseArgs];
  }

  /**
   * Format a file path for OpenCode file references.
   *
   * OpenCode's TUI treats a leading `@` as an agent-mention trigger: in inject
   * mode we write text straight into the running TUI, so an `@path` prefix gets
   * intercepted and rewritten to an agent invocation (e.g. `@explore`) before it
   * ever reaches the model. OpenCode does not auto-read `@`-prefixed paths anyway
   * — it decides to read referenced files on its own from the plain path — so we
   * drop the `@` entirely, mirroring Codex. This applies uniformly to simple,
   * injected, and categorized prompts because every ref routes through here.
   *
   * @param relativeFilePath Relative or absolute file path
   * @returns File path without an `@` prefix
   */
  formatFileReference(relativeFilePath: string): string {
    return relativeFilePath;
  }

  /**
   * Generate MCP server configuration for OpenCode CLI.
   *
   * OpenCode reads MCP config from .opencode/opencode.json in the project root.
   * There is no --mcp-config CLI flag. The file is auto-detected at startup.
   *
   * Written to {workspaceRoot}/.opencode/opencode.json (merged with existing config).
   * Supports ctrlyoke server, user-defined MCP servers, or both.
   * Config format (opencode uses "mcp" key with "type": "local"):
   * {
   *   "$schema": "https://opencode.ai/config.json",
   *   "mcp": {
   *     "ctrlyoke": {
   *       "type": "local",
   *       "command": ["node", "/path/to/mcp-server.js"],
   *       "environment": { ... }
   *     },
   *     "my-server": {
   *       "type": "local",
   *       "command": ["node", "/path/to/server.js"],
   *       "environment": { ... }
   *     }
   *   }
   * }
   *
   * @param mcpServerPath Absolute path to MCP server executable (undefined when ctrlyoke server not requested)
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow
   * @param additionalEnv Extra environment variables for the ctrlyoke MCP server
   * @param userServers User-defined MCP server configurations
   * @returns Empty array (config file is auto-detected by filename, no CLI args needed)
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<string[] | null> {
    const hasUserServers = userServers && userServers.length > 0;
    if (!mcpServerPath && !hasUserServers) {
      return null;
    }
    try {
      const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, "/");

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

      // Build the MCP servers object, merging ctrlyoke + user-defined servers
      const mcpEntries: Record<string, unknown> = {
        ...(existingConfig.mcp as Record<string, unknown> | undefined),
      };

      // ctrlyoke server (when included in mcpServers list)
      if (mcpServerPath) {
        const normalizedServerPath = mcpServerPath.replace(/\\/g, "/");
        const env: Record<string, string> = {
          CTRLYOKE_WORKSPACE: normalizedWorkspaceRoot,
        };
        if (workingFilePath) {
          env["CTRLYOKE_WORKING_FILE"] = workingFilePath.replace(/\\/g, "/");
        }
        if (additionalEnv) {
          Object.assign(env, additionalEnv);
        }
        mcpEntries["ctrlyoke"] = {
          type: "local",
          command: ["node", normalizedServerPath],
          environment: env,
        };
      }

      // User-defined MCP servers
      if (hasUserServers) {
        for (const server of userServers) {
          const entry: Record<string, unknown> = server.url
            ? { type: "remote", url: server.url }
            : {
                type: "local",
                command: [server.command ?? "", ...(server.args ?? [])],
              };
          if (!server.url && server.env) {
            entry["environment"] = server.env;
          }
          if (server.url && server.headers) {
            entry["headers"] = server.headers;
          }
          mcpEntries[server.id] = entry;
        }
      }

      const config = {
        ...existingConfig,
        $schema: "https://opencode.ai/config.json",
        mcp: mcpEntries,
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
    return this.notificationMonitor.getManagedPluginArtifactPaths(
      workspaceRoot
    );
  }

  async cleanupWorkspaceArtifacts(workspaceRoot: string): Promise<void> {
    const managedArtifacts =
      this.notificationMonitor.getManagedPluginArtifactPaths(workspaceRoot);
    for (const artifactPath of managedArtifacts) {
      await fs.promises.unlink(artifactPath).catch(() => {});
    }

    const gitignorePath =
      this.notificationMonitor.getPluginGitignorePath(workspaceRoot);
    const hasRemainingManagedArtifacts = await Promise.all(
      managedArtifacts.map((artifactPath) =>
        fs.promises
          .access(artifactPath)
          .then(() => true)
          .catch(() => false)
      )
    ).then((results) => results.some(Boolean));
    if (!hasRemainingManagedArtifacts) {
      await this.deleteCtrlYokeGitignore(gitignorePath);
    }
  }

  /**
   * Check if OpenCode CLI is available on the system
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability("opencode --version");
  }

  /**
   * Get OpenCode CLI version string
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion("opencode --version", {
      timeoutMs: 5000,
    });
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
   * Deploy the ctrlyoke completion plugin to .opencode/plugin/ before launching the TUI.
   *
   * Always copies the static ctrlyoke-opencode-plugin.ts file (fully type-checked,
   * no code generation). When user hooks are configured, a JSON sidecar file is written
   * alongside the plugin — the plugin reads this at startup to discover what commands to run.
   *
   * Sidecar format: {workspaceRoot}/.opencode/plugin/ctrlyoke-hooks.json
   *   [{"event":"stop","command":"node ./my-script.js"}, ...]
   *
   * @param workspaceRoot Workspace root directory
   * @param extensionPath Extension installation path (used to locate the plugin template)
   * @param userHooks Optional user-defined hooks to embed via sidecar file
   */
  private async deployCompletionPlugin(
    workspaceRoot: string,
    extensionPath: string,
    userHooks?: UserHookConfig[]
  ): Promise<void> {
    try {
      const pluginDir =
        this.notificationMonitor.getPluginDirectory(workspaceRoot);
      // OpenCode only loads .ts plugins — .js files are silently ignored.
      const pluginPath =
        this.notificationMonitor.getPluginFilePath(workspaceRoot);
      const sourcePath = path.join(
        extensionPath,
        "out",
        "scripts",
        "ctrlyoke-opencode-plugin.ts"
      );
      const sidecarPath =
        this.notificationMonitor.getPluginHooksFilePath(workspaceRoot);

      await fs.promises.mkdir(pluginDir, { recursive: true });
      await this.writePluginDirGitignore(workspaceRoot);

      // Always copy the static plugin (type-checked, no code generation).
      await fs.promises.copyFile(sourcePath, pluginPath);

      // Write or remove the sidecar hooks file.
      if (userHooks && userHooks.length > 0) {
        const sidecar = userHooks.map((h) => ({
          event: h.event,
          command: h.command,
        }));
        await fs.promises.writeFile(
          sidecarPath,
          JSON.stringify(sidecar, null, 2),
          "utf-8"
        );
      } else {
        // Remove any stale sidecar from a prior run that had user hooks.
        await fs.promises.unlink(sidecarPath).catch(() => {});
      }

      Log.debug(`🔌 OpenCode completion plugin deployed to: ${pluginPath}`);
    } catch (error) {
      // Non-fatal: interactive mode will still work, just won't auto-detect completion
      Log.warn(`Failed to deploy OpenCode completion plugin: ${error}`);
    }
  }

  private async writePluginDirGitignore(workspaceRoot: string): Promise<void> {
    const gitignorePath =
      this.notificationMonitor.getPluginGitignorePath(workspaceRoot);
    try {
      await fs.promises.access(gitignorePath);
      return;
    } catch {
      // File doesn't exist — write it
    }

    const content = [
      "# ctrlyoke temp files (auto-managed, do not commit)",
      "ctrlyoke-completion-hook.ts",
      "ctrlyoke-hooks.json",
      ".gitignore",
      "",
    ].join("\n");
    await fs.promises
      .writeFile(gitignorePath, content, "utf-8")
      .catch(() => {});
  }

  private async deleteCtrlYokeGitignore(gitignorePath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(gitignorePath, "utf-8");
      if (content.startsWith("# ctrlyoke temp files")) {
        await fs.promises.unlink(gitignorePath).catch(() => {});
      }
    } catch {
      // File doesn't exist or unreadable — nothing to do
    }
  }
}
