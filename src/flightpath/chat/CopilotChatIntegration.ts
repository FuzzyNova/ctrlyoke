import * as vscode from "vscode";
import {
  PromptItem,
  CopilotIntegrationMode,
} from "../../types/FlightPathTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";

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
export class CopilotChatIntegration extends CopilotIntegration {
  // Background polling state
  private initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  private pollingAttempts: number = 0;
  private readonly maxPollingAttempts: number = 6; // 30 seconds / 5 seconds = 6 attempts
  private readonly pollingInterval: number = 5000; // 5 seconds
  private pollingTimer: NodeJS.Timeout | undefined;

  // Language Model Tool for response completion detection
  private isToolRegistered: boolean = false;
  private toolCalledForCurrentPrompt: boolean = false; // Prevent duplicate tool calls in same response

  // Tool invocation instruction - single source of truth
  private readonly TOOL_INSTRUCTION = `
<criticalInstruction>
When you have FULLY FINISHED your response including ALL code, explanations, and file modifications, call the #flightpath_response_complete tool EXACTLY ONCE as your FINAL action. This is essential for workflow automation. Do NOT add any text after calling the tool.
</criticalInstruction>`;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.initialize();
  }

  /**
   * Get the chat window command based on user settings
   * @returns The VS Code command to use for opening Copilot Chat
   */
  private getChatWindowCommand(): string {
    const config = vscode.workspace.getConfiguration("flightpath");
    const chatLocation = config.get<string>("chatWindowLocation", "chatPanel");

    const commandMap: Record<string, string> = {
      chatPanel: "workbench.panel.chat.view.copilot.focus",
      newTab: "workbench.action.chat.openInEditor",
      newWindow: "workbench.action.chat.openInNewWindow",
    };

    return commandMap[chatLocation] || commandMap["chatPanel"];
  }

  /**
   * Initialize Copilot integration with background polling
   * Polls every 5 seconds for up to 30 seconds to detect Copilot availability
   * Note: Language Model Tool will be registered AFTER Copilot becomes ready
   */
  async initialize(): Promise<void> {
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
      return;
    }

    try {
      const tool = vscode.lm.registerTool("flightpath_response_complete", {
        invoke: async (options, token) => {
          // Prevent duplicate tool calls in same response (LLM loop behavior)
          if (this.toolCalledForCurrentPrompt) {
            console.log("⚠️ Tool called multiple times - stopping LLM loop");

            // Stop the chat to prevent infinite loop
            try {
              await vscode.commands.executeCommand(
                "workbench.action.chat.cancel"
              );
            } catch (cancelError) {
              console.warn("⚠️ Could not cancel chat:", cancelError);
            }

            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                "Already acknowledged - stopping loop"
              ),
            ]);
          }

          // Mark tool as called for this prompt
          this.toolCalledForCurrentPrompt = true;

          // Fire the response complete event for internal handling
          // Note: Chat mode cannot access response text directly, so we fire with empty string
          this.responseCompleteEmitter.fire("");

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
      console.log("✅ Language Model Tool registered");
    } catch (error) {
      console.error("❌ Failed to register Language Model Tool:", error);
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
        console.log("✅ Copilot Chat automation available");
      } else {
        console.error("❌ Required automation commands not available");
      }
    } catch (error) {
      console.error("❌ Error checking Copilot availability:", error);
      this.isAvailable = false;
    }
  }

  /**
   * Start background polling to detect Copilot availability
   * Polls every 5 seconds for up to 30 seconds (6 attempts)
   */
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

  /**
   * Poll Copilot availability with progressive strategy
   */
  private async pollCopilotAvailability(): Promise<void> {
    this.pollingAttempts++;

    // Strategy: First check is passive, second check onwards we try activation
    const shouldActivate = this.pollingAttempts >= 2;
    await this.checkCopilotAvailability(shouldActivate);

    if (this.isAvailable) {
      // Success! Copilot is available
      console.log("✅ Copilot Chat ready");

      // Now that Copilot is ready, register the Language Model Tool
      this.registerResponseTool();

      this.initializationStatus = CopilotStatus.Ready;
      this.statusChangeEmitter.fire(CopilotStatus.Ready);

      // Clear polling timer
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = undefined;
      }
      return;
    }

    // Check if we've exceeded max attempts
    if (this.pollingAttempts >= this.maxPollingAttempts) {
      console.error("❌ Copilot not available after 30 seconds");
      this.initializationStatus = CopilotStatus.Unavailable;
      this.statusChangeEmitter.fire(CopilotStatus.Unavailable);

      // Clear polling timer
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

  /**
   * Manually retry Copilot detection (restart polling)
   */
  async retryDetection(): Promise<void> {
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
   *
   * @param prompt The prompt item to send
   * @param needsCompletionDetection If true, attach tool instructions for completion detection (default: true)
   */
  async sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection: boolean = true
  ): Promise<boolean> {
    try {
      // Verify automation is still available
      if (!this.isAvailable) {
        console.error("❌ Automation became unavailable");
        vscode.window.showErrorMessage(
          "FlightPath: Automation became unavailable"
        );
        return false;
      }

      // Build prompt with Copilot Chat syntax
      const chatPrompt = await this.buildCopilotChatPrompt(
        prompt,
        needsCompletionDetection
      );

      // Execute direct automation
      const result = await this.sendPromptWithDirectAutomation(
        chatPrompt,
        needsCompletionDetection
      );

      return result;
    } catch (error) {
      console.error("❌ Failed to send prompt:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to send prompt: ${error}`
      );
      return false;
    }
  }

  /**
   * Copy chat content to clipboard and return it
   * Preserves user's original clipboard content by caching and restoring it
   * @returns The current chat conversation text
   */
  private async copyChatToClipboard(): Promise<string> {
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

      return chatContent;
    } catch (error) {
      console.error("❌ Failed to copy chat to clipboard:", error);
      return "";
    }
  }

  /**
   * Wait for Copilot to finish responding by monitoring chat content stability
   *
   * Strategy: Copilot calls our tool before it's done streaming. We poll the chat
   * content via clipboard and wait for it to stop changing (3 consecutive stable checks).
   *
   * @param maxAttempts Maximum number of polling attempts (default: 40 = 20 seconds)
   * @returns True if Copilot finished, false if timeout
   */
  private async waitForCopilotToFinishStreaming(
    maxAttempts: number = 40
  ): Promise<boolean> {
    let previousContent = "";
    let unchangedCount = 0;
    const requiredStableChecks = 3; // 3 consecutive stable checks = 1.5 seconds

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Small delay between checks
      await new Promise((resolve) => setTimeout(resolve, 500));

      try {
        // Copy current chat content
        const currentContent = await this.copyChatToClipboard();

        // Check if content has changed
        if (currentContent === previousContent && currentContent.length > 0) {
          unchangedCount++;

          // If content has been stable for required checks, we're done
          if (unchangedCount >= requiredStableChecks) {
            return true;
          }
        } else {
          // Content changed, reset counter
          unchangedCount = 0;
          previousContent = currentContent;
        }
      } catch (error) {
        console.warn("⚠️ Error checking chat content:", error);
        // If we can't check, assume it's done to avoid blocking forever
        return true;
      }
    }

    console.warn(
      `⚠️ Timeout waiting for Copilot to finish streaming after ${maxAttempts * 0.5}s`
    );
    return false;
  }

  /**
   * Public method to wait for streaming to complete
   * Called by FlightPathManager after tool callback fires
   */
  async waitForStreamingComplete(): Promise<void> {
    await this.waitForCopilotToFinishStreaming();
  }

  /**
   * Submit chat message with clipboard verification and retry logic
   *
   * Verifies submit succeeded by checking if our prompt appears in the chat.
   * Uses exponential backoff: 500ms, 1000ms, 2000ms, 3000ms, 5000ms
   *
   * @param promptText The prompt text to verify in chat
   * @param maxAttempts Maximum number of retry attempts (default: 5)
   * @returns True if submit succeeded and verified, false if all attempts failed
   */
  private async submitWithRetry(
    promptText: string,
    maxAttempts: number = 5
  ): Promise<boolean> {
    let attempt = 0;
    const delays = [500, 1000, 2000, 3000, 5000]; // Exponential backoff pattern

    // Get chat content BEFORE submitting (to verify it changes)
    const chatBeforeSubmit = await this.copyChatToClipboard();

    while (attempt < maxAttempts) {
      attempt++;

      try {
        // Execute submit command
        await vscode.commands.executeCommand("workbench.action.chat.submit");

        // Wait for UI to process and chat to update
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify submit worked by checking if our prompt appears in chat
        const chatAfterSubmit = await this.copyChatToClipboard();

        // Extract a unique portion of the prompt for verification (first 100 chars without tool instruction)
        const promptToVerify = promptText
          .replace(this.TOOL_INSTRUCTION, "")
          .trim()
          .substring(0, 100);

        // Check if our prompt appears in the chat and wasn't there before
        if (
          chatAfterSubmit.includes(promptToVerify) &&
          !chatBeforeSubmit.includes(promptToVerify)
        ) {
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

    // All attempts failed
    console.error(
      `❌ Submit failed after ${maxAttempts} attempts - Copilot may still be responding`
    );
    return false;
  }

  /**
   * Direct text insertion automation (PROVEN - zero interaction)
   *
   * Based on validated proof-of-concept in extension.ts:testCopilotAutomation()
   * Timing delays are proven and validated - do not reduce!
   *
   * @param chatPrompt The full prompt text to send
   * @param needsCompletionDetection If true, reset tool flags for completion detection
   */
  private async sendPromptWithDirectAutomation(
    chatPrompt: string,
    needsCompletionDetection: boolean = true
  ): Promise<boolean> {
    try {
      // Only reset tool call flag if we're using completion detection
      if (needsCompletionDetection) {
        this.toolCalledForCurrentPrompt = false;
      }

      // Step 1: Open/Focus Copilot Chat using configured location
      const chatCommand = this.getChatWindowCommand();
      try {
        await vscode.commands.executeCommand(chatCommand);
      } catch (focusError) {
        console.error("❌ Could not open Copilot Chat:", focusError);
        throw new Error(`Failed to open Copilot Chat: ${focusError}`);
      }

      // Use longer delay for newWindow and newTab as they may need more setup time
      const chatLocation = vscode.workspace
        .getConfiguration("flightpath")
        .get<string>("chatWindowLocation", "chatPanel");
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
      const submitSuccess = await this.submitWithRetry(chatPrompt, 10);

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
   * Override buildPromptText to handle chat-specific attachment strategy
   * Uses native VS Code attachment commands when enabled for clean chat UI
   */
  protected async buildPromptText(prompt: PromptItem): Promise<string> {
    // Check if auto-attachment is enabled
    const autoAttach = vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("autoAttachFiles", true);

    // Check if native attachments are enabled for chat mode
    const useNativeAttachments = vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("chatUseNativeAttachments", true);

    if (!autoAttach) {
      // Auto-attachment disabled - return prompt as-is
      return prompt.prompt.trim();
    }

    if (useNativeAttachments) {
      // Use VS Code's native attachment commands for clean UI
      return await this.processNativeAttachments(prompt.prompt);
    } else {
      // Fall back to XML attachment (shows raw text but more reliable)
      return await super.buildPromptText(prompt);
    }
  }

  /**
   * Helper method to open a document, execute an action, and close it
   * Common flow for both file and selection attachments
   *
   * @param uri File URI to open
   * @param action Async function to execute while document is focused
   */
  private async withFocusedDocument(
    uri: vscode.Uri,
    action: (editor: vscode.TextEditor) => Promise<void>
  ): Promise<void> {
    // Open the document
    const doc = await vscode.workspace.openTextDocument(uri);

    // Open document and GAIN FOCUS (preserveFocus: false is critical)
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true, // Preview mode - will be replaced by next preview
      preserveFocus: false, // MUST be false - we need focus for attachment commands
      viewColumn: vscode.ViewColumn.Beside,
    });

    // Small delay to ensure document is focused and rendered
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Execute the action (attach file or attach selection)
    await action(editor);

    // Close the editor to avoid cluttering workspace
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }

  /**
   * Process #file: references using VS Code's native attachment commands
   * Attaches files/selections via commands and KEEPS #file: references in prompt text
   *
   * IMPORTANT: #file: references are kept in the prompt text because they provide
   * critical context about WHERE in the prompt specific code is being discussed.
   * This enables prompts like: "Look at this first: #file:A:1-10 then this: #file:B:20-30"
   *
   * @param prompt Original prompt text with #file: references
   * @returns Original prompt text unchanged (files are attached via commands)
   */
  private async processNativeAttachments(prompt: string): Promise<string> {
    try {
      // Parse file references from prompt
      const fileReferences = this.parseFileReferences(prompt);

      if (fileReferences.length === 0) {
        return prompt; // No attachments needed
      }

      console.log(
        `📎 Processing ${fileReferences.length} file attachment(s) using native commands...`
      );

      // Process each file reference
      for (const ref of fileReferences) {
        const absolutePath = this.resolveWorkspacePath(ref.path);
        const uri = vscode.Uri.file(absolutePath);

        if (!ref.startLine || !ref.endLine) {
          // Attach entire file
          try {
            await this.withFocusedDocument(uri, async () => {
              // Attach the currently focused file (no URI parameter supported)
              await vscode.commands.executeCommand(
                "github.copilot.chat.attachFile"
              );
            });
            console.log(`✅ Attached file: ${ref.path}`);
          } catch (error) {
            console.error(`❌ Failed to attach file ${ref.path}:`, error);
          }
        } else {
          // Attach line range using selection
          try {
            await this.withFocusedDocument(uri, async (editor) => {
              // Set selection (convert to 0-indexed)
              // Non-null assertions safe here - we've already checked they exist
              const selection = new vscode.Selection(
                new vscode.Position(ref.startLine! - 1, 0),
                new vscode.Position(ref.endLine! - 1, Number.MAX_SAFE_INTEGER)
              );
              editor.selection = selection;

              // Attach the selection
              await vscode.commands.executeCommand(
                "github.copilot.chat.attachSelection"
              );
            });
            console.log(
              `✅ Attached selection: ${ref.path}:${ref.startLine}-${ref.endLine}`
            );
          } catch (error) {
            console.error(
              `❌ Failed to attach selection ${ref.path}:${ref.startLine}-${ref.endLine}:`,
              error
            );
          }
        }

        // Small delay between attachments to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Keep #file: references in prompt text - they provide important context
      // about WHERE in the prompt specific code is being discussed
      return prompt;
    } catch (error) {
      console.error("Error processing native attachments:", error);
      // On error, fall back to returning original prompt
      return prompt;
    }
  }

  /**
   * Build final prompt with XML structure for tool instruction
   * User prompt is sent as-is (visible in chat), tool instruction is wrapped in XML (hidden by Copilot UI but processed correctly)
   * Prompts are stored in final-form (ready to send) in JSON files
   *
   * @param prompt The prompt item
   * @param includeToolInstruction If true, append tool instruction for completion detection
   */
  private async buildCopilotChatPrompt(
    prompt: PromptItem,
    includeToolInstruction: boolean = true
  ): Promise<string> {
    // Use base class method to get prompt text with file attachments processed
    const promptText = await this.buildPromptText(prompt);

    // Only append tool instruction if needed (multi-prompt workflows)
    if (includeToolInstruction) {
      // Append TOOL_INSTRUCTION wrapped in XML - Copilot hides XML tags in chat UI but still processes them
      // This gives us a clean chat history while maintaining automation functionality
      return `${promptText}

${this.TOOL_INSTRUCTION}`;
    }

    return promptText.trim();
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
        strategy: CopilotIntegrationMode.Chat,
      };
    } else {
      return {
        available: false,
        message:
          "❌ Direct automation unavailable - required commands not found",
        strategy: CopilotIntegrationMode.Chat,
      };
    }
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
    return this.initializationStatus === CopilotStatus.Ready;
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
      currentStrategy: this.isAvailable ? "chat" : "unavailable",
    };
  }
}
