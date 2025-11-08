import * as vscode from "vscode";
import { PromptItem } from "../../types/FlightPathTypes";

/**
 * Copilot initialization status
 */
export enum CopilotStatus {
  Initializing = "initializing",
  Waiting = "waiting",
  Ready = "ready",
  Unavailable = "unavailable",
}

/**
 * Base class for Copilot integrations
 *
 * Provides common functionality and defines the contract that all
 * Copilot integration strategies must implement.
 */
export abstract class CopilotIntegration {
  protected context: vscode.ExtensionContext;
  protected isAvailable: boolean = false;
  protected workflowStep: number = 0;
  protected totalSteps: number = 0;

  // Event emitters for status and response completion
  protected statusChangeEmitter = new vscode.EventEmitter<CopilotStatus>();
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  protected responseCompleteEmitter = new vscode.EventEmitter<string>();
  public readonly onResponseComplete = this.responseCompleteEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Register disposal of event emitters
    context.subscriptions.push(this.statusChangeEmitter);
    context.subscriptions.push(this.responseCompleteEmitter);
  }

  /**
   * Initialize the Copilot integration
   * Must be implemented by subclasses
   */
  abstract initialize(): Promise<void>;

  /**
   * Send a prompt to Copilot
   * Must be implemented by subclasses
   * @param prompt The prompt item to send
   * @param needsCompletionDetection If true, set up completion detection mechanisms (default: true)
   * @returns True if prompt was sent successfully
   */
  abstract sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection?: boolean
  ): Promise<boolean>;

  /**
   * Get the current status of the integration
   * Must be implemented by subclasses
   */
  abstract getStatus(): {
    available: boolean;
    message: string;
    strategy: string;
  };

  /**
   * Check if the integration is available
   * Must be implemented by subclasses
   */
  abstract isIntegrationAvailable(): boolean;

  /**
   * Build prompt text from prompt item
   * Common logic for extracting prompt text (without tool instruction XML)
   */
  protected async buildPromptText(prompt: PromptItem): Promise<string> {
    // User's prompt text is already in final form with all context variables
    return prompt.prompt.trim();
  }

  /**
   * Set workflow progress tracking
   * Called by PromptQueue to update progress information
   */
  setWorkflowProgress(currentStep: number, totalSteps: number): void {
    this.workflowStep = currentStep;
    this.totalSteps = totalSteps;
  }

  /**
   * Update workflow progress status bar message
   */
  protected async updateWorkflowProgress(): Promise<void> {
    if (this.totalSteps > 0) {
      const progress = `${this.workflowStep}/${this.totalSteps}`;
      vscode.window.setStatusBarMessage(
        `$(compass-dot) FlightPath: Step ${progress} completed`,
        3000
      );
    }
  }

  /**
   * Get initialization status
   * Must be implemented by subclasses
   */
  abstract getInitializationStatus(): CopilotStatus;

  /**
   * Check if Copilot is ready for workflows
   * Must be implemented by subclasses
   */
  abstract isReady(): boolean;

  /**
   * Get detailed status (optional - can be overridden by subclasses)
   * Default implementation returns basic information
   */
  getDetailedStatus(): {
    initializationStatus: CopilotStatus;
    isReady: boolean;
    message: string;
    pollingAttempts?: number;
    maxPollingAttempts?: number;
  } {
    const status = this.getInitializationStatus();
    let message = "";

    switch (status) {
      case CopilotStatus.Initializing:
        message = "🔍 Initializing Copilot integration...";
        break;
      case CopilotStatus.Waiting:
        message = "⏳ Waiting for Copilot...";
        break;
      case CopilotStatus.Ready:
        message = "✅ Copilot ready";
        break;
      case CopilotStatus.Unavailable:
        message = "❌ Copilot unavailable";
        break;
    }

    return {
      initializationStatus: status,
      isReady: this.isReady(),
      message,
    };
  }
}
