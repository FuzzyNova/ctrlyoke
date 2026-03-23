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
import type { SplitContext } from "../utils/ContextExpander";
import { Log } from "../utils/Log";
import { ResolvedProperties } from "../utils/PropertyResolver";
import { TempFileManager } from "../utils/TempFileManager";
import { PromptFileSplitter, SplitConfig } from "../utils/PromptFileSplitter";
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
  /** The prompt text that was sent for this step. Absent for finalPrompt loop items. */
  prompt?: string;
  text: string;
  /** "finalPrompt" when the item originates from a finalPrompt loop (not a queue prompt). */
  type?: "finalPrompt";
};

/**
 * Categorized sections of a prompt — used for typed file splitting.
 * Each category is written to its own temp file so the harness (and Copilot's
 * auto-summarizer) can navigate the content without stripping the user prompt.
 */
export interface PromptSections {
  /** Expanded <skillInstructions> block, or null if no skills */
  skillContent: string | null;
  /** Expanded agent file content (without wrapper tags), or null if no agent */
  agentContent: string | null;
  /** Absolute paths for full-file @path refs — harness reads these directly */
  directFileRefs: string[];
  /** Embedded XML attachment blocks for selection/sym/git/dir content, or null */
  excerptContent: string | null;
  /** The raw user prompt text (with @path tokens preserved as-is) */
  userPromptText: string;
}

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
  /** Maximum character length for prompts passed directly on the command line. */
  private static readonly MAX_SIMPLE_PROMPT_LENGTH = 300;
  /** Characters safe to pass directly on the command line without temp-file escaping. */
  private static readonly SAFE_CHARS_PATTERN = /^[a-zA-Z0-9\s.,!?:;\-_()@#/]*$/;

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
      /** Session ID from the most recent finalPrompt execution. Consumed by SessionResolver
       *  when sessionId is the "finalPrompt" sentinel on any prompt (queue or finalPrompt phase). */
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
   * Build prompt sections from prompt item, separating content by category.
   *
   * Unlike buildPromptText() which merges everything into one blob, this method
   * returns each category separately so callers can write them to typed files:
   *   agent instructions → <ts>-<name>.agent.prompt.md
   *   skills             → <ts>-<name>.skills.prompt.md
   *   direct file refs   → @path inline in instruction string (harness auto-reads)
   *   excerpts           → <ts>-<name>.excerpts.prompt.md
   *   user prompt        → <ts>-<name>.prompt.md
   *
   * @param prompt The prompt item to build sections for
   * @param resolvedAgent Optional resolved agent name
   * @param resolvedSkills Optional resolved skill names
   * @returns Categorized prompt sections
   */
  protected async buildPromptSections(
    prompt: PromptItem,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ): Promise<PromptSections> {
    const userPromptText = prompt.prompt.trim();
    const workspaceRoot = this.getWorkspaceRoot();

    // Expand context into direct file refs + excerpt blocks (split, not merged)
    let splitContext: SplitContext = { directFileRefs: [], excerptBlocks: "" };
    if (workspaceRoot) {
      try {
        const expander = new ContextExpander(workspaceRoot);
        splitContext = await expander.expandContextSplit(userPromptText);
      } catch (error) {
        Log.error("[HarnessIntegration] Error in expandContextSplit:", error);
      }
    }

    const skillContent = resolvedSkills?.length
      ? await this.expandSkillBlock(resolvedSkills, workspaceRoot)
      : null;

    const agentContent = resolvedAgent
      ? await this.expandAgentBlock(resolvedAgent, workspaceRoot)
      : null;

    return {
      skillContent,
      agentContent,
      directFileRefs: splitContext.directFileRefs,
      excerptContent: splitContext.excerptBlocks || null,
      userPromptText,
    };
  }

  /**
   * Format categorized file references into a structured instruction string.
   *
   * Single source of truth for both CLI and Chat harnesses.
   *
   * Format (absent categories omitted):
   *   Following these agent instructions <agentRefs>,
   *   using these available skills <skillRefs>,
   *   using these file references <directRefs>,
   *   with this prior conversation context <contextRefs>,
   *   and these attachment excerpts <excerptRefs>,
   *   follow the instructions in <promptRefs>
   *
   * When only a prompt exists: "Follow instructions in <promptRefs> "
   *
   * The excerpt prefix is "using" when it is the first clause, "and" otherwise.
   *
   * @param joinSeparator Separator between clauses — ",\n" for CLI, ", " for Chat
   */
  protected static formatCategorizedInstruction(
    agentRefs: string[],
    skillRefs: string[],
    directRefs: string[],
    contextRefs: string[],
    excerptRefs: string[],
    promptRefs: string[],
    joinSeparator = ",\n"
  ): string {
    const clauses: string[] = [];

    if (agentRefs.length > 0) {
      clauses.push(`Following these agent instructions ${agentRefs.join(", ")}`);
    }
    if (skillRefs.length > 0) {
      clauses.push(`using these available skills ${skillRefs.join(", ")}`);
    }
    if (directRefs.length > 0) {
      clauses.push(`using these file references ${directRefs.join(", ")}`);
    }
    if (contextRefs.length > 0) {
      clauses.push(
        `with this prior conversation context ${contextRefs.join(", ")}`
      );
    }
    if (excerptRefs.length > 0) {
      const excerptPrefix = clauses.length === 0 ? "using" : "and";
      clauses.push(
        `${excerptPrefix} these attachment excerpts ${excerptRefs.join(", ")}`
      );
    }

    const followClause = `follow the instructions in ${promptRefs.join(", ")}`;

    if (clauses.length === 0) {
      return `Follow instructions in ${promptRefs.join(", ")} `;
    }

    return clauses.join(joinSeparator) + `${joinSeparator}${followClause} `;
  }

  /**
   * Build prompt text from prompt item.
   * Assembles in the canonical section order (without priorContext):
   *   <skillInstructions> → <agentInstructions> → <attachment> blocks → user prompt
   *
   * Used by CopilotChatIntegration when building temp files for attachment.
   * For the full prompt sent to AI (including priorContext and injected instructions),
   * see buildPromptWithInstructions.
   *
   * @param prompt The prompt item to build text for
   * @param resolvedAgent Optional resolved agent name
   * @param resolvedSkills Optional resolved skill names
   */
  protected async buildPromptText(
    prompt: PromptItem,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ): Promise<string> {
    const userPromptText = prompt.prompt.trim();
    const workspaceRoot = this.getWorkspaceRoot();

    // Expand context references to get just the attachment section
    const attachmentSection = await this.expandContextOnly(userPromptText);

    // Build skill block
    const skillContent = resolvedSkills?.length
      ? await this.expandSkillBlock(resolvedSkills, workspaceRoot)
      : null;

    // Build agent block
    const agentContent = resolvedAgent
      ? await this.expandAgentBlock(resolvedAgent, workspaceRoot)
      : null;

    // Assemble: skills → agent → attachments → userPrompt
    const sections: string[] = [];
    if (skillContent) {
      sections.push(skillContent);
    }
    if (agentContent) {
      sections.push(
        `<agentInstructions>\n${agentContent}\n</agentInstructions>`
      );
    }
    if (attachmentSection) {
      sections.push(attachmentSection);
    }
    sections.push(userPromptText);

    return sections.join("\n\n");
  }

  /**
   * Expand context references in the prompt and return ONLY the attachment XML section.
   * Returns an empty string if no workspace is available or no file references are found.
   */
  private async expandContextOnly(userPromptText: string): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      Log.warn("No workspace root, skipping context expansion");
      return "";
    }
    try {
      const expander = new ContextExpander(workspaceRoot);
      const expanded = await expander.expandContext(userPromptText);
      if (expanded === userPromptText) {
        return ""; // No attachments were added
      }
      // ContextExpander returns: `${attachmentsSection}\n\n${promptText}`
      // Strip the trailing "\n\n" + userPromptText to isolate the attachment section.
      const suffix = "\n\n" + userPromptText;
      if (expanded.endsWith(suffix)) {
        return expanded.slice(0, -suffix.length);
      }
      Log.warn(
        "Unexpected ContextExpander output format, skipping attachments"
      );
      return "";
    } catch (error) {
      Log.error("Error expanding context:", error);
      return "";
    }
  }

  /**
   * Expand a block of content, logging success or warning on failure.
   * Returns the content string, or null if nothing resolved.
   */
  private async expandBlockContent(
    expander: () => Promise<string | null>,
    successMsg: string,
    warnMsg: string
  ): Promise<string | null> {
    const content = await expander();
    if (content) {
      Log.debug(successMsg);
    } else {
      Log.warn(warnMsg);
    }
    return content;
  }

  /**
   * Expand skill names to a <skillInstructions> block.
   * Returns null if no skills are provided or none resolve.
   */
  protected async expandSkillBlock(
    resolvedSkills: string[],
    workspaceRoot: string | undefined
  ): Promise<string | null> {
    return this.expandBlockContent(
      () => SkillExpander.expandSkills(resolvedSkills, workspaceRoot),
      `🎯 Skills [${resolvedSkills.join(", ")}] instructions added to prompt`,
      `⚠️ No skills resolved from [${resolvedSkills.join(", ")}], continuing without skills`
    );
  }

  /**
   * Expand an agent name to its file content for use in <agentInstructions>.
   * Returns null if the agent is not found.
   */
  private async expandAgentBlock(
    resolvedAgent: string,
    workspaceRoot: string | undefined
  ): Promise<string | null> {
    return this.expandBlockContent(
      () => AgentExpander.expandAgent(resolvedAgent, workspaceRoot),
      `🤖 Agent "${resolvedAgent}" instructions added to prompt`,
      `⚠️ Agent "${resolvedAgent}" not found, continuing without agent`
    );
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
  protected gatherPriorContextItems(
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
        prompt: allPrompts[i]?.prompt,
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
   * Build the <priorContext> XML block from gathered context items.
   * finalPrompt loop items carry type="finalPrompt" on the <step> element.
   */
  protected buildPriorContextXml(contextItems: PriorContextItem[]): string {
    const steps = contextItems
      .map((item) => {
        const typeAttr = item.type ? ` type="${item.type}"` : "";
        const nameAttr = item.name ? ` name="${item.name}"` : "";
        const promptSection = item.prompt
          ? `<prompt>\n${item.prompt.trim()}\n</prompt>\n`
          : "";
        const responseSection = `<response>\n${item.text.trim()}\n</response>`;
        return `<step index="${item.index + 1}"${typeAttr}${nameAttr}>\n${promptSection}${responseSection}\n</step>`;
      })
      .join("\n");

    return `<priorContext>\n${steps}\n</priorContext>`;
  }


  /**
   * Build the additional workflow-context text (prior context + critical instruction)
   * for injection into the prompt file section of a categorized split.
   *
   * Used by CopilotChatIntegration and any other integration that builds
   * categorized prompt files and needs to include workflow context in the
   * prompt file (rather than in the blob from buildPromptWithInstructions).
   *
   * @returns Assembled text block, or empty string if nothing to inject
   */
  protected buildWorkflowContextText(
    promptIndex: number,
    allPrompts: PromptItem[],
    resolvedPriorContext?: PriorContext,
    finalPromptResponseTexts?: string[]
  ): string {
    if (resolvedPriorContext === undefined || resolvedPriorContext === "none") {
      return "";
    }
    const contextItems = this.gatherPriorContextItems(
      resolvedPriorContext,
      allPrompts,
      promptIndex,
      finalPromptResponseTexts ?? []
    );
    if (contextItems.length === 0) {
      return "";
    }
    const isFinalPromptContext =
      resolvedPriorContext === "finalPromptAll" ||
      resolvedPriorContext === "finalPromptPrevious";
    Log.debug(
      `🔗 Injecting ${isFinalPromptContext ? "finalPrompt" : "prior"} context for prompt ${promptIndex + 1}: ` +
        `${contextItems.length} step(s) from indices [${contextItems.map((c) => c.index + 1).join(", ")}]`
    );
    return this.buildPriorContextXml(contextItems);
  }

  /**
   * Build the fully assembled prompt for sending to AI.
   *
   * Section order (canonical):
   *   <skillInstructions> → <agentInstructions> → <priorContext>
   *   → <attachment> blocks → user prompt
   *
   * @param prompt The prompt item
   * @param promptIndex Current prompt index
   * @param allPrompts All prompts in the workflow
   * @param resolvedAgent Resolved agent name for prompt prepending
   * @param resolvedSkills Resolved skill names for frontmatter injection
   * @param resolvedPriorContext Prior context injection setting
   * @param finalPromptResponseTexts Per-loop finalPrompt response texts (for "finalPromptAll"/"finalPromptPrevious")
   * @param isResumedSession Whether this prompt is continuing an existing session.
   *   When true and `flightpath.omitAgentsAndSkillsOnResume` is enabled, agent and skill
   *   blocks are omitted to prevent duplicate instructions in the resumed session.
   * @returns Fully assembled prompt text
   */
  protected async buildPromptWithInstructions(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[],
    resolvedAgent?: string,
    resolvedSkills?: string[],
    resolvedPriorContext?: PriorContext,
    finalPromptResponseTexts?: string[],
    isResumedSession?: boolean
  ): Promise<string> {
    const userPromptText = prompt.prompt.trim();
    const workspaceRoot = this.getWorkspaceRoot();

    // 1. Attachment section (file/directory context references)
    const attachmentSection = await this.expandContextOnly(userPromptText);

    // Determine whether to omit agent/skill blocks for this prompt.
    // When the setting is enabled and this prompt resumes an existing session,
    // the harness already has those instructions from the first message.
    const omitAgentsAndSkills =
      isResumedSession &&
      ConfigurationUtils.shouldOmitAgentsAndSkillsOnResume();

    if (omitAgentsAndSkills) {
      Log.debug(
        "⏭️ Omitting agent and skill blocks (resuming existing session)"
      );
    }

    // 2. Skill block
    const skillContent =
      !omitAgentsAndSkills && resolvedSkills?.length
        ? await this.expandSkillBlock(resolvedSkills, workspaceRoot)
        : null;

    // 3. Agent block
    const agentContent =
      !omitAgentsAndSkills && resolvedAgent
        ? await this.expandAgentBlock(resolvedAgent, workspaceRoot)
        : null;

    // 4. Prior context block
    let priorContextBlock = "";
    if (resolvedPriorContext !== undefined && resolvedPriorContext !== "none") {
      const contextItems = this.gatherPriorContextItems(
        resolvedPriorContext,
        allPrompts,
        promptIndex,
        finalPromptResponseTexts ?? []
      );
      if (contextItems.length > 0) {
        priorContextBlock = this.buildPriorContextXml(contextItems);
        const isFinalPromptContext =
          resolvedPriorContext === "finalPromptAll" ||
          resolvedPriorContext === "finalPromptPrevious";
        Log.debug(
          `🔗 Injecting ${isFinalPromptContext ? "finalPrompt" : "prior"} context for prompt ${promptIndex + 1}: ` +
            `${contextItems.length} step(s) from indices [${contextItems.map((c) => c.index + 1).join(", ")}]`
        );
      }
    }

    // Assemble in canonical order:
    //   skills → agent → priorContext → attachments → userPrompt
    const sections: string[] = [];
    if (skillContent) {
      sections.push(skillContent);
    }
    if (agentContent) {
      sections.push(
        `<agentInstructions>\n${agentContent}\n</agentInstructions>`
      );
    }
    if (priorContextBlock) {
      sections.push(priorContextBlock);
    }
    if (attachmentSection) {
      sections.push(attachmentSection);
    }
    sections.push(userPromptText);

    return sections.join("\n\n");
  }

  /**
   * Return the SplitConfig to use when creating temp prompt files.
   * Override in subclasses to apply harness-specific limits.
   * Default returns undefined (PromptFileSplitter uses its built-in defaults).
   */
  protected getTempFileSplitConfig(): SplitConfig | undefined {
    return undefined;
  }

  /**
   * Create temp prompt file(s) from expanded prompt text.
   * Handles large-prompt splitting (>10K tokens or >1800 lines) via PromptFileSplitter.
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
    const splitter = new PromptFileSplitter(this.getTempFileSplitConfig());
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
   * Extract the leading slash command from user prompt text.
   *
   * Returns the slash command token (e.g., "/handoff") if the text starts with
   * one, or null if no leading slash command is present.
   *
   * A slash command is "/" followed by one or more word characters (\w+).
   * Examples: "/handoff", "/compact", "/context".
   */
  protected extractLeadingSlashCommand(text: string): string | null {
    const match = text.match(/^(\/\w+)/);
    return match ? match[1] : null;
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
    if (finalPromptText.length > HarnessIntegration.MAX_SIMPLE_PROMPT_LENGTH) {
      return false;
    }

    // Only allow: letters, numbers, spaces, and basic safe punctuation.
    // If anything else exists, use file-based passing.
    if (!HarnessIntegration.SAFE_CHARS_PATTERN.test(finalPromptText)) {
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
