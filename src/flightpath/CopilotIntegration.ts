import * as vscode from "vscode";
import { PromptItem, ContextConfig } from "../types/FlightPathTypes";

/**
 * Copilot initialization status
 */
export type CopilotStatus =
  | "initializing"
  | "waiting"
  | "ready"
  | "unavailable";

/**
 * GitHub Copilot Chat Integration with Direct Automation
 *
 * Implements PROVEN zero-interaction automation for Copilot Chat using:
 * - Direct text insertion (validated in POC at extension.ts:testCopilotAutomation)
 * - Proven timing delays: 1000ms (focus), 300ms (clear), 500ms (type)
 * - Background polling for Copilot availability (5s intervals, 30s max)
 *
 * Fallback: If direct automation is unavailable, reports error clearly to user
 */
export class CopilotIntegration {
  private context: vscode.ExtensionContext;
  private isAvailable: boolean = false;
  private workflowStep: number = 0;
  private totalSteps: number = 0;

  // Background polling state
  private initializationStatus: CopilotStatus = "initializing";
  private pollingAttempts: number = 0;
  private readonly maxPollingAttempts: number = 6; // 30 seconds / 5 seconds = 6 attempts
  private readonly pollingInterval: number = 5000; // 5 seconds
  private pollingTimer: NodeJS.Timeout | undefined;
  private statusChangeEmitter = new vscode.EventEmitter<CopilotStatus>();

  // Event for status changes
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  // Language Model Tool for response completion detection
  private responseCompleteEmitter = new vscode.EventEmitter<void>();
  public readonly onResponseComplete = this.responseCompleteEmitter.event;
  private isToolRegistered: boolean = false;
  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Register disposal of event emitters
    context.subscriptions.push(this.statusChangeEmitter);
    context.subscriptions.push(this.responseCompleteEmitter);

