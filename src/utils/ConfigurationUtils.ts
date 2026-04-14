import {
  DynamicQueueConfig,
  EndCondition,
  Harness,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
} from "../types/FlightPathTypes";
import {
  HARNESS_IDS,
  DEFAULT_MODELS,
  type HarnessId,
  type PermissionMode,
} from "../types/DashboardConstants";
import { configService } from "../config/FlightPathConfigService";

/**
 * Map a Harness enum value to the HarnessId string used in config keys
 */
function harnessToId(harness: Harness): HarnessId {
  switch (harness) {
    case Harness.CopilotCli:
      return "copilot-cli";
    case Harness.CopilotChat:
      return "copilot-chat";
    case Harness.ClaudeCli:
      return "claude-cli";
    case Harness.CodexCli:
      return "codex-cli";
    case Harness.OpenCodeCli:
      return "opencode-cli";
    case Harness.QwenCli:
      return "qwen-cli";
    case Harness.GeminiCli:
      return "gemini-cli";
    default:
      return "copilot-cli";
  }
}

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

  /** Capabilities file name (written by extension, read by MCP server) */
  CAPABILITIES_FILE: "capabilities.json",

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
    return configService.get("ui").showCliCommand;
  },

  /**
   * Check if CLI output should be shown in output panel
   */
  shouldShowCliOutput(): boolean {
    return configService.get("ui").showCliOutput;
  },

  /**
   * Check if raw CLI output should be logged for debugging
   */
  shouldLogRawCliOutput(): boolean {
    return configService.get("ui").logRawCliOutput;
  },

  /**
   * Check if diagnostic file logging is enabled.
   * When true, FlightPath writes log files to .flightpath/logs/ in production builds.
   * Dev builds always write log files regardless of this setting.
   */
  isDiagnosticLogsEnabled(): boolean {
    return configService.get("enableDiagnosticLogs");
  },

  /**
   * Check if prompt files should open in the second editor group
   */
  shouldOpenPromptsInSecondGroup(): boolean {
    return configService.get("ui").openPromptsInSecondGroup;
  },

  /**
   * Get the default harness from settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI), codex-cli (Codex CLI)
   */
  getIntegrationMode(): Harness {
    const mode = configService.get("harness");

    switch (mode) {
      case HARNESS_IDS.COPILOT_CHAT:
        return Harness.CopilotChat;
      case HARNESS_IDS.CLAUDE_CLI:
        return Harness.ClaudeCli;
      case HARNESS_IDS.CODEX_CLI:
        return Harness.CodexCli;
      case HARNESS_IDS.OPENCODE_CLI:
        return Harness.OpenCodeCli;
      case HARNESS_IDS.GEMINI_CLI:
        return Harness.GeminiCli;
      case HARNESS_IDS.QWEN_CLI:
        return Harness.QwenCli;
      case HARNESS_IDS.COPILOT_CLI:
      default:
        return Harness.CopilotCli;
    }
  },

  /**
   * Get dynamic queue configuration from settings
   */
  getDynamicQueueConfig(): DynamicQueueConfig {
    const queue = configService.get("queue");
    return {
      maxQueueSize: queue.maxSize,
      maxWorkflowExecutionTime: queue.maxWorkflowExecutionTime,
      unlimitedMode: queue.unlimitedMode,
      notifyOnExtension: queue.notifyOnExtension,
    };
  },

  /**
   * Get the script timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   */
  getScriptTimeoutMs(): number {
    return configService.get("execution").scriptTimeout * 1000;
  },

  /**
   * Get the default end condition for new workflows (null/undefined = disabled)
   */
  getDefaultEndCondition(): EndCondition | null | undefined {
    return configService.get("workflow").defaultEndCondition;
  },

  /**
   * Get the default pre-condition for new workflows (null/undefined = disabled)
   */
  getDefaultPreCondition(): PreCondition | null | undefined {
    return configService.get("workflow").defaultPreCondition;
  },

  /**
   * Get default max retries for end conditions (reads from defaultEndCondition)
   */
  getDefaultMaxRetries(): number {
    return configService.get("workflow").defaultEndCondition?.maxRetries ?? 0;
  },

  /**
   * Get default retry prompt template (reads from defaultEndCondition)
   */
  getDefaultRetryPrompt(): string {
    return configService.get("workflow").defaultEndCondition?.retryPrompt ?? "";
  },

  /**
   * Set the default end condition in settings
   */
  async setDefaultEndCondition(value: EndCondition | null): Promise<void> {
    await configService.set("workflow.defaultEndCondition", value, "user");
  },

  /**
   * Set the default pre-condition in settings
   */
  async setDefaultPreCondition(value: PreCondition | null): Promise<void> {
    await configService.set("workflow.defaultPreCondition", value, "user");
  },

  /**
   * Get default workflow format (yaml or json)
   */
  getDefaultWorkflowFormat(): "yaml" | "json" {
    return configService.get("workflow").defaultFormat;
  },

  /**
   * Check if .gitignore should be respected for completions
   */
  shouldRespectGitignoreForCompletions(): boolean {
    return configService.get("ui").respectGitignoreForCompletions;
  },

  /**
   * Get the default CLI model (Copilot CLI)
   */
  getCliModel(): string {
    return (
      configService.get("models")["copilot-cli"] ??
      DEFAULT_MODELS["copilot-cli"]
    );
  },

  /**
   * Get model for a specific harness
   * Maps harness enum to the appropriate model setting
   */
  getModelForHarness(harness: Harness): string {
    switch (harness) {
      case Harness.CopilotCli:
        return ConfigurationUtils.getCliModel();
      case Harness.CopilotChat:
        return ConfigurationUtils.getCopilotChatModel();
      case Harness.ClaudeCli:
        return ConfigurationUtils.getClaudeCliModel();
      case Harness.CodexCli:
        return ConfigurationUtils.getCodexCliModel();
      case Harness.OpenCodeCli:
        return ConfigurationUtils.getOpenCodeCliModel();
      case Harness.GeminiCli:
        return ConfigurationUtils.getGeminiCliModel();
      case Harness.QwenCli:
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
    return configService.get("tools").allowedDirs;
  },

  /**
   * Get CLI tool permissions mode (shared between Copilot and Claude)
   */
  getCliToolPermissions(): Exclude<PermissionMode, "none"> {
    return configService.get("tools").permissionMode as Exclude<
      PermissionMode,
      "none"
    >;
  },

  /**
   * Get chat window location preference
   */
  getChatWindowLocation(): "chatPanel" | "newTab" | "newWindow" {
    return configService.get("chat").windowLocation;
  },

  /**
   * Get chat inactivity timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   */
  getChatInactivityTimeoutMs(): number {
    return configService.get("chat").inactivityTimeout * 1000;
  },

  /**
   * Check if chat timeout should be treated as success
   * When true, inactivity timeouts are treated as successful completions
   */
  shouldTreatChatTimeoutAsSuccess(): boolean {
    return configService.get("chat").treatTimeoutAsSuccess;
  },

  // ============================================================
  // CLI EXECUTION SETTINGS
  // ============================================================

  /**
   * Get CLI execution mode (interactive terminal or headless)
   */
  getCliExecutionMode(): string {
    return configService.get("execution").mode;
  },

  /**
   * Get interactive continuation mode ("restart" or "inject").
   * "restart" kills and restarts the terminal for each follow-up prompt.
   * "inject" keeps the TUI alive and writes the next prompt directly into the PTY.
   */
  getInteractiveContinuationMode(): "restart" | "inject" {
    return configService.get("execution").continuationMode;
  },

  /**
   * Check if terminal should be closed when each interactive prompt completes
   */
  shouldCloseTerminalWhenPromptCompletes(): boolean {
    return configService.get("execution").closeTerminalOnComplete;
  },

  /**
   * Get maximum prompt execution timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   * Returns undefined if set to -1 (unlimited)
   */
  getMaxPromptExecutionTimeMs(): number | undefined {
    const timeoutSeconds = configService.get("execution").maxPromptTimeout;
    return timeoutSeconds === -1 ? undefined : timeoutSeconds * 1000;
  },

  /**
   * Check if all paths should be allowed for Copilot CLI
   */
  shouldAllowAllPaths(): boolean {
    return configService.get("tools").copilotAllowAllPaths;
  },

  // ============================================================
  // CLAUDE CLI SETTINGS
  // ============================================================

  /**
   * Get Claude CLI model
   */
  getClaudeCliModel(): string {
    return (
      configService.get("models")["claude-cli"] ?? DEFAULT_MODELS["claude-cli"]
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
      configService.get("models")["opencode-cli"] ??
      DEFAULT_MODELS["opencode-cli"]
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
      configService.get("models")["qwen-cli"] ?? DEFAULT_MODELS["qwen-cli"]
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
      configService.get("models")["gemini-cli"] ?? DEFAULT_MODELS["gemini-cli"]
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
      configService.get("models")["codex-cli"] ?? DEFAULT_MODELS["codex-cli"]
    );
  },

  /**
   * Get Codex CLI sandbox mode
   * Options: read-only, workspace-write, danger-full-access
   */
  getCodexSandboxMode(): string {
    return configService.get("tools").codexSandboxMode;
  },

  /**
   * Get Codex CLI approval policy
   * Options: untrusted, on-request, never
   */
  getCodexApprovalPolicy(): string {
    return configService.get("tools").codexApprovalPolicy;
  },

  // ============================================================
  // SHARED CLI TOOL SETTINGS
  // ============================================================

  /**
   * Get extra CLI flags to append for a specific harness (global fallback).
   * Prompt-level and workflow-level additionalArgs take precedence via PropertyResolver.
   * copilot-chat is not a CLI harness and returns "".
   */
  getAdditionalArgsForHarness(harness: Harness): string {
    if (harness === Harness.CopilotChat) {
      return "";
    }
    return configService.get("additionalArgs")[harnessToId(harness)] ?? "";
  },

  /**
   * Get allowed tools for CLI operations (shared between Copilot and Claude)
   */
  getCliAllowedTools(): string[] {
    return configService.get("tools").allowed;
  },

  /**
   * Get denied tools for CLI operations (shared between Copilot and Claude)
   */
  getCliDeniedTools(): string[] {
    return configService.get("tools").denied;
  },

  // ============================================================
  // SESSION & WORKFLOW SETTINGS
  // ============================================================

  /**
   * Get the default prior context injection mode for workflow prompts.
   */
  getPriorContext(): string {
    return configService.get("workflow").priorContext;
  },

  /**
   * Check if existing chat session should be resumed per prompt
   */
  shouldResumeExistingSession(): boolean {
    return configService.get("workflow").resumeExistingSession;
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
    return configService.get("workflow").defaultTemplate;
  },

  /**
   * Check if recent session should be auto-loaded on startup
   */
  shouldAutoLoadRecentSession(): boolean {
    return configService.get("workflow").autoLoadRecentSession;
  },

  // ============================================================
  // CHAT MODE SETTINGS
  // ============================================================

  /**
   * Get the default Copilot Chat model
   */
  getCopilotChatModel(): string {
    return (
      configService.get("models")["copilot-chat"] ??
      DEFAULT_MODELS["copilot-chat"]
    );
  },

  /**
   * Get the default agent name for new workflows
   * Returns empty string if no default agent is selected
   */
  getDefaultAgent(): string {
    return configService.get("workflow").defaultAgent;
  },

  /**
   * Get the default skills for new workflows
   * Returns empty array if no default skills are selected
   */
  getDefaultSkills(): string[] {
    return configService.get("workflow").defaultSkills ?? [];
  },

  /**
   * Check if agent mode should be forced for chat
   */
  shouldForceAgentModeForChat(): boolean {
    return configService.get("chat").forceAgentMode;
  },

  /**
   * Check if native attachments should be used for chat mode.
   * When false (default), builds temp prompt files with embedded agent/skills/context.
   * When true, uses VS Code's native attachFile commands and agent-specific chat windows.
   */
  shouldUseChatNativeAttachments(): boolean {
    return configService.get("chat").useNativeAttachments;
  },

  /**
   * Check if agent and skill instructions should be omitted when resuming a session.
   * When true (default), agent/skill blocks are skipped for prompts that resume an existing
   * session — preventing duplicate instructions since the harness already received them
   * in the first message of that session.
   */
  shouldOmitAgentsAndSkillsOnResume(): boolean {
    return configService.get("workflow").omitAgentsSkillsOnResume;
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
    await configService.set(key, value, "user");
  },

  // ============================================================
  // SETTINGS UPDATE METHODS
  // ============================================================

  /**
   * Set the default harness integration mode
   */
  async setIntegrationMode(harness: Harness): Promise<void> {
    await configService.set("harness", harness, "user");
  },

  /**
   * Set the model for a specific harness
   */
  async setModelForHarness(harness: Harness, model: string): Promise<void> {
    await configService.set(`models.${harnessToId(harness)}`, model, "user");
  },

  /**
   * Set the default additional args for a specific harness
   */
  async setAdditionalArgsForHarness(
    harness: Harness,
    args: string
  ): Promise<void> {
    // Pass undefined to remove the setting entirely when args is empty —
    // avoids leaving a "" entry in settings.json.
    await configService.set(
      `additionalArgs.${harnessToId(harness)}`,
      args || undefined,
      "user"
    );
  },

  /**
   * Set the default agent for new workflows
   */
  async setDefaultAgent(agent: string): Promise<void> {
    await configService.set("workflow.defaultAgent", agent, "user");
  },

  /**
   * Set the default skills for new workflows
   */
  async setDefaultSkills(skills: string[]): Promise<void> {
    await configService.set("workflow.defaultSkills", skills, "user");
  },

  /**
   * Set CLI execution mode
   */
  async setCliExecutionMode(mode: string): Promise<void> {
    await configService.set("execution.mode", mode, "user");
  },

  /**
   * Set whether to resume existing session
   */
  async setResumeExistingSession(enabled: boolean): Promise<void> {
    await configService.set("workflow.resumeExistingSession", enabled, "user");
  },

  /**
   * Get the default MCP servers from settings
   */
  getDefaultMcpServers(): (string | McpServerConfig)[] {
    return configService.get("mcp").defaultServers;
  },

  /**
   * Set the default MCP servers in settings
   */
  async setDefaultMcpServers(
    servers: (string | McpServerConfig)[]
  ): Promise<void> {
    await configService.set("mcp.defaultServers", servers, "user");
  },

  /**
   * Get the default hooks from settings
   */
  getDefaultHooks(): UserHookConfig[] {
    return configService.get("hooks");
  },

  /**
   * Set the default hooks in settings
   */
  async setDefaultHooks(hooks: UserHookConfig[]): Promise<void> {
    await configService.set("hooks", hooks, "user");
  },

  /**
   * Set the default workflow template
   */
  async setDefaultWorkflowTemplate(templateId: string): Promise<void> {
    await configService.set("workflow.defaultTemplate", templateId, "user");
  },

  // ============================================================
  // OUTPUT HISTORY SETTINGS
  // ============================================================

  /**
   * Check if output history saving is enabled
   */
  isSaveOutputHistoryEnabled(): boolean {
    return configService.get("history").saveOutput;
  },

  /**
   * Get the maximum number of history runs to retain per workflow
   */
  getMaxHistoryRuns(): number {
    return configService.get("history").maxRuns;
  },

  /**
   * Check if delete confirmation dialogs should be shown
   * When true (default), shows a modal before destructive delete operations.
   */
  shouldConfirmDeleteOperations(): boolean {
    return configService.get("ui").confirmDeleteOperations;
  },

  /**
   * Set whether to show confirmation dialogs before delete operations
   */
  async setConfirmDeleteOperations(enabled: boolean): Promise<void> {
    await configService.set("ui.confirmDeleteOperations", enabled, "user");
  },

  shouldConfirmResetOperations(): boolean {
    return configService.get("ui").confirmResetOperations;
  },

  async setConfirmResetOperations(enabled: boolean): Promise<void> {
    await configService.set("ui.confirmResetOperations", enabled, "user");
  },
};
