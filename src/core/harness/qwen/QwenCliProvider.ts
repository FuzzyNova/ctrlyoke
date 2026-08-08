import * as path from "path";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { QwenNotificationMonitor } from "./QwenNotificationMonitor";
import { QwenToolPermissionMapper } from "./QwenToolPermissionMapper";
import { QwenLogParser } from "./QwenLogParser";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { SettingsJsonHooksTracker } from "../shared/SettingsJsonHooksTracker";
import { QwenTrustedHooksTracker } from "../shared/QwenTrustedHooksTracker";
import { parseArgString } from "../../../utils/CliArgParser";
import { CliParseUtils } from "../shared/CliParseUtils";
import type {
  HookEvent,
  PromptStep,
  WorkflowStep,
  McpServerConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import {
  applyPreparedMutations,
  type CliProviderPreparation,
} from "../shared/interfaces/PreparedMutation";

/**
 * Qwen Code CLI Harness
 *
 * Implements all Qwen Code-specific logic using composition pattern:
 * - Process exit detection (headless) + log file monitoring (interactive) for completion
 * - Stream-json stdout used as a session-ID carrier and activity clock
 * - Mode-based tool permission conversion (plan, default, auto-edit, yolo)
 * - Session discovery via log file analysis
 *
 * This provider aggregates four specialized components:
 * - QwenNotificationMonitor: Monitors process exit and log files
 * - QwenToolPermissionMapper: Converts permissions to CLI arguments
 * - QwenLogParser: Parses log files for sessions and completion
 *
 * Qwen Code CLI features:
 * - Uses stream-json output format (NDJSON - one JSON object per line)
 * - Session ID from system init or result event
 * - Mode-based permissions (--approval-mode, -y for YOLO)
 * - Supports --resume flag for session continuation
 * - Log files in ~/.qwen/projects/<workspace>/chats/<session-id>.jsonl
 *
 * Usage:
 * ```typescript
 * const provider = new QwenCliProvider();
 * const integration = new CliIntegration(provider, platform, registerWithContext);
 * ```
 */
export class QwenCliProvider implements ICliProvider {
  /** Tracker for parallel-safe hooks management in .qwen/settings.json. */
  private readonly hooksTracker: SettingsJsonHooksTracker;

  /** Tracker for Qwen's persistent global hook approvals. */
  private readonly trustedHooksTracker: QwenTrustedHooksTracker;

  constructor(
    hooksTracker = SettingsJsonHooksTracker.getInstance("qwen"),
    trustedHooksTracker = QwenTrustedHooksTracker.getInstance()
  ) {
    this.hooksTracker = hooksTracker;
    this.trustedHooksTracker = trustedHooksTracker;
  }

  readonly config: HarnessConfig = {
    name: "qwen",
    harnessId: HARNESS_IDS.QWEN_CLI,
    displayName: "Qwen Code CLI",
    terminalName: "Qwen Code",
    installHint: "Install via: npm install -g @qwen-code/qwen-code",
    shouldStreamHeadlessOutput: true,

    // Qwen uses log file monitoring for completion detection in interactive mode
    // Process exit is primary for headless mode
    usesInteractiveNotificationMonitor: true,
  };

  /** Qwen's session log is richer than its Claude-shaped headless stdout. */
  readonly headlessSource = "log" as const;
  readonly notificationMonitor: INotificationMonitor =
    new QwenNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new QwenToolPermissionMapper();
  readonly logParser = new QwenLogParser();

  /** Extract Qwen's session ID from any complete JSON object in stdout. */
  extractSessionIdFromStdout(chunk: string): string | undefined {
    const { objects } = CliParseUtils.extractJsonObjectsFromStream(chunk);
    const sessionEvent = objects.find(
      (event) => typeof event.session_id === "string"
    );
    return sessionEvent?.session_id as string | undefined;
  }

  /**
   * Build complete CLI arguments array for Qwen Code CLI execution
   *
   * Handles all Qwen-specific arguments including:
   * - Output format (--output-format stream-json for headless)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (--resume for resumption)
   * - Tool permissions (--approval-mode, -y, --allowed-tools, --exclude-tools)
   * - Extra CLI flags from additionalArgs
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param extensionPath Extension installation directory
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for resolved properties
   * @returns Complete CLI arguments array (without prompt - that's handled separately)
   */
  async buildCliArgs(
    prompt: PromptStep,
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
    },
    workspaceRoots?: readonly string[]
  ): Promise<string[]> {
    const preparation = await this.planCliArgs(
      prompt,
      isInteractive,
      extensionPath,
      workspaceRoot,
      sessionId,
      workflowContext,
      workspaceRoots
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planCliArgs(
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
    _workspaceRoots?: readonly string[]
  ): Promise<CliProviderPreparation> {
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // MCP configuration (when dynamic queue extension or user MCP servers are enabled)
    const mcpPreparation = await CliProviderUtils.planMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.planMcpConfigArgs(
          serverPath,
          wsRoot,
          workingFile,
          additionalEnv,
          userServers
        )
    );
    if (
      mcpPreparation.cliArgs.length > 0 ||
      mcpPreparation.mutations.length > 0
    ) {
      args.push(...mcpPreparation.cliArgs);
      Log.debug("🔧 ctrlyoke MCP config added inline for Qwen");
    }

    // Note: Headless-specific flags (--output-format) are added by
    // buildHeadlessArgs() to ensure correct positioning after the prompt argument.

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.

    // Session management: Resume with explicit session ID
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
    // NOTE: buildHeadlessUserHookArgs returns ["--experimental-hooks"] for Qwen headless.
    // Permission preparation is similarly dispatched by CliIntegration — not here.

    Log.debug(
      `🔧 Qwen CLI arguments: ${JSON.stringify(this.redactMcpConfigArgs(args))}`
    );

    return {
      cliArgs: args,
      mutations: mcpPreparation.mutations,
      diagnostics: mcpPreparation.diagnostics,
    };
  }

  private redactMcpConfigArgs(args: string[]): string[] {
    const redactedArgs = [...args];
    for (let index = 0; index < redactedArgs.length - 1; index++) {
      if (redactedArgs[index] === "--mcp-config") {
        redactedArgs[index + 1] = "[REDACTED]";
        index++;
      }
    }
    return redactedArgs;
  }

  /**
   * Set up ctrlyoke notification hooks (Stop hook + user hooks) for interactive mode.
   * Merges hooks into .qwen/settings.json and pre-trusts them in the global
   * Qwen trust tracker.
   * Hooks are enabled by default in Qwen — no CLI flag needed.
   */
  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planNotificationHookArgs(
      extensionPath,
      workspaceRoot,
      _promptIndex,
      workingFilePath,
      userHooks,
      enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-qwen-hook.js"
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
          "userPromptSubmit",
          "stop",
          ...enabledNotificationHookEvents,
        ]),
      ]
    );
    const ctrlyokeHooksSection = (
      hookConfig as { type: string; config: { hooks: Record<string, unknown> } }
    ).config.hooks as Record<string, unknown[]>;
    const wrappedCtrlYokeEvents = [
      ...new Set<HookEvent>([
        "sessionStart",
        "userPromptSubmit",
        "stop",
        ...enabledNotificationHookEvents,
      ]),
    ];
    const ctrlyokeHookKeys = this.buildTrustedHookKeys(ctrlyokeHooksSection);
    const ownedKeys = [
      ...new Set([...Object.keys(ctrlyokeHooksSection), ...ctrlyokeHookKeys]),
    ];

    const workflowKey = workingFilePath ?? workspaceRoot;
    return {
      cliArgs: [],
      mutations: [
        {
          path: path.join(workspaceRoot, ".qwen", "settings.json"),
          ownedKeys,
          description: "Register Qwen notification hooks and trust keys",
          apply: async () => {
            await this.registerHooksInSettings(
              workspaceRoot,
              workflowKey,
              ctrlyokeHooksSection,
              ctrlyokeHookKeys,
              userHooks,
              wrappedCtrlYokeEvents
            );
            Log.debug(`🔔 Configured Stop hook for Qwen completion detection`);
          },
        },
      ],
      diagnostics: [],
    };
  }

  /**
   * Set up user-only hooks for headless execution.
   * No ctrlyoke notification hooks are included since headless uses process-exit for completion.
   * Hooks are enabled by default in Qwen — no CLI flag needed.
   */
  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const preparation = await this.planHeadlessUserHookArgs(
      extensionPath,
      workspaceRoot,
      _promptIndex,
      workingFilePath,
      userHooks,
      enabledNotificationHookEvents
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs;
  }

  async planHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<CliProviderPreparation> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    const ctrlyokeHooksSection =
      enabledNotificationHookEvents.length > 0
        ? (
            this.notificationMonitor.buildHookConfig(
              path.join(
                extensionPath,
                "out",
                "scripts",
                "ctrlyoke-qwen-hook.js"
              ),
              this.notificationMonitor.getNotificationDirectory(workspaceRoot),
              workspaceRoot,
              userHooks,
              enabledNotificationHookEvents
            ) as {
              type: string;
              config: { hooks: Record<string, unknown[]> };
            }
          ).config.hooks
        : {};
    const ctrlyokeHookKeys = this.buildTrustedHookKeys(ctrlyokeHooksSection);
    const ownedKeys = [
      ...new Set([...Object.keys(ctrlyokeHooksSection), ...ctrlyokeHookKeys]),
    ];
    return {
      cliArgs: [],
      mutations: [
        {
          path: path.join(workspaceRoot, ".qwen", "settings.json"),
          ownedKeys,
          description: "Register Qwen headless hooks and trust keys",
          apply: async () => {
            await this.registerHooksInSettings(
              workspaceRoot,
              workflowKey,
              ctrlyokeHooksSection,
              ctrlyokeHookKeys,
              userHooks,
              enabledNotificationHookEvents
            );
            Log.debug(`🔔 Configured user hooks for Qwen headless mode`);
          },
        },
      ],
      diagnostics: [],
    };
  }

  /**
   * Build CLI arguments for tool permissions.
   * Called for both interactive and headless modes by CliIntegration.runExecutionSession().
   */
  async prepareToolPermissions(
    toolPermissions: ToolPermissionConfig | null | undefined,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (toolPermissions === null) {
      return { cliArgs: [], diagnostics: [] };
    }
    const config = toolPermissions ?? {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.toolPermissionMapper.prepare(config, context);
  }

  /**
   * Shared helper: merge hooks into .qwen/settings.json and pre-trust them.
   *
   * Uses SettingsJsonHooksTracker for parallel-safe ref-counted hook management.
   * Pass an empty ctrlyokeHooksSection + undefined ctrlyokeHookKey for headless (user-only) mode.
   */
  private async registerHooksInSettings(
    workspaceRoot: string,
    workflowKey: string,
    ctrlyokeHooksSection: Record<string, unknown[]>,
    ctrlyokeHookKeys: string[],
    userHooks: UserHookConfig[] | undefined,
    wrappedCtrlYokeEvents: HookEvent[] = []
  ): Promise<void> {
    const workflowUserHooks = this.buildUserHooksSection(
      userHooks,
      wrappedCtrlYokeEvents
    );

    // Register hooks via ref-counted tracker under its own mutation lock.
    await this.hooksTracker.withLock(async () => {
      await this.hooksTracker.registerWorkflow(
        workflowKey,
        workspaceRoot,
        ctrlyokeHooksSection,
        workflowUserHooks
      );
    });

    await this.trustedHooksTracker.registerWorkflow(
      workflowKey,
      workspaceRoot,
      ctrlyokeHookKeys,
      (userHooks ?? []).map((uh) => `:${uh.command}`)
    );
  }

  private buildUserHooksSection(
    userHooks?: UserHookConfig[],
    wrappedCtrlYokeEvents: HookEvent[] = []
  ): Record<string, unknown[]> {
    const section: Record<string, unknown[]> = {};
    for (const uh of userHooks ?? []) {
      if (
        uh.event === "permissionRequest" &&
        wrappedCtrlYokeEvents.includes("permissionRequest")
      ) {
        continue;
      }
      const nativeEvent = QwenNotificationMonitor.EVENT_MAP[uh.event];
      if (!nativeEvent) continue;
      if (!section[nativeEvent]) {
        section[nativeEvent] = [];
      }
      section[nativeEvent].push({
        hooks: [{ type: "command", command: uh.command }],
      });
    }
    return section;
  }

  private buildTrustedHookKeys(
    hooksSection: Record<string, unknown[]>
  ): string[] {
    const keys = new Set<string>();
    for (const groups of Object.values(hooksSection)) {
      for (const group of groups) {
        if (!group || typeof group !== "object") {
          continue;
        }
        const hooks = (group as { hooks?: unknown[] }).hooks;
        if (!Array.isArray(hooks)) {
          continue;
        }
        for (const hook of hooks) {
          if (!hook || typeof hook !== "object") {
            continue;
          }
          const command = (hook as { command?: unknown }).command;
          if (typeof command === "string" && command.length > 0) {
            keys.add(`:${command}`);
          }
        }
      }
    }
    return [...keys];
  }

  /**
   * Clean up workflow hook artifacts from .qwen/settings.json.
   *
   * Hooks remain workspace-backed until Qwen provides an inline hook mechanism.
   *
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Unique workflow key for the hooks tracker
   */
  async cleanupWorkspaceArtifacts(
    workspaceRoot: string,
    workingFilePath?: string
  ): Promise<void> {
    // Unregister hooks via ref-counted tracker (serialized to avoid file races)
    const hookKey = workingFilePath ?? workspaceRoot;
    await this.hooksTracker.withLock(async () => {
      await this.hooksTracker.unregisterWorkflow(hookKey, workspaceRoot);
    });
    await this.trustedHooksTracker.unregisterWorkflow(hookKey);
  }

  /**
   * Validate model is supported by Qwen CLI, fallback to configured default if not
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    const defaultModel = ConfigurationUtils.getQwenCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check for "none" sentinel value (skip --model flag)
    if (requestedModel === "none") {
      return undefined;
    }

    // Accept any model string — Qwen CLI validates it against the configured API key
    return requestedModel;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Qwen CLI expects the prompt as a positional argument.
   * Format: qwen "prompt" --output-format stream-json --input-format stream-json [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.ctrlyoke/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // --output-format stream-json enables structured JSON output for reliable parsing.
    // --input-format stream-json is required alongside it (Qwen rejects the combination
    // otherwise) and exempts this run from Qwen's non-interactive auto-deny gate, which
    // resolves --allowed-tools entries against a narrower, stale alias table than the
    // one used everywhere else and silently force-denies tools it doesn't recognize
    // (e.g. write_file) even when explicitly allowed. Qwen auto-wraps this positional
    // prompt into the initial stream-json user message internally — no stdin writing
    // needed — and ctrlyoke's headless spawn already runs with stdin ignored, so the
    // session's stdin read loop EOFs immediately and drains the in-flight turn before
    // exiting, matching the existing process-exit completion signal.
    return [
      prompt,
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      ...baseArgs,
    ];
  }

  /**
   * Build CLI arguments for interactive TUI mode
   *
   * Qwen interactive mode: qwen "prompt text" [args...] (no --output-format = interactive)
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
   * Format a file path reference for Qwen Code CLI
   *
   * Qwen accepts @path format for file references (same as Copilot).
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path")
   */
  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration for Qwen Code CLI.
   *
   * Qwen CLI accepts a per-invocation inline JSON object through `--mcp-config`.
   * The shared settings-entry builder keeps this schema aligned with Qwen's
   * native settings format without writing a workspace settings file.
   *
   * @returns Two tokens (`--mcp-config` and its JSON value), or null without MCP
   */
  async getMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<string[] | null> {
    const preparation = await this.planMcpConfigArgs(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers
    );
    await applyPreparedMutations(preparation.mutations);
    return preparation.cliArgs.length > 0 ? preparation.cliArgs : null;
  }

  async planMcpConfigArgs(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Promise<CliProviderPreparation> {
    if (!mcpServerPath && (!userServers || userServers.length === 0)) {
      return { cliArgs: [], mutations: [], diagnostics: [] };
    }

    const mcpEntries = CliProviderUtils.buildSettingsJsonMcpEntries(
      mcpServerPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      userServers
    );

    return {
      cliArgs: ["--mcp-config", JSON.stringify({ mcpServers: mcpEntries })],
      mutations: [],
      diagnostics: [],
    };
  }

  /**
   * Return null — inline MCP config does not have a file path to clean up.
   */
  getMcpConfigFilePath(
    _workingFilePath: string | undefined,
    _workspaceRoot: string
  ): null {
    return null;
  }

  /**
   * Check if Qwen Code CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    return CliProviderUtils.checkCliAvailability("qwen --version");
  }

  /**
   * Get Qwen Code CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion("qwen --version");
  }

  /**
   * Check if error is a Qwen Code CLI invalid session error.
   *
   * This classifies a process-spawn error so the runner can retry without
   * the resume flag; it is intentionally a provider concern, not output
   * parsing.
   */
  isRecoverableSessionError(error: unknown): boolean {
    const message = getErrorMessage(error);
    return (
      message.includes("invalid session") ||
      message.includes("session not found") ||
      message.includes("--resume requires a valid session")
    );
  }
}
