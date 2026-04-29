import {
  DynamicQueueConfig,
  EndCondition,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
} from "../types/FlightPathTypes";
import type { TerminalSettings } from "../types/FlightPathSettings";
import {
  HARNESS_IDS,
  DEFAULT_MODELS,
  type HarnessId,
  type PermissionMode,
} from "../types/DashboardConstants";
import { configService } from "../config/FlightPathConfigService";

/**
 * Configuration key constants (single source of truth for configService.get/set key strings)
 */
export const CONFIG_KEYS = {
  // Top-level section keys (used with configService.get())
  HARNESS: "harness",
  MODELS: "models",
  ADDITIONAL_ARGS: "additionalArgs",
  EXECUTION: "execution",
  TOOLS: "tools",
  WORKFLOW: "workflow",
  CHAT: "chat",
  MCP: "mcp",
  HOOKS: "hooks",
  QUEUE: "queue",
  HISTORY: "history",
  TERMINAL: "terminal",
  UI: "ui",
  SERVER: "server",
  NOTIFICATIONS: "notifications",
  ENABLE_DIAGNOSTIC_LOGS: "enableDiagnosticLogs",

  // Dot-notation paths (used with configService.set())
  WORKFLOW_DEFAULT_END_CONDITION: "workflow.defaultEndCondition",
  WORKFLOW_DEFAULT_PRE_CONDITION: "workflow.defaultPreCondition",
  WORKFLOW_DEFAULT_AGENT: "workflow.defaultAgent",
  WORKFLOW_DEFAULT_SKILLS: "workflow.defaultSkills",
  WORKFLOW_DEFAULT_TEMPLATE: "workflow.defaultTemplate",
  WORKFLOW_RESUME_EXISTING_SESSION: "workflow.resumeExistingSession",
  EXECUTION_MODE: "execution.mode",
  TOOLS_PERMISSION_MODE: "tools.permissionMode",
  TOOLS_ALLOWED: "tools.allowed",
  TOOLS_DENIED: "tools.denied",
  SERVER_ENABLED: "server.enabled",
  SERVER_TLS_CERT_PATH: "server.tls.certPath",
  SERVER_TLS_KEY_PATH: "server.tls.keyPath",
  UI_CONFIRM_DELETE_OPERATIONS: "ui.confirmDeleteOperations",
  UI_CONFIRM_RESET_OPERATIONS: "ui.confirmResetOperations",
  UI_SHOW_HEADLESS_PERMISSION_WARNING: "ui.showHeadlessPermissionWarning",
  UI_AUTO_FOCUS_OUTPUT_ON_EXECUTION: "ui.autoFocusOutputOnExecution",
  MCP_DEFAULT_SERVERS: "mcp.defaultServers",
  EXTENSION_NAMESPACE: "flightpath.",
} as const;

/**
 * Configuration scope constants (single source of truth for configService.set scope strings)
 */
export const CONFIG_SCOPE = {
  USER: "user",
  WORKSPACE: "workspace",
} as const;

/**
 * Path constants (single source of truth for directory names)
 */
export const PATH_CONSTANTS = {
  /** Root FlightPath directory name (default: ".flightpath") */
  FLIGHTPATH_DIR: ".flightpath",

  /** Queue directory name (subdirectory of FLIGHTPATH_DIR) */
  QUEUE_DIR: ".queue",

  /** Scripts directory name (subdirectory of FLIGHTPATH_DIR) */
  SCRIPTS_DIR: "scripts",

  /** Prompts directory name (subdirectory of FLIGHTPATH_DIR) */
  PROMPTS_DIR: "prompts",

  /** Templates directory name (subdirectory of FLIGHTPATH_DIR) */
  TEMPLATES_DIR: "templates",

  /** Workflows directory name (subdirectory of FLIGHTPATH_DIR) */
  WORKFLOWS_DIR: "workflows",

  /** Temp directory name (subdirectory of FLIGHTPATH_DIR) */
  TEMP_DIR: "temp",

  /** Logs directory name (subdirectory of FLIGHTPATH_DIR) */
  LOGS_DIR: "logs",

  /** History directory name (subdirectory of FLIGHTPATH_DIR) */
  HISTORY_DIR: ".history",

  /** Agents directory name (subdirectory of FLIGHTPATH_DIR) */
  AGENTS_DIR: "agents",

  /** Skills directory name (subdirectory of FLIGHTPATH_DIR) */
  SKILLS_DIR: "skills",

  /** Certs directory name (subdirectory of FLIGHTPATH_DIR) — gitignored */
  CERTS_DIR: "certs",

  /** Notifications directory name (subdirectory of FLIGHTPATH_DIR) */
  NOTIFICATIONS_DIR: "notifications",

  /** Capabilities file name (written by extension, read by MCP server) */
  CAPABILITIES_FILE: "capabilities.json",

  /** Persisted push subscription registry file (inside NOTIFICATIONS_DIR) */
  PUSH_SUBSCRIPTIONS_FILE: "push-subscriptions.json",

  /** Persisted VAPID key pair file (inside NOTIFICATIONS_DIR) */
  VAPID_KEYS_FILE: "vapid-keys.json",

  /** MCP directory name (subdirectory of FLIGHTPATH_DIR) */
  MCP_DIR: "mcp",

  /** Workspace MCP server registry file name (inside MCP_DIR) */
  MCP_SERVERS_FILE: "servers.json",
} as const;

