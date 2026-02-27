import * as vscode from "vscode";
import * as path from "path";
import { PromptItem, PromptFile } from "../types/FlightPathTypes";
import {
  CliResult,
  UniversalCliOutput,
  CliEvent,
} from "../types/CliOutputTypes";
import { AgentExpander } from "../utils/AgentExpander";
import { SkillExpander } from "../utils/SkillExpander";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { ContextExpander } from "../utils/ContextExpander";
import { Log } from "../utils/Log";
import { ResolvedProperties } from "../utils/PropertyResolver";
import { shouldInjectExtensionInstructions } from "../utils/PromptIdentity";
import type { PromptQueue } from "./PromptQueue";

/**
 * Harness initialization status
 */
export enum HarnessStatus {
  Initializing = "initializing",
  Waiting = "waiting",
  Ready = "ready",
  Unavailable = "unavailable",
}

/**
 * Base class for Harness integrations
 *
 * Provides common functionality and defines the contract that all
 * Harness integration strategies must implement.
 */
export abstract class HarnessIntegration {
  protected context: vscode.ExtensionContext;
  protected isAvailable: boolean = false;
  protected workflowStep: number = 0;
  protected totalSteps: number = 0;
  protected isCancelling: boolean = false;
  protected lastFailureReason: string | null = null;

  // Event emitters for status and response completion
  protected statusChangeEmitter = new vscode.EventEmitter<HarnessStatus>();
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  protected responseCompleteEmitter = new vscode.EventEmitter<string>();
  public readonly onResponseComplete = this.responseCompleteEmitter.event;

  // Event emitter for streaming response chunks (plain text - for Copilot CLI backward compatibility)
  protected streamingChunkEmitter = new vscode.EventEmitter<string>();
  public readonly onStreamingChunk = this.streamingChunkEmitter.event;

  // Event emitter for structured streaming events (for Claude/Codex CLI)
  protected streamingEventsEmitter = new vscode.EventEmitter<CliEvent[]>();
  public readonly onStreamingEvents = this.streamingEventsEmitter.event;

