import * as crypto from "crypto";
import type { PromptStep } from "../../../types/CtrlYokeTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import {
  PromptFileSplitter,
  type SplitConfig,
} from "../../../utils/PromptFileSplitter";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  HARNESS_IDS,
  MAX_CONTENT_SIZE,
  MAX_PREVIEW_BODY_BYTES,
  PREVIEW_PROMPT_CATEGORIES,
  PREVIEW_TRUNCATION_REASONS,
  TEMP_FILE_CATEGORIES,
  CTRLYOKE_SLASH_TOKEN_KINDS,
  type PreviewPromptCategory,
} from "../../../types/DashboardConstants";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { TempFileManager } from "../../../utils/TempFileManager";
import { Log } from "../../../utils/Log";
import { parseInlinePriorContextRefs } from "../../../utils/FileReferenceParser";
import { ResumeAttachmentResolver } from "../../../utils/ResumeAttachmentResolver";
import {
  scanCtrlYokeSlashTokens,
  rewriteCtrlYokeSlashTokens,
} from "../../../utils/CtrlYokeSlashTokens";
import { SkillDiscovery } from "../../../utils/SkillDiscovery";
import {
  estimateFileTokens,
  type FileTokenEstimate,
} from "../../../utils/FileTokenEstimator";
import type {
  PriorContextItem,
  PromptSections,
} from "../../HarnessIntegration";
import { refToPriorContext } from "../../HarnessIntegration";
import type {
  CategorizedPromptPreview,
  CategorizedPromptSectionPreview,
} from "../../../types/ExecutionPreviewTypes";
import type {
  CompatibilityDiagnostic,
  CompatibilityDiagnosticSeverity,
} from "../../../types/CompatibilityTypes";
import type { PreparedMutation } from "./interfaces/PreparedMutation";

const PROMPT_DIAGNOSTIC_CODES = {
  LARGE_REFERENCE: "prompt.reference.implausibly-large",
  OVER_INLINE_CAP: "prompt.content.over-inline-cap",
  UNKNOWN_SKILL_REFERENCE: "prompt.skill.unknown",
  UNRESOLVED_REFERENCE: "prompt.reference.unresolved",
} as const;

export interface PlannedPromptFile {
  readonly path: string;
  readonly category: (typeof TEMP_FILE_CATEGORIES)[keyof typeof TEMP_FILE_CATEGORIES];
  readonly reference: string;
  readonly content: string;
  readonly chunkIndex: number;
}

export interface PromptFileResult {
  tempFilePaths: string[];
  promptWithInstruction: string;
  diagnostics: readonly CompatibilityDiagnostic[];
}

/** Pure categorized prompt preparation plus deferred temp-file mutations. */
export interface PromptPreparationPlan {
  readonly tempFilePaths: string[];
  readonly promptWithInstruction: string;
  readonly files: readonly PlannedPromptFile[];
  readonly mutations: readonly PreparedMutation[];
  readonly promptPreview: CategorizedPromptPreview;
  readonly diagnostics: readonly CompatibilityDiagnostic[];
}

export interface CliPromptPreparerDeps {
  shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => boolean;
  buildPromptSections: (
    prompt: PromptStep,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ) => Promise<PromptSections>;
  extractLeadingSlashCommand: (promptText: string) => string | null;
  isSimplePrompt: (promptText: string) => boolean;
  isInjectablePrompt?: (promptText: string) => boolean;
  buildPriorContextXmlFromItems: (items: PriorContextItem[]) => string;
  getWorkspaceRoot: () => string | undefined;
  getTempFileSplitConfig: () => SplitConfig | undefined;
  formatDirectFileRef: (absolutePath: string) => string;
  formatTempFileRef: (tempMgr: TempFileManager, absolutePath: string) => string;
  formatCategorizedReferences: (
    agentRefs: string[],
    skillRefs: string[],
    directRefs: string[],
    contextRefs: string[],
    excerptRefs: string[],
    promptRefs: string[]
  ) => string;
}

