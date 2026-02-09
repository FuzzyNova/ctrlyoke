import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import {
  MESSAGE_TYPES,
  HARNESS_IDS,
  DEFAULT_MODELS,
} from "../types/DashboardConstants";
import {
  getAvailableModelsSync,
  getCliSupportedModelIdsSync,
  onModelsLoaded,
  isRegistryInitialized,
} from "../utils/ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Harness } from "../types/FlightPathTypes";
import { Log } from "../utils/Log";
import { AgentDiscovery, AgentInfo } from "../utils/AgentDiscovery";

const execAsync = promisify(exec);

/**
 * Harness availability status
 */
interface ProviderStatus {
  available: boolean;
  status: "checking" | "available" | "unavailable";
  message?: string;
}

/**
 * FlightPath Settings WebviewViewProvider
 * Manages the Settings panel for provider and model selection.
 */
export class FlightPathSettingsProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private configChangeDisposable?: vscode.Disposable;
  private modelsLoadedDisposable?: vscode.Disposable;

  // Discovered agents
  private availableAgents: AgentInfo[] = [];

  // Harness availability status
  private providerStatus: Record<string, ProviderStatus> = {
    [HARNESS_IDS.COPILOT_CLI]: { available: false, status: "checking" },
    [HARNESS_IDS.COPILOT_CHAT]: { available: false, status: "checking" }, // Check for Copilot extension
    [HARNESS_IDS.CLAUDE_CLI]: { available: false, status: "checking" },
    [HARNESS_IDS.CODEX_CLI]: { available: false, status: "checking" },
  };

  // Webview path segments (same as dashboard)
  private static readonly WEBVIEW_PATH_SEGMENTS = ["out", "ui", "webview"];

  // Setting keys for each provider's model
  private static readonly MODEL_SETTING_MAP: Record<string, string> = {
    [HARNESS_IDS.COPILOT_CLI]: "copilotCliModel",
    [HARNESS_IDS.COPILOT_CHAT]: "copilotChatModel",
    [HARNESS_IDS.CLAUDE_CLI]: "claudeCliModel",
    [HARNESS_IDS.CODEX_CLI]: "codexCliModel",
  };

  // Validation constants
  private static readonly VALID_HARNESSES = [
    HARNESS_IDS.COPILOT_CLI,
    HARNESS_IDS.COPILOT_CHAT,
    HARNESS_IDS.CLAUDE_CLI,
    HARNESS_IDS.CODEX_CLI,
  ] as const;

  private static readonly VALID_EXECUTION_MODES = [
    "interactive",
    "headless",
  ] as const;

  // Reference to dashboard provider for workflow property updates
  private dashboardProvider?: any;

  // Pending workflow properties (set before workflow is created)
  private pendingWorkflowProperties: {
    provider?: string;
    model?: string;
    agent?: string;
    resumeSession?: boolean;
    allowDynamicExtension?: boolean;
    endCondition?: any;
  } = {};

  constructor(private readonly context: vscode.ExtensionContext) {
    // Listen for configuration changes to sync settings view
    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("flightpath")) {
          this.sendInitialState();
        }
      }
    );
    context.subscriptions.push(this.configChangeDisposable);

    // Subscribe to model registry loaded event
    this.modelsLoadedDisposable = onModelsLoaded(() => {
      Log.info("Model registry loaded, refreshing settings view");
      this.sendModelOptionsUpdate();
    });
    context.subscriptions.push(this.modelsLoadedDisposable);

    // Check provider availability in background
    this.checkProviderAvailability();

    // Discover available agents
    this.discoverAgents();
  }

  /**
   * Helper method to update a setting with consistent logging
   * @param key Setting key (without 'flightpath.' prefix)
   * @param value New value
   * @param successMessage Message to log on success
   */
  private async updateSettingWithLogging(
    key: string,
    value: any,
    successMessage: string
  ): Promise<void> {
    try {
      await ConfigurationUtils.updateSetting(key, value);
      Log.info(successMessage);
    } catch (error) {
      Log.error(`Failed to update setting '${key}':`, error);
    }
  }

  /**
   * Get the webview directory path
   */
  private getWebviewPath(...segments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      ...FlightPathSettingsProvider.WEBVIEW_PATH_SEGMENTS,
      ...segments
    );
  }

  /**
   * Get the webview directory filesystem path
   */
  private getWebviewFsPath(...segments: string[]): string {
    return path.join(
      this.context.extensionUri.fsPath,
      ...FlightPathSettingsProvider.WEBVIEW_PATH_SEGMENTS,
      ...segments
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.getWebviewPath()],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message);
    });
  }

  private handleWebviewMessage(message: any): void {
    switch (message.type) {
      case MESSAGE_TYPES.READY:
        this.sendInitialState();
        break;
      case MESSAGE_TYPES.CHANGE_HARNESS:
        this.handleHarnessChange(message.harness);
        break;
      case MESSAGE_TYPES.CHANGE_MODEL:
        this.handleModelChange(message.model, message.harness);
        break;
      case MESSAGE_TYPES.CHANGE_AGENT:
        this.handleAgentChange(message.agent);
        break;
      case MESSAGE_TYPES.CHANGE_EXECUTION_MODE:
        this.handleExecutionModeChange(message.executionMode);
        break;
      case MESSAGE_TYPES.CHANGE_RESUME_SESSION:
        this.handleResumeSessionChange(message.enabled);
        break;
      case MESSAGE_TYPES.CHANGE_DYNAMIC_QUEUE:
        this.handleDynamicQueueChange(message.enabled);
        break;
      case MESSAGE_TYPES.OPEN_SETTINGS:
        this.handleOpenSettings();
        break;
      case MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY:
        this.handleUpdateWorkflowProperty(message.property, message.value);
        break;
      case MESSAGE_TYPES.SET_AS_DEFAULT:
        this.handleSetAsDefault(
          message.property,
          message.value,
          message.harness
        );
        break;
      case MESSAGE_TYPES.GET_CONFIG:
        this.handleGetConfig(message.key);
        break;
      case MESSAGE_TYPES.UPDATE_CONFIG:
        this.handleUpdateConfig(message.key, message.value);
        break;
    }
  }

  private sendInitialState(): void {
    if (!this.view) {
      return;
    }

    const harness = ConfigurationUtils.getIntegrationMode();
    const model = this.getModelForHarness(harness);
    const agent = ConfigurationUtils.getCustomAgent();
    const executionMode = ConfigurationUtils.getCliExecutionMode();
    const resumeExistingSession =
      ConfigurationUtils.shouldResumeExistingSession();
    const dynamicQueueEnabled =
      ConfigurationUtils.getDynamicQueueConfig().enabled;

    // Global settings (from VS Code)
    const globalSettings = {
      harness,
      model,
      agent,
      executionMode,
      resumeSession: resumeExistingSession,
      allowDynamicExtension: dynamicQueueEnabled,
    };

    // Build dynamic model options from ModelRegistry
    const modelOptions = this.buildModelOptions();

    // Include provider status
    const providerStatus = this.providerStatus;

    // Include available agents
    const availableAgents = this.availableAgents;

    // Workflow properties will be sent separately when workflow is loaded
    // Dashboard provider sends WORKFLOW_LOADED message with properties
    const workflowProperties = {};

    this.view.webview.postMessage({
      type: MESSAGE_TYPES.INIT,
      data: {
        globalSettings,
        workflowProperties,
        modelOptions,
        providerStatus,
        availableAgents,
      },
    });
  }

  /**
   * Send updated model options to the webview
   * Called when model registry finishes loading
   */
  private sendModelOptionsUpdate(): void {
    if (!this.view) {
      return;
    }

    const modelOptions = this.buildModelOptions();
    this.view.webview.postMessage({
      type: MESSAGE_TYPES.MODEL_OPTIONS_UPDATE,
      data: { modelOptions },
    });
  }

  /**
   * Send updated provider status to the webview
   */
  private sendProviderStatusUpdate(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
      data: { providerStatus: this.providerStatus },
    });
  }

  /**
   * Helper function to check CLI command availability
   * @param providerId The provider ID from HARNESS_IDS
   * @param command The CLI command to check (e.g., "copilot", "claude", "codex")
   */
  private async checkCliAvailability(
    providerId: string,
    command: string
  ): Promise<void> {
    try {
      const { stdout } = await execAsync(`${command} --version`, {
        timeout: 5000,
      });
      this.providerStatus[providerId] = {
        available: true,
        status: "available",
        message: stdout.trim(),
      };
      Log.info(`${command} CLI available:`, stdout.trim());
    } catch {
      this.providerStatus[providerId] = {
        available: false,
        status: "unavailable",
        message: "Not installed or not in PATH",
      };
      Log.info(`${command} CLI not available`);
    }
  }

  /**
   * Check availability of CLI providers in background
   * Updates providerStatus and notifies webview
   */
  private async checkProviderAvailability(): Promise<void> {
    // Check CLI providers using helper function
    await this.checkCliAvailability(HARNESS_IDS.COPILOT_CLI, "copilot");
    await this.checkCliAvailability(HARNESS_IDS.CLAUDE_CLI, "claude");
    await this.checkCliAvailability(HARNESS_IDS.CODEX_CLI, "codex");

    // Check Copilot Chat extension availability
    await this.checkCopilotChatAvailability();

    // Send update to webview
    this.sendProviderStatusUpdate();
  }

  /**
   * Check if GitHub Copilot Chat extension is available
   * Checks for extension installation and required commands
   */
  private async checkCopilotChatAvailability(): Promise<void> {
    try {
      // Check if GitHub Copilot extensions are installed
      const copilotExtension = vscode.extensions.getExtension("GitHub.copilot");
      const copilotChatExtension = vscode.extensions.getExtension(
        "GitHub.copilot-chat"
      );

      const hasExtension = !!(copilotExtension || copilotChatExtension);

      if (!hasExtension) {
        this.providerStatus[HARNESS_IDS.COPILOT_CHAT] = {
          available: false,
          status: "unavailable",
          message: "GitHub Copilot extension not installed",
        };
        Log.info("Copilot Chat not available - extension not installed");
        return;
      }

      // Check for required chat commands
      const commands = await vscode.commands.getCommands();
      const hasChatSubmit = commands.includes("workbench.action.chat.submit");
      const hasChatPanel = commands.includes(
        "workbench.panel.chat.view.copilot.focus"
      );

      if (hasChatSubmit && hasChatPanel) {
        this.providerStatus[HARNESS_IDS.COPILOT_CHAT] = {
          available: true,
          status: "available",
          message: "GitHub Copilot Chat",
        };
        Log.info("Copilot Chat available");
      } else {
        this.providerStatus[HARNESS_IDS.COPILOT_CHAT] = {
          available: false,
          status: "unavailable",
          message: "Copilot Chat commands not available",
        };
        Log.info("Copilot Chat not available - required commands missing");
      }
    } catch (error) {
      this.providerStatus[HARNESS_IDS.COPILOT_CHAT] = {
        available: false,
        status: "unavailable",
        message: "Error checking Copilot Chat availability",
      };
      Log.error("Error checking Copilot Chat:", error);
    }
  }

  /**
   * Build model options for each provider from ModelRegistry
   * Chat models come from VS Code LM API (full list)
   * CLI models come from `copilot help config` (subset)
   * Claude CLI models are static (no programmatic way to query)
   */
  private buildModelOptions(): Record<
    string,
    Array<{ value: string; label: string }>
  > {
    // Get all chat models (superset - includes models not available in CLI)
    const chatModels = getAvailableModelsSync();

    // Get CLI-supported model IDs
    const cliModelIds = getCliSupportedModelIdsSync();

    // Models to hide from the UI (non-functional or internal)
    const hiddenModels = new Set(["copilot-fast"]);

    // Format chat models for dropdown (filter out hidden models)
    const copilotChatOptions = chatModels
      .filter((m) => !hiddenModels.has(m.id))
      .map((m) => ({
        value: m.id,
        label: getModelDisplayName(m.id),
      }));

    // Format CLI models for dropdown (only CLI-supported ones, filter hidden)
    const copilotCliOptions = cliModelIds
      .filter((id) => !hiddenModels.has(id))
      .map((id) => ({
        value: id,
        label: getModelDisplayName(id),
      }));

    // Claude CLI uses static list with friendly labels from ModelConstants
    const claudeCliOptions = Object.entries(CLAUDE_CLI_MODEL_LABELS).map(
      ([value, label]) => ({ value, label })
    );

    // Codex CLI uses static list with friendly labels from ModelConstants
    const codexCliOptions = Object.entries(CODEX_CLI_MODEL_LABELS).map(
      ([value, label]) => ({ value, label })
    );

    return {
      [HARNESS_IDS.COPILOT_CLI]: copilotCliOptions,
      [HARNESS_IDS.COPILOT_CHAT]: copilotChatOptions,
      [HARNESS_IDS.CLAUDE_CLI]: claudeCliOptions,
      [HARNESS_IDS.CODEX_CLI]: codexCliOptions,
    };
  }

  private getModelForHarness(harness: Harness): string {
    return ConfigurationUtils.getModelForHarness(harness);
  }

  private async handleHarnessChange(harness: string): Promise<void> {
    if (!FlightPathSettingsProvider.VALID_HARNESSES.includes(harness as any)) {
      Log.error(`Invalid harness: ${harness}`);
      return;
    }

    await this.updateSettingWithLogging(
      "harness",
      harness,
      `✅ Harness changed to: ${harness}`
    );
  }

  private async handleModelChange(
    model: string,
    harness: string
  ): Promise<void> {
    const settingKey = FlightPathSettingsProvider.MODEL_SETTING_MAP[harness];
    if (!settingKey) {
      Log.error(`Unknown harness for model change: ${harness}`);
      return;
    }

    await this.updateSettingWithLogging(
      settingKey,
      model,
      `✅ Model changed to: ${model} (for ${harness})`
    );
  }

  private async handleAgentChange(agent: string): Promise<void> {
    // No validation - accept any discovered agent name (or empty string)
    await this.updateSettingWithLogging(
      "customAgent",
      agent,
      `✅ Custom agent changed to: ${agent || "(none)"}`
    );
  }

  private async handleExecutionModeChange(
    executionMode: string
  ): Promise<void> {
    if (
      !FlightPathSettingsProvider.VALID_EXECUTION_MODES.includes(
        executionMode as any
      )
    ) {
      Log.error(`Invalid execution mode: ${executionMode}`);
      return;
    }

    await this.updateSettingWithLogging(
      "cliExecutionMode",
      executionMode,
      `✅ Execution mode changed to: ${executionMode}`
    );
  }

  private async handleResumeSessionChange(enabled: boolean): Promise<void> {
    await this.updateSettingWithLogging(
      "resumeExistingSession",
      enabled,
      `✅ Resume existing session ${enabled ? "enabled" : "disabled"}`
    );
  }

  private async handleDynamicQueueChange(enabled: boolean): Promise<void> {
    await this.updateSettingWithLogging(
      "enableDynamicQueue",
      enabled,
      `✅ Dynamic queue ${enabled ? "enabled" : "disabled"}`
    );
  }

  private handleOpenSettings(): void {
    // Open VS Code settings focused on FlightPath extension
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@flightpath"
    );
    Log.info("📋 Opened VS Code settings for FlightPath");
  }

  /**
   * Handle config value request from webview
   * Sends current config value back to webview
   */
  private handleGetConfig(key: string): void {
    if (!this.view) {
      return;
    }

    // Get value from VS Code configuration
    const value = ConfigurationUtils.getConfigValue<boolean>(key);

    // Send value back to webview
    this.view.webview.postMessage({
      type: MESSAGE_TYPES.CONFIG_VALUE,
      key: key,
      value: value,
    });
  }

  /**
   * Handle config update request from webview
   * Updates VS Code global setting
   */
  private async handleUpdateConfig(key: string, value: any): Promise<void> {
    await this.updateSettingWithLogging(
      key,
      value,
      `✅ Config updated: ${key} = ${JSON.stringify(value)}`
    );
  }

  /**
   * Discover available agents from all supported locations
   * Called on initialization and workspace folder changes
   */
  private async discoverAgents(): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      this.availableAgents =
        await AgentDiscovery.discoverAgents(workspaceFolder);

      Log.info(
        `Discovered ${this.availableAgents.length - 1} custom agents` // -1 for "None" option
      );

      // Send updated agents to webview if it's ready
      if (this.view) {
        this.sendAgentsUpdate();
      }
    } catch (error) {
      Log.error("Error discovering agents:", error);
    }
  }

  /**
   * Send updated agents list to the webview
   */
  private sendAgentsUpdate(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: MESSAGE_TYPES.AGENTS_UPDATE,
      data: { availableAgents: this.availableAgents },
    });
  }

  /**
   * Handle workflow property update from webview
   * Stores in pending properties and forwards to Dashboard provider
   */
  private async handleUpdateWorkflowProperty(
    property: string,
    value: any
  ): Promise<void> {
    // Store in pending properties (will be used when workflow is created)
    if (value === undefined) {
      delete (this.pendingWorkflowProperties as any)[property];
    } else {
      (this.pendingWorkflowProperties as any)[property] = value;
    }

    Log.info(
      `Stored pending workflow property '${property}': ${JSON.stringify(value)}`
    );

    if (!this.dashboardProvider) {
      Log.warn("Dashboard provider not set - cannot update workflow property");
      return;
    }

    // Forward to Dashboard provider for immediate working file update (if workflow loaded)
    // Dashboard provider has access to FlightPathManager and working file paths
    await (this.dashboardProvider as any).handleWebviewMessage({
      type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
      property,
      value,
    });
  }

  /**
   * Get pending workflow properties and clear them
   * Called by Dashboard provider when creating/loading a workflow
   */
  public getPendingPropertiesAndClear(): Record<string, any> {
    const pending = { ...this.pendingWorkflowProperties };
    this.pendingWorkflowProperties = {};
    Log.info(
      `Returning pending properties: ${JSON.stringify(pending)} (cleared)`
    );
    return pending;
  }

  /**
   * Get pending workflow properties without clearing them
   */
  public getPendingProperties(): Record<string, any> {
    return { ...this.pendingWorkflowProperties };
  }

  /**
   * Clear all pending workflow properties
   */
  public clearPendingProperties(): void {
    this.pendingWorkflowProperties = {};
  }

  /**
   * Handle "Set as Default" button click
   * Updates VS Code global setting with workflow property value
   */
  private async handleSetAsDefault(
    property: string,
    value: any,
    provider?: string
  ): Promise<void> {
    // Map property names to VS Code setting keys
    const settingMap: Record<string, string> = {
      harness: "provider",
      model: this.getModelSettingKey(
        provider || ConfigurationUtils.getIntegrationMode()
      ),
      agent: "customAgent",
      resumeSession: "resumeExistingSession",
      allowDynamicExtension: "enableDynamicQueue",
    };

    const settingKey = settingMap[property];
    if (!settingKey) {
      Log.error(`Unknown property for setAsDefault: ${property}`);
      return;
    }

    await this.updateSettingWithLogging(
      settingKey,
      value,
      `✅ Set as default: ${property} = ${JSON.stringify(value)}`
    );

    // Refresh UI to reflect new global setting
    this.sendInitialState();
  }

  /**
   * Get the appropriate model setting key for a given harness
   */
  private getModelSettingKey(harness: string): string {
    return (
      FlightPathSettingsProvider.MODEL_SETTING_MAP[harness] ||
      "copilotCliModel"
    );
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const constantsUri = webview.asWebviewUri(
      this.getWebviewPath("DashboardConstants.js")
    );
    const scriptUri = webview.asWebviewUri(this.getWebviewPath("settings.js"));
    const styleUri = webview.asWebviewUri(this.getWebviewPath("settings.css"));
    const sharedStyleUri = webview.asWebviewUri(
      this.getWebviewPath("shared.css")
    );
    // Get codicon CSS from copied files in webview directory
    const codiconsUri = webview.asWebviewUri(
      this.getWebviewPath("codicons", "codicon.css")
    );

    // Read HTML template and replace placeholders
    const htmlPath = this.getWebviewFsPath("settings.html");

    let html: string;
    try {
      html = fs.readFileSync(htmlPath, "utf8");
    } catch (error) {
      Log.error("Failed to load settings.html template:", error);
      // Fallback to minimal HTML
      return `<!DOCTYPE html>
<html>
<head><title>FlightPath Settings</title></head>
<body><p>Error loading settings template</p></body>
</html>`;
    }

    // Replace template placeholders with actual URIs
    html = html
      .replace(/\{\{constantsUri\}\}/g, constantsUri.toString())
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
      .replace(/\{\{styleUri\}\}/g, styleUri.toString())
      .replace(/\{\{sharedStyleUri\}\}/g, sharedStyleUri.toString())
      .replace(/\{\{codiconsUri\}\}/g, codiconsUri.toString())
      .replace(/\{\{cspSource\}\}/g, webview.cspSource);

    return html;
  }

  /**
   * Post message to settings webview (called from dashboard provider)
   */
  public postMessageToWebview(message: any): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage(message);
  }

  /**
   * Set reference to dashboard provider for bidirectional communication
   */
  public setDashboardProvider(dashboardProvider: any): void {
    this.dashboardProvider = dashboardProvider;
  }
}
