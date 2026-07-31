import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "url";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import type { ToolPermissionConfig } from "../shared/interfaces/IToolPermissionMapper";
import { OpenCodeNotificationMonitor } from "./OpenCodeNotificationMonitor";
import { OpenCodeToolPermissionMapper } from "./OpenCodeToolPermissionMapper";
import { OpenCodeLogParser } from "./OpenCodeLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { configService } from "../../../config/CtrlYokeConfigService";
import { getOpenCodeContextWindowSize } from "../../../utils/ModelRegistry";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { CliParseUtils } from "../shared/CliParseUtils";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import {
  buildOpenCodeMcpEntries,
  OPENCODE_INLINE_CONFIG_MAX_BYTES,
  resolveOpenCodePermissionCollisionContext,
  type OpenCodeInlineConfig,
  type OpenCodeInlineConfigBuildOptions,
  type OpenCodePermissionCollisionContext,
} from "./OpenCodeInlineConfig";

/**
 * OpenCode CLI Harness
 *
 * Implements all OpenCode-specific logic using the composition pattern:
 * - Plugin-based completion detection (session.status idle events)
 * - JSONL response parsing (--format json)
 * - Inline-config-driven tool permissions (OPENCODE_CONFIG_CONTENT)
 * - Multi-provider model support (provider/model format)
 *
 * This provider aggregates three specialized components:
 * - OpenCodeNotificationMonitor: Manages plugin-based completion detection
 * - OpenCodeToolPermissionMapper: Returns [] (permissions are config-file driven)
 * - OpenCodeLogParser: Maps OpenCode events for both headless and interactive modes
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

  readonly notificationMonitor = new OpenCodeNotificationMonitor();
  readonly toolPermissionMapper = new OpenCodeToolPermissionMapper();
  /** OpenCode may echo malformed inline config, which can contain MCP secrets. */
  readonly suppressHeadlessStderr = true;
  readonly headlessSource = "stdout" as const;
  readonly logParser = new OpenCodeLogParser(() =>
    getOpenCodeContextWindowSize(this.resolvedCurrentModel)
  );

  /** Inline config accumulated while preparing the current prompt. */
  private pendingInlineConfig: OpenCodeInlineConfig = { plugin: [] };
  private pendingPermissionCollisionContext: OpenCodePermissionCollisionContext =
    { topLevelKeys: new Set(), nestedKeysByTool: new Map() };

  /**
   * Build the ctrlyoke-owned OpenCode config without performing any I/O.
   *
   * This builder is also used by prompt preparation to keep the inline shape
   * in one place.
   */
  buildInlineConfig(
    options: OpenCodeInlineConfigBuildOptions
  ): OpenCodeInlineConfig {
    const permission = options.toolPermissions
      ? this.toolPermissionMapper.buildPermissionPolicy(
          options.toolPermissions,
          options.permissionCollisionContext
        )
      : undefined;
    const mcpEntries = buildOpenCodeMcpEntries(
      options.mcpServerPath,
      options.workspaceRoot,
      options.workingFilePath,
      options.additionalEnv,
      options.userServers
    );
    const pluginPath = path.join(
      options.extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );

    return {
      ...(permission ? { permission } : {}),
      ...(Object.keys(mcpEntries).length > 0 ? { mcp: mcpEntries } : {}),
      plugin: [pathToFileURL(pluginPath).href],
    };
  }

  /** Convert OpenCode's JSONL stdout into the event vocabulary of OpenCodeLogParser. */
  parseHeadlessStdout(stdout: string): BaseCliEvent[] {
    return CliParseUtils.parseJsonLines(stdout) as BaseCliEvent[];
  }

  /** Extract the session ID carried by any OpenCode stdout event. */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const event = CliParseUtils.parseJsonLines(chunk).find(
      (candidate) => typeof candidate.sessionID === "string"
    );
    return event?.sessionID as string | undefined;
  }

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
    // The integration is reused across prompts in one workflow. Reset before
    // optional MCP or permission preparation so a later prompt cannot inherit
    // either slice when its workspace or policy is absent.
    this.pendingInlineConfig = { plugin: [] };
    this.pendingPermissionCollisionContext =
      await resolveOpenCodePermissionCollisionContext(workspaceRoot);
    this.pendingInlineConfig.plugin = this.buildInlineConfig({
      extensionPath,
    }).plugin;

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
      Log.debug("🔧 ctrlyoke MCP config prepared for OpenCode inline delivery");
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
   * OpenCode has no --mcp-config CLI flag. MCP entries are delivered through
   * OPENCODE_CONFIG_CONTENT at process startup.
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
   * @returns Empty array (inline config is delivered through the spawn env)
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
      delete this.pendingInlineConfig.mcp;
      return null;
    }
    const mcpEntries = buildOpenCodeMcpEntries(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers
    );
    this.pendingInlineConfig.mcp = mcpEntries;
    return [];
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

  /**
   * Accumulate OpenCode's permission policy before process launch.
   * `none` and `dangerouslyAllowAll` intentionally emit no permission slice.
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    _workspaceRoot: string,
    _workingFilePath?: string
  ): Promise<void> {
    const policy = toolPermissions
      ? this.toolPermissionMapper.buildPermissionPolicy(
          toolPermissions,
          this.pendingPermissionCollisionContext
        )
      : undefined;

    if (policy) {
      this.pendingInlineConfig.permission = policy;
    } else {
      delete this.pendingInlineConfig.permission;
    }
  }

  async cleanupWorkspaceArtifacts(
    workspaceRoot: string,
    _workingFilePath?: string
  ): Promise<void> {
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

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    return {
      OPENCODE_CONFIG_CONTENT: this.getInlineConfigContent(),
    };
  }

  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...CliProviderUtils.buildProcessEnv(),
      OPENCODE_CONFIG_CONTENT: this.getInlineConfigContent(),
    };
  }

  private getInlineConfigContent(): string {
    const content = JSON.stringify(this.pendingInlineConfig);
    const size = Buffer.byteLength(content, "utf8");
    if (size > OPENCODE_INLINE_CONFIG_MAX_BYTES) {
      Log.warn(
        `OpenCode inline config is ${size} bytes; refusing to launch above the ${OPENCODE_INLINE_CONFIG_MAX_BYTES}-byte defensive limit`
      );
      throw new Error(
        `OpenCode inline config exceeds the ${OPENCODE_INLINE_CONFIG_MAX_BYTES}-byte defensive limit`
      );
    }
    return content;
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
