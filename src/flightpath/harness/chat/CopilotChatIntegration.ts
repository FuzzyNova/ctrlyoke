import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import {
  PromptStep,
  type UserHookConfig,
} from "../../../types/FlightPathTypes";
import {
  HARNESS_IDS,
  TEMP_FILE_CATEGORIES,
} from "../../../types/DashboardConstants";
import { HarnessIntegration, HarnessStatus } from "../../HarnessIntegration";
import { isModelAvailable } from "../../../utils/ModelRegistry";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { ChatSessionMonitor } from "./ChatSessionMonitor";
import { ChatSessionParser } from "./ChatSessionParser";
import { NativeAttachmentHandler } from "./NativeAttachmentHandler";
import { Log } from "../../../utils/Log";
import {
  PromptFileSplitter,
  type SplitConfig,
} from "../../../utils/PromptFileSplitter";
import { TempFileManager } from "../../../utils/TempFileManager";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { AgentExpander } from "../../../utils/AgentExpander";
import { CliOutputFormatter } from "../shared/CliOutputFormatter";
import { UniversalCliOutput } from "../../../types/CliOutputTypes";
import { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type { PromptSections } from "../../HarnessIntegration";
import { CopilotNotificationMonitor } from "../copilot/CopilotNotificationMonitor";
import { parseInlinePriorContextRefs } from "../../../utils/FileReferenceParser";

/**
 * GitHub Copilot Chat Integration - UI automation with session file monitoring.
 * See flightpath-chat.instructions.md for implementation details.
 *
 * Completion Detection:
 * - Session file monitoring (100% reliable) - Method 5 from CHAT_COMPLETION_DETECTION.md
 * - Monitors VS Code's internal chatSessions/*.json files for completion indicators
 */
export class CopilotChatIntegration extends HarnessIntegration {
  // Background polling state
  private initializationStatus: HarnessStatus = HarnessStatus.Initializing;
  private pollingAttempts: number = 0;
  private readonly maxPollingAttempts: number = 6;
  private readonly pollingInterval: number = 5000;
  private pollingTimer: NodeJS.Timeout | undefined;

  // Extracted components
  private sessionMonitor: ChatSessionMonitor;
  private sessionParser: ChatSessionParser;
  private attachmentHandler: NativeAttachmentHandler;

  // Track if last failure was due to user cancellation in chat UI
  private lastFailureWasUserCancellation: boolean = false;

  // Last parsed structured output (populated after each completed response)
  private lastParsedOutput?: UniversalCliOutput;

  // Temp file paths created during prompt building (for cleanup after execution)
  private pendingTempFiles: string[] = [];

  // Hook files written to .github/hooks/ for the current prompt (cleaned up after execution)
  private hookFilePaths: string[] = [];
  /** Path to temporary .gitignore written in .github/hooks/ to hide FlightPath files from git. */
  private hooksDirGitignorePath: string | undefined;

  constructor(
    context: vscode.ExtensionContext,
    registerWithContext: boolean = true
  ) {
    super(context, registerWithContext);
    this.sessionMonitor = new ChatSessionMonitor(context);
    this.sessionParser = new ChatSessionParser();
    this.attachmentHandler = new NativeAttachmentHandler((path) =>
      this.resolveWorkspacePath(path)
    );
  }

  /**
   * Get the appropriate VS Code command for the configured chat window location.
   * Single source of truth for chat location → VS Code command mapping.
   *
   * @param purpose 'focus' to open/focus existing chat, 'new' to start a new chat session
   */
  private getChatCommand(purpose: "focus" | "new"): string {
    const chatLocation = ConfigurationUtils.getChatWindowLocation();

    const commandMap: Record<string, Record<string, string>> = {
      focus: {
        chatPanel: "workbench.panel.chat.view.copilot.focus",
        newTab: "workbench.action.chat.openInEditor",
        newWindow: "workbench.action.chat.openInNewWindow",
      },
      new: {
        chatPanel: "workbench.action.chat.newLocalChat",
        newTab: "workbench.action.chat.newChat",
        newWindow: "workbench.action.chat.openInNewWindow",
      },
    };

    return (
      commandMap[purpose][chatLocation] || commandMap[purpose]["chatPanel"]
    );
  }

  /** Get the VS Code command for opening Copilot Chat based on user settings */
  private getChatWindowCommand(): string {
    return this.getChatCommand("focus");
  }

  /** Start a new chat session. Mode/agent inherited from previous session. */
  private async startNewChatSession(): Promise<void> {
    const command = this.getChatCommand("new");

    try {
      await vscode.commands.executeCommand(command);
      Log.debug(
        `✨ New chat session: ${ConfigurationUtils.getChatWindowLocation()}`
      );
    } catch (error) {
      Log.error("❌ Failed to start new chat:", error);
      // Don't throw - we'll still try to send the prompt to existing chat
    }
  }

  /** Switch to agent mode (required for file editing, overrides custom agents) */
  private async ensureAgentMode(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.openagent");
      Log.debug("🤖 Agent mode enabled");
      // Small delay to allow mode switch
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      Log.warn("⚠️ Could not switch to agent mode:", error);
      // Don't throw - user may have manually selected agent mode
    }
  }

  /**
   * Open a new chat session for a specific agent.
   *
   * VS Code/Copilot registers a command per discovered agent using the frontmatter
   * `name:` field, not the filename:
   *   `workbench.action.chat.open<frontmatterName>`
   * e.g., `workbench.action.chat.openSenior Developer` (name from frontmatter)
   *
   * Falls back to generic agent mode if the agent-specific command doesn't exist.
   */
  private async openAgentSpecificChat(agentName: string): Promise<boolean> {
    // VS Code registers commands using the frontmatter `name:` field, not the filename.
    // E.g., senior-developer.agent.md with `name: Senior Developer` → openSenior Developer
    const commandName = await AgentExpander.getAgentCommandName(
      agentName,
      this.getWorkspaceRoot()
    );
    const agentCommand = `workbench.action.chat.open${commandName}`;

    try {
      // Check if the agent-specific command exists
      const commands = await vscode.commands.getCommands();
      if (commands.includes(agentCommand)) {
        await vscode.commands.executeCommand(agentCommand);
        Log.info(`🤖 Opened agent-specific chat: ${commandName}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return true;
      } else {
        Log.warn(
          `⚠️ Agent command "${agentCommand}" not found, falling back to generic agent mode`
        );
        return false;
      }
    } catch (error) {
      Log.warn(
        `⚠️ Could not open agent-specific chat for "${agentName}":`,
        error
      );
      return false;
    }
  }

  /** Get the default model from settings */
  private getDefaultModel(): string {
    return ConfigurationUtils.getCopilotChatModel();
  }

  /**
   * Use smaller file limits for Copilot Chat to prevent auto-summarization.
   * Copilot summarizes attached files that exceed a certain size, which can
   * strip the prompt text (always at the end) and lose critical context.
   * Attachment-boundary splitting ensures attachment blocks are never cut mid-way.
   */
  protected override getTempFileSplitConfig(): SplitConfig {
    return {
      maxTokensPerFile: 8000,
      maxLinesPerFile: 600,
      minChunkSize: 1000,
      splitOnAttachmentBoundaries: true,
    };
  }

  /** Resolve workspace root for chat-mode file expansion/attachments. */
  protected override getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Preserve VS Code status-bar progress updates for chat harness. */
  protected override async updateWorkflowProgress(): Promise<void> {
    if (this.totalSteps > 0) {
      const progress = `${this.workflowStep}/${this.totalSteps}`;
      vscode.window.setStatusBarMessage(
        `$(compass-dot) FlightPath: Step ${progress} completed`,
        3000
      );
    }
  }

  /** Switch chat model - always switches to ensure consistency with CLI modes */
  private async switchModelIfNeeded(model?: string): Promise<void> {
    // Use prompt model if specified, otherwise use setting default
    const targetModel = model || this.getDefaultModel();

    // Validate model is available (using dynamically discovered models)
    if (!isModelAvailable(targetModel)) {
      const message = `Model "${targetModel}" not recognized. Using current chat model.`;
      Log.warn(`⚠️ ${message}`);
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

      Log.info(`✅ Model: ${targetModel}`);
    } catch (error) {
      Log.error(`❌ Model switch failed (${targetModel}):`, error);
      vscode.window.showWarningMessage(
        `FlightPath: Could not switch to model "${targetModel}". ` +
          `This model may not be available on your subscription. ` +
          `Using current model instead. You can change the default in Settings.`
      );
    }
  }

  /** Dispose event emitters and cancel any in-flight polling timer */
  override dispose(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    super.dispose();
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
            Log.warn("⚠️ Could not activate Copilot Chat:", activationError);
          }
        }

        if (copilotExtension && !copilotExtension.isActive) {
          try {
            await copilotExtension.activate();
          } catch (activationError) {
            Log.warn("⚠️ Could not activate Copilot:", activationError);
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
        Log.info("✅ Chat automation ready");
      } else {
        Log.error("❌ Required commands unavailable");
      }
    } catch (error) {
      Log.error("❌ Error checking Copilot availability:", error);
      this.isAvailable = false;
    }
  }

  /** Start background polling for Copilot availability */
  private async startBackgroundPolling(): Promise<void> {
    this.pollingAttempts = 0;
    this.initializationStatus = HarnessStatus.Initializing;
    this.statusChangeEmitter.fire(HarnessStatus.Initializing);

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
      Log.info("✅ Copilot ready");

      // Initialize session monitor for completion detection
      await this.sessionMonitor.initialize();

      this.initializationStatus = HarnessStatus.Ready;
      this.statusChangeEmitter.fire(HarnessStatus.Ready);

      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = undefined;
      }
      return;
    }

    if (this.pollingAttempts >= this.maxPollingAttempts) {
      Log.error("❌ Copilot unavailable (30s timeout)");
      this.initializationStatus = HarnessStatus.Unavailable;
      this.statusChangeEmitter.fire(HarnessStatus.Unavailable);

      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = undefined;
      }
      return;
    }

    // Continue polling
    this.initializationStatus = HarnessStatus.Waiting;
    this.statusChangeEmitter.fire(HarnessStatus.Waiting);

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
    prompt: PromptStep,
    needsCompletionDetection?: boolean,
    workflowContext?: WorkflowContext
  ): Promise<boolean> {
    try {
      // Reset cancellation flag for new prompt
      this.resetCancellationFlag();

      // Verify automation is still available
      if (!this.isAvailable) {
        Log.error("❌ Automation became unavailable");
        vscode.window.showErrorMessage(
          "FlightPath: Automation became unavailable"
        );
        return false;
      }

      // Use resolved properties if available (from PropertyResolver three-tier precedence)
      const resolvedModel = workflowContext?.resolvedProperties?.model;
      const resolvedResumeSession =
        workflowContext?.resolvedProperties?.resumeSession;

      // Resolve agent for this prompt (needed for agent-specific chat windows)
      const resolvedAgent = workflowContext?.resolvedProperties?.agent;
      const useNativeAttachments =
        ConfigurationUtils.shouldUseChatNativeAttachments();

      // Start new chat session if NOT resuming
      // Use resolved property if available, otherwise fall back to prompt property
      const shouldStartNewSession = !(
        resolvedResumeSession ??
        prompt.resumeSession ??
        false
      );
      if (shouldStartNewSession) {
        Log.info("🆕 Starting new chat session");

        // When using native attachments and an agent is selected, open the
        // agent-specific chat window (e.g., workbench.action.chat.openflightpath-orchestrator)
        // so Copilot automatically applies that agent's instructions.
        let openedAgentChat = false;
        if (useNativeAttachments && resolvedAgent) {
          openedAgentChat = await this.openAgentSpecificChat(resolvedAgent);
        }

        if (!openedAgentChat) {
          await this.startNewChatSession();
        }

        // Clear session tracking so we search for the new session
        this.sessionMonitor.resetSession();
      } else {
        Log.info("♻️ Resuming existing chat session");
      }

      // Ensure we're in agent mode if user has enabled force agent mode setting
      // This prevents issues with Ask/Plan modes but overrides custom agents
      const forceAgentMode = ConfigurationUtils.shouldForceAgentModeForChat();
      if (forceAgentMode && !useNativeAttachments) {
        // Only force generic agent mode when NOT using native attachments
        // (native attachments flow uses agent-specific commands instead)
        await this.ensureAgentMode();
      }

      // Switch model if specified - use resolved property if available
      await this.switchModelIfNeeded(resolvedModel);

      // Determine if completion detection is needed:
      // - If explicitly provided, use that value
      // - Otherwise, check if prompt has endCondition with script (requires completion detection)
      const shouldDetectCompletion =
        needsCompletionDetection !== undefined
          ? needsCompletionDetection
          : !!prompt.endCondition?.script;

      // Write user-defined hooks to .github/hooks/ before the session starts
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const userHooks = workflowContext?.resolvedProperties?.hooks;
      if (userHooks && userHooks.length > 0 && workspaceRoot) {
        await this.writeUserHookFile(
          workspaceRoot,
          workflowContext!.promptIndex,
          workflowContext!.filePath,
          userHooks
        );
      }

      // Build full prompt (what we'll type into chat)
      const chatPrompt = await this.buildCopilotChatPrompt(
        prompt,
        workflowContext,
        !shouldStartNewSession
      );

      // Determine what text appears in session files so we can verify submission.
      // When using temp files, the session file stores the short instruction
      // ("Follow instructions in prompt.md"), not the raw user prompt (which
      // is inside the temp file). For inline prompts, session files strip XML
      // tags so we match on the raw user text.
      const sessionSearchText =
        this.pendingTempFiles.length > 0
          ? chatPrompt.trim()
          : prompt.prompt.trim();

      // Record session position before send (used by ChatSessionMonitor)
      await this.sessionMonitor.recordPositionBeforeSend(sessionSearchText);

      // Execute direct automation - type full prompt, verify with session search text
      const sent = await this.sendPromptWithDirectAutomation(
        chatPrompt,
        sessionSearchText,
        shouldStartNewSession
      );

      if (!sent) {
        return false;
      }

      // Wait for completion using session monitoring (if needed)
      if (shouldDetectCompletion) {
        const inactivityTimeoutMs =
          ConfigurationUtils.getChatInactivityTimeoutMs();

        Log.debug("🔍 Monitoring session file for completion...");
        const result = await this.sessionMonitor.waitForCompletion(
          () => this.isCancelling,
          inactivityTimeoutMs
        );

        if (result.userCancelled) {
          Log.info("⚠️ User cancelled - stopping workflow");
          this.lastFailureWasUserCancellation = true;
          await this.cleanupTempFiles();
          return false;
        }

        if (!result.completed) {
          // Check if this was a timeout that should be treated as success
          const isTimeout = result.failureReason?.includes("timeout");
          const treatTimeoutAsSuccess =
            ConfigurationUtils.shouldTreatChatTimeoutAsSuccess();

          if (isTimeout && treatTimeoutAsSuccess) {
            Log.warn(
              "⚠️ Timeout - treating as successful completion (treatChatTimeoutAsSuccess=true)"
            );
            // Proceed as if completed - extract session output and fire event
            const responseText = await this.extractSessionOutput();
            this.responseCompleteEmitter.fire(responseText);
            await this.cleanupTempFiles();
            return true;
          }

          Log.error("❌ Completion detection failed");
          if (result.failureReason) {
            this.lastFailureReason = result.failureReason;
          }
          await this.cleanupTempFiles();
          return false;
        }

        // Extract session output and fire event
        const responseText = await this.extractSessionOutput();
        this.responseCompleteEmitter.fire(responseText);
      }

      await this.cleanupTempFiles();
      return true;
    } catch (error) {
      Log.error("❌ Failed to send prompt:", error);
      if (!this.lastFailureReason) {
        this.lastFailureReason =
          error instanceof Error
            ? error.message
            : "Failed to send prompt to Copilot";
      }
      vscode.window.showErrorMessage(
        `FlightPath: Failed to send prompt: ${error}`
      );
      await this.cleanupTempFiles();
      return false;
    }
  }

  /**
   * Extract session output from session file
   * Replaces unreliable clipboard-based approach with session file parsing.
   * Session files are the single source of truth for Chat responses.
   */
  private async extractSessionOutput(): Promise<string> {
    try {
      const sessionFile = this.sessionMonitor.getSessionFile();
      if (!sessionFile) {
        Log.error("❌ No session file found");
        return "";
      }

      // Validate session file exists
      if (!this.sessionParser.isValidSessionFile(sessionFile)) {
        Log.error(`❌ Invalid session file: ${sessionFile}`);
        return "";
      }

      // Parse session file for structured output
      const output = this.sessionParser.extractResponse(sessionFile);

      if (output.events.length === 0) {
        Log.warn("⚠️ Session file has no response events");
        return "";
      }

      // Store structured output for getLastParsedOutput() (used by WorkflowExecutor)
      this.lastParsedOutput = output;

      // Format for output window (plain text)
      const formattedText = CliOutputFormatter.toPlainText(output);

      Log.debug(
        `📋 Extracted response: ${formattedText.length} chars, ${output.events.length} events`
      );

      return formattedText;
    } catch (error) {
      Log.error("❌ Failed to extract session output:", error);
      return "";
    }
  }

  /**
   * Submit with exponential backoff retry and session file verification
   *
   * Session file verification is 100% reliable vs unreliable clipboard approach.
   * Uses RetryUtils defaults: 15 attempts over ~18 seconds for robust verification.
   */
  private async submitWithRetry(promptText: string): Promise<boolean> {
    const normalizedPrompt = promptText.trim().substring(0, 60);
    Log.debug(`🔍 Verifying submission for prompt: "${normalizedPrompt}..."`);

    const result = await retryWithBackoff(
      async () => {
        // Check for cancellation
        if (this.isCancelling) {
          Log.info("⏹️ Cancelled during submit retry");
          return false; // Stop retrying
        }

        // Execute submit command
        await vscode.commands.executeCommand("workbench.action.chat.submit");

        // Wait for UI to process
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify submission by searching for our prompt in session files
        // Searches ALL files sorted by newest first - handles both:
        // 1. Resumed sessions from any age (user might resume chat from weeks ago)
        // 2. Duplicate prompts (most recently modified session wins)
        // VS Code updates file mtime when writing, so active sessions float to top
        const sessionFile =
          this.sessionMonitor.findSessionFileByPromptText(promptText);

        if (sessionFile) {
          Log.debug(
            `✅ Submit verified via session file: ${path.basename(sessionFile)}`
          );
          // Cache session file so waitForCompletion() doesn't re-search
          this.sessionMonitor.setSessionFile(sessionFile);
          return sessionFile; // Success
        }

        // Submit didn't work, return null to trigger retry
        return null;
      },
      {
        // Use defaults: maxAttempts=60, delays=[100,200,500,1000,1500] (~84s total)
        // VS Code can take 45+ seconds to write session files, so we need long retry window
        onRetry: (attempt, maxAttempts) => {
          if (attempt % 5 === 0 || attempt <= 3) {
            Log.warn(
              `⚠️ Submit verification failed, retrying (${attempt}/${maxAttempts}) — prompt: "${normalizedPrompt}..."`
            );
          }
        },
      }
    );

    if (!result) {
      Log.error("❌ Submit failed after all retry attempts");
      return false;
    }

    return true;
  }

  /**
   * Execute direct automation: focus, clear, type, submit. Timing validated.
   *
   * @param chatPrompt Full prompt with XML tags to type into chat
   * @param rawPromptText Raw user prompt without XML (for session file verification)
   * @param isNewChatSession Whether this is a new chat session
   */
  private async sendPromptWithDirectAutomation(
    chatPrompt: string,
    rawPromptText: string,
    _isNewChatSession: boolean = true
  ): Promise<boolean> {
    try {
      // Step 1: Open/Focus Copilot Chat using configured location
      const chatCommand = this.getChatWindowCommand();
      try {
        await vscode.commands.executeCommand(chatCommand);
      } catch (focusError) {
        Log.error("❌ Could not open Copilot Chat:", focusError);
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
        Log.error("❌ Could not select all text:", selectError);
        throw new Error(`Failed to select all: ${selectError}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 300)); // PROVEN: 300ms required

      // Step 3: Paste the prompt into chat input.
      // IMPORTANT: Do NOT use `vscode.commands.executeCommand("type", ...)` for large prompts.
      // The `type` command fires individual input events per character — with 230KB+ of context
      // attachments this deadlocks the VS Code extension host completely.
      // Clipboard paste is instant regardless of content size.
      const promptSizeKb = (
        Buffer.byteLength(chatPrompt, "utf8") / 1024
      ).toFixed(1);
      Log.debug(
        `[Chat] Step 3: pasting prompt into chat input (${promptSizeKb} KB)`
      );
      const previousClipboard = await vscode.env.clipboard.readText();
      try {
        await vscode.env.clipboard.writeText(chatPrompt);
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction"
        );
        Log.debug(`[Chat] Step 3: paste complete`);
      } catch (pasteError) {
        Log.error("❌ Could not paste text:", pasteError);
        throw new Error(`Failed to paste text: ${pasteError}`);
      } finally {
        await vscode.env.clipboard.writeText(previousClipboard);
      }

      await new Promise((resolve) => setTimeout(resolve, 500)); // PROVEN: 500ms required

      // Step 4: Submit with retry logic and session file verification
      // Use raw prompt text (without XML) for session file matching
      const submitSuccess = await this.submitWithRetry(rawPromptText);

      if (!submitSuccess) {
        if (this.isCancelling) {
          return false; // Graceful stop — no error
        }
        throw new Error(
          "Failed to submit message after multiple retries - prompt not found in session files"
        );
      }

      // Update workflow progress
      await this.updateWorkflowProgress();

      return true;
    } catch (error) {
      Log.error("❌ Direct automation failed:", error);

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

  /**
   * Override to handle two chat-specific prompt building strategies:
   *
   * **useNativeAttachments=true** (opt-in):
   *   Uses VS Code's native `attachFile`/`attachSelection` commands for clean UI.
   *   Agent is handled via agent-specific chat window commands (see openAgentSpecificChat).
   *   Skills are written to a temp file and attached (no native VS Code skills API).
   *
   * **useNativeAttachments=false** (default):
   *   Creates categorized typed temp files (agent, skills, excerpts, prompt),
   *   attaches them to chat, and returns a structured instruction string.
   *   This gives a uniform experience matching CLI harnesses.
   */
  private async buildPromptText(
    prompt: PromptStep,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ): Promise<string> {
    const useNativeAttachments =
      ConfigurationUtils.shouldUseChatNativeAttachments();

    if (useNativeAttachments) {
      // Native path: attachment handler handles @path refs and line selections.
      // Agent is handled by openAgentSpecificChat. Skills written to temp file.
      const sections = await this.buildPromptSections(
        prompt,
        undefined,
        resolvedSkills
      );
      const processedPrompt = await this.attachmentHandler.processAttachments(
        prompt.prompt
      );
      if (sections.skillContent) {
        await this.attachSkillsAsTempFile(sections.skillContent);
      }
      return processedPrompt;
    }

    // Non-native path: categorized typed temp files
    const sections = await this.buildPromptSections(
      prompt,
      resolvedAgent,
      resolvedSkills
    );
    if (
      !sections.agentContent &&
      !sections.skillContent &&
      !sections.excerptContent &&
      this.isSimplePrompt(sections.userPromptText)
    ) {
      return sections.userPromptText;
    }
    return this.buildAndAttachCategorizedFiles(sections);
  }

  /** Attach a file to Copilot Chat via VS Code command with a small delay. */
  private async attachFileToChat(absolutePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(absolutePath);
      await vscode.commands.executeCommand(
        "workbench.action.chat.attachFile",
        uri
      );
      Log.info(`📎 Attached to chat: ${path.basename(absolutePath)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      Log.error(
        `❌ Failed to attach file: ${path.basename(absolutePath)}`,
        error
      );
    }
  }

  /**
   * Write skill content to a typed temp file and attach it to chat.
   * Used for the native attachments path, which has no VS Code skills API.
   */
  private async attachSkillsAsTempFile(skillContent: string): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }
    const tempMgr = new TempFileManager(workspaceRoot);
    const filePath = await tempMgr.createCategoryFile(
      skillContent,
      TEMP_FILE_CATEGORIES.SKILLS
    );
    this.pendingTempFiles.push(filePath);
    await this.attachFileToChat(filePath);
  }

  /**
   * Format the typed chat instruction string referencing attached file basenames.
   * Matches the structured format used by CLI harnesses.
   */
  private formatCategorizedChatInstruction(
    agentFileNames: string[],
    skillFileNames: string[],
    contextFileNames: string[],
    excerptFileNames: string[],
    promptFileNames: string[]
  ): string {
    // Direct files are attached via VS Code commands — not referenced in the text instruction
    return CopilotChatIntegration.formatCategorizedInstruction(
      agentFileNames,
      skillFileNames,
      [],
      contextFileNames,
      excerptFileNames,
      promptFileNames,
      ", "
    );
  }

  /**
   * Build categorized typed temp files from prompt sections, attach them to
   * chat via VS Code commands, and return a structured instruction string.
   *
   * File categories written:
   *   - .agent.prompt.md   — agent instructions (wrapped in <agentInstructions>)
   *   - .skills.prompt.md  — skill block
   *   - .context.prompt.md — prior context (<priorContext>)
   *   - .excerpts.prompt.md — inline excerpt content (line-numbered)
   *   - .prompt.md         — user prompt text only
   *
   * Direct file refs (full-file @path references) are attached as actual workspace
   * files — no temp copy needed.
   */
  private async buildAndAttachCategorizedFiles(
    sections: PromptSections,
    workflowContextText?: string,
    workflowFilePath?: string,
    stepNumber?: number
  ): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      Log.warn("No workspace root — falling back to inline prompt");
      return workflowContextText
        ? `${workflowContextText}\n\n${sections.userPromptText}`
        : sections.userPromptText;
    }

    const tempMgr = new TempFileManager(workspaceRoot);
    const splitter = new PromptFileSplitter(this.getTempFileSplitConfig());
    const tempFilePaths: string[] = [];
    const agentFileNames: string[] = [];
    const skillFileNames: string[] = [];
    const contextFileNames: string[] = [];
    const excerptFileNames: string[] = [];
    const promptFileNames: string[] = [];

    // 1. Agent file(s)
    if (sections.agentContent) {
      const wrapped = `<agentInstructions>\n${sections.agentContent}\n</agentInstructions>`;
      const { chunks } = splitter.split(wrapped);
      const agentPaths = await tempMgr.createCategorySplitFiles(
        chunks,
        TEMP_FILE_CATEGORIES.AGENT,
        workflowFilePath,
        stepNumber
      );
      tempFilePaths.push(...agentPaths);
      agentFileNames.push(...agentPaths.map((p) => path.basename(p)));
    }

    // 2. Skills file(s) — split if large (rare, but handled for completeness)
    if (sections.skillContent) {
      const skillPaths = await tempMgr.createCategorySplitFiles(
        splitter.split(sections.skillContent).chunks,
        TEMP_FILE_CATEGORIES.SKILLS,
        workflowFilePath,
        stepNumber
      );
      tempFilePaths.push(...skillPaths);
      skillFileNames.push(...skillPaths.map((p) => path.basename(p)));
    }

    // 3. Direct file refs — attach actual workspace files (no temp copy)
    for (const absPath of sections.directFileRefs) {
      await this.attachFileToChat(absPath);
    }

    // 4. Prior context file(s) — split on <step> boundaries so no file exceeds the token limit
    if (workflowContextText) {
      const contextPaths = await tempMgr.createCategorySplitFiles(
        splitter.splitContextContent(workflowContextText).chunks,
        TEMP_FILE_CATEGORIES.CONTEXT,
        workflowFilePath,
        stepNumber
      );
      tempFilePaths.push(...contextPaths);
      contextFileNames.push(...contextPaths.map((p) => path.basename(p)));
    }

    // 5. Excerpt file(s)
    if (sections.excerptContent) {
      const { chunks } = splitter.split(sections.excerptContent);
      const excerptPaths = await tempMgr.createCategorySplitFiles(
        chunks,
        TEMP_FILE_CATEGORIES.EXCERPTS,
        workflowFilePath,
        stepNumber
      );
      tempFilePaths.push(...excerptPaths);
      excerptFileNames.push(...excerptPaths.map((p) => path.basename(p)));
    }

    // 6. Prompt file(s) — user prompt text
    const { chunks: promptChunks } = splitter.split(sections.userPromptText);
    for (let i = 0; i < promptChunks.length; i++) {
      const partNumber = promptChunks.length > 1 ? i + 1 : undefined;
      const promptPath = await tempMgr.createCategoryFile(
        promptChunks[i],
        TEMP_FILE_CATEGORIES.PROMPT,
        workflowFilePath,
        stepNumber,
        partNumber
      );
      tempFilePaths.push(promptPath);
      promptFileNames.push(path.basename(promptPath));
    }

    // Track all temp files for cleanup after execution
    this.pendingTempFiles.push(...tempFilePaths);

    // Attach all typed temp files to chat
    for (const fp of tempFilePaths) {
      await this.attachFileToChat(fp);
    }

    Log.debug(
      `📁 Chat categorized: ${agentFileNames.length} agent, ${skillFileNames.length} skills, ` +
        `${sections.directFileRefs.length} direct, ${contextFileNames.length} context, ` +
        `${excerptFileNames.length} excerpt, ${promptFileNames.length} prompt file(s)`
    );

    return this.formatCategorizedChatInstruction(
      agentFileNames,
      skillFileNames,
      contextFileNames,
      excerptFileNames,
      promptFileNames
    );
  }

  /**
   * Clean up any temp files created during prompt building.
   * Called after execution completes (success or failure).
   */
  private async cleanupTempFiles(): Promise<void> {
    if (this.pendingTempFiles.length > 0) {
      const count = this.pendingTempFiles.length;
      await this.deleteTempFiles(this.pendingTempFiles);
      Log.info(`🗑️ Cleaned up ${count} temp file(s)`);
      this.pendingTempFiles = [];
    }
    for (const hookPath of this.hookFilePaths) {
      try {
        await fs.unlink(hookPath);
      } catch {
        // Hook file may have already been removed — ignore
      }
    }
    this.hookFilePaths = [];
    if (this.hooksDirGitignorePath) {
      await fs.unlink(this.hooksDirGitignorePath).catch(() => {});
      this.hooksDirGitignorePath = undefined;
    }
  }

  /**
   * Write user-defined hooks to .github/hooks/ before sending a prompt.
   *
   * Copilot Chat reads the same .github/hooks/ directory as Copilot CLI —
   * hooks fire on sessionStart, sessionEnd, preToolUse, postToolUse, and
   * userPromptSubmitted. No FlightPath notification entries are included
   * here because CopilotChatIntegration uses ChatSessionMonitor for
   * completion detection, not the notification-file mechanism.
   *
   * Files are named with the same per-prompt pattern as CopilotCliProvider
   * so parallel workflows don't interfere with each other.
   */
  private async writeUserHookFile(
    workspaceRoot: string,
    promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[]
  ): Promise<void> {
    const hookConfig =
      CopilotNotificationMonitor.buildUserOnlyConfig(userHooks);

    // Same filename pattern as CopilotCliProvider.buildHookFileName()
    const stem = workingFilePath
      ? path.basename(workingFilePath).replace(/\.flightpath\.json$/i, "")
      : String(Date.now());
    const safeStem = stem.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    const hookFileName = `flightpath-${safeStem}-p${promptIndex}.json`;

    const hookDir = path.join(workspaceRoot, ".github", "hooks");

    // Security: validate hook path stays within workspace root
    const normalizedRoot = path.resolve(workspaceRoot);
    if (!path.resolve(hookDir).startsWith(normalizedRoot)) {
      Log.error(
        `Security: Hook directory is outside workspace root "${normalizedRoot}"`
      );
      return;
    }

    try {
      await fs.mkdir(hookDir, { recursive: true });
      await this.writeHookDirGitignore(hookDir);
      const hookPath = path.join(hookDir, hookFileName);
      await fs.writeFile(
        hookPath,
        JSON.stringify(hookConfig, null, 2),
        "utf-8"
      );
      this.hookFilePaths.push(hookPath);
      Log.debug(`📁 Created hook file: ${hookPath}`);
    } catch (error) {
      Log.warn(`⚠️ Failed to create hook file: ${error}`);
    }
  }

  /**
   * Write a temporary .gitignore to .github/hooks/ to prevent FlightPath hook files
   * from appearing as untracked in git. The .gitignore hides itself too.
   * No-op if a .gitignore already exists there (user-owned file).
   */
  private async writeHookDirGitignore(hookDir: string): Promise<void> {
    if (this.hooksDirGitignorePath) {
      return; // Already written for this session
    }
    const gitignorePath = path.join(hookDir, ".gitignore");
    try {
      await fs.access(gitignorePath);
      return; // Existing .gitignore — leave it alone
    } catch {
      // File doesn't exist — write it
    }
    const content = [
      "# FlightPath temp files (auto-managed, do not commit)",
      "flightpath-*.json",
      ".gitignore",
      "",
    ].join("\n");
    await fs.writeFile(gitignorePath, content, "utf-8").catch(() => {});
    this.hooksDirGitignorePath = gitignorePath;
  }

  /**
   * Build final step text for the chat input.
   *
   * - **Native attachments** (`useNativeAttachments=true`): attach files via VS Code
   *   native commands, return only the raw prompt text (short string typed into input).
   * - **Temp file path** (`useNativeAttachments=false`, default): build the fully
   *   expanded prompt (including workflow context, agent, skills, and context
   *   attachments), write to temp file(s), attach them to chat, and return a short
   *   "Follow instructions in …" string. This matches the CLI harness flow and avoids
   *   sending large prompts through the `type` command (which deadlocks VS Code for
   *   large context attachments).
   */
  private async buildCopilotChatPrompt(
    prompt: PromptStep,
    workflowContext?: WorkflowContext,
    isResumedSession?: boolean
  ): Promise<string> {
    if (ConfigurationUtils.shouldUseChatNativeAttachments()) {
      // Native path: attachment handler handles @path refs, skills written to
      // temp file. Agent handled by openAgentSpecificChat in sendPrompt.
      return (
        await this.buildPromptText(
          prompt,
          workflowContext?.resolvedProperties?.agent,
          workflowContext?.resolvedProperties?.skills
        )
      ).trim();
    }

    // Non-native path: categorized typed temp files (agent, skills, excerpts, prompt)
    const omitAgentsAndSkills =
      isResumedSession &&
      ConfigurationUtils.shouldOmitAgentsAndSkillsOnResume();
    if (omitAgentsAndSkills) {
      Log.debug(
        "⏭️ Omitting agent and skill blocks (resuming existing session)"
      );
    }

    const resolvedAgent = omitAgentsAndSkills
      ? undefined
      : workflowContext?.resolvedProperties?.agent;
    const resolvedSkills = omitAgentsAndSkills
      ? undefined
      : workflowContext?.resolvedProperties?.skills;

    const sections = await this.buildPromptSections(
      prompt,
      resolvedAgent,
      resolvedSkills
    );
    const inlinePriorContextRefs = parseInlinePriorContextRefs(
      sections.userPromptText
    ).map((match) => match.ref);
    const resolvedPriorContext =
      workflowContext?.resolvedProperties?.priorContext;
    const hasPriorContext =
      (resolvedPriorContext !== undefined && resolvedPriorContext !== "none") ||
      inlinePriorContextRefs.length > 0;

    // Fast path: simple prompts with no context attachments (file refs allowed
    // when the surrounding text is itself simple)
    if (
      !sections.agentContent &&
      !sections.skillContent &&
      !sections.excerptContent &&
      !hasPriorContext &&
      this.isSimplePrompt(sections.userPromptText)
    ) {
      Log.debug(`📝 Simple prompt — using inline (fast path)`);
      return sections.userPromptText;
    }

    const rawContextText = workflowContext
      ? this.buildWorkflowContextText(
          workflowContext.promptIndex,
          workflowContext.allPrompts,
          resolvedPriorContext,
          inlinePriorContextRefs,
          workflowContext.getFinalStepResponseTexts?.()
        )
      : "";

    return (
      await this.buildAndAttachCategorizedFiles(
        sections,
        rawContextText || undefined,
        workflowContext?.filePath,
        workflowContext ? workflowContext.promptIndex + 1 : undefined
      )
    ).trim();
  }

  /** Get the last parsed structured output (tool calls, thinking blocks, metadata) */
  override getLastParsedOutput(): UniversalCliOutput | undefined {
    return this.lastParsedOutput;
  }

  /** Get integration status */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message:
          "✅ Direct automation available (PROVEN zero-interaction strategy)",
        strategy: HARNESS_IDS.COPILOT_CHAT,
      };
    } else {
      return {
        available: false,
        message:
          "❌ Direct automation unavailable - required commands not found",
        strategy: HARNESS_IDS.COPILOT_CHAT,
      };
    }
  }

  /** Check if Copilot integration is available */
  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }
  /** Get integration mode identifier */
  getIntegrationMode(): string {
    return HARNESS_IDS.COPILOT_CHAT;
  }
  /** Get initialization status */
  getInitializationStatus(): HarnessStatus {
    return this.initializationStatus;
  }

  /** Check if Copilot is ready for workflows */
  isReady(): boolean {
    return this.initializationStatus === HarnessStatus.Ready;
  }

  /** Get detailed status with initialization state */
  getDetailedStatus(): {
    initializationStatus: HarnessStatus;
    isReady: boolean;
    message: string;
    pollingAttempts: number;
    maxPollingAttempts: number;
  } {
    let message = "";

    switch (this.initializationStatus) {
      case HarnessStatus.Initializing:
        message = "🔍 Initializing Copilot integration...";
        break;
      case HarnessStatus.Waiting:
        message = `⏳ Waiting for Copilot... (attempt ${this.pollingAttempts}/${this.maxPollingAttempts})`;
        break;
      case HarnessStatus.Ready:
        message = "✅ Copilot automation ready";
        break;
      case HarnessStatus.Unavailable:
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
      // Test message has no XML tags, so pass same text for both params
      const result = await this.sendPromptWithDirectAutomation(
        testMessage,
        testMessage
      );

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

  /** Cancel current chat response */
  protected async cancelImplementation(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.cancel");
      Log.info("⏹️ Cancelled");

      // Fire responseComplete so WorkflowOrchestrator knows cancellation finished
      // This allows state transition from CANCELLING to IDLE
      this.responseCompleteEmitter.fire("Chat cancelled");
    } catch (error) {
      Log.warn("⚠️ Could not cancel chat:", error);
      // Still fire completion even if cancel failed (chat might already be idle)
      this.responseCompleteEmitter.fire("Chat cancel failed");
    }
  }

  /** Check if last failure was user cancellation (resets after check) */
  wasLastFailureUserCancellation(): boolean {
    const wasCancelled = this.lastFailureWasUserCancellation;
    this.lastFailureWasUserCancellation = false; // Reset flag after checking
    return wasCancelled;
  }
}
