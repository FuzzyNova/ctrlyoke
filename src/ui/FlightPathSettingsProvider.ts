import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { MESSAGE_TYPES, PROVIDER_IDS } from "../types/DashboardConstants";
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
import { Provider } from "../types/FlightPathTypes";
import { Log } from "../utils/Log";
import { AgentDiscovery, AgentInfo } from "../utils/AgentDiscovery";

const execAsync = promisify(exec);

/**
 * Provider availability status
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

  // Provider availability status
  private providerStatus: Record<string, ProviderStatus> = {
    [PROVIDER_IDS.COPILOT_CLI]: { available: false, status: "checking" },
    [PROVIDER_IDS.COPILOT_CHAT]: { available: false, status: "checking" }, // Check for Copilot extension
    [PROVIDER_IDS.CLAUDE_CLI]: { available: false, status: "checking" },
    [PROVIDER_IDS.CODEX_CLI]: { available: false, status: "checking" },
  };

  // Webview path segments (same as dashboard)
  private static readonly WEBVIEW_PATH_SEGMENTS = ["out", "ui", "webview"];

  // Setting keys for each provider's model
  private static readonly MODEL_SETTING_MAP: Record<string, string> = {
    [PROVIDER_IDS.COPILOT_CLI]: "copilotCliModel",
    [PROVIDER_IDS.COPILOT_CHAT]: "copilotChatModel",
    [PROVIDER_IDS.CLAUDE_CLI]: "claudeCliModel",
    [PROVIDER_IDS.CODEX_CLI]: "codexCliModel",
  };

  // Default models per provider
  private static readonly DEFAULT_MODELS: Record<string, string> = {
    [PROVIDER_IDS.COPILOT_CLI]: "claude-sonnet-4.5",
    [PROVIDER_IDS.COPILOT_CHAT]: "claude-sonnet-4.5",
    [PROVIDER_IDS.CLAUDE_CLI]: "sonnet",
    [PROVIDER_IDS.CODEX_CLI]: "gpt-5.1-codex",
  };

  // Reference to dashboard provider for workflow property updates
  private dashboardProvider?: any;

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
      case MESSAGE_TYPES.CHANGE_PROVIDER:
        this.handleProviderChange(message.provider);
        break;
      case MESSAGE_TYPES.CHANGE_MODEL:
        this.handleModelChange(message.model, message.provider);
        break;
      case MESSAGE_TYPES.CHANGE_AGENT:
        this.handleAgentChange(message.agent);
        break;
      case MESSAGE_TYPES.CHANGE_EXECUTION_MODE:
        this.handleExecutionModeChange(message.executionMode);
        break;
      case MESSAGE_TYPES.CHANGE_NEW_CHAT_SESSION:
        this.handleNewChatSessionChange(message.enabled);
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
        this.handleSetAsDefault(message.property, message.value);
        break;
    }
  }

  private sendInitialState(): void {
    if (!this.view) {
      return;
    }

    const provider = ConfigurationUtils.getIntegrationMode();
    const model = this.getModelForProvider(provider);
    const agent = ConfigurationUtils.getCustomAgent();
    const executionMode = ConfigurationUtils.getCliExecutionMode();
    const newChatSessionPerPrompt =
      ConfigurationUtils.shouldStartNewChatSessionPerPrompt();
    const dynamicQueueEnabled =
      ConfigurationUtils.getDynamicQueueConfig().enabled;

    // Global settings (from VS Code)
    const globalSettings = {
      provider,
      model,
      agent,
      executionMode,
      newChatSession: newChatSessionPerPrompt,
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
      type: MESSAGE_TYPES.PROVIDER_STATUS_UPDATE,
      data: { providerStatus: this.providerStatus },
    });
  }

  /**
   * Helper function to check CLI command availability
   * @param providerId The provider ID from PROVIDER_IDS
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
    await this.checkCliAvailability(PROVIDER_IDS.COPILOT_CLI, "copilot");
    await this.checkCliAvailability(PROVIDER_IDS.CLAUDE_CLI, "claude");
    await this.checkCliAvailability(PROVIDER_IDS.CODEX_CLI, "codex");

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
        this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
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
        this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
          available: true,
          status: "available",
          message: "GitHub Copilot Chat",
        };
        Log.info("Copilot Chat available");
      } else {
        this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
          available: false,
          status: "unavailable",
          message: "Copilot Chat commands not available",
        };
        Log.info("Copilot Chat not available - required commands missing");
      }
    } catch (error) {
      this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
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
      [PROVIDER_IDS.COPILOT_CLI]: copilotCliOptions,
      [PROVIDER_IDS.COPILOT_CHAT]: copilotChatOptions,
      [PROVIDER_IDS.CLAUDE_CLI]: claudeCliOptions,
      [PROVIDER_IDS.CODEX_CLI]: codexCliOptions,
    };
  }

  private getModelForProvider(provider: Provider): string {
    // Return the appropriate model based on provider
    switch (provider) {
      case Provider.CopilotCli:
        return ConfigurationUtils.getCliModel();
      case Provider.CopilotChat:
        // Chat model uses same setting as CLI model for now
        return ConfigurationUtils.getCliModel();
      case Provider.ClaudeCli:
        return ConfigurationUtils.getClaudeCliModel();
      case Provider.CodexCli:
        return ConfigurationUtils.getCodexCliModel();
      default:
        return ConfigurationUtils.getCliModel();
    }
  }

  private async handleProviderChange(provider: string): Promise<void> {
    const validProviders: string[] = [
      PROVIDER_IDS.COPILOT_CLI,
      PROVIDER_IDS.COPILOT_CHAT,
      PROVIDER_IDS.CLAUDE_CLI,
      PROVIDER_IDS.CODEX_CLI,
    ];
    if (!validProviders.includes(provider)) {
      Log.error(`Invalid provider: ${provider}`);
      return;
    }

    try {
      await ConfigurationUtils.updateSetting("provider", provider);
      Log.info(`✅ Provider changed to: ${provider}`);
    } catch (error) {
      Log.error("Failed to update provider setting:", error);
    }
  }

  private async handleModelChange(
    model: string,
    provider: string
  ): Promise<void> {
    const settingKey = FlightPathSettingsProvider.MODEL_SETTING_MAP[provider];
    if (!settingKey) {
      Log.error(`Unknown provider for model change: ${provider}`);
      return;
    }

    try {
      await ConfigurationUtils.updateSetting(settingKey, model);
      Log.info(`✅ Model changed to: ${model} (for ${provider})`);
    } catch (error) {
      Log.error("Failed to update model setting:", error);
    }
  }

  private async handleAgentChange(agent: string): Promise<void> {
    // No validation - accept any discovered agent name (or empty string)
    try {
      await ConfigurationUtils.updateSetting("customAgent", agent);
      Log.info(`✅ Custom agent changed to: ${agent || "(none)"}`);
    } catch (error) {
      Log.error("Failed to update custom agent setting:", error);
    }
  }

  private async handleExecutionModeChange(
    executionMode: string
  ): Promise<void> {
    const validModes = ["interactive", "headless"];
    if (!validModes.includes(executionMode)) {
      Log.error(`Invalid execution mode: ${executionMode}`);
      return;
    }

    try {
      await ConfigurationUtils.updateSetting("cliExecutionMode", executionMode);
      Log.info(`✅ Execution mode changed to: ${executionMode}`);
    } catch (error) {
      Log.error("Failed to update cliExecutionMode setting:", error);
    }
  }

  private async handleNewChatSessionChange(enabled: boolean): Promise<void> {
    try {
      await ConfigurationUtils.updateSetting(
        "newChatSessionPerPrompt",
        enabled
      );
      Log.info(
        `✅ New chat session per prompt ${enabled ? "enabled" : "disabled"}`
      );
    } catch (error) {
      Log.error("Failed to update newChatSessionPerPrompt setting:", error);
    }
  }

  private async handleDynamicQueueChange(enabled: boolean): Promise<void> {
    try {
      await ConfigurationUtils.updateSetting("enableDynamicQueue", enabled);
      Log.info(`✅ Dynamic queue ${enabled ? "enabled" : "disabled"}`);
    } catch (error) {
      Log.error("Failed to update enableDynamicQueue setting:", error);
    }
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
   * Forwards property update to Dashboard provider which handles working file saves
   */
  private async handleUpdateWorkflowProperty(
    property: string,
    value: any
  ): Promise<void> {
    // Forward to Dashboard provider for working file updates
    // Dashboard provider has access to FlightPathManager and working file paths
    Log.info(
      `Forwarding workflow property update to Dashboard: ${property} = ${JSON.stringify(value)}`
    );

    if (!this.dashboardProvider) {
      Log.warn("Dashboard provider not set - cannot update workflow property");
      return;
    }

    // Forward the message to Dashboard provider's handleWebviewMessage
    // Dashboard provider has a public method to receive messages
    await (this.dashboardProvider as any).handleWebviewMessage({
      type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
      property,
      value,
    });

    // Dashboard provider will handle the update and send confirmation back
    // via WORKFLOW_PROPERTIES_UPDATE message
  }

  /**
   * Handle "Set as Default" button click
   * Updates VS Code global setting with workflow property value
   */
  private async handleSetAsDefault(
    property: string,
    value: any
  ): Promise<void> {
    try {
      // Map property names to VS Code setting keys
      const settingMap: Record<string, string> = {
        provider: "provider",
        model: this.getModelSettingKey(
          value.provider || ConfigurationUtils.getIntegrationMode()
        ),
        agent: "customAgent",
        newChatSession: "newChatSessionPerPrompt",
        allowDynamicExtension: "enableDynamicQueue",
      };

      const settingKey = settingMap[property];
      if (!settingKey) {
        Log.error(`Unknown property for setAsDefault: ${property}`);
        return;
      }

      await ConfigurationUtils.updateSetting(settingKey, value);
      Log.info(`✅ Set as default: ${property} = ${JSON.stringify(value)}`);

      // Refresh UI to reflect new global setting
      this.sendInitialState();
    } catch (error) {
      Log.error(`Failed to set ${property} as default:`, error);
    }
  }

  /**
   * Get the appropriate model setting key for a given provider
   */
  private getModelSettingKey(provider: string): string {
    return (
      FlightPathSettingsProvider.MODEL_SETTING_MAP[provider] ||
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
  public setDashboardProvider(provider: any): void {
    this.dashboardProvider = provider;
  }
}
