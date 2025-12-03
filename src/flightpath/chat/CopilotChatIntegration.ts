import * as vscode from "vscode";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import { isModelAvailable } from "../../utils/ModelRegistry";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { ChatLogMonitor } from "./ChatLogMonitor";
import { NativeAttachmentHandler } from "./NativeAttachmentHandler";

/**
 * GitHub Copilot Chat Integration - UI automation with log-based response detection.
 * See flightpath-chat.instructions.md for implementation details.
 */
export class CopilotChatIntegration extends CopilotIntegration {
  // Background polling state
  private initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  private pollingAttempts: number = 0;
  private readonly maxPollingAttempts: number = 6;
  private readonly pollingInterval: number = 5000;
  private pollingTimer: NodeJS.Timeout | undefined;

  // Extracted components
  private logMonitor: ChatLogMonitor;
  private attachmentHandler: NativeAttachmentHandler;

  // Track if last failure was due to user cancellation in chat UI
  private lastFailureWasUserCancellation: boolean = false;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.logMonitor = new ChatLogMonitor(context);
    this.attachmentHandler = new NativeAttachmentHandler((path) =>
      this.resolveWorkspacePath(path)
    );
    this.initialize();
  }

  /** Get the VS Code command for opening Copilot Chat based on user settings */
  private getChatWindowCommand(): string {
    const chatLocation = ConfigurationUtils.getChatWindowLocation();

    const commandMap: Record<string, string> = {
      chatPanel: "workbench.panel.chat.view.copilot.focus",
      newTab: "workbench.action.chat.openInEditor",
      newWindow: "workbench.action.chat.openInNewWindow",
    };

    return commandMap[chatLocation] || commandMap["chatPanel"];
  }

  /** Start a new chat session. Mode/agent inherited from previous session. */
  private async startNewChatSession(): Promise<void> {
    const chatLocation = ConfigurationUtils.getChatWindowLocation();

    const commandMap: Record<string, string> = {
      chatPanel: "workbench.action.chat.newChatInSideBar",
      newTab: "workbench.action.chat.newChat",
      newWindow: "workbench.action.chat.newChatInNewWindow",
    };

    const command = commandMap[chatLocation] || commandMap["chatPanel"];

    try {
      await vscode.commands.executeCommand(command);
      console.log(`✨ New chat session: ${chatLocation}`);
    } catch (error) {
      console.error("❌ Failed to start new chat:", error);
      // Don't throw - we'll still try to send the prompt to existing chat
    }
  }

  /** Switch to agent mode (required for file editing, overrides custom agents) */
  private async ensureAgentMode(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.openagent");
      console.log("🤖 Agent mode enabled");
      // Small delay to allow mode switch
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      console.warn("⚠️ Could not switch to agent mode:", error);
      // Don't throw - user may have manually selected agent mode
    }
  }

  /** Get the default model from settings */
  private getDefaultModel(): string {
    return ConfigurationUtils.getCopilotChatModel();
  }

  /** Switch chat model - always switches to ensure consistency with CLI modes */
  private async switchModelIfNeeded(model?: string): Promise<void> {
    // Use prompt model if specified, otherwise use setting default
    const targetModel = model || this.getDefaultModel();

    // Validate model is available (using dynamically discovered models)
    if (!isModelAvailable(targetModel)) {
      const message = `Model "${targetModel}" not recognized. Using current chat model.`;
      console.warn(`⚠️ ${message}`);
      vscode.window.showWarningMessage(`FlightPath: ${message}`);
      return;
    }

    try {
      // Query available models to get correct family for this ID
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      const modelInfo = models.find((m) => m.id === targetModel);

      if (!modelInfo) {
        throw new Error(`Model "${targetModel}" not found in available models`);
      }

      // Execute model change command with correct family from Language Model API
      // Note: family may differ from id (e.g., "oswe-vscode-secondary" has family "gpt-5-mini")
      await vscode.commands.executeCommand(
        "workbench.action.chat.changeModel",
        modelInfo
      );

      // Wait for model switch to complete (300ms proven reliable in testing)
      await new Promise((resolve) => setTimeout(resolve, 300));

      console.log(`✅ Model: ${targetModel}`);
    } catch (error) {
      console.error(`❌ Model switch failed (${targetModel}):`, error);
      vscode.window.showWarningMessage(
        `FlightPath: Could not switch to model "${targetModel}". ` +
          `This model may not be available on your subscription. ` +
          `Using current model instead. You can change the default in Settings.`
      );
    }
  }

  /** Initialize with background polling (5s intervals, 30s max) */
  async initialize(): Promise<void> {
    await this.startBackgroundPolling();
  }

  /** Check Copilot availability; optionally activate extensions if installed */
  private async checkCopilotAvailability(
    activateIfNeeded: boolean = false
  ): Promise<void> {
    try {
      // Check if GitHub Copilot extension is installed and active
      let copilotExtension = vscode.extensions.getExtension("GitHub.copilot");
      let copilotChatExtension = vscode.extensions.getExtension(
        "GitHub.copilot-chat"
      );

      // Try to activate extensions if they're installed but not active
      if (activateIfNeeded) {
        if (copilotChatExtension && !copilotChatExtension.isActive) {
          try {
            await copilotChatExtension.activate();
          } catch (activationError) {
            console.warn(
              "⚠️ Could not activate Copilot Chat:",
              activationError
            );
          }
        }

        if (copilotExtension && !copilotExtension.isActive) {
          try {
            await copilotExtension.activate();
          } catch (activationError) {
            console.warn("⚠️ Could not activate Copilot:", activationError);
          }
        }

        // Re-fetch extension references after activation attempts
        copilotExtension = vscode.extensions.getExtension("GitHub.copilot");
        copilotChatExtension = vscode.extensions.getExtension(
          "GitHub.copilot-chat"
        );
      }

      const hasCopilot = !!(
        copilotExtension?.isActive || copilotChatExtension?.isActive
      );

      if (!hasCopilot) {
        this.isAvailable = false;
        return;
      }

      // Check for required automation commands
      const commands = await vscode.commands.getCommands();

      const hasTypeCommand = commands.includes("type");
      const hasChatSubmit = commands.includes("workbench.action.chat.submit");
      const hasChatPanel = commands.includes(
        "workbench.panel.chat.view.copilot.focus"
      );
      const hasChatTab = commands.includes(
        "workbench.action.chat.openInEditor"
      );
      const hasChatWindow = commands.includes(
        "workbench.action.chat.openInNewWindow"
      );
      const hasSelectAll = commands.includes("editor.action.selectAll");

      // At least one chat opening method must be available
      const hasChatOpenCommand = hasChatPanel || hasChatTab || hasChatWindow;

      this.isAvailable =
        hasTypeCommand && hasChatSubmit && hasChatOpenCommand && hasSelectAll;

      if (this.isAvailable) {
        console.log("✅ Chat automation ready");
      } else {
        console.error("❌ Required commands unavailable");
      }
    } catch (error) {
      console.error("❌ Error checking Copilot availability:", error);
      this.isAvailable = false;
    }
  }

  /** Start background polling for Copilot availability */
  private async startBackgroundPolling(): Promise<void> {
    this.pollingAttempts = 0;
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    // Clear any existing polling timer
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
    }

    await this.pollCopilotAvailability();
  }

  /** Poll Copilot availability (first check passive, then try activation) */
  private async pollCopilotAvailability(): Promise<void> {
    this.pollingAttempts++;

    // Strategy: First check is passive, second check onwards we try activation
    const shouldActivate = this.pollingAttempts >= 2;
    await this.checkCopilotAvailability(shouldActivate);

    if (this.isAvailable) {
      console.log("✅ Copilot ready");

      // Initialize log monitor for completion detection
      await this.logMonitor.initialize();

      this.initializationStatus = CopilotStatus.Ready;
      this.statusChangeEmitter.fire(CopilotStatus.Ready);

      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = undefined;
      }
      return;
    }

    if (this.pollingAttempts >= this.maxPollingAttempts) {
      console.error("❌ Copilot unavailable (30s timeout)");
      this.initializationStatus = CopilotStatus.Unavailable;
      this.statusChangeEmitter.fire(CopilotStatus.Unavailable);

      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = undefined;
      }
      return;
    }

    // Continue polling
    this.initializationStatus = CopilotStatus.Waiting;
    this.statusChangeEmitter.fire(CopilotStatus.Waiting);

    this.pollingTimer = setTimeout(() => {
      this.pollCopilotAvailability();
    }, this.pollingInterval);
  }

  /** Manually retry Copilot detection */
  async retryDetection(): Promise<void> {
    vscode.window.showInformationMessage(
      "FlightPath: Retrying Copilot detection..."
    );
    await this.startBackgroundPolling();
  }

  /** Send prompt via direct automation. See flightpath-chat.instructions.md for timing. */
  async sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection?: boolean,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    try {
      // Reset cancellation flag for new prompt
      this.resetCancellationFlag();

      // Verify automation is still available
      if (!this.isAvailable) {
        console.error("❌ Automation became unavailable");
        vscode.window.showErrorMessage(
          "FlightPath: Automation became unavailable"
        );
        return false;
      }

      // Start new chat session if requested
      // When newChatSession is true (default from user setting), start fresh session
      // When newChatSession is false, continue in existing chat session for context continuity
      // Note: Retries should always use the same chat session (handled by retry logic setting newChatSession=false)
      if (prompt.newChatSession === true) {
        await this.startNewChatSession();
      }

      // Ensure we're in agent mode if user has enabled force agent mode setting
      // This prevents issues with Ask/Plan modes but overrides custom agents
      const forceAgentMode = ConfigurationUtils.shouldForceAgentModeForChat();
      if (forceAgentMode) {
        await this.ensureAgentMode();
      }

      // Switch model if specified in prompt
      await this.switchModelIfNeeded(prompt.model);

      // Determine if completion detection is needed:
      // - If explicitly provided, use that value
      // - Otherwise, check if prompt has endCondition with script (requires completion detection)
      const shouldDetectCompletion =
        needsCompletionDetection !== undefined
          ? needsCompletionDetection
          : !!prompt.endCondition?.script;

      // Build prompt with Copilot Chat syntax
      const chatPrompt = await this.buildCopilotChatPrompt(
        prompt,
        workflowContext
      );

      // Record log position before sending
      await this.logMonitor.recordPositionBeforeSend();

      // Execute direct automation
      // Pass whether this is a new chat session for submit verification logic
      const sent = await this.sendPromptWithDirectAutomation(
        chatPrompt,
        prompt.newChatSession === true
      );

      if (!sent) {
        return false;
      }

      // Wait for completion using log monitoring (if needed)
      if (shouldDetectCompletion) {
        const inactivityTimeoutMs =
          ConfigurationUtils.getChatInactivityTimeoutMs();
        const result = await this.logMonitor.waitForCompletion(
          () => this.isCancelling,
          inactivityTimeoutMs
        );

        if (result.userCancelled) {
          console.log("⚠️ User cancelled - stopping workflow");
          this.lastFailureWasUserCancellation = true;
          return false;
        }

        if (!result.completed) {
          // Check if this was an inactivity timeout that should be treated as success
          const isInactivityTimeout =
            result.failureReason?.includes("inactivity timeout");
          const treatTimeoutAsSuccess =
            ConfigurationUtils.shouldTreatChatTimeoutAsSuccess();

          if (isInactivityTimeout && treatTimeoutAsSuccess) {
            console.warn(
              "⚠️ Inactivity timeout - treating as successful completion (treatChatTimeoutAsSuccess=true)"
            );
            // Proceed as if completed - get chat content and fire event
            const responseText = await this.getChatContent(chatPrompt);
            this.responseCompleteEmitter.fire(responseText);
            return true;
          }

          console.error("❌ Completion detection failed");
          if (result.failureReason) {
            this.lastFailureReason = result.failureReason;
          }
          return false;
        }

        // Get chat content and fire event
        const responseText = await this.getChatContent(chatPrompt);
        this.responseCompleteEmitter.fire(responseText);
      }

      return true;
    } catch (error) {
      console.error("❌ Failed to send prompt:", error);
      if (!this.lastFailureReason) {
        this.lastFailureReason =
          error instanceof Error
            ? error.message
            : "Failed to send prompt to Copilot";
      }
      vscode.window.showErrorMessage(
        `FlightPath: Failed to send prompt: ${error}`
      );
      return false;
    }
  }

  /** Copy chat and extract latest response (preserves original clipboard) */
  private async getChatContent(lastPromptText?: string): Promise<string> {
    try {
      // Cache user's original clipboard content
      const originalClipboard = await vscode.env.clipboard.readText();

      // Execute copyAll command
      await vscode.commands.executeCommand("workbench.action.chat.copyAll");

      // Small delay to ensure clipboard is updated
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Read chat content
      const chatContent = await vscode.env.clipboard.readText();

      // Restore user's original clipboard content
      await vscode.env.clipboard.writeText(originalClipboard);

      // If we have the prompt text, extract only the response after it
      if (lastPromptText) {
        // Find the last occurrence of our prompt in the chat
        // Use a significant portion of the prompt for reliable matching
        const searchText = lastPromptText.trim().substring(0, 200);
        const lastPromptIndex = chatContent.lastIndexOf(searchText);

        if (lastPromptIndex !== -1) {
          // Find where the prompt ends (search for end of that line/section)
          // The response typically starts after a newline following the prompt
          const afterPromptStart = lastPromptIndex + searchText.length;
          const responseText = chatContent.substring(afterPromptStart).trim();

          console.log(`📋 Response: ${responseText.length} chars`);
          return responseText;
        } else {
          console.warn("⚠️ Prompt not found in chat, returning full content");
        }
      }

      return chatContent;
    } catch (error) {
      console.error("❌ Failed to copy chat to clipboard:", error);
      return "";
    }
  }

  /** Submit with exponential backoff retry (500ms-5s) and verification */
  private async submitWithRetry(
    promptText: string,
    maxAttempts: number = 5,
    isNewChatSession: boolean = true
  ): Promise<boolean> {
    let attempt = 0;
    const delays = [500, 1000, 2000, 3000, 5000]; // Exponential backoff pattern

    // Get chat content BEFORE submitting (to verify it changes)
    // If this is a new chat session, assume empty (the new chat command always works)
    // If reusing existing chat, get actual content
    let chatBeforeSubmit = "";
    if (!isNewChatSession) {
      chatBeforeSubmit = await this.getChatContent();
    }

    while (attempt < maxAttempts) {
      attempt++;

      if (this.isCancelling) {
        console.log("⏹️ Cancelled");
        return false;
      }

      try {
        // Execute submit command
        await vscode.commands.executeCommand("workbench.action.chat.submit");

        // Wait for UI to process and chat to update
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify submit worked by checking if our prompt appears in chat
        const chatAfterSubmit = await this.getChatContent();

        // Extract a unique portion of the prompt for verification (first 100 chars)
        // Normalize whitespace for comparison (replace multiple spaces/newlines with single space)
        const promptToVerify = promptText
          .trim()
          .substring(0, 100)
          .replace(/\s+/g, " "); // Normalize whitespace for comparison

        // Normalize chat content for comparison
        const normalizedChat = chatAfterSubmit.replace(/\s+/g, " ");

        // Check if chat grew AND prompt appears in chat
        // Size check handles duplicate prompts (primary signal), prompt presence is safety validation
        const chatGrew = chatAfterSubmit.length > chatBeforeSubmit.length;
        const promptFound = normalizedChat.includes(promptToVerify);

        if (chatGrew && promptFound) {
          return true;
        }
      } catch (error) {
        console.warn(
          "⚠️ Submit attempt failed:",
          error instanceof Error ? error.message : String(error)
        );
      }

      // If we have attempts left, wait and retry
      if (attempt < maxAttempts) {
        const delayIndex = Math.min(attempt - 1, delays.length - 1);
        const delay = delays[delayIndex];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    console.error(`❌ Submit failed after ${maxAttempts} attempts`);
    return false;
  }

  /** Execute direct automation: focus, clear, type, submit. Timing validated. */
  private async sendPromptWithDirectAutomation(
    chatPrompt: string,
    isNewChatSession: boolean = true
  ): Promise<boolean> {
    try {
      // Step 1: Open/Focus Copilot Chat using configured location
      const chatCommand = this.getChatWindowCommand();
      try {
        await vscode.commands.executeCommand(chatCommand);
      } catch (focusError) {
        console.error("❌ Could not open Copilot Chat:", focusError);
        throw new Error(`Failed to open Copilot Chat: ${focusError}`);
      }

      // Use longer delay for newWindow and newTab as they may need more setup time
      const chatLocation = ConfigurationUtils.getChatWindowLocation();
      const focusDelay = chatLocation === "chatPanel" ? 1000 : 1500;

      await new Promise((resolve) => setTimeout(resolve, focusDelay));

      // Step 2: Clear any existing input
      try {
        await vscode.commands.executeCommand("editor.action.selectAll");
      } catch (selectError) {
        console.error("❌ Could not select all text:", selectError);
        throw new Error(`Failed to select all: ${selectError}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 300)); // PROVEN: 300ms required

      // Step 3: Type the prompt directly into chat input
      try {
        await vscode.commands.executeCommand("type", { text: chatPrompt });
      } catch (typeError) {
        console.error("❌ Could not type text:", typeError);
        throw new Error(`Failed to type text: ${typeError}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500)); // PROVEN: 500ms required

      // Step 4: Submit with retry logic (handles race condition)
      const submitSuccess = await this.submitWithRetry(
        chatPrompt,
        10,
        isNewChatSession
      );

      if (!submitSuccess) {
        throw new Error(
          "Failed to submit message after multiple retries - Copilot is still responding"
        );
      }

      // Update workflow progress
      await this.updateWorkflowProgress();

      return true;
    } catch (error) {
      console.error("❌ Direct automation failed:", error);

      // Set specific failure reason
      this.lastFailureReason =
        error instanceof Error
          ? error.message
          : "Failed to send message to Copilot Chat";

      vscode.window
        .showErrorMessage(
          `FlightPath: Automation failed: ${error}. Check that Copilot Chat is open and responsive.`,
          "Show Output Log"
        )
        .then((action) => {
          if (action === "Show Output Log") {
            vscode.commands.executeCommand(
              "workbench.action.output.toggleOutput"
            );
          }
        });

      return false;
    }
  }

  /** Override to use native VS Code attachments when enabled */
  protected async buildPromptText(prompt: PromptItem): Promise<string> {
    // Check if auto-attachment is enabled
    const autoAttach = ConfigurationUtils.shouldAutoAttachFiles();

    // Check if native attachments are enabled for chat mode
    const useNativeAttachments =
      ConfigurationUtils.shouldUseChatNativeAttachments();

    if (!autoAttach) {
      return prompt.prompt.trim();
    }

    if (useNativeAttachments) {
      return await this.attachmentHandler.processAttachments(prompt.prompt);
    } else {
      return await super.buildPromptText(prompt);
    }
  }

  /** Build final prompt with dynamic queue instructions if applicable */
  private async buildCopilotChatPrompt(
    prompt: PromptItem,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<string> {
    const promptText = workflowContext
      ? await this.buildPromptWithInstructions(
          prompt,
          workflowContext.promptIndex,
          workflowContext.allPrompts,
          workflowContext.filePath
        )
      : await this.buildPromptText(prompt);

    return promptText.trim();
  }

  /** Get integration status */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message:
          "✅ Direct automation available (PROVEN zero-interaction strategy)",
        strategy: Provider.CopilotChat,
      };
    } else {
      return {
        available: false,
        message:
          "❌ Direct automation unavailable - required commands not found",
        strategy: Provider.CopilotChat,
      };
    }
  }

  /** Check if Copilot integration is available */
  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  /** Get initialization status */
  getInitializationStatus(): CopilotStatus {
    return this.initializationStatus;
  }

  /** Check if Copilot is ready for workflows */
  isReady(): boolean {
    return this.initializationStatus === CopilotStatus.Ready;
  }

  /** Get detailed status with initialization state */
  getDetailedStatus(): {
    initializationStatus: CopilotStatus;
    isReady: boolean;
    message: string;
    pollingAttempts: number;
    maxPollingAttempts: number;
  } {
    let message = "";

    switch (this.initializationStatus) {
      case CopilotStatus.Initializing:
        message = "🔍 Initializing Copilot integration...";
        break;
      case CopilotStatus.Waiting:
        message = `⏳ Waiting for Copilot... (attempt ${this.pollingAttempts}/${this.maxPollingAttempts})`;
        break;
      case CopilotStatus.Ready:
        message = "✅ Copilot automation ready";
        break;
      case CopilotStatus.Unavailable:
        message = "❌ Copilot automation unavailable - setup required";
        break;
    }

    return {
      initializationStatus: this.initializationStatus,
      isReady: this.isReady(),
      message,
      pollingAttempts: this.pollingAttempts,
      maxPollingAttempts: this.maxPollingAttempts,
    };
  }

  /** Refresh Copilot availability check */
  async refresh(activateIfNeeded: boolean = false): Promise<void> {
    await this.checkCopilotAvailability(activateIfNeeded);
  }

  /** Test automation capability (diagnostic) */
  async testAutomation(): Promise<boolean> {
    const testMessage = "FlightPath automation test. Please acknowledge.";

    try {
      const result = await this.sendPromptWithDirectAutomation(testMessage);

      if (result) {
        vscode.window.showInformationMessage(
          "✅ FlightPath: Automation test successful! Check Copilot Chat for test message."
        );
      }

      return result;
    } catch (error) {
      vscode.window.showErrorMessage(
        `❌ FlightPath: Automation test failed: ${error}`
      );
      return false;
    }
  }

  /** Get detailed capability information */
  getCapabilities(): {
    hasDirectAutomation: boolean;
    supportsZeroInteraction: boolean;
    currentStrategy: string;
  } {
    return {
      hasDirectAutomation: this.isAvailable,
      supportsZeroInteraction: this.isAvailable,
      currentStrategy: this.isAvailable ? "copilot-chat" : "unavailable",
    };
  }

  /** Cancel current chat response */
  protected async cancelImplementation(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.cancel");
      console.log("⏹️ Cancelled");
    } catch (error) {
      console.warn("⚠️ Could not cancel chat:", error);
    }
  }

  /** Check if last failure was user cancellation (resets after check) */
  wasLastFailureUserCancellation(): boolean {
    const wasCancelled = this.lastFailureWasUserCancellation;
    this.lastFailureWasUserCancellation = false; // Reset flag after checking
    return wasCancelled;
  }
}