export class CliPromptPreparer {
  constructor(private readonly deps: CliPromptPreparerDeps) {}

  /**
   * Compute the exact categorized payload without creating any temp file.
   * Referenced files are inspected with stat only; inline payloads are split
   * into the same chunks that live execution writes.
   */
  async planPrompt(
    prompt: PromptStep,
    workflowContext: WorkflowContext | undefined,
    resolvedProperties: ResolvedProperties | undefined,
    resolvedSessionId: string | undefined,
    injectMode = false
  ): Promise<PromptPreparationPlan> {
    const originalPromptText = prompt.prompt.trim();
    const slashCommand =
      this.deps.extractLeadingSlashCommand(originalPromptText);
    const isPureSlashCommand =
      slashCommand !== null && /^\/\w+\s*$/.test(originalPromptText);

    // Keep colon-containing ctrlyoke references out of this native-command
    // bypass; the regex intentionally recognizes only plain slash commands.
    if (isPureSlashCommand) {
      Log.debug(
        `⚡ Slash command detected ("${slashCommand}") — skipping instruction assembly`
      );
      return this.createInlinePlan(originalPromptText);
    }

    const promptIndex = workflowContext?.promptIndex ?? 0;
    const allPrompts = workflowContext?.allPrompts ?? [prompt];
    const workspaceRoot = this.deps.getWorkspaceRoot();
    const attachmentResolution =
      !!resolvedSessionId &&
      this.deps.shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume()
        ? ResumeAttachmentResolver.resolve({
            promptIndex,
            allPrompts,
            harness: resolvedProperties?.harness,
            resumeSession: true,
            resolvedSessionId,
            agent: resolvedProperties?.agent,
            skills: resolvedProperties?.skills,
          })
        : {
            agent: resolvedProperties?.agent,
            skills: resolvedProperties?.skills,
          };
    const skillTokens = scanCtrlYokeSlashTokens(originalPromptText).filter(
      (token) => token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.SKILL
    );
    const mcpTokens = scanCtrlYokeSlashTokens(originalPromptText).filter(
      (token) => token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.MCP
    );
    const discoveredSkills = skillTokens.length
      ? await SkillDiscovery.discoverSkills(workspaceRoot)
      : [];
    const inlineSkillNames = [
      ...new Set(
        skillTokens
          .filter((token) =>
            SkillDiscovery.resolveCtrlYokeSkillInvocation(
              discoveredSkills,
              token.name,
              resolvedProperties?.harness,
              workspaceRoot
            )
          )
          .map((token) => token.name)
      ),
    ];
    const effectiveSkills = [
      ...new Set([...(attachmentResolution.skills ?? []), ...inlineSkillNames]),
    ];
    const effectiveSkillResolution =
      effectiveSkills.length > 0 ? effectiveSkills : undefined;
    const resolvedMcpServerIds = new Set(
      (resolvedProperties?.mcpServers ?? []).map((server) =>
        typeof server === "string" ? server : server.id
      )
    );
    const inlineMcpNames = [
      ...new Set(
        mcpTokens
          .filter((token) => resolvedMcpServerIds.has(token.name))
          .map((token) => token.name)
      ),
    ];
    const harnessId = resolvedProperties?.harness ?? HARNESS_IDS.COPILOT_CLI;
    const inlineSkillDiagnostics = skillTokens
      .filter((token) => !inlineSkillNames.includes(token.name))
      .map((token) =>
        this.createDiagnostic(
          PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SKILL_REFERENCE,
          harnessId,
          `Skill "${token.name}" referenced by ${token.raw} was not found among discovered skills.`
        )
      );
    const sections = await this.deps.buildPromptSections(
      prompt,
      attachmentResolution.agent,
      effectiveSkillResolution
    );
    // A skipped reference previously vanished from the outgoing prompt with
    // only a debug/warn log line — surface it as a real diagnostic so
    // "nothing to attach" and "attachment silently failed" are never
    // indistinguishable to the user.
    const unresolvedReferenceDiagnostics = sections.skippedReferences.map(
      (skipped) =>
        this.createDiagnostic(
          PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
          harnessId,
          `Reference "${skipped.ref}" could not be attached: ${skipped.reason}`
        )
    );
    const promptDiagnostics = [
      ...inlineSkillDiagnostics,
      ...unresolvedReferenceDiagnostics,
    ];
    const outgoingSections = {
      ...sections,
      userPromptText: rewriteCtrlYokeSlashTokens(
        sections.userPromptText,
        (token) =>
          (token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.SKILL &&
            inlineSkillNames.includes(token.name)) ||
          (token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.MCP &&
            inlineMcpNames.includes(token.name))
      ),
    };

    const resolvedPriorContext = resolvedProperties?.priorContext;
    const inlineRefs = parseInlinePriorContextRefs(
      outgoingSections.userPromptText
    ).map(
      (match) => match.ref
    );
    const hasPriorContext =
      (resolvedPriorContext !== undefined && resolvedPriorContext !== "none") ||
      inlineRefs.length > 0;
    const hasExtras =
      !!sections.agentContent ||
      !!sections.skillContent ||
      sections.directFileRefs.length > 0 ||
      !!sections.excerptContent ||
      hasPriorContext ||
      inlineSkillNames.length > 0;
    const inlineCheck = this.makeInlineCheck(injectMode);

    if (!hasExtras && inlineCheck(outgoingSections.userPromptText)) {
      return this.createInlinePlan(
        outgoingSections.userPromptText,
        promptDiagnostics
      );
    }

    // Preserve the live fast path: direct references remain inline when the
    // rest of the prompt is safe to send as-is.
    if (
      outgoingSections.directFileRefs.length > 0 &&
      !outgoingSections.agentContent &&
      !outgoingSections.skillContent &&
      !outgoingSections.excerptContent &&
      !hasPriorContext &&
      inlineCheck(outgoingSections.userPromptText)
    ) {
      const plan = await this.createInlinePlanWithReferences(
        outgoingSections.userPromptText,
        outgoingSections.directFileRefs,
        harnessId
      );
      return this.withDiagnostics(plan, promptDiagnostics);
    }

    const contextItems = hasPriorContext
      ? workflowContext?.resolvePriorContextItems
        ? await workflowContext.resolvePriorContextItems(
            [
              ...(resolvedPriorContext && resolvedPriorContext !== "none"
                ? [resolvedPriorContext]
                : []),
              ...inlineRefs.map(refToPriorContext),
            ],
            allPrompts,
            promptIndex
          )
        : []
      : [];
    const resolvedContextContent =
      contextItems.length > 0
        ? this.deps.buildPriorContextXmlFromItems(contextItems)
        : undefined;

    const plan = await this.createCategorizedPromptPlan(
      outgoingSections,
      workflowContext,
      resolvedContextContent,
      hasPriorContext,
      harnessId
    );
    const planWithDiagnostics = this.withDiagnostics(
      plan,
      promptDiagnostics
    );
    if (!slashCommand) {
      return planWithDiagnostics;
    }
    return {
      ...planWithDiagnostics,
      promptWithInstruction: `${slashCommand} ${planWithDiagnostics.promptWithInstruction.trimStart()}`,
    };
  }

