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
  private toolCalledForCurrentPrompt: boolean = false; // Prevent duplicate tool calls in same response

  // Tool invocation instruction - single source of truth
  private readonly TOOL_INSTRUCTION =
    "\n\n---\n\nCRITICAL INSTRUCTION: When you have FULLY FINISHED your response including ALL code, explanations, and file modifications, call the #flightpath_response_complete tool EXACTLY ONCE as your FINAL action. This is essential for workflow automation.";
  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Register disposal of event emitters
    context.subscriptions.push(this.statusChangeEmitter);
    context.subscriptions.push(this.responseCompleteEmitter);

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

    const command = commandMap[chatLocation] || commandMap["chatPanel"];
    console.log(
      `⚙️ FlightPath: Using chat window location: ${chatLocation} → ${command}`
    );
    return command;
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
    console.log(
      "🔧 Tool will be available to Copilot as: #flightpath_response_complete"
    );

    try {
      const tool = vscode.lm.registerTool("flightpath_response_complete", {
        invoke: async (options, token) => {
          console.log("🎯 ===== TOOL CALLBACK RECEIVED =====");

          // Prevent duplicate tool calls in same response (LLM loop behavior)
          if (this.toolCalledForCurrentPrompt) {
            console.log(
              "⚠️ FlightPath: Tool already called for this prompt - LLM is looping!"
            );
            console.log(
              "� FlightPath: Canceling chat to stop infinite loop..."
            );

            // Stop the chat to prevent infinite loop
            try {
              await vscode.commands.executeCommand(
                "workbench.action.chat.cancel"
              );
              console.log("✅ FlightPath: Chat canceled successfully");
            } catch (cancelError) {
              console.warn(
                "⚠️ FlightPath: Could not cancel chat:",
                cancelError
              );
            }

            console.log(
              "💡 LLMs often try to add text after calling tools, which triggers loops"
            );
            console.log("🎯 =====================================");
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                "Already acknowledged - stopping loop"
              ),
            ]);
          }

          console.log("✅ FlightPath: Copilot called response complete tool!");
          console.log("📊 Tool invocation options:", {
            hasToolInvocationToken: !!options.toolInvocationToken,
            inputProvided: options.input,
          });
          console.log("🎯 =====================================");

          // Mark tool as called for this prompt
          this.toolCalledForCurrentPrompt = true;

          // Show success popup to user
          vscode.window.showInformationMessage(
            "🎉 FlightPath: Copilot has finished responding!",
            "OK"
          );

          // Fire the response complete event for internal handling
          console.log("🔔 FlightPath: Firing responseCompleteEmitter event...");
          this.responseCompleteEmitter.fire();
          console.log("✅ FlightPath: Event fired successfully");

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
      console.log("✅ Tool is now active and listening for Copilot callbacks");
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

      console.log("📋 Command availability check:");
      console.log(`   - type: ${hasTypeCommand ? "✅" : "❌"}`);
      console.log(`   - chat.submit: ${hasChatSubmit ? "✅" : "❌"}`);
      console.log(`   - chat.panel.focus: ${hasChatPanel ? "✅" : "❌"}`);
      console.log(`   - chat.openInEditor: ${hasChatTab ? "✅" : "❌"}`);
      console.log(`   - chat.openInNewWindow: ${hasChatWindow ? "✅" : "❌"}`);
      console.log(`   - selectAll: ${hasSelectAll ? "✅" : "❌"}`);

      // At least one chat opening method must be available
      const hasChatOpenCommand = hasChatPanel || hasChatTab || hasChatWindow;

      this.isAvailable =
        hasTypeCommand && hasChatSubmit && hasChatOpenCommand && hasSelectAll;

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
        console.log(`   - chat open command: ${hasChatOpenCommand}`);
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
    console.log(
      "⏳ Waiting for Copilot to finish streaming (clipboard monitoring)..."
    );

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
          console.log(
            `✅ Chat content stable (${unchangedCount}/${requiredStableChecks} checks)`
          );

          // If content has been stable for required checks, we're done
          if (unchangedCount >= requiredStableChecks) {
            console.log(
              `✅ Copilot finished streaming (content stable for ${unchangedCount * 0.5}s)`
            );
            return true;
          }
        } else {
          // Content changed, reset counter
          if (unchangedCount > 0) {
            console.log(`⏳ Chat content changed, resetting stability counter`);
          }
          unchangedCount = 0;
          previousContent = currentContent;
        }

        console.log(
          `⏳ Attempt ${attempt}/${maxAttempts}: Copilot still streaming...`
        );
      } catch (error) {
        console.warn(`⚠️ Error checking chat content:`, error);
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
    const finished = await this.waitForCopilotToFinishStreaming();
    if (!finished) {
      console.warn(
        "⚠️ FlightPath: Copilot may still be streaming, but proceeding anyway to avoid blocking workflow"
      );
    }
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
    console.log("📋 Copying chat content before submit...");
    const chatBeforeSubmit = await this.copyChatToClipboard();
    console.log(`📊 Chat before submit: ${chatBeforeSubmit.length} characters`);

    while (attempt < maxAttempts) {
      attempt++;

      console.log(
        `📤 Submit attempt ${attempt}/${maxAttempts}: Executing workbench.action.chat.submit...`
      );

      try {
        // Execute submit command
        await vscode.commands.executeCommand("workbench.action.chat.submit");

        // Wait for UI to process and chat to update
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify submit worked by checking if our prompt appears in chat
        console.log("🔍 Verifying submit by checking clipboard...");
        const chatAfterSubmit = await this.copyChatToClipboard();
        console.log(
          `📊 Chat after submit: ${chatAfterSubmit.length} characters`
        );

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
          console.log(`✅ Submit verified - prompt appears in chat!`);
          return true;
        } else {
          console.warn(
            `⚠️ Submit verification failed - prompt not found in chat`
          );
          console.log(`🔍 Looking for: "${promptToVerify}"`);
          console.log(
            `📊 Chat changed: ${chatBeforeSubmit.length} → ${chatAfterSubmit.length} chars`
          );
        }
      } catch (error) {
        console.warn(
          `⚠️ Submit attempt ${attempt} threw error:`,
          error instanceof Error ? error.message : String(error)
        );
      }

      // If we have attempts left, wait and retry
      if (attempt < maxAttempts) {
        const delayIndex = Math.min(attempt - 1, delays.length - 1);
        const delay = delays[delayIndex];
        console.log(`⏳ Retrying submit in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // All attempts failed
    console.error(
      `❌ Submit failed after ${maxAttempts} attempts - prompt never appeared in chat.`
    );
    console.error(
      `💡 This suggests Copilot is still responding to previous prompt.`
    );
    return false;
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
      // Reset tool call flag for new prompt
      this.toolCalledForCurrentPrompt = false;
      console.log("🔄 FlightPath: Reset tool call flag for new prompt");

      console.log("🔍 FlightPath: Starting direct automation sequence...");
      console.log(
        `📝 Prompt to send: "${chatPrompt.substring(0, 100)}${chatPrompt.length > 100 ? "..." : ""}"`
      );

      // Step 1: Open/Focus Copilot Chat using configured location
      const chatCommand = this.getChatWindowCommand();
      console.log(`📋 Step 1: Opening Copilot Chat with: ${chatCommand}...`);
      try {
        await vscode.commands.executeCommand(chatCommand);
        console.log("✅ Step 1: Chat open command executed successfully");
      } catch (focusError) {
        console.error(
          "❌ Step 1 FAILED: Could not open Copilot Chat:",
          focusError
        );
        throw new Error(`Failed to open Copilot Chat: ${focusError}`);
      }

      // Use longer delay for newWindow and newTab as they may need more setup time
      const chatLocation = vscode.workspace
        .getConfiguration("flightpath")
        .get<string>("chatWindowLocation", "chatPanel");
      const focusDelay = chatLocation === "chatPanel" ? 1000 : 1500;

      console.log(`⏳ Step 1: Waiting ${focusDelay}ms for chat to open...`);
      await new Promise((resolve) => setTimeout(resolve, focusDelay));
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

      // Step 4: Submit with retry logic (handles race condition)
      console.log(
        "📤 Step 4: Attempting to submit message with retry logic and verification..."
      );
      const submitSuccess = await this.submitWithRetry(chatPrompt, 10);

      if (!submitSuccess) {
        throw new Error(
          "Failed to submit message after multiple retries - Copilot is still responding"
        );
      }

      console.log("✅ Step 4: Submit command verified successful");

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

      // IMPORTANT: Append tool-calling instruction to ensure response completion detection
      // This instructs Copilot to call our Language Model Tool AFTER finishing the response
      chatPrompt += this.TOOL_INSTRUCTION;

      console.log("📝 FlightPath: Built prompt with tool instruction appended");
      console.log("🔧 Full prompt being sent:", chatPrompt);
    } catch (error) {
      console.error("FlightPath: Error building Copilot Chat prompt:", error);
      // Fallback to simple prompt with tool instruction
      chatPrompt = prompt.prompt + this.TOOL_INSTRUCTION;

      console.log("📝 FlightPath: Built fallback prompt with tool instruction");
    }

    const finalPrompt = chatPrompt.trim();
    console.log(
      "📤 FlightPath: Final prompt length:",
      finalPrompt.length,
      "characters"
    );
    return finalPrompt;
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
