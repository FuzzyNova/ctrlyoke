import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import {
  getAvailableModelsSync,
  getCliSupportedModelIdsSync,
  onModelsLoaded,
  isRegistryInitialized,
} from "../utils/ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";

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

  // Provider availability status
  private providerStatus: Record<string, ProviderStatus> = {
    "copilot-cli": { available: false, status: "checking" },
    "copilot-chat": { available: false, status: "checking" }, // Check for Copilot extension
    "claude-cli": { available: false, status: "checking" },
  };

  // Webview path segments (same as dashboard)
  private static readonly WEBVIEW_PATH_SEGMENTS = ["out", "ui", "webview"];

  // Setting keys for each provider's model
  private static readonly MODEL_SETTING_MAP: Record<string, string> = {
    "copilot-cli": "copilotCliModel",
    "copilot-chat": "copilotChatModel",
    "claude-cli": "claudeCliModel",
  };

  // Default models per provider
  private static readonly DEFAULT_MODELS: Record<string, string> = {
    "copilot-cli": "claude-sonnet-4.5",
    "copilot-chat": "claude-sonnet-4.5",
    "claude-cli": "sonnet",
  };

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
      console.log(
        "FlightPath: Model registry loaded, refreshing settings view"
      );
      this.sendModelOptionsUpdate();
    });
    context.subscriptions.push(this.modelsLoadedDisposable);

    // Check provider availability in background
    this.checkProviderAvailability();
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
      case MESSAGE_TYPES.CHANGE_DYNAMIC_QUEUE:
        this.handleDynamicQueueChange(message.enabled);
        break;
    }
  }

  private sendInitialState(): void {
    if (!this.view) {
      return;
    }

    const config = vscode.workspace.getConfiguration("flightpath");
    const provider = config.get<string>("provider", "copilot-cli");
    const model = this.getModelForProvider(provider);
    const dynamicQueueEnabled = config.get<boolean>(
      "enableDynamicQueue",
      false
    );

    // Build dynamic model options from ModelRegistry
    const modelOptions = this.buildModelOptions();

    // Include provider status
    const providerStatus = this.providerStatus;

    this.view.webview.postMessage({
      type: MESSAGE_TYPES.INIT,
      data: {
        provider,
        model,
        dynamicQueueEnabled,
        modelOptions,
        providerStatus,
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
   * Check availability of CLI providers in background
   * Updates providerStatus and notifies webview
   */
  private async checkProviderAvailability(): Promise<void> {
    // Check Copilot CLI
    try {
      const { stdout } = await execAsync("copilot --version", {
        timeout: 5000,
      });
      this.providerStatus["copilot-cli"] = {
        available: true,
        status: "available",
        message: stdout.trim(),
      };
      console.log("FlightPath: Copilot CLI available:", stdout.trim());
    } catch {
      this.providerStatus["copilot-cli"] = {
        available: false,
        status: "unavailable",
        message: "Not installed or not in PATH",
      };
      console.log("FlightPath: Copilot CLI not available");
    }

    // Check Claude CLI
    try {
      const { stdout } = await execAsync("claude --version", { timeout: 5000 });
      this.providerStatus["claude-cli"] = {
        available: true,
        status: "available",
        message: stdout.trim(),
      };
      console.log("FlightPath: Claude CLI available:", stdout.trim());
    } catch {
      this.providerStatus["claude-cli"] = {
        available: false,
        status: "unavailable",
        message: "Not installed or not in PATH",
      };
      console.log("FlightPath: Claude CLI not available");
    }

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
        this.providerStatus["copilot-chat"] = {
          available: false,
          status: "unavailable",
          message: "GitHub Copilot extension not installed",
        };
        console.log(
          "FlightPath: Copilot Chat not available - extension not installed"
        );
        return;
      }

      // Check for required chat commands
      const commands = await vscode.commands.getCommands();
      const hasChatSubmit = commands.includes("workbench.action.chat.submit");
      const hasChatPanel = commands.includes(
        "workbench.panel.chat.view.copilot.focus"
      );

      if (hasChatSubmit && hasChatPanel) {
        this.providerStatus["copilot-chat"] = {
          available: true,
          status: "available",
          message: "GitHub Copilot Chat",
        };
        console.log("FlightPath: Copilot Chat available");
      } else {
        this.providerStatus["copilot-chat"] = {
          available: false,
          status: "unavailable",
          message: "Copilot Chat commands not available",
        };
        console.log(
          "FlightPath: Copilot Chat not available - required commands missing"
        );
      }
    } catch (error) {
      this.providerStatus["copilot-chat"] = {
        available: false,
        status: "unavailable",
        message: "Error checking Copilot Chat availability",
      };
      console.error("FlightPath: Error checking Copilot Chat:", error);
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

    return {
      "copilot-cli": copilotCliOptions,
      "copilot-chat": copilotChatOptions,
      "claude-cli": claudeCliOptions,
    };
  }

  private getModelForProvider(provider: string): string {
    const config = vscode.workspace.getConfiguration("flightpath");
    const settingKey =
      FlightPathSettingsProvider.MODEL_SETTING_MAP[provider] ||
      "copilotCliModel";
    const defaultModel =
      FlightPathSettingsProvider.DEFAULT_MODELS[provider] ||
      "claude-sonnet-4.5";
    return config.get<string>(settingKey, defaultModel);
  }

  private async handleProviderChange(provider: string): Promise<void> {
    const validProviders = ["copilot-cli", "copilot-chat", "claude-cli"];
    if (!validProviders.includes(provider)) {
      console.error(`Invalid provider: ${provider}`);
      return;
    }

    try {
      await vscode.workspace
        .getConfiguration("flightpath")
        .update("provider", provider, vscode.ConfigurationTarget.Global);
      console.log(`✅ Provider changed to: ${provider}`);
    } catch (error) {
      console.error("Failed to update provider setting:", error);
    }
  }

  private async handleModelChange(
    model: string,
    provider: string
  ): Promise<void> {
    const settingKey = FlightPathSettingsProvider.MODEL_SETTING_MAP[provider];
    if (!settingKey) {
      console.error(`Unknown provider for model change: ${provider}`);
      return;
    }

    try {
      await vscode.workspace
        .getConfiguration("flightpath")
        .update(settingKey, model, vscode.ConfigurationTarget.Global);
      console.log(`✅ Model changed to: ${model} (for ${provider})`);
    } catch (error) {
      console.error("Failed to update model setting:", error);
    }
  }

  private async handleDynamicQueueChange(enabled: boolean): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration("flightpath")
        .update(
          "enableDynamicQueue",
          enabled,
          vscode.ConfigurationTarget.Global
        );
      console.log(`✅ Dynamic queue ${enabled ? "enabled" : "disabled"}`);
    } catch (error) {
      console.error("Failed to update enableDynamicQueue setting:", error);
    }
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const constantsUri = webview.asWebviewUri(
      this.getWebviewPath("DashboardConstants.js")
    );
    const scriptUri = webview.asWebviewUri(this.getWebviewPath("settings.js"));
    const styleUri = webview.asWebviewUri(this.getWebviewPath("settings.css"));

    // Read HTML template and replace placeholders
    const htmlPath = this.getWebviewFsPath("settings.html");

    let html: string;
    try {
      html = fs.readFileSync(htmlPath, "utf8");
    } catch (error) {
      console.error("Failed to load settings.html template:", error);
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
      .replace(/\{\{cspSource\}\}/g, webview.cspSource);

    return html;
  }
}