  /** Apply a plan for real execution while retaining the legacy result shape. */
  async preparePrompt(
    prompt: PromptStep,
    workflowContext: WorkflowContext | undefined,
    resolvedProperties: ResolvedProperties | undefined,
    resolvedSessionId: string | undefined,
    injectMode = false
  ): Promise<PromptFileResult> {
    const plan = await this.planPrompt(
      prompt,
      workflowContext,
      resolvedProperties,
      resolvedSessionId,
      injectMode
    );
    const appliedMutations: PreparedMutation[] = [];
    try {
      for (const mutation of plan.mutations) {
        await mutation.apply();
        appliedMutations.push(mutation);
      }
    } catch (error) {
      for (const mutation of appliedMutations.reverse()) {
        await mutation.restore?.();
      }
      throw error;
    }
    return {
      tempFilePaths: [...plan.tempFilePaths],
      promptWithInstruction: plan.promptWithInstruction,
      diagnostics: plan.diagnostics,
    };
  }

  /** Returns the appropriate inline-check function based on execution mode. */
  private makeInlineCheck(injectMode: boolean): (text: string) => boolean {
    return injectMode && this.deps.isInjectablePrompt
      ? this.deps.isInjectablePrompt
      : this.deps.isSimplePrompt;
  }

  private createInlinePlan(
    promptText: string,
    diagnostics: readonly CompatibilityDiagnostic[] = []
  ): PromptPreparationPlan {
    const body = this.createBodySection(
      PREVIEW_PROMPT_CATEGORIES.PROMPT_TEXT,
      promptText,
      0,
      MAX_PREVIEW_BODY_BYTES
    );
    return {
      tempFilePaths: [],
      promptWithInstruction: promptText,
      files: [],
      mutations: [],
      promptPreview: {
        sections: [body.section],
        totalByteCount: body.fullByteCount,
        includedBodyByteCount: body.includedByteCount,
        bodyBudgetBytes: MAX_PREVIEW_BODY_BYTES,
      },
      diagnostics: [...diagnostics],
    };
  }

