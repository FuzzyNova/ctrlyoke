import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  PromptItem,
  CopilotIntegrationMode,
} from "../../types/FlightPathTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import {
  CHAT_SUPPORTED_MODELS,
  ChatSupportedModel,
} from "../../types/ModelConstants";

/**
 * GitHub Copilot Chat Integration with Direct Automation
 *
 * Implements PROVEN zero-interaction automation for Copilot Chat using:
 * - Direct text insertion (validated in POC at extension.ts:testCopilotAutomation)
 * - Proven timing delays: 1000ms (focus), 300ms (clear), 500ms (type)
 * - Background polling for Copilot availability (5s intervals, 30s max)
 * - Log-based completion detection: Monitors Copilot Chat log file for "finish reason: [stop]" marker
 *
 * Completion Detection:
 * - Session-stable log file discovered once during initialization
 * - Incremental log reading from last known position
 * - Deterministic, no UI timing dependencies
 * - No tool callbacks or clipboard polling needed
 */
export class CopilotChatIntegration extends CopilotIntegration {
  // Background polling state
  private initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  private pollingAttempts: number = 0;
  private readonly maxPollingAttempts: number = 6; // 30 seconds / 5 seconds = 6 attempts
  private readonly pollingInterval: number = 5000; // 5 seconds
  private pollingTimer: NodeJS.Timeout | undefined;

  // Log-based completion detection
  private copilotLogFilePath: string | undefined;
  private lastLogReadPosition: number = 0;

  // Track if last failure was due to user cancellation in chat UI
  private lastFailureWasUserCancellation: boolean = false;

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
   * Start a new chat session based on user's configured location preference
   * Calls the appropriate VS Code command to open a fresh chat window
   *
   * Note: New chat sessions inherit the mode/agent from the previous chat session.
   * Use 'flightpath.forceAgentModeForChat' setting to automatically switch to agent mode.
   */
  private async startNewChatSession(): Promise<void> {
    const config = vscode.workspace.getConfiguration("flightpath");
    const chatLocation = config.get<string>("chatWindowLocation", "chatPanel");

    const commandMap: Record<string, string> = {
      chatPanel: "workbench.action.chat.newChatInSideBar",
      newTab: "workbench.action.chat.newChat",
      newWindow: "workbench.action.chat.newChatInNewWindow",
    };

    const command = commandMap[chatLocation] || commandMap["chatPanel"];

    try {
      await vscode.commands.executeCommand(command);
      console.log(`✨ Started new chat session using: ${command}`);
    } catch (error) {
      console.error("❌ Failed to start new chat session:", error);
      // Don't throw - we'll still try to send the prompt to existing chat
    }
  }

