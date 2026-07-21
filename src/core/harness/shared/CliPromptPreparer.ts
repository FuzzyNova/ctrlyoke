import type {
  PriorContext,
  PromptStep,
  WorkflowStep,
} from "../../../types/CtrlYokeTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import {
  PromptFileSplitter,
  type SplitConfig,
} from "../../../utils/PromptFileSplitter";
import { TEMP_FILE_CATEGORIES } from "../../../types/DashboardConstants";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { TempFileManager } from "../../../utils/TempFileManager";
import { Log } from "../../../utils/Log";
import {
  parseInlinePriorContextRefs,
  type InlinePriorContextRef,
} from "../../../utils/FileReferenceParser";
import { ResumeAttachmentResolver } from "../../../utils/ResumeAttachmentResolver";
import type {
  PriorContextItem,
  PromptSections,
} from "../../HarnessIntegration";
import { refToPriorContext } from "../../HarnessIntegration";

export interface PromptFileResult {
  tempFilePaths: string[];
  promptWithInstruction: string;
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
  /** Legacy test seam; production prompt construction always uses the resolver. */
  gatherAndMergeContextItems?: (
    propertyContext: PriorContext | undefined,
    inlineRefs: InlinePriorContextRef[],
    allPrompts: WorkflowStep[],
    promptIndex: number,
    finalStepResponseTexts: string[]
  ) => PriorContextItem[];
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