/**
 * Configuration utility functions for FlightPath settings.
 * Centralizes all settings access for consistency and testability.
 */
export const ConfigurationUtils = {
  /**
   * Check if CLI command should be shown in dashboard output
   */
  shouldShowCliCommand(): boolean {
    return configService.get(CONFIG_KEYS.UI).showCliCommand;
  },

  /**
   * Check if CLI output should be shown in output panel
   */
  shouldShowCliOutput(): boolean {
    return configService.get(CONFIG_KEYS.UI).showCliOutput;
  },

  /**
   * Check if raw CLI output should be logged for debugging
   */
  shouldLogRawCliOutput(): boolean {
    return configService.get(CONFIG_KEYS.UI).logRawCliOutput;
  },

  /**
   * Check if the headless limited-permissions warning should be shown.
   */
  shouldShowHeadlessPermissionWarning(): boolean {
    return configService.get(CONFIG_KEYS.UI).showHeadlessPermissionWarning;
  },

  /**
   * Check if prompt execution should automatically reveal the output section
   * and switch to the relevant output view (output vs terminal).
   */
  shouldAutoFocusOutputOnExecution(): boolean {
    return configService.get(CONFIG_KEYS.UI).autoFocusOutputOnExecution;
  },

  /**
   * Check if diagnostic file logging is enabled.
   * When true, FlightPath writes log files to .flightpath/logs/ in production builds.
   * Dev builds always write log files regardless of this setting.
   */
  isDiagnosticLogsEnabled(): boolean {
    return configService.get(CONFIG_KEYS.ENABLE_DIAGNOSTIC_LOGS);
  },

  /**
   * Check if prompt files should open in the second editor group
   */
  shouldOpenPromptsInSecondGroup(): boolean {
    return configService.get(CONFIG_KEYS.UI).openPromptsInSecondGroup;
  },

  /**
   * Get the default harness from settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI), codex-cli (Codex CLI)
   */
  getIntegrationMode(): HarnessId {
    const mode = configService.get(CONFIG_KEYS.HARNESS) as HarnessId;
    const validIds = Object.values(HARNESS_IDS) as HarnessId[];
    return validIds.includes(mode) ? mode : HARNESS_IDS.COPILOT_CLI;
  },

  /**
   * Get dynamic queue configuration from settings
   */
  getDynamicQueueConfig(): DynamicQueueConfig {
    const queue = configService.get(CONFIG_KEYS.QUEUE);
    return {
      maxQueueSize: queue.maxSize,
      maxWorkflowExecutionTime: queue.maxWorkflowExecutionTime,
      unlimitedMode: queue.unlimitedMode,
      notifyOnExtension: queue.notifyOnExtension,
    };
  },

  /**
   * Get embedded terminal settings.
   */
  getTerminalSettings(): TerminalSettings {
    return configService.get(CONFIG_KEYS.TERMINAL);
  },

  /**
   * Get the script timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   */
  getScriptTimeoutMs(): number {
    return configService.get(CONFIG_KEYS.EXECUTION).scriptTimeout * 1000;
  },

  /**
   * Get the default end condition for new workflows (null/undefined = disabled)
   */
  getDefaultEndCondition(): EndCondition | null | undefined {
    return configService.get(CONFIG_KEYS.WORKFLOW).defaultEndCondition;
  },

  /**
   * Get the default pre-condition for new workflows (null/undefined = disabled)
   */
  getDefaultPreCondition(): PreCondition | null | undefined {
    return configService.get(CONFIG_KEYS.WORKFLOW).defaultPreCondition;
  },

  /**
   * Get default max retries for end conditions (reads from defaultEndCondition)
   */
  getDefaultMaxRetries(): number {
    return (
      configService.get(CONFIG_KEYS.WORKFLOW).defaultEndCondition?.maxRetries ??
      0
    );
  },

  /**
   * Get default retry prompt template (reads from defaultEndCondition)
   */
  getDefaultRetryPrompt(): string {
    return (
      configService.get(CONFIG_KEYS.WORKFLOW).defaultEndCondition
        ?.retryPrompt ?? ""
    );
  },

  /**
   * Set the default end condition in settings
   */
  async setDefaultEndCondition(value: EndCondition | null): Promise<void> {
    await configService.set(
      CONFIG_KEYS.WORKFLOW_DEFAULT_END_CONDITION,
      value,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default pre-condition in settings
   */
  async setDefaultPreCondition(value: PreCondition | null): Promise<void> {
    await configService.set(
      CONFIG_KEYS.WORKFLOW_DEFAULT_PRE_CONDITION,
      value,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Get default workflow format (yaml or json)
   */
  getDefaultWorkflowFormat(): "yaml" | "json" {
    return configService.get(CONFIG_KEYS.WORKFLOW).defaultFormat;
  },

  /**
   * Check if .gitignore should be respected for completions
   */
  shouldRespectGitignoreForCompletions(): boolean {
    return configService.get(CONFIG_KEYS.UI).respectGitignoreForCompletions;
  },

  /**
   * Get the default CLI model (Copilot CLI)
   */
  getCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.MODELS)[HARNESS_IDS.COPILOT_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.COPILOT_CLI]
    );
  },

  /**
   * Get model for a specific harness
   * Maps harness enum to the appropriate model setting
   */
  getModelForHarness(harness: HarnessId): string {
    switch (harness) {
      case HARNESS_IDS.COPILOT_CLI:
        return ConfigurationUtils.getCliModel();
      case HARNESS_IDS.COPILOT_CHAT:
        return ConfigurationUtils.getCopilotChatModel();
      case HARNESS_IDS.CLAUDE_CLI:
        return ConfigurationUtils.getClaudeCliModel();
      case HARNESS_IDS.CODEX_CLI:
        return ConfigurationUtils.getCodexCliModel();
      case HARNESS_IDS.OPENCODE_CLI:
        return ConfigurationUtils.getOpenCodeCliModel();
      case HARNESS_IDS.GEMINI_CLI:
        return ConfigurationUtils.getGeminiCliModel();
      case HARNESS_IDS.QWEN_CLI:
        return ConfigurationUtils.getQwenCliModel();
      default:
        // Fallback to Copilot CLI model
        return ConfigurationUtils.getCliModel();
    }
  },

  /**
   * Get allowed directories for CLI operations (copilot-cli, claude-cli, codex-cli, qwen-cli).
   * Not supported by gemini-cli, opencode-cli, or copilot-chat.
   */
  getCliAllowedDirs(): string[] {
    return configService.get(CONFIG_KEYS.TOOLS).allowedDirs;
  },

  /**
   * Get CLI tool permissions mode (shared between Copilot and Claude)
   */
  getCliToolPermissions(): Exclude<PermissionMode, "none"> {
    return configService.get(CONFIG_KEYS.TOOLS).permissionMode as Exclude<
      PermissionMode,
      "none"
    >;
  },

  /**
   * Get chat window location preference
   */
  getChatWindowLocation(): "chatPanel" | "newTab" | "newWindow" {
    return configService.get(CONFIG_KEYS.CHAT).windowLocation;
  },

  /**
   * Get chat inactivity timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   */
  getChatInactivityTimeoutMs(): number {
    return configService.get(CONFIG_KEYS.CHAT).inactivityTimeout * 1000;
  },

  /**
   * Check if chat timeout should be treated as success
   * When true, inactivity timeouts are treated as successful completions
   */
  shouldTreatChatTimeoutAsSuccess(): boolean {
    return configService.get(CONFIG_KEYS.CHAT).treatTimeoutAsSuccess;
  },

  // ============================================================
  // CLI EXECUTION SETTINGS
  // ============================================================

  /**
   * Get CLI execution mode (interactive terminal or headless)
   */
  getCliExecutionMode(): string {
    return configService.get(CONFIG_KEYS.EXECUTION).mode;
  },

  /**
   * Returns true when inject mode is enabled.
   * Keeps the TUI alive and writes follow-up prompts directly into the PTY,
   * avoiding terminal restart latency and the Claude Code resume cache bug.
   *
   * closeTerminalOnComplete takes precedence: if terminals are closed on
   * completion, injection is impossible regardless of the injectMode setting.
   */
  isInjectModeEnabled(): boolean {
    const exec = configService.get(CONFIG_KEYS.EXECUTION);
    if (exec.closeTerminalOnComplete) {
      return false;
    }
    return exec.injectMode;
  },

  /**
   * Check if terminal should be closed when each interactive prompt completes
   */
  shouldCloseTerminalWhenPromptCompletes(): boolean {
    return configService.get(CONFIG_KEYS.EXECUTION).closeTerminalOnComplete;
  },

  /**
   * Check if categorized temp prompt files should be deleted after execution.
   * Returns false when the user wants to inspect files in .flightpath/temp/ for debugging.
   */
  shouldAutoDeleteTempFiles(): boolean {
    return configService.get(CONFIG_KEYS.EXECUTION).autoDeleteTempFiles;
  },

  /**
   * Get maximum prompt execution timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   * Returns undefined if set to -1 (unlimited)
   */
  getMaxPromptExecutionTimeMs(): number | undefined {
    const timeoutSeconds = configService.get(
      CONFIG_KEYS.EXECUTION
    ).maxPromptTimeout;
    return timeoutSeconds === -1 ? undefined : timeoutSeconds * 1000;
  },

  /**
   * Check if all paths should be allowed for Copilot CLI
   */
  shouldAllowAllPaths(): boolean {
    return configService.get(CONFIG_KEYS.TOOLS).copilotAllowAllPaths;
  },

  // ============================================================
  // CLAUDE CLI SETTINGS
  // ============================================================

  /**
   * Get Claude CLI model
   */
  getClaudeCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.MODELS)[HARNESS_IDS.CLAUDE_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.CLAUDE_CLI]
    );
  },

  // ============================================================
  // OPENCODE CLI SETTINGS
  // ============================================================

  /**
   * Get OpenCode CLI model (user-configured, free-form provider/model format)
   */
  getOpenCodeCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.MODELS)[HARNESS_IDS.OPENCODE_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.OPENCODE_CLI]
    );
  },

  // ============================================================
  // QWEN CLI SETTINGS
  // ============================================================

  /**
   * Get Qwen CLI model
   */
  getQwenCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.MODELS)[HARNESS_IDS.QWEN_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.QWEN_CLI]
    );
  },

  // ============================================================
  // GEMINI CLI SETTINGS
  // ============================================================

  /**
   * Get Gemini CLI model
   */
  getGeminiCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.MODELS)[HARNESS_IDS.GEMINI_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.GEMINI_CLI]
    );
  },

  // ============================================================
  // CODEX CLI SETTINGS
  // ============================================================

  /**
   * Get Codex CLI model
   */
  getCodexCliModel(): string {
    return (
      configService.get(CONFIG_KEYS.MODELS)[HARNESS_IDS.CODEX_CLI] ??
      DEFAULT_MODELS[HARNESS_IDS.CODEX_CLI]
    );
  },

  /**
   * Get Codex CLI sandbox mode
   * Options: read-only, workspace-write, danger-full-access
   */
  getCodexSandboxMode(): string {
    return configService.get(CONFIG_KEYS.TOOLS).codexSandboxMode;
  },

  /**
   * Get Codex CLI approval policy
   * Options: untrusted, on-request, never
   */
  getCodexApprovalPolicy(): string {
    return configService.get(CONFIG_KEYS.TOOLS).codexApprovalPolicy;
  },

  // ============================================================
  // SHARED CLI TOOL SETTINGS
  // ============================================================

  /**
   * Get extra CLI flags to append for a specific harness (global fallback).
   * Prompt-level and workflow-level additionalArgs take precedence via PropertyResolver.
   * copilot-chat is not a CLI harness and returns "".
   */
  getAdditionalArgsForHarness(harness: HarnessId): string {
    if (harness === HARNESS_IDS.COPILOT_CHAT) {
      return "";
    }
    return configService.get(CONFIG_KEYS.ADDITIONAL_ARGS)[harness] ?? "";
  },

  /**
   * Get allowed tools for CLI operations (shared between Copilot and Claude)
   */
  getCliAllowedTools(): string[] {
    return configService.get(CONFIG_KEYS.TOOLS).allowed;
  },

  /**
   * Get denied tools for CLI operations (shared between Copilot and Claude)
   */
  getCliDeniedTools(): string[] {
    return configService.get(CONFIG_KEYS.TOOLS).denied;
  },

  // ============================================================
  // SESSION & WORKFLOW SETTINGS
  // ============================================================

  /**
   * Get the default prior context injection mode for workflow prompts.
   */
  getPriorContext(): string {
    return configService.get(CONFIG_KEYS.WORKFLOW).priorContext;
  },

  /**
   * Check if existing chat session should be resumed per prompt
   */
  shouldResumeExistingSession(): boolean {
    return configService.get(CONFIG_KEYS.WORKFLOW).resumeExistingSession;
  },

  /**
   * Determine if existing chat session should be resumed for a specific prompt
   * Checks prompt's explicit setting first, then falls back to global setting
   * @param promptResumeSession The prompt's resumeSession property (may be undefined)
   * @returns true if session should be resumed, false to start new session
   */
  shouldResumeSessionForPrompt(
    promptResumeSession: boolean | undefined
  ): boolean {
    if (promptResumeSession !== undefined) {
      return promptResumeSession;
    }
    return ConfigurationUtils.shouldResumeExistingSession();
  },

  /**
   * Get default workflow template ID
   */
  getDefaultWorkflowTemplate(): string {
    return configService.get(CONFIG_KEYS.WORKFLOW).defaultTemplate;
  },

  /**
   * Check if recent session should be auto-loaded on startup
   */
  shouldAutoLoadRecentSession(): boolean {
    return configService.get(CONFIG_KEYS.WORKFLOW).autoLoadRecentSession;
  },

  // ============================================================
  // CHAT MODE SETTINGS
  // ============================================================

  /**
   * Get the default Copilot Chat model
   */
  getCopilotChatModel(): string {
    return (
      configService.get(CONFIG_KEYS.MODELS)[HARNESS_IDS.COPILOT_CHAT] ??
      DEFAULT_MODELS[HARNESS_IDS.COPILOT_CHAT]
    );
  },

  /**
   * Get the default agent name for new workflows
   * Returns empty string if no default agent is selected
   */
  getDefaultAgent(): string {
    return configService.get(CONFIG_KEYS.WORKFLOW).defaultAgent;
  },

  /**
   * Get the default skills for new workflows
   * Returns empty array if no default skills are selected
   */
  getDefaultSkills(): string[] {
    return configService.get(CONFIG_KEYS.WORKFLOW).defaultSkills ?? [];
  },

  /**
   * Check if agent mode should be forced for chat
   */
  shouldForceAgentModeForChat(): boolean {
    return configService.get(CONFIG_KEYS.CHAT).forceAgentMode;
  },

  /**
   * Check if native attachments should be used for chat mode.
   * When false (default), builds temp prompt files with embedded agent/skills/context.
   * When true, uses VS Code's native attachFile commands and agent-specific chat windows.
   */
  shouldUseChatNativeAttachments(): boolean {
    return configService.get(CONFIG_KEYS.CHAT).useNativeAttachments;
  },

  /**
   * Check if agent and skill instructions should be omitted when resuming a session.
   * When true (default), agent/skill blocks are skipped for prompts that resume an existing
   * session — preventing duplicate instructions since the harness already received them
   * in the first message of that session.
   */
  shouldOmitAgentsAndSkillsOnResume(): boolean {
    return configService.get(CONFIG_KEYS.WORKFLOW).omitAgentsSkillsOnResume;
  },

  // ============================================================
  // SETTINGS UPDATE HELPERS
  // ============================================================

  /**
   * Get a FlightPath configuration value by dot-notation path
   * @param key The setting path (dot-notation, e.g. "execution.mode")
   * @param defaultValue The default value if setting is not defined
   * @returns The configuration value
   */
  getConfigValue<T>(key: string, defaultValue?: T): T | undefined {
    const value = configService.getNested(key) as T | undefined;
    if (value !== undefined) {
      return value;
    }
    return defaultValue;
  },

  /**
   * Update a FlightPath configuration setting
   * @param key The setting path (dot-notation, e.g. "execution.mode")
   * @param value The new value
   * @param _target Ignored — always writes to user scope via config service
   */
  async updateSetting<T>(
    key: string,
    value: T,
    _target?: unknown
  ): Promise<void> {
    await configService.set(key, value, CONFIG_SCOPE.USER);
  },

  // ============================================================
  // SETTINGS UPDATE METHODS
  // ============================================================

  /**
   * Set the default harness integration mode
   */
  async setIntegrationMode(harness: HarnessId): Promise<void> {
    await configService.set(CONFIG_KEYS.HARNESS, harness, CONFIG_SCOPE.USER);
  },

  /**
   * Set the model for a specific harness
   */
  async setModelForHarness(harness: HarnessId, model: string): Promise<void> {
    await configService.set(
      `${CONFIG_KEYS.MODELS}.${harness}`,
      model,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default additional args for a specific harness
   */
  async setAdditionalArgsForHarness(
    harness: HarnessId,
    args: string
  ): Promise<void> {
    // Pass undefined to remove the setting entirely when args is empty —
    // avoids leaving a "" entry in settings.json.
    await configService.set(
      `${CONFIG_KEYS.ADDITIONAL_ARGS}.${harness}`,
      args || undefined,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default agent for new workflows
   */
  async setDefaultAgent(agent: string): Promise<void> {
    await configService.set(
      CONFIG_KEYS.WORKFLOW_DEFAULT_AGENT,
      agent,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set the default skills for new workflows
   */
  async setDefaultSkills(skills: string[]): Promise<void> {
    await configService.set(
      CONFIG_KEYS.WORKFLOW_DEFAULT_SKILLS,
      skills,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set CLI execution mode
   */
  async setCliExecutionMode(mode: string): Promise<void> {
    await configService.set(
      CONFIG_KEYS.EXECUTION_MODE,
      mode,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Set whether to resume existing session
   */
  async setResumeExistingSession(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.WORKFLOW_RESUME_EXISTING_SESSION,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Get the default MCP servers from settings
   */
  getDefaultMcpServers(): (string | McpServerConfig)[] {
    return configService.get(CONFIG_KEYS.MCP).defaultServers;
  },

  /**
   * Set the default MCP servers in settings
   */
  async setDefaultMcpServers(
    servers: (string | McpServerConfig)[]
  ): Promise<void> {
    await configService.set(
      CONFIG_KEYS.MCP_DEFAULT_SERVERS,
      servers,
      CONFIG_SCOPE.USER
    );
  },

  /**
   * Get the default hooks from settings
   */
  getDefaultHooks(): UserHookConfig[] {
    return configService.get(CONFIG_KEYS.HOOKS);
  },

  /**
   * Set the default hooks in settings
   */
  async setDefaultHooks(hooks: UserHookConfig[]): Promise<void> {
    await configService.set(CONFIG_KEYS.HOOKS, hooks, CONFIG_SCOPE.USER);
  },

  /**
   * Set the default workflow template
   */
  async setDefaultWorkflowTemplate(templateId: string): Promise<void> {
    await configService.set(
      CONFIG_KEYS.WORKFLOW_DEFAULT_TEMPLATE,
      templateId,
      CONFIG_SCOPE.USER
    );
  },

  // ============================================================
  // OUTPUT HISTORY SETTINGS
  // ============================================================

  /**
   * Check if output history saving is enabled
   */
  isSaveOutputHistoryEnabled(): boolean {
    return configService.get(CONFIG_KEYS.HISTORY).saveOutput;
  },

  /**
   * Get the maximum number of history runs to retain per workflow
   */
  getMaxHistoryRuns(): number {
    return configService.get(CONFIG_KEYS.HISTORY).maxRuns;
  },

  /**
   * Check if delete confirmation dialogs should be shown
   * When true (default), shows a modal before destructive delete operations.
   */
  shouldConfirmDeleteOperations(): boolean {
    return configService.get(CONFIG_KEYS.UI).confirmDeleteOperations;
  },

  /**
   * Set whether to show confirmation dialogs before delete operations
   */
  async setConfirmDeleteOperations(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_CONFIRM_DELETE_OPERATIONS,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  shouldConfirmResetOperations(): boolean {
    return configService.get(CONFIG_KEYS.UI).confirmResetOperations;
  },

  shouldShowHiddenFiles(): boolean {
    return configService.get(CONFIG_KEYS.UI).showHiddenFiles;
  },

  async setConfirmResetOperations(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_CONFIRM_RESET_OPERATIONS,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  async setShowHeadlessPermissionWarning(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_SHOW_HEADLESS_PERMISSION_WARNING,
      enabled,
      CONFIG_SCOPE.USER
    );
  },

  async setAutoFocusOutputOnExecution(enabled: boolean): Promise<void> {
    await configService.set(
      CONFIG_KEYS.UI_AUTO_FOCUS_OUTPUT_ON_EXECUTION,
      enabled,
      CONFIG_SCOPE.USER
    );
  },
};
