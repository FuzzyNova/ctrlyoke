import * as vscode from "vscode";
import { DynamicQueueConfig, Harness } from "../types/FlightPathTypes";
import { HARNESS_IDS, EXECUTION_MODES } from "../types/DashboardConstants";

/**
 * Configuration namespace for FlightPath settings
 */
const CONFIG_NAMESPACE = "flightpath";

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
} as const;

/**
 * Get the FlightPath configuration object
 */
function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
}

/**
 * Get the settings key for a harness model
 * Internal helper for ConfigurationUtils
 */
function getModelSettingKeyForHarness(harness: Harness): string {
  switch (harness) {
    case Harness.CopilotCli:
      return "copilotCliModel";
    case Harness.CopilotChat:
      return "copilotChatModel";
    case Harness.ClaudeCli:
      return "claudeCliModel";
    case Harness.CodexCli:
      return "codexCliModel";
    case Harness.OpenCodeCli:
      return "openCodeCliModel";
    default:
      return "copilotCliModel";
  }
}

/**
 * Get the settings key for harness-specific additional args
 * Internal helper for ConfigurationUtils
 */
function getAdditionalArgsSettingKeyForHarness(harness: Harness): string {
  switch (harness) {
    case Harness.CopilotCli:
      return "copilotCliAdditionalArgs";
    case Harness.ClaudeCli:
      return "claudeCliAdditionalArgs";
    case Harness.CodexCli:
      return "codexCliAdditionalArgs";
    case Harness.OpenCodeCli:
      return "openCodeCliAdditionalArgs";
    default:
      return "copilotCliAdditionalArgs";
  }
}

/**
 * Configuration utility functions for FlightPath settings.
 * Centralizes all VS Code settings access for consistency and testability.
 */
