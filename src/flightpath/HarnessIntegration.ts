import * as path from "path";
import { PromptItem, PromptFile, PriorContext } from "../types/FlightPathTypes";
import { TypedEmitter } from "../utils/TypedEmitter";
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
import { TempFileManager } from "../utils/TempFileManager";
import { PromptFileSplitter } from "../utils/PromptFileSplitter";
import type { PromptQueue } from "./PromptQueue";

/**
 * Minimal container for VS Code-style disposable subscriptions.
 * Avoids importing the `vscode` module in the shared core, which must also
 * compile into the standalone CLI bundle (where `vscode` is not available).
 */
interface SubscriptionContainer {
  readonly subscriptions: Array<{ dispose(): void }>;
}

/** A single context item ready for XML serialization by insertPriorContext. */
type PriorContextItem = {
  index: number;
  name?: string;
  text: string;
  /** "finalPrompt" when the item originates from a finalPrompt loop (not a queue prompt). */
  type?: "finalPrompt";
};

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
  protected context: SubscriptionContainer | undefined;
  protected isAvailable: boolean = false;
  protected workflowStep: number = 0;
  protected totalSteps: number = 0;
  protected isCancelling: boolean = false;
  protected lastFailureReason: string | null = null;

  // Event emitters for status and response completion
  protected statusChangeEmitter = new TypedEmitter<HarnessStatus>();
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  protected responseCompleteEmitter = new TypedEmitter<string>();
  public readonly onResponseComplete = this.responseCompleteEmitter.event;

  /**
   * When true, this harness emits pre-formatted plain text rather than markdown.
   * The UI skips the Streamdown pipeline to avoid double-rendering artifacts.
   * Override in subclasses (CliIntegration reads from provider config).
   */
  get rawTextOutput(): boolean {
    return false;
  }

  // Event emitter for streaming response chunks (plain text - for Copilot CLI backward compatibility)
  protected streamingChunkEmitter = new TypedEmitter<string>();
  public readonly onStreamingChunk = this.streamingChunkEmitter.event;

  // Event emitter for structured streaming events (for Claude/Codex CLI)
  protected streamingEventsEmitter = new TypedEmitter<CliEvent[]>();
  public readonly onStreamingEvents = this.streamingEventsEmitter.event;

  // Event emitter for prompt ready (fires when prompt is built but before execution)
  protected promptReadyEmitter = new TypedEmitter<{
    fullPrompt: string;
    cliCommand?: string;
  }>();
  public readonly onPromptReady = this.promptReadyEmitter.event;

  constructor(
    context: SubscriptionContainer | undefined,
    registerWithContext: boolean = true
  ) {
    this.context = context;

    // Detector singletons register with context so VS Code disposes them on deactivation.
    // Execution integrations (per-run, short-lived) skip registration and are disposed
    // manually in startWorkflowExecution's finally block to avoid leaking into subscriptions.
    if (context && registerWithContext) {
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
   * Clean up workflow-scoped artifacts created during execution (e.g. MCP config files).
   *
   * Called from the finally block in WorkflowInstance.startWorkflowExecution after
   * each workflow run completes. Default is a no-op; CliIntegration overrides this
   * to delegate to the provider's cleanupMcpConfig.
   *
   * @param workingFilePath The working file path for this workflow run
   * @param workspaceRoot Workspace root directory
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cleanupWorkflowArtifacts(
    _workingFilePath: string | undefined,
    _workspaceRoot: string
  ): Promise<void> {
    // no-op by default
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
      workingFilePath?: string; // Path to .flightpath.json working file (sets FLIGHTPATH_WORKING_FILE for MCP)
      resolvedProperties?: ResolvedProperties; // Resolved properties from PropertyResolver
      workflowFile?: PromptFile; // For session resolution
      promptQueue?: PromptQueue; // For runtime metadata persistence
      /** Session ID from the previous finalPrompt loop iteration. Consumed by SessionResolver
       *  when sessionId is the "finalPrompt" sentinel; ignored for regular queue prompts. */
      finalPromptSessionId?: string;
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
        Log.debug(`🤖 Agent "${resolvedAgent}" instructions added to prompt`);
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
        Log.debug(
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
      const afterAttachment = lastAttachmentEnd + ATTACHMENT_CLOSE_TAG.length;
      const before = expandedPrompt.substring(0, afterAttachment);
      const after = expandedPrompt.substring(afterAttachment).trimStart();
      return `${before}\n\n${skillContent}\n\n${after}`;
    }

    // 3. Prepend before entire prompt
    return `${skillContent}\n\n${expandedPrompt}`;
  }


  /**
   * Gather prior prompt response texts based on the priorContext field.
   *
   * Queue-prompt keywords ("all", "previous", number[]) resolve against allPrompts._runtime.responseText.
   * finalPrompt keywords ("finalPromptAll", "finalPromptPrevious") resolve against finalPromptResponseTexts.
   *
   * Prompts/loops with no captured output are silently skipped.
   *
   * @param priorContext The resolved priorContext value
   * @param allPrompts All queue prompts in the workflow
   * @param currentIndex 0-based index of the prompt being built
   * @param finalPromptResponseTexts Per-loop finalPrompt response texts (indexed by loopIndex)
   */
  private gatherPriorContextItems(
    priorContext: PriorContext,
    allPrompts: PromptItem[],
    currentIndex: number,
    finalPromptResponseTexts: string[] = []
  ): PriorContextItem[] {
    if (priorContext === "none") {
      return [];
    }

    // finalPrompt-specific keywords
    if (priorContext === "finalPromptAll") {
      const items = finalPromptResponseTexts
        .map((text, i) => ({ index: i, text, type: "finalPrompt" as const }))
        .filter((item) => item.text.length > 0);
      if (items.length === 0 && finalPromptResponseTexts.length > 0) {
        Log.debug(
          `priorContext: no captured finalPrompt response text available yet`
        );
      }
      return items;
    }

    if (priorContext === "finalPromptPrevious") {
      const lastIndex = finalPromptResponseTexts.length - 1;
      if (lastIndex < 0) {
        return [];
      }
      const text = finalPromptResponseTexts[lastIndex];
      if (!text) {
        return [];
      }
      return [{ index: lastIndex, text, type: "finalPrompt" as const }];
    }

    // Queue-prompt keywords
    let targetIndices: number[];

    if (priorContext === "all") {
      targetIndices = Array.from({ length: currentIndex }, (_, i) => i);
    } else if (priorContext === "previous") {
      targetIndices = currentIndex > 0 ? [currentIndex - 1] : [];
    } else {
      // Array of 1-based prompt numbers → 0-based indices, validated
      const outOfRange: number[] = [];
      targetIndices = priorContext
        .map((n) => n - 1) // convert to 0-based
        .filter((i) => {
          if (i >= 0 && i < currentIndex) {
            return true;
          }
          outOfRange.push(i + 1); // convert back to 1-based for logging
          return false;
        });

      if (outOfRange.length > 0) {
        Log.warn(
          `priorContext: indices [${outOfRange.join(", ")}] are out of range for prompt ${currentIndex + 1} ` +
            `(only ${currentIndex} prompt(s) have run). Skipping.`
        );
      }
    }

    const items = targetIndices
      .map((i) => ({
        index: i,
        name: allPrompts[i]?.name,
        text: allPrompts[i]?._runtime?.responseText ?? "",
      }))
      .filter((item) => item.text.length > 0);

    if (items.length === 0 && targetIndices.length > 0) {
      Log.debug(
        `priorContext: no captured response text found for any specified prompts at index ${currentIndex + 1}`
      );
    }

    return items;
  }

  /**
   * Format gathered context items as an XML block and prepend to prompt text.
   * finalPrompt loop items carry type="finalPrompt" on the <step> element.
   * Result is inserted BEFORE the user's prompt text.
   */
  private insertPriorContext(
    promptText: string,
    contextItems: PriorContextItem[]
  ): string {
    if (contextItems.length === 0) {
      return promptText;
    }

    const steps = contextItems
      .map((item) => {
        const typeAttr = item.type ? ` type="${item.type}"` : "";
        const nameAttr = item.name ? ` name="${item.name}"` : "";
        return `<step index="${item.index + 1}"${typeAttr}${nameAttr}>\n${item.text.trim()}\n</step>`;
      })
      .join("\n");

    const contextBlock = `<priorContext>\n${steps}\n</priorContext>`;
    return `${contextBlock}\n\n${promptText}`;
  }

  /**
   * Build prompt with dynamic queue instructions if needed
   * @param prompt The prompt item
   * @param promptIndex Current prompt index
   * @param allPrompts All prompts in the workflow
   * @param allowDynamicExtension Whether to enable dynamic queue extension
   * @param resolvedAgent Resolved agent path for prompt prepending
   * @param resolvedSkills Resolved skill paths for frontmatter injection
   * @param resolvedPriorContext Prior context injection setting
   * @param finalPromptResponseTexts Per-loop finalPrompt response texts (for "finalPromptAll"/"finalPromptPrevious")
   * @returns Prompt text with optional prior context and MCP tool instructions
   */
  protected async buildPromptWithInstructions(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[],
    allowDynamicExtension?: boolean,
    resolvedAgent?: string,
    resolvedSkills?: string[],
    resolvedPriorContext?: PriorContext,
    finalPromptResponseTexts?: string[]
  ): Promise<string> {
    // Build base prompt text (with attachments, agent, and skill instructions)
    let promptText = await this.buildPromptText(
      prompt,
      resolvedAgent,
      resolvedSkills
    );

    // Inject prior context if specified
    if (resolvedPriorContext !== undefined && resolvedPriorContext !== "none") {
      const contextItems = this.gatherPriorContextItems(
        resolvedPriorContext,
        allPrompts,
        promptIndex,
        finalPromptResponseTexts ?? []
      );
      if (contextItems.length > 0) {
        promptText = this.insertPriorContext(promptText, contextItems);
        const isFinalPromptContext =
          resolvedPriorContext === "finalPromptAll" ||
          resolvedPriorContext === "finalPromptPrevious";
        Log.debug(
          `🔗 Injecting ${isFinalPromptContext ? "finalPrompt" : "prior"} context for prompt ${promptIndex + 1}: ` +
            `${contextItems.length} step(s) from indices [${contextItems.map((c) => c.index + 1).join(", ")}]`
        );
      }
    }

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
   * Create temp prompt file(s) from expanded prompt text.
   * Handles large-prompt splitting (>20K tokens or >1800 lines) via PromptFileSplitter.
   * Logs creation stats for debugging.
   *
   * This is the single implementation shared by all harnesses that use temp files
   * (CliIntegration for file-reference passing; CopilotChatIntegration for attachment).
   *
   * @param promptText The full expanded prompt text to write
   * @param filePath Optional workflow file path (for meaningful temp filenames)
   * @param promptNumber Optional 1-based prompt number (for meaningful temp filenames)
   * @returns Absolute file paths and workspace-relative paths for each created file
   */
  protected async createTempPromptFiles(
    promptText: string,
    filePath?: string,
    promptNumber?: number
  ): Promise<{ tempFilePaths: string[]; relativePaths: string[] }> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace root available for temp file");
    }

    const tempMgr = new TempFileManager(workspaceRoot);
    const splitter = new PromptFileSplitter();
    const splitResult = splitter.split(promptText);

    let tempFilePaths: string[];

    if (!splitResult.needsSplit) {
      const tempFilePath = await tempMgr.createPromptFile(
        promptText,
        filePath,
        promptNumber
      );
      tempFilePaths = [tempFilePath];
      Log.info(
        `📁 Temp file: ${tempMgr.getRelativePath(tempFilePath)} ` +
          `(${splitResult.tokenCounts[0]} tokens, ${splitResult.lineCounts[0]} lines)`
      );
    } else {
      tempFilePaths = await tempMgr.createSplitPromptFiles(
        splitResult.chunks,
        filePath,
        promptNumber
      );
      Log.info(`📁 Prompt split into ${splitResult.chunks.length} files:`);
      splitResult.chunks.forEach((_, idx) => {
        Log.info(
          `   ${idx + 1}. ${tempMgr.getRelativePath(tempFilePaths[idx])} ` +
            `(${splitResult.tokenCounts[idx]} tokens, ${splitResult.lineCounts[idx]} lines)`
        );
      });
    }

    const relativePaths = tempFilePaths.map((fp) =>
      tempMgr.getRelativePath(fp)
    );
    return { tempFilePaths, relativePaths };
  }

  /**
   * Delete temp prompt files created during execution.
   * No-op if the array is empty or no workspace root is available.
   */
  protected async deleteTempFiles(tempFilePaths: string[]): Promise<void> {
    if (tempFilePaths.length === 0) {
      return;
    }
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }
    const tempMgr = new TempFileManager(workspaceRoot);
    await tempMgr.deleteFiles(tempFilePaths);
  }

  /**
   * Check if a prompt is simple enough to pass directly without a temp file.
   *
   * Simple prompts must be:
   * - Short length (≤300 characters)
   * - No dynamic queue XML instructions
   * - No shell-dangerous characters (quotes, backslashes, newlines, metacharacters, etc.)
   *
   * **Security-critical for CLI:** We're conservative because the prompt gets embedded
   * directly in the shell command line. Even with escaping, complex prompts could
   * break parsing or introduce security issues.
   *
   * For chat harnesses the same check applies as a fast-path gate: if it passes,
   * the prompt is short and clean enough to type inline, skipping temp file I/O.
   *
   * @param finalPromptText The final prompt text (after instruction injection)
   * @returns true if prompt can be passed directly
   */
  protected isSimplePrompt(finalPromptText: string): boolean {
    const MAX_SIMPLE_PROMPT_LENGTH = 300;

    if (finalPromptText.length > MAX_SIMPLE_PROMPT_LENGTH) {
      return false;
    }

    if (finalPromptText.includes("<criticalInstruction>")) {
      return false;
    }

    // Only allow: letters, numbers, spaces, and basic safe punctuation.
    // If anything else exists, use file-based passing.
    const SAFE_CHARS_PATTERN = /^[a-zA-Z0-9\s.,!?:;\-_()@#/]*$/;
    if (!SAFE_CHARS_PATTERN.test(finalPromptText)) {
      Log.debug(
        "📁 Prompt contains special characters, using file-based passing for safety"
      );
      return false;
    }

    if (/[\n\r\t]/.test(finalPromptText)) {
      Log.debug("📁 Prompt contains newlines/tabs, using file-based passing");
      return false;
    }

    return true;
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
    return undefined;
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
    // No-op in base class; VS Code subclasses override for status bar integration.
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

  /**
   * Close any open interactive terminal without fully disposing the integration.
   * No-op for non-CLI integrations. Overridden by CliIntegration.
   * Called by WorkflowInstance before switching to a different harness mid-workflow,
   * so the outgoing integration's terminal is not orphaned.
   */
  closeTerminal(): void {}
}
