import * as path from "path";
import {
  PromptStep,
  PriorContext,
  WorkflowStep,
  isScriptStep,
  ScriptRuntimeOutput,
} from "../types/FlightPathTypes";
import { WorkflowContext } from "../types/WorkflowContextTypes";
import { TypedEmitter } from "../utils/TypedEmitter";
import {
  CliResult,
  UniversalCliOutput,
  CliEvent,
} from "../types/CliOutputTypes";
import { AgentExpander } from "../utils/AgentExpander";
import { SkillExpander } from "../utils/SkillExpander";
import { ContextExpander } from "../utils/ContextExpander";
import type { SplitContext } from "../utils/ContextExpander";
import { Log } from "../utils/Log";
import { TempFileManager } from "../utils/TempFileManager";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { stripAnsiCodes } from "../utils/TerminalOutputSanitizer";
import { SplitConfig } from "../utils/PromptFileSplitter";
import {
  PRIOR_CONTEXT_KEYWORDS,
  PRIOR_CONTEXT_ITEM_TYPES,
  STEP_TYPES,
  PriorContextItemType,
} from "../types/DashboardConstants";
import type { InlinePriorContextRef } from "../utils/FileReferenceParser";
import type { FlightPathNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";

/**
 * Minimal container for VS Code-style disposable subscriptions.
 * Avoids importing the `vscode` module in the shared core, which must also
 * compile into the standalone CLI bundle (where `vscode` is not available).
 */
interface SubscriptionContainer {
  readonly subscriptions: Array<{ dispose(): void }>;
}

/** A single context item ready for XML serialization by insertPriorContext. */
export type PriorContextItem = {
  index: number;
  name?: string;
  /** The prompt text that was sent for this step. Absent for finalStep loop items and script steps. */
  prompt?: string;
  text: string;
  /** Discriminant set when the item originates from a finalStep/finalStep loop (not a queue prompt). */
  type?: PriorContextItemType;
  /** Structured script output. Present only for ScriptStep items; triggers script-specific XML rendering. */
  scriptOutput?: ScriptRuntimeOutput;
};

export function refToPriorContext(ref: InlinePriorContextRef): PriorContext {
  switch (ref.kind) {
    case "previous":
      return PRIOR_CONTEXT_KEYWORDS.PREVIOUS;
    case "all":
      return PRIOR_CONTEXT_KEYWORDS.ALL;
    case "finalStep":
      return PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS;
    case "allFinalStep":
      return PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL;
    case "step":
      return ref.indices;
  }
}

function deduplicatePriorContextItems(
  items: PriorContextItem[]
): PriorContextItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type ?? "queue"}:${item.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
 * Serialize a list of PriorContextItems into the <priorContext> XML block
 * that is injected into AI prompts.
 *
 * This is the single source of truth for the prior-context XML format.
 * Both live injection (HarnessIntegration) and the editor preview
 * (PriorContextPreviewBuilder) use this function, ensuring the preview
 * always matches what the AI actually receives.
 */
export function buildPriorContextXmlFromItems(
  contextItems: PriorContextItem[]
): string {
  const sortedItems = [...contextItems].sort((a, b) => a.index - b.index);
  const steps = sortedItems
    .map((item) => {
      const nameAttr = item.name ? ` name="${item.name}"` : "";
      if (item.scriptOutput) {
        const commandSection = `<command>\n${item.scriptOutput.command.trim()}\n</command>\n`;
        const stdoutSection = item.scriptOutput.stdout.trim()
          ? `<stdout>\n${stripAnsiCodes(item.scriptOutput.stdout.trim())}\n</stdout>\n`
          : "";
        const stderrSection = item.scriptOutput.stderr.trim()
          ? `<stderr>\n${stripAnsiCodes(item.scriptOutput.stderr.trim())}\n</stderr>\n`
          : "";
        const exitCodeSection =
          item.scriptOutput.exitCode !== undefined
            ? `<exitCode>${item.scriptOutput.exitCode}</exitCode>\n`
            : "";
        return `<step index="${item.index + 1}" type="${STEP_TYPES.SCRIPT}"${nameAttr}>\n${commandSection}${stdoutSection}${stderrSection}${exitCodeSection}</step>`;
      }
      const typeAttr = item.type ? ` type="${item.type}"` : "";
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
  private static readonly MAX_SIMPLE_PROMPT_LENGTH = 3000;
  /**
   * Characters safe to pass directly as a single CLI argument without falling back
   * to temp-file prompt assembly.
   *
   * The runtime launch path now uses argv-based process spawning instead of shell
   * command strings, but we still keep this fast-path conservative so large or
   * syntax-heavy prompts naturally flow into the file-based path.
   */
  private static readonly SAFE_CHARS_PATTERN =
    /^[a-zA-Z0-9\s.,!?:;\-_()@#/\\~]*$/;

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

  // Event emitter for streaming response chunks (plain text - for plain-text harnesses like Copilot CLI)
  protected streamingChunkEmitter = new TypedEmitter<string>();
  public readonly onStreamingChunk = this.streamingChunkEmitter.event;

  // Event emitter for structured streaming events (for Claude/Codex CLI)
  protected streamingEventsEmitter = new TypedEmitter<CliEvent[]>();
  public readonly onStreamingEvents = this.streamingEventsEmitter.event;

  // Event emitter for live context window updates (fires during streaming as events arrive)
  protected contextWindowUpdateEmitter = new TypedEmitter<{
    used: number;
    size: number;
  }>();
  public readonly onContextWindowUpdate = this.contextWindowUpdateEmitter.event;

  // Event emitter for prompt ready (fires when prompt is built but before execution)
  protected promptReadyEmitter = new TypedEmitter<{
    fullPrompt: string;
    cliCommand?: string;
  }>();
  public readonly onPromptReady = this.promptReadyEmitter.event;

  // Event emitter for hook notification events (fired by HookEventMonitor during execution)
  protected notificationEventEmitter =
    new TypedEmitter<FlightPathNotificationEvent>();
  public readonly onNotificationEvent = this.notificationEventEmitter.event;

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
      context.subscriptions.push(this.contextWindowUpdateEmitter);
      context.subscriptions.push(this.promptReadyEmitter);
      context.subscriptions.push(this.notificationEventEmitter);
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
    this.contextWindowUpdateEmitter.dispose();
    this.promptReadyEmitter.dispose();
    this.notificationEventEmitter.dispose();
  }

  /**
   * Gracefully terminate the underlying process before disposal.
   * For PTY-based harnesses (CliIntegration), sends Ctrl+C and waits before killing
   * so the CLI can clean up. No-op for all other harnesses.
   *
   * Call this before dispose() when the user explicitly restarts from beginning,
   * so the previous run's process exits cleanly rather than being hard-killed.
   */
  closeTerminalGracefully(): void {
    // no-op for non-PTY harnesses
  }

  /**
   * Returns true if this integration can be reused for the next run without disposing
   * and recreating it. True when inject mode is configured and the underlying PTY
   * session is still alive with a known inject context.
   *
   * Overridden by CliIntegration; all other harnesses return false (default).
   */
  canReuseForInject(): boolean {
    return false;
  }

  /**
   * Reset per-run mutable state so the integration can be handed to a new workflow
   * execution without side-effects from the previous run.
   * Called by WorkflowInstance when reusing a live integration via liveInjectIntegration.
   */
  resetForNewRun(): void {
    this.isCancelling = false;
    this.lastFailureReason = null;
  }

  /**
   * Register a one-shot callback that fires when the PTY session underlying this
   * integration exits (user killed the terminal, process crashed, etc.).
   * The callback is responsible for disposing the integration and clearing the
   * WorkflowInstance.liveInjectIntegration reference.
   *
   * Default: no-op for non-PTY harnesses. Overridden by CliIntegration.
   */
  onPtySessionEnded(_callback: () => void): void {
    // no-op for non-PTY integrations
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
    prompt: PromptStep,
    needsCompletionDetection?: boolean,
    workflowContext?: WorkflowContext
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
   * Returns each category separately so callers can write them to typed files:
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
    prompt: PromptStep,
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
   * @param joinSeparator Separator between clauses; callers choose the separator
   * appropriate for their transport.
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
      clauses.push(
        `Following these agent instructions ${agentRefs.join(", ")}`
      );
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
   * finalStep keywords ("finalStepAll", "finalStepPrevious") resolve against finalStepResponseTexts.
   *
   * Prompts/loops with no captured output are silently skipped.
   *
   * @param priorContext The resolved priorContext value
   * @param allPrompts All queue prompts in the workflow
   * @param currentIndex 0-based index of the prompt being built
   * @param finalStepResponseTexts Per-loop finalStep response texts (indexed by loopIndex)
   */
  protected gatherPriorContextItems(
    priorContext: PriorContext,
    allPrompts: WorkflowStep[],
    currentIndex: number,
    finalStepResponseTexts: string[] = []
  ): PriorContextItem[] {
    if (priorContext === PRIOR_CONTEXT_KEYWORDS.NONE) {
      return [];
    }

    // finalStep-specific keywords
    if (priorContext === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL) {
      const items = finalStepResponseTexts
        .map((text, i) => ({
          index: i,
          text,
          type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
        }))
        .filter((item) => item.text.length > 0);
      if (items.length === 0 && finalStepResponseTexts.length > 0) {
        Log.debug(
          `priorContext: no captured finalStep response text available yet`
        );
      }
      return items;
    }

    if (priorContext === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS) {
      const lastIndex = finalStepResponseTexts.length - 1;
      if (lastIndex < 0) {
        return [];
      }
      const text = finalStepResponseTexts[lastIndex];
      if (!text) {
        return [];
      }
      return [
        {
          index: lastIndex,
          text,
          type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
        },
      ];
    }

    // Queue-prompt keywords
    let targetIndices: number[];

    if (priorContext === PRIOR_CONTEXT_KEYWORDS.ALL) {
      targetIndices = Array.from({ length: currentIndex }, (_, i) => i);
    } else if (priorContext === PRIOR_CONTEXT_KEYWORDS.PREVIOUS) {
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
      .map((i): PriorContextItem | null => {
        const step = allPrompts[i];
        if (!step) return null;
        if (isScriptStep(step)) {
          const scriptOutput = step._runtime?.scriptOutput;
          if (!scriptOutput) return null;
          return {
            index: i,
            name: step.name,
            text: [
              scriptOutput.stdout,
              scriptOutput.stderr,
              scriptOutput.exitCode !== undefined
                ? String(scriptOutput.exitCode)
                : "",
            ]
              .filter(Boolean)
              .join("\n")
              .trim(),
            scriptOutput,
          };
        }
        return {
          index: i,
          name: step.name,
          prompt: step.prompt,
          text: step._runtime?.responseText ?? "",
        };
      })
      .filter(
        (item): item is PriorContextItem =>
          item !== null && item.text.length > 0
      );

    if (items.length === 0 && targetIndices.length > 0) {
      Log.debug(
        `priorContext: no captured response text found for any specified prompts at index ${currentIndex + 1}`
      );
    }

    return items;
  }

  protected gatherAndMergeContextItems(
    propertyContext: PriorContext | undefined,
    inlineRefs: InlinePriorContextRef[],
    allPrompts: WorkflowStep[],
    currentIndex: number,
    finalStepResponseTexts: string[] = []
  ): PriorContextItem[] {
    const propertyItems =
      propertyContext !== undefined &&
      propertyContext !== PRIOR_CONTEXT_KEYWORDS.NONE
        ? this.gatherPriorContextItems(
            propertyContext,
            allPrompts,
            currentIndex,
            finalStepResponseTexts
          )
        : [];

    const inlineItems = inlineRefs.flatMap((ref) =>
      this.gatherPriorContextItems(
        refToPriorContext(ref),
        allPrompts,
        currentIndex,
        finalStepResponseTexts
      )
    );

    return deduplicatePriorContextItems([...propertyItems, ...inlineItems]);
  }

  protected buildPriorContextXmlFromItems(
    contextItems: PriorContextItem[]
  ): string {
    return buildPriorContextXmlFromItems(contextItems);
  }

  protected buildPriorContextXml(contextItems: PriorContextItem[]): string {
    return buildPriorContextXmlFromItems(contextItems);
  }

  protected stripAnsiCodes(text: string): string {
    return stripAnsiCodes(text);
  }

  /**
   * Build the additional workflow-context text (prior context + critical instruction)
   * for injection into the prompt file section of a categorized split.
   *
   * Used by CopilotChatIntegration and any other integration that builds
   * categorized prompt files and needs to include workflow context in the
   * prompt file section.
   *
   * @returns Assembled text block, or empty string if nothing to inject
   */
  protected buildWorkflowContextText(
    promptIndex: number,
    allPrompts: WorkflowStep[],
    resolvedPriorContext?: PriorContext,
    inlinePriorContextRefs: InlinePriorContextRef[] = [],
    finalStepResponseTexts?: string[]
  ): string {
    if (
      (resolvedPriorContext === undefined ||
        resolvedPriorContext === PRIOR_CONTEXT_KEYWORDS.NONE) &&
      inlinePriorContextRefs.length === 0
    ) {
      return "";
    }
    const contextItems = this.gatherAndMergeContextItems(
      resolvedPriorContext,
      inlinePriorContextRefs,
      allPrompts,
      promptIndex,
      finalStepResponseTexts ?? []
    );
    if (contextItems.length === 0) {
      return "";
    }
    const isFinalStepContext =
      resolvedPriorContext === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL ||
      resolvedPriorContext === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS;
    Log.debug(
      `🔗 Injecting ${isFinalStepContext ? "finalStep" : "prior"} context for prompt ${promptIndex + 1}: ` +
        `${contextItems.length} step(s) from indices [${contextItems.map((c) => c.index + 1).join(", ")}]`
    );
    return this.buildPriorContextXmlFromItems(contextItems);
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
   * Delete temp prompt files created during execution.
   * No-op if the array is empty, no workspace root is available, or
   * execution.autoDeleteTempFiles is false (user wants to inspect files).
   */
  protected async deleteTempFiles(tempFilePaths: string[]): Promise<void> {
    if (tempFilePaths.length === 0) {
      return;
    }
    if (!ConfigurationUtils.shouldAutoDeleteTempFiles()) {
      Log.debug(
        `🗂️ Keeping ${tempFilePaths.length} temp file(s) (autoDeleteTempFiles=false)`
      );
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
   * - No shell-dangerous characters (quotes, backslashes, newlines, metacharacters, etc.)
   *
   * **CLI behavior:** We still keep this fast path conservative even though runtime
   * execution now uses argv-based spawning rather than shell command strings. Complex
   * prompts are better handled through temp files so the harness receives the exact
   * structured content without relying on large inline arguments.
   *
   * For chat harnesses the same check applies as a fast-path gate: if it passes,
   * the prompt is short and clean enough to type inline, skipping temp file I/O.
   *
   * @param promptText The prompt text
   * @returns true if prompt can be passed directly
   */
  protected isSimplePrompt(promptText: string): boolean {
    if (promptText.length > HarnessIntegration.MAX_SIMPLE_PROMPT_LENGTH) {
      return false;
    }

    // Only allow: letters, numbers, spaces, and basic safe punctuation.
    // If anything else exists, use file-based passing.
    if (!HarnessIntegration.SAFE_CHARS_PATTERN.test(promptText)) {
      Log.debug(
        "📁 Prompt contains special characters, using file-based passing for safety"
      );
      return false;
    }

    if (/[\n\r\t]/.test(promptText)) {
      Log.debug("📁 Prompt contains newlines/tabs, using file-based passing");
      return false;
    }

    return true;
  }

  /**
   * Check if a prompt is safe to inject directly into a running TUI via PTY stdin.
   *
   * Inject mode writes text to the PTY's stdin directly — no shell spawning, no
   * CreateProcess, no argument parsing. The only characters that must be excluded
   * are ASCII control codes that could disrupt the TUI or trigger input submission:
   *
   *   - `\x00–\x1f` — NUL, TAB (`\t`), LF (`\n`), CR (`\r`, the submit key), ESC, etc.
   *   - `\x7f` — DEL
   *
   * There is no length restriction: PTY writes are not subject to OS command-line
   * limits (CreateProcess's 32767-char cap on Windows applies only to spawned shells).
   * Shell metacharacters (`"`, `'`, `$`, backticks, `\`) are safe because no shell
   * parsing occurs.
   *
   * @param promptText The prompt text to check
   * @returns true if the prompt can be injected directly into the running TUI
   */
  protected isInjectablePrompt(promptText: string): boolean {
    if (/[\x00-\x1f\x7f]/.test(promptText)) {
      Log.debug(
        "📁 Prompt contains control characters, using file-based passing for inject mode"
      );
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
   * Get supplemental plain-text output captured for the last prompt-send
   * failure, such as the tail of PTY output from an interactive CLI crash.
   * Returns undefined when no additional failure output is available.
   */
  getLastFailureOutput(): string | undefined {
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
   * Check if the last sendPrompt failure was due to the CLI process exiting
   * before completion was detected. All CLI harnesses are TUIs that stay open
   * between prompts, so any process exit before a Stop hook or log-based
   * completion event is abnormal (Ctrl+C, crash, SIGKILL).
   * Returns false by default. CliIntegration overrides this.
   */
  wasLastFailureProcessExit(): boolean {
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
