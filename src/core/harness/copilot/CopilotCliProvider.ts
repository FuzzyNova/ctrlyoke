import * as path from "path";
import * as fs from "fs/promises";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import type { UniversalCliOutput } from "../../../types/CliOutputTypes";
import { CopilotResponseParser } from "./CopilotResponseParser";
import { CopilotNotificationMonitor } from "./CopilotNotificationMonitor";
import { CopilotToolPermissionMapper } from "./CopilotToolPermissionMapper";
import { CopilotLogParser } from "./CopilotLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import {
  initializeModelRegistry,
  isCliModelSupported,
  isRegistryInitialized,
} from "../../../utils/ModelRegistry";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import type {
  HookEvent,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

/**
 * Copilot CLI Harness
 *
 * Implements all Copilot-specific logic using composition pattern:
 * - Log file monitoring and sessionEnd hook for completion detection
 * - JSONL output parsing in headless mode (--output-format json), plain text fallback
 * - Tool permission conversion with read-only tool filtering
 * - MCP server configuration with "local" type and tools field
 * - Session ID from result.sessionId in JSON output; log file discovery as fallback
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
    harnessId: HARNESS_IDS.COPILOT_CLI,
    displayName: "GitHub Copilot CLI",
    terminalName: "Copilot",
    installHint: "Install via: npm install -g @github/copilot",
    shouldStreamHeadlessOutput: true,

    // Copilot uses sessionEnd hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,

    // Headless mode uses --output-format json, so output is structured events (not raw text).
    // The parser sets rawTextOutput:true in metadata for interactive/plain-text fallback.
    rawTextOutput: false,
  };

  readonly responseParser: IResponseParser = new CopilotResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CopilotNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CopilotToolPermissionMapper();
  readonly logParser = new CopilotLogParser();

  /** Hook files created for both interactive and headless mode (cleaned up after workflow). */
  private hookFilePaths: string[] = [];
  /** Path to temporary .gitignore written in .github/hooks/ to hide ctrlyoke files from git. */
  private hooksDirGitignorePath: string | undefined;
  private enablePromptModeRepoHooksForHeadlessRun = false;
  /**
   * Per-invocation path for Copilot's OpenTelemetry file exporter, generated fresh in
   * buildCliArgs() each prompt. Feeds live context-window tracking (see CopilotLogParser's
   * OTel section) since Copilot CLI 1.0.x removed every other per-turn context signal.
   */
  private otelFilePath: string | undefined;

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
   * - Session management (--resume)
   * - sessionEnd hook (interactive mode only)
   *
   * Note: --output-format json is added by buildHeadlessArgs(), not here.
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
    },
    workspaceRoots?: readonly string[]
  ): Promise<string[]> {
    this.enablePromptModeRepoHooksForHeadlessRun = false;

    // Generate a fresh per-invocation OTel export path (or clear it) every prompt.
    // Must run unconditionally — the parser/provider instances are reused across
    // prompts, so a stale path from a previous invocation must never leak forward.
    this.otelFilePath = workspaceRoot
      ? path.join(
          workspaceRoot,
          PATH_CONSTANTS.CTRLYOKE_DIR,
          PATH_CONSTANTS.TEMP_DIR,
          CopilotCliProvider.buildOtelFileName(
            workflowContext?.promptIndex ?? 0,
            workflowContext?.workingFilePath
          )
        )
      : undefined;
    this.logParser.setOtelFilePath(this.otelFilePath);

    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    // This ensures workflow-level defaults are respected
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
      // Auto-approve ctrlyoke MCP tools only when the ctrlyoke server is included
      const mcpServersResolved =
        workflowContext?.resolvedProperties?.mcpServers ?? [];
      if (mcpServersResolved.includes("ctrlyoke")) {
        args.push("--allow-tool", "ctrlyoke");
        Log.debug("🔧 ctrlyoke MCP tools auto-approved");
      }

      // Auto-approve user-defined MCP server tools based on autoApprove config
      const mcpServers = workflowContext?.resolvedProperties?.mcpServers ?? [];
      for (const server of mcpServers) {
        if (typeof server === "object" && server.autoApprove) {
          if (server.autoApprove === true) {
            // Approve all tools from this server
            args.push("--allow-tool", server.id);
            Log.debug(
              `🔧 Auto-approved all tools from MCP server: ${server.id}`
            );
          } else if (Array.isArray(server.autoApprove)) {
            // Approve specific tool patterns
            for (const pattern of server.autoApprove) {
              args.push("--allow-tool", pattern);
            }
            Log.debug(
              `🔧 Auto-approved ${server.autoApprove.length} tool pattern(s) from MCP server: ${server.id}`
            );
          }
        }
      }
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    // Hook setup (interactive notification hooks + headless user hooks) is dispatched
    // by CliIntegration.runExecutionSession() via buildNotificationHookArgs() /
    // buildHeadlessUserHookArgs() — not here in buildCliArgs().
    // Permission args are similarly dispatched via buildPermissionArgs() — not here.

    // Workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(
        workspaceRoot,
        workspaceRoots
      );
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Model selection with validation - use resolved property if available
    const model = await this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.
    // No --agent CLI flag needed; this works with all providers (Copilot, Claude, Codex).

    // Session resumption
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );
    if (shouldResume) {
      args.push("--resume", sessionId!);
      Log.debug(`✅ Added resume flag: --resume ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(`🆕 Starting new session`);
    }

    Log.debug(`🔧 CLI arguments: ${JSON.stringify(args)}`);

    return args;
  }

  /**
   * Validate model is supported by Copilot CLI, fallback to default if not.
   * Lazily initializes the model registry if needed (e.g. CLI mode where
   * initializeModelRegistry() is never called during extension activation).
   */
  private async validateAndGetModel(requestedModel?: string): Promise<string> {
    const defaultModel = ConfigurationUtils.getCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    if (requestedModel === MODEL_NONE) {
      return "";
    }

    // Lazily initialize the registry if not yet done (CLI mode).
    // queryCopilotCliModels() runs `copilot help config` — no VS Code context needed.
    // queryLmModels() falls back to the static list via the vscode shim.
    if (!isRegistryInitialized()) {
      await initializeModelRegistry();
    }

    // Check if model is supported by CLI (using dynamically discovered models)
    if (isCliModelSupported(requestedModel)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Copilot CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);

    return defaultModel;
  }

  /**
   * Set up ctrlyoke notification hooks (sessionEnd + user hooks) for interactive mode.
   *
   * Creates a uniquely-named hook file per prompt in `.github/hooks/` so that
   * parallel workflows don't interfere with each other. Copilot auto-discovers
   * all JSON files in the hooks directory, so each prompt's file is loaded
   * independently — no merging or ref-counting needed.
   *
   * @returns CLI arguments array (empty — Copilot auto-discovers hooks from .github/hooks/)
   */
  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);
    const hookScriptPath = path.join(
      extensionPath,
      "out/scripts/ctrlyoke-copilot-hook.js"
    );
    const hookConfig = this.notificationMonitor.buildHookConfig(
      hookScriptPath,
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
    const hookFileName = CopilotCliProvider.buildHookFileName(
      promptIndex,
      workingFilePath
    );
    await this.createHookFile(hookConfig, workspaceRoot, hookFileName);
    Log.debug(`🔔 Configured sessionEnd hook for completion detection`);
    // No additional CLI args needed - Copilot auto-discovers hooks in .github/hooks/
    return [];
  }

  /**
   * Create a hook file with only user-defined hooks for headless execution.
   * No ctrlyoke notification hooks are needed since headless uses process-exit for completion.
   *
   * @returns CLI arguments array (empty — Copilot auto-discovers hooks from .github/hooks/)
   */
  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const hasUserHooks = userHooks && userHooks.length > 0;
    this.enablePromptModeRepoHooksForHeadlessRun =
      hasUserHooks || enabledNotificationHookEvents.length > 0;
    if (!hasUserHooks && enabledNotificationHookEvents.length === 0) {
      // Nothing to configure — skip hook file creation.
      // Cleanup of any previous prompt's hook file is handled by cleanupPreviousPromptHooks.
      return [];
    }
    const config =
      enabledNotificationHookEvents.length > 0
        ? this.notificationMonitor.buildHookConfig(
            path.join(
              extensionPath,
              "out",
              "scripts",
              "ctrlyoke-copilot-hook.js"
            ),
            this.notificationMonitor.getNotificationDirectory(workspaceRoot),
            workspaceRoot,
            userHooks,
            enabledNotificationHookEvents
          )
        : {
            type: "json",
            config: CopilotNotificationMonitor.buildUserOnlyConfig(
              userHooks ?? []
            ),
          };
    const hookFileName = CopilotCliProvider.buildHookFileName(
      promptIndex,
      workingFilePath
    );
    await this.createHookFile(config, workspaceRoot, hookFileName);
    Log.debug(`🔔 Configured user hooks for headless mode`);
    return [];
  }

  getHeadlessSpawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = this.enablePromptModeRepoHooksForHeadlessRun
      ? { GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: "true" }
      : {};
    return { ...env, ...this.buildOtelSpawnEnv() };
  }

  /**
   * Redirect Copilot's OpenTelemetry file exporter to this invocation's dedicated path.
   *
   * Overriding this is necessary, not optional: some environments already have
   * COPILOT_OTEL_FILE_EXPORTER_PATH set globally (observed pointed at the Windows null
   * device, `\\.\nul`), which silently discards the only live context-window signal
   * Copilot CLI 1.0.x still exposes. Explicitly setting both vars here ensures ctrlyoke
   * always gets the data regardless of what the user's shell environment does.
   */
  private buildOtelSpawnEnv(): NodeJS.ProcessEnv {
    if (!this.otelFilePath) {
      return {};
    }
    return {
      COPILOT_OTEL_ENABLED: "true",
      COPILOT_OTEL_FILE_EXPORTER_PATH: this.otelFilePath,
    };
  }

  /**
   * Interactive spawn env: base process env plus the OTel export path override.
   * Copilot has no other reason to need env overrides in interactive mode today,
   * unlike Claude's CLAUDECODE removal — this exists solely to carry the OTel vars.
   */
  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...CliProviderUtils.buildProcessEnv(),
      ...this.buildOtelSpawnEnv(),
    };
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
   * Delete hook files written for the previous prompt before building hooks for the next.
   * Prevents .github/hooks/ from accumulating files across prompts — Copilot CLI reads
   * every JSON file in that directory, so leftover files would cause previous-prompt
   * hooks to fire during subsequent prompts.
   */
  async cleanupPreviousPromptHooks(_workspaceRoot: string): Promise<void> {
    for (const hookPath of this.hookFilePaths) {
      await fs.unlink(hookPath).catch(() => {});
    }
    this.hookFilePaths = [];
  }

  /**
   * Return additional file paths to delete after workflow cleanup.
   *
   * Includes all per-prompt hook files created during this workflow's
   * interactive and headless sessions, plus this invocation's Copilot OTel
   * telemetry file (see buildOtelSpawnEnv()).
   *
   * Note: the .gitignore is NOT deleted here. Deletion is deferred to
   * cleanupWorkspaceArtifacts() so we can check whether concurrent workflows
   * still have hook files on disk before removing it.
   */
  getAdditionalCleanupFilePaths(workspaceRoot: string): string[] {
    return [
      ...this.hookFilePaths,
      ...(this.otelFilePath ? [this.otelFilePath] : []),
      // Defensive: some environments have COPILOT_OTEL_FILE_EXPORTER_PATH set globally
      // to the relative path "NUL" (observed pointed at the Windows null device via
      // \\.\nul). buildOtelSpawnEnv() always overrides this for our own spawns, but
      // clean up the stray file anyway in case anything ever bypasses that override —
      // when CWD is the workspace root, "NUL" resolves to a real file, not the device.
      path.join(workspaceRoot, "NUL"),
    ];
  }

  /**
   * Delete the temporary .gitignore if no concurrent workflows still have
   * ctrlyoke hook files on disk. Called after getAdditionalCleanupFilePaths()
   * has already removed this workflow's own hook files.
   *
   * Does not rely on hooksDirGitignorePath being set: even when a concurrent
   * workflow wrote the gitignore (so this instance never set hooksDirGitignorePath),
   * we still clean it up if it's ours and the directory is now empty.
   */
  async cleanupWorkspaceArtifacts(workspaceRoot: string): Promise<void> {
    const hookDir = path.join(workspaceRoot, ".github", "hooks");
    try {
      const files = await fs.readdir(hookDir);
      const hasOtherHookFiles = files.some(
        (f) => f.startsWith("ctrlyoke-") && f.endsWith(".json")
      );
      if (hasOtherHookFiles) {
        return; // Concurrent workflow still active — leave gitignore in place
      }
      // No ctrlyoke hook files remain. Delete the gitignore only if it's ours.
      if (files.includes(".gitignore")) {
        const gitignorePath =
          this.hooksDirGitignorePath ?? path.join(hookDir, ".gitignore");
        await this.deleteCtrlYokeGitignore(gitignorePath);
      }
      this.hooksDirGitignorePath = undefined;
    } catch {
      // Directory doesn't exist — nothing to clean up
      this.hooksDirGitignorePath = undefined;
    }
  }

  /**
   * Delete a .gitignore only if it was written by ctrlyoke (identified by
   * our magic header comment). Leaves user-owned gitignore files untouched.
   */
  private async deleteCtrlYokeGitignore(gitignorePath: string): Promise<void> {
    try {
      const content = await fs.readFile(gitignorePath, "utf-8");
      if (content.startsWith("# ctrlyoke temp files")) {
        await fs.unlink(gitignorePath).catch(() => {});
      }
    } catch {
      // File doesn't exist or unreadable — nothing to do
    }
  }

  /**
   * Create a per-prompt hook file for Copilot in .github/hooks/.
   */
  private async createHookFile(
    hookConfig: any,
    workspaceRoot: string,
    hookFileName: string
  ): Promise<void> {
    try {
      const hookDir = path.join(workspaceRoot, ".github", "hooks");

      // Security: Validate that the resolved hook path stays within the workspace root.
      const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
      const resolvedHookDir = path.resolve(hookDir);
      if (!resolvedHookDir.startsWith(normalizedWorkspaceRoot)) {
        Log.error(
          `Security: Hook directory "${resolvedHookDir}" is outside workspace root "${normalizedWorkspaceRoot}"`
        );
        return;
      }

      await fs.mkdir(hookDir, { recursive: true });
      await this.writeHookDirGitignore(hookDir);

      const hookPath = path.join(hookDir, hookFileName);
      await fs.writeFile(
        hookPath,
        JSON.stringify(hookConfig.config, null, 2),
        "utf-8"
      );

      this.hookFilePaths.push(hookPath);
      Log.debug(`📁 Created hook file: ${hookPath}`);
    } catch (error) {
      Log.warn(`⚠️ Failed to create hook file: ${error}`);
    }
  }

  /**
   * Write a temporary .gitignore to .github/hooks/ to prevent ctrlyoke hook files
   * from appearing as untracked in git. The .gitignore hides itself too so git never
   * sees either file. No-op if a .gitignore already exists there (user-owned file).
   */
  private async writeHookDirGitignore(hookDir: string): Promise<void> {
    if (this.hooksDirGitignorePath) {
      return; // Already written for this workflow
    }
    const gitignorePath = path.join(hookDir, ".gitignore");
    try {
      await fs.access(gitignorePath);
      return; // Existing .gitignore — leave it alone
    } catch {
      // File doesn't exist — write it
    }
    const content = [
      "# ctrlyoke temp files (auto-managed, do not commit)",
      "ctrlyoke-*.json",
      ".gitignore",
      "",
    ].join("\n");
    await fs.writeFile(gitignorePath, content, "utf-8").catch(() => {});
    this.hooksDirGitignorePath = gitignorePath;
  }

  /**
   * Build a unique hook filename for a prompt.
   *
   * Format: `ctrlyoke-<stem>-p<promptIndex>.json`
   * where stem is derived from the working file basename (already contains a
   * timestamp and workflow name), or falls back to a timestamp.
   *
   * Examples:
   * - `ctrlyoke-1774891046-my-workflow-p0.json`
   * - `ctrlyoke-1774891046-my-workflow-p1.json`
   * - `ctrlyoke-1774891200-p0.json` (fallback when no workingFilePath)
   */
  private static buildHookFileName(
    promptIndex: number,
    workingFilePath?: string
  ): string {
    let stem: string;
    if (workingFilePath) {
      // Working file is like "1774891046-my-workflow.ctrlyoke.json"
      // Strip extensions to get "1774891046-my-workflow"
      stem = path.basename(workingFilePath).replace(/\.ctrlyoke\.json$/i, "");
    } else {
      stem = String(Date.now());
    }
    // Sanitize: keep alphanumeric, hyphens, underscores only
    const safeStem = stem.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    return `ctrlyoke-${safeStem}-p${promptIndex}.json`;
  }

  /**
   * Build a unique OTel export filename for a prompt, mirroring buildHookFileName()'s
   * naming convention (same collision profile — accepted there already).
   *
   * Format: `ctrlyoke-otel-<stem>-p<promptIndex>.jsonl`
   */
  private static buildOtelFileName(
    promptIndex: number,
    workingFilePath?: string
  ): string {
    let stem: string;
    if (workingFilePath) {
      stem = path.basename(workingFilePath).replace(/\.ctrlyoke\.json$/i, "");
    } else {
      stem = String(Date.now());
    }
    const safeStem = stem.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    return `ctrlyoke-otel-${safeStem}-p${promptIndex}.jsonl`;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Copilot requires --prompt flag to specify prompts.
   * Format: copilot --output-format json --prompt "..." [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.ctrlyoke/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // --output-format json enables structured JSONL output for reliable response/session parsing.
    return ["--output-format", "json", "--prompt", prompt, ...baseArgs];
  }

  /**
   * Build CLI arguments for interactive TUI mode
   *
   * Copilot interactive mode: copilot -i "prompt text" [args...]
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete arguments array
   */
  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return ["-i", promptText, ...baseArgs];
  }

  /**
   * Generate MCP server configuration arguments for Copilot CLI
   *
   * Copilot CLI uses --additional-mcp-config @<file> format.
   * Config file format: JSON with "type": "local"/"http"/"sse" and "tools" field.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets CTRLYOKE_WORKING_FILE)
   * @returns CLI arguments array with --additional-mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<string[] | null> {
    try {
      // Generate MCP config JSON using shared utility
      // Copilot CLI requires "type": "local" and "tools" field for ctrlyoke server;
      // user servers need "type": "local"/"http"/"sse" and "tools": ["*"]
      const copilotUserServerConfig = {
        stdioType: "local",
        remoteTypeMap: { "streamable-http": "http", sse: "sse" },
        tools: ["*"] as string[],
      };
      let configJson: string;
      if (mcpServerPath && userServers && userServers.length > 0) {
        configJson = CliMcpConfigGenerator.generateJsonConfigWithUserServers(
          mcpServerPath,
          workspaceRoot,
          userServers,
          { type: "local", tools: ["*"] },
          workingFilePath,
          additionalEnv,
          copilotUserServerConfig
        );
      } else if (mcpServerPath) {
        configJson = CliMcpConfigGenerator.generateJsonConfig(
          mcpServerPath,
          workspaceRoot,
          { type: "local", tools: ["*"] },
          workingFilePath,
          additionalEnv
        );
      } else if (userServers && userServers.length > 0) {
        configJson = CliMcpConfigGenerator.generateUserServersOnlyConfig(
          userServers,
          copilotUserServerConfig
        );
      } else {
        return null;
      }

      // Write to temp directory — use unique name per execution to avoid parallel workflow collisions
      const configPath = this.getMcpConfigFilePath(
        workingFilePath,
        workspaceRoot
      )!;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, configJson, "utf-8");

      // Return --additional-mcp-config @file argument
      return ["--additional-mcp-config", `@${configPath}`];
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return null;
    }
  }

  /**
   * Return the path of the MCP config file this provider writes.
   * Used by CliIntegration to delete the file after the workflow finishes.
   */
  getMcpConfigFilePath(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): string {
    return CliMcpConfigGenerator.getConfigFilePath(
      workingFilePath,
      workspaceRoot,
      "mcp-config"
    );
  }

  /**
   * Check if Copilot CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability("copilot --version", {
      retryWindowsFileLockErrors: true,
    });
  }

  /**
   * Get Copilot CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion("copilot --version", {
      retryWindowsFileLockErrors: true,
    });
  }

  /**
   * Extract session ID from session log files by matching prompt text.
   *
   * Fallback method used when the session ID is not available from hook notifications.
   * With the current Copilot hook format, session IDs are provided via sessionStart
   * notifications, making this a true fallback (e.g., hooks not configured or timed out).
   *
   * Uses prompt-text matching (via discoverSessionLog) to find the correct
   * session log among potentially many concurrent sessions, then extracts
   * the session ID from the session.start event.
   *
   * @param promptText The prompt text that was sent (matched against user.message events)
   * @param startTime When execution started (filters to recently modified logs)
   * @returns Session ID (UUID) if found, undefined otherwise
   *
   * @remarks
   * **Why prompt matching instead of most-recent:**
   * Multiple Copilot CLI sessions may run concurrently. Grabbing the most
   * recently modified log would be a race condition. Instead, we match the
   * actual prompt text in the log's user.message event to find the correct session.
   *
   * **Discovery algorithm (delegated to CopilotLogParser.discoverSessionLog):**
   * 1. Find recently modified entries in `~/.copilot/session-state/`
   * 2. Read first 10 events from each candidate
   * 3. Match user.message content against first 100 chars of promptText
   * 4. Return the matching session's log path
   * 5. Extract session ID from session.start event
   */
  /**
   * Augment JSON-mode headless output with context window data from Copilot log files.
   *
   * Copilot's --output-format json stdout contains output tokens per turn but no input tokens.
   * Fallback sources are tried in order:
   *
   * 1. **OpenTelemetry chat spans** (this invocation's `otelFilePath`, see `buildOtelSpawnEnv()`)
   *    By the time headless collection runs, the process has already exited, so the file
   *    is complete — one poll picks up every span written this invocation. Most reliable:
   *    carries exact `gen_ai.usage.input_tokens` per turn, unlike the tiers below.
   *
   * 2. **session.truncation events** (`~/.copilot/session-state/{sessionId}/events.jsonl`)
   *    Pre-1.0 Copilot CLI only. Fired once per model turn with
   *    postTruncationTokensInMessages + tokenLimit.
   *
   * 3. **session.shutdown's currentTokens** (same events.jsonl)
   *    Copilot CLI 1.0.x+ removed session.truncation entirely; currentTokens fires once
   *    at process exit and is the only context signal left. No tokenLimit field, so
   *    getCopilotContextWindowSize(model) supplies the denominator.
   *
   * 4. **CompactionProcessor lines** (`~/.copilot/logs/process-*.log`)
   *    Legacy per-turn utilization line; observed to no longer fire reliably on
   *    current Copilot CLI versions, kept as a last-resort fallback.
   *
   * This is the permanent architecture — session ID is not available until the final
   * `result` event, so real-time log tailing during execution is not feasible.
   */
  async augmentParsedOutput(
    output: UniversalCliOutput
  ): Promise<UniversalCliOutput> {
    // Plain-text mode: token data comes from stderr stats in parseTokenCounts(), not needed here.
    if (output.metadata.rawTextOutput) {
      return output;
    }

    // Already have input token data — Copilot may add this to JSON output in a future version.
    if (output.metadata.usage && output.metadata.usage.inputTokens > 0) {
      return output;
    }

    await this.logParser.pollOtelContextWindow(output.metadata.model ?? "");
    const otelUsage = this.logParser.getFinalOtelUsage();
    if (otelUsage) {
      Log.debug(
        `[CopilotCliProvider] Context window from OTel: ${otelUsage.contextWindowUsedTokens}/${otelUsage.contextWindowSize} tokens`
      );
      const existingOutputTokens = output.metadata.usage?.outputTokens ?? 0;
      return {
        ...output,
        metadata: {
          ...output.metadata,
          usage: {
            ...output.metadata.usage,
            inputTokens: otelUsage.inputTokens,
            outputTokens: existingOutputTokens,
            totalTokens: otelUsage.inputTokens + existingOutputTokens,
            contextWindowUsedTokens: otelUsage.contextWindowUsedTokens,
            contextWindowSize: otelUsage.contextWindowSize,
          },
        },
      };
    }

    const sessionId = output.metadata.sessionId;
    if (!sessionId) {
      Log.debug(
        `[CopilotCliProvider] augmentParsedOutput: no sessionId in parsed metadata`
      );
      return output;
    }

    const truncation = await CopilotLogParser.extractTruncationDataFromLog(
      sessionId,
      output.metadata.model
    );
    const outputTokens = output.metadata.usage?.outputTokens ?? 0;

    if (truncation) {
      const { postTruncationTokensInMessages, tokenLimit } = truncation;
      Log.debug(
        `[CopilotCliProvider] Context window from session log: ${postTruncationTokensInMessages}/${tokenLimit} tokens`
      );
      return {
        ...output,
        metadata: {
          ...output.metadata,
          usage: {
            ...output.metadata.usage,
            inputTokens: postTruncationTokensInMessages,
            outputTokens,
            totalTokens: postTruncationTokensInMessages + outputTokens,
            contextWindowUsedTokens: postTruncationTokensInMessages,
            contextWindowSize: tokenLimit,
          },
        },
      };
    }

    // Fallback: session.truncation only fires when there is enough prior context
    // (short/first prompts may not emit it). The process log always contains
    // CompactionProcessor utilization lines which carry the same data.
    const processCtx =
      await this.logParser.extractContextFromProcessLog(sessionId);
    if (!processCtx) {
      Log.debug(
        `[CopilotCliProvider] No context window data available for session ${sessionId}`
      );
      return output;
    }

    Log.debug(
      `[CopilotCliProvider] Context window from process log: ${processCtx.used}/${processCtx.size} tokens`
    );
    return {
      ...output,
      metadata: {
        ...output.metadata,
        usage: {
          ...output.metadata.usage,
          inputTokens: processCtx.used,
          outputTokens,
          totalTokens: processCtx.used + outputTokens,
          contextWindowUsedTokens: processCtx.used,
          contextWindowSize: processCtx.size,
        },
      },
    };
  }

  async extractSessionIdFromLogs(
    promptText: string,
    startTime: Date
  ): Promise<string | undefined> {
    const logPath = await this.logParser.discoverSessionLog(
      promptText,
      startTime
    );
    if (!logPath) {
      Log.debug(
        "[CopilotCliProvider] Could not discover session log for prompt"
      );
      return undefined;
    }

    // Extract session ID from first event (stateless read, safe after monitoring)
    const sessionId = await this.logParser.extractSessionIdFromLogPath(logPath);
    return sessionId ?? undefined;
  }
}