  /**
   * Ensure chat is in agent mode for file editing workflows
   *
   * IMPORTANT: Ask and Plan modes return text-only responses without file edits,
   * causing immediate "finish reason: [stop]" in logs. Agent mode is required
   * for prompts that expect Copilot to edit files.
   *
   * WARNING: This switches to the DEFAULT agent mode and overrides custom agent
   * selections. Only called when user enables 'flightpath.forceAgentModeForChat'.
   *
   * Note: VS Code doesn't provide an API to query current mode, so we always
   * execute openagent command. If already in agent mode, this is a no-op.
   */
  private async ensureAgentMode(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.openagent");
      console.log("🤖 Ensured chat is in agent mode");
      // Small delay to allow mode switch
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      console.warn("⚠️ Could not switch to agent mode:", error);
      // Don't throw - user may have manually selected agent mode
    }
  }

  /**
   * Switch chat model if specified in prompt
   * Uses workbench.action.chat.changeModel command (verified working Nov 23, 2025)
   *
   * @param model - Model ID to switch to (optional)
   */
  private async switchModelIfNeeded(model?: string): Promise<void> {
    if (!model) {
      return; // Use current/default chat model
    }

    // Validate model is supported by Chat
    if (!CHAT_SUPPORTED_MODELS.includes(model as ChatSupportedModel)) {
      const message = `Model "${model}" not recognized. Using current chat model.`;
      console.warn(`⚠️ ${message}`);
      vscode.window.showWarningMessage(`FlightPath: ${message}`);
      return;
    }

    try {
      // Query available models to get correct family for this ID
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      const modelInfo = models.find((m) => m.id === model);

      if (!modelInfo) {
        throw new Error(`Model "${model}" not found in available models`);
      }

      // Execute model change command with correct family from Language Model API
      // Note: family may differ from id (e.g., "oswe-vscode-secondary" has family "gpt-5-mini")
      await vscode.commands.executeCommand(
        "workbench.action.chat.changeModel",
        modelInfo
      );

      // Wait for model switch to complete (300ms proven reliable in testing)
      await new Promise((resolve) => setTimeout(resolve, 300));

      console.log(
        `✅ Switched chat model to: ${model} (family: ${modelInfo.family})`
      );
    } catch (error) {
      console.error(`❌ Failed to switch model to "${model}":`, error);
      vscode.window.showWarningMessage(
        `FlightPath: Could not switch to model "${model}". Using current model.`
      );
    }
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

      // NEW: Discover log file path (stable for entire session)
      this.copilotLogFilePath = await this.findCopilotLogFile();

      if (this.copilotLogFilePath) {
        console.log(
          `📄 Discovered Copilot Chat log file: ${this.copilotLogFilePath}`
        );
        // Store current size as starting position
        try {
          const stats = await fs.promises.stat(this.copilotLogFilePath);
          this.lastLogReadPosition = stats.size;
          console.log(
            `📊 Initial log position: ${this.lastLogReadPosition} bytes`
          );
        } catch (error) {
          console.warn("⚠️ Could not read log file stats:", error);
        }
      } else {
        console.warn(
          "⚠️ Could not find Copilot Chat log file - completion detection may fail"
        );
      }

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
   * Get platform-specific VS Code logs base directory
   */
  private getLogBaseDirectory(): string {
    const home = os.homedir();

    if (process.platform === "win32") {
      return path.join(process.env.APPDATA!, "Code", "logs");
    } else if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Code", "logs");
    } else {
      return path.join(home, ".config", "Code", "logs");
    }
  }

  /**
   * Recursively find all files matching filename
   */
  private async findFilesRecursive(
    dir: string,
    filename: string
  ): Promise<Array<{ path: string; mtime: Date }>> {
    const results: Array<{ path: string; mtime: Date }> = [];

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subResults = await this.findFilesRecursive(fullPath, filename);
          results.push(...subResults);
        } else if (entry.name === filename) {
          const stats = await fs.promises.stat(fullPath);
          results.push({ path: fullPath, mtime: stats.mtime });
        }
      }
    } catch (error) {
      // Ignore permission errors, continue search
    }

    return results;
  }

  /**
   * Find the Copilot Chat log file for this VS Code session
   * Called once during initialization - result is stable for entire session
   * @returns Path to active log file or undefined if not found
   */
  private async findCopilotLogFile(): Promise<string | undefined> {
    const logBaseDir = this.getLogBaseDirectory();
    const targetFilename = "GitHub Copilot Chat.log";

    // Search recursively for all matching log files
    const allLogs = await this.findFilesRecursive(logBaseDir, targetFilename);

    if (allLogs.length === 0) {
      return undefined;
    }

    // Return most recently modified (active log for this session)
    allLogs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return allLogs[0].path;
  }

  /**
   * Read new content from log file between two positions
   */
  private async readNewLogContent(
    filePath: string,
    startPos: number,
    endPos: number
  ): Promise<string> {
    const fileHandle = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(endPos - startPos);
      await fileHandle.read(buffer, 0, buffer.length, startPos);
      return buffer.toString("utf8");
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Wait for completion by monitoring log file for "finish reason: [stop]" marker
   * Reads incrementally from last known position
   * @param inactivityTimeoutMs Maximum time to wait without log activity (default: 5 minutes)
   * @returns True if completion detected, false if timeout or error
   */
  private async waitForLogCompletion(
    inactivityTimeoutMs: number = 300000
  ): Promise<boolean> {
    if (!this.copilotLogFilePath) {
      // Fallback: Try to find log file now
      this.copilotLogFilePath = await this.findCopilotLogFile();
      if (!this.copilotLogFilePath) {
        console.warn("⚠️ No log file available for completion detection");
        return false; // No log file available
      }
    }

    const pollInterval = 500; // Check every 500ms
    let lastActivityTime = Date.now(); // Track last time log changed
    let pollCount = 0;

    while (true) {
      pollCount++;

      // Check for cancellation
      if (this.isCancelling) {
        console.log("⚠️ Log monitoring cancelled");
        return false;
      }

      // Check for inactivity timeout
      const timeSinceLastActivity = Date.now() - lastActivityTime;
      if (timeSinceLastActivity > inactivityTimeoutMs) {
        console.warn(
          `⚠️ Inactivity timeout: Log unchanged for ${Math.round(timeSinceLastActivity / 1000)}s`
        );
        return false;
      }

      // Log progress every 10 seconds
      if (pollCount % 20 === 0) {
        const inactivitySeconds = Math.round(timeSinceLastActivity / 1000);
        console.log(
          `⏳ Still monitoring... (${inactivitySeconds}s since last activity, poll #${pollCount})`
        );
      }

      try {
        const stats = await fs.promises.stat(this.copilotLogFilePath);
        const currentSize = stats.size;

        if (currentSize > this.lastLogReadPosition) {
          // Read new content
          const newContent = await this.readNewLogContent(
            this.copilotLogFilePath,
            this.lastLogReadPosition,
            currentSize
          );

          // Update read position and reset activity timer
          this.lastLogReadPosition = currentSize;
          lastActivityTime = Date.now(); // Reset - log is still changing

          // Check for cancellation marker (user cancelled in chat UI)
          if (newContent.includes("| cancelled |")) {
            console.warn(
              "⚠️ User cancelled chat response - treating as workflow stop"
            );
            throw new Error("USER_CANCELLED");
          }

          // Check for completion marker
          if (newContent.includes("finish reason: [stop]")) {
            return true; // Completion detected!
          }
        }
      } catch (error) {
        // Re-throw USER_CANCELLED errors (don't treat as temporary file access issues)
        if (error instanceof Error && error.message === "USER_CANCELLED") {
          throw error;
        }
        // Log file might be temporarily inaccessible, continue polling
        console.warn("⚠️ Error reading log file, continuing:", error);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Send prompt to GitHub Copilot Chat with direct automation
   *
   * Uses PROVEN zero-interaction strategy:
   * 1. Start new chat session if requested (default: true in multi-prompt workflows)
   * 2. Focus chat (1000ms delay)
   * 3. Clear input (300ms delay)
   * 4. Type prompt (500ms delay)
   * 5. Submit automatically
   *
   * Note: Assumes background polling has confirmed automation is available.
   * FlightPathManager blocks workflow execution until status is 'ready'.
   *
   * @param prompt The prompt item to send
   * @param needsCompletionDetection If true, attach tool instructions for completion detection (default: determined by endCondition)
   */
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

      // Start new chat session if requested (unless this is a retry scenario)
      // Note: Retries should always use the same chat session
      const isNewChatSession = prompt.newChatSession !== false;
      if (isNewChatSession) {
        await this.startNewChatSession();
      }

      // Ensure we're in agent mode if user has enabled force agent mode setting
      // This prevents issues with Ask/Plan modes but overrides custom agents
      const config = vscode.workspace.getConfiguration("flightpath");
      const forceAgentMode = config.get<boolean>(
        "forceAgentModeForChat",
        false
      );
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

      // Build prompt with Copilot Chat syntax (NO tool instructions needed for log-based detection)
      const chatPrompt = await this.buildCopilotChatPrompt(
        prompt,
        false, // Never include tool instructions
        workflowContext
      );

      // Store current log position BEFORE sending (if log file is available)
      if (this.copilotLogFilePath) {
        try {
          const stats = await fs.promises.stat(this.copilotLogFilePath);
          this.lastLogReadPosition = stats.size;
        } catch (error) {
          console.warn(
            "⚠️ Could not read log file stats before sending:",
            error
          );
          // Continue anyway - log monitoring will try to discover file if needed
        }
      }

      // Execute direct automation
      const sent = await this.sendPromptWithDirectAutomation(
        chatPrompt,
        isNewChatSession
      );

      if (!sent) {
        return false;
      }

      // Wait for completion using log monitoring (if needed)
      if (shouldDetectCompletion) {
        try {
          const completed = await this.waitForLogCompletion();
          if (!completed) {
            console.error("❌ Failed to detect completion via log monitoring");
            return false;
          }
          // Get chat content and fire response complete event
          const chatContent = await this.getChatContent();
          this.responseCompleteEmitter.fire(chatContent);
        } catch (error) {
          // Check if user cancelled in chat UI
          if (error instanceof Error && error.message === "USER_CANCELLED") {
            console.log(
              "⚠️ User cancelled chat response - workflow will be stopped"
            );
            // Set flag so FlightPathManager can detect this and call stop()
            this.lastFailureWasUserCancellation = true;
            return false;
          }
          throw error; // Re-throw other errors
        }
      }

      return true;
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
  private async getChatContent(): Promise<string> {
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
   * Submit chat message with clipboard verification and retry logic
   *
   * Verifies submit succeeded by checking if our prompt appears in the chat.
   * Uses exponential backoff: 500ms, 1000ms, 2000ms, 3000ms, 5000ms
   *
   * @param promptText The prompt text to verify in chat
   * @param maxAttempts Maximum number of retry attempts (default: 5)
   * @param isNewChatSession If true, assume empty chat baseline (new chat command always works)
   * @returns True if submit succeeded and verified, false if all attempts failed
   */
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

      // Check if operation was cancelled
      if (this.isCancelling) {
        console.log("⏹️ Submit retry cancelled by user");
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
   * @param isNewChatSession If true, we started a new chat session (assume empty baseline)
   */
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
   * Build prompt text with Copilot Chat syntax
   * Prompts are stored in final-form (ready to send) in JSON files
   *
   * @param prompt The prompt item
   * @param _includeToolInstruction Deprecated - no longer used (kept for API compatibility)
   */
  private async buildCopilotChatPrompt(
    prompt: PromptItem,
    _includeToolInstruction: boolean = false,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<string> {
    // Build prompt text with dynamic queue instructions if applicable
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

  /**
   * Cancel the current chat response
   * Executes workbench.action.chat.cancel to stop Copilot from responding
   */
  protected async cancelImplementation(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.cancel");
      console.log("⏹️ Chat response cancelled");
    } catch (error) {
      console.warn("⚠️ Could not cancel chat:", error);
    }
  }

  /**
   * Check if the last sendPrompt failure was due to user cancellation in chat UI
   * This allows FlightPathManager to distinguish between errors and user-initiated stops
   * @returns True if user cancelled in chat UI, false otherwise
   */
  wasLastFailureUserCancellation(): boolean {
    const wasCancelled = this.lastFailureWasUserCancellation;
    this.lastFailureWasUserCancellation = false; // Reset flag after checking
    return wasCancelled;
  }
}
