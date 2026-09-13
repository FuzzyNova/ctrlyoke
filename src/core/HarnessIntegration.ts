import {
  PromptStep,
  PriorContext,
  ScriptRuntimeOutput,
  type FailureKind,
} from "../types/CtrlYokeTypes";
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
import type {
  SkippedReference,
  SourceRuntimeCopy,
  SplitContext,
} from "../utils/ContextExpander";
import { Log } from "../utils/Log";
import { TempFileManager } from "../utils/TempFileManager";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import {
  getTrustedSourceDefinitionDir,
  resolveEffectiveAbsoluteReferences,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import { stripAnsiCodes } from "../utils/TerminalOutputSanitizer";
import { SplitConfig } from "../utils/PromptFileSplitter";
import {
  PRIOR_CONTEXT_KEYWORDS,
  PRIOR_CONTEXT_REFERENCE_KINDS,
  CTRLYOKE_MCP_MODES,
  MCP_SKILL_NAMES,
  STEP_TYPES,
  PriorContextItemType,
} from "../types/DashboardConstants";
import {
  ctrlYokeDeniedToolNames,
  ctrlYokeToolFamilies,
} from "../types/ExecutionPropertyResolver";
import type { InlinePriorContextRef } from "../utils/FileReferenceParser";
import { scanCtrlYokeSlashTokens } from "../utils/CtrlYokeSlashTokens";
import type { CtrlYokeNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";
import { CliProviderUtils } from "./harness/shared/CliProviderUtils";

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

function skillsForPrompt(
  resolvedSkills: string[] | undefined,
  workflowContext: WorkflowContext | undefined
): string[] | undefined {
  if (!resolvedSkills?.length || !workflowContext) return resolvedSkills;

  const isParallelMember = workflowContext.workflowFile?.parallelGroups?.some(
    (group) =>
      workflowContext.promptIndex >= group.startIndex &&
      workflowContext.promptIndex <= group.endIndex
  );
  if (
    !isParallelMember ||
    workflowContext.resolvedProperties?.ctrlyokeMcpMode !==
      CTRLYOKE_MCP_MODES.SKILL ||
    !workflowContext.resolvedProperties ||
    !ctrlYokeToolFamilies(workflowContext.resolvedProperties).workflow
  ) {
    return resolvedSkills;
  }

  return resolvedSkills.filter((skill) => skill !== MCP_SKILL_NAMES.TOOLS);
}

/**
 * Carry the step's ctrlyoke denials into skill generation so a denied tool is
 * never documented. The executor builds the address half of this context; the
 * denial half is only known once properties are resolved for the step.
 */
function mcpToolSkillContextForPrompt(
  workflowContext: WorkflowContext | undefined
): WorkflowContext["mcpToolSkillContext"] {
  const context = workflowContext?.mcpToolSkillContext;
  if (!context || !workflowContext?.resolvedProperties) return context;
  return {
    ...context,
    deniedTools: ctrlYokeDeniedToolNames(workflowContext.resolvedProperties),
  };
}

export function refToPriorContext(ref: InlinePriorContextRef): PriorContext {
  switch (ref.kind) {
    case PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS:
      return PRIOR_CONTEXT_KEYWORDS.PREVIOUS;
    case PRIOR_CONTEXT_REFERENCE_KINDS.ALL:
      return PRIOR_CONTEXT_KEYWORDS.ALL;
    case PRIOR_CONTEXT_REFERENCE_KINDS.FINAL_STEP:
      return PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS;
    case PRIOR_CONTEXT_REFERENCE_KINDS.ALL_FINAL_STEP:
      return PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL;
    case PRIOR_CONTEXT_REFERENCE_KINDS.STEP:
      return ref.indices;
  }
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
  /** Resolved image files among directFileRefs. */
  imageFileRefs: string[];
  /** Source-only full-file refs copied into the execution checkout before launch. */
  sourceRuntimeCopies: SourceRuntimeCopy[];
  /** Source-runtime reference tokens read in place as excerpts. */
  sourceRuntimeReadReferences: string[];
  /** Embedded XML attachment blocks for selection/sym/git/dir content, or null */
  excerptContent: string | null;
  /**
   * The user prompt text, with @path/#selection:/#sym: reference tokens
   * sanitized (folder-name-prefixed paths resolved, provider-specific @
   * handling applied) via {@link ContextExpander.sanitizeReferences}.
   */
  userPromptText: string;
  /** References that could not be attached — see {@link SkippedReference}. */
  skippedReferences: SkippedReference[];
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

export interface WorkflowArtifactCleanupResult {
  cleaned: boolean;
  failures: string[];
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
  /** Authored workflow definition used as the base for workflow-relative refs. */
  protected sourceDefinitionPath?: string;

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
    cliCommandWasInjected?: boolean;
  }>();
  public readonly onPromptReady = this.promptReadyEmitter.event;

  // Event emitter for hook notification events (fired by HookEventMonitor during execution)
  protected notificationEventEmitter =
    new TypedEmitter<CtrlYokeNotificationEvent>();
  public readonly onNotificationEvent = this.notificationEventEmitter.event;

  /**
   * Event emitter for session activity observed *after* a prompt's per-prompt
   * monitor has already resolved — a harness auto-resuming a backgrounded task,
   * or a human typing directly into the live TUI. Fired by `SessionActivityWatcher`
   * (via `CliIntegration`); no-op source for non-PTY harnesses. Display-only:
   * consumers append to existing output/history, never mutate workflow state.
   */
  protected sessionActivityResumedEmitter = new TypedEmitter<{
    events: CliEvent[];
  }>();
  public readonly onSessionActivityResumed =
    this.sessionActivityResumedEmitter.event;

  /** Stable transport session identity used for post-completion attribution. */
  getActivitySessionId(): string | undefined {
    return undefined;
  }

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
      context.subscriptions.push(this.sessionActivityResumedEmitter);
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
    this.sessionActivityResumedEmitter.dispose();
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
   * Returns true if this integration should be kept alive across workflow
   * runs so its own session-activity watcher can keep tailing for
   * post-completion follow-ups (a harness auto-resuming a backgrounded task,
   * or a human typing directly into a still-open chat) rather than being
   * disposed the moment a run ends.
   *
   * Distinct from `canReuseForInject()`, which is specifically about resuming
   * a live PTY session for the *next prompt's* inject-mode dispatch — this is
   * about keeping a non-PTY integration's own long-lived watcher alive.
   *
   * Default: false. Overridden by non-PTY harness integrations that need a
   * post-completion session-activity watcher to keep running.
   */
  shouldPersistForSessionActivity(): boolean {
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
   * Returns true when workflow artifacts must remain installed while this
   * integration is retained for reuse. Most harnesses load their hooks when
   * the process starts, so their workspace artifacts can be cleaned as soon as
   * execution completes. Harnesses that re-read hook configuration for an
   * injected turn override this and defer cleanup until the integration exits.
   */
  shouldRetainWorkflowArtifactsForReuse(): boolean {
    return false;
  }

  /** Identity of the execution workspace this integration is bound to. */
  getExecutionWorkspaceIdentity(): string | undefined {
    return this.getExecutionWorkspaceRoot();
  }

  /** Public execution-root view for lifecycle cleanup and diagnostics. */
  getExecutionRoot(): string | undefined {
    return this.getExecutionWorkspaceRoot();
  }

  /**
   * Clean up workflow-scoped artifacts created during execution (e.g. MCP config files).
   *
   * Called from WorkflowInstance after execution completes, or when a retained
   * integration is retired if shouldRetainWorkflowArtifactsForReuse() opts into
   * deferred cleanup. Default is a no-op; CliIntegration delegates to
   * provider-owned artifact cleanup.
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
   * Strict terminal cleanup used by managed worktrees. The legacy cleanup
   * method intentionally remains best-effort for retained/native sessions;
   * managed settlement needs an explicit proof barrier before it commits.
   */
  async cleanupWorkflowArtifactsStrict(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): Promise<WorkflowArtifactCleanupResult> {
    try {
      await this.cleanupWorkflowArtifacts(workingFilePath, workspaceRoot);
      return { cleaned: true, failures: [] };
    } catch (error) {
      return {
        cleaned: false,
        failures: [error instanceof Error ? error.message : String(error)],
      };
    }
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

  /** Set the authored workflow path used by inline reference expansion. */
  setSourceDefinitionPath(sourceDefinitionPath: string | undefined): void {
    this.sourceDefinitionPath = sourceDefinitionPath;
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
    resolvedSkills?: string[],
    workflowContext?: WorkflowContext
  ): Promise<PromptSections> {
    const rawPromptText = prompt.prompt.trim();
    let userPromptText = rawPromptText;
    const workspaceRoot = this.getExecutionWorkspaceRoot();

    // Expand context into direct file refs + excerpt blocks (split, not merged)
    let splitContext: SplitContext = {
      directFileRefs: [],
      imageFileRefs: [],
      sourceRuntimeCopies: [],
      sourceRuntimeReadReferences: [],
      excerptBlocks: "",
      skippedReferences: [],
    };
    if (workspaceRoot) {
      try {
        const effectiveAbsolute = resolveEffectiveAbsoluteReferences(
          ConfigurationUtils.shouldUseAbsolutePathReferences(),
          this.getExecutionWorkspaceRoots().length > 1
        );
        const expander = new ContextExpander({
          workspaceRoot,
          additionalTrustedRoots: [
            ...this.getExecutionWorkspaceRoots(),
            ...this.getApprovedExternalRoots(workflowContext),
          ],
          namedRoots: this.getExecutionNamedWorkspaceRoots(),
          effectiveAbsolute,
          sourceDefinitionDir: this.getSourceDefinitionDir(workflowContext),
          allowWorkflowRelativeReferences:
            this.allowsWorkflowRelativeReferences(),
          sourceCheckoutRoot: this.getExecutionSourceCheckoutRoot(),
        });
        splitContext = await expander.expandContextSplit(rawPromptText);
        // Rewrite folder-name-prefixed refs to their resolved form inline,
        // for consumers (simple-prompt fast path, direct PTY injection) that
        // send userPromptText verbatim instead of going through splitContext.
        userPromptText = await expander.sanitizeReferences(
          rawPromptText,
          (quotedPath) => this.formatInlineFileReference(quotedPath)
        );
      } catch (error) {
        Log.error("[HarnessIntegration] Error in expandContextSplit:", error);
      }
    }

    const promptSkills = skillsForPrompt(resolvedSkills, workflowContext);
    const skillContent = promptSkills?.length
      ? await this.expandSkillBlock(
          promptSkills,
          workspaceRoot,
          this.getExecutionCheckoutRoot(),
          mcpToolSkillContextForPrompt(workflowContext)
        )
      : null;

    const agentContent = resolvedAgent
      ? await this.expandAgentBlock(resolvedAgent, workspaceRoot)
      : null;

    return {
      skillContent,
      agentContent,
      directFileRefs: splitContext.directFileRefs,
      imageFileRefs: splitContext.imageFileRefs,
      sourceRuntimeCopies: splitContext.sourceRuntimeCopies,
      sourceRuntimeReadReferences: splitContext.sourceRuntimeReadReferences,
      excerptContent: splitContext.excerptBlocks || null,
      userPromptText,
      skippedReferences: splitContext.skippedReferences,
    };
  }

  /**
   * Format categorized file references into a structured instruction string.
   *
   * Single source of truth for both CLI and Chat harnesses.
   *
   * Format (absent categories omitted):
   *   Following these agent instructions <agentRefs>,
   *   using these secrets <secretRefs>,
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
    joinSeparator = ",\n",
    secretRefs: string[] = []
  ): string {
    const clauses: string[] = [];

    if (agentRefs.length > 0) {
      clauses.push(
        `Following these agent instructions ${agentRefs.join(", ")}`
      );
    }
    if (secretRefs.length > 0) {
      clauses.push(`using these secrets ${secretRefs.join(", ")}`);
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
    workspaceRoot: string | undefined,
    executionCheckoutRoot: string | undefined,
    runContext?: WorkflowContext["mcpToolSkillContext"]
  ): Promise<string | null> {
    return this.expandBlockContent(
      () =>
        // Live execution expands the run address into the generated skill.
        // Export omits this argument so its snapshot intentionally keeps placeholders.
        SkillExpander.expandSkills(
          resolvedSkills,
          workspaceRoot,
          executionCheckoutRoot,
          runContext
        ),
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

  protected buildPriorContextXmlFromItems(
    contextItems: PriorContextItem[]
  ): string {
    return buildPriorContextXmlFromItems(contextItems);
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
        `[HarnessIntegration] Keeping ${tempFilePaths.length} temp file(s) (autoDeleteTempFiles=false)`
      );
      return;
    }
    const workspaceRoot = this.getExecutionWorkspaceRoot();
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
    const leadingCtrlYokeToken = scanCtrlYokeSlashTokens(text)[0];
    if (leadingCtrlYokeToken?.index === 0) {
      return null;
    }
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
        "[HarnessIntegration] Prompt contains special characters, using file-based passing for safety"
      );
      return false;
    }

    if (/[\n\r\t]/.test(promptText)) {
      Log.debug(
        "[HarnessIntegration] Prompt contains newlines/tabs, using file-based passing"
      );
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
        "[HarnessIntegration] Prompt contains control characters, using file-based passing for inject mode"
      );
      return false;
    }
    return true;
  }

  /**
   * Format an already-quoted path as an inline `@file` reference token, for
   * {@link ContextExpander.sanitizeReferences}'s rewrite of literal `@path`
   * mentions in prompt text. Base implementation is the CLI-native `@`
   * prefix; `CliIntegration` overrides this to honor `ICliProvider.
   * formatFileReference` (e.g. Codex, which drops the `@` entirely) — the
   * same provider hook used for ctrlyoke-generated file references.
   */
  protected formatInlineFileReference(quotedPath: string): string {
    return `@${quotedPath}`;
  }

  /**
   * Get workspace root directory
   */
  protected getWorkspaceRoot(): string | undefined {
    return undefined;
  }

  /** Explicit execution root; getWorkspaceRoot retains its state-root meaning. */
  protected getExecutionWorkspaceRoot(): string | undefined {
    return this.getWorkspaceRoot();
  }

  /** Canonical source checkout used for read-only runtime artifact fallback. */
  protected getExecutionSourceCheckoutRoot(): string | undefined {
    return undefined;
  }

  /** Canonical checkout root visible to the harness during execution. */
  protected getExecutionCheckoutRoot(): string | undefined {
    return undefined;
  }

  /**
   * Get every directory that should be trusted as "inside the workspace" for
   * path-containment checks (e.g. `@file` prompt references). Defaults to
   * just `getWorkspaceRoot()`; overridden where a platform adapter can supply
   * the full multi-root list (see `CliIntegration`).
   */
  protected getWorkspaceRoots(): string[] {
    const root = this.getWorkspaceRoot();
    return root ? [root] : [];
  }

  /** Workspace roots visible to the harness process and prompt resolver. */
  protected getExecutionWorkspaceRoots(): string[] {
    const root = this.getExecutionWorkspaceRoot();
    return root ? [root] : [];
  }

  /**
   * Named roots (folder name → path) for folder-name-prefixed multi-root ref
   * resolution (`root2/src/index.ts`). Defaults to none; overridden where a
   * platform adapter can supply the full multi-root list (see `CliIntegration`).
   */
  protected getNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    return [];
  }

  protected getExecutionNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    return this.getNamedWorkspaceRoots();
  }

  protected getApprovedExternalRoots(
    workflowContext?: WorkflowContext
  ): string[] {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return [];
    }

    const workflowRoots = workflowContext
      ? CliProviderUtils.getWorkflowExternalRootsContext(
          workspaceRoot,
          workflowContext
        )
      : undefined;
    return ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      workflowRoots?.workspaceIdentity ??
        ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot),
      workflowRoots
        ? {
            identity: workflowRoots.identity,
            declaredRoots: workflowRoots.declaredRoots,
          }
        : undefined
    );
  }

  /** Semantic definition path used by execution-side reference expansion. */
  protected getExecutionSourceDefinitionPath(): string | undefined {
    return this.sourceDefinitionPath;
  }

  /** Whether workflow-relative refs have a safe execution-side base. */
  protected allowsWorkflowRelativeReferences(): boolean {
    return true;
  }

  /**
   * Return the trusted directory containing the authored workflow definition.
   * The run working copy is intentionally never used as this source.
   */
  protected getSourceDefinitionDir(
    workflowContext?: WorkflowContext
  ): string | undefined {
    return getTrustedSourceDefinitionDir(
      this.getExecutionSourceDefinitionPath(),
      Array.from(
        new Set([
          ...this.getExecutionWorkspaceRoots(),
          ...this.getApprovedExternalRoots(workflowContext),
        ])
      )
    );
  }

  /**
   * Get every external directory currently authorized to be read/attached
   * for this workspace: user-scope `permissions.allowedExternalFileRoots`
   * (trusted immediately) plus workspace-scope entries with a recorded
   * "allow" decision in `ExternalRootsTrustStore`. Returns `[]` when no
   * workspace is open. See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
   */
  protected getEffectiveApprovedExternalFileRoots(): string[] {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return [];
    }
    const workspaceIdentity =
      ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
    return ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      workspaceIdentity
    );
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

  getLastCliCommandWasInjected(): boolean | undefined {
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

  wasLastFailureHarnessError(): boolean {
    return false;
  }

  wasLastFailureTimeout(): boolean {
    return false;
  }

  getLastFailureKind(): FailureKind | undefined {
    return undefined;
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