  private withDiagnostics(
    plan: PromptPreparationPlan,
    diagnostics: readonly CompatibilityDiagnostic[]
  ): PromptPreparationPlan {
    return diagnostics.length === 0
      ? plan
      : { ...plan, diagnostics: [...diagnostics, ...plan.diagnostics] };
  }

  private async createInlinePlanWithReferences(
    promptText: string,
    directFileRefs: string[],
    harnessId: ResolvedProperties["harness"]
  ): Promise<PromptPreparationPlan> {
    const promptBody = this.createBodySection(
      PREVIEW_PROMPT_CATEGORIES.PROMPT_TEXT,
      promptText,
      0,
      MAX_PREVIEW_BODY_BYTES
    );
    const sections: CategorizedPromptSectionPreview[] = [];
    const diagnostics: CompatibilityDiagnostic[] = [];
    for (let i = 0; i < directFileRefs.length; i++) {
      sections.push(
        await this.buildFileReferenceSection(
          directFileRefs[i],
          i,
          harnessId,
          diagnostics
        )
      );
    }
    sections.push(promptBody.section);
    return {
      tempFilePaths: [],
      promptWithInstruction: promptText,
      files: [],
      mutations: [],
      promptPreview: {
        sections,
        totalByteCount: sections.reduce(
          (sum, section) => sum + section.byteCount,
          0
        ),
        includedBodyByteCount: promptBody.includedByteCount,
        bodyBudgetBytes: MAX_PREVIEW_BODY_BYTES,
      },
      diagnostics,
    };
  }

  private async createCategorizedPromptPlan(
    sections: PromptSections,
    workflowContext: WorkflowContext | undefined,
    contextContent: string | undefined,
    hasPriorContext: boolean,
    harnessId: ResolvedProperties["harness"]
  ): Promise<PromptPreparationPlan> {
    const workspaceRoot = this.deps.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace root available for categorized temp files");
    }

    const tempMgr = new TempFileManager(workspaceRoot);
    const splitter = new PromptFileSplitter(this.deps.getTempFileSplitConfig());
    const plannedFiles: PlannedPromptFile[] = [];
    const mutations: PreparedMutation[] = [];
    const diagnostics: CompatibilityDiagnostic[] = [];
    const previewSections: CategorizedPromptSectionPreview[] = [];
    let remainingBodyBytes = MAX_PREVIEW_BODY_BYTES;
    const filePath = workflowContext?.workflowName ?? workflowContext?.filePath;
    const stepNumber = workflowContext
      ? workflowContext.promptIndex + 1
      : undefined;
    // TempFileManager uses second-resolution names. One timestamp keeps the
    // planned paths byte-for-byte identical to the files applied below.
    const timestamp = Math.floor(Date.now() / 1000);