    this.initialize();
  }

  /**
   * Initialize Copilot integration with background polling
   * Polls every 5 seconds for up to 30 seconds to detect Copilot availability
   * Note: Language Model Tool will be registered AFTER Copilot becomes ready
   */
  private async initialize(): Promise<void> {
    await this.startBackgroundPolling();
  }

  /**
   * Register the Language Model Tool for detecting response completion
   * This tool is called by Copilot when it finishes responding to a prompt
   * Should only be called AFTER Copilot extensions are active and ready
   */
  private registerResponseTool(): void {
    // Prevent duplicate registration
    if (this.isToolRegistered) {
      console.log(
        "⚠️ FlightPath: Language Model Tool already registered, skipping..."
      );
      return;
    }

    console.log(
      "🔧 FlightPath: Registering Language Model Tool: flightpath_response_complete"
    );

    try {
      const tool = vscode.lm.registerTool("flightpath_response_complete", {
        invoke: async (options, token) => {
          console.log("✅ FlightPath: Copilot called response complete tool!");
          console.log("📊 Tool invocation options:", {
            hasToolInvocationToken: !!options.toolInvocationToken,
            inputProvided: options.input,
          });

          // Show success popup to user
          vscode.window.showInformationMessage(
            "🎉 FlightPath: Copilot has finished responding!",
            "OK"
          );

          // Fire the response complete event for internal handling
          this.responseCompleteEmitter.fire();

          // Return acknowledgment to Copilot
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              "Response acknowledged by FlightPath"
            ),
          ]);
        },
      });

      // Register for disposal
      this.context.subscriptions.push(tool);
      this.isToolRegistered = true;
      console.log("✅ FlightPath: Language Model Tool registered successfully");
    } catch (error) {
      console.error(
        "❌ FlightPath: Failed to register Language Model Tool:",
        error
      );
      vscode.window.showErrorMessage(
        `FlightPath: Failed to register response detection tool: ${error}`
      );
    }
  }

  /**
   * Check if GitHub Copilot is available and automation commands are present
   * @param activateIfNeeded - If true, will attempt to activate Copilot extensions if they're installed but not active
   */
  private async checkCopilotAvailability(
    activateIfNeeded: boolean = false
  ): Promise<void> {
    try {
      console.log("🔍 FlightPath: Checking Copilot availability...");

      // Check if GitHub Copilot extension is installed and active
      let copilotExtension = vscode.extensions.getExtension("GitHub.copilot");
      let copilotChatExtension = vscode.extensions.getExtension(
        "GitHub.copilot-chat"
      );

      console.log(
        "📦 Copilot extension:",
        copilotExtension
          ? `Found (Active: ${copilotExtension.isActive})`
          : "Not found"
      );
      console.log(
        "📦 Copilot Chat extension:",
        copilotChatExtension
          ? `Found (Active: ${copilotChatExtension.isActive})`
          : "Not found"
      );

      // Try to activate extensions if they're installed but not active
      if (activateIfNeeded) {
        if (copilotChatExtension && !copilotChatExtension.isActive) {
          console.log(
            "🔄 FlightPath: Attempting to activate Copilot Chat extension..."
          );
          try {
            await copilotChatExtension.activate();
            console.log("✅ FlightPath: Copilot Chat extension activated");
          } catch (activationError) {
            console.warn(
              "⚠️ FlightPath: Could not activate Copilot Chat:",
              activationError
            );
          }
        }

        if (copilotExtension && !copilotExtension.isActive) {
          console.log(
            "🔄 FlightPath: Attempting to activate Copilot extension..."
          );
          try {
            await copilotExtension.activate();
            console.log("✅ FlightPath: Copilot extension activated");
          } catch (activationError) {
            console.warn(
              "⚠️ FlightPath: Could not activate Copilot:",
              activationError
            );
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
        console.log(
          "❌ FlightPath: GitHub Copilot not installed or not active"
        );
        if (!activateIfNeeded) {
          console.log(
            "💡 FlightPath: Will retry with activation when sending prompts"
          );
        }
        this.isAvailable = false;
        return;
      }

      // Check for required automation commands (PROVEN strategy)
      console.log(
        "🔍 FlightPath: Checking for required automation commands..."
      );
      const commands = await vscode.commands.getCommands();
      console.log(`📊 Total VS Code commands available: ${commands.length}`);

      const hasTypeCommand = commands.includes("type");
      const hasChatSubmit = commands.includes("workbench.action.chat.submit");
      const hasChatFocus = commands.includes(
        "workbench.panel.chat.view.copilot.focus"
      );
      const hasSelectAll = commands.includes("editor.action.selectAll");

      console.log("📋 Command availability check:");
      console.log(`   - type: ${hasTypeCommand ? "✅" : "❌"}`);
      console.log(`   - chat.submit: ${hasChatSubmit ? "✅" : "❌"}`);
      console.log(`   - chat.focus: ${hasChatFocus ? "✅" : "❌"}`);
      console.log(`   - selectAll: ${hasSelectAll ? "✅" : "❌"}`);

      this.isAvailable =
        hasTypeCommand && hasChatSubmit && hasChatFocus && hasSelectAll;

      if (this.isAvailable) {
        console.log(
          "✅ FlightPath: Direct automation available (PROVEN strategy)"
        );
      } else {
        console.log(
          "❌ FlightPath: Required automation commands not available"
        );
        console.log(`   - type: ${hasTypeCommand}`);
        console.log(`   - chat.submit: ${hasChatSubmit}`);
        console.log(`   - chat.focus: ${hasChatFocus}`);
        console.log(`   - selectAll: ${hasSelectAll}`);
      }
    } catch (error) {
      console.error(
        "❌ FlightPath: Error checking Copilot availability:",
        error
      );
      console.error("📊 Error details:", JSON.stringify(error, null, 2));
      this.isAvailable = false;
    }
  }

  /**
   * Start background polling to detect Copilot availability
   * Polls every 5 seconds for up to 30 seconds (6 attempts)
   */
  private async startBackgroundPolling(): Promise<void> {
    console.log(
      "🔄 FlightPath: Starting background polling for Copilot availability..."
    );
    this.pollingAttempts = 0;
    this.initializationStatus = "initializing";
    this.statusChangeEmitter.fire("initializing");

    // Clear any existing polling timer
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
    }

    await this.pollCopilotAvailability();
  }

  /**
   * Poll Copilot availability with progressive strategy
   */
  private async pollCopilotAvailability(): Promise<void> {
    this.pollingAttempts++;
    console.log(
      `🔍 FlightPath: Polling attempt ${this.pollingAttempts}/${this.maxPollingAttempts}`
    );

    // Strategy: First check is passive, second check onwards we try activation
    const shouldActivate = this.pollingAttempts >= 2;
    await this.checkCopilotAvailability(shouldActivate);

    if (this.isAvailable) {
      // Success! Copilot is available
      console.log("✅ FlightPath: Copilot automation ready after polling");

      // Now that Copilot is ready, register the Language Model Tool
      this.registerResponseTool();

      this.initializationStatus = "ready";
      this.statusChangeEmitter.fire("ready");

      // Clear polling timer
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = undefined;
      }
      return;
    }

    // Check if we've exceeded max attempts
    if (this.pollingAttempts >= this.maxPollingAttempts) {
      console.log(
        "❌ FlightPath: Polling timeout - Copilot not available after 30 seconds"
      );
      this.initializationStatus = "unavailable";
      this.statusChangeEmitter.fire("unavailable");

      // Clear polling timer
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = undefined;
      }
      return;
    }

    // Continue polling
    console.log(
      `⏳ FlightPath: Copilot not ready, will retry in ${this.pollingInterval / 1000} seconds...`
    );
    this.initializationStatus = "waiting";
    this.statusChangeEmitter.fire("waiting");

    this.pollingTimer = setTimeout(() => {
      this.pollCopilotAvailability();
    }, this.pollingInterval);
  }

  /**
   * Manually retry Copilot detection (restart polling)
   */
  async retryDetection(): Promise<void> {
    console.log("🔄 FlightPath: Manual retry of Copilot detection requested");
    vscode.window.showInformationMessage(
      "FlightPath: Retrying Copilot detection..."
    );
    await this.startBackgroundPolling();
  }

  /**
   * Send prompt to GitHub Copilot Chat with direct automation
   *
   * Uses PROVEN zero-interaction strategy:
   * 1. Focus chat (1000ms delay)
   * 2. Clear input (300ms delay)
   * 3. Type prompt (500ms delay)
   * 4. Submit automatically
   *
   * Note: Assumes background polling has confirmed automation is available.
   * FlightPathManager blocks workflow execution until status is 'ready'.
   */
  async sendPrompt(prompt: PromptItem): Promise<boolean> {
    try {
      console.log("🚀 FlightPath: sendPrompt() called");
      console.log(`📊 Prompt item:`, {
        prompt: prompt.prompt.substring(0, 100),
        hasContext: !!prompt.context,
        hasEndCondition: !!prompt.endCondition,
      });

      // Verify automation is still available (should always be true due to workflow blocking)
      if (!this.isAvailable) {
        const message =
          "FlightPath: Automation became unavailable. This should not happen if initialization completed successfully.";
        console.error("❌ " + message);
        vscode.window.showErrorMessage(message);
        return false;
      }

      console.log("✅ FlightPath: Automation confirmed available");
      console.log(
        "🚀 FlightPath: Sending prompt with direct automation (PROVEN strategy)"
      );

      // Build prompt with Copilot Chat syntax
      console.log("🔨 Building Copilot Chat prompt with context...");
      const chatPrompt = await this.buildCopilotChatPrompt(prompt);
      console.log(`✅ Built chat prompt (${chatPrompt.length} characters)`);
      console.log(
        `📝 Chat prompt preview: "${chatPrompt.substring(0, 150)}${chatPrompt.length > 150 ? "..." : ""}"`
      );

      // Execute direct automation
      console.log("🎬 Executing direct automation sequence...");
      const result = await this.sendPromptWithDirectAutomation(chatPrompt);
      console.log(
        `📊 Automation result: ${result ? "✅ SUCCESS" : "❌ FAILED"}`
      );

      return result;
    } catch (error) {
      console.error("❌ FlightPath: Failed to send prompt to Copilot:", error);
      console.error("📊 Error type:", typeof error);
      console.error(
        "📊 Error stack:",
        error instanceof Error ? error.stack : "No stack trace"
      );
      vscode.window.showErrorMessage(
        `FlightPath: Failed to send prompt: ${error}`
      );
      return false;
    }
  }

  /**
   * Direct text insertion automation (PROVEN - zero interaction)
   *
   * Based on validated proof-of-concept in extension.ts:testCopilotAutomation()
   * Timing delays are proven and validated - do not reduce!
   */
  private async sendPromptWithDirectAutomation(
    chatPrompt: string
  ): Promise<boolean> {
    try {
      console.log("🔍 FlightPath: Starting direct automation sequence...");
      console.log(
        `📝 Prompt to send: "${chatPrompt.substring(0, 100)}${chatPrompt.length > 100 ? "..." : ""}"`
      );

      // Step 1: Focus Copilot Chat panel
      console.log("📋 Step 1: Attempting to focus Copilot Chat panel...");
      try {
        await vscode.commands.executeCommand(
          "workbench.panel.chat.view.copilot.focus"
        );
        console.log("✅ Step 1: Focus command executed successfully");
      } catch (focusError) {
        console.error(
          "❌ Step 1 FAILED: Could not focus Copilot Chat panel:",
          focusError
        );
        throw new Error(`Failed to focus Copilot Chat: ${focusError}`);
      }

      console.log("⏳ Step 1: Waiting 1000ms for panel to focus...");
      await new Promise((resolve) => setTimeout(resolve, 1000)); // PROVEN: 1000ms required
      console.log("✅ Step 1: Wait complete");

      // Step 2: Clear any existing input
      console.log("🧹 Step 2: Attempting to select all existing text...");
      try {
        await vscode.commands.executeCommand("editor.action.selectAll");
        console.log("✅ Step 2: Select all command executed successfully");
      } catch (selectError) {
        console.error(
          "❌ Step 2 FAILED: Could not select all text:",
          selectError
        );
        throw new Error(`Failed to select all: ${selectError}`);
      }

      console.log("⏳ Step 2: Waiting 300ms for selection to complete...");
      await new Promise((resolve) => setTimeout(resolve, 300)); // PROVEN: 300ms required
      console.log("✅ Step 2: Wait complete");

      // Step 3: Type the prompt directly into chat input
      console.log("⌨️ Step 3: Attempting to type prompt text...");
      console.log(`📊 Prompt length: ${chatPrompt.length} characters`);
      try {
        await vscode.commands.executeCommand("type", { text: chatPrompt });
        console.log("✅ Step 3: Type command executed successfully");
      } catch (typeError) {
        console.error("❌ Step 3 FAILED: Could not type text:", typeError);
        console.error("📋 Type command parameters:", { text: chatPrompt });
        throw new Error(`Failed to type text: ${typeError}`);
      }

      console.log("⏳ Step 3: Waiting 500ms for text to be processed...");
      await new Promise((resolve) => setTimeout(resolve, 500)); // PROVEN: 500ms required
      console.log("✅ Step 3: Wait complete");

      // Step 4: Submit automatically
      console.log("📤 Step 4: Attempting to submit message...");
      try {
        await vscode.commands.executeCommand("workbench.action.chat.submit");
        console.log("✅ Step 4: Submit command executed successfully");
      } catch (submitError) {
        console.error(
          "❌ Step 4 FAILED: Could not submit message:",
          submitError
        );
        throw new Error(`Failed to submit message: ${submitError}`);
      }

      console.log(
        "✅ FlightPath: Prompt sent successfully with zero-interaction automation"
      );
      console.log("🎉 All automation steps completed successfully!");

      // Update workflow progress
      await this.updateWorkflowProgress();

      return true;
    } catch (error) {
      console.error(
        "❌ FlightPath: Direct automation failed with error:",
        error
      );
      console.error("📊 Error type:", typeof error);
      console.error("📊 Error details:", JSON.stringify(error, null, 2));

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

  /**
   * Show detailed requirements for automation to work
   */
  private async showAutomationRequirements(): Promise<void> {
    const requirements = `# FlightPath Automation Requirements

For zero-interaction automation to work, the following are required:

## Required Extensions
- GitHub Copilot Chat (installed and activated)

## Required VS Code Commands
- \`type\` - Insert text at cursor
- \`workbench.action.chat.submit\` - Submit chat message
- \`workbench.panel.chat.view.copilot.focus\` - Focus Copilot Chat
- \`editor.action.selectAll\` - Select all text

## Troubleshooting
1. Ensure GitHub Copilot Chat extension is installed and active
2. Try reloading VS Code window (Ctrl+Shift+P → "Reload Window")
3. Update VS Code to the latest version
4. Check VS Code Output panel for detailed error messages

## Testing
Use Command Palette: "FlightPath: Test Automation" to verify setup
`;

    const doc = await vscode.workspace.openTextDocument({
      content: requirements,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /**
   * Build prompt with Copilot Chat syntax and context
   * Uses native Copilot Chat variables (@workspace, #file, #selection)
   */
  private async buildCopilotChatPrompt(prompt: PromptItem): Promise<string> {
    let chatPrompt = "";
    const contextParts: string[] = [];

    try {
      // Add workspace context using Copilot Chat variables
      if (
        prompt.context?.includeWorkspaceFiles &&
        prompt.context.includeWorkspaceFiles.length > 0
      ) {
        chatPrompt += "@workspace ";

        // Also add specific file patterns as context
        for (const pattern of prompt.context.includeWorkspaceFiles) {
          const files = await vscode.workspace.findFiles(pattern, null, 5);
          for (const file of files) {
            const fileName = vscode.workspace.asRelativePath(file);
            chatPrompt += `#file:${fileName} `;
          }
        }
      }

      // Add current file reference
      if (prompt.context?.includeCurrentFile) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          const fileName = vscode.workspace.asRelativePath(
            activeEditor.document.uri
          );
          chatPrompt += `#file:${fileName} `;
        }
      }

      // Add selection context
      if (prompt.context?.includeSelection) {
        chatPrompt += "#selection ";
      }

      // Detect and apply slash commands based on prompt content
      const promptLower = prompt.prompt.toLowerCase();
      let slashCommand = "";

      if (
        promptLower.includes("fix") ||
        promptLower.includes("error") ||
        promptLower.includes("bug")
      ) {
        slashCommand = "/fix ";
      } else if (
        promptLower.includes("explain") ||
        promptLower.includes("what does")
      ) {
        slashCommand = "/explain ";
      } else if (
        promptLower.includes("create") ||
        promptLower.includes("generate") ||
        promptLower.includes("new")
      ) {
        slashCommand = "/new ";
      } else if (promptLower.includes("test")) {
        slashCommand = "/tests ";
      }

      // Combine: [slash command] [context variables] [prompt text]
      chatPrompt = slashCommand + chatPrompt + prompt.prompt;
    } catch (error) {
      console.error("FlightPath: Error building Copilot Chat prompt:", error);
      // Fallback to simple prompt
      chatPrompt = prompt.prompt;
    }

    return chatPrompt.trim();
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use buildCopilotChatPrompt instead
   */
  private async buildPromptWithContext(prompt: PromptItem): Promise<string> {
    return await this.buildCopilotChatPrompt(prompt);
  }

  /**
   * Update workflow progress tracking
   */
  private async updateWorkflowProgress(): Promise<void> {
    if (this.totalSteps > 0) {
      const progress = `${this.workflowStep}/${this.totalSteps}`;
      vscode.window.setStatusBarMessage(
        `$(rocket) FlightPath: Step ${progress} completed`,
        3000
      );
    }
  }

  /**
   * Show prompt preview in a document
   */
  private async showPromptPreview(prompt: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument({
        content: `# FlightPath Generated Copilot Chat Prompt\n\n${prompt}\n\n---\n\n*Copy this prompt and paste it into Copilot Chat*`,
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    } catch (error) {
      console.error("FlightPath: Failed to show prompt preview:", error);
    }
  }

  /**
   * Set workflow progress tracking (called by PromptQueue)
   */
  setWorkflowProgress(currentStep: number, totalSteps: number): void {
    this.workflowStep = currentStep;
    this.totalSteps = totalSteps;
  }

  /**
   * Check if Copilot integration is available
   */
  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  /**
   * Get initialization status
   */
  getInitializationStatus(): CopilotStatus {
    return this.initializationStatus;
  }

  /**
   * Check if Copilot is ready for workflows
   */
  isReady(): boolean {
    return this.initializationStatus === "ready";
  }

  /**
   * Get integration status
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message:
          "✅ Direct automation available (PROVEN zero-interaction strategy)",
        strategy: "direct",
      };
    } else {
      return {
        available: false,
        message:
          "❌ Direct automation unavailable - required commands not found",
        strategy: "unavailable",
      };
    }
  }

  /**
   * Get detailed status with initialization state
   */
  getDetailedStatus(): {
    initializationStatus: CopilotStatus;
    isReady: boolean;
    message: string;
    pollingAttempts: number;
    maxPollingAttempts: number;
  } {
    let message = "";

    switch (this.initializationStatus) {
      case "initializing":
        message = "🔍 Initializing Copilot integration...";
        break;
      case "waiting":
        message = `⏳ Waiting for Copilot... (attempt ${this.pollingAttempts}/${this.maxPollingAttempts})`;
        break;
      case "ready":
        message = "✅ Copilot automation ready";
        break;
      case "unavailable":
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

  /**
   * Refresh Copilot availability check
   * @param activateIfNeeded - If true, will attempt to activate Copilot extensions
   */
  async refresh(activateIfNeeded: boolean = false): Promise<void> {
    await this.checkCopilotAvailability(activateIfNeeded);
  }

  /**
   * Test automation capability (diagnostic tool)
   */
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

  /**
   * Execute prompt with enhanced context awareness and automation
   */
  async executePromptWithContext(prompt: PromptItem): Promise<{
    success: boolean;
    message: string;
    requiresManualExecution?: boolean;
    strategy?: string;
  }> {
    try {
      const success = await this.sendPrompt(prompt);

      if (success) {
        return {
          success: true,
          message: "Prompt sent successfully using direct automation",
          requiresManualExecution: false,
          strategy: "direct",
        };
      } else {
        return {
          success: false,
          message:
            "Direct automation unavailable - required commands not found",
          requiresManualExecution: true,
          strategy: "unavailable",
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Copilot integration error: ${error}`,
        requiresManualExecution: true,
        strategy: "error",
      };
    }
  }

  /**
   * Check if zero-interaction automation is supported
   */
  isZeroInteractionSupported(): boolean {
    return this.isAvailable;
  }

  /**
   * Get detailed capability information
   */
  getCapabilities(): {
    hasDirectAutomation: boolean;
    supportsZeroInteraction: boolean;
    currentStrategy: string;
  } {
    return {
      hasDirectAutomation: this.isAvailable,
      supportsZeroInteraction: this.isAvailable,
      currentStrategy: this.isAvailable ? "direct" : "unavailable",
    };
  }
}