export const ConfigurationUtils = {
  /**
   * Check if CLI command should be shown in dashboard output
   */
  shouldShowCliCommand(): boolean {
    return getConfig().get<boolean>("showCliCommand", false);
  },

  /**
   * Check if CLI output should be shown in output panel
   */
  shouldShowCliOutput(): boolean {
    return getConfig().get<boolean>("showCliOutput", true);
  },

  /**
   * Check if raw CLI output should be logged for debugging
   */
  shouldLogRawCliOutput(): boolean {
    return getConfig().get<boolean>("logRawCliOutput", false);
  },

  /**
   * Check if diagnostic file logging is enabled.
   * When true, FlightPath writes log files to .flightpath/logs/ in production builds.
   * Dev builds always write log files regardless of this setting.
   */
  isDiagnosticLogsEnabled(): boolean {
    return getConfig().get<boolean>("enableDiagnosticLogs", false);
  },

  /**
   * Check if prompt files should open in the second editor group
   */
  shouldOpenPromptsInSecondGroup(): boolean {
    return getConfig().get<boolean>("openPromptsInSecondGroup", false);
  },

  /**
   * Get the default harness from settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI), codex-cli (Codex CLI)
   */
  getIntegrationMode(): Harness {
    const mode = getConfig().get<string>("harness", Harness.CopilotCli);

    switch (mode) {
      case HARNESS_IDS.COPILOT_CHAT:
      case Harness.CopilotChat:
        return Harness.CopilotChat;
      case HARNESS_IDS.CLAUDE_CLI:
      case Harness.ClaudeCli:
        return Harness.ClaudeCli;
      case HARNESS_IDS.CODEX_CLI:
      case Harness.CodexCli:
        return Harness.CodexCli;
      case HARNESS_IDS.OPENCODE_CLI:
      case Harness.OpenCodeCli:
        return Harness.OpenCodeCli;
      case HARNESS_IDS.COPILOT_CLI:
      case Harness.CopilotCli:
      default:
        return Harness.CopilotCli;
    }
  },

  /**
   * Get dynamic queue configuration from settings
   */
  getDynamicQueueConfig(): DynamicQueueConfig {
    const config = getConfig();

    return {
      enabled: config.get<boolean>("enableDynamicQueue", false),
      maxQueueSize: config.get<number>("maxQueueSize", 100),
      maxWorkflowExecutionTime: config.get<number>(
        "maxWorkflowExecutionTime",
        86400
      ),
      unlimitedMode: config.get<boolean>("unlimitedMode", false),
      notifyOnExtension: config.get<boolean>("notifyOnQueueExtension", true),
    };
  },

  /**
   * Get the script timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   */
  getScriptTimeoutMs(): number {
    const timeoutSeconds = getConfig().get<number>("scriptTimeout", 30);
    return timeoutSeconds * 1000;
  },

  /**
   * Get default max retries for end conditions
   */
  getDefaultMaxRetries(): number {
    return getConfig().get<number>("defaultMaxRetries", 3);
  },

  /**
   * Get default retry prompt template
   */
  getDefaultRetryPrompt(): string {
    return getConfig().get<string>("defaultRetryPrompt", "");
  },

  /**
   * Get default workflow format (yaml or json)
   */
  getDefaultWorkflowFormat(): "yaml" | "json" {
    return getConfig().get<"yaml" | "json">("defaultWorkflowFormat", "yaml");
  },

  /**
   * Check if .gitignore should be respected for completions
   */
  shouldRespectGitignoreForCompletions(): boolean {
    return getConfig().get<boolean>("respectGitignoreForCompletions", true);
  },

  /**
   * Get the default CLI model (Copilot CLI)
   */
  getCliModel(): string {
    return getConfig().get<string>("copilotCliModel", "claude-sonnet-4.5");
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
      default:
        // Fallback to Copilot CLI model
        return ConfigurationUtils.getCliModel();
    }
  },

  /**
   * Get allowed directories for CLI operations
   */
  getCliAllowedDirs(): string[] {
    return getConfig().get<string[]>("copilotCliAllowedDirs", []);
  },

  /**
   * Get CLI tool permissions mode (shared between Copilot and Claude)
   */
  getCliToolPermissions(): "dangerouslyAllowAll" | "allowAll" | "custom" {
    return getConfig().get<"dangerouslyAllowAll" | "allowAll" | "custom">(
      "cliToolPermissions",
      "allowAll"
    );
  },

  /**
   * Get chat window location preference
   */
  getChatWindowLocation(): "chatPanel" | "newTab" | "newWindow" {
    return getConfig().get<"chatPanel" | "newTab" | "newWindow">(
      "chatWindowLocation",
      "chatPanel"
    );
  },

  /**
   * Get chat inactivity timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   */
  getChatInactivityTimeoutMs(): number {
    const timeoutSeconds = getConfig().get<number>(
      "chatInactivityTimeout",
      300
    );
    return timeoutSeconds * 1000;
  },

  /**
   * Check if chat timeout should be treated as success
   * When true, inactivity timeouts are treated as successful completions
   */
  shouldTreatChatTimeoutAsSuccess(): boolean {
    return getConfig().get<boolean>("treatChatTimeoutAsSuccess", true);
  },

  // ============================================================
  // CLI EXECUTION SETTINGS
  // ============================================================

  /**
   * Get CLI execution mode (interactive terminal or headless)
   */
  getCliExecutionMode(): string {
    return getConfig().get<string>("cliExecutionMode", EXECUTION_MODES.INTERACTIVE);
  },

  /**
   * Check if terminal should be closed when each interactive prompt completes
   */
  shouldCloseTerminalWhenPromptCompletes(): boolean {
    return getConfig().get<boolean>("closeTerminalWhenPromptCompletes", false);
  },

  /**
   * Get maximum prompt execution timeout in milliseconds
   * User configures in seconds, this returns milliseconds
   * Returns undefined if set to -1 (unlimited)
   */
  getMaxPromptExecutionTimeMs(): number | undefined {
    const timeoutSeconds = getConfig().get<number>(
      "maxPromptExecutionTime",
      10800
    );
    return timeoutSeconds === -1 ? undefined : timeoutSeconds * 1000;
  },

  /**
   * Check if all paths should be allowed for Copilot CLI
   */
  shouldAllowAllPaths(): boolean {
    return getConfig().get<boolean>("copilotCliAllowAllPaths", true);
  },

  // ============================================================
  // CLAUDE CLI SETTINGS
  // ============================================================

  /**
   * Get Claude CLI model
   */
  getClaudeCliModel(): string {
    return getConfig().get<string>("claudeCliModel", "sonnet");
  },

  // ============================================================
  // OPENCODE CLI SETTINGS
  // ============================================================

  /**
   * Get OpenCode CLI model (user-configured, free-form provider/model format)
   */
  getOpenCodeCliModel(): string {
    return getConfig().get<string>(
      "openCodeCliModel",
      "anthropic/claude-sonnet-4-6"
    );
  },

  // ============================================================
  // CODEX CLI SETTINGS
  // ============================================================

  /**
   * Get Codex CLI model
   */
  getCodexCliModel(): string {
    return getConfig().get<string>("codexCliModel", "gpt-5.1-codex");
  },

  /**
   * Get Codex CLI sandbox mode
   * Options: read-only, workspace-write, danger-full-access
   */
  getCodexSandboxMode(): string {
    return getConfig().get<string>("codexSandboxMode", "workspace-write");
  },

  /**
   * Get Codex CLI approval policy
   * Options: untrusted, on-failure, on-request, never
   */
  getCodexApprovalPolicy(): string {
    return getConfig().get<string>("codexApprovalPolicy", "on-request");
  },

  /**
   * Get allowed directories for Codex CLI
   */
  getCodexAllowedDirs(): string[] {
    return getConfig().get<string[]>("codexAllowedDirs", []);
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
    const key = getAdditionalArgsSettingKeyForHarness(harness);
    return getConfig().get<string>(key, "");
  },

  /**
   * Get allowed tools for CLI operations (shared between Copilot and Claude)
   */
  getCliAllowedTools(): string[] {
    return getConfig().get<string[]>("cliAllowedTools", []);
  },

  /**
   * Get denied tools for CLI operations (shared between Copilot and Claude)
   */
  getCliDeniedTools(): string[] {
    return getConfig().get<string[]>("cliDeniedTools", []);
  },

  // ============================================================
  // SESSION & WORKFLOW SETTINGS
  // ============================================================

  /**
   * Get the default prior context injection mode for workflow prompts.
   */
  getPriorContext(): string {
    return getConfig().get<string>("priorContext", "none");
  },

  /**
   * Check if existing chat session should be resumed per prompt
   */
  shouldResumeExistingSession(): boolean {
    return getConfig().get<boolean>("resumeExistingSession", false);
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
    return getConfig().get<string>("defaultWorkflowTemplate", "blank");
  },

  /**
   * Check if recent session should be auto-loaded on startup
   */
  shouldAutoLoadRecentSession(): boolean {
    return getConfig().get<boolean>("autoLoadRecentSession", true);
  },

  // ============================================================
  // CHAT MODE SETTINGS
  // ============================================================

  /**
   * Get the default Copilot Chat model
   */
  getCopilotChatModel(): string {
    return getConfig().get<string>("copilotChatModel", "claude-sonnet-4.5");
  },

  /**
   * Get the default agent name for new workflows
   * Returns empty string if no default agent is selected
   */
  getDefaultAgent(): string {
    return getConfig().get<string>("defaultAgent", "");
  },

  /**
   * Get the default skills for new workflows
   * Returns empty array if no default skills are selected
   */
  getDefaultSkills(): string[] {
    return getConfig().get<string[]>("defaultSkills", []) ?? [];
  },

  /**
   * Check if agent mode should be forced for chat
   */
  shouldForceAgentModeForChat(): boolean {
    return getConfig().get<boolean>("forceAgentModeForChat", false);
  },

  /**
   * Check if native attachments should be used for chat mode.
   * When false (default), builds temp prompt files with embedded agent/skills/context.
   * When true, uses VS Code's native attachFile commands and agent-specific chat windows.
   */
  shouldUseChatNativeAttachments(): boolean {
    return getConfig().get<boolean>("chatUseNativeAttachments", false);
  },

  /**
   * Check if agent and skill instructions should be omitted when resuming a session.
   * When true (default), agent/skill blocks are skipped for prompts that resume an existing
   * session — preventing duplicate instructions since the harness already received them
   * in the first message of that session.
   */
  shouldOmitAgentsAndSkillsOnResume(): boolean {
    return getConfig().get<boolean>("omitAgentsAndSkillsOnResume", true);
  },

  // ============================================================
  // SETTINGS UPDATE HELPERS
  // ============================================================

  /**
   * Get a FlightPath configuration value
   * @param key The setting key (without 'flightpath.' prefix)
   * @param defaultValue The default value if setting is not defined
   * @returns The configuration value
   */
  getConfigValue<T>(key: string, defaultValue?: T): T | undefined {
    if (defaultValue !== undefined) {
      return getConfig().get<T>(key, defaultValue);
    }
    return getConfig().get<T>(key);
  },

  /**
   * Update a FlightPath configuration setting
   * @param key The setting key (without 'flightpath.' prefix)
   * @param value The new value
   * @param target The configuration target (default: Global)
   */
  async updateSetting<T>(
    key: string,
    value: T,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
  ): Promise<void> {
    await getConfig().update(key, value, target);
  },

  // ============================================================
  // SETTINGS UPDATE METHODS
  // ============================================================

  /**
   * Set the default harness integration mode
   */
  async setIntegrationMode(harness: Harness): Promise<void> {
    await this.updateSetting("harness", harness);
  },

  /**
   * Set the model for a specific harness
   */
  async setModelForHarness(harness: Harness, model: string): Promise<void> {
    const settingKey = getModelSettingKeyForHarness(harness);
    await this.updateSetting(settingKey, model);
  },

  /**
   * Set the default additional args for a specific harness
   */
  async setAdditionalArgsForHarness(
    harness: Harness,
    args: string
  ): Promise<void> {
    const settingKey = getAdditionalArgsSettingKeyForHarness(harness);
    // Pass undefined to remove the VS Code setting entirely when args is
    // empty — avoids leaving a "" entry in settings.json.
    await this.updateSetting(settingKey, args || undefined);
  },

  /**
   * Set the default agent for new workflows
   */
  async setDefaultAgent(agent: string): Promise<void> {
    await this.updateSetting("defaultAgent", agent);
  },

  /**
   * Set the default skills for new workflows
   */
  async setDefaultSkills(skills: string[]): Promise<void> {
    await this.updateSetting("defaultSkills", skills);
  },

  /**
   * Set CLI execution mode
   */
  async setCliExecutionMode(mode: string): Promise<void> {
    await this.updateSetting("cliExecutionMode", mode);
  },

  /**
   * Set whether to resume existing session
   */
  async setResumeExistingSession(enabled: boolean): Promise<void> {
    await this.updateSetting("resumeExistingSession", enabled);
  },

  /**
   * Set whether dynamic queue is enabled
   */
  async setEnableDynamicQueue(enabled: boolean): Promise<void> {
    await this.updateSetting("enableDynamicQueue", enabled);
  },

  /**
   * Set the default workflow template
   */
  async setDefaultWorkflowTemplate(templateId: string): Promise<void> {
    await this.updateSetting("defaultWorkflowTemplate", templateId);
  },

  // ============================================================
  // OUTPUT HISTORY SETTINGS
  // ============================================================

  /**
   * Check if output history saving is enabled
   */
  isSaveOutputHistoryEnabled(): boolean {
    return getConfig().get<boolean>("saveOutputHistory", true)!;
  },

  /**
   * Get the maximum number of history runs to retain per workflow
   */
  getMaxHistoryRuns(): number {
    return getConfig().get<number>("maxHistoryRuns", -1)!;
  },

  /**
   * Check if delete confirmation dialogs should be shown
   * When true (default), shows a modal before destructive delete operations.
   */
  shouldConfirmDeleteOperations(): boolean {
    return getConfig().get<boolean>("confirmDeleteOperations", true);
  },

  /**
   * Set whether to show confirmation dialogs before delete operations
   */
  async setConfirmDeleteOperations(enabled: boolean): Promise<void> {
    await this.updateSetting("confirmDeleteOperations", enabled);
  },

  shouldConfirmResetOperations(): boolean {
    return getConfig().get<boolean>("confirmResetOperations", true);
  },

  async setConfirmResetOperations(enabled: boolean): Promise<void> {
    await this.updateSetting("confirmResetOperations", enabled);
  },
};
