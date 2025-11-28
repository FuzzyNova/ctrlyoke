import * as vscode from "vscode";
import {
  DynamicQueueConfig,
  CopilotIntegrationMode,
} from "../types/FlightPathTypes";

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
   * Get the default Copilot integration mode from settings
   * Supports: cli (Copilot CLI), chat (Copilot Chat), claude-cli (Claude Code CLI)
   */
  getIntegrationMode(): CopilotIntegrationMode {
    const mode = getConfig().get<string>(
      "copilotIntegrationMode",
      CopilotIntegrationMode.CLI
    );

    switch (mode) {
      case "chat":
      case CopilotIntegrationMode.Chat:
        return CopilotIntegrationMode.Chat;
      case "claude-cli":
      case CopilotIntegrationMode.ClaudeCli:
        return CopilotIntegrationMode.ClaudeCli;
      case "cli":
      case CopilotIntegrationMode.CLI:
      default:
        return CopilotIntegrationMode.CLI;
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
};