    const formatTempRef = (plannedPath: string): string =>
      this.deps.formatTempFileRef(tempMgr, plannedPath);

    const addChunkFiles = (
      category: (typeof TEMP_FILE_CATEGORIES)[keyof typeof TEMP_FILE_CATEGORIES],
      previewCategory: PreviewPromptCategory,
      chunks: string[],
      tokenCounts: number[],
      lineCounts: number[],
      sourceByteCount?: number
    ): string[] => {
      const refs: string[] = [];
      const isOverInlineCap =
        this.isTierTwoCategory(previewCategory) &&
        (sourceByteCount ?? 0) > MAX_CONTENT_SIZE;
      if (isOverInlineCap) {
        diagnostics.push(
          this.createDiagnostic(
            PROMPT_DIAGNOSTIC_CODES.OVER_INLINE_CAP,
            harnessId,
            `${previewCategory} content is ${sourceByteCount} bytes and exceeds the ${MAX_CONTENT_SIZE}-byte inline content cap.`
          )
        );
      }
      for (let i = 0; i < chunks.length; i++) {
        const partNumber = chunks.length > 1 ? i + 1 : undefined;
        const plannedPath = tempMgr.getCategoryFilePath(
          category,
          filePath,
          stepNumber,
          partNumber,
          timestamp
        );
        const reference = formatTempRef(plannedPath);
        plannedFiles.push({
          path: plannedPath,
          category,
          reference,
          content: chunks[i],
          chunkIndex: i,
        });
        mutations.push({
          path: plannedPath,
          intendedContent: chunks[i],
          apply: () => tempMgr.writeCategoryFile(plannedPath, chunks[i]),
          restore: () => tempMgr.deleteFiles([plannedPath]),
        });
        const body = this.createBodySection(
          previewCategory,
          chunks[i],
          i,
          isOverInlineCap
            ? 0
            : this.isTierTwoCategory(previewCategory)
              ? Math.min(remainingBodyBytes, MAX_CONTENT_SIZE)
              : remainingBodyBytes,
          tokenCounts[i],
          lineCounts[i]
        );
        if (isOverInlineCap) {
          body.section.truncationReason =
            PREVIEW_TRUNCATION_REASONS.OVER_INLINE_CAP;
        }
        remainingBodyBytes -= body.includedByteCount;
        previewSections.push(body.section);
        refs.push(reference);
      }
      return refs;
    };

    const agentRefs: string[] = [];
    if (sections.agentContent) {
      const content = `<agentInstructions>\n${sections.agentContent}\n</agentInstructions>`;
      const split = splitter.split(content);
      agentRefs.push(
        ...addChunkFiles(
          TEMP_FILE_CATEGORIES.AGENT,
          PREVIEW_PROMPT_CATEGORIES.AGENT_INSTRUCTIONS,
          split.chunks,
          split.tokenCounts,
          split.lineCounts,
          Buffer.byteLength(content, "utf8")
        )
      );
    }

    const skillRefs: string[] = [];
    if (sections.skillContent) {
      const split = splitter.split(sections.skillContent);
      skillRefs.push(
        ...addChunkFiles(
          TEMP_FILE_CATEGORIES.SKILLS,
          PREVIEW_PROMPT_CATEGORIES.SKILL_CONTENT,
          split.chunks,
          split.tokenCounts,
          split.lineCounts,
          Buffer.byteLength(sections.skillContent, "utf8")
        )
      );
    }

