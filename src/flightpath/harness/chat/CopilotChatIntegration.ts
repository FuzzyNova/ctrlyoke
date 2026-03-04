import * as vscode from "vscode";
import * as path from "path";
import { PromptItem, Harness } from "../../../types/FlightPathTypes";
import { HarnessIntegration, HarnessStatus } from "../../HarnessIntegration";
import { isModelAvailable } from "../../../utils/ModelRegistry";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { ChatSessionMonitor } from "./ChatSessionMonitor";
import { ChatSessionParser } from "./ChatSessionParser";
import { NativeAttachmentHandler } from "./NativeAttachmentHandler";
import { Log } from "../../../utils/Log";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { AgentExpander } from "../../../utils/AgentExpander";
import { CliOutputFormatter } from "../shared/CliOutputFormatter";
import { UniversalCliOutput } from "../../../types/CliOutputTypes";
import { ResolvedProperties } from "../../../utils/PropertyResolver";

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
    this.initialize();
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
    prompt: PromptItem,
    needsCompletionDetection?: boolean,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
    }
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

      // Build full prompt (what we'll type into chat)
      const chatPrompt = await this.buildCopilotChatPrompt(
        prompt,
        workflowContext
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
    isNewChatSession: boolean = true
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

      // Step 3: Type the prompt directly into chat input
      try {
        await vscode.commands.executeCommand("type", { text: chatPrompt });
      } catch (typeError) {
        Log.error("❌ Could not type text:", typeError);
        throw new Error(`Failed to type text: ${typeError}`);
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
   *   Skills are NOT supported in this mode (VS Code has no native skill API).
   *
   * **useNativeAttachments=false** (default):
   *   Builds fully expanded temp prompt files (with agent, skills, and context
   *   embedded), then attaches those temp files to chat using native file
   *   attachment commands. The typed prompt becomes a short instruction:
   *   "Follow instructions in prompt1.md and prompt2.md"
   *   This gives a uniform experience matching CLI harnesses.
   */
  protected async buildPromptText(
    prompt: PromptItem,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ): Promise<string> {
    // Check if auto-attachment is enabled
    const autoAttach = ConfigurationUtils.shouldAutoAttachFiles();

    // Check if native attachments are enabled for chat mode
    const useNativeAttachments =
      ConfigurationUtils.shouldUseChatNativeAttachments();

    if (!autoAttach) {
      return prompt.prompt.trim();
    }

    if (useNativeAttachments) {
      // Native attachments: use VS Code commands to attach files directly.
      // Agent is handled by opening agent-specific chat window (sendPrompt).
      // Skills NOT supported in this mode.
      return await this.attachmentHandler.processAttachments(prompt.prompt);
    }

    // Non-native attachments: build fully expanded prompt (with agent, skills,
    // context references), write to temp file(s), attach to chat, and return
    // a short instruction referencing the files.
    return await this.buildTempFilePrompt(
      prompt,
      resolvedAgent,
      resolvedSkills
    );
  }

  /**
   * Build expanded prompt, write to temp file(s), attach them to chat,
   * and return a short "Follow instructions in ..." message.
   *
   * This mirrors the CLI flow: agent + skills + context are embedded in
   * temp .prompt.md files, giving a uniform experience across all harnesses.
   */
  private async buildTempFilePrompt(
    prompt: PromptItem,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ): Promise<string> {
    // Build fully expanded prompt text (base class handles agent, skills, context)
    const expandedText = await super.buildPromptText(
      prompt,
      resolvedAgent,
      resolvedSkills
    );

    if (!this.getWorkspaceRoot()) {
      Log.warn("No workspace root, falling back to inline prompt");
      return expandedText;
    }

    // Fast path: simple prompts (short, no special chars) can be typed inline —
    // no temp file I/O or attachment commands needed.
    if (this.isSimplePrompt(expandedText)) {
      Log.debug(`📝 Simple prompt - using inline (fast path)`);
      return expandedText;
    }

    // Create temp file(s) via base class (handles splitting, logging)
    const { tempFilePaths } = await this.createTempPromptFiles(expandedText);

    // Track temp files for cleanup after execution
    this.pendingTempFiles.push(...tempFilePaths);

    // Attach each temp file to chat using native file attachment
    for (const filePath of tempFilePaths) {
      try {
        const uri = vscode.Uri.file(filePath);
        await vscode.commands.executeCommand(
          "workbench.action.chat.attachFile",
          uri
        );
        Log.info(`📎 Attached to chat: ${path.basename(filePath)}`);
        // Small delay between attachments to prevent race conditions
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        Log.error(
          `❌ Failed to attach temp file: ${path.basename(filePath)}`,
          error
        );
      }
    }

    // Build short instruction referencing the files (bare filenames - no @ prefix)
    const fileNames = tempFilePaths.map((fp) => path.basename(fp));
    if (fileNames.length === 1) {
      return `Follow instructions in ${fileNames[0]}`;
    }
    // Natural language: "file1, file2, and file3"
    const last = fileNames.pop()!;
    return `Follow instructions in ${fileNames.join(", ")}, and ${last}`;
  }

  /**
   * Clean up any temp files created during prompt building.
   * Called after execution completes (success or failure).
   */
  private async cleanupTempFiles(): Promise<void> {
    if (this.pendingTempFiles.length === 0) {
      return;
    }
    const count = this.pendingTempFiles.length;
    await this.deleteTempFiles(this.pendingTempFiles);
    Log.info(`🗑️ Cleaned up ${count} temp file(s)`);
    this.pendingTempFiles = [];
  }

  /** Build final prompt with dynamic queue instructions if applicable */
  private async buildCopilotChatPrompt(
    prompt: PromptItem,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
    }
  ): Promise<string> {
    const promptText = workflowContext
      ? await this.buildPromptWithInstructions(
          prompt,
          workflowContext.promptIndex,
          workflowContext.allPrompts,
          workflowContext.resolvedProperties?.allowDynamicExtension,
          workflowContext.resolvedProperties?.agent, // Pass resolved agent for prompt prepending
          workflowContext.resolvedProperties?.skills // Pass resolved skills for frontmatter injection
        )
      : await this.buildPromptText(prompt);

    return promptText.trim();
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
        strategy: Harness.CopilotChat,
      };
    } else {
      return {
        available: false,
        message:
          "❌ Direct automation unavailable - required commands not found",
        strategy: Harness.CopilotChat,
      };
    }
  }

  /** Check if Copilot integration is available */
  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }
  /** Get integration mode identifier */
  getIntegrationMode(): string {
    return Harness.CopilotChat;
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

      // Fire responseComplete so FlightPathManager knows cancellation finished
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
