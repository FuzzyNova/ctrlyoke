import type { PriorContext, PromptItem } from "../../../types/FlightPathTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import {
  PromptFileSplitter,
  type SplitConfig,
} from "../../../utils/PromptFileSplitter";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { TempFileManager } from "../../../utils/TempFileManager";
import type { PromptSections } from "../../HarnessIntegration";

export interface PromptFileResult {
  tempFilePaths: string[];
  promptWithInstruction: string;
}

export interface CliPromptPreparerDeps {
  shouldOmitAgentsAndSkillsOnResume: () => boolean;
  buildPromptSections: (
    prompt: PromptItem,
    resolvedAgent?: string,
    resolvedSkills?: string[]
  ) => Promise<PromptSections>;
  isSimplePrompt: (promptText: string) => boolean;
  buildPriorContextXml: (
    resolvedPriorContext: Exclude<PriorContext, "none">,
    allPrompts: PromptItem[],
    promptIndex: number,
    finalPromptResponseTexts: string[]
  ) => string;
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
  logInfo: (message: string) => void;
}

export class CliPromptPreparer {
  constructor(private readonly deps: CliPromptPreparerDeps) {}

  async preparePrompt(
    prompt: PromptItem,
    workflowContext: WorkflowContext | undefined,
    resolvedProperties: ResolvedProperties | undefined,
    resolvedSessionId: string | undefined,
    finalPromptResponseTexts?: string[]
  ): Promise<PromptFileResult> {
    const omitAgentsAndSkills =
      !!resolvedSessionId && this.deps.shouldOmitAgentsAndSkillsOnResume();
    const sections = await this.deps.buildPromptSections(
      prompt,
      omitAgentsAndSkills ? undefined : resolvedProperties?.agent,
      omitAgentsAndSkills ? undefined : resolvedProperties?.skills
    );

    const promptIndex = workflowContext?.promptIndex ?? 0;
    const allPrompts = workflowContext?.allPrompts ?? [prompt];
    const resolvedPriorContext = resolvedProperties?.priorContext;
    const hasPriorContext =
      resolvedPriorContext !== undefined && resolvedPriorContext !== "none";

    const hasExtras =
      !!sections.agentContent ||
      !!sections.skillContent ||
      sections.directFileRefs.length > 0 ||
      !!sections.excerptContent ||
      hasPriorContext;
    if (!hasExtras && this.deps.isSimplePrompt(sections.userPromptText)) {
      return {
        promptWithInstruction: sections.userPromptText,
        tempFilePaths: [],
      };
    }

    const contextContent = hasPriorContext
      ? this.deps.buildPriorContextXml(
          resolvedPriorContext as Exclude<PriorContext, "none">,
          allPrompts,
          promptIndex,
          finalPromptResponseTexts ?? []
        ) || undefined
      : undefined;

    return this.createCategorizedPromptFiles(
      sections,
      workflowContext,
      contextContent
    );
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
        "agent",
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
        "skills",
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
        "context",
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
        "excerpts",
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
        "prompt",
        filePath,
        stepNumber,
        partNumber
      );
      promptPaths.push(promptPath);
    }
    allTempFilePaths.push(...promptPaths);
    const promptRefs = promptPaths.map(fmtRef);

    this.deps.logInfo(
      `📁 Categorized prompt files: ${allTempFilePaths.length} file(s)`
    );

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