    const directRefs: string[] = [];
    for (let i = 0; i < sections.directFileRefs.length; i++) {
      const absolutePath = sections.directFileRefs[i];
      const reference = this.deps.formatDirectFileRef(absolutePath);
      directRefs.push(reference);
      previewSections.push(
        await this.buildFileReferenceSection(
          absolutePath,
          i,
          harnessId,
          diagnostics,
          reference
        )
      );
    }

    const contextRefs: string[] = [];
    if (contextContent) {
      const split = splitter.splitContextContent(contextContent);
      contextRefs.push(
        ...addChunkFiles(
          TEMP_FILE_CATEGORIES.CONTEXT,
          PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT,
          split.chunks,
          split.tokenCounts,
          split.lineCounts
        )
      );
    }
    if (hasPriorContext && !contextContent) {
      previewSections.push({
        category: PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT,
        byteCount: 0,
        tokenEstimate: 0,
        chunkIndex: 0,
        lineCount: null,
        contentHash: null,
        truncationReason: PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE,
      });
    }

    const excerptRefs: string[] = [];
    if (sections.excerptContent) {
      const split = splitter.split(sections.excerptContent);
      excerptRefs.push(
        ...addChunkFiles(
          TEMP_FILE_CATEGORIES.EXCERPTS,
          PREVIEW_PROMPT_CATEGORIES.INLINE_REFERENCE,
          split.chunks,
          split.tokenCounts,
          split.lineCounts,
          Buffer.byteLength(sections.excerptContent, "utf8")
        )
      );
    }

    const promptSplit = splitter.split(sections.userPromptText);
    const promptPaths: string[] = [];
    for (let i = 0; i < promptSplit.chunks.length; i++) {
      const partNumber = promptSplit.chunks.length > 1 ? i + 1 : undefined;
      const promptPath = tempMgr.getCategoryFilePath(
        TEMP_FILE_CATEGORIES.PROMPT,
        filePath,
        stepNumber,
        partNumber,
        timestamp
      );
      const reference = formatTempRef(promptPath);
      promptPaths.push(promptPath);
      plannedFiles.push({
        path: promptPath,
        category: TEMP_FILE_CATEGORIES.PROMPT,
        reference,
        content: promptSplit.chunks[i],
        chunkIndex: i,
      });
      mutations.push({
        path: promptPath,
        intendedContent: promptSplit.chunks[i],
        apply: () =>
          tempMgr.writeCategoryFile(promptPath, promptSplit.chunks[i]),
        restore: () => tempMgr.deleteFiles([promptPath]),
      });
      const body = this.createBodySection(
        PREVIEW_PROMPT_CATEGORIES.PROMPT_TEXT,
        promptSplit.chunks[i],
        i,
        remainingBodyBytes,
        promptSplit.tokenCounts[i],
        promptSplit.lineCounts[i]
      );
      remainingBodyBytes -= body.includedByteCount;
      previewSections.push(body.section);
    }
    const promptRefs = plannedFiles
      .filter((file) => file.category === TEMP_FILE_CATEGORIES.PROMPT)
      .map((file) => file.reference);
    const promptWithInstruction = this.deps.formatCategorizedReferences(
      agentRefs,
      skillRefs,
      directRefs,
      contextRefs,
      excerptRefs,
      promptRefs
    );