  // Event emitter for prompt ready (fires when prompt is built but before execution)
  protected promptReadyEmitter = new vscode.EventEmitter<{
    fullPrompt: string;
    cliCommand?: string;
  }>();
  public readonly onPromptReady = this.promptReadyEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    registerWithContext: boolean = true
  ) {
    this.context = context;

    // Detector singletons register with context so VS Code disposes them on deactivation.
    // Execution integrations (per-run, short-lived) skip registration and are disposed
    // manually in startWorkflowExecution's finally block to avoid leaking into subscriptions.
    if (registerWithContext) {
      context.subscriptions.push(this.statusChangeEmitter);
      context.subscriptions.push(this.responseCompleteEmitter);
      context.subscriptions.push(this.streamingChunkEmitter);
      context.subscriptions.push(this.streamingEventsEmitter);
      context.subscriptions.push(this.promptReadyEmitter);
    }
  }

  /**
   * Dispose all event emitters owned by this integration.
   * Called automatically by VS Code for detector singletons (via context.subscriptions).
   * Called manually for execution integrations after each workflow run.
   */
  dispose(): void {
    this.statusChangeEmitter.dispose();
    this.responseCompleteEmitter.dispose();
    this.streamingChunkEmitter.dispose();
    this.streamingEventsEmitter.dispose();
    this.promptReadyEmitter.dispose();
  }

  /**
   * Mark this integration as ready without running initialize().
   * Called by IntegrationFactory.createForExecution() on per-run execution integrations:
   * the detector singleton has already confirmed harness availability, so we skip the
   * PATH/version check and go straight to Ready.
   * Subclasses that track additional initialization state (e.g. CliIntegration)
   * should override this to also update their local status field.
   */
  markAsReady(): void {
    this.isAvailable = true;
  }

  /**
   * Set the workflow display name (used for terminal tab naming in CLI integrations).
   * Default is a no-op; CliIntegration overrides with the real implementation.
   */
  setWorkflowName(_name: string | undefined): void {
    // no-op in base class; CliIntegration overrides
  }

  /**
   * Initialize the Harness integration
   * Must be implemented by subclasses
   */
  abstract initialize(): Promise<void>;

  /**
   * Send a prompt to the Harness integration
   * Must be implemented by subclasses
   * @param prompt The prompt item to send
   * @param needsCompletionDetection If true, set up completion detection mechanisms (default: true)
   * @param workflowContext Optional workflow context for dynamic queue instructions, temp file naming, and session resolution
   * @returns True if prompt was sent successfully
   */
  abstract sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection?: boolean,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties; // Resolved properties from PropertyResolver
      workflowFile?: PromptFile; // For session resolution
      promptQueue?: PromptQueue; // For runtime metadata persistence
    }
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
   * Get integration mode (e.g., "copilot-cli", "claude-cli", "chat")
   * Used to customize dynamic queue instructions for each integration type
   * Must be implemented by subclasses
   */
  abstract getIntegrationMode(): string;

  /**
   * Build prompt text from prompt item
   * Common logic for extracting prompt text, expanding context references,
   * prepending agent instructions, and inserting skill instructions.
   *
   * @param prompt The prompt item to build text for
   * @param resolvedAgent Optional resolved agent name to prepend instructions for
   * @param resolvedSkills Optional resolved skill names to insert as <skillInstructions>
   */
  protected async buildPromptText(
    prompt: PromptItem,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ): Promise<string> {
    // Check if auto-attachment is enabled
    const autoAttach = ConfigurationUtils.shouldAutoAttachFiles();

    // User's prompt text is already in final form with all context variables
    const promptText = prompt.prompt.trim();

    // Expand context references if enabled
    let expandedText: string;
    if (autoAttach) {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        Log.warn("No workspace root, skipping context expansion");
        expandedText = promptText;
      } else {
        const expander = new ContextExpander(workspaceRoot);
        expandedText = await expander.expandContext(promptText);
      }
    } else {
      expandedText = promptText;
    }

    // Agent expansion - prepend agent instructions if specified
    if (resolvedAgent) {
      const workspaceRoot = this.getWorkspaceRoot();
      const agentContent = await AgentExpander.expandAgent(
        resolvedAgent,
        workspaceRoot
      );
      if (agentContent) {
        expandedText = this.insertAgentInstructions(expandedText, agentContent);
        Log.info(`🤖 Agent "${resolvedAgent}" instructions added to prompt`);
      } else {
        Log.warn(
          `⚠️ Agent "${resolvedAgent}" not found, continuing without agent`
        );
      }
    }

    // Skill expansion - insert skill frontmatter if specified
    if (resolvedSkills && resolvedSkills.length > 0) {
      const workspaceRoot = this.getWorkspaceRoot();
      const skillContent = await SkillExpander.expandSkills(
        resolvedSkills,
        workspaceRoot
      );
      if (skillContent) {
        expandedText = this.insertSkillInstructions(expandedText, skillContent);
        Log.info(
          `🎯 Skills [${resolvedSkills.join(", ")}] instructions added to prompt`
        );
      } else {
        Log.warn(
          `⚠️ No skills resolved from [${resolvedSkills.join(", ")}], continuing without skills`
        );
      }
    }

    return expandedText;
  }

  /**
   * Insert agent instructions between attachment blocks and user prompt.
   *
   * Final structure:
   *   [<attachment> blocks] → <agentInstructions> → [user prompt]
   *
   * Positioning rationale:
   * - Attachments FIRST: provide context/files the agent may reference
   * - Agent instructions SECOND: defines role and how to use the context
   * - User prompt LAST: gets maximum LLM attention (positioned last)
   *
   * This matches GitHub Copilot's <modeInstructions> pattern.
   */
  private insertAgentInstructions(
    expandedPrompt: string,
    agentContent: string
  ): string {
    const ATTACHMENT_CLOSE_TAG = "</attachment>";
    const lastAttachmentEnd = expandedPrompt.lastIndexOf(ATTACHMENT_CLOSE_TAG);

    if (lastAttachmentEnd === -1) {
      // No attachments - prepend agent before entire prompt
      return `<agentInstructions>\n${agentContent}\n</agentInstructions>\n\n${expandedPrompt}`;
    }

    // Split at end of last attachment and insert agent between attachments and user prompt
    const afterAttachmentTag = lastAttachmentEnd + ATTACHMENT_CLOSE_TAG.length;
    const attachmentSection = expandedPrompt.substring(0, afterAttachmentTag);
    const userPromptSection = expandedPrompt.substring(afterAttachmentTag);

    return `${attachmentSection}\n\n<agentInstructions>\n${agentContent}\n</agentInstructions>\n\n${userPromptSection.trim()}`;
  }

  /**
   * Insert skill instructions after agent instructions (or after attachments if no agent).
   *
   * Final structure:
   *   [<attachment> blocks] → <agentInstructions> (if agent) → <skillInstructions> → [user prompt]
   *
   * Positioning logic:
   * 1. If agentInstructions present: insert after </agentInstructions>
   * 2. Else if attachment blocks present: insert after last </attachment>
   * 3. Else: prepend before entire prompt
   */
  private insertSkillInstructions(
    expandedPrompt: string,
    skillContent: string
  ): string {
    const AGENT_CLOSE_TAG = "</agentInstructions>";
    const ATTACHMENT_CLOSE_TAG = "</attachment>";

    // 1. Try to insert after agent instructions
    const agentEnd = expandedPrompt.lastIndexOf(AGENT_CLOSE_TAG);
    if (agentEnd !== -1) {
      const afterAgent = agentEnd + AGENT_CLOSE_TAG.length;
      const before = expandedPrompt.substring(0, afterAgent);
      const after = expandedPrompt.substring(afterAgent).trimStart();
      return `${before}\n\n${skillContent}\n\n${after}`;
    }

    // 2. Try to insert after last attachment
    const lastAttachmentEnd = expandedPrompt.lastIndexOf(ATTACHMENT_CLOSE_TAG);
    if (lastAttachmentEnd !== -1) {
      const afterAttachment =
        lastAttachmentEnd + ATTACHMENT_CLOSE_TAG.length;
      const before = expandedPrompt.substring(0, afterAttachment);
      const after = expandedPrompt.substring(afterAttachment).trimStart();
      return `${before}\n\n${skillContent}\n\n${after}`;
    }

    // 3. Prepend before entire prompt
    return `${skillContent}\n\n${expandedPrompt}`;
  }

  /**
   * Build prompt with dynamic queue instructions if needed
   * @param prompt The prompt item
   * @param promptIndex Current prompt index
   * @param allPrompts All prompts in the workflow
   * @param filePath Path to the .flightpath.json file (unused, kept for compatibility)
   * @returns Prompt text with optional MCP tool instructions
   */
  protected async buildPromptWithInstructions(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[],
    filePath?: string,
    allowDynamicExtension?: boolean,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ): Promise<string> {
    // Build base prompt text (with attachments, agent, and skill instructions)
    let promptText = await this.buildPromptText(
      prompt,
      resolvedAgent,
      resolvedSkills
    );

    // Check if we should inject dynamic queue instructions
    const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
    const shouldEnableDynamicExtension =
      allowDynamicExtension ?? dynamicQueueConfig.enabled;

    if (!shouldEnableDynamicExtension) {
      return promptText; // Dynamic queue disabled
    }

    // Check if this prompt should get extension instructions
    const shouldInject = shouldInjectExtensionInstructions(
      prompt,
      promptIndex,
      allPrompts,
      dynamicQueueConfig.dynamicExtensionOnLastPrompt,
      shouldEnableDynamicExtension
    );

    if (!shouldInject) {
      return promptText; // No instructions for this prompt
    }

    // Get integration mode to determine instruction format
    const integrationMode = this.getIntegrationMode();

    // Get dynamic queue config for instruction template
    const { maxQueueSize, maxWorkflowExecutionTime, unlimitedMode } =
      dynamicQueueConfig;

    // Calculate current stats
    const currentSize = allPrompts.length;
    const currentIndex = promptIndex + 1; // 1-based for display
    const totalPrompts = allPrompts.length;

    // Build concise instruction (tool schemas provide usage details)
    const maxSizeDisplay = unlimitedMode
      ? "unlimited"
      : maxQueueSize.toString();
    const maxTimeDisplay =
      unlimitedMode || maxWorkflowExecutionTime === -1
        ? "unlimited"
        : `${maxWorkflowExecutionTime}s`;

    const instructions = `<criticalInstruction>
FlightPath workflow: Step ${currentIndex}/${totalPrompts} (${currentSize}/${maxSizeDisplay} prompts, ${maxTimeDisplay} max time)

You have access to flightpath_queue_status and flightpath_append_queue tools. Use them if you need additional steps to complete this task. Only extend the queue if truly necessary.
</criticalInstruction>

`;

    // Prepend instructions to prompt
    return instructions + promptText;
  }

  /**
   * Resolve relative path to absolute workspace path
   * Uses Node.js path.resolve for cross-platform compatibility
   */
  protected resolveWorkspacePath(relativePath: string): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    // path.resolve handles both absolute and relative paths correctly
    // If relativePath is already absolute, it returns it as-is
    // If relative, it joins with workspaceRoot
    return path.resolve(workspaceRoot, relativePath);
  }

  /**
   * Get workspace root directory
   */
  protected getWorkspaceRoot(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder?.uri.fsPath;
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
  abstract getInitializationStatus(): HarnessStatus;

  /**
   * Check if Harness is ready for workflows
   * Must be implemented by subclasses
   */
  abstract isReady(): boolean;

  /**
   * Cancel the current operation
   * Sets the shared cancellation flag and calls subclass-specific implementation
   */
  async cancel(): Promise<void> {
    this.isCancelling = true;
    await this.cancelImplementation();
  }

  /**
   * Subclass-specific cancellation logic
   * Must be implemented by subclasses to handle their specific cleanup
   */
  protected abstract cancelImplementation(): Promise<void>;

  /**
   * Reset cancellation flag (call before starting new operations)
   */
  protected resetCancellationFlag(): void {
    this.isCancelling = false;
  }

  /**
   * Get detailed status (optional - can be overridden by subclasses)
   * Default implementation returns basic information
   */
  getDetailedStatus(): {
    initializationStatus: HarnessStatus;
    isReady: boolean;
    message: string;
    pollingAttempts?: number;
    maxPollingAttempts?: number;
  } {
    const status = this.getInitializationStatus();
    let message = "";

    switch (status) {
      case HarnessStatus.Initializing:
        message = "🔍 Initializing Harness integration...";
        break;
      case HarnessStatus.Waiting:
        message = "⏳ Waiting for Harness...";
        break;
      case HarnessStatus.Ready:
        message = "✅ Harness ready";
        break;
      case HarnessStatus.Unavailable:
        message = "❌ Harness unavailable";
        break;
    }

    return {
      initializationStatus: status,
      isReady: this.isReady(),
      message,
    };
  }

  // ============================================================
  // EXECUTION OUTPUT METHODS (CLI provides real values, Chat returns undefined)
  // ============================================================

  /**
   * Get the last execution result (CLI-specific, returns undefined for Chat)
   * Includes response text, statistics, and exit code
   */
  getLastResult(): CliResult | undefined {
    return undefined;
  }

  /**
   * Get the last parsed output with structured data.
   * Contains tool calls, thinking blocks, and metadata.
   * Returns undefined for non-CLI integrations.
   */
  getLastParsedOutput(): UniversalCliOutput | undefined {
    return undefined;
  }

  /**
   * Get the last CLI command executed (for debugging)
   * Returns undefined for non-CLI integrations
   */
  getLastCliCommand(): string | undefined {
    return undefined;
  }

  /**
   * Get the full prompt text sent (includes all context and instructions)
   * Returns undefined if not tracked
   */
  getLastFullPrompt(): string | undefined {
    return undefined;
  }

  /**
   * Parse token counts from statistics string
   * Returns undefined for non-CLI integrations or unparseable stats
   */
  parseTokenCounts(
    _statistics: string
  ): { prompt: number; completion: number } | undefined {
    return undefined;
  }

  // ============================================================
  // DIAGNOSTIC METHODS (Chat provides full implementations, CLI provides defaults)
  // ============================================================

  /**
   * Test automation capability (diagnostic tool)
   * CLI: Returns isReady() since CLI doesn't need automation testing
   * Chat: Sends test message to verify automation works
   */
  async testAutomation(): Promise<boolean> {
    return this.isReady();
  }

  /**
   * Retry integration detection/initialization
   * CLI: Re-runs initialize()
   * Chat: Restarts polling for Harness availability
   */
  async retryDetection(): Promise<void> {
    await this.initialize();
  }

  /**
   * Get capability information for this integration
   */
  getCapabilities(): {
    hasDirectAutomation: boolean;
    supportsZeroInteraction: boolean;
    currentStrategy: string;
  } {
    const status = this.getStatus();
    return {
      hasDirectAutomation: this.isAvailable,
      supportsZeroInteraction: this.isAvailable,
      currentStrategy: status.strategy,
    };
  }

  /**
   * Check if the last sendPrompt failure was due to user cancellation
   * Returns false by default (only Chat tracks this)
   */
  wasLastFailureUserCancellation(): boolean {
    return false;
  }

  /**
   * Get the reason for the last sendPrompt failure
   * Returns the failure reason and resets it to null
   * Returns "Failed to send prompt" as default if no specific reason was set
   */
  getLastFailureReason(): string {
    const reason = this.lastFailureReason || "Failed to send prompt";
    this.lastFailureReason = null; // Reset after reading
    return reason;
  }

  /**
   * Check if this is a CLI-based integration
   * Returns false by default. CLI integrations override to return true.
   * Use this for CLI-specific features like output logging, token display, etc.
   */
  isCli(): boolean {
    return false;
  }
}
