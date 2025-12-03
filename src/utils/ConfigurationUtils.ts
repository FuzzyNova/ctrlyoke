import * as vscode from "vscode";
import { DynamicQueueConfig, Provider } from "../types/FlightPathTypes";

/**
 * Configuration namespace for FlightPath settings
 */
const CONFIG_NAMESPACE = "flightpath";

/**
 * Get the FlightPath configuration object
 */
function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
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
   * Check if prompt files should open in the second editor group
   */
  shouldOpenPromptsInSecondGroup(): boolean {
    return getConfig().get<boolean>("openPromptsInSecondGroup", false);
  },

  /**
   * Get the default Copilot integration mode from settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI)
   */
  getIntegrationMode(): Provider {
    const mode = getConfig().get<string>("provider", Provider.CopilotCli);

    switch (mode) {
      case "copilot-chat":
      case Provider.CopilotChat:
        return Provider.CopilotChat;
      case "claude-cli":
      case Provider.ClaudeCli:
        return Provider.ClaudeCli;
      case "copilot-cli":
      case Provider.CopilotCli:
      default:
        return Provider.CopilotCli;
    }
  },

  /**
   * Get dynamic queue configuration from settings
   */
  getDynamicQueueConfig(): DynamicQueueConfig {
    const config = getConfig();

    return {
      enabled: config.get<boolean>("enableDynamicQueue", false),
      dynamicExtensionOnLastPrompt: config.get<boolean>(
        "dynamicExtensionOnLastPrompt",
        true
      ),
      maxQueueSize: config.get<number>("maxQueueSize", 100),
      maxExecutionTime: config.get<number>("maxExecutionTime", 18000),
      unlimitedMode: config.get<boolean>("unlimitedMode", false),
      notifyOnExtension: config.get<boolean>("notifyOnQueueExtension", true),
    };
  },

  /**
   * Get the prompts directory path
   */
  getPromptsDirectory(): string {
    return getConfig().get<string>("promptsDirectory", ".flightpath");
  },

  /**
   * Get the script timeout in milliseconds
   */
  getScriptTimeout(): number {
    return getConfig().get<number>("scriptTimeout", 30000);
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
   * Check if files should be auto-attached
   */
  shouldAutoAttachFiles(): boolean {
    return getConfig().get<boolean>("autoAttachFiles", true);
  },

  /**
   * Get the default CLI model
   */
  getCliModel(): string {
    return getConfig().get<string>("copilotCliModel", "claude-sonnet-4.5");
  },

  /**
   * Get allowed directories for CLI operations
   */
  getCliAllowedDirs(): string[] {
    return getConfig().get<string[]>("copilotCliAllowedDirs", []);
  },

  /**
   * Get CLI tool permissions mode
   */
  getCliToolPermissions(): "allowAll" | "custom" {
    return getConfig().get<"allowAll" | "custom">(
      "copilotCliToolPermissions",
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
    return getConfig().get<string>("cliExecutionMode", "interactive");
  },

  /**
   * Get Copilot CLI log directory
   */
  getCopilotCliLogDir(): string {
    return getConfig().get<string>("copilotCliLogDir", "");
  },

  /**
   * Get Copilot CLI log level
   */
  getCopilotCliLogLevel(): string {
    return getConfig().get<string>("copilotCliLogLevel", "default");
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

  /**
   * Get Claude CLI tool permissions mode
   */
  getClaudeCliToolPermissions(): "skipAll" | "custom" {
    return getConfig().get<"skipAll" | "custom">(
      "claudeCliToolPermissions",
      "skipAll"
    );
  },

  /**
   * Get Claude CLI output format
   */
  getClaudeCliOutputFormat(): "json" | "text" {
    return getConfig().get<"json" | "text">("claudeCliOutputFormat", "json");
  },

  // ============================================================
  // SHARED CLI TOOL SETTINGS
  // ============================================================

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
   * Check if new chat session should be started per prompt
   */
  shouldStartNewChatSessionPerPrompt(): boolean {
    return getConfig().get<boolean>("newChatSessionPerPrompt", true);
  },

  /**
   * Get workflows directory path
   */
  getWorkflowsDirectory(): string {
    return getConfig().get<string>(
      "workflowsDirectory",
      ".flightpath/workflows"
    );
  },

  /**
   * Get default workflow template ID
   */
  getDefaultWorkflowTemplate(): string {
    return getConfig().get<string>("defaultWorkflowTemplate", "blank");
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
   * Check if agent mode should be forced for chat
   */
  shouldForceAgentModeForChat(): boolean {
    return getConfig().get<boolean>("forceAgentModeForChat", false);
  },

  /**
   * Check if native attachments should be used for chat mode
   */
  shouldUseChatNativeAttachments(): boolean {
    return getConfig().get<boolean>("chatUseNativeAttachments", true);
  },

  // ============================================================
  // SETTINGS UPDATE HELPERS
  // ============================================================

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
};