    return {
      tempFilePaths: plannedFiles.map((file) => file.path),
      promptWithInstruction,
      files: plannedFiles,
      mutations,
      promptPreview: {
        sections: previewSections,
        totalByteCount: previewSections.reduce(
          (sum, section) => sum + section.byteCount,
          0
        ),
        includedBodyByteCount: previewSections.reduce(
          (sum, section) =>
            sum + (section.body ? Buffer.byteLength(section.body, "utf8") : 0),
          0
        ),
        bodyBudgetBytes: MAX_PREVIEW_BODY_BYTES,
      },
      diagnostics,
    };
  }

  /**
   * Build a FILE_REFERENCE (Tier 1) preview section for one `@path` reference.
   * Token estimation is single-sourced via `estimateFileTokens` — exact for
   * files at or under MAX_CONTENT_SIZE, a size-based approximation above it —
   * so this number agrees with the live editor's attachment token count
   * (`ContextExpander.estimateFileReferenceTokens`) for the same file.
   */
  private async buildFileReferenceSection(
    absolutePath: string,
    chunkIndex: number,
    harnessId: ResolvedProperties["harness"],
    diagnostics: CompatibilityDiagnostic[],
    providerReference?: string
  ): Promise<CategorizedPromptSectionPreview> {
    let estimate: FileTokenEstimate | undefined;
    try {
      estimate = await estimateFileTokens(absolutePath);
    } catch {
      // Keep the reference if the file disappeared after context expansion.
    }
    if (estimate?.estimated) {
      diagnostics.push(
        this.createDiagnostic(
          PROMPT_DIAGNOSTIC_CODES.LARGE_REFERENCE,
          harnessId,
          `Referenced file ${absolutePath} is ${estimate.byteCount} bytes; the target harness may not be able to process it.`
        )
      );
    }
    return {
      category: PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE,
      byteCount: estimate?.byteCount ?? 0,
      lineCount: null,
      tokenEstimate: estimate?.tokens ?? null,
      chunkIndex,
      contentHash: null,
      truncationReason: PREVIEW_TRUNCATION_REASONS.REFERENCE,
      path: absolutePath,
      ...(providerReference ? { providerReference } : {}),
      ...(estimate ? { modifiedTimeMs: estimate.mtimeMs } : {}),
    };
  }

  private createBodySection(
    category: PreviewPromptCategory,
    content: string,
    chunkIndex: number,
    bodyBudgetBytes: number,
    tokenEstimate?: number,
    lineCount?: number
  ): {
    section: CategorizedPromptSectionPreview;
    fullByteCount: number;
    includedByteCount: number;
  } {
    const fullByteCount = Buffer.byteLength(content, "utf8");
    const contentHash = crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const body = truncateUtf8(content, bodyBudgetBytes);
    const includedByteCount = Buffer.byteLength(body, "utf8");
    return {
      section: {
        category,
        byteCount: fullByteCount,
        lineCount: lineCount ?? countLines(content),
        tokenEstimate: tokenEstimate ?? null,
        chunkIndex,
        contentHash,
        ...(body ? { body } : {}),
        ...(includedByteCount < fullByteCount
          ? { truncationReason: PREVIEW_TRUNCATION_REASONS.BODY_BUDGET }
          : {}),
      },
      fullByteCount,
      includedByteCount,
    };
  }

  private isTierTwoCategory(category: PreviewPromptCategory): boolean {
    return (
      category === PREVIEW_PROMPT_CATEGORIES.AGENT_INSTRUCTIONS ||
      category === PREVIEW_PROMPT_CATEGORIES.SKILL_CONTENT ||
      category === PREVIEW_PROMPT_CATEGORIES.INLINE_REFERENCE
    );
  }

  private createDiagnostic(
    code: string,
    harnessId: ResolvedProperties["harness"],
    message: string,
    severity: CompatibilityDiagnosticSeverity = COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
  ): CompatibilityDiagnostic {
    return {
      code,
      severity,
      harnessId,
      capability: "promptInputs",
      state: {
        fidelity: CAPABILITY_FIDELITIES.PARTIAL,
        mechanism: CAPABILITY_MECHANISMS.NONE,
        verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
      },
      message,
    };
  }
}

function countLines(content: string): number {
  return content ? content.split("\n").length : 0;
}

/** Truncate by UTF-8 bytes without splitting a multi-byte code point. */
function truncateUtf8(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  const buffer = Buffer.from(content, "utf8").subarray(0, maxBytes);
  return buffer.toString("utf8").replace(/\uFFFD$/, "");
}