  async preparePrompt(
    prompt: PromptStep,
    workflowContext: WorkflowContext | undefined,
    resolvedProperties: ResolvedProperties | undefined,
    resolvedSessionId: string | undefined,
    finalStepResponseTexts?: string[],
    injectMode = false
  ): Promise<PromptFileResult> {
    const originalPromptText = prompt.prompt.trim();
    const slashCommand =
      this.deps.extractLeadingSlashCommand(originalPromptText);
    const isPureSlashCommand =
      slashCommand !== null && /^\/\w+\s*$/.test(originalPromptText);

    if (isPureSlashCommand) {
      Log.debug(
        `⚡ Slash command detected ("${slashCommand}") — skipping instruction assembly`
      );
      return {
        promptWithInstruction: originalPromptText,
        tempFilePaths: [],
      };
    }

    const promptIndex = workflowContext?.promptIndex ?? 0;
    const allPrompts = workflowContext?.allPrompts ?? [prompt];
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
    const sections = await this.deps.buildPromptSections(
      prompt,
      attachmentResolution.agent,
      attachmentResolution.skills
    );

    const resolvedPriorContext = resolvedProperties?.priorContext;
    const inlineRefs = parseInlinePriorContextRefs(sections.userPromptText).map(
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
      hasPriorContext;
    const inlineCheck = this.makeInlineCheck(injectMode);
    if (!hasExtras && inlineCheck(sections.userPromptText)) {
      return {
        promptWithInstruction: sections.userPromptText,
        tempFilePaths: [],
      };
    }

    // Fast path: only @file references as extras, and the full text qualifies
    // as an inline prompt — send it directly so "fully implement @Plan.md" is
    // not wrapped in a categorized instruction. SAFE_CHARS_PATTERN includes `\`
    // and `~` so common Windows/Unix path characters pass without stripping.
    if (
      sections.directFileRefs.length > 0 &&
      !sections.agentContent &&
      !sections.skillContent &&
      !sections.excerptContent &&
      !hasPriorContext &&
      inlineCheck(sections.userPromptText)
    ) {
      return {
        promptWithInstruction: sections.userPromptText,
        tempFilePaths: [],
      };
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
        : (this.deps.gatherAndMergeContextItems?.(
            resolvedPriorContext,
            inlineRefs,
            allPrompts,
            promptIndex,
            finalStepResponseTexts ?? []
          ) ?? [])
      : [];
    const resolvedContextContent =
      contextItems.length > 0
        ? this.deps.buildPriorContextXmlFromItems(contextItems)
        : undefined;

    const preparedPrompt = await this.createCategorizedPromptFiles(
      sections,
      workflowContext,
      resolvedContextContent
    );

    if (!slashCommand) {
      return preparedPrompt;
    }

    return {
      ...preparedPrompt,
      promptWithInstruction: `${slashCommand} ${preparedPrompt.promptWithInstruction.trimStart()}`,
    };
  }

  /** Returns the appropriate inline-check function based on execution mode. */
  private makeInlineCheck(injectMode: boolean): (text: string) => boolean {
    return injectMode && this.deps.isInjectablePrompt
      ? this.deps.isInjectablePrompt
      : this.deps.isSimplePrompt;
  }

  private async createCategorizedPromptFiles(
    sections: PromptSections,
    workflowContext?: WorkflowContext,
    contextContent?: string
  ): Promise<PromptFileResult> {
    const workspaceRoot = this.deps.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace root available for categorized temp files");
    }

    const tempMgr = new TempFileManager(workspaceRoot);
    const splitter = new PromptFileSplitter(this.deps.getTempFileSplitConfig());
    const allTempFilePaths: string[] = [];
    const filePath = workflowContext?.workflowName ?? workflowContext?.filePath;
    const stepNumber = workflowContext
      ? workflowContext.promptIndex + 1
      : undefined;

    const fmtRef = (filePathToFormat: string) =>
      this.deps.formatTempFileRef(tempMgr, filePathToFormat);

    const agentRefs: string[] = [];
    if (sections.agentContent) {
      const agentText = `<agentInstructions>\n${sections.agentContent}\n</agentInstructions>`;
      const agentPaths = await tempMgr.createCategorySplitFiles(
        splitter.split(agentText).chunks,
        TEMP_FILE_CATEGORIES.AGENT,
        filePath,
        stepNumber
      );
      allTempFilePaths.push(...agentPaths);
      agentRefs.push(...agentPaths.map(fmtRef));
    }

    const skillRefs: string[] = [];
    if (sections.skillContent) {
      const skillPaths = await tempMgr.createCategorySplitFiles(
        splitter.split(sections.skillContent).chunks,
        TEMP_FILE_CATEGORIES.SKILLS,
        filePath,
        stepNumber
      );
      allTempFilePaths.push(...skillPaths);
      skillRefs.push(...skillPaths.map(fmtRef));
    }

    const directRefs = sections.directFileRefs.map((absolutePath) =>
      this.deps.formatDirectFileRef(absolutePath)
    );

    const contextRefs: string[] = [];
    if (contextContent) {
      const contextPaths = await tempMgr.createCategorySplitFiles(
        splitter.splitContextContent(contextContent).chunks,
        TEMP_FILE_CATEGORIES.CONTEXT,
        filePath,
        stepNumber
      );
      allTempFilePaths.push(...contextPaths);
      contextRefs.push(...contextPaths.map(fmtRef));
    }

    const excerptRefs: string[] = [];
    if (sections.excerptContent) {
      const excerptPaths = await tempMgr.createCategorySplitFiles(
        splitter.split(sections.excerptContent).chunks,
        TEMP_FILE_CATEGORIES.EXCERPTS,
        filePath,
        stepNumber
      );
      allTempFilePaths.push(...excerptPaths);
      excerptRefs.push(...excerptPaths.map(fmtRef));
    }

    const promptSplit = splitter.split(sections.userPromptText);
    const promptPaths: string[] = [];
    for (let i = 0; i < promptSplit.chunks.length; i++) {
      const partNumber = promptSplit.chunks.length > 1 ? i + 1 : undefined;
      const promptPath = await tempMgr.createCategoryFile(
        promptSplit.chunks[i],
        TEMP_FILE_CATEGORIES.PROMPT,
        filePath,
        stepNumber,
        partNumber
      );
      promptPaths.push(promptPath);
    }
    allTempFilePaths.push(...promptPaths);
    const promptRefs = promptPaths.map(fmtRef);

    Log.info(`📁 Categorized prompt files: ${allTempFilePaths.length} file(s)`);

    return {
      tempFilePaths: allTempFilePaths,
      promptWithInstruction: this.deps.formatCategorizedReferences(
        agentRefs,
        skillRefs,
        directRefs,
        contextRefs,
        excerptRefs,
        promptRefs
      ),
    };
  }
}
