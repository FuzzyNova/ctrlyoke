import * as path from "path";
import * as fs from "fs";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import type {
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { OpenCodeNotificationMonitor } from "./OpenCodeNotificationMonitor";
import { OpenCodeToolPermissionMapper } from "./OpenCodeToolPermissionMapper";
import { OpenCodeLogParser } from "./OpenCodeLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
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
  HookEvent,
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
 *   (plugin loaded from the extension installation through inline config)
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
  /** Placeholder substituted for secret-bearing text removed from stderr. */
  private static readonly REDACTED = "[ctrlyoke redacted]";
  readonly headlessSource = "stdout" as const;
  readonly logParser = new OpenCodeLogParser(() =>
    getOpenCodeContextWindowSize(this.resolvedCurrentModel)
  );

  /** Inline config accumulated while preparing the current prompt. */
  private pendingInlineConfig: OpenCodeInlineConfig = { plugin: [] };
  /** User hooks serialized for the plugin's process-local environment. */
  private pendingUserHooksEnv: string | undefined;
  /** Artifacts created only by the documented fallback path. */
  private fallbackPluginArtifactPaths: string[] = [];
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
    const pluginPath = path.resolve(
      options.extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );

    return {
      ...(permission ? { permission } : {}),
      ...(Object.keys(mcpEntries).length > 0 ? { mcp: mcpEntries } : {}),
      // OpenCode converts absolute paths to file:// URLs itself. Keeping the
      // path here also avoids having to escape Windows drive letters/spaces.
      plugin: [pluginPath],
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
    this.pendingUserHooksEnv = undefined;
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

    const userHooks = workflowContext?.resolvedProperties?.hooks ?? undefined;
    this.pendingUserHooksEnv = this.serializeUserHooks(userHooks);
    if (workspaceRoot) {
      await this.ensureExternalPluginIsLoadable(
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
   * Accumulate OpenCode's permission policy before process launch.
   * `none` and `dangerouslyAllowAll` intentionally emit no permission slice.
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (toolPermissions === null || toolPermissions === undefined) {
      delete this.pendingInlineConfig.permission;
      return { cliArgs: [], diagnostics: [] };
    }
    const policy = toolPermissions
      ? this.toolPermissionMapper.buildPermissionPolicy(
          toolPermissions,
          context.permissionCollisionContext ??
            this.pendingPermissionCollisionContext
        )
      : undefined;

    if (policy) {
      this.pendingInlineConfig.permission = policy;
    } else {
      delete this.pendingInlineConfig.permission;
    }
    return this.toolPermissionMapper.prepare(toolPermissions, context);
  }

  async cleanupWorkspaceArtifacts(
    _workspaceRoot: string,
    _workingFilePath?: string
  ): Promise<void> {
    for (const artifactPath of this.fallbackPluginArtifactPaths) {
      await fs.promises.unlink(artifactPath).catch(() => {});
    }
    this.fallbackPluginArtifactPaths = [];
  }

  async buildNotificationHookArgs(
    _extensionPath: string,
    _workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    _enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    this.pendingUserHooksEnv = this.serializeUserHooks(userHooks);
    return [];
  }

  async buildHeadlessUserHookArgs(
    _extensionPath: string,
    _workspaceRoot: string,
    _promptIndex: number,
    _workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    _enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    this.pendingUserHooksEnv = this.serializeUserHooks(userHooks);
    return [];
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    return {
      OPENCODE_CONFIG_CONTENT: this.getInlineConfigContent(),
      ...(this.pendingUserHooksEnv
        ? { CTRLYOKE_OPENCODE_HOOKS: this.pendingUserHooksEnv }
        : {}),
    };
  }

  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...CliProviderUtils.buildProcessEnv(),
      OPENCODE_CONFIG_CONTENT: this.getInlineConfigContent(),
      ...(this.pendingUserHooksEnv
        ? { CTRLYOKE_OPENCODE_HOOKS: this.pendingUserHooksEnv }
        : {}),
    };
  }

  /**
   * Remove secret-bearing text from headless stderr while keeping the rest of
   * the diagnostic intact.
   *
   * A malformed `OPENCODE_CONFIG_CONTENT` makes OpenCode abort and echo the
   * offending content, which carries MCP `environment` credentials. ctrlyoke
   * always emits `JSON.stringify` output so it should never trigger that path,
   * but the echo must not reach logs or output history if it ever does.
   * Dropping stderr wholesale is the wrong trade — it would erase the message
   * for every ordinary OpenCode failure too — so redact only what is sensitive:
   * the serialized config itself and each MCP environment value.
   */
  redactHeadlessStderr(stderr: string): string {
    if (!stderr) {
      return stderr;
    }
    let redacted = stderr;
    for (const secret of this.collectInlineConfigSecrets()) {
      if (secret && redacted.includes(secret)) {
        redacted = redacted.split(secret).join(OpenCodeCliProvider.REDACTED);
      }
    }
    return redacted;
  }

  /**
   * Secret-bearing strings from the current inline config, longest first so a
   * value nested inside the serialized config is not left behind by a
   * shorter replacement that already consumed part of it.
   */
  private collectInlineConfigSecrets(): string[] {
    const secrets: string[] = [JSON.stringify(this.pendingInlineConfig)];
    for (const entry of Object.values(this.pendingInlineConfig.mcp ?? {})) {
      // Discriminated union: local servers carry credentials in `environment`,
      // remote servers in `headers`.
      const credentialValues =
        entry.type === "local" ? entry.environment : entry.headers;
      for (const value of Object.values(credentialValues ?? {})) {
        if (value.length > 0) {
          secrets.push(value);
        }
      }
    }
    return secrets.sort((left, right) => right.length - left.length);
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

  private serializeUserHooks(userHooks?: UserHookConfig[]): string | undefined {
    if (!userHooks || userHooks.length === 0) {
      return undefined;
    }
    return JSON.stringify(
      userHooks.map((hook) => ({ event: hook.event, command: hook.command }))
    );
  }

  /**
   * Verify the external plugin before launch. Path-spec plugins are verified in
   * OpenCode 1.18.10 but undocumented, so retain a small, warning-backed
   * workspace deployment fallback if the installed plugin cannot be loaded.
   */
  private async ensureExternalPluginIsLoadable(
    workspaceRoot: string,
    extensionPath: string,
    userHooks?: UserHookConfig[]
  ): Promise<void> {
    const sourcePath = path.resolve(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );
    try {
      await fs.promises.access(sourcePath, fs.constants.R_OK);
    } catch {
      // A missing extension artifact is an installation/build problem, not an
      // OpenCode path-spec regression; leave the workspace untouched here.
      return;
    }
    try {
      await this.pluginPathIsReadable(sourcePath);
    } catch (error) {
      Log.warn(
        `OpenCode external plugin could not be loaded from ${sourcePath}; ` +
          `falling back to .opencode/plugin/: ${error}`
      );
      try {
        await this.deployCompletionPluginFallback(
          workspaceRoot,
          sourcePath,
          userHooks
        );
      } catch (fallbackError) {
        Log.warn(`OpenCode plugin fallback was unavailable: ${fallbackError}`);
      }
    }
  }

  private async pluginPathIsReadable(sourcePath: string): Promise<void> {
    await fs.promises.access(sourcePath, fs.constants.R_OK);
  }

  /** Minimal compatibility fallback for a future OpenCode regression. */
  private async deployCompletionPluginFallback(
    workspaceRoot: string,
    sourcePath: string,
    userHooks?: UserHookConfig[]
  ): Promise<void> {
    // A missing extension artifact cannot be recovered by copying it into the
    // workspace. This keeps installation failures file-free and distinct from
    // a genuine regression in OpenCode's external path loading.
    await fs.promises.access(sourcePath, fs.constants.R_OK);
    const pluginDir = path.join(workspaceRoot, ".opencode", "plugin");
    const pluginPath = path.join(pluginDir, "ctrlyoke-completion-hook.ts");
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.copyFile(sourcePath, pluginPath);
    this.fallbackPluginArtifactPaths.push(pluginPath);

    if (userHooks && userHooks.length > 0) {
      const sidecarPath = path.join(pluginDir, "ctrlyoke-hooks.json");
      await fs.promises.writeFile(
        sidecarPath,
        this.serializeUserHooks(userHooks)!,
        "utf8"
      );
      this.fallbackPluginArtifactPaths.push(sidecarPath);
    }

    // An auto-scanned fallback plugin must not remain in the inline list.
    this.pendingInlineConfig.plugin = [];
    Log.warn(
      "OpenCode plugin fallback deployed under .opencode/plugin/; " +
        "this compatibility path writes workspace files"
    );
  }
}
